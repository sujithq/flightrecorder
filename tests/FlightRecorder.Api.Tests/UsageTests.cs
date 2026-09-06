using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using FlightRecorder.Api.Tools;
using Microsoft.Data.Sqlite;

namespace FlightRecorder.Api.Tests;

public sealed class UsageTests : IClassFixture<FlightRecorderApiFactory>
{
    private readonly HttpClient client;
    public UsageTests(FlightRecorderApiFactory factory) => client = factory.CreateClient();

    private static TraceRun Start(IFlightRecorderService service) => service.StartRun(new StartRunRequest
    {
        Request = "Synthetic usage check", EntryPointAgent = "test-agent", RequestingIdentity = "test",
        RecordingMode = RecordingMode.Redacted
    });

    [Fact]
    public void Omitted_measurements_remain_null_in_events_runs_summaries_comparison_and_badge()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        var evt = service.RecordEvent(run.Id, new() { Name = "Usage unavailable", Type = FlightEventType.ModelCall })!;
        Assert.Null(evt.InputTokens);
        Assert.Null(evt.OutputTokens);
        Assert.Null(evt.EstimatedCost);
        Assert.Equal(1, evt.UsageSchemaVersion);
        var trace = service.GetRun(run.Id)!;
        Assert.Null(trace.InputTokens);
        Assert.Null(trace.OutputTokens);
        Assert.Null(trace.EstimatedCost);
        Assert.Equal(1, trace.Usage.EventCount);
        Assert.False(trace.Usage.TokensComplete);
        Assert.False(trace.Usage.CostComplete);
        Assert.Null(service.ListRuns().Single().InputTokens);
        Assert.Equal(trace.Usage, service.ListRuns().Single().Usage);
        Assert.Null(TraceViewService.Compare(trace, trace).Delta.InputTokens);
        var badge = new TraceExportService(new TraceRedactor()).Badge(trace);
        Assert.Equal(2, badge.Version);
        Assert.Null(badge.Tokens);
        Assert.Null(badge.EstimatedCost);
    }

    [Fact]
    public void Explicit_zero_and_positive_measurements_are_preserved()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        service.RecordEvent(run.Id, new()
        {
            Name = "Measured zero", Type = FlightEventType.ModelCall, Model = "test-model",
            InputTokens = 0, OutputTokens = 0, EstimatedCost = 0, CostBasis = "Synthetic USD rate of 0 for both token directions."
        });
        var zero = service.GetRun(run.Id)!;
        Assert.Equal(0, zero.InputTokens);
        Assert.Equal(0, zero.OutputTokens);
        Assert.Equal(0, zero.EstimatedCost);
        Assert.True(zero.Usage.TokensComplete);
        Assert.True(zero.Usage.CostComplete);
        var badge = new TraceExportService(new TraceRedactor()).Badge(zero);
        Assert.Equal(0, badge.Tokens);
        Assert.Equal(0, badge.EstimatedCost);
        service.RecordEvent(run.Id, new()
        {
            Name = "Reported usage", Type = FlightEventType.ModelCall, Model = "test-model",
            InputTokens = 100, OutputTokens = 25, EstimatedCost = 0.0002m, CostBasis = "Synthetic USD test pricing."
        });
        var reported = service.GetRun(run.Id)!;
        Assert.Equal(100, reported.InputTokens);
        Assert.Equal(25, reported.OutputTokens);
        Assert.Equal(0.0002m, reported.EstimatedCost);
        Assert.Equal(100, TraceViewService.Compare(zero, reported).Delta.InputTokens);
    }

    [Fact]
    public void Partial_totals_keep_known_usage_without_claiming_complete_cost_or_savings()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        service.RecordEvent(run.Id, new() { Name = "Build", Type = FlightEventType.ToolCall });
        service.RecordEvent(run.Id, new() { Name = "Missing model usage", Type = FlightEventType.ModelCall });
        service.RecordEvent(run.Id, new() { Name = "Input only", InputTokens = 12 });
        service.RecordEvent(run.Id, new()
        {
            Name = "Complete model usage", Type = FlightEventType.ModelCall, Model = "test-model",
            InputTokens = 3, OutputTokens = 5, EstimatedCost = 0, CostBasis = "Synthetic free USD pricing."
        });
        var trace = service.GetRun(run.Id)!;
        Assert.Equal(15, trace.InputTokens);
        Assert.Equal(5, trace.OutputTokens);
        Assert.Equal(new UsageCoverage(3, 2, 1, 1), trace.Usage);
        var comparison = TraceViewService.Compare(trace, trace);
        Assert.Null(comparison.Delta.InputTokens);
        Assert.Null(comparison.Delta.OutputTokens);
        Assert.Null(comparison.Delta.EstimatedCost);
        var exporter = new TraceExportService(new TraceRedactor());
        Assert.Null(exporter.Badge(trace).Tokens);
        Assert.Null(exporter.Badge(trace).EstimatedCost);
        var summary = exporter.GitHubCheck(trace)["output"]!["summary"]!.GetValue<string>();
        Assert.Contains("20 (partial)", summary);
        Assert.Contains("$0.0000 (partial)", summary);
    }

    [Fact]
    public void Aggregate_tokens_do_not_overflow_int32()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        for (var index = 0; index < 2; index++)
            service.RecordEvent(run.Id, new() { Name = "Large reported usage", InputTokens = int.MaxValue });
        Assert.Equal(2L * int.MaxValue, service.GetRun(run.Id)!.InputTokens);
    }

    [Fact]
    public void Empty_run_does_not_claim_measured_zero()
    {
        var run = Start(new FlightRecorderService());
        Assert.Null(run.InputTokens);
        Assert.Null(run.OutputTokens);
        Assert.Null(run.EstimatedCost);
        Assert.False(run.Usage.TokensComplete);
        Assert.False(run.Usage.CostComplete);
    }

    [Theory]
    [InlineData("cost-only")]
    [InlineData("missing-model")]
    [InlineData("missing-output")]
    [InlineData("missing-basis")]
    [InlineData("basis-without-cost")]
    public void Estimate_requires_model_reported_tokens_and_pricing_basis(string invalid)
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        Assert.Throws<ValidationException>(() => service.RecordEvent(run.Id, new()
        {
            Name = "Invalid pricing",
            Model = invalid is "cost-only" or "missing-model" ? null : "test-model",
            InputTokens = invalid == "cost-only" ? null : 12,
            OutputTokens = invalid is "cost-only" or "missing-output" ? null : 4,
            EstimatedCost = invalid == "basis-without-cost" ? null : 0,
            CostBasis = invalid is "cost-only" or "missing-basis" ? null : "Synthetic USD test pricing."
        }));
        Assert.Empty(service.GetRun(run.Id)!.Events);
    }

    [Fact]
    public void Mcp_omission_is_not_zero_and_an_explicit_zero_is_recorded()
    {
        var tools = new FlightRecorderMcpTools(new FlightRecorderService());
        var run = tools.StartRun("Synthetic MCP usage check", "test-agent", "test", RecordingMode.Redacted);
        var missing = tools.RecordEvent(run.Id, FlightEventType.ModelCall, "Not reported")!;
        Assert.Null(missing.InputTokens);
        Assert.Null(missing.EstimatedCost);
        var zero = tools.RecordEvent(run.Id, FlightEventType.ModelCall, "Reported zero",
            model: "test-model", inputTokens: 0, outputTokens: 0, estimatedCost: 0, costBasis: "Synthetic USD test prices.")!;
        Assert.Equal(0, zero.InputTokens);
        Assert.Equal(0, zero.EstimatedCost);
    }

    [Fact]
    public async Task Mcp_wire_call_without_usage_persists_null_not_default_zero()
    {
        using var started = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
        {
            Request = "Synthetic MCP wire check", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        started.EnsureSuccessStatusCode();
        var run = (await started.Content.ReadFromJsonAsync<TraceRun>())!;
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mcp")
        {
            Content = JsonContent.Create(new
            {
                jsonrpc = "2.0", id = 1, method = "tools/call",
                @params = new { name = "record_flight_event", arguments = new
                {
                    runId = run.Id, type = "ModelCall", name = "Wire usage omitted"
                } }
            })
        };
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        request.Headers.Add("MCP-Protocol-Version", "2025-11-25");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        var json = response.Content.Headers.ContentType?.MediaType == "text/event-stream"
            ? body.Split('\n').First(line => line.StartsWith("data:", StringComparison.Ordinal))[5..] : body;
        Assert.NotNull(JsonNode.Parse(json)!["result"]);
        Assert.NotEqual(true, JsonNode.Parse(json)!["result"]!["isError"]?.GetValue<bool>());
        var trace = (await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}"))!;
        var evt = Assert.Single(trace.Events);
        Assert.Null(evt.InputTokens);
        Assert.Null(evt.OutputTokens);
        Assert.Null(evt.EstimatedCost);
    }

    [Fact]
    public async Task Http_contract_preserves_null_and_validates_negative_or_unjustified_estimates()
    {
        using var start = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
        {
            Request = "Synthetic HTTP check", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        start.EnsureSuccessStatusCode();
        var run = (await start.Content.ReadFromJsonAsync<TraceRun>())!;
        using var record = await client.PostAsJsonAsync($"/api/runs/{run.Id}/events", new { name = "Missing", type = 2 });
        record.EnsureSuccessStatusCode();
        var evt = JsonNode.Parse(await record.Content.ReadAsStringAsync())!.AsObject();
        Assert.True(evt.ContainsKey("inputTokens"));
        Assert.Null(evt["inputTokens"]);
        Assert.Null(evt["outputTokens"]);
        Assert.Null(evt["estimatedCost"]);
        foreach (var body in new object[]
        {
            new { name = "Invalid", type = 2, inputTokens = -1 },
            new { name = "Invalid", type = 2, estimatedCost = 0.5 },
            new { name = "Invalid", type = 2, inputTokens = 0, outputTokens = 0, estimatedCost = -1, model = "test", costBasis = "USD" }
        })
        {
            using var invalid = await client.PostAsJsonAsync($"/api/runs/{run.Id}/events", body);
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        }
    }

    [Fact]
    public void Otlp_omits_unknown_attributes_and_retains_reported_zero_with_pricing_basis()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        service.RecordEvent(run.Id, new() { Name = "Missing", Type = FlightEventType.ModelCall });
        var exporter = new TraceExportService(new TraceRedactor());
        Assert.DoesNotContain("gen_ai.usage.input_tokens", exporter.Otlp(service.GetRun(run.Id)!).ToJsonString());
        Assert.DoesNotContain("flightrecorder.estimated_cost", exporter.Otlp(service.GetRun(run.Id)!).ToJsonString());
        Assert.Contains("Not reported", exporter.GitHubCheck(service.GetRun(run.Id)!)["output"]!["summary"]!.GetValue<string>());
        service.RecordEvent(run.Id, new()
        {
            Name = "Known", Type = FlightEventType.ModelCall, Model = "test-model",
            InputTokens = 0, OutputTokens = 0, EstimatedCost = 0, CostBasis = "Synthetic USD test pricing."
        });
        var json = exporter.Otlp(service.GetRun(run.Id)!).ToJsonString();
        Assert.Contains("gen_ai.usage.input_tokens", json);
        Assert.Contains("flightrecorder.cost_basis", json);
        Assert.Contains("USD", json);
    }

    [Fact]
    public void Small_positive_cost_is_not_exported_as_free_usage()
    {
        var service = new FlightRecorderService();
        var run = Start(service);
        service.RecordEvent(run.Id, new()
        {
            Name = "Small positive estimate", Type = FlightEventType.ModelCall, Model = "test",
            InputTokens = 1, OutputTokens = 1, EstimatedCost = 0.00001m, CostBasis = "Synthetic USD test prices."
        });
        var summary = new TraceExportService(new TraceRedactor()).GitHubCheck(service.GetRun(run.Id)!);
        Assert.Contains("<$0.0001", summary["output"]!["summary"]!.GetValue<string>());
    }

    [Fact]
    public void Metadata_only_retains_allowlisted_usage_evidence_not_arbitrary_bodies()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new()
        {
            Request = "Synthetic metadata check", EntryPointAgent = "test", RequestingIdentity = "test",
            RecordingMode = RecordingMode.MetadataOnly
        });
        var evt = service.RecordEvent(run.Id, new()
        {
            Name = "Usage evidence", Type = FlightEventType.ModelCall, Model = "test-model",
            InputTokens = 20, OutputTokens = 10, EstimatedCost = 0.001m, CostBasis = "Synthetic USD test prices.",
            Input = "Do not retain this content",
            Attributes = new()
            {
                ["sdk.usageEvent"] = "assistant.usage", ["sdk.cacheReadCount"] = "5",
                ["sdk.cacheWriteCount"] = "0", ["unrelated"] = "Do not retain this attribute"
            }
        })!;
        Assert.Null(evt.Input);
        Assert.Equal("5", evt.Attributes!["sdk.cacheReadCount"]);
        Assert.Equal("0", evt.Attributes["sdk.cacheWriteCount"]);
        Assert.False(evt.Attributes.ContainsKey("unrelated"));
        Assert.NotNull(evt.CostBasis);
    }

    [Fact]
    public void Stored_legacy_zeros_are_ambiguous_while_new_explicit_zeros_survive_restart()
    {
        var directory = Directory.CreateTempSubdirectory("flightrecorder-usage-test-").FullName;
        try
        {
            var options = new TraceStorageOptions { DataDirectory = directory };
            FlightRecorderService Service() => new(store: new SqliteTraceRunStore(options));
            var service = Service();
            var run = Start(service);
            service.RecordEvent(run.Id, new()
            {
                Name = "Legacy zero", Type = FlightEventType.ModelCall, InputTokens = 0, OutputTokens = 0
            });
            service.RecordEvent(run.Id, new()
            {
                Name = "Legacy positive", Type = FlightEventType.ModelCall, InputTokens = 10, OutputTokens = 2,
                Model = "test", EstimatedCost = 0.1m, CostBasis = "Synthetic USD test pricing."
            });
            service.RecordEvent(run.Id, new()
            {
                Name = "New explicit zero", Type = FlightEventType.ModelCall, Model = "test",
                InputTokens = 0, OutputTokens = 0, EstimatedCost = 0, CostBasis = "Synthetic USD test pricing."
            });
            service.RecordEvent(run.Id, new() { Name = "New unknown", Type = FlightEventType.ModelCall });
            using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(directory, "traces.db"), Pooling = false
            }.ToString()))
            {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "SELECT payload_json FROM runs WHERE id=$id";
                command.Parameters.AddWithValue("$id", run.Id.ToString("D"));
                var document = JsonNode.Parse((string)command.ExecuteScalar()!)!;
                foreach (var evt in document["Events"]!.AsArray().Take(2))
                {
                    evt!.AsObject().Remove("UsageSchemaVersion");
                    evt.AsObject().Remove("CostBasis");
                }
                document["Events"]![0]!["EstimatedCost"] = 0;
                command.CommandText = "UPDATE runs SET payload_json=$payload WHERE id=$id";
                command.Parameters.AddWithValue("$payload", document.ToJsonString());
                command.ExecuteNonQuery();
            }
            var loaded = Service().GetRun(run.Id)!;
            Assert.Null(loaded.Events[0].InputTokens);
            Assert.Null(loaded.Events[0].OutputTokens);
            Assert.Null(loaded.Events[0].EstimatedCost);
            Assert.Null(loaded.Events[0].UsageSchemaVersion);
            Assert.Equal(10, loaded.Events[1].InputTokens);
            Assert.Equal(0.1m, loaded.Events[1].EstimatedCost);
            Assert.Null(loaded.Events[1].CostBasis);
            Assert.False(loaded.Usage.CostComplete);
            Assert.Equal(0, loaded.Events[2].InputTokens);
            Assert.Equal(0, loaded.Events[2].EstimatedCost);
            Assert.Equal(1, loaded.Events[2].UsageSchemaVersion);
            Assert.Null(loaded.Events[3].InputTokens);
            Assert.Equal(1, loaded.Events[3].UsageSchemaVersion);
            service = Service();
            service.RecordEvent(run.Id, new() { Name = "Subsequent event" });
            Assert.Equal(JsonSerializer.Serialize(service.GetRun(run.Id)), JsonSerializer.Serialize(Service().GetRun(run.Id)));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}
