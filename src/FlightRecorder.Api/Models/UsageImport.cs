using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Text.Json.Serialization;

namespace FlightRecorder.Api.Models;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record UsageImportRequest
{
    [JsonRequired] public string SourceKind { get; init; } = "";
    [JsonRequired] public string Format { get; init; } = "";
    [JsonRequired] public string Revision { get; init; } = "";
    [JsonRequired] public string? ExpectedRevision { get; init; }
    [JsonRequired] public IReadOnlyList<UsageObservation> Observations { get; init; } = [];
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
[JsonNumberHandling(JsonNumberHandling.Strict)]
public sealed record UsageObservation
{
    [JsonRequired] public string Id { get; init; } = "";
    [JsonRequired] public string Quality { get; init; } = "";
    public string? Model { get; init; }
    public DateTimeOffset? Timestamp { get; init; }
    public int? InputTokens { get; init; }
    public int? OutputTokens { get; init; }
    public int? EstimatedInputTokens { get; init; }
    public int? EstimatedOutputTokens { get; init; }
    public int? CacheReadTokens { get; init; }
    public int? CacheWriteTokens { get; init; }
    public long? NanoAiu { get; init; }
}

public sealed record ImportedUsage(string SourceId, string ObservationId, string SourceKind, string Format,
    string Quality, int? EstimatedInputTokens = null, int? EstimatedOutputTokens = null,
    int? CacheReadTokens = null, int? CacheWriteTokens = null, long? NanoAiu = null,
    string TimestampMeaning = "import-time");

public sealed record UsageImportCursor(string SourceId, string Revision, string SourceKind, string Format,
    string? SnapshotHash = null);

public sealed record UsageImportResult(string SourceId, string Revision, int ImportedCount, bool Changed);

public static class UsageImportValidation
{
    public const int MaximumObservations = 1000;
    public const int MaximumRequestBytes = 1_048_576;
    public static bool IsHash(string? value) => value is { Length: 64 } && value.All(char.IsAsciiHexDigit);
    public static bool IsSource(string? kind, string? format) => kind switch
    {
        "vscode-chat" => format is "vscode-json" or "vscode-delta-jsonl" or "vscode-event-jsonl",
        "copilot-cli" => format is "copilot-cli-db" or "copilot-cli-events",
        _ => false
    };

    public static void Validate(string sourceId, UsageImportRequest request)
    {
        if (!IsHash(sourceId) || !IsHash(request.Revision) ||
            request.ExpectedRevision is not null && !IsHash(request.ExpectedRevision))
            throw new ValidationException("Source ID and revisions must be 64 hexadecimal characters.");
        if (!IsSource(request.SourceKind, request.Format))
            throw new ValidationException("Source kind and format must identify a supported local session format.");
        if (request.Observations is not { Count: > 0 and <= MaximumObservations })
            throw new ValidationException("A usage snapshot must contain between 1 and 1000 observations.");
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var observation in request.Observations)
        {
            if (observation is null || !IsHash(observation.Id) || !ids.Add(observation.Id))
                throw new ValidationException("Each observation must have a unique 64 hexadecimal character ID.");
            ValidateObservation(request.SourceKind, observation);
        }
    }

    public static void ValidateObservation(string sourceKind, UsageObservation observation)
    {
        if (observation.Model is { } model && (string.IsNullOrWhiteSpace(model) || model.Length > 200 ||
            model.Any(c => char.IsControl(c) || char.GetUnicodeCategory(c) is
                UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator or UnicodeCategory.Surrogate)))
            throw new ValidationException("Model must be a nonblank identifier of at most 200 characters without control characters.");
        if (observation.Timestamp < DateTimeOffset.UnixEpoch)
            throw new ValidationException("Observation timestamps must not precede the Unix epoch.");
        if (observation.InputTokens < 0 || observation.OutputTokens < 0 ||
            observation.EstimatedInputTokens < 0 || observation.EstimatedOutputTokens < 0 ||
            observation.CacheReadTokens < 0 || observation.CacheWriteTokens < 0 || observation.NanoAiu < 0)
            throw new ValidationException("Usage counters cannot be negative.");
        if (observation.NanoAiu > 9_007_199_254_740_991L)
            throw new ValidationException("Nano-AIU must be an exactly representable JSON integer.");
        var measured = observation.InputTokens.HasValue || observation.OutputTokens.HasValue ||
            observation.CacheReadTokens.HasValue || observation.CacheWriteTokens.HasValue;
        var estimated = observation.EstimatedInputTokens.HasValue || observation.EstimatedOutputTokens.HasValue;
        if (observation.Quality switch
            {
                "measured" => !measured || estimated,
                "estimated" => measured || !estimated,
                "unavailable" => measured || estimated,
                _ => true
            })
            throw new ValidationException("Quality must match its counters: measured uses native token fields, estimated uses estimate fields, unavailable has no token fields.");
        if (observation.NanoAiu.HasValue && sourceKind != "copilot-cli")
            throw new ValidationException("Nano-AIU accounting is supported only for Copilot CLI sources.");
    }
}
