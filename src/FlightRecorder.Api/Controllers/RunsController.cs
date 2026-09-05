using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace FlightRecorder.Api.Controllers;

[ApiController]
[Route("api/runs")]
public sealed class RunsController(IFlightRecorderService recorder) : ControllerBase
{
    [HttpPost]
    public ActionResult<TraceRun> StartRun(StartRunRequest request) => Ok(recorder.StartRun(request));

    [HttpGet]
    public ActionResult<IReadOnlyList<RunSummary>> ListRuns() => Ok(recorder.ListRuns());

    [HttpGet("{runId:guid}")]
    public ActionResult<TraceRun> GetRun(Guid runId) => recorder.GetRun(runId) is { } run ? Ok(run) : NotFound();

    [HttpPost("{runId:guid}/events")]
    public ActionResult<FlightEvent> RecordEvent(Guid runId, RecordEventRequest request)
    {
        var evt = recorder.RecordEvent(runId, request);
        return evt is null ? NotFound() : Created($"/api/runs/{runId}/events/{evt.Id}", evt);
    }

    [HttpPost("{runId:guid}/complete")]
    public IActionResult CompleteRun(Guid runId)
        => recorder.CompleteRun(runId) ? NoContent() : NotFound();

    [HttpGet("{runId:guid}/analysis")]
    public ActionResult<RootCauseAnalysis> Analyze(Guid runId)
        => recorder.Analyze(runId) is { } analysis ? Ok(analysis) : NotFound();
}
