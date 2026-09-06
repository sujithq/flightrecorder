# Agent Flight Recorder for VS Code

Open the Flight Recorder trace viewer as an editor panel. Inspect agent graphs,
policy decisions, timelines, evidence, and trace comparisons using the same
interface as the browser viewer.

## Run

1. Start the Flight Recorder API with its built viewer assets.
2. Set `flightRecorder.serverUrl` to your local API origin (default
   `http://localhost:5205`).
3. Run **Flight Recorder: Open Recorder** or **Flight Recorder: Select Run**
   from the Command Palette.

Only loopback addresses are accepted. The extension uses VS Code port forwarding
in remote workspaces and requires a trusted workspace. It does not start the
service, store credentials, or transmit traces to another service.

## Build from source

At the repository root, run `npm ci`, `npm run build:web`, and
`npm run package:vscode`. Install the resulting VSIX from `artifacts/` using
**Extensions: Install from VSIX**. An Extension Development Host can also load
this folder using `code --extensionDevelopmentPath=extensions/flight-recorder`.

The API must be running before opening a panel. If a previously stopped service
is restarted, run **Flight Recorder: Open Recorder** again to reload the frame.