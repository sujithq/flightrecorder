using System.Text.Json;
using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public static class TraceViewService
{
    public static TraceGraph Graph(TraceRun run)
    {
        var events = run.Events.ToDictionary(evt => evt.Id);
        var nodes = new List<GraphNode>
        {
            new(run.Id, run.EntryPointAgent, FlightEventType.Run, run.EntryPointAgent, run.Status, run.Duration.TotalMilliseconds)
        };
        nodes.AddRange(run.Events.Select(evt => new GraphNode(evt.Id, evt.Name, evt.Type,
            evt.AgentName, evt.Status, evt.Duration.TotalMilliseconds)));
        var edges = run.Events.Select(evt =>
        {
            var parent = evt.ParentEventId is { } parentId ? events.GetValueOrDefault(parentId) : null;
            var sourceIdentity = parent?.Identity ?? run.RequestingIdentity;
            return new GraphEdge(parent?.Id ?? run.Id, evt.Id, evt.Objective, sourceIdentity, evt.Identity,
                sourceIdentity is not null && evt.Identity is not null && sourceIdentity != evt.Identity,
                evt.Duration.TotalMilliseconds);
        }).ToArray();
        return new TraceGraph(run.Id, nodes, edges);
    }

    public static TraceComparison Compare(TraceRun baseline, TraceRun candidate)
    {
        var before = Index(baseline);
        var after = Index(candidate);
        var comparisons = before.Keys.Concat(after.Keys).Distinct(StringComparer.Ordinal).Select(key =>
        {
            var baselineEvent = before.GetValueOrDefault(key);
            var candidateEvent = after.GetValueOrDefault(key);
            var fields = ChangedFields(baselineEvent, candidateEvent);
            var change = baselineEvent is null ? "Added" : candidateEvent is null ? "Removed"
                : fields.Count > 0 ? "Changed" : "Unchanged";
            return new EventComparison(key, change, baselineEvent, candidateEvent, fields);
        }).ToArray();
        var baselineMetrics = Metrics(baseline);
        var candidateMetrics = Metrics(candidate);
        return new TraceComparison(baseline.Id, candidate.Id, baselineMetrics, candidateMetrics,
            new RunMetrics(candidateMetrics.EventCount - baselineMetrics.EventCount,
                candidateMetrics.DurationMilliseconds - baselineMetrics.DurationMilliseconds,
                candidateMetrics.InputTokens - baselineMetrics.InputTokens,
                candidateMetrics.OutputTokens - baselineMetrics.OutputTokens,
                candidateMetrics.EstimatedCost - baselineMetrics.EstimatedCost,
                candidateMetrics.PolicyInterventions - baselineMetrics.PolicyInterventions), comparisons);
    }

    public static RunMetrics Metrics(TraceRun run) => new(run.Events.Count, run.Duration.TotalMilliseconds,
        run.Events.Sum(evt => (long)evt.InputTokens), run.Events.Sum(evt => (long)evt.OutputTokens),
        run.EstimatedCost, run.Events.Count(evt => evt.Type == FlightEventType.PolicyDecision &&
            evt.Status is FlightEventStatus.Blocked or FlightEventStatus.RequiresApproval));

    private static Dictionary<string, FlightEvent> Index(TraceRun run)
    {
        var paths = new Dictionary<Guid, string>();
        var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
        var result = new Dictionary<string, FlightEvent>(StringComparer.Ordinal);
        foreach (var evt in run.Events)
        {
            var parentPath = evt.ParentEventId is { } parentId ? paths.GetValueOrDefault(parentId, "") : "";
            var signature = parentPath + JsonSerializer.Serialize(new[] { evt.Type.ToString(), evt.AgentName ?? "", evt.Name });
            var occurrence = occurrences.GetValueOrDefault(signature);
            occurrences[signature] = occurrence + 1;
            var key = $"{signature}#{occurrence}/";
            paths[evt.Id] = key;
            result[key] = evt;
        }
        return result;
    }

    private static IReadOnlyList<string> ChangedFields(FlightEvent? baseline, FlightEvent? candidate)
    {
        if (baseline is null || candidate is null) return [];
        (string Name, object? Before, object? After)[] fields =
        [
            ("Status", baseline.Status, candidate.Status),
            ("Identity", baseline.Identity, candidate.Identity),
            ("AgentVersion", baseline.AgentVersion, candidate.AgentVersion),
            ("Model", baseline.Model, candidate.Model),
            ("ToolServer", baseline.ToolServer, candidate.ToolServer),
            ("Objective", baseline.Objective, candidate.Objective),
            ("RequestedScope", baseline.RequestedScope, candidate.RequestedScope),
            ("GrantedScope", baseline.GrantedScope, candidate.GrantedScope),
            ("PolicyName", baseline.PolicyName, candidate.PolicyName),
            ("PolicyReason", baseline.PolicyReason, candidate.PolicyReason),
            ("Duration", baseline.Duration, candidate.Duration),
            ("InputTokens", baseline.InputTokens, candidate.InputTokens),
            ("OutputTokens", baseline.OutputTokens, candidate.OutputTokens),
            ("EstimatedCost", baseline.EstimatedCost, candidate.EstimatedCost)
        ];
        return fields.Where(field => !Equals(field.Before, field.After)).Select(field => field.Name).ToArray();
    }
}