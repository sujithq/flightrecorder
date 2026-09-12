using System.Text.Json;
using System.ComponentModel.DataAnnotations;
using FlightRecorder.Api.Models;
using Microsoft.Data.Sqlite;

namespace FlightRecorder.Api.Services;

public sealed class SqliteTraceRunStore : ITraceRunStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { IgnoreReadOnlyProperties = true };
    private const string SelectRuns = "SELECT id, started_at_utc_ticks, completed_at_utc_ticks, payload_json FROM runs";
    private readonly string connectionString;
    private readonly int maxCompletedRuns;

    public SqliteTraceRunStore(TraceStorageOptions options)
    {
        var directory = options.ResolveDataDirectory();
        maxCompletedRuns = options.MaxCompletedRuns;
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "traces.db"),
            Mode = SqliteOpenMode.ReadWrite,
            Cache = SqliteCacheMode.Private,
            Pooling = false,
            DefaultTimeout = 5
        }.ToString();
        ProtectStorage(() =>
        {
            Directory.CreateDirectory(directory);
            Initialize();
            return true;
        });
    }

    public void Add(TraceRun run) => ProtectStorage(() =>
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred: false);
        Write(connection, transaction, run, insert: true);
        if (run.EndedAt is not null) Prune(connection, transaction);
        transaction.Commit();
        return true;
    });

    public TraceRun? Get(Guid runId) => ProtectStorage(() =>
    {
        using var connection = Open();
        return Read(connection, null, runId);
    });

    public IReadOnlyList<TraceRun> List() => ProtectStorage<IReadOnlyList<TraceRun>>(() =>
    {
        using var connection = Open();
        return ReadAll(connection, null);
    });

    public TraceRun? Update(Guid runId, Func<TraceRun, TraceRun> update) => ProtectStorage(() =>
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred: false);
        var current = Read(connection, transaction, runId);
        if (current is null) return null;
        var updated = update(current);
        if (updated.Id != runId) throw new ArgumentException("A run update cannot change its ID.", nameof(update));
        if (ReferenceEquals(current, updated))
        {
            transaction.Commit();
            return current;
        }
        Write(connection, transaction, updated, insert: false);
        if (updated.EndedAt is not null) Prune(connection, transaction);
        transaction.Commit();
        return updated;
    });

    private void Initialize()
    {
        using var connection = Open(create: true);
        using (var journal = Command(connection, null, "PRAGMA journal_mode=DELETE"))
        {
            if (!string.Equals(journal.ExecuteScalar()?.ToString(), "delete", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException();
        }
        using var transaction = connection.BeginTransaction(deferred: false);
        using (var integrity = Command(connection, transaction, "PRAGMA integrity_check"))
        using (var result = integrity.ExecuteReader())
        {
            if (!result.Read() || result.GetString(0) != "ok" || result.Read()) throw new InvalidDataException();
        }
        using var versionCommand = Command(connection, transaction, "PRAGMA user_version");
        var version = Convert.ToInt64(versionCommand.ExecuteScalar());
        if (version == 0)
        {
            using var tables = Command(connection, transaction,
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
            if (Convert.ToInt64(tables.ExecuteScalar()) != 0) throw new InvalidDataException();
            using var schema = Command(connection, transaction, """
                CREATE TABLE runs (
                    id TEXT PRIMARY KEY NOT NULL,
                    started_at_utc_ticks INTEGER NOT NULL,
                    completed_at_utc_ticks INTEGER,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX completed_runs ON runs(completed_at_utc_ticks DESC, started_at_utc_ticks DESC, id)
                    WHERE completed_at_utc_ticks IS NOT NULL;
                PRAGMA user_version=1;
                """);
            schema.ExecuteNonQuery();
        }
        else if (version != 1) throw new InvalidDataException();
        ReadAll(connection, transaction);
        Prune(connection, transaction);
        transaction.Commit();
    }

    private SqliteConnection Open(bool create = false)
    {
        var settings = new SqliteConnectionStringBuilder(connectionString);
        if (create) settings.Mode = SqliteOpenMode.ReadWriteCreate;
        var connection = new SqliteConnection(settings.ToString());
        try
        {
            connection.Open();
            using var sync = Command(connection, null, "PRAGMA synchronous=FULL");
            sync.ExecuteNonQuery();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private static TraceRun? Read(SqliteConnection connection, SqliteTransaction? transaction, Guid runId)
    {
        using var command = Command(connection, transaction, SelectRuns + " WHERE id=$id");
        command.Parameters.AddWithValue("$id", runId.ToString("D"));
        using var reader = command.ExecuteReader();
        return reader.Read() ? Decode(reader) : null;
    }

    private static IReadOnlyList<TraceRun> ReadAll(SqliteConnection connection, SqliteTransaction? transaction)
    {
        using var command = Command(connection, transaction, SelectRuns);
        using var reader = command.ExecuteReader();
        var runs = new List<TraceRun>();
        while (reader.Read()) runs.Add(Decode(reader));
        return runs;
    }

    private static TraceRun Decode(SqliteDataReader reader)
    {
        var run = JsonSerializer.Deserialize<TraceRun>(reader.GetString(3), JsonOptions);
        var endedAt = reader.IsDBNull(2) ? (long?)null : reader.GetInt64(2);
        if (run is null || run.Id == Guid.Empty || run.Id.ToString("D") != reader.GetString(0) ||
            run.StartedAt.UtcTicks != reader.GetInt64(1) || run.EndedAt?.UtcTicks != endedAt ||
            run.Request is null || run.EntryPointAgent is null || run.RequestingIdentity is null ||
            !Enum.IsDefined(run.RecordingMode) || run.Events is null)
            throw new InvalidDataException();
        var seen = new HashSet<Guid>();
        foreach (var evt in run.Events)
        {
            if (evt is null || evt.Id == Guid.Empty || evt.RunId != run.Id || seen.Contains(evt.Id) ||
                evt.Name is null || !Enum.IsDefined(evt.Type) || !Enum.IsDefined(evt.Status) ||
                evt.InputTokens < 0 || evt.OutputTokens < 0 || evt.EstimatedCost < 0 ||
                evt.ReportedAiCredits < 0 || evt.EstimatedAiCredits < 0 ||
                evt.ParentTaskId is not null && evt.TaskId is null ||
                evt.UsageSchemaVersion is not (null or 1) ||
                evt.StartedAt < DateTimeOffset.UnixEpoch || evt.EndedAt < evt.StartedAt ||
                evt.ParentEventId is { } parentId && !seen.Contains(parentId))
                throw new InvalidDataException();
            seen.Add(evt.Id);
        }
        ValidateUsageImports(run);
        // Older writers persisted omitted measurements as zero. Those zeros cannot
        // be distinguished from measured zero; retain positive evidence, not guesses.
        return run with
        {
            UsageImports = run.UsageImports ?? [],
            Events = run.Events.Select(evt => evt.UsageSchemaVersion is null ? evt with
            {
                InputTokens = evt.InputTokens == 0 ? null : evt.InputTokens,
                OutputTokens = evt.OutputTokens == 0 ? null : evt.OutputTokens,
                EstimatedCost = evt.EstimatedCost == 0 ? null : evt.EstimatedCost
            } : evt).ToArray()
        };
    }

    private static void ValidateUsageImports(TraceRun run)
    {
        var imported = run.Events.Where(evt => evt.ImportedUsage is not null).ToArray();
        if (run.UsageImports is not { Count: > 0 })
        {
            if (imported.Length != 0) throw new InvalidDataException();
            return;
        }
        if (run.UsageImports.Count != 1 || imported.Length is 0 or > UsageImportValidation.MaximumObservations)
            throw new InvalidDataException();
        var cursor = run.UsageImports[0];
        if (cursor is null || !UsageImportValidation.IsHash(cursor.SourceId) ||
            !UsageImportValidation.IsHash(cursor.Revision) || !UsageImportValidation.IsHash(cursor.SnapshotHash) ||
            !UsageImportValidation.IsSource(cursor.SourceKind, cursor.Format) ||
            run.Events.Any(evt => evt.ImportedUsage is null &&
                (evt.InputTokens.HasValue || evt.OutputTokens.HasValue || evt.EstimatedCost.HasValue ||
                    evt.Attributes?.Keys.Any(key => key is "sdk.cacheReadCount" or "sdk.cacheWriteCount") == true)))
            throw new InvalidDataException();
        var identifiers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var evt in imported)
        {
            var usage = evt.ImportedUsage!;
            if (usage.SourceId != cursor.SourceId || usage.SourceKind != cursor.SourceKind || usage.Format != cursor.Format ||
                !UsageImportValidation.IsHash(usage.ObservationId) || !identifiers.Add(usage.ObservationId) ||
                usage.TimestampMeaning is not ("observed" or "import-time") || evt.Type != FlightEventType.ModelCall ||
                evt.Status != FlightEventStatus.Succeeded || evt.UsageSchemaVersion != 1 || evt.EndedAt is not null ||
                evt.EstimatedCost is not null || evt.CostBasis is not null || evt.Input is not null || evt.Output is not null ||
                evt.Attributes is not null)
                throw new InvalidDataException();
            try
            {
                UsageImportValidation.ValidateObservation(usage.SourceKind, new()
                {
                    Id = usage.ObservationId, Quality = usage.Quality, Model = evt.Model, Timestamp = evt.StartedAt,
                    InputTokens = evt.InputTokens, OutputTokens = evt.OutputTokens,
                    EstimatedInputTokens = usage.EstimatedInputTokens, EstimatedOutputTokens = usage.EstimatedOutputTokens,
                    CacheReadTokens = usage.CacheReadTokens, CacheWriteTokens = usage.CacheWriteTokens, NanoAiu = usage.NanoAiu
                });
            }
            catch (ValidationException) { throw new InvalidDataException(); }
        }
    }

    private static void Write(SqliteConnection connection, SqliteTransaction transaction, TraceRun run, bool insert)
    {
        using var command = Command(connection, transaction, insert
            ? "INSERT INTO runs(id, started_at_utc_ticks, completed_at_utc_ticks, payload_json) VALUES($id, $started, $completed, $payload)"
            : "UPDATE runs SET started_at_utc_ticks=$started, completed_at_utc_ticks=$completed, payload_json=$payload WHERE id=$id");
        command.Parameters.AddWithValue("$id", run.Id.ToString("D"));
        command.Parameters.AddWithValue("$started", run.StartedAt.UtcTicks);
        command.Parameters.AddWithValue("$completed", run.EndedAt is { } completed ? completed.UtcTicks : DBNull.Value);
        command.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(run, JsonOptions));
        if (command.ExecuteNonQuery() != 1) throw new InvalidDataException();
    }

    private void Prune(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = Command(connection, transaction, """
            DELETE FROM runs WHERE id IN (
                SELECT id FROM runs WHERE completed_at_utc_ticks IS NOT NULL
                ORDER BY completed_at_utc_ticks DESC, started_at_utc_ticks DESC, id
                LIMIT -1 OFFSET $limit
            )
            """);
        command.Parameters.AddWithValue("$limit", maxCompletedRuns);
        command.ExecuteNonQuery();
    }

    private static SqliteCommand Command(SqliteConnection connection, SqliteTransaction? transaction, string sql)
    {
        var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        return command;
    }

    private static T ProtectStorage<T>(Func<T> operation)
    {
        try { return operation(); }
        catch (Exception error) when (error is SqliteException or IOException or InvalidDataException or UnauthorizedAccessException or JsonException)
        {
            throw new TraceStorageException();
        }
    }
}