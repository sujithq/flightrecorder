using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using FlightRecorder.Api.Tools;

namespace FlightRecorder.Api.Tests;

public sealed class FlightRecorderMcpToolsTests
{
    [Fact]
    public void Records_and_analyzes_a_complete_copilot_workflow()
    {
        var tools = new FlightRecorderMcpTools(new FlightRecorderService());
        var run = tools.StartRun(
            "Fix issue #42 and create a pull request",
            "github-copilot",
            "developer",
            RecordingMode.Redacted);
        var startedAt = DateTimeOffset.UtcNow.AddSeconds(-2);
        var endedAt = startedAt.AddSeconds(1);

        var tests = tools.RecordEvent(
            run.Id,
            FlightEventType.ToolCall,
            "run-tests",
            FlightEventStatus.Succeeded,
            agentName: "github-copilot",
            toolServer: "terminal",
            startedAt: startedAt,
            endedAt: endedAt,
            input: "dotnet test token=secret-value",
            output: "Passed: 128",
            attributes: new Dictionary<string, string> { ["passed"] = "128" });
        var blocked = tools.RecordEvent(
            run.Id,
            FlightEventType.PolicyDecision,
            "create-pull-request",
            FlightEventStatus.Blocked,
            requestedScope: "pull_requests:write",
            grantedScope: "contents:read",
            policyReason: "Repository write actions require explicit approval");

        Assert.True(tools.CompleteRun(run.Id));

        var trace = tools.GetRun(run.Id);
        var analysis = tools.AnalyzeRun(run.Id);

        Assert.NotNull(trace);
        Assert.Equal("dotnet test token=[REDACTED]", tests!.Input);
        Assert.Equal(TimeSpan.FromSeconds(1), tests.Duration);
        Assert.Equal("128", tests.Attributes!["passed"]);
        Assert.Equal(FlightEventStatus.Blocked, trace.Status);
        Assert.NotNull(analysis);
        Assert.Contains(analysis.Evidence, evidence => evidence.EventId == blocked!.Id && evidence.Label == "Primary failure");
        Assert.Contains(analysis.Evidence, evidence => evidence.EventId == tests.Id);
        Assert.Contains(tools.ListRuns(), summary => summary.Id == run.Id && summary.EventCount == 2);
    }

    [Fact]
    public void Returns_missing_results_for_an_unknown_run()
    {
        var tools = new FlightRecorderMcpTools(new FlightRecorderService());
        var runId = Guid.NewGuid();

        Assert.Null(tools.RecordEvent(runId, FlightEventType.ToolCall, "missing-run"));
        Assert.False(tools.CompleteRun(runId));
        Assert.Null(tools.GetRun(runId));
        Assert.Null(tools.AnalyzeRun(runId));
    }
}
