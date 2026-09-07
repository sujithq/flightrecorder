using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using FlightRecorder.Api.Controllers;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;

namespace FlightRecorder.Api.Tests;

public sealed class UsageImportTests : IClassFixture<FlightRecorderApiFactory>
{
    private readonly HttpClient client;
    public UsageImportTests(FlightRecorderApiFactory factory) => client = factory.CreateClient();
    private static string Hash(char value) => new(value, 64);
    private static readonly string Source = Hash('a');
    private static TraceRun Start(IFlightRecorderService service, RecordingMode mode = RecordingMode.MetadataOnly)
        => service.StartRun(new() { Request = "Synthetic import", EntryPointAgent = "test", RequestingIdentity = "test", RecordingMode = mode });
    private static UsageObservation Observation(char id = '1', int? input = 0, int? output = 2)
        => new() { Id = Hash(id), Quality = "measured", InputTokens = input, OutputTokens = output };
    private static UsageImportRequest Snapshot(char revision = 'b', string? expected = null, params UsageObservation[] observations)
        => new() { SourceKind = "copilot-cli", Format = "copilot-cli-events", Revision = Hash(revision),
            ExpectedRevision = expected, Observations = observations.Length == 0 ? [Observation()] : observations };

    [Fact]
    public void Snapshots_are_exact_once_correctable_and_preserve_hierarchy_and_completion()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        var unmetered = service.RecordEvent(run.Id, new() { Name = "Unmetered", Type = FlightEventType.ModelCall })!;
        service.CompleteRun(run.Id);
        var completed = service.GetRun(run.Id)!;
        var first = service.ImportUsage(run.Id, Source, Snapshot())!;
        Assert.True(first.Changed);
        Assert.Equal(1, first.ImportedCount);
        var imported = service.GetRun(run.Id)!.Events.Last();
        Assert.Null(imported.EndedAt);
        Assert.Equal("import-time", imported.ImportedUsage!.TimestampMeaning);
        var child = service.RecordEvent(run.Id, new() { Name = "Evidence", ParentEventId = imported.Id })!;
        Assert.False(service.ImportUsage(run.Id, Source, Snapshot())!.Changed);
        var updated = Snapshot('c', Hash('b'), Observation(input: 7, output: 0));
        service.ImportUsage(run.Id, Source, updated);
        var trace = service.GetRun(run.Id)!;
        Assert.Equal(3, trace.Events.Count);
        Assert.Equal(imported.Id, trace.Events[1].Id);
        Assert.Equal(imported.StartedAt, trace.Events[1].StartedAt);
        Assert.Equal(unmetered, trace.Events[0]);
        Assert.Equal(child, trace.Events[2]);
        Assert.Equal(7, trace.InputTokens);
        Assert.Equal(0, trace.OutputTokens);
        Assert.Equal(completed.EndedAt, trace.EndedAt);
        Assert.Equal(completed.Status, trace.Status);
        Assert.False(trace.Usage.TokensComplete);
        Assert.Throws<UsageImportConflictException>(() => service.ImportUsage(run.Id, Source, Snapshot('d')));
        Assert.Throws<UsageImportConflictException>(() => service.ImportUsage(run.Id, Source, Snapshot('c', Hash('c'), Observation(input: 8))));
        Assert.Throws<UsageImportConflictException>(() => service.ImportUsage(run.Id, Hash('f'), updated));
        var replacement = service.ImportUsage(run.Id, Source, Snapshot('d', Hash('c'), Observation('2', 1, 1)))!;
        Assert.Equal(1, replacement.ImportedCount);
        Assert.True(replacement.Changed);
        trace = service.GetRun(run.Id)!;
        Assert.Equal(imported.Id, trace.Events[1].Id);
        Assert.Equal("unavailable", trace.Events[1].ImportedUsage!.Quality);
        Assert.Null(trace.Events[1].InputTokens);
        Assert.Null(trace.Events[1].ImportedUsage!.NanoAiu);
        Assert.Equal(1, trace.InputTokens);
    }

    [Fact]
    public void Estimates_credits_and_unknowns_never_become_measured_tokens_or_invoice_cost()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        service.ImportUsage(run.Id, Source, Snapshot('b', null,
            new() { Id = Hash('1'), Quality = "estimated", EstimatedInputTokens = 20, EstimatedOutputTokens = 0, NanoAiu = 1_000_000_000 },
            new() { Id = Hash('2'), Quality = "unavailable", NanoAiu = 0 },
            Observation('3', 0, null)));
        var trace = service.GetRun(run.Id)!;
        Assert.Equal(0, trace.InputTokens);
        Assert.Null(trace.OutputTokens);
        Assert.Equal(20, trace.EstimatedInputTokens);
        Assert.Equal(0, trace.EstimatedOutputTokens);
        Assert.Equal(1m, trace.CopilotCredits);
        Assert.Equal(0.01m, trace.CopilotUsageValueUsd);
        Assert.Null(trace.EstimatedCost);
        Assert.False(trace.Usage.TokensComplete);
        Assert.Equal(trace.EstimatedInputTokens, service.ListRuns().Single().EstimatedInputTokens);
        Assert.Equal(trace.CopilotUsageValueUsd, TraceViewService.Metrics(trace).CopilotUsageValueUsd);
        Assert.Null(TraceViewService.Compare(trace, trace).Delta.CopilotCredits);
        var exporter = new TraceExportService(new TraceRedactor());
        var badge = exporter.Badge(trace);
        Assert.Equal(2, badge.Version);
        Assert.Null(badge.EstimatedCost);
        Assert.Null(badge.Tokens);
        var otlp = exporter.Otlp(trace).ToJsonString();
        Assert.Contains("flightrecorder.usage.estimated_input_tokens", otlp);
        Assert.Contains("flightrecorder.usage.copilot_credits", otlp);
        Assert.DoesNotContain("gen_ai.usage.output_tokens", otlp);
        var summary = exporter.GitHubCheck(trace)["output"]!["summary"]!.GetValue<string>();
        Assert.Contains("Recorded token estimates", summary);
        Assert.Contains("Copilot credit-equivalent USD", summary);
        Assert.Contains("not an invoice", summary);
    }

    [Fact]
    public void Import_refuses_existing_metering_and_blocks_future_mixed_metering()
    {
        var service = new FlightRecorderService();
        var prior = Start(service);
        service.RecordEvent(prior.Id, new() { Name = "SDK zero", InputTokens = 0 });
        Assert.Throws<UsageImportConflictException>(() => service.ImportUsage(prior.Id, Source, Snapshot()));
        var run = Start(service);
        service.ImportUsage(run.Id, Source, Snapshot());
        Assert.Throws<UsageImportConflictException>(() => service.RecordEvent(run.Id, new() { Name = "SDK zero", OutputTokens = 0 }));
        Assert.NotNull(service.RecordEvent(run.Id, new() { Name = "Unmetered SDK", Type = FlightEventType.ModelCall }));
        Assert.Null(service.ImportUsage(Guid.NewGuid(), Source, Snapshot()));
    }

    [Fact]
    public void Unknown_and_explicit_zero_accounting_remain_distinct_and_cannot_overflow()
    {
        var service = new FlightRecorderService();
        var missing = Start(service);
        service.ImportUsage(missing.Id, Source, Snapshot('b', null,
            new UsageObservation { Id = Hash('1'), Quality = "unavailable" }));
        var unknown = service.GetRun(missing.Id)!;
        Assert.Null(unknown.InputTokens);
        Assert.Null(unknown.EstimatedInputTokens);
        Assert.Null(unknown.CopilotCredits);
        Assert.Null(unknown.CopilotUsageValueUsd);
        var measured = Start(service);
        service.ImportUsage(measured.Id, Source, Snapshot('b', null,
            Observation('1', int.MaxValue, 0) with { NanoAiu = 9_007_199_254_740_991L },
            Observation('2', int.MaxValue, 0) with { NanoAiu = 9_007_199_254_740_991L }));
        var total = service.GetRun(measured.Id)!;
        Assert.Equal(2L * int.MaxValue, total.InputTokens);
        Assert.Equal(2m * 9_007_199_254_740_991m / 1_000_000_000m, total.CopilotCredits);
        Assert.True(total.Usage.TokensComplete);
        Assert.False(total.Usage.CostComplete);
        service.ImportUsage(measured.Id, Source, Snapshot('c', Hash('b'),
            Observation('1', 0, 0) with { NanoAiu = 0 },
            Observation('2', 0, 0) with { NanoAiu = 0 }));
        var zero = service.GetRun(measured.Id)!;
        Assert.Equal(0, zero.InputTokens);
        Assert.Equal(0, zero.OutputTokens);
        Assert.Equal(0, zero.CopilotCredits);
        Assert.Equal(0, zero.CopilotUsageValueUsd);
        Assert.Null(zero.EstimatedCost);
    }

    [Fact]
    public void Canonical_retries_ignore_order_hex_case_and_timestamp_offset()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        var observation = Observation('d') with { Timestamp = DateTimeOffset.Parse("2026-01-01T00:00:00Z") };
        service.ImportUsage(run.Id, Source, Snapshot('b', null, observation, Observation('e')));
        var retry = Snapshot('b', Hash('b'), Observation('e') with { Id = Hash('E') },
            observation with { Id = Hash('D'), Timestamp = DateTimeOffset.Parse("2026-01-01T02:00:00+02:00") })
            with { Revision = Hash('B') };
        Assert.False(service.ImportUsage(run.Id, Hash('A'), retry)!.Changed);
        Assert.Equal(2, service.GetRun(run.Id)!.Events.Count);
    }

    [Fact]
    public void Privacy_and_provenance_survive_metadata_only_and_corrections_are_compared()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        service.ImportUsage(run.Id, Source, Snapshot('b', null, new UsageObservation
        {
            Id = Hash('1'), Quality = "measured", Model = "model token=synthetic-secret",
            InputTokens = 1, CacheReadTokens = 0, Timestamp = DateTimeOffset.Parse("2026-01-01T00:00:00Z")
        }));
        var before = service.GetRun(run.Id)!;
        var evt = Assert.Single(before.Events);
        Assert.DoesNotContain("synthetic-secret", JsonSerializer.Serialize(before));
        Assert.Equal(Source, evt.ImportedUsage!.SourceId);
        Assert.Equal("observed", evt.ImportedUsage.TimestampMeaning);
        Assert.Null(evt.Input);
        Assert.Null(evt.Output);
        Assert.Null(evt.Attributes);
        service.ImportUsage(run.Id, Source, Snapshot('c', Hash('b'), new UsageObservation { Id = Hash('1'), Quality = "unavailable" }));
        var after = service.GetRun(run.Id)!;
        Assert.Null(after.InputTokens);
        Assert.Contains("ImportedUsage", Assert.Single(TraceViewService.Compare(before, after).Events).ChangedFields);
    }

    [Fact]
    public void Invalid_snapshots_are_rejected_atomically_and_retained_identifiers_are_bounded()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        foreach (var invalid in new[]
        {
            Snapshot() with { Observations = [] },
            Snapshot() with { Observations = [Observation(), Observation()] },
            Snapshot() with { SourceKind = "vscode-chat" },
            Snapshot() with { Revision = "raw-session-id" },
            Snapshot() with { ExpectedRevision = "invalid" },
            Snapshot() with { Observations = [null!] },
            Snapshot() with { Observations = Enumerable.Range(0, 1001).Select(index => Observation() with { Id = index.ToString("x64") }).ToArray() },
            Snapshot('b', null, Observation() with { Model = "bad\nmodel" }),
            Snapshot('b', null, Observation() with { Model = "bad\u202emodel" }),
            Snapshot('b', null, Observation() with { Timestamp = DateTimeOffset.UnixEpoch.AddTicks(-1) }),
            Snapshot('b', null, Observation() with { InputTokens = -1 }),
            Snapshot('b', null, Observation() with { NanoAiu = -1 }),
            Snapshot('b', null, Observation() with { NanoAiu = 9_007_199_254_740_992L }),
            Snapshot('b', null, Observation() with { EstimatedInputTokens = 1 }),
            Snapshot('b', null, new UsageObservation { Id = Hash('1'), Quality = "estimated", InputTokens = 2 }),
            Snapshot('b', null, new UsageObservation { Id = Hash('1'), Quality = "unavailable", CacheReadTokens = 0 })
        })
            Assert.Throws<ValidationException>(() => service.ImportUsage(run.Id, Source, invalid));
        Assert.Empty(service.GetRun(run.Id)!.Events);
        var many = Enumerable.Range(0, 1000).Select(index => Observation() with { Id = index.ToString("x64") }).ToArray();
        service.ImportUsage(run.Id, Source, Snapshot('b', null, many));
        Assert.Throws<ValidationException>(() => service.ImportUsage(run.Id, Source, Snapshot('c', Hash('b'), Observation('f'))));
        Assert.Equal(1000, service.GetRun(run.Id)!.Events.Count);
    }

    [Fact]
    public async Task Rest_endpoint_validates_contract_and_returns_conflicts_and_cursor()
    {
        var limit = typeof(RunsController).GetMethod(nameof(RunsController.ImportUsage))!.GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType == typeof(RequestSizeLimitAttribute));
        Assert.Equal((long)UsageImportValidation.MaximumRequestBytes, limit.ConstructorArguments[0].Value);
        using var start = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
            { Request = "Synthetic import", EntryPointAgent = "test", RequestingIdentity = "test" });
        var run = (await start.Content.ReadFromJsonAsync<TraceRun>())!;
        Assert.Empty(run.UsageImports!);
        Assert.Empty((await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}"))!.UsageImports!);
        var url = $"/api/runs/{run.Id}/usage-imports/{Source}";
        using var imported = await client.PutAsJsonAsync(url, Snapshot());
        Assert.Equal(HttpStatusCode.OK, imported.StatusCode);
        var result = (await imported.Content.ReadFromJsonAsync<UsageImportResult>())!;
        Assert.Equal(new UsageImportResult(Source, Hash('b'), 1, true), result);
        using var retry = await client.PutAsJsonAsync(url, Snapshot());
        Assert.False((await retry.Content.ReadFromJsonAsync<UsageImportResult>())!.Changed);
        using var stale = await client.PutAsJsonAsync(url, Snapshot('c'));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        using var mixed = await client.PostAsJsonAsync($"/api/runs/{run.Id}/events", new { name = "SDK", inputTokens = 0 });
        Assert.Equal(HttpStatusCode.Conflict, mixed.StatusCode);
        using var missing = await client.PutAsJsonAsync($"/api/runs/{Guid.NewGuid()}/usage-imports/{Source}", Snapshot());
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        var cursor = Assert.Single((await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}"))!.UsageImports!);
        Assert.Equal(Hash('b'), cursor.Revision);
        var valid = JsonSerializer.SerializeToNode(Snapshot(), new JsonSerializerOptions(JsonSerializerDefaults.Web))!.AsObject();
        foreach (var mutation in new Action<JsonObject>[]
        {
            body => body["attributes"] = new JsonObject(),
            body => body.Remove("expectedRevision"),
            body => body["observations"] = new JsonArray(),
            body => body["observations"]![0]!["prompt"] = "not allowed",
            body => body["observations"]![0]!["nanoAiu"] = 1.5,
            body => body["observations"]![0]!["inputTokens"] = "12",
            body => body["observations"]![0]!["model"] = new string('x', 201),
            body => body["observations"]![0]!["model"] = "model\ncontrol",
            body => body["observations"]![0]!["nanoAiu"] = JsonNode.Parse("9223372036854775808"),
            body => body["observations"]![0]!["inputTokens"] = JsonNode.Parse("2147483648"),
            body => body["observations"]![0]!["inputTokens"] = -1,
            body => body["observations"]![0]!["quality"] = "unknown",
            body => body["observations"] = null,
            body => body["observations"]![0] = null,
            body => body["observations"]![0]!["timestamp"] = "invalid"
        })
        {
            var body = valid.DeepClone().AsObject();
            mutation(body);
            using var invalid = await client.PutAsJsonAsync(url, body);
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        }
        using var invalidId = await client.PutAsJsonAsync($"/api/runs/{run.Id}/usage-imports/not-a-hash", Snapshot());
        Assert.Equal(HttpStatusCode.BadRequest, invalidId.StatusCode);
        var oversized = Encoding.UTF8.GetBytes(new string(' ', UsageImportValidation.MaximumRequestBytes) + valid);
        using var content = new StreamContent(new MemoryStream(oversized));
        content.Headers.ContentType = new("application/json");
        using var tooLarge = await client.PutAsync(url, content);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode);
    }

    [Fact]
    public async Task Sqlite_restart_preserves_cursor_and_serializes_racing_updates()
    {
        var directory = Path.Combine(Directory.GetCurrentDirectory(), "artifacts", "validation", "usage-import-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            FlightRecorderService Service() => new(store: new SqliteTraceRunStore(new() { DataDirectory = directory }));
            var service = Service();
            var run = Start(service);
            using (var legacy = new SqliteConnection(new SqliteConnectionStringBuilder
                { DataSource = Path.Combine(directory, "traces.db"), Pooling = false }.ToString()))
            {
                legacy.Open();
                using var removeCursor = legacy.CreateCommand();
                removeCursor.CommandText = "UPDATE runs SET payload_json=json_remove(payload_json, '$.UsageImports')";
                removeCursor.ExecuteNonQuery();
            }
            Assert.Empty(Service().GetRun(run.Id)!.UsageImports!);
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            async Task<bool> Import(char revision)
            {
                await gate.Task;
                try { Service().ImportUsage(run.Id, Source, Snapshot(revision)); return true; }
                catch (UsageImportConflictException) { return false; }
            }
            var races = new[] { Task.Run(() => Import('b')), Task.Run(() => Import('c')) };
            gate.SetResult();
            Assert.Single(await Task.WhenAll(races), result => result);
            var reopened = Service();
            var trace = reopened.GetRun(run.Id)!;
            var cursor = Assert.Single(trace.UsageImports!);
            var evt = Assert.Single(trace.Events);
            Assert.False(reopened.ImportUsage(run.Id, Source, Snapshot(cursor.Revision[0]))!.Changed);
            Assert.Equal(evt.Id, Assert.Single(Service().GetRun(run.Id)!.Events).Id);
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
                { DataSource = Path.Combine(directory, "traces.db"), Pooling = false }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE runs SET payload_json=json_set(payload_json, '$.Events[0].ImportedUsage.NanoAiu', -1)";
            command.ExecuteNonQuery();
            Assert.Throws<TraceStorageException>(() => Service());
        }
        finally { TestDirectory.Delete(directory); }
    }

    [Fact]
    public void Failed_snapshot_write_rolls_back_metrics_and_cursor_but_retries_need_no_write()
    {
        var directory = Path.Combine(Directory.GetCurrentDirectory(), "artifacts", "validation", "usage-import-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var service = new FlightRecorderService(store: new SqliteTraceRunStore(new() { DataDirectory = directory }));
            var run = Start(service);
            service.ImportUsage(run.Id, Source, Snapshot());
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
                { DataSource = Path.Combine(directory, "traces.db"), Pooling = false }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "CREATE TRIGGER reject_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;";
            command.ExecuteNonQuery();
            Assert.False(service.ImportUsage(run.Id, Source, Snapshot())!.Changed);
            Assert.Throws<TraceStorageException>(() => service.ImportUsage(run.Id, Source,
                Snapshot('c', Hash('b'), Observation(input: 100))));
            var trace = service.GetRun(run.Id)!;
            Assert.Equal(0, trace.InputTokens);
            Assert.Equal(Hash('b'), Assert.Single(trace.UsageImports!).Revision);
        }
        finally { TestDirectory.Delete(directory); }
    }
}
