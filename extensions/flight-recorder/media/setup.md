# Your recorder stays local

Run **Flight Recorder: Set Up Local Recorder** to build the release's bundled
source with Docker. Installation happens only after you confirm.

- Docker with Compose v2 and a running Linux-container engine is required.
- Uncached base images and packages require internet access.
- NuGet restores use the bundled approved `NuGet.Config`.
- The service binds only to loopback and stores traces in a persistent Docker volume.
- Restart with Docker is off by default. Enabling it does not change OS startup settings.
- No service starts simply because you open VS Code.

Use **Show Local Recorder Status** to verify setup and **Show Local Recorder Logs**
for diagnostics. Stopping the service does not delete its traces.

Docker Desktop can require a paid subscription for some organizations. Follow the
official installation guidance for your operating system and organization.
