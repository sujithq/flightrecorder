using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.ComponentModel.DataAnnotations;
using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public sealed class InMemoryFlightRecorderService : IFlightRecorderService
{
    private static readonly HashSet<string> MetadataKeys = new(StringComparer.Ordinal)
    {
        "http.request.method", "http.response.status_code", "gen_ai.operation.name",
        "gen_ai.request.model", "gen_ai.agent.name", "gen_ai.tool.name", "gen_ai.policy.decision",
        "gen_ai.data.classification"
    };
    private readonly TraceRedactor redactor;
    private readonly ConcurrentDictionary<Guid, TraceRun> runs = new();

    public InMemoryFlightRecorderService(TraceRedactor? redactor = null)
    {
        this.redactor = redactor ?? new TraceRedactor();
    }

    public TraceRun StartRun(StartRunRequest request)
    {
        Validator.ValidateObject(request, new ValidationContext(request), true);
        var mode = request.RecordingMode;
        var run = new TraceRun(Guid.NewGuid(), Protect(mode, request.Request.Trim()) ?? "[Content omitted]",
            Metadata(mode, request.EntryPointAgent.Trim())!, Metadata(mode, request.RequestingIdentity.Trim())!,
            mode, DateTimeOffset.UtcNow, null, []);
        runs[run.Id] = run;
        return run;
    }

    public TraceRun? GetRun(Guid runId) => runs.TryGetValue(runId, out var run) ? run : null;

    public IReadOnlyList<RunSummary> ListRuns() => runs.Values
        .OrderByDescending(r => r.StartedAt)
        .Select(r => new RunSummary(r.Id, r.Request, r.EntryPointAgent, r.RequestingIdentity, r.Status,
            r.StartedAt, r.EndedAt, r.Duration, r.Events.Count, r.InputTokens, r.OutputTokens, r.EstimatedCost))
        .ToArray();

    public FlightEvent? RecordEvent(Guid runId, RecordEventRequest request)
    {
        if (!runs.TryGetValue(runId, out var current)) return null;
        Validator.ValidateObject(request, new ValidationContext(request), true);
        if (request.ParentEventId is { } parentId && current.Events.All(evt => evt.Id != parentId))
            throw new ArgumentException("Parent event must already exist in the same run.", nameof(request));
        var mode = current.RecordingMode;
        var evt = new FlightEvent(Guid.NewGuid(), runId, request.Type, Metadata(mode, request.Name.Trim())!, request.StartedAt,
            request.EndedAt, request.Status, Metadata(mode, request.AgentName), Metadata(mode, request.AgentVersion), Metadata(mode, request.Model),
            Metadata(mode, request.ToolServer), Metadata(mode, request.Identity), Protect(mode, request.Objective),
            Metadata(mode, request.RequestedScope), Metadata(mode, request.GrantedScope),
            Metadata(mode, request.PolicyName), Metadata(mode, request.PolicyReason), request.InputTokens, request.OutputTokens,
            request.EstimatedCost, Protect(mode, request.Input), Protect(mode, request.Output),
            ProtectAttributes(mode, request.Attributes), request.ParentEventId);
        while (!runs.TryUpdate(runId, current with { Events = [.. current.Events, evt] }, current))
            current = runs[runId];
        return evt;
    }

    public bool CompleteRun(Guid runId, DateTimeOffset? endedAt = null)
    {
        if (!runs.TryGetValue(runId, out var current)) return false;
        var completionTime = endedAt ?? DateTimeOffset.UtcNow;
        while (!runs.TryUpdate(runId, current with { EndedAt = completionTime }, current))
            current = runs[runId];
        return true;
    }

    public RootCauseAnalysis? Analyze(Guid runId)
    {
        var run = GetRun(runId);
        if (run is null) return null;
        var blocked = run.Events.FirstOrDefault(e => e.Status is FlightEventStatus.Blocked or FlightEventStatus.RequiresApproval);
        var failed = run.Events.FirstOrDefault(e => e.Status == FlightEventStatus.Failed);
        var failureEvent = blocked ?? failed;
        var successful = run.Events.Where(e => e.Status == FlightEventStatus.Succeeded).ToArray();
        var evidence = new List<EvidenceReference>();
        if (failureEvent is not null) evidence.Add(new(failureEvent.Id, "Primary failure"));
        evidence.AddRange(successful.Take(5).Select(e => new EvidenceReference(e.Id, $"Succeeded: {e.Name}")));

        if (failureEvent is null)
        {
            return new RootCauseAnalysis(runId, "The run completed without a recorded failure or policy intervention.",
                "No failure was recorded.", $"{successful.Length} event(s) succeeded.",
                "Continue monitoring the run or add evaluation events for outcome quality.", evidence);
        }

        var reason = failureEvent.PolicyReason ?? failureEvent.Output ?? "The event reported a failure without a detailed reason.";
        var next = failureEvent.Status is FlightEventStatus.Blocked or FlightEventStatus.RequiresApproval
            ? "Review the policy decision and grant only the minimum required permission before resuming."
            : "Inspect the failed event and retry only after correcting its reported cause.";
        return new RootCauseAnalysis(runId,
            $"{failureEvent.Name} was {failureEvent.Status.ToString().ToLowerInvariant()}.",
            reason,
            successful.Length == 0 ? "No events succeeded before the failure." :
                $"{successful.Length} event(s) succeeded before the failure: {string.Join(", ", successful.Select(e => e.Name))}.",
            next, evidence);
    }

    private string? Protect(RecordingMode mode, string? value) => mode switch
    {
        RecordingMode.MetadataOnly => null,
        RecordingMode.Redacted => redactor.Redact(value),
        _ => value
    };

    private string? Metadata(RecordingMode mode, string? value)
        => mode == RecordingMode.Full ? value : redactor.Redact(value);

    private IReadOnlyDictionary<string, string>? ProtectAttributes(RecordingMode mode, Dictionary<string, string>? attributes)
    {
        if (attributes is null) return null;
        var protectedAttributes = new Dictionary<string, string>();
        foreach (var attribute in attributes)
        {
            if (mode == RecordingMode.MetadataOnly && !MetadataKeys.Contains(attribute.Key)) continue;
            var key = Metadata(mode, attribute.Key)!;
            protectedAttributes[key] = mode != RecordingMode.Full && redactor.IsSecretKey(attribute.Key)
                ? TraceRedactor.Replacement : Metadata(mode, attribute.Value)!;
        }
        return new ReadOnlyDictionary<string, string>(protectedAttributes);
    }
}
