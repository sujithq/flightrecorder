using System.Collections.ObjectModel;
using System.ComponentModel.DataAnnotations;
using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public sealed partial class FlightRecorderService : IFlightRecorderService
{
    private static readonly HashSet<string> MetadataKeys = new(StringComparer.Ordinal)
    {
        "http.request.method", "http.response.status_code", "gen_ai.operation.name",
        "gen_ai.request.model", "gen_ai.agent.name", "gen_ai.tool.name", "gen_ai.policy.decision",
        "gen_ai.data.classification", "sdk.usageEvent", "sdk.cacheReadCount", "sdk.cacheWriteCount",
        "sdk.cacheDetailsReported", "sdk.durationMs", "sdk.timestampMeaning", "sdk.invalidUsageFields",
        "flightrecorder.task.lifecycle", "flightrecorder.task.source", "flightrecorder.attribution.method",
        "flightrecorder.attribution.confidence"
    };
    private readonly TraceRedactor redactor;
    private readonly ITraceRunStore store;

    public FlightRecorderService(TraceRedactor? redactor = null, ITraceRunStore? store = null)
    {
        this.redactor = redactor ?? new TraceRedactor();
        this.store = store ?? new InMemoryTraceRunStore();
    }

    public TraceRun StartRun(StartRunRequest request)
    {
        Validator.ValidateObject(request, new ValidationContext(request), true);
        var mode = request.RecordingMode;
        var run = new TraceRun(Guid.NewGuid(), Protect(mode, request.Request.Trim()) ?? "[Content omitted]",
            Metadata(mode, request.EntryPointAgent.Trim())!, Metadata(mode, request.RequestingIdentity.Trim())!,
            mode, DateTimeOffset.UtcNow, null, [], []);
        store.Add(run);
        return run;
    }

    public TraceRun? GetRun(Guid runId) => store.Get(runId);

    public IReadOnlyList<RunSummary> ListRuns() => store.List()
        .OrderByDescending(run => run.StartedAt)
        .Select(run => new RunSummary(run.Id, run.Request, run.EntryPointAgent, run.RequestingIdentity, run.Status,
            run.StartedAt, run.EndedAt, run.Duration, run.Events.Count, run.InputTokens, run.OutputTokens, run.EstimatedCost, run.Usage,
            run.EstimatedInputTokens, run.EstimatedOutputTokens, run.CopilotCredits, run.CopilotUsageValueUsd,
            run.ReportedAiCredits, run.EstimatedAiCredits))
        .ToArray();

    public FlightEvent? RecordEvent(Guid runId, RecordEventRequest request)
    {
        FlightEvent? evt = null;
        store.Update(runId, current =>
        {
            Validator.ValidateObject(request, new ValidationContext(request), true);
            if (current.UsageImports is { Count: > 0 } &&
                (request.InputTokens.HasValue || request.OutputTokens.HasValue || request.EstimatedCost.HasValue ||
                    HasCacheCounters(request.Attributes)))
                throw new UsageImportConflictException("This run uses imported usage. Manual or SDK metering cannot be mixed with that source.");
            if (request.ParentEventId is { } parentId && current.Events.All(parent => parent.Id != parentId))
                throw new ArgumentException("Parent event must already exist in the same run.", nameof(request));
            var attribution = TaskContext(current.Events);
            var taskId = request.TaskId ?? attribution.CurrentTaskId;
            var parentTaskId = request.ParentTaskId ?? (taskId is { } currentTask ? attribution.Parents.GetValueOrDefault(currentTask) : null);
            var mode = current.RecordingMode;
            evt = new FlightEvent(Guid.NewGuid(), runId, request.Type, Metadata(mode, request.Name.Trim())!, request.StartedAt,
                request.EndedAt, request.Status, Metadata(mode, request.AgentName), Metadata(mode, request.AgentVersion), Metadata(mode, request.Model),
                Metadata(mode, request.ToolServer), Metadata(mode, request.Identity), Protect(mode, request.Objective),
                Metadata(mode, request.RequestedScope), Metadata(mode, request.GrantedScope),
                Metadata(mode, request.PolicyName), Metadata(mode, request.PolicyReason), request.InputTokens, request.OutputTokens,
                request.EstimatedCost, Protect(mode, request.Input), Protect(mode, request.Output),
                ProtectAttributes(mode, request.Attributes), request.ParentEventId, Metadata(mode, request.CostBasis), 1, null,
                taskId, parentTaskId, Metadata(mode, request.ChatSessionId), Metadata(mode, request.ChatTurnId),
                Metadata(mode, request.SubagentSessionId), Metadata(mode, request.TraceId), Metadata(mode, request.SpanId),
                request.ReportedAiCredits, request.EstimatedAiCredits);
            return current with { Events = [.. current.Events, evt] };
        });
        return evt;
    }

    public bool CompleteRun(Guid runId, DateTimeOffset? endedAt = null)
    {
        var completionTime = endedAt ?? DateTimeOffset.UtcNow;
        return store.Update(runId, current => current with { EndedAt = completionTime }) is not null;
    }

    public RootCauseAnalysis? Analyze(Guid runId)
    {
        var run = GetRun(runId);
        if (run is null) return null;
        var blocked = run.Events.FirstOrDefault(evt => evt.Status is FlightEventStatus.Blocked or FlightEventStatus.RequiresApproval);
        var failed = run.Events.FirstOrDefault(evt => evt.Status == FlightEventStatus.Failed);
        var failureEvent = blocked ?? failed;
        var successful = run.Events.Where(evt => evt.Status == FlightEventStatus.Succeeded).ToArray();
        var evidence = new List<EvidenceReference>();
        if (failureEvent is not null) evidence.Add(new(failureEvent.Id, "Primary failure"));
        evidence.AddRange(successful.Take(5).Select(evt => new EvidenceReference(evt.Id, $"Succeeded: {evt.Name}")));

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
                $"{successful.Length} event(s) succeeded before the failure: {string.Join(", ", successful.Select(evt => evt.Name))}.",
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

    private static (Guid? CurrentTaskId, IReadOnlyDictionary<Guid, Guid?> Parents) TaskContext(IReadOnlyList<FlightEvent> events)
    {
        var parents = new Dictionary<Guid, Guid?>();
        var stack = new List<Guid>();
        foreach (var evt in events)
        {
            if (evt.TaskId is not { } taskId) continue;
            if (!parents.ContainsKey(taskId)) parents[taskId] = evt.ParentTaskId;
            var lifecycle = evt.Attributes?.GetValueOrDefault("flightrecorder.task.lifecycle");
            if (string.Equals(lifecycle, "start", StringComparison.Ordinal))
            {
                if (!stack.Contains(taskId)) stack.Add(taskId);
                continue;
            }
            if (!string.Equals(lifecycle, "complete", StringComparison.Ordinal)) continue;
            var index = stack.LastIndexOf(taskId);
            if (index >= 0) stack.RemoveAt(index);
        }
        return (stack.Count == 0 ? null : stack[^1], new ReadOnlyDictionary<Guid, Guid?>(parents));
    }
}