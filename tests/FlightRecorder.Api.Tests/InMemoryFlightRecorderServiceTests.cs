using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;

namespace FlightRecorder.Api.Tests;

public sealed class InMemoryFlightRecorderServiceTests
{
    [Fact]
    public void Records_metadata_and_aggregates_run_usage()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "Fix failed deployment",
            EntryPointAgent = "orchestrator",
            RequestingIdentity = "developer",
            RecordingMode = RecordingMode.Full
        });

        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Type = FlightEventType.ModelCall,
            Name = "diagnosis",
            InputTokens = 100,
            OutputTokens = 30,
            EstimatedCost = 0.02m,
            Model = "synthetic-model",
            CostBasis = "Synthetic USD test estimate.",
            Input = "request"
        });
        service.CompleteRun(run.Id);

        var actual = service.GetRun(run.Id)!;
        Assert.Equal(100, actual.InputTokens);
        Assert.Equal(30, actual.OutputTokens);
        Assert.Equal(0.02m, actual.EstimatedCost);
        Assert.Equal(FlightEventStatus.Succeeded, actual.Status);
        Assert.Equal("request", actual.Events.Single().Input);
    }

    [Fact]
    public void Redacted_mode_removes_secret_values()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "Inspect logs",
            EntryPointAgent = "diagnostic",
            RequestingIdentity = "agent",
            RecordingMode = RecordingMode.Redacted
        });

        var evt = service.RecordEvent(run.Id, new RecordEventRequest
        {
            Type = FlightEventType.ToolCall,
            Name = "query-logs",
            Input = "token=super-secret password=hunter2"
        });

        Assert.NotNull(evt);
        Assert.Equal("token=[REDACTED] password=[REDACTED]", evt.Input);
    }

    [Fact]
    public void Unknown_run_operations_return_not_found_results()
    {
        var service = new FlightRecorderService();
        var missingRunId = Guid.NewGuid();

        Assert.Null(service.GetRun(missingRunId));
        Assert.Null(service.RecordEvent(missingRunId, new RecordEventRequest
        {
            Type = FlightEventType.ToolCall,
            Name = "missing-run"
        }));
        Assert.False(service.CompleteRun(missingRunId));
        Assert.Null(service.Analyze(missingRunId));
    }

    [Fact]
    public void Analysis_links_policy_failure_and_successful_work()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "Create pull request",
            EntryPointAgent = "coding-agent",
            RequestingIdentity = "agent-dev-042"
        });
        var tests = service.RecordEvent(run.Id, new RecordEventRequest
        {
            Type = FlightEventType.ToolCall,
            Name = "run-tests",
            Status = FlightEventStatus.Succeeded
        });
        var blocked = service.RecordEvent(run.Id, new RecordEventRequest
        {
            Type = FlightEventType.PolicyDecision,
            Name = "create-pull-request",
            Status = FlightEventStatus.Blocked,
            RequestedScope = "pull_requests:write",
            GrantedScope = "contents:read",
            PolicyReason = "Repository write actions require explicit approval"
        });

        var analysis = service.Analyze(run.Id)!;
        Assert.Contains("blocked", analysis.Summary);
        Assert.Contains("explicit approval", analysis.Failure);
        Assert.Contains(analysis.Evidence, e => e.EventId == blocked!.Id && e.Label == "Primary failure");
        Assert.Contains(analysis.Evidence, e => e.EventId == tests!.Id);
    }
}
