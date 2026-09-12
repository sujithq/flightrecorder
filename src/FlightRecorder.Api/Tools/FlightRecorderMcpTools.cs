using Description = System.ComponentModel.DescriptionAttribute;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using ModelContextProtocol.Server;

namespace FlightRecorder.Api.Tools;

[McpServerToolType]
public sealed class FlightRecorderMcpTools(IFlightRecorderService recorder)
{
    private const string TaskLifecycleKey = "flightrecorder.task.lifecycle";
    private const string TaskSourceKey = "flightrecorder.task.source";
    private const string AttributionMethodKey = "flightrecorder.attribution.method";
    private const string AttributionConfidenceKey = "flightrecorder.attribution.confidence";

    [McpServerTool(Name = "start_flight_run")]
    [Description("Start a Flight Recorder run and return its run ID.")]
    public TraceRun StartRun(
        [Description("The user request or task being executed.")] string request,
        [Description("The agent that owns the run.")] string entryPointAgent,
        [Description("The identity that requested the run.")] string requestingIdentity,
        [Description("MetadataOnly omits request and event content, Redacted removes common secrets and PII, and Full retains content.")] RecordingMode recordingMode = RecordingMode.MetadataOnly)
        => recorder.StartRun(new StartRunRequest
        {
            Request = request,
            EntryPointAgent = entryPointAgent,
            RequestingIdentity = requestingIdentity,
            RecordingMode = recordingMode
        });

    [McpServerTool(Name = "record_flight_event")]
    [Description("Record an agent, model, tool, or policy event for a Flight Recorder run.")]
    public FlightEvent? RecordEvent(
        [Description("The run ID returned by start_flight_run.")] Guid runId,
        [Description("The event category: Run, AgentSpan, ModelCall, ToolCall, or PolicyDecision.")] FlightEventType type,
        [Description("A concise name for the event.")] string name,
        [Description("The event outcome: Started, Succeeded, Failed, Blocked, or RequiresApproval.")] FlightEventStatus status = FlightEventStatus.Succeeded,
        [Description("Name of the agent responsible for the event.")] string? agentName = null,
        [Description("Version of the agent responsible for the event.")] string? agentVersion = null,
        [Description("Model used by a model-call event.")] string? model = null,
        [Description("MCP server, API, or tool host used by a tool-call event.")] string? toolServer = null,
        [Description("Identity or principal used for the operation.")] string? identity = null,
        [Description("Objective assigned to the agent or operation.")] string? objective = null,
        [Description("Permission scope requested by the operation.")] string? requestedScope = null,
        [Description("Permission scope actually granted to the operation.")] string? grantedScope = null,
        [Description("Name of the policy involved in a policy decision.")] string? policyName = null,
        [Description("Human-readable reason for a policy decision or failure.")] string? policyReason = null,
        [Description("UTC start time. Defaults to the current time when omitted.")] DateTimeOffset? startedAt = null,
        [Description("UTC end time, when the event has completed.")] DateTimeOffset? endedAt = null,
        [Description("Reported model input tokens. Omit when unavailable; zero means an explicitly reported zero. Never infer from text length.")] int? inputTokens = null,
        [Description("Reported model output tokens. Omit when unavailable; zero means an explicitly reported zero.")] int? outputTokens = null,
        [Description("Estimated USD cost from reported usage and explicit model pricing. Omit when unavailable. Copilot credits are not dollars. Requires model, inputTokens, outputTokens and costBasis.")] decimal? estimatedCost = null,
        [Description("Input or sanitized parameters supplied to the operation.")] string? input = null,
        [Description("Output or result returned by the operation.")] string? output = null,
        [Description("Additional event metadata, subject to the run recording policy.")] Dictionary<string, string>? attributes = null,
        [Description("An existing event ID in this run that owns this child operation or delegation.")] Guid? parentEventId = null,
        [Description("Pricing source, applicable model rates, currency USD and effective/as-of date used for estimatedCost. Do not invent rates.")] string? costBasis = null,
        [Description("Task identifier for deterministic attribution. Omit to inherit the current active task, if any.")] Guid? taskId = null,
        [Description("Parent task identifier when this event belongs to a subtask.")] Guid? parentTaskId = null,
        [Description("Copilot chat session identifier for this event.")] string? chatSessionId = null,
        [Description("Copilot chat turn identifier for this event.")] string? chatTurnId = null,
        [Description("Subagent session identifier for this event.")] string? subagentSessionId = null,
        [Description("Source telemetry trace identifier for this event.")] string? traceId = null,
        [Description("Source telemetry span identifier for this event.")] string? spanId = null,
        [Description("Measured AI credits reported by Copilot telemetry. Omit when unavailable.")] decimal? reportedAiCredits = null,
        [Description("Estimated AI credits derived by Flight Recorder. Never treat this as billing truth.")] decimal? estimatedAiCredits = null)
        => recorder.RecordEvent(runId, new RecordEventRequest
        {
            Type = type,
            Name = name,
            Status = status,
            AgentName = agentName,
            AgentVersion = agentVersion,
            Model = model,
            ToolServer = toolServer,
            Identity = identity,
            Objective = objective,
            RequestedScope = requestedScope,
            GrantedScope = grantedScope,
            PolicyName = policyName,
            PolicyReason = policyReason,
            StartedAt = startedAt ?? DateTimeOffset.UtcNow,
            EndedAt = endedAt,
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            EstimatedCost = estimatedCost,
            CostBasis = costBasis,
            Input = input,
            Output = output,
            Attributes = attributes,
            ParentEventId = parentEventId,
            TaskId = taskId,
            ParentTaskId = parentTaskId,
            ChatSessionId = chatSessionId,
            ChatTurnId = chatTurnId,
            SubagentSessionId = subagentSessionId,
            TraceId = traceId,
            SpanId = spanId,
            ReportedAiCredits = reportedAiCredits,
            EstimatedAiCredits = estimatedAiCredits
        });

    [McpServerTool(Name = "start_flight_task")]
    [Description("Start an explicit task for deterministic usage attribution.")]
    public FlightEvent? StartTask(
        [Description("The run ID returned by start_flight_run.")] Guid runId,
        [Description("Task name.")] string name,
        [Description("Task description/objective.")] string? description = null,
        [Description("Task source: manual, prompt, todo, subagent, github-issue, or inferred.")] string source = "manual",
        [Description("Optional explicit task ID.")] Guid? taskId = null)
    {
        var newTaskId = taskId ?? Guid.NewGuid();
        return recorder.RecordEvent(runId, new RecordEventRequest
        {
            Type = FlightEventType.AgentSpan,
            Name = name,
            Status = FlightEventStatus.Started,
            Objective = description,
            TaskId = newTaskId,
            Attributes = new Dictionary<string, string>
            {
                [TaskLifecycleKey] = "start",
                [TaskSourceKey] = source,
                [AttributionMethodKey] = "explicit-task",
                [AttributionConfidenceKey] = "1.0"
            }
        });
    }

    [McpServerTool(Name = "start_flight_subtask")]
    [Description("Start an explicit subtask under the current task or a specified parent task.")]
    public FlightEvent? StartSubtask(
        [Description("The run ID returned by start_flight_run.")] Guid runId,
        [Description("Subtask name.")] string name,
        [Description("Subtask description/objective.")] string? description = null,
        [Description("Parent task ID. Omit to use the current active task.")] Guid? parentTaskId = null,
        [Description("Task source: manual, prompt, todo, subagent, github-issue, or inferred.")] string source = "manual",
        [Description("Optional explicit subtask ID.")] Guid? taskId = null)
    {
        var run = recorder.GetRun(runId);
        if (run is null) return null;
        var context = BuildTaskContext(run.Events);
        var parent = parentTaskId ?? context.CurrentTaskId;
        var newTaskId = taskId ?? Guid.NewGuid();
        return recorder.RecordEvent(runId, new RecordEventRequest
        {
            Type = FlightEventType.AgentSpan,
            Name = name,
            Status = FlightEventStatus.Started,
            Objective = description,
            TaskId = newTaskId,
            ParentTaskId = parent,
            Attributes = new Dictionary<string, string>
            {
                [TaskLifecycleKey] = "start",
                [TaskSourceKey] = source,
                [AttributionMethodKey] = "explicit-task",
                [AttributionConfidenceKey] = "1.0"
            }
        });
    }

    [McpServerTool(Name = "complete_current_flight_task")]
    [Description("Complete the most recently started active task.")]
    public FlightEvent? CompleteCurrentTask(
        [Description("The run ID returned by start_flight_run.")] Guid runId,
        [Description("Completion status. Use Cancelled-like outcomes with Failed or Blocked.")] FlightEventStatus status = FlightEventStatus.Succeeded)
    {
        var run = recorder.GetRun(runId);
        if (run is null) return null;
        var context = BuildTaskContext(run.Events);
        if (context.CurrentTaskId is not { } currentTaskId) return null;
        var name = context.Names.GetValueOrDefault(currentTaskId, "Complete task");
        return recorder.RecordEvent(runId, new RecordEventRequest
        {
            Type = FlightEventType.AgentSpan,
            Name = $"Complete: {name}",
            Status = status,
            TaskId = currentTaskId,
            ParentTaskId = context.Parents.GetValueOrDefault(currentTaskId),
            Attributes = new Dictionary<string, string>
            {
                [TaskLifecycleKey] = "complete",
                [AttributionMethodKey] = "explicit-task",
                [AttributionConfidenceKey] = "1.0"
            }
        });
    }

    [McpServerTool(Name = "assign_current_chat_turn_to_flight_task")]
    [Description("Assign the current chat turn/session context to the active task.")]
    public FlightEvent? AssignCurrentChatTurnToTask(
        [Description("The run ID returned by start_flight_run.")] Guid runId,
        [Description("Chat session ID.")] string chatSessionId,
        [Description("Chat turn ID.")] string chatTurnId,
        [Description("Optional subagent session ID.")] string? subagentSessionId = null,
        [Description("Optional source telemetry trace ID.")] string? traceId = null,
        [Description("Optional source telemetry span ID.")] string? spanId = null)
    {
        var run = recorder.GetRun(runId);
        if (run is null) return null;
        var context = BuildTaskContext(run.Events);
        if (context.CurrentTaskId is not { } currentTaskId) return null;
        return recorder.RecordEvent(runId, new RecordEventRequest
        {
            Type = FlightEventType.AgentSpan,
            Name = "Assign chat turn to task",
            Status = FlightEventStatus.Succeeded,
            TaskId = currentTaskId,
            ParentTaskId = context.Parents.GetValueOrDefault(currentTaskId),
            ChatSessionId = chatSessionId,
            ChatTurnId = chatTurnId,
            SubagentSessionId = subagentSessionId,
            TraceId = traceId,
            SpanId = spanId,
            Attributes = new Dictionary<string, string>
            {
                [AttributionMethodKey] = "explicit-task",
                [AttributionConfidenceKey] = "1.0"
            }
        });
    }

    [McpServerTool(Name = "show_flight_task_usage")]
    [Description("Show task/subtask usage and AI-credit breakdown for a run.")]
    public TaskUsageBreakdown? ShowTaskUsage([Description("The run ID returned by start_flight_run.")] Guid runId)
    {
        var run = recorder.GetRun(runId);
        if (run is null) return null;
        var context = BuildTaskContext(run.Events);
        var groups = run.Events.Where(evt => evt.TaskId.HasValue).GroupBy(evt => evt.TaskId!.Value)
            .Select(group =>
            {
                var events = group.ToArray();
                var start = events.FirstOrDefault(evt => evt.Attributes?.GetValueOrDefault(TaskLifecycleKey) == "start");
                var name = start?.Name ?? context.Names.GetValueOrDefault(group.Key, group.Key.ToString("D"));
                var source = start?.Attributes?.GetValueOrDefault(TaskSourceKey) ?? "inferred";
                var isActive = context.ActiveTaskIds.Contains(group.Key);
                return new TaskUsageItem(
                    group.Key,
                    context.Parents.GetValueOrDefault(group.Key),
                    name,
                    source,
                    isActive ? "active" : "completed",
                    events.Count(evt => evt.Type == FlightEventType.ModelCall),
                    events.Count(evt => evt.Type == FlightEventType.ToolCall),
                    UsageTotals.Tokens(events.Select(evt => evt.InputTokens)),
                    UsageTotals.Tokens(events.Select(evt => evt.OutputTokens)),
                    UsageTotals.Cost(events.Select(evt => evt.ReportedAiCredits)),
                    UsageTotals.Cost(events.Select(evt => evt.EstimatedAiCredits)),
                    events.Sum(evt => evt.Duration.TotalMilliseconds),
                    events.Length);
            })
            .OrderByDescending(item => item.ReportedAiCredits ?? item.EstimatedAiCredits ?? 0m)
            .ThenBy(item => item.Name, StringComparer.Ordinal)
            .ToArray();
        return new TaskUsageBreakdown(runId, run.ReportedAiCredits, run.EstimatedAiCredits, groups);
    }

    [McpServerTool(Name = "complete_flight_run")]
    [Description("Mark a Flight Recorder run as complete.")]
    public bool CompleteRun([Description("The run ID returned by start_flight_run.")] Guid runId)
        => recorder.CompleteRun(runId);

    [McpServerTool(Name = "get_flight_trace")]
    [Description("Retrieve the complete trace for a Flight Recorder run.")]
    public TraceRun? GetRun([Description("The run ID returned by start_flight_run.")] Guid runId)
        => recorder.GetRun(runId);

    [McpServerTool(Name = "analyze_flight_run")]
    [Description("Generate a deterministic, evidence-linked root-cause analysis for a run.")]
    public RootCauseAnalysis? AnalyzeRun([Description("The run ID returned by start_flight_run.")] Guid runId)
        => recorder.Analyze(runId);

    [McpServerTool(Name = "list_flight_runs")]
    [Description("List recorded Flight Recorder run summaries.")]
    public IReadOnlyList<RunSummary> ListRuns() => recorder.ListRuns();

    private static TaskContext BuildTaskContext(IReadOnlyList<FlightEvent> events)
    {
        var stack = new List<Guid>();
        var parents = new Dictionary<Guid, Guid?>();
        var names = new Dictionary<Guid, string>();
        foreach (var evt in events.Where(evt => evt.TaskId.HasValue))
        {
            var taskId = evt.TaskId!.Value;
            if (!parents.ContainsKey(taskId)) parents[taskId] = evt.ParentTaskId;
            if (!names.ContainsKey(taskId)) names[taskId] = evt.Name;
            var lifecycle = evt.Attributes?.GetValueOrDefault(TaskLifecycleKey);
            if (lifecycle == "start")
            {
                if (!stack.Contains(taskId)) stack.Add(taskId);
                continue;
            }
            if (lifecycle != "complete") continue;
            var index = stack.LastIndexOf(taskId);
            if (index >= 0) stack.RemoveAt(index);
        }
        return new TaskContext(stack.Count == 0 ? null : stack[^1], stack.ToHashSet(), parents, names);
    }

    private sealed record TaskContext(Guid? CurrentTaskId, IReadOnlySet<Guid> ActiveTaskIds,
        IReadOnlyDictionary<Guid, Guid?> Parents, IReadOnlyDictionary<Guid, string> Names);
}
