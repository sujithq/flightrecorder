# Contributing

Thank you for contributing to Agent Flight Recorder.

## Prerequisites

- Git
- .NET SDK 10.0.303, as pinned by `global.json`
- Node.js 24 LTS and npm
- Python 3.11+ for the hardware-independent Badger2040 tests
- Docker, only when validating container changes

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

Browser tests start and stop the built API on port 5080. Windows uses installed Edge; other platforms need `npx playwright install chromium`. Set `PLAYWRIGHT_CHANNEL` to override the browser channel or `FLIGHTRECORDER_URL` to target a running service. The editor may not discover Node/Python or newly added .NET tests; the commands above are the authoritative checks.

No hardware or GitHub token is required for automated tests. Native VS Code panel behavior, physical Badger2040 updates, remote port forwarding, and publishing a live GitHub check need separate integration verification.

When changing the container configuration, also run:

```powershell
docker build --tag flightrecorder:dev .
```

Generated `bin`, `obj`, web assets, VSIX, test-result, coverage, and local secret files must not be committed. Some legacy build outputs are tracked; do not mix unrelated generated changes into a feature commit.

## Development guidelines

- Keep changes focused on one concern.
- Follow `.editorconfig` and existing C# conventions.
- Add or update tests for behavior changes.
- Preserve the privacy guarantees of each recording mode.
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
