namespace FlightRecorder.Api.Models;

public sealed record TaskUsageBreakdown(
    Guid RunId,
    decimal? ReportedAiCredits,
    decimal? EstimatedAiCredits,
    IReadOnlyList<TaskUsageItem> Tasks);

public sealed record TaskUsageItem(
    Guid TaskId,
    Guid? ParentTaskId,
    string Name,
    string Source,
    string Status,
    int ModelCalls,
    int ToolCalls,
    long? InputTokens,
    long? OutputTokens,
    decimal? ReportedAiCredits,
    decimal? EstimatedAiCredits,
    double DurationMilliseconds,
    int EventCount);
