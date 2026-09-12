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
        Assert.Null(tools.StartTask(runId, "missing"));
        Assert.Null(tools.StartSubtask(runId, "missing"));
        Assert.Null(tools.CompleteCurrentTask(runId));
        Assert.Null(tools.ShowTaskUsage(runId));
    }

    [Fact]
    public void Task_controls_apply_deterministic_attribution_and_report_breakdown()
    {
        var tools = new FlightRecorderMcpTools(new FlightRecorderService());
        var run = tools.StartRun("Implement usage attribution", "github-copilot", "developer", RecordingMode.Redacted);
        var task = tools.StartTask(run.Id, "Implement usage attribution", source: "manual")!;
        var subtask = tools.StartSubtask(run.Id, "Add tests", source: "todo")!;
        var attributed = tools.RecordEvent(run.Id, FlightEventType.ModelCall, "Generate tests",
            inputTokens: 1200, outputTokens: 220, reportedAiCredits: 1.25m, estimatedAiCredits: 1.4m)!;
        var turn = tools.AssignCurrentChatTurnToTask(run.Id, "chat-session-1", "chat-turn-3",
            subagentSessionId: "subagent-5", traceId: "trace-1", spanId: "span-1")!;
        Assert.Equal(subtask.TaskId, attributed.TaskId);
        Assert.Equal(subtask.TaskId, turn.TaskId);
        Assert.Equal("chat-session-1", turn.ChatSessionId);
        Assert.Equal("chat-turn-3", turn.ChatTurnId);
        Assert.Equal("subagent-5", turn.SubagentSessionId);
        Assert.Equal("trace-1", turn.TraceId);
        Assert.Equal("span-1", turn.SpanId);
        Assert.NotNull(tools.CompleteCurrentTask(run.Id));
        Assert.NotNull(tools.CompleteCurrentTask(run.Id));

        var breakdown = tools.ShowTaskUsage(run.Id)!;
        Assert.Equal(2, breakdown.Tasks.Count);
        Assert.Equal(1.25m, breakdown.ReportedAiCredits);
        Assert.Equal(1.4m, breakdown.EstimatedAiCredits);
        var addTests = breakdown.Tasks.Single(item => item.TaskId == subtask.TaskId);
        Assert.Equal(task.TaskId, addTests.ParentTaskId);
        Assert.Equal(1, addTests.ModelCalls);
        Assert.Equal(1200, addTests.InputTokens);
        Assert.Equal(220, addTests.OutputTokens);
        Assert.Equal(1.25m, addTests.ReportedAiCredits);
        Assert.Equal(1.4m, addTests.EstimatedAiCredits);
        Assert.Equal("todo", addTests.Source);
    }
}
