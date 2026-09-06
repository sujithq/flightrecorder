using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace FlightRecorder.Api.Controllers;

[ApiController]
[Route("api/demo/runs")]
public sealed class DemoController(IFlightRecorderService recorder, IConfiguration configuration, IHostEnvironment environment) : ControllerBase
{
    [HttpPost]
    public IActionResult Create(DemoRunRequest request)
    {
        if (!configuration.GetValue("FlightRecorder:EnableDemo", environment.IsDevelopment())) return NotFound();
        if (request.Scenario is not ("blocked" or "approved"))
            return Problem(statusCode: 400, title: "Scenario must be blocked or approved.");
        var approved = request.Scenario == "approved";
        var run = recorder.StartRun(new StartRunRequest
        {
            Request = "Demo: Repair failed deployment",
            EntryPointAgent = "orchestrator",
            RequestingIdentity = "developer-demo",
            RecordingMode = RecordingMode.Redacted
        });
        FlightEvent Add(string name, FlightEventType type, string agent, int offset, int duration,
            Guid? parent = null, FlightEventStatus status = FlightEventStatus.Succeeded,
            string? objective = null, int inputTokens = 0, int outputTokens = 0, decimal cost = 0,
            string? requestedScope = null, string? grantedScope = null, string? policy = null, string? reason = null)
            => recorder.RecordEvent(run.Id, new RecordEventRequest
            {
                Name = name, Type = type, AgentName = agent, AgentVersion = approved ? "1.1-demo" : "1.0-demo",
                ParentEventId = parent, StartedAt = run.StartedAt.AddMilliseconds(offset),
                EndedAt = run.StartedAt.AddMilliseconds(offset + duration), Status = status,
                Identity = agent == "coding-agent" ? "agent-dev-042" : "agent-observer-demo",
                Objective = objective, InputTokens = inputTokens, OutputTokens = outputTokens, EstimatedCost = cost,
                Model = type == FlightEventType.ModelCall ? "demo-model" : null,
                ToolServer = type == FlightEventType.ToolCall ? "demo-tools" : null,
                RequestedScope = requestedScope, GrantedScope = grantedScope, PolicyName = policy, PolicyReason = reason
            })!;
        var orchestrator = Add("Orchestrator", FlightEventType.AgentSpan, "orchestrator", 0, 14700);
        Add("Repository lookup", FlightEventType.ToolCall, "orchestrator", 80, 420, orchestrator.Id);
        var diagnostics = Add("Diagnostics", FlightEventType.AgentSpan, "diagnostic-agent", 600, 3800,
            orchestrator.Id, objective: "Identify the failed deployment stage");
        Add("Deployment logs", FlightEventType.ToolCall, "diagnostic-agent", 720, 1100, diagnostics.Id);
        Add("Deployment lookup", FlightEventType.ToolCall, "diagnostic-agent", 1900, 850, diagnostics.Id);
        Add("Diagnose configuration", FlightEventType.ModelCall, "diagnostic-agent", 2800, 1400, diagnostics.Id,
            inputTokens: 1850, outputTokens: 420, cost: 0.0042m);
        var coding = Add("Prepare fix", FlightEventType.AgentSpan, "coding-agent", 4600, 10100,
            orchestrator.Id, objective: "Correct configuration and verify the change");
        Add("Generate patch", FlightEventType.ModelCall, "coding-agent", 4800, approved ? 4600 : 6200, coding.Id,
            inputTokens: approved ? 2400 : 3800, outputTokens: 920, cost: approved ? 0.0087m : 0.0122m);
        Add("Run tests", FlightEventType.ToolCall, "coding-agent", 11200, 2300, coding.Id);
        var outcome = approved ? FlightEventStatus.Succeeded : FlightEventStatus.Blocked;
        var pullRequest = Add("Create pull request", FlightEventType.ToolCall, "coding-agent", 13900, 700, coding.Id, outcome);
        Add("Repository write approval", FlightEventType.PolicyDecision, "coding-agent", 14000, 120,
            pullRequest.Id, outcome, requestedScope: "pull_requests:write",
            grantedScope: approved ? "contents:read, pull_requests:write" : "contents:read",
            policy: "Repository write actions require explicit approval",
            reason: approved ? "Explicit approval recorded in this synthetic scenario; no external action was performed."
                : "Pull request creation denied: explicit approval was not granted. No repository changes were published.");
        recorder.CompleteRun(run.Id, run.StartedAt.AddMilliseconds(14700));
        return Ok(recorder.GetRun(run.Id));
    }
}