const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const tencentcloud = require('tencentcloud-sdk-nodejs');
const axios = require('axios');
const launchParams = require('./vmConfig');

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 7777;

// -------- Config (tweak these) --------
const FULL_MATCH_LIMIT = Number(process.env.FULL_MATCH_LIMIT || 5);
const MAX_BACKUP_VMS = Number(process.env.MAX_BACKUP_VMS || 10);
const MIN_BACKUP_VMS = Number(process.env.MIN_BACKUP_VMS || 1);
const NEAR_CAPACITY_THRESHOLD = Number(process.env.NEAR_CAPACITY_THRESHOLD || 1);
const VM_UNREACHABLE_TERMINATE_THRESHOLD = Number(process.env.VM_UNREACHABLE_TERMINATE_THRESHOLD || 2); // consecutive failures before termination
const VM_AGE_TERMINATE_MINUTES = Number(process.env.VM_AGE_TERMINATE_MINUTES || 5); // avoid terminating brand-new VMs immediately
const STATUS_TIMEOUT_MS = Number(process.env.STATUS_TIMEOUT_MS || 5000);
const UPDATE_INTERVAL_MS = Number(process.env.UPDATE_INTERVAL_MS || 30 * 1000); // cron frequency

const SCENE_MAP = {
  VersusMen_Online: 'SelectionScreenMen_Online',
  VersusWomen_Online: 'SelectionScreenWomen_Online',
  KunBoran_Online: 'SelectionScreenMen_Online_KunBoran',
};

const CvmClient = tencentcloud.cvm.v20170312.Client;
const cvmClient = new CvmClient({
  credential: {
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY,
  },
  region: process.env.TENCENT_REGION || 'ap-singapore',
  profile: { httpProfile: { reqMethod: 'POST', reqTimeout: 30 } },
});

app.use(cors());
app.use(express.json());

// -------- In-memory state --------
// vmPool: { instanceId: { ip, matchCount, unreachableCount, launchedAt (ms), lastSeen (ms) } }
const vmPool = {};
// matches: map matchId -> match meta
const matches = {};
// protectedVM: instanceId chosen as protected (rotatable)
let protectedVM = null;

// concurrency guards
let launching = false;

// -------- Helpers --------
function nowMs() {
  return Date.now();
}

async function safeWait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Synchronize vmPool with DescribeInstances()
 * - Adds running instances not yet in vmPool
 * - Removes instances that are absent or not running
 */
async function syncWithCloud() {
  try {
    const res = await cvmClient.DescribeInstances({});
    const allInstances = res.InstanceSet || [];

    // Build a map from InstanceId -> instance object
    const cloudMap = new Map();
    for (const inst of allInstances) cloudMap.set(inst.InstanceId, inst);

    // Remove vmPool entries that are gone or not RUNNING
    for (const instanceId of Object.keys(vmPool)) {
      const inst = cloudMap.get(instanceId);
      if (!inst || inst.InstanceState !== 'RUNNING') {
        console.log(`[SYNC] Removing non-running instance from vmPool: ${instanceId}`);
        delete vmPool[instanceId];
        if (protectedVM === instanceId) protectedVM = null;
      } else {
        // update ip if changed
        const ip = inst.PublicIpAddresses?.[0];
        if (ip && vmPool[instanceId].ip !== ip) {
          vmPool[instanceId].ip = ip;
        }
      }
    }

    // Add running instances not present in vmPool
    for (const inst of allInstances) {
      if (inst.InstanceState !== 'RUNNING') continue;
      const instanceId = inst.InstanceId;
      const ip = inst.PublicIpAddresses?.[0];
      if (!ip) continue; // not ready yet
      if (!vmPool[instanceId]) {
        vmPool[instanceId] = {
          ip,
          matchCount: 0,
          unreachableCount: 0,
          launchedAt: nowMs(),
          lastSeen: nowMs(),
        };
        console.log(`[SYNC] Tracking existing running VM: ${instanceId} @ ${ip}`);
      }
    }

    // Ensure protectedVM exists and points to an existing VM
    if (!protectedVM) {
      const ids = Object.keys(vmPool);
      if (ids.length > 0) {
        // choose the one with earliest launchedAt (oldest)
        ids.sort((a, b) => vmPool[a].launchedAt - vmPool[b].launchedAt);
        protectedVM = ids[0];
        console.log(`[SYNC] Protected VM set to ${protectedVM}`);
      }
    } else if (!vmPool[protectedVM]) {
      protectedVM = null; // will be re-chosen next sync
    }
  } catch (err) {
    console.error('[SYNC] DescribeInstances failed:', err?.message || err);
  }
}

/**
 * Launch a new backup VM and wait until it gets a public IP and is RUNNING.
 * Returns { instanceId, ip } or null on failure.
 * This guards concurrent launches.
 */
async function launchBackupVM() {
  if (launching) {
    console.log('[LAUNCH] Another launch already in progress, skipping concurrent launch.');
    return null;
  }
  if (Object.keys(vmPool).length >= MAX_BACKUP_VMS) {
    console.log('[LAUNCH] Reached MAX_BACKUP_VMS, not launching more.');
    return null;
  }

  launching = true;
  try {
    const params = { ...launchParams, InstanceName: `match-agent-${Date.now()}` };
    const res = await cvmClient.RunInstances(params);
    const instanceId = res.InstanceIdSet?.[0];
    if (!instanceId) throw new Error('RunInstances did not return instanceId');
    console.log(`[LAUNCH] Requested new VM: ${instanceId}`);

    // Poll DescribeInstances to wait for RUNNING state with PublicIpAddresses
    const maxPoll = 40; // up to ~200 seconds with backoff
    let ip = null;
    for (let i = 0; i < maxPoll; i++) {
      await safeWait(5000 + (i * 250)); // small backoff
      try {
        const desc = await cvmClient.DescribeInstances({ InstanceIds: [instanceId] });
        const inst = desc.InstanceSet?.[0];
        if (inst && inst.InstanceState === 'RUNNING' && inst.PublicIpAddresses?.length) {
          ip = inst.PublicIpAddresses[0];
          vmPool[instanceId] = {
            ip,
            matchCount: 0,
            unreachableCount: 0,
            launchedAt: nowMs(),
            lastSeen: nowMs(),
          };
          console.log(`[LAUNCH] VM ready: ${instanceId} @ ${ip}`);
          break;
        }
      } catch (err) {
        // transient, continue polling
      }
    }

    // Choose protectedVM if none
    if (!protectedVM) {
      protectedVM = instanceId;
      console.log(`[LAUNCH] Protected VM set to ${protectedVM}`);
    }

    if (!ip) {
      console.error(`[LAUNCH] Timeout waiting for VM ${instanceId} to become RUNNING with IP`);
      // Optionally try to terminate to clean up
      try { await cvmClient.TerminateInstances({ InstanceIds: [instanceId] }); } catch (e) {}
      delete vmPool[instanceId];
      return null;
    }

    return { instanceId, ip };
  } catch (err) {
    console.error('[LAUNCH] launchBackupVM failed:', err?.message || err);
    return null;
  } finally {
    launching = false;
  }
}

/**
 * Ask each VM for /status. Update matchCount and lastSeen.
 * Handle unreachable VMs: increment unreachableCount and terminate after threshold.
 */
async function refreshVmStatus(instanceId, vm) {
  try {
    const { data } = await axios.get(`http://${vm.ip}:7777/status`, { timeout: STATUS_TIMEOUT_MS });
    // Expecting something like { activeMatches: N }
    vm.matchCount = Number.isFinite(data?.activeMatches) ? data.activeMatches : 0;
    vm.unreachableCount = 0;
    vm.lastSeen = nowMs();
    // normalize
    if (vm.matchCount < 0) vm.matchCount = 0;
    return true;
  } catch (err) {
    vm.unreachableCount = (vm.unreachableCount || 0) + 1;
    console.warn(`[STATUS] VM ${instanceId}@${vm.ip} unreachable (${vm.unreachableCount}): ${err?.message || err}`);
    // If VM is brand-new don't kill it immediately — give some boot time
    const ageMinutes = (nowMs() - vm.launchedAt) / (60 * 1000);
    if (vm.unreachableCount >= VM_UNREACHABLE_TERMINATE_THRESHOLD && ageMinutes >= VM_AGE_TERMINATE_MINUTES) {
      // Terminate if not protected
      if (instanceId !== protectedVM && Object.keys(vmPool).length > MIN_BACKUP_VMS) {
        console.log(`[STATUS] Terminating unreachable VM ${instanceId} (${vm.ip})`);
        try {
          await cvmClient.TerminateInstances({ InstanceIds: [instanceId] });
        } catch (e) {
          console.error(`[STATUS] TerminateInstances failed for ${instanceId}:`, e?.message || e);
        }
        delete vmPool[instanceId];
        return false;
      } else {
        console.log(`[STATUS] VM ${instanceId} is protected or we are at MIN_BACKUP_VMS, skipping termination.`);
      }
    }
    return false;
  }
}

/**
 * Get an available VM (with free slots) or launch a new one.
 * Preference: lowest matchCount, reachable, not protected (for load).
 */
async function getAvailableVM() {
  // First, try to refresh status for all known VMs in parallel
  const entries = Object.entries(vmPool);
  await Promise.all(entries.map(([instanceId, vm]) => refreshVmStatus(instanceId, vm)));

  // Choose best candidate
  const candidates = Object.entries(vmPool)
    .filter(([instanceId, vm]) => vm.matchCount < FULL_MATCH_LIMIT)
    .sort((a, b) => (a[1].matchCount - b[1].matchCount) || (a[1].lastSeen - b[1].lastSeen));

  if (candidates.length > 0) {
    const [instanceId, vm] = candidates[0];
    return { instanceId, ip: vm.ip };
  }

  // No candidate, attempt to launch new VM
  return await launchBackupVM();
}

/**
 * Start a unity server on a given VM IP (post to /start-match)
 */
async function launchUnityServerOnVM(vmIP, matchId, gameMode, matchPrivacy, tickRate, matchType, playfabSecretKey) {
  try {
    const url = `http://${vmIP}:7777/start-match`;
    const payload = { matchId, gameMode, matchPrivacy, tickRate, matchType, playfabSecretKey };
    const { data } = await axios.post(url, payload, { timeout: 15000 });

    if (!data || !data.success) throw new Error(data?.message || 'Failed to start match on VM');

    return {
      serverIP: vmIP,
      serverPort: data.serverPort,
      matchId,
      gameMode,
      tickRate,
      containerId: data.containerId,
    };
  } catch (err) {
    console.error(`[LAUNCH_MATCH] launchUnityServerOnVM failed for ${vmIP}:`, err?.message || err);
    throw err;
  }
}

/**
 * Recompute protectedVM policy:
 * - Ensure there is at least one protected VM
 * - If protected VM is idle for long, rotate to the oldest active VM
 */
function recomputeProtectedVM() {
  if (!protectedVM) {
    const ids = Object.keys(vmPool);
    if (ids.length > 0) {
      ids.sort((a, b) => vmPool[a].launchedAt - vmPool[b].launchedAt);
      protectedVM = ids[0];
      console.log(`[PROTECT] New protectedVM: ${protectedVM}`);
    }
    return;
  }

  const current = vmPool[protectedVM];
  if (!current) {
    protectedVM = null;
    recomputeProtectedVM();
    return;
  }

  // Rotate if protected VM is idle for a while AND there exists at least one non-protected VM
  const idleForMs = nowMs() - (current.lastSeen || current.launchedAt);
  const idleForMinutes = idleForMs / (60 * 1000);
  if (idleForMinutes > 60) { // arbitrary rotation window (1 hour)
    const candidates = Object.keys(vmPool).filter(id => id !== protectedVM);
    if (candidates.length > 0) {
      candidates.sort((a, b) => vmPool[a].launchedAt - vmPool[b].launchedAt);
      protectedVM = candidates[0];
      console.log(`[PROTECT] Rotated protectedVM to ${protectedVM}`);
    }
  }
}

/**
 * Main periodic updater: sync with cloud, fetch statuses, terminate idle VMs, auto-scale
 */
async function updateVMs() {
  try {
    // 1) Bring vmPool in sync with cloud view
    await syncWithCloud();

    // 2) Refresh status for each VM
    const entries = Object.entries(vmPool);
    let totalFreeSlots = 0;
    for (const [instanceId, vm] of entries) {
      const statusOk = await refreshVmStatus(instanceId, vm);
      if (statusOk) {
        const freeSlots = Math.max(0, FULL_MATCH_LIMIT - (vm.matchCount || 0));
        totalFreeSlots += freeSlots;

        // Terminate strictly idle VMs (matchCount===0) if we have more than MIN_BACKUP_VMS and not protected
        if (
          vm.matchCount === 0 &&
          Object.keys(vmPool).length > MIN_BACKUP_VMS &&
          instanceId !== protectedVM
        ) {
          // Safe-guard: don't terminate very young VMs
          const ageMinutes = (nowMs() - vm.launchedAt) / (60 * 1000);
          if (ageMinutes >= VM_AGE_TERMINATE_MINUTES) {
            console.log(`[AUTO] Terminating idle VM ${instanceId} (${vm.ip})`);
            try {
              await cvmClient.TerminateInstances({ InstanceIds: [instanceId] });
            } catch (e) {
              console.error(`[AUTO] Failed to terminate ${instanceId}:`, e?.message || e);
            }
            delete vmPool[instanceId];
            if (protectedVM === instanceId) protectedVM = null;
          } else {
            console.log(`[AUTO] VM ${instanceId} is idle but too new to terminate (age ${ageMinutes.toFixed(1)}m)`);
          }
        }
      } else {
        // refreshVmStatus already may delete unreachable VMs if threshold reached
      }
    }

    // 3) Ensure minimum backup VMs
    const runningCount = Object.keys(vmPool).length;
    if (runningCount < MIN_BACKUP_VMS) {
      const diff = MIN_BACKUP_VMS - runningCount;
      console.log(`[AUTO] Need ${diff} VM(s) to meet MIN_BACKUP_VMS`);
      for (let i = 0; i < diff; i++) {
        await launchBackupVM();
      }
    }

    // 4) Auto-scale up if free capacity low
    if (totalFreeSlots <= NEAR_CAPACITY_THRESHOLD && Object.keys(vmPool).length < MAX_BACKUP_VMS) {
      console.log(`[AUTO] Low capacity (${totalFreeSlots} free slots). Launching a new VM...`);
      await launchBackupVM();
    }

    // 5) Recompute protected VM policy
    recomputeProtectedVM();
  } catch (err) {
    console.error('[UPDATE_VMS] Unexpected error in updateVMs:', err?.message || err);
  }
}

// -------- API: match request handling --------
function handleMatchRequest(matchPrivacy = 'Public') {
  return async (req, res) => {
    const { matchId, gameMode, tickRate = 30, matchType } = req.body;
    if (!matchId || !gameMode || !SCENE_MAP[gameMode]) {
      return res.status(400).json({ error: 'Missing or invalid matchId/gameMode' });
    }

    try {
      const targetVM = await getAvailableVM();
      if (!targetVM) return res.status(503).json({ error: 'No VM available' });

      const payloadMatchType = matchType || (matchPrivacy === 'Private' ? 'CustomPrivate' : 'QuickPlay');
      const matchData = await launchUnityServerOnVM(
        targetVM.ip,
        matchId,
        gameMode,
        matchPrivacy,
        tickRate,
        payloadMatchType,
        process.env.PLAYFAB_SECRET_KEY
      );

      matches[matchId] = { ...matchData, startedAt: nowMs(), vmInstanceId: targetVM.instanceId };
      // increment the vmPool matchCount optimistically (may be corrected on next status refresh)
      if (vmPool[targetVM.instanceId]) vmPool[targetVM.instanceId].matchCount++;
      console.log(`[MATCH] ${matchId} started on ${targetVM.ip}:${matchData.serverPort}`);

      return res.json(matchData);
    } catch (err) {
      console.error('[MATCH ERROR]', err?.message || err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

app.post('/api/request-public-match', handleMatchRequest('Public'));
app.post('/api/request-private-match', handleMatchRequest('Private'));

app.get('/api/match-details/:matchId', (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });
  const matchData = matches[matchId];
  if (!matchData) return res.status(404).json({ error: 'Match not found' });
  return res.json(matchData);
});

// health & debug endpoints
app.get('/api/debug/vms', (req, res) => {
  return res.json({ protectedVM, vmPool, matches });
});

// -------- Start server & background tasks --------
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Allocator listening on port ${PORT}`);
  // initial sync & ensure minimum pool
  await updateVMs();
  // schedule periodic updates
  setInterval(updateVMs, UPDATE_INTERVAL_MS);
});
