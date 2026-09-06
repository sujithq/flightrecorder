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

## Conventional commit and release flow

There are two deliberate actions: **prepare the version before committing**, then
**push a release tag after the commit is on main**. The [repository Copilot instructions](.github/copilot-instructions.md#conventional-commit-and-release-workflow)
tell local Copilot Chat agents to run preparation when you ask for a conventional
commit message for your current changes. No Git hook is installed, and the Source
Control panel's built-in message-generation button is not guaranteed to load that
workflow. You can use the commands/tasks directly for deterministic behavior.

### 1. Ask for the commit message

For example: "Give me a conventional commit message for these changes." Copilot
chooses the type and runs:

```powershell
npm run release:prepare -- --type feat
```

| Change | Version increment |
| --- | --- |
| `feat` | Minor: `0.2.1` -> `0.3.0` |
| Breaking change (`!` / `BREAKING CHANGE`) | Major: `0.2.1` -> `1.0.0` |
| `fix`, `docs`, `chore`, `perf`, `refactor`, `build`, `ci`, `test`, `style`, `revert` | Patch: `0.2.1` -> `0.2.2` |

For breaking changes, add `--breaking`. Use `--dry-run` to preview without editing:

```powershell
npm run release:prepare -- --type feat --breaking --dry-run
```

Preparation updates only the version property in [the extension manifest](extensions/flight-recorder/package.json).
It preserves formatting and all other changes, does not update the private root
package version, and never stages, commits, tags, pushes, installs dependencies, or
contacts a remote. Include **or re-stage** the manifest when you commit.

The target comes from the highest reachable numeric `vX.Y.Z` tag, not from the last
preparation. Asking twice keeps the same pending version. Asking for a patch after
a minor bump does not downgrade it; asking for a minor after a patch upgrades the
pending target. A manually chosen higher version is preserved. Without version
tags, the committed extension manifest is the baseline. Full Git history is required;
keep release tags current (for example, fetch tags before starting a release cycle).
This initial automation accepts numeric `X.Y.Z` versions; GitHub's prerelease
checkbox is a separate publication setting.

To select a type without Copilot, use **Tasks: Run Task > Flight Recorder: Prepare
Release Version**. If you want only wording without changes, tell Copilot
"message only; do not change the version."

### 2. Commit, push main, then run the release task

Review and commit the intended files, including the prepared version, and push or
merge that commit to `origin/main`. Switch to the synchronized local `main` branch.
Then run **Tasks: Run Task > Flight Recorder: Create and Push Release Tag**, or:

```powershell
npm run release:tag
```

The task refuses dirty worktrees (including untracked files), detached HEAD, feature
branches, a commit not at the remote's `main` tip, multiple push destinations, or
conflicting existing tags. It creates an annotated `v<committed extensionVersion>`
tag and pushes **only that tag**. It never pushes a branch, force-pushes, moves an
existing tag, or commits files. A retry of the same successfully pushed tag is a
no-op. If a push fails, the local tag is retained for a safe retry.

For a read-only check before publishing a tag, use **Flight Recorder: Check Release
Tag (Dry Run)** or `npm run release:tag -- --dry-run`. This check queries the remote,
but creates or pushes nothing.

Watch the **Draft release** GitHub Actions workflow after the tag push. A successful
push is not a completed release: validation must pass and you must review and publish
the resulting draft manually. Do not reuse a released version.

The tasks belong to this source repository; they are not end-user extension commands.
Test the scripts with the existing Node runner:

```powershell
node --test tests\integrations\release.test.mjs
```

Tests use disposable local Git repositories/remotes, not the project's GitHub remote.

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
