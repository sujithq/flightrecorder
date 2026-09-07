using System.ComponentModel.DataAnnotations;
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
        try
        {
            var evt = recorder.RecordEvent(runId, request);
            return evt is null ? NotFound() : Created($"/api/runs/{runId}/events/{evt.Id}", evt);
        }
        catch (UsageImportConflictException error)
        {
            return Problem(statusCode: 409, title: "Conflicting usage source", detail: error.Message);
        }
        catch (Exception error) when (error is ArgumentException or ValidationException)
        {
            return Problem(statusCode: 400, title: "Invalid event", detail: error.Message);
        }
    }

    [HttpPut("{runId:guid}/usage-imports/{sourceId}")]
    [RequestSizeLimit(UsageImportValidation.MaximumRequestBytes)]
    [UsageImportBodyLimit]
    public ActionResult<UsageImportResult> ImportUsage(Guid runId, string sourceId, UsageImportRequest request)
    {
        try
        {
            var result = recorder.ImportUsage(runId, sourceId, request);
            return result is null ? NotFound() : Ok(result);
        }
        catch (UsageImportConflictException error)
        {
            return Problem(statusCode: 409, title: "Conflicting usage snapshot", detail: error.Message);
        }
        catch (ValidationException error)
        {
            return Problem(statusCode: 400, title: "Invalid usage snapshot", detail: error.Message);
        }
    }

    [HttpPost("{runId:guid}/complete")]
    public IActionResult CompleteRun(Guid runId)
        => recorder.CompleteRun(runId) ? NoContent() : NotFound();

    [HttpGet("{runId:guid}/analysis")]
    public ActionResult<RootCauseAnalysis> Analyze(Guid runId)
        => recorder.Analyze(runId) is { } analysis ? Ok(analysis) : NotFound();
}
