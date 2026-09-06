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
    int? InputTokens = null,
    int? OutputTokens = null,
    decimal? EstimatedCost = null,
    string? Input = null,
    string? Output = null,
    IReadOnlyDictionary<string, string>? Attributes = null,
    Guid? ParentEventId = null,
    string? CostBasis = null,
    int? UsageSchemaVersion = null)
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
    public long? InputTokens => UsageTotals.Tokens(Events.Select(e => e.InputTokens));
    public long? OutputTokens => UsageTotals.Tokens(Events.Select(e => e.OutputTokens));
    public decimal? EstimatedCost => UsageTotals.Cost(Events.Select(e => e.EstimatedCost));
    public UsageCoverage Usage => UsageCoverage.From(Events);
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
    long? InputTokens,
    long? OutputTokens,
    decimal? EstimatedCost,
    UsageCoverage? Usage = null);

public sealed record UsageCoverage(int EventCount, int InputTokenEvents, int OutputTokenEvents, int CostEvents)
{
    public bool TokensComplete => EventCount > 0 && InputTokenEvents == EventCount && OutputTokenEvents == EventCount;
    public bool CostComplete => EventCount > 0 && CostEvents == EventCount;

    public static UsageCoverage From(IReadOnlyList<FlightEvent> events)
    {
        var metered = events.Where(e => e.Type == FlightEventType.ModelCall ||
            e.InputTokens.HasValue || e.OutputTokens.HasValue || e.EstimatedCost.HasValue).ToArray();
        return new(metered.Length, metered.Count(e => e.InputTokens.HasValue),
            metered.Count(e => e.OutputTokens.HasValue),
            metered.Count(e => e.EstimatedCost.HasValue && !string.IsNullOrWhiteSpace(e.CostBasis)));
    }
}

public static class UsageTotals
{
    public static long? Tokens(IEnumerable<int?> values)
    {
        var reported = values.OfType<int>().ToArray();
        return reported.Length == 0 ? null : reported.Sum(value => (long)value);
    }

    public static decimal? Cost(IEnumerable<decimal?> values)
    {
        var reported = values.OfType<decimal>().ToArray();
        return reported.Length == 0 ? null : reported.Sum();
    }
}

public sealed record EvidenceReference(Guid EventId, string Label);

public sealed record RootCauseAnalysis(
    Guid RunId,
    string Summary,
    string Failure,
    string Succeeded,
    string RecommendedNextStep,
    IReadOnlyList<EvidenceReference> Evidence);
