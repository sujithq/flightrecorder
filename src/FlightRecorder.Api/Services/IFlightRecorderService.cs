using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public interface IFlightRecorderService
{
    TraceRun StartRun(StartRunRequest request);
    TraceRun? GetRun(Guid runId);
    IReadOnlyList<RunSummary> ListRuns();
    FlightEvent? RecordEvent(Guid runId, RecordEventRequest request);
    bool CompleteRun(Guid runId, DateTimeOffset? endedAt = null);
    RootCauseAnalysis? Analyze(Guid runId);
}
