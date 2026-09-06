using System.ComponentModel.DataAnnotations;

namespace FlightRecorder.Api.Models;

public sealed class StartRunRequest
{
    [Required, MinLength(1)]
    public string Request { get; init; } = string.Empty;

    [Required, MinLength(1)]
    public string EntryPointAgent { get; init; } = string.Empty;

    [Required, MinLength(1)]
    public string RequestingIdentity { get; init; } = string.Empty;

    [EnumDataType(typeof(RecordingMode))]
    public RecordingMode RecordingMode { get; init; } = RecordingMode.MetadataOnly;
}

public sealed class RecordEventRequest : IValidatableObject
{
    [Required, MinLength(1)]
    public string Name { get; init; } = string.Empty;

    [Required, EnumDataType(typeof(FlightEventType))]
    public FlightEventType Type { get; init; }

    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EndedAt { get; init; }
    [EnumDataType(typeof(FlightEventStatus))]
    public FlightEventStatus Status { get; init; } = FlightEventStatus.Succeeded;
    public Guid? ParentEventId { get; init; }
    public string? AgentName { get; init; }
    public string? AgentVersion { get; init; }
    public string? Model { get; init; }
    public string? ToolServer { get; init; }
    public string? Identity { get; init; }
    public string? Objective { get; init; }
    public string? RequestedScope { get; init; }
    public string? GrantedScope { get; init; }
    public string? PolicyName { get; init; }
    public string? PolicyReason { get; init; }
    [Range(0, int.MaxValue)] public int InputTokens { get; init; }
    [Range(0, int.MaxValue)] public int OutputTokens { get; init; }
    [Range(0, double.MaxValue)] public decimal EstimatedCost { get; init; }
    public string? Input { get; init; }
    public string? Output { get; init; }
    public Dictionary<string, string>? Attributes { get; init; }

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (EndedAt < StartedAt)
            yield return new ValidationResult("End time cannot precede start time.", [nameof(EndedAt)]);
        if (StartedAt < DateTimeOffset.UnixEpoch || EndedAt < DateTimeOffset.UnixEpoch)
            yield return new ValidationResult("Trace timestamps must not precede the Unix epoch.", [nameof(StartedAt)]);
        if (string.IsNullOrWhiteSpace(Name))
            yield return new ValidationResult("Event name cannot be blank.", [nameof(Name)]);
    }
}
