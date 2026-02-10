// matchLauncher.js
const { exec } = require('child_process');
const util = require('util');
const net = require('net');

const execAsync = util.promisify(exec);

const FULL_MATCH_LIMIT = 25;
const SCENE_MAP = {
  VersusMen_Online: 'SelectionScreenMen_Online',
  VersusWomen_Online: 'SelectionScreenWomen_Online',
  KunBoran_Online: 'SelectionScreenMen_Online_KunBoran'
};

// Check running docker containers labeled match_server=true
function getRunningMatchCount() {
  return new Promise((resolve) => {
    exec(`docker ps --filter "label=match_server=true" --format "{{.ID}}" | wc -l`, (err, stdout) => {
      resolve(err ? 0 : parseInt(stdout.trim()) || 0);
    });
  });
}

// Check if a port is free on local machine
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        server.close();
        resolve(true);
      })
      .listen(port);
  });
}

// Try to find a random available port in range
async function getRandomAvailablePort(min = 7000, max = 7999) {
  for (let i = 0; i < 20; i++) {
    const port = Math.floor(Math.random() * (max - min + 1)) + min;
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

/**
 * Launch a Unity server Docker container with given parameters.
 * Throws if limits exceeded or no port available.
 *
 * @param {string} matchId - Unique match ID
 * @param {number|null} port - Port number or null to auto assign
 * @param {string} gameMode - One of SCENE_MAP keys
 * @param {string} matchPrivacy - e.g. "Public" or "Private"
 * @param {number} tickRate - Server tick rate
 * @param {string} matchType - Match type for tracking
 * @param {string} playfabSecret - PlayFab secret key for env var injection
 * @param {string} publicIP - IP to report back to clients
 * @returns {Promise<object>} matchData with serverIP, serverPort, scene, etc.
 */
async function launchUnityServer(
  matchId,
  port,
  gameMode,
  matchPrivacy = 'Public',
  tickRate = 30,
  matchType = 'QuickPlay',
  playfabSecret,
  publicIP
) {
  const runningCount = await getRunningMatchCount();
  if (runningCount >= FULL_MATCH_LIMIT) {
    throw new Error(`Match limit reached: ${runningCount} matches running.`);
  }

  if (!gameMode || !SCENE_MAP[gameMode]) {
    throw new Error(`Invalid scene: ${gameMode}`);
  }
  const scene = SCENE_MAP[gameMode];

  if (!port) {
    port = await getRandomAvailablePort();
    if (!port) throw new Error('No available ports');
  }

  // Compose docker run command
  const dockerCmd = `docker run -d --name ${matchId} --label match_server=true ` +
    `-e PLAYFAB_SECRET_KEY=${playfabSecret} ` +
    `--cpus=0.35 --memory=350m ` +
    `-p ${port}:7777/udp ` +
    `kunkhmerserver:latest ` +
    `Game/KunKhmerLinuxServer.x86_64 -nographics -batchmode ` +
    `-matchId=${matchId} -scene=${scene} -matchPrivacy=${matchPrivacy} -servertickRate=${tickRate} -matchType=${matchType}`;

  const { stdout } = await execAsync(dockerCmd);

  console.log(`[DOCKER] Started match ${matchId} on port ${port} -> container: ${stdout.trim()}`);

  return {
    matchId,
    serverIP: publicIP,
    serverPort: port,
    gameMode,
    matchPrivacy,
    tickRate,
    matchType,
  };
}

module.exports = {
  launchUnityServer,
  getRunningMatchCount,
  getRandomAvailablePort,
  isPortAvailable,
  SCENE_MAP,
  FULL_MATCH_LIMIT,
};
