using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public sealed class InMemoryTraceRunStore : ITraceRunStore
{
    private readonly Lock gate = new();
    private readonly Dictionary<Guid, TraceRun> runs = new();
    private readonly int maxCompletedRuns;

    public InMemoryTraceRunStore(int maxCompletedRuns = 10)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxCompletedRuns);
        this.maxCompletedRuns = maxCompletedRuns;
    }

    public void Add(TraceRun run)
    {
        lock (gate)
        {
            runs.Add(run.Id, run);
            Prune();
        }
    }

    public TraceRun? Get(Guid runId)
    {
        lock (gate) return runs.GetValueOrDefault(runId);
    }

    public IReadOnlyList<TraceRun> List()
    {
        lock (gate) return runs.Values.ToArray();
    }

    public TraceRun? Update(Guid runId, Func<TraceRun, TraceRun> update)
    {
        lock (gate)
        {
            if (!runs.TryGetValue(runId, out var current)) return null;
            var updated = update(current);
            if (updated.Id != runId) throw new ArgumentException("A run update cannot change its ID.", nameof(update));
            runs[runId] = updated;
            if (updated.EndedAt is not null) Prune();
            return updated;
        }
    }

    private void Prune()
    {
        var expired = runs.Values.Where(run => run.EndedAt is not null)
            .OrderByDescending(run => run.EndedAt)
            .ThenByDescending(run => run.StartedAt)
            .ThenBy(run => run.Id.ToString("D"), StringComparer.Ordinal)
            .Skip(maxCompletedRuns).Select(run => run.Id).ToArray();
        foreach (var runId in expired) runs.Remove(runId);
    }
}