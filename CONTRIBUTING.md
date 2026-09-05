# Contributing

Thank you for contributing to Agent Flight Recorder.

## Prerequisites

- Git
- .NET SDK 10.0.303, as pinned by `global.json`
- Docker, only when validating container changes

## Set up the repository

```powershell
git clone https://github.com/sujithq/flightrecorder.git
cd flightrecorder
dotnet restore FlightRecorder.slnx
```

Create a focused branch from `main` before making changes.

## Build and test

```powershell
dotnet build FlightRecorder.slnx -c Release --no-restore
dotnet test FlightRecorder.slnx -c Release --no-build
```

When changing the container configuration, also run:

```powershell
docker build --tag flightrecorder:dev .
```

Generated `bin`, `obj`, test-result, coverage, and local secret files must not be committed.

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
