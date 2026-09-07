using System.Text.Json;
using System.Text.Json.Nodes;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.Data.Sqlite;

namespace FlightRecorder.Api.Tests;

public sealed class TracePersistenceTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("flightrecorder-tests-").FullName;
    private TraceStorageOptions Options(int limit = 10) => new() { DataDirectory = directory, MaxCompletedRuns = limit };
    private FlightRecorderService Service(int limit = 10) => new(store: new SqliteTraceRunStore(Options(limit)));
    private static TraceRun Start(IFlightRecorderService service, RecordingMode mode = RecordingMode.Redacted)
        => service.StartRun(new StartRunRequest
        {
            Request = "Synthetic request token=synthetic-secret", EntryPointAgent = "test-agent",
            RequestingIdentity = "fixture@example.invalid", RecordingMode = mode
        });

    private SqliteConnection Connection()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "traces.db"), Pooling = false, Mode = SqliteOpenMode.ReadWrite
        }.ToString());
        connection.Open();
        return connection;
    }

    private void Sql(string sql)
    {
        using var connection = Connection();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    [Theory]
    [InlineData(RecordingMode.MetadataOnly)]
    [InlineData(RecordingMode.Redacted)]
    [InlineData(RecordingMode.Full)]
    public void Reopening_preserves_trace_fields_and_recording_mode(RecordingMode mode)
    {
        var service = Service();
        var run = Start(service, mode);
        var started = DateTimeOffset.Parse("2026-09-06T10:00:00.1234567+02:00");
        var parent = service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "Parent", Type = FlightEventType.AgentSpan, AgentName = "parent", Identity = "parent-identity",
            StartedAt = started, EndedAt = started.AddSeconds(1), Objective = "Synthetic objective"
        })!;
        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "Synthetic model", Type = FlightEventType.ModelCall, ParentEventId = parent.Id,
            StartedAt = started, EndedAt = started.AddMilliseconds(400), Status = FlightEventStatus.Blocked,
            AgentName = "child", AgentVersion = "1.2", Model = "synthetic-model", ToolServer = "synthetic-tools",
            Identity = "child-identity", RequestedScope = "pull_requests:write", GrantedScope = "contents:read",
            PolicyName = "Approval", PolicyReason = "No approval", InputTokens = 123, OutputTokens = 45,
            CostBasis = "Synthetic USD test estimate.",
            EstimatedCost = 0.0123456789m, Input = "token=synthetic-input", Output = "Bearer synthetic-output",
            Attributes = new() { ["token"] = "synthetic-attribute", ["gen_ai.operation.name"] = "chat" }
        });
        service.CompleteRun(run.Id, started.AddMinutes(1));
        var before = service.GetRun(run.Id)!;
        var after = Service().GetRun(run.Id)!;
        Assert.Equal(JsonSerializer.Serialize(before), JsonSerializer.Serialize(after));
        Assert.Equal(JsonSerializer.Serialize(TraceViewService.Graph(before)), JsonSerializer.Serialize(TraceViewService.Graph(after)));
        Assert.Equal(JsonSerializer.Serialize(service.Analyze(run.Id)), JsonSerializer.Serialize(Service().Analyze(run.Id)));
        Assert.All(TraceViewService.Compare(before, after).Events, change => Assert.Equal("Unchanged", change.Change));
        using var connection = Connection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT payload_json FROM runs";
        var payload = (string)command.ExecuteScalar()!;
        Assert.Null(JsonNode.Parse(payload)!["Duration"]);
        Assert.Null(JsonNode.Parse(payload)!["InputTokens"]);
        if (mode == RecordingMode.Full) Assert.Contains("synthetic-secret", payload);
        else
        {
            Assert.DoesNotContain("synthetic-secret", payload);
            Assert.DoesNotContain("synthetic-input", payload);
            Assert.DoesNotContain("synthetic-output", payload);
            Assert.DoesNotContain("synthetic-attribute", payload);
            Assert.DoesNotContain("fixture@example.invalid", payload);
        }
        if (mode == RecordingMode.MetadataOnly)
        {
            Assert.Equal("[Content omitted]", after.Request);
            Assert.Null(after.Events[0].Objective);
            Assert.Null(after.Events[1].Input);
            Assert.Single(after.Events[1].Attributes!);
        }
    }

    [Fact]
    public void Concurrent_acknowledged_events_and_completion_survive_reopening()
    {
        var service = Service();
        var run = Start(service);
        var parent = service.RecordEvent(run.Id, new RecordEventRequest { Name = "Parent", Type = FlightEventType.AgentSpan })!;
        Parallel.For(0, 200, index =>
        {
            service.RecordEvent(run.Id, new RecordEventRequest { Name = $"Event {index}", ParentEventId = parent.Id, InputTokens = 1 });
            if (index % 10 == 0) service.CompleteRun(run.Id);
        });
        var recovered = Service().GetRun(run.Id)!;
        Assert.Equal(201, recovered.Events.Count);
        Assert.Equal(200, recovered.InputTokens);
        Assert.NotNull(recovered.EndedAt);
        Assert.All(recovered.Events.Skip(1), evt => Assert.Equal(parent.Id, evt.ParentEventId));
        Assert.Equal(201, recovered.Events.Select(evt => evt.Id).Distinct().Count());
    }

    [Fact]
    public void Retention_keeps_latest_completed_and_all_unfinished_runs_across_restarts()
    {
        var service = Service();
        var completed = new List<Guid>();
        var epoch = DateTimeOffset.UtcNow;
        for (var index = 0; index < 12; index++)
        {
            var run = Start(service);
            service.RecordEvent(run.Id, new RecordEventRequest
            {
                Name = "Outcome", Status = index % 2 == 0 ? FlightEventStatus.Failed : FlightEventStatus.Blocked
            });
            service.CompleteRun(run.Id, epoch.AddSeconds(index));
            completed.Add(run.Id);
        }
        var unfinished = new[] { Start(service), Start(service), Start(service) };
        service.RecordEvent(unfinished[0].Id, new RecordEventRequest { Name = "Unfinished block", Status = FlightEventStatus.Blocked });
        service.RecordEvent(unfinished[1].Id, new RecordEventRequest { Name = "Unfinished failure", Status = FlightEventStatus.Failed });
        var recovered = Service();
        Assert.Equal(13, recovered.ListRuns().Count);
        Assert.Null(recovered.GetRun(completed[0]));
        Assert.Null(recovered.GetRun(completed[1]));
        Assert.Null(recovered.RecordEvent(completed[0], new RecordEventRequest { Name = "Cannot resurrect" }));
        Assert.False(recovered.CompleteRun(completed[0]));
        var reduced = Service(3);
        Assert.Equal(6, reduced.ListRuns().Count);
        Assert.All(completed.Take(9), runId => Assert.Null(reduced.GetRun(runId)));
        Assert.All(completed.Skip(9), runId => Assert.NotNull(reduced.GetRun(runId)));
        Assert.All(unfinished, run => Assert.Null(reduced.GetRun(run.Id)!.EndedAt));
        Assert.Equal(6, Service(10).ListRuns().Count);
        Assert.NotNull(reduced.RecordEvent(unfinished[0].Id, new RecordEventRequest { Name = "Resumed work" }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Completion_time_and_stable_ties_control_retention(bool sqlite)
    {
        ITraceRunStore store = sqlite ? new SqliteTraceRunStore(Options(2)) : new InMemoryTraceRunStore(2);
        var started = DateTimeOffset.UtcNow;
        var runs = Enumerable.Range(1, 4).Select(index => new TraceRun(
            Guid.Parse($"00000000-0000-0000-0000-{index:D12}"), "Synthetic", "agent", "identity",
            RecordingMode.MetadataOnly, started, started.AddMinutes(1), [])).ToArray();
        foreach (var run in runs.Reverse()) store.Add(run);
        Assert.Equal(runs.Take(2).Select(run => run.Id).Order(), store.List().Select(run => run.Id).Order());
        var lateCompletion = runs[3] with { StartedAt = started.AddDays(-1), EndedAt = started.AddMinutes(2) };
        store.Add(lateCompletion);
        Assert.NotNull(store.Get(lateCompletion.Id));
        Assert.Null(store.Get(runs[1].Id));
    }

    [Fact]
    public void Failed_retention_rolls_back_completion_and_preserves_prior_history()
    {
        var service = Service(1);
        var completed = Start(service);
        service.CompleteRun(completed.Id);
        var pending = Start(service);
        Sql("CREATE TRIGGER reject_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-private-failure'); END;");
        var error = Assert.Throws<TraceStorageException>(() => service.CompleteRun(pending.Id, DateTimeOffset.UtcNow.AddMinutes(1)));
        Assert.DoesNotContain("synthetic-private-failure", error.ToString());
        Assert.Null(error.InnerException);
        Assert.NotNull(service.GetRun(completed.Id));
        Assert.Null(service.GetRun(pending.Id)!.EndedAt);
        Assert.Equal(2, service.ListRuns().Count);
    }

    [Fact]
    public void Failed_writes_never_report_success_or_mutate_stored_traces()
    {
        var service = Service();
        var run = Start(service);
        Sql("CREATE TRIGGER reject_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-private-failure'); END;");
        Assert.Throws<TraceStorageException>(() => service.RecordEvent(run.Id, new RecordEventRequest { Name = "Not committed" }));
        Assert.Empty(service.GetRun(run.Id)!.Events);
        Sql("CREATE TRIGGER reject_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-private-failure'); END;");
        Assert.Throws<TraceStorageException>(() => Start(service));
        Assert.Single(service.ListRuns());
        Assert.Empty(Service().GetRun(run.Id)!.Events);
    }

    [Fact]
    public void Locked_database_returns_a_sanitized_storage_failure()
    {
        var service = Service();
        var run = Start(service);
        using (var connection = Connection())
        using (var transaction = connection.BeginTransaction(deferred: false))
        {
            Assert.Throws<TraceStorageException>(() => service.RecordEvent(run.Id, new RecordEventRequest { Name = "Locked" }));
        }
        Assert.Empty(Service().GetRun(run.Id)!.Events);
    }

    [Fact]
    public void Invalid_payload_prevents_startup_before_pruning()
    {
        var service = Service();
        for (var index = 0; index < 4; index++) service.CompleteRun(Start(service).Id);
        Sql("UPDATE runs SET payload_json='{}' WHERE id=(SELECT id FROM runs LIMIT 1)");
        Assert.Throws<TraceStorageException>(() => Service(1));
        using var connection = Connection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM runs";
        Assert.Equal(4L, command.ExecuteScalar());
    }

    [Fact]
    public void Unsupported_schema_is_not_replaced()
    {
        var run = Start(Service());
        Sql("PRAGMA user_version=2");
        Assert.Throws<TraceStorageException>(() => Service());
        using var connection = Connection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id FROM runs";
        Assert.Equal(run.Id.ToString("D"), command.ExecuteScalar());
    }

    [Fact]
    public void Corrupt_database_and_unwritable_directory_do_not_fall_back_to_memory()
    {
        var database = Path.Combine(directory, "traces.db");
        File.WriteAllText(database, "synthetic corrupt database");
        Assert.Throws<TraceStorageException>(() => Service());
        Assert.Equal("synthetic corrupt database", File.ReadAllText(database));
        Assert.Throws<TraceStorageException>(() => new SqliteTraceRunStore(new TraceStorageOptions { DataDirectory = database }));
    }

    [Fact]
    public void Deleted_database_is_not_silently_recreated_by_a_running_store()
    {
        var service = Service();
        Start(service);
        File.Delete(Path.Combine(directory, "traces.db"));
        Assert.Throws<TraceStorageException>(() => Start(service));
        Assert.False(File.Exists(Path.Combine(directory, "traces.db")));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Retention_must_be_positive(int limit)
        => Assert.Throws<InvalidOperationException>(() => new SqliteTraceRunStore(Options(limit)));

    [Theory]
    [InlineData("")]
    [InlineData("relative/path")]
    public void Configured_data_directory_must_be_absolute(string path)
        => Assert.Throws<InvalidOperationException>(() => new TraceStorageOptions { DataDirectory = path }.ResolveDataDirectory());

    public void Dispose() => TestDirectory.Delete(directory);
}