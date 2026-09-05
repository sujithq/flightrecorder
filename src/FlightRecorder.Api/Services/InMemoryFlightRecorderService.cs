using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public sealed class InMemoryFlightRecorderService : IFlightRecorderService
{
    private static readonly Regex SecretPattern = new("(?i)(token|password|secret|api[_-]?key)(\\s*[:=]\\s*)[^\\s,;]+", RegexOptions.Compiled);
    private readonly ConcurrentDictionary<Guid, TraceRun> runs = new();

    public TraceRun StartRun(StartRunRequest request)
    {
        var run = new TraceRun(Guid.NewGuid(), request.Request.Trim(), request.EntryPointAgent.Trim(),
            request.RequestingIdentity.Trim(), request.RecordingMode, DateTimeOffset.UtcNow, null, []);
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
        var evt = new FlightEvent(Guid.NewGuid(), runId, request.Type, request.Name.Trim(), request.StartedAt,
            request.EndedAt, request.Status, request.AgentName, request.AgentVersion, request.Model,
            request.ToolServer, request.Identity, request.Objective, request.RequestedScope, request.GrantedScope,
            request.PolicyName, request.PolicyReason, request.InputTokens, request.OutputTokens,
            request.EstimatedCost, Protect(current.RecordingMode, request.Input), Protect(current.RecordingMode, request.Output),
            request.Attributes);
        var updated = current with { Events = [.. current.Events, evt] };
        runs[runId] = updated;
        return evt;
    }

    public bool CompleteRun(Guid runId, DateTimeOffset? endedAt = null)
    {
        if (!runs.TryGetValue(runId, out var current)) return false;
        runs[runId] = current with { EndedAt = endedAt ?? DateTimeOffset.UtcNow };
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

    private static string? Protect(RecordingMode mode, string? value) => mode switch
    {
        RecordingMode.MetadataOnly => null,
        RecordingMode.Redacted => string.IsNullOrWhiteSpace(value) ? value : SecretPattern.Replace(value, "$1$2[REDACTED]"),
        _ => value
    };
}
