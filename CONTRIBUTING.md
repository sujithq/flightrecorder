# Contributing

Thank you for contributing to Agent Flight Recorder.

## Prerequisites

- Git
- .NET SDK 10.0.303, as pinned by `global.json`
- Node.js 24 LTS and npm
- Python 3.11+ for the hardware-independent Badger2040 tests
- Docker with Compose 2.24.4+ when validating container changes and durable storage

## Set up the repository

```powershell
git clone https://github.com/sujithq/flightrecorder.git
cd flightrecorder
npm ci
npm run build:web
dotnet restore FlightRecorder.slnx --artifacts-path artifacts/validation
```

NuGet uses the approved feed in [NuGet.Config](NuGet.Config). Do not replace it with nuget.org or configure that NuGet endpoint as an npm registry.

Create a focused branch from `main` before making changes.

## Build and test

```powershell
dotnet build FlightRecorder.slnx -c Release --no-restore --artifacts-path artifacts/validation
dotnet test FlightRecorder.slnx -c Release --no-build --artifacts-path artifacts/validation
npm test
npm run test:badger
npm run test:e2e
npm run package:vscode
```

Browser tests start and stop the built API on port 5081 with an isolated temporary SQLite directory, removed after the run. They never reuse the user's recorder on 5080. API integration tests also use temporary databases through `FlightRecorderApiFactory`; direct unit tests use the in-memory store. Do not let tests write to a native user's local application data directory.

Windows uses installed Edge; other platforms need `npx playwright install chromium`. Set `PLAYWRIGHT_CHANNEL` to override the browser channel. `FLIGHTRECORDER_URL` explicitly opts into testing a running service and can add/prune its traces, so use only a disposable test server. The editor may not discover Node/Python or newly added .NET tests; the commands above are the authoritative checks.

No hardware or GitHub token is required for automated tests. Native VS Code panel behavior, physical Badger2040 updates, remote port forwarding, and publishing a live GitHub check need separate integration verification.

When changing VSIX setup or packaging, use the existing Node integration tests, then:

```powershell
npm run package:vscode
npm run test:vsix-setup
```

The VSIX acceptance test extracts the real package into temporary storage, builds from its
bundled context with local Docker, and verifies viewer/API/MCP readiness plus synthetic trace
persistence. It does not use a developer recorder or the workspace as a fallback build context.
Only its unique Compose project's containers and volume are removed; build cache is retained.
ZIP extraction uses PowerShell on Windows and `unzip` on Linux/macOS.

`tests/vscode/run.cjs` is a dependency-free VS Code extension-test-host smoke entry point.
Run it using `--extensionTestsPath` with an extracted VSIX as `--extensionDevelopmentPath`,
isolated `--user-data-dir` and `--extensions-dir`, and an unrelated test workspace.
It verifies real activation and command/provider registration without invoking setup.
Full setup dialogs and MCP trust approvals still require the clean-profile acceptance
checklist in the [getting-started guide](docs/getting-started.md#release-and-clean-install-acceptance).

When changing the container configuration, also run:

```powershell
docker compose build recorder
npm run test:persistence
```

The persistence test uses its own project-scoped named volume and random loopback port. It runs as the image's non-root user, sends SIGKILL to the API, verifies automatic recovery, recreates the container, reduces retention to three completed runs, and performs `down`/`up` without deleting the volume. Only its uniquely named test resources are deleted during cleanup. Never run `docker compose down -v` against the user's recorder to test durability.

Generated `bin`, `obj`, web assets, VSIX, test-result, coverage, database/journal files, and local secret files must not be committed. Some legacy build outputs are tracked; do not mix unrelated generated changes into a feature commit.

## Development guidelines

- Keep changes focused on one concern.
- Follow `.editorconfig` and existing C# conventions.
- Add or update tests for behavior changes.
- Preserve the privacy guarantees of each recording mode.
- Persist only the already-protected TraceRun, commit before acknowledging writes, and prune only completed runs transactionally. Do not treat a blocked/failed status as completion without `EndedAt`.
- Never add credentials, tokens, personal data, or captured sensitive payloads to tests or documentation.
- Update documentation when changing the API, MCP tools, configuration, or setup process.

## Pull requests

Before opening a pull request:

1. Rebase or merge the latest `main` branch.
2. Run the Release build and complete test suite.
3. Explain the motivation and user-visible behavior.
4. Link related issues.
5. Call out security, privacy, compatibility, or migration implications.

Use the pull request template and keep unrelated refactoring out of the change.

## Reporting security vulnerabilities

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md) instead.
