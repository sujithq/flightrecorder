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
                Text("flightrecorder.event.status", evt.Status.ToString()),
                Integer("gen_ai.usage.input_tokens", evt.InputTokens),
                Integer("gen_ai.usage.output_tokens", evt.OutputTokens),
                new { key = "flightrecorder.estimated_cost", value = new { doubleValue = (double)evt.EstimatedCost } }
            };
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
        var summary = new StringBuilder()
            .AppendLine($"## Agent Flight Recorder: {run.Status}")
            .AppendLine()
            .AppendLine($"Run `{run.Id}` | Agent: {Markdown(run.EntryPointAgent)}")
            .AppendLine()
            .AppendLine("| Events | Duration | Tokens | Estimated cost (USD) |")
            .AppendLine("| ---: | ---: | ---: | ---: |")
            .AppendLine(FormattableString.Invariant($"| {metrics.EventCount} | {metrics.DurationMilliseconds / 1000:0.###} s | {metrics.InputTokens + metrics.OutputTokens} | ${metrics.EstimatedCost:0.0000} |"));
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
        return new BadgeSummary(1, run.Id.ToString(), BadgeText(run.EntryPointAgent, 28), run.Status.ToString(),
            run.Events.Count, run.Events.Sum(evt => (long)evt.InputTokens + evt.OutputTokens),
            Math.Round(run.Duration.TotalSeconds, 1), run.EstimatedCost,
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