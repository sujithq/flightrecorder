using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public interface ITraceRunStore
{
    void Add(TraceRun run);
    TraceRun? Get(Guid runId);
    IReadOnlyList<TraceRun> List();
    TraceRun? Update(Guid runId, Func<TraceRun, TraceRun> update);
}