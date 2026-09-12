using System.ComponentModel.DataAnnotations;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;

namespace FlightRecorder.Api.Tests;

public sealed class EventHierarchyTests
{
    private static TraceRun Start(FlightRecorderService service) => service.StartRun(new StartRunRequest
    {
        Request = "Synthetic trace", EntryPointAgent = "orchestrator", RequestingIdentity = "test"
    });

    [Fact]
    public void Child_events_reference_a_parent_in_the_same_run()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        var parent = service.RecordEvent(run.Id, new RecordEventRequest { Name = "agent", Type = FlightEventType.AgentSpan })!;
        var child = service.RecordEvent(run.Id, new RecordEventRequest { Name = "tool", ParentEventId = parent.Id })!;
        Assert.Equal(parent.Id, child.ParentEventId);
        var otherRun = Start(service);
        Assert.Throws<ArgumentException>(() => service.RecordEvent(otherRun.Id,
            new RecordEventRequest { Name = "foreign parent", ParentEventId = parent.Id }));
        Assert.Throws<ArgumentException>(() => service.RecordEvent(run.Id,
            new RecordEventRequest { Name = "unknown parent", ParentEventId = Guid.NewGuid() }));
    }

    [Fact]
    public void Parallel_ingestion_and_completion_do_not_lose_events()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        Parallel.For(0, 200, index =>
        {
            service.RecordEvent(run.Id, new RecordEventRequest { Name = $"event-{index}", InputTokens = 1 });
            if (index % 10 == 0) service.CompleteRun(run.Id);
        });
        var result = service.GetRun(run.Id)!;
        Assert.Equal(200, result.Events.Count);
        Assert.Equal(200, result.InputTokens);
        Assert.NotNull(result.EndedAt);
    }

    [Fact]
    public void Invalid_timing_and_enum_values_are_rejected()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        Assert.Throws<ValidationException>(() => service.RecordEvent(run.Id,
            new RecordEventRequest { Name = "bad duration", EndedAt = DateTimeOffset.UnixEpoch }));
        Assert.Throws<ValidationException>(() => service.RecordEvent(run.Id,
            new RecordEventRequest { Name = "bad type", Type = (FlightEventType)99 }));
    }

    [Fact]
    public void Events_without_task_id_inherit_the_current_active_task()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        var taskId = Guid.NewGuid();
        var subtaskId = Guid.NewGuid();
        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "Main task", Type = FlightEventType.AgentSpan, Status = FlightEventStatus.Started,
            TaskId = taskId, Attributes = new() { ["flightrecorder.task.lifecycle"] = "start" }
        });
        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "Subtask", Type = FlightEventType.AgentSpan, Status = FlightEventStatus.Started,
            TaskId = subtaskId, ParentTaskId = taskId, Attributes = new() { ["flightrecorder.task.lifecycle"] = "start" }
        });
        var attributed = service.RecordEvent(run.Id, new RecordEventRequest { Name = "model call", Type = FlightEventType.ModelCall })!;
        Assert.Equal(subtaskId, attributed.TaskId);
        Assert.Equal(taskId, attributed.ParentTaskId);
        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "Subtask complete", Type = FlightEventType.AgentSpan, Status = FlightEventStatus.Succeeded,
            TaskId = subtaskId, ParentTaskId = taskId, Attributes = new() { ["flightrecorder.task.lifecycle"] = "complete" }
        });
        var parentTaskEvent = service.RecordEvent(run.Id, new RecordEventRequest { Name = "after subtask", Type = FlightEventType.ToolCall })!;
        Assert.Equal(taskId, parentTaskEvent.TaskId);
    }
}