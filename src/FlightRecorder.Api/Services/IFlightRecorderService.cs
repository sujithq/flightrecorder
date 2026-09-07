using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public interface IFlightRecorderService
{
    TraceRun StartRun(StartRunRequest request);
    TraceRun? GetRun(Guid runId);
    IReadOnlyList<RunSummary> ListRuns();
    FlightEvent? RecordEvent(Guid runId, RecordEventRequest request);
    UsageImportResult? ImportUsage(Guid runId, string sourceId, UsageImportRequest request);
    bool CompleteRun(Guid runId, DateTimeOffset? endedAt = null);
    RootCauseAnalysis? Analyze(Guid runId);
}
