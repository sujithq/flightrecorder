using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text.Json;
using FlightRecorder.Api.Models;

namespace FlightRecorder.Api.Services;

public sealed partial class FlightRecorderService
{
    public UsageImportResult? ImportUsage(Guid runId, string sourceId, UsageImportRequest request)
    {
        UsageImportValidation.Validate(sourceId, request);
        sourceId = sourceId.ToLowerInvariant();
        var revision = request.Revision.ToLowerInvariant();
        var expectedRevision = request.ExpectedRevision?.ToLowerInvariant();
        var observations = request.Observations.Select(item => item with
        {
            Id = item.Id.ToLowerInvariant(), Model = item.Model?.Trim(), Timestamp = item.Timestamp?.ToUniversalTime()
        }).OrderBy(item => item.Id, StringComparer.Ordinal).ToArray();
        // The client's revision is opaque. A separate normalized fingerprint detects
        // accidental revision reuse, including after restart, without storing source text.
        var snapshotHash = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
            { request.SourceKind, request.Format, Observations = observations })));
        UsageImportResult? result = null;
        store.Update(runId, current =>
        {
            var cursor = current.UsageImports?.SingleOrDefault();
            if (cursor is not null && (cursor.SourceId != sourceId || cursor.SourceKind != request.SourceKind || cursor.Format != request.Format))
                throw new UsageImportConflictException("This run is already bound to another usage source or format.");
            if (current.Events.Any(evt => evt.ImportedUsage is null &&
                (evt.InputTokens.HasValue || evt.OutputTokens.HasValue || evt.EstimatedCost.HasValue || HasCacheCounters(evt.Attributes))))
                throw new UsageImportConflictException("This run already contains manual or SDK metering; importing usage would be ambiguous.");
            if (cursor?.Revision == revision)
            {
                if (cursor.SnapshotHash != snapshotHash)
                    throw new UsageImportConflictException("This revision was already used with a different snapshot.");
                result = new(sourceId, revision, observations.Length, false);
                return current;
            }
            if (cursor?.Revision != expectedRevision)
                throw new UsageImportConflictException("The expected revision is stale. Read the run cursor before importing another snapshot.");
            var existing = current.Events.Where(evt => evt.ImportedUsage is not null)
                .ToDictionary(evt => evt.ImportedUsage!.ObservationId, StringComparer.Ordinal);
            if (existing.Keys.Union(observations.Select(item => item.Id)).Count() > UsageImportValidation.MaximumObservations)
                throw new ValidationException("A run can retain at most 1000 imported observation IDs, including withdrawn observations.");
            var replacements = new Dictionary<Guid, FlightEvent>();
            var additions = new List<FlightEvent>();
            var receivedAt = DateTimeOffset.UtcNow;
            foreach (var item in observations)
            {
                existing.Remove(item.Id, out var previous);
                var provenance = new ImportedUsage(sourceId, item.Id, request.SourceKind, request.Format, item.Quality,
                    item.EstimatedInputTokens, item.EstimatedOutputTokens, item.CacheReadTokens, item.CacheWriteTokens, item.NanoAiu,
                    item.Timestamp.HasValue ? "observed" : previous?.ImportedUsage?.TimestampMeaning ?? "import-time");
                var evt = new FlightEvent(previous?.Id ?? Guid.NewGuid(), runId, FlightEventType.ModelCall,
                    "Imported Copilot usage", item.Timestamp ?? previous?.StartedAt ?? receivedAt, null, FlightEventStatus.Succeeded,
                    AgentName: "local-usage-import", Model: Metadata(current.RecordingMode, item.Model),
                    Identity: "local-usage-collector", InputTokens: item.InputTokens, OutputTokens: item.OutputTokens,
                    ParentEventId: previous?.ParentEventId, UsageSchemaVersion: 1, ImportedUsage: provenance);
                if (previous is null) additions.Add(evt);
                else replacements[previous.Id] = evt;
            }
            // Retain withdrawn event IDs because later evidence can reference them.
            // A fresh source revision is a correction, not an instruction to sum snapshots.
            foreach (var previous in existing.Values)
                replacements[previous.Id] = previous with
                {
                    InputTokens = null, OutputTokens = null, EstimatedCost = null, CostBasis = null,
                    ImportedUsage = previous.ImportedUsage! with
                    {
                        Quality = "unavailable", EstimatedInputTokens = null, EstimatedOutputTokens = null,
                        CacheReadTokens = null, CacheWriteTokens = null, NanoAiu = null
                    }
                };
            result = new(sourceId, revision, observations.Length, true);
            return current with
            {
                Events = [.. current.Events.Select(evt => replacements.GetValueOrDefault(evt.Id, evt)), .. additions],
                UsageImports = [new(sourceId, revision, request.SourceKind, request.Format, snapshotHash)]
            };
        });
        return result;
    }

    private static bool HasCacheCounters(IEnumerable<KeyValuePair<string, string>>? attributes)
        => attributes?.Any(item => item.Key is "sdk.cacheReadCount" or "sdk.cacheWriteCount") == true;
}
