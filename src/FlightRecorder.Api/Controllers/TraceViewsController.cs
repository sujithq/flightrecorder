using System.Text;
using System.Text.Json;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace FlightRecorder.Api.Controllers;

[ApiController]
[Route("api/runs")]
public sealed class TraceViewsController(IFlightRecorderService recorder, TraceExportService exports,
    OtlpForwarder forwarder, IConfiguration configuration) : ControllerBase
{
    [HttpGet("{runId:guid}/graph")]
    public IActionResult Graph(Guid runId)
        => recorder.GetRun(runId) is { } run ? Ok(TraceViewService.Graph(run)) : NotFound();

    [HttpGet("{baselineId:guid}/compare/{candidateId:guid}")]
    public IActionResult Compare(Guid baselineId, Guid candidateId)
        => recorder.GetRun(baselineId) is { } baseline && recorder.GetRun(candidateId) is { } candidate
            ? Ok(TraceViewService.Compare(baseline, candidate)) : NotFound();

    [HttpGet("{runId:guid}/exports/otlp")]
    public IActionResult Otlp(Guid runId)
        => recorder.GetRun(runId) is { } run
            ? File(Encoding.UTF8.GetBytes(exports.Otlp(run).ToJsonString()), "application/json", $"flight-{runId}.otlp.json")
            : NotFound();

    [HttpPost("{runId:guid}/exports/otlp")]
    public async Task<IActionResult> SendOtlp(Guid runId, CancellationToken cancellationToken)
    {
        if (recorder.GetRun(runId) is not { } run) return NotFound();
        try
        {
            await forwarder.SendAsync(exports.Otlp(run), cancellationToken);
            return NoContent();
        }
        catch (InvalidOperationException error)
        {
            return Problem(statusCode: 503, title: "OTLP export is not configured", detail: error.Message);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException)
        {
            return Problem(statusCode: 502, title: "The OTLP collector did not accept the complete trace.");
        }
    }

    [HttpGet("{runId:guid}/exports/github")]
    public IActionResult GitHub(Guid runId)
    {
        if (recorder.GetRun(runId) is not { } run) return NotFound();
        Uri.TryCreate(configuration["FlightRecorder:PublicBaseUrl"], UriKind.Absolute, out var viewerUri);
        return Ok(exports.GitHubCheck(run, viewerUri));
    }

    [HttpGet("{runId:guid}/badge")]
    public IActionResult Badge(Guid runId)
        => recorder.GetRun(runId) is { } run ? Ok(exports.Badge(run)) : NotFound();

    [HttpGet("/api/badger/latest")]
    public IActionResult LatestBadge()
    {
        var latest = recorder.ListRuns().FirstOrDefault();
        return latest is not null && recorder.GetRun(latest.Id) is { } run ? Ok(exports.Badge(run)) : NoContent();
    }
}