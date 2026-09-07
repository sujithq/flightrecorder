# Collect native Copilot usage locally

The VSIX can read a **selected local Copilot session** and import its usage
metadata. This is separate from the MCP recording instructions and the
[application-owned SDK adapter](../integrations/copilot-sdk/README.md).
It does not intercept model calls, scrape remote accounts, or guarantee that every
Copilot version saves token counts.

## Quickstart

1. Install a release containing the collector, then **Rebuild / Update Local
   Recorder** so the API supports usage imports. Keep the viewer and collector on
   the same local endpoint.
2. In a trusted local desktop VS Code window, run **Flight Recorder: Collect Local
   Copilot Usage**. Review the read-access prompt before allowing discovery.
3. Choose **Discover local Copilot sessions**, or choose your own Chat JSON/JSONL
   file or Copilot CLI database/events file. Select the intended session explicitly;
   the collector never assumes the most recent session is yours.
4. Choose **Measured usage only** (recommended). Alternatively, explicitly enable
   visible-text estimates for requests with no measurements. This reads selected
   transcript text in memory to count characters but never sends that text.
5. Choose **Create a dedicated session-usage run**, or select an existing run that
   represents that entire session and contains no overlapping SDK/manual usage.
6. Confirm the session-to-run mapping and select **Start Collection**. The Output
   channel **Flight Recorder Usage** shows measured, estimated, and unavailable
   observation counts. Choose **Open Recorder** to inspect the result.
7. Use **Stop Local Usage Collection** when done. It stops polling and completes
   a dedicated run created by this collector only after successful import. It
   does not complete a pre-existing run or declare a failed import successful.

The collection loop rechecks every ten seconds while that window remains open.
**Import Bound Session Usage Now** immediately imports and resumes a paused
binding after you resolve its error. **Show Local Usage Collection Status** shows
the run and polling/error state.

Closing or reloading VS Code stops collection; it does not complete a run while
the extension is disposing. Re-enable collection and select the same source and
existing run to resume. Source paths and bindings live in window memory, not
Settings Sync, workspace files, or a machine-wide automatic watcher.

## Sources and quality

| Source | Supported usage |
| --- | --- |
| VS Code Chat JSON / supported JSONL layouts | Request result usage fields, when saved by that Chat version |
| Copilot CLI `session-store.db` | Numeric/model/billing fields from `assistant_usage_events` for the selected session |
| Supported CLI `events.jsonl` | Recorded usage events or supported shutdown totals, without adding both representations |

Discovery is bounded to the current VS Code profile's known session directories
and the current user's conventional Copilot directory. It does not scan other
users, all disks, WSL mounts, or remote hosts. Use the manual file picker when your
profile/storage layout differs. The picker can show a local file path to help you
choose; that path is never uploaded to the recorder.

SQLite support uses the extension host's built-in `node:sqlite` when available,
opening the database read-only. If unavailable or the table/schema is not supported,
the command reports the limitation. It does not install SQLite, run external database
commands, modify the database, or read the conversation/turn tables.

These are persisted implementation formats, **not stable public APIs**. Unknown
layouts, inaccessible/oversized files, incomplete writes, and invalid measurements
are diagnosed rather than silently converted to zeros. A file can change while
Copilot is writing it; retry after the writer has completed the record.

### Measured, estimated, unavailable

- **Measured**: numeric usage fields were reported by the source. Missing input or
  output fields remain missing; an explicit numeric zero stays zero.
- **Estimated**: only after opt-in, approximate visible-text counts using
  `ceil(characters / 4)`. These are not a tokenizer count, not the complete hidden
  context, and not billed usage. They are shown separately, never added to the
  measured token total or used to calculate a provider/API cost.
- **Unavailable**: the recognized source observation lacks supported measurements
  (and estimates were disabled or there was no supported text to estimate).

Imported events include source kind, format, opaque fingerprints and quality in
the viewer's **Local usage provenance** section. No request prompts, assistant
text, tool output, repository path, raw session ID or credential is imported.
The API validates the metadata shape; it does not accept an arbitrary transcript.

### Copilot billing is not an API price estimate

When the source actually reports `total_nano_aiu`, it is kept as raw billing units.
The viewer shows **Reported Copilot credits** (`nano-AIU / 1e9`) and a separate
**Credit-equivalent USD** (`nano-AIU / 1e11` at $0.01 per credit).
These indicate source-reported usage value, **not additional invoice charges**:
included allowances, plan terms and organizational adjustments still matter.
This does not use an arbitrary SDK `cost` multiplier or pretend provider API rates
are Copilot prices. Missing billing units stay **Not reported**.

The source/unit interpretation follows the verified implementation described by
[AI Engineering Fluency](https://github.com/rajbos/ai-engineering-fluency/blob/84621ad408b84455db229a0360a0c6ce7e221c73/src/tokenEstimation.ts#L264-L270).
GitHub describes additional AI-credit charges in its
[billing documentation](https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises/fundamentals).
Persisted schema and billing-unit changes require updating the adapter, not guessing
a new conversion.

## Preventing duplicates and incorrect attribution

The API accepts a whole-source snapshot under an opaque source fingerprint and
revision, rather than appending the cumulative token total every poll. Repeating an
unchanged snapshot is a no-op; updated observations retain their event identity.
Revision checks reject concurrent stale updates. A missing observation is not silently
treated as a known zero or attributed to another session.

One session source per run is supported. Importing another source into the same run,
or mixing imported usage with SDK/manual measured usage, is rejected to avoid
counting the same model work twice. If a single chat spans several tasks, a session
total cannot safely be assigned to just one of them; use a dedicated session-usage run.
The source-selection confirmation is the attribution boundary, not time proximity
or "latest run."

No collector is enabled on installation/activation, and MCP recording alone does not
opt you into local storage access. Organization restrictions and workspace trust
still apply. **Stop Local Usage Collection** discards the in-memory source binding;
already-imported metadata remains subject to normal recorder retention.

## Troubleshooting

- **No sessions discovered:** choose a file manually; your current Copilot
  runtime may use a different storage format or not persist usage.
- **Measurements unavailable:** check the Output channel. Optional text estimates
  can provide a rough separate indicator, but cannot recover billed token counts.
- **HTTP 404:** rebuild/update the recorder API or select a retained run.
- **HTTP 409:** another import changed the revision, the run belongs to another
  source, or it contains overlapping usage. Review the run and rebind explicitly.
- **Stopped/changed endpoint:** ensure the recorder is running; stop and rebind
  when changing its URL. The collector will not silently follow another endpoint.
- **Collection paused:** resolve the reported source/API issue, then use
  **Import Bound Session Usage Now**. No automatic blind retry of failed writes occurs.

Tests use synthetic source fixtures and isolated API instances, not your private
Copilot history. Actual coverage on your installation depends on fields your
Copilot runtime persisted.
