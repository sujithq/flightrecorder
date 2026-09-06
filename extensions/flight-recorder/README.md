# Agent Flight Recorder for VS Code

Open the Flight Recorder trace viewer as an editor panel. Inspect agent graphs,
policy decisions, timelines, evidence, and trace comparisons using the same
interface as the browser viewer.

## Run

1. Start the Docker recorder with `docker compose up --build --detach` from the repository root.
2. The panel defaults to `http://localhost:5080`. Set `flightRecorder.serverUrl`
   only when using a different local API origin.
3. Run **Flight Recorder: Open Recorder** or **Flight Recorder: Select Run**
   from the Command Palette.

Only loopback addresses are accepted. The extension uses VS Code port forwarding
in remote workspaces and requires a trusted workspace. It does not start the
service, store credentials, or transmit traces to another service.

When upgrading from 0.1.0, install the updated VSIX and reopen the panel. A saved
`flightRecorder.serverUrl` setting is not overwritten: reset it to the new default
or change it to `http://localhost:5080` if it still points to the old port.
Native development on port 5205 remains available through an explicit setting.

## Build from source

At the repository root, run `npm ci`, `npm run build:web`, and
`npm run package:vscode`. Install `artifacts/flight-recorder-0.1.1.vsix` using
**Extensions: Install from VSIX**. An Extension Development Host can also load
this folder using `code --extensionDevelopmentPath=extensions/flight-recorder`.

The API must be running before opening a panel. If a previously stopped service
is restarted, run **Flight Recorder: Open Recorder** again to reload the frame.