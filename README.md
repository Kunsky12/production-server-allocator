# Production Server Allocator

This repository contains a robust orchestration system designed to manage a fleet of virtual machines (VMs) for hosting real-time game matches. It dynamically provisions, scales, and monitors server instances on Tencent Cloud to ensure players can always find a match.

## Core Responsibilities

-   **Dynamic VM Provisioning**: Starts and stops spot instances on Tencent Cloud to match demand.
-   **Auto-Scaling**: Automatically scales the number of VMs up or down based on current server load and capacity thresholds.
-   **Health Checks & Failure Handling**: Monitors the status of each VM and automatically terminates unreachable or faulty instances.
-   **Load Balancing**: Distributes new game matches to the least-loaded available server.
-   **Containerized Match Hosting**: Each VM runs game matches in isolated Docker containers, managed by a local agent.

## Architecture

The system consists of two primary components:

1.  **Match Allocator (`match-allocator.js`)**: The central control plane. This Node.js application runs as a persistent service. It exposes an API for requesting new matches, maintains a pool of active VMs, and runs a periodic background task to manage the entire server fleet.

2.  **VM Agent (`matchLauncher.js`)**: A lightweight script intended to run on each provisioned game server VM. It listens for commands from the Match Allocator to launch new game server instances using Docker. It also provides a `/status` endpoint for health checks.

### Workflow

1.  A game client or backend service sends a `POST` request to the Match Allocator's API (e.g., `/api/request-public-match`).
2.  The Allocator identifies the least-loaded VM from its pool.
3.  If all VMs are near capacity, the Allocator provisions a new spot instance on Tencent Cloud using the parameters in `vmConfig.js`.
4.  The Allocator sends a `POST` request to the selected VM's agent (`/start-match`).
5.  The VM agent receives the request, finds an available UDP port, and launches a new Unity game server as a Docker container (`kunkhmerserver:latest`).
6.  The agent responds to the Allocator with the server's public IP and allocated port.
7.  The Allocator returns these connection details to the original game client.

## Features

-   **Cost-Efficient Scaling**: Utilizes Tencent Cloud's `SPOTPAID` instances to minimize hosting costs.
-   **Protected VM Policy**: Designates one VM as "protected" to prevent the entire fleet from scaling down to zero, ensuring at least one warm server is always ready.
-   **Configurable Scaling Logic**: All scaling parameters (min/max VMs, capacity thresholds, termination policies) are configurable via environment variables.
-   **Graceful Shutdown**: Idle VMs are terminated only if they are not protected and the fleet size is above the configured minimum. New VMs are given a grace period before they are eligible for termination.
-   **Resiliency**: Automatically removes VMs that fail consecutive health checks and replaces them to maintain capacity.

## Configuration

The system is configured using environment variables. Create a `.env` file in the root directory.

### Tencent Cloud & VM Configuration (`vmConfig.js`)
```
# Tencent Cloud Credentials
TENCENT_SECRET_ID=your_secret_id
TENCENT_SECRET_KEY=your_secret_key
TENCENT_REGION=ap-singapore

# VM Launch Parameters
INSTANCE_TYPE=S5.MEDIUM4
IMAGE_ID=img-xxxxxxxx          # Your base VM image with Docker and the agent pre-installed
ZONE=ap-singapore-2
VPC_ID=vpc-xxxxxxxx
SUBNET_ID=subnet-xxxxxxxx
SG_ID=sg-xxxxxxxx              # Security Group ID
```

### Allocator Logic (`match-allocator.js`)
```
# Server Port
PORT=7777

# Game Server Key
PLAYFAB_SECRET_KEY=your_playfab_secret

# Scaling Rules
FULL_MATCH_LIMIT=5                 # Max matches per VM before it's considered full
MAX_BACKUP_VMS=10                  # Maximum number of VMs in the pool
MIN_BACKUP_VMS=1                   # Minimum number of VMs to keep running
NEAR_CAPACITY_THRESHOLD=1          # Launch a new VM when total free slots drops to this number
VM_UNREACHABLE_TERMINATE_THRESHOLD=2 # Terminate VM after this many consecutive failed health checks
VM_AGE_TERMINATE_MINUTES=5         # Minimum age in minutes before an idle VM can be terminated

# Timing
STATUS_TIMEOUT_MS=5000             # Timeout for VM health check requests
UPDATE_INTERVAL_MS=30000           # Frequency of the main auto-scaling/health-check loop
```

## API Endpoints

The `match-allocator.js` service exposes the following endpoints:

#### `POST /api/request-public-match`
Requests a new public game match.

**Body:**
```json
{
  "matchId": "unique-match-identifier",
  "gameMode": "VersusMen_Online",
  "tickRate": 30
}
```

**Success Response (200):**
```json
{
  "serverIP": "123.45.67.89",
  "serverPort": 7800,
  "matchId": "unique-match-identifier",
  "gameMode": "VersusMen_Online",
  "tickRate": 30,
  "containerId": "docker-container_id"
}
```

**Error Response (503):**
```json
{
  "error": "No VM available"
}
```

#### `POST /api/request-private-match`
Requests a new private game match. The payload is identical to the public match endpoint.

#### `GET /api/match-details/:matchId`
Retrieves the details of a running match.

#### `GET /api/debug/vms`
A debugging endpoint that returns the current internal state of the allocator, including the VM pool and active matches.

## Setup and Usage

### Prerequisites
-   Node.js and npm
-   A Tencent Cloud account
-   A pre-built Docker image for your game server (e.g., `kunkhmerserver:latest`) pushed to a registry accessible by your VMs.
-   A base VM image (`IMAGE_ID`) that has Docker, Node.js, and the repository code pre-installed. The `matchLauncher.js`-based agent should be configured to run on boot.

### Running the Allocator

1.  Clone the repository:
    ```sh
    git clone https://github.com/kunsky12/production-server-allocator.git
    cd production-server-allocator
    ```

2.  Install dependencies:
    ```sh
    npm install
    ```

3.  Create and populate your `.env` file with the required configuration variables.

4.  Start the allocator service:
    ```sh
    node match-allocator.js
    ```
The allocator will start, perform an initial sync with Tencent Cloud, and begin managing the server pool.
