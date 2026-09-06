# Copilot Repository Instructions

This project uses **Squad**, an AI team framework. Follow the Squad guidelines when picking up issues autonomously. The local development policies also apply to ordinary Copilot work in this repository.

## Coordinator Canary Check

**IMPORTANT — run this check on EVERY session start, before doing any work:**

Inspect your `agent_instructions` for the coordinator canaries. This is a **two-state payload-integrity check within a known Squad coordinator session**; it verifies whether the coordinator payload loaded fully or was visibly truncated. It is **not** proof that an agent with no canaries is safely non-Squad — wholly absent payloads and proven non-Squad agents require a host-level identity beacon before custom-agent instruction ingestion.

1. If the HEAD canary `SQUAD_COORDINATOR_CANARY_HEAD_b7d2` is **absent**, the Squad coordinator payload is not observable from inside this prompt. Treat non-Squad discrimination as an **OPEN host-level concern**; do not claim this check proved the current agent is non-Squad.
2. If the HEAD canary `SQUAD_COORDINATOR_CANARY_HEAD_b7d2` is **present** and the EOF canary `SQUAD_COORDINATOR_CANARY_a8f3` is **present**, the coordinator prompt loaded fully. Proceed with normal Squad behavior.
3. If the HEAD canary `SQUAD_COORDINATOR_CANARY_HEAD_b7d2` is **present** but the EOF canary `SQUAD_COORDINATOR_CANARY_a8f3` is **absent**, the coordinator prompt loaded but was **truncated** before the end.

**When the coordinator prompt is truncated, you MUST:**
1. **STOP** — do not proceed with standard Squad behavior.
2. **WARN the user** with this exact message:
   ```
   ⚠️ Squad coordinator (squad.agent.md) loaded but appears to be truncated before the EOF canary. Do NOT proceed with standard Squad behavior — Squad's safety rails are incomplete. Please restart your session.
   ```
3. Do not continue with normal Squad routing, spawning, PR, or branch-protection behavior after emitting the warning.

## Team Context

Before starting work on any issue:

1. Read `.squad/team.md` for the team roster, member roles, and your capability profile.
2. Read `.squad/routing.md` for work routing rules.
3. If the issue has a `squad:{member}` label, read that member's charter at `.squad/agents/{member}/charter.md` to understand their domain expertise and coding style — work in their voice.

## Capability Self-Check

Before starting work, check your capability profile in `.squad/team.md` under the **Coding Agent → Capabilities** section.

- **🟢 Good fit** — proceed autonomously.
- **🟡 Needs review** — proceed, but note in the PR description that a squad member should review.
- **🔴 Not suitable** — do NOT start work. Instead, comment on the issue:
  ```
  🤖 This issue doesn't match my capability profile (reason: {why}). Suggesting reassignment to a squad member.
  ```

## Branch Naming

Use the squad branch convention:
```
squad/{issue-number}-{kebab-case-slug}
```
Example: `squad/42-fix-login-validation`

## PR Guidelines

When opening a PR:
- Reference the issue: `Closes #{issue-number}`
- If the issue had a `squad:{member}` label, mention the member: `Working as {member} ({role})`
- If this is a 🟡 needs-review task, add to the PR description: `⚠️ This task was flagged as "needs review" — please have a squad member review before merging.`
- Follow any project conventions in `.squad/decisions.md`

## Decisions

If you make a decision that affects other team members, write it to:
```
.squad/decisions/inbox/copilot-{brief-slug}.md
```
The Scribe will merge it into the shared decisions file.

## Local Development

- Before NuGet package, restore, build, or test work, consult [NuGet.Config](../NuGet.Config) and honor its approved package source. Do not bypass it with alternate feeds or ad hoc `--source` overrides.

## Conventional Commit and Release Workflow

- When the user asks for a conventional commit message **for current local changes**, prepare the future extension version before returning the message, unless they explicitly request message-only/no version changes. This does not apply to questions about old commits or general explanations of the release process.
- Inspect the intended changes and choose a conventional type. Run `npm run release:prepare -- --type <type>`; add `--breaking` for breaking changes (`!` or a `BREAKING CHANGE` footer). Repository policy: `feat` bumps minor, breaking changes bump major (including before 1.0), and other supported types bump patch so documentation/walkthrough changes can also ship.
- Use the command's returned version and tag in the response. It derives the target from the highest reachable numeric `vX.Y.Z` tag (or committed manifest if no such tag exists), preserves an already-prepared higher version, and does not compound bumps on repeated requests. Do not manually increment it again. Keep local release tags up to date; preparation does not fetch from remotes.
- Only [the extension manifest](../extensions/flight-recorder/package.json) is versioned by this flow. Leave the private root package version unchanged. Tell the user to include/re-stage the changed manifest in their commit; do not stage, commit, tag, push, or publish simply because a message was requested.
- If preparing the version fails or edits are not permitted, report that explicitly; do not claim a version was updated or bypass permissions. Explain any staged/uncommitted changes without discarding them.
- After the user commits and pushes their changes to `origin/main`, they explicitly run **Tasks: Run Task > Flight Recorder: Create and Push Release Tag**, or `npm run release:tag`. The task requires clean `main`, checks the actual remote, creates an annotated tag from the committed extension version, and pushes only that tag. Never run it automatically while generating a commit message.
- A pushed tag starts validation and draft-release creation; publishing the GitHub release remains manual. These are local Copilot Chat instructions, not a Git hook or a guarantee that every editor's commit-message generator loads them. See [the release guide](../CONTRIBUTING.md#conventional-commit-and-release-flow).

## Local Flight Recorder Policy

### Scope, privacy, and availability

- This is the shared recording policy for ordinary Copilot, custom agents, and Squad agents whose host loads these instructions. Record substantive software-engineering tasks in local VS Code or Copilot CLI sessions unless the user opts out. Do not automatically record cloud/CI sessions, casual questions, or trivial reads.
- Use only the configured, trusted local `flightrecorder` MCP server and tools available to the current agent. These instructions do not start servers, enable tools, grant permissions, or override approvals or read-only restrictions. Never bypass a tool restriction through another API or agent.
- Sanitize the task request and every event field before sending them. Never send credentials, secrets, personal data, or unnecessary source content, even in `Full` mode. Server-side redaction is not a substitute for sanitizing inputs.
- If tools are missing, the server is unavailable, or recording permission is denied, state that recording is unavailable and continue the requested task within existing permissions. If recording fails after a run starts, retain its ID and disclose the gap or incomplete lifecycle; do not fabricate events or claim recording succeeded.
- Inspect an existing trace with `flightrecorder/get_flight_trace` and `flightrecorder/analyze_flight_run`. Inspection alone must not start a new run or complete the inspected run.

### Run ownership and delegation

1. The top-level agent owns one run for the task. Before substantive work, call `flightrecorder/start_flight_run` with:
   - a sanitized description of the user's task as `request`
   - `github-copilot-vscode` or `github-copilot-cli` as `entryPointAgent`, matching the actual local environment
   - a non-sensitive role description as `requestingIdentity`
   - `Redacted` recording unless the user explicitly requests another mode
2. Retain the returned `runId` for all recorder calls for this task. Use only explicitly supplied recording context; never guess the run from the latest entry in a shared server.
3. Before delegating, record an `AgentSpan` with `Started` status, the actual delegate's name, and a sanitized objective in the same run. For nested delegation, link this span to the inherited `parentEventId`. Pass the shared `runId`, the returned span's event ID as the child's `parentEventId`, the run owner's identity, and these recording/privacy rules explicitly in the delegation prompt. Do not assume subagents inherit instructions, context, or MCP access.
4. Delegates record significant events under their supplied `parentEventId`; they must not start a disconnected run or complete the shared run. A parent event must already exist in the same run. If context or recorder access is missing, return sanitized milestones and the recording limitation to the delegator instead. The owner records permitted returned evidence with clear subagent-reported attribution, without misrepresenting it as direct observation.
5. Only the run owner calls `flightrecorder/complete_flight_run`, after all participating delegates finish and their evidence is collected, then calls `flightrecorder/analyze_flight_run`. Include the run ID and a short trace summary in the final response. If contributors are still active, leave the run open and report it as unfinished. Confirm tool results before claiming completion or analysis succeeded.

### Significant evidence

- Perform the user's task with the normal development tools; recording supplements rather than replaces the work.
- Call `flightrecorder/record_flight_event` for significant milestones, not every trivial read:
  - delegation and its outcome as `AgentSpan`
  - observed model selections or concise decision summaries as `ModelCall`, not invented underlying calls or private reasoning
  - builds, tests, external APIs, and consequential commands as `ToolCall`
  - denied permissions or approval requirements as `PolicyDecision`
- Record accurate statuses and concise sanitized input/output. Supply timing, model, token, and cost data only when known; omit unknown optional measurements and do not describe default zeros as measured usage.
- Record failed or blocked operations before attempting recovery when recording remains available. Preserve successful evidence and append recovery or delegation outcomes linked to the relevant earlier event; do not erase failures.
- This is best-effort, agent-reported evidence, not automatic interception or a complete audit of every tool/model call. Guaranteed capture requires host/runtime instrumentation.
