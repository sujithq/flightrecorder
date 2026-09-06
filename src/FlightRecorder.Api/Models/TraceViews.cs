namespace FlightRecorder.Api.Models;

public sealed record TraceGraph(Guid RunId, IReadOnlyList<GraphNode> Nodes, IReadOnlyList<GraphEdge> Edges);

public sealed record GraphNode(Guid Id, string Name, FlightEventType Type, string? AgentName,
    FlightEventStatus Status, double DurationMilliseconds);

public sealed record GraphEdge(Guid SourceId, Guid TargetId, string? Objective, string? SourceIdentity,
    string? TargetIdentity, bool IdentityChanged, double DurationMilliseconds);

public sealed record RunMetrics(int EventCount, double DurationMilliseconds, long? InputTokens,
    long? OutputTokens, decimal? EstimatedCost, int PolicyInterventions, UsageCoverage? Usage = null);

public sealed record EventComparison(string Key, string Change, FlightEvent? Baseline,
    FlightEvent? Candidate, IReadOnlyList<string> ChangedFields);

public sealed record TraceComparison(Guid BaselineRunId, Guid CandidateRunId, RunMetrics Baseline,
    RunMetrics Candidate, RunMetrics Delta, IReadOnlyList<EventComparison> Events);

public sealed record BadgeSummary(int Version, string RunId, string Agent, string Status,
    int EventCount, long? Tokens, double DurationSeconds, decimal? EstimatedCost, string? Alert);

public sealed class DemoRunRequest
{
    public string Scenario { get; init; } = "blocked";
}