namespace FlightRecorder.Api.Models;

public enum FlightEventType
{
    Run,
    AgentSpan,
    ModelCall,
    ToolCall,
    PolicyDecision
}

public enum FlightEventStatus
{
    Started,
    Succeeded,
    Failed,
    Blocked,
    RequiresApproval
}

public enum RecordingMode
{
    MetadataOnly,
    Redacted,
    Full
}

public sealed record FlightEvent(
    Guid Id,
    Guid RunId,
    FlightEventType Type,
    string Name,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    FlightEventStatus Status,
    string? AgentName = null,
    string? AgentVersion = null,
    string? Model = null,
    string? ToolServer = null,
    string? Identity = null,
    string? Objective = null,
    string? RequestedScope = null,
    string? GrantedScope = null,
    string? PolicyName = null,
    string? PolicyReason = null,
    int InputTokens = 0,
    int OutputTokens = 0,
    decimal EstimatedCost = 0,
    string? Input = null,
    string? Output = null,
    IReadOnlyDictionary<string, string>? Attributes = null)
{
    public TimeSpan Duration => (EndedAt ?? StartedAt) - StartedAt;
}

public sealed record TraceRun(
    Guid Id,
    string Request,
    string EntryPointAgent,
    string RequestingIdentity,
    RecordingMode RecordingMode,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    IReadOnlyList<FlightEvent> Events)
{
    public FlightEventStatus Status => Events.Any(e => e.Status == FlightEventStatus.Failed)
        ? FlightEventStatus.Failed
        : Events.Any(e => e.Status is FlightEventStatus.Blocked or FlightEventStatus.RequiresApproval)
            ? FlightEventStatus.Blocked
            : EndedAt is null ? FlightEventStatus.Started : FlightEventStatus.Succeeded;

    public TimeSpan Duration => (EndedAt ?? StartedAt) - StartedAt;
    public int InputTokens => Events.Sum(e => e.InputTokens);
    public int OutputTokens => Events.Sum(e => e.OutputTokens);
    public decimal EstimatedCost => Events.Sum(e => e.EstimatedCost);
}

public sealed record RunSummary(
    Guid Id,
    string Request,
    string EntryPointAgent,
    string RequestingIdentity,
    FlightEventStatus Status,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    TimeSpan Duration,
    int EventCount,
    int InputTokens,
    int OutputTokens,
    decimal EstimatedCost);

public sealed record EvidenceReference(Guid EventId, string Label);

public sealed record RootCauseAnalysis(
    Guid RunId,
    string Summary,
    string Failure,
    string Succeeded,
    string RecommendedNextStep,
    IReadOnlyList<EvidenceReference> Evidence);
