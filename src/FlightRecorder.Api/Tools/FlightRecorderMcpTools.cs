using Description = System.ComponentModel.DescriptionAttribute;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using ModelContextProtocol.Server;

namespace FlightRecorder.Api.Tools;

[McpServerToolType]
public sealed class FlightRecorderMcpTools(IFlightRecorderService recorder)
{
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
        [Description("Number of model input tokens consumed.")] int inputTokens = 0,
        [Description("Number of model output tokens consumed.")] int outputTokens = 0,
        [Description("Estimated monetary cost of this event.")] decimal estimatedCost = 0,
        [Description("Input or sanitized parameters supplied to the operation.")] string? input = null,
        [Description("Output or result returned by the operation.")] string? output = null,
        [Description("Additional event metadata, subject to the run recording policy.")] Dictionary<string, string>? attributes = null,
        [Description("An existing event ID in this run that owns this child operation or delegation.")] Guid? parentEventId = null)
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
            Input = input,
            Output = output,
            Attributes = attributes,
            ParentEventId = parentEventId
        });

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
}
