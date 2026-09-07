using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public sealed class TraceExportService(TraceRedactor redactor)
{
    public JsonObject Otlp(TraceRun run)
    {
        var spans = new List<object>();
        var runAttributes = new List<object>
        {
            Text("gen_ai.agent.name", run.EntryPointAgent),
            Text("flightrecorder.recording_mode", run.RecordingMode.ToString()),
            Text("flightrecorder.identity.id", run.RequestingIdentity)
        };
        var lastEventTime = run.Events.Select(evt => evt.EndedAt ?? evt.StartedAt).DefaultIfEmpty(run.StartedAt).Max();
        var endTime = run.EndedAt ?? (lastEventTime > run.StartedAt ? lastEventTime : run.StartedAt);
        spans.Add(Span(run.Id, run.Id, null, run.EntryPointAgent, 1, run.StartedAt, endTime, run.Status, runAttributes));
        foreach (var evt in run.Events)
        {
            var attributes = new List<object>
            {
                Text("flightrecorder.event.id", evt.Id.ToString()),
                Text("flightrecorder.event.type", evt.Type.ToString()),
                Text("flightrecorder.event.status", evt.Status.ToString())
            };
            if (evt.InputTokens is { } inputTokens) attributes.Add(Integer("gen_ai.usage.input_tokens", inputTokens));
            if (evt.OutputTokens is { } outputTokens) attributes.Add(Integer("gen_ai.usage.output_tokens", outputTokens));
            if (evt.TaskId is { } taskId) attributes.Add(Identifier("flightrecorder.task.id", taskId.ToString("D")));
            if (evt.ParentTaskId is { } parentTaskId) attributes.Add(Identifier("flightrecorder.task.parent_id", parentTaskId.ToString("D")));
            if (evt.ChatSessionId is { } chatSessionId) attributes.Add(Identifier("flightrecorder.chat.session_id", chatSessionId));
            if (evt.ChatTurnId is { } chatTurnId) attributes.Add(Identifier("flightrecorder.chat.turn_id", chatTurnId));
            if (evt.SubagentSessionId is { } subagentSessionId) attributes.Add(Identifier("flightrecorder.subagent.session_id", subagentSessionId));
            if (evt.TraceId is { } traceId) attributes.Add(Identifier("flightrecorder.trace.id", traceId));
            if (evt.SpanId is { } spanId) attributes.Add(Identifier("flightrecorder.span.id", spanId));
            if (evt.ReportedAiCredits is { } reportedAiCredits) attributes.Add(Decimal("gen_ai.usage.ai_credits", reportedAiCredits));
            if (evt.EstimatedAiCredits is { } estimatedAiCredits) attributes.Add(Decimal("flightrecorder.usage.estimated_ai_credits", estimatedAiCredits));
            if (evt.ImportedUsage is { } imported)
            {
                attributes.Add(Identifier("flightrecorder.usage.source_id", imported.SourceId));
                attributes.Add(Identifier("flightrecorder.usage.observation_id", imported.ObservationId));
                attributes.Add(Text("flightrecorder.usage.source_kind", imported.SourceKind));
                attributes.Add(Text("flightrecorder.usage.format", imported.Format));
                attributes.Add(Text("flightrecorder.usage.quality", imported.Quality));
                attributes.Add(Text("flightrecorder.usage.timestamp_meaning", imported.TimestampMeaning));
                if (imported.EstimatedInputTokens is { } estimatedInput)
                    attributes.Add(Integer("flightrecorder.usage.estimated_input_tokens", estimatedInput));
                if (imported.EstimatedOutputTokens is { } estimatedOutput)
                    attributes.Add(Integer("flightrecorder.usage.estimated_output_tokens", estimatedOutput));
                if (imported.CacheReadTokens is { } cacheRead)
                    attributes.Add(Integer("flightrecorder.usage.cache_read_tokens", cacheRead));
                if (imported.CacheWriteTokens is { } cacheWrite)
                    attributes.Add(Integer("flightrecorder.usage.cache_write_tokens", cacheWrite));
                if (imported.NanoAiu is { } nanoAiu)
                {
                    attributes.Add(Integer("flightrecorder.usage.nano_aiu", nanoAiu));
                    attributes.Add(Decimal("flightrecorder.usage.copilot_credits", nanoAiu / 1_000_000_000m));
                    attributes.Add(Decimal("flightrecorder.usage.copilot_usage_value_usd", nanoAiu / 100_000_000_000m));
                }
            }
            if (evt.EstimatedCost is { } cost)
            {
                attributes.Add(new { key = "flightrecorder.estimated_cost", value = new { doubleValue = (double)cost } });
                attributes.Add(Text("flightrecorder.cost_currency", "USD"));
                if (evt.CostBasis is { } basis) attributes.Add(Text("flightrecorder.cost_basis", basis));
            }
            (string Key, string? Value)[] metadata =
            [
                ("gen_ai.agent.name", evt.AgentName), ("gen_ai.agent.version", evt.AgentVersion),
                ("gen_ai.request.model", evt.Model), ("flightrecorder.tool.server", evt.ToolServer),
                ("flightrecorder.identity.id", evt.Identity), ("flightrecorder.policy.name", evt.PolicyName),
                ("flightrecorder.policy.reason", evt.PolicyReason),
                ("flightrecorder.permission.requested", evt.RequestedScope),
                ("flightrecorder.permission.granted", evt.GrantedScope)
            ];
            attributes.AddRange(metadata.Where(item => item.Value is not null).Select(item => Text(item.Key, item.Value!)));
            if (evt.Type == FlightEventType.ToolCall) attributes.Add(Text("gen_ai.tool.name", evt.Name));
            if (evt.Type == FlightEventType.PolicyDecision)
                attributes.Add(Text("flightrecorder.policy.decision", evt.Status.ToString()));
            spans.Add(Span(run.Id, evt.Id, evt.ParentEventId ?? run.Id, evt.Name,
                evt.Type is FlightEventType.ToolCall or FlightEventType.ModelCall ? 3 : 1,
                evt.StartedAt, evt.EndedAt ?? evt.StartedAt, evt.Status, attributes));
        }
        return JsonSerializer.SerializeToNode(new
        {
            resourceSpans = new[]
            {
                new
                {
                    resource = new { attributes = new[] { Text("service.name", "agent-flight-recorder") } },
                    scopeSpans = new[] { new { scope = new { name = "FlightRecorder", version = "1.0.0" }, spans } }
                }
            }
        })!.AsObject();
    }

    public JsonObject GitHubCheck(TraceRun run, Uri? viewerBaseUri = null)
    {
        if (viewerBaseUri is not null && (viewerBaseUri.Scheme != "https" &&
            !(viewerBaseUri.Scheme == "http" && viewerBaseUri.IsLoopback)))
            throw new ArgumentException("Viewer URL must use HTTPS or loopback HTTP.", nameof(viewerBaseUri));
        var metrics = TraceViewService.Metrics(run);
        var tokens = metrics.InputTokens.HasValue || metrics.OutputTokens.HasValue
            ? ((metrics.InputTokens ?? 0) + (metrics.OutputTokens ?? 0)).ToString(CultureInfo.InvariantCulture) +
                (run.Usage.TokensComplete ? "" : " (partial)")
            : "Not reported";
        var cost = metrics.EstimatedCost is { } estimate
            ? (estimate is > 0 and < 0.0001m ? "<$0.0001" : estimate.ToString("$0.0000", CultureInfo.InvariantCulture)) +
                (run.Usage.CostComplete ? "" : " (partial)")
            : "Not reported";
        var summary = new StringBuilder()
            .AppendLine($"## Agent Flight Recorder: {run.Status}")
            .AppendLine()
            .AppendLine($"Run `{run.Id}` | Agent: {Markdown(run.EntryPointAgent)}")
            .AppendLine()
            .AppendLine("| Events | Duration | Reported tokens | Reported estimate (USD) |")
            .AppendLine("| ---: | ---: | ---: | ---: |")
            .AppendLine(FormattableString.Invariant($"| {metrics.EventCount} | {metrics.DurationMilliseconds / 1000:0.###} s | {tokens} | {cost} |"))
            .AppendLine()
            .AppendLine("Usage totals cover reported events only, not unobserved model calls. Missing usage or pricing is not zero. USD estimates are not Copilot billing credits.");
        if (run.EstimatedInputTokens.HasValue || run.EstimatedOutputTokens.HasValue)
            summary.AppendLine().AppendLine(FormattableString.Invariant(
                $"Recorded token estimates (not measured): input {run.EstimatedInputTokens?.ToString(CultureInfo.InvariantCulture) ?? "Not reported"}, output {run.EstimatedOutputTokens?.ToString(CultureInfo.InvariantCulture) ?? "Not reported"}."));
        if (run.CopilotCredits is { } credits)
            summary.AppendLine().AppendLine(FormattableString.Invariant(
                $"Copilot credits: {credits:0.#########}; Copilot credit-equivalent USD: ${run.CopilotUsageValueUsd:0.###########}. Source accounting value, not an invoice or model-price estimate."));
        if (run.ReportedAiCredits is { } reported)
            summary.AppendLine().AppendLine(FormattableString.Invariant(
                $"Reported AI credits: {reported:0.#########}."));
        if (run.EstimatedAiCredits is { } estimatedAiCredits)
            summary.AppendLine().AppendLine(FormattableString.Invariant(
                $"Estimated AI credits: {estimatedAiCredits:0.#########}. Estimates are never treated as billing truth."));
        if (run.UsageImports is { Count: > 0 })
            summary.AppendLine().AppendLine("Imported snapshots may be partial. A newer revision replaces prior counters; withdrawn observations remain as unavailable evidence.");
        var details = new StringBuilder("## Decision evidence\n\n");
        var detailBytes = Encoding.UTF8.GetByteCount(details.ToString());
        var listedEvents = 0;
        foreach (var evt in run.Events.Take(50))
        {
            var label = Markdown(evt.Name);
            var evidence = viewerBaseUri is null ? $"{label} (`{evt.Id}`)"
                : $"[{label}]({ViewerLink(viewerBaseUri, run.Id, evt.Id)})";
            var entry = new StringBuilder().AppendLine($"- **{evt.Status}**: {evidence}");
            if (evt.Type == FlightEventType.PolicyDecision)
                entry.AppendLine($"  Identity: {Markdown(evt.Identity)}; requested: {Markdown(evt.RequestedScope)}; granted: {Markdown(evt.GrantedScope)}; policy: {Markdown(evt.PolicyName)}. {Markdown(evt.PolicyReason)}");
            var entryText = entry.ToString();
            var entryBytes = Encoding.UTF8.GetByteCount(entryText);
            if (detailBytes + entryBytes > 60_000) break;
            details.Append(entryText);
            detailBytes += entryBytes;
            listedEvents++;
        }
        if (run.Events.Count > listedEvents) details.AppendLine($"\nShowing {listedEvents} of {run.Events.Count} events.");
        var check = new JsonObject
        {
            ["name"] = "Agent Flight Recorder",
            ["external_id"] = run.Id.ToString(),
            ["status"] = run.EndedAt is null ? "in_progress" : "completed",
            ["started_at"] = run.StartedAt.ToString("O"),
            ["output"] = new JsonObject
            {
                ["title"] = $"Agent run: {run.Status}",
                ["summary"] = summary.ToString(),
                ["text"] = details.ToString()
            }
        };
        if (viewerBaseUri is not null) check["details_url"] = ViewerLink(viewerBaseUri, run.Id);
        if (run.EndedAt is { } endedAt)
        {
            check["completed_at"] = endedAt.ToString("O");
            check["conclusion"] = run.Status switch
            {
                FlightEventStatus.Failed => "failure",
                FlightEventStatus.Blocked or FlightEventStatus.RequiresApproval => "action_required",
                _ => "success"
            };
        }
        return check;
    }

    public BadgeSummary Badge(TraceRun run)
    {
        var alert = run.Events.FirstOrDefault(evt => evt.Status is FlightEventStatus.Blocked or
            FlightEventStatus.RequiresApproval or FlightEventStatus.Failed);
        return new BadgeSummary(2, run.Id.ToString(), BadgeText(run.EntryPointAgent, 28), run.Status.ToString(),
            run.Events.Count, run.Usage.TokensComplete ? run.InputTokens + run.OutputTokens : null,
            Math.Round(run.Duration.TotalSeconds, 1), run.Usage.CostComplete ? run.EstimatedCost : null,
            alert is null ? null : BadgeText(alert.Name, 64));
    }

    private object Span(Guid runId, Guid eventId, Guid? parentId, string name, int kind,
        DateTimeOffset startedAt, DateTimeOffset endedAt, FlightEventStatus status, List<object> attributes)
        => new
        {
            traceId = runId.ToString("N"), spanId = SpanId(eventId),
            parentSpanId = parentId is { } parent ? SpanId(parent) : "",
            name = redactor.Redact(name), kind,
            startTimeUnixNano = Nanoseconds(startedAt), endTimeUnixNano = Nanoseconds(endedAt), attributes,
            status = new { code = status == FlightEventStatus.Started ? 0 : status == FlightEventStatus.Succeeded ? 1 : 2 }
        };

    private object Text(string key, string value) => new { key, value = new { stringValue = redactor.Redact(value) } };
    private static object Identifier(string key, string value) => new { key, value = new { stringValue = value } };
    private static object Decimal(string key, decimal value) => new { key, value = new { doubleValue = (double)value } };
    private static object Integer(string key, long value) => new { key, value = new { intValue = value.ToString(CultureInfo.InvariantCulture) } };
    private static string SpanId(Guid identifier) => identifier.ToString("N")[..16];
    private static string Nanoseconds(DateTimeOffset timestamp)
        => ((decimal)(timestamp.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) * 100).ToString("0", CultureInfo.InvariantCulture);
    private static string ViewerLink(Uri baseUri, Guid runId, Guid? eventId = null)
        => new Uri(baseUri, $"?run={runId}" + (eventId is null ? "" : $"&event={eventId}")).AbsoluteUri;

    private string Markdown(string? value)
    {
        var safe = redactor.Redact(value) ?? "not recorded";
        safe = safe.Length > 400 ? safe[..400] + "..." : safe;
        safe = safe.Replace("\r", " ").Replace("\n", " ").Replace("&", "&amp;")
            .Replace("<", "&lt;").Replace(">", "&gt;");
        foreach (var character in new[] { "\\", "`", "*", "_", "[", "]", "|" }) safe = safe.Replace(character, "\\" + character);
        return safe;
    }

    private string BadgeText(string value, int length)
        => new((redactor.Redact(value) ?? "").Take(length).Select(character => character is >= ' ' and <= '~' ? character : '?').ToArray());
}