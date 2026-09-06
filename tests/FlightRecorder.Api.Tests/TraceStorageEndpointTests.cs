using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FlightRecorder.Api.Tests;

public sealed class TraceStorageEndpointTests
{
    private static void Sql(FlightRecorderApiFactory factory, string sql)
    {
        var options = factory.Services.GetRequiredService<TraceStorageOptions>();
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(options.ResolveDataDirectory(), "traces.db"), Pooling = false,
            Mode = SqliteOpenMode.ReadWrite
        }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    [Fact]
    public async Task Runtime_uses_sqlite_and_all_REST_mutations_surface_storage_failures()
    {
        using var factory = new FlightRecorderApiFactory();
        using var client = factory.CreateClient();
        Assert.IsType<SqliteTraceRunStore>(factory.Services.GetRequiredService<ITraceRunStore>());
        var request = new StartRunRequest { Request = "synthetic-private-request", EntryPointAgent = "agent", RequestingIdentity = "identity" };
        using var started = await client.PostAsJsonAsync("/api/runs", request);
        var run = (await started.Content.ReadFromJsonAsync<TraceRun>())!;
        Sql(factory, "CREATE TRIGGER reject_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-private-failure'); END;");
        using var recorded = await client.PostAsJsonAsync($"/api/runs/{run.Id}/events", new RecordEventRequest { Name = "synthetic-private-event" });
        using var completed = await client.PostAsync($"/api/runs/{run.Id}/complete", null);
        Sql(factory, "CREATE TRIGGER reject_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-private-failure'); END;");
        using var another = await client.PostAsJsonAsync("/api/runs", request);
        foreach (var response in new[] { recorded, completed, another })
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            var body = await response.Content.ReadAsStringAsync();
            Assert.Contains("Trace storage is unavailable", body);
            Assert.DoesNotContain("synthetic-private", body);
            Assert.DoesNotContain("traces.db", body);
        }
        var unchanged = (await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}"))!;
        Assert.Empty(unchanged.Events);
        Assert.Null(unchanged.EndedAt);
        Assert.Single((await client.GetFromJsonAsync<RunSummary[]>("/api/runs"))!);
    }

    [Fact]
    public async Task MCP_storage_failure_is_a_failed_tool_call_without_sensitive_details()
    {
        using var factory = new FlightRecorderApiFactory();
        using var client = factory.CreateClient();
        Sql(factory, "CREATE TRIGGER reject_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-private-failure'); END;");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mcp")
        {
            Content = JsonContent.Create(new
            {
                jsonrpc = "2.0", id = 1, method = "tools/call",
                @params = new { name = "start_flight_run", arguments = new
                {
                    request = "synthetic-private-request", entryPointAgent = "agent", requestingIdentity = "identity"
                } }
            })
        };
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        request.Headers.Add("MCP-Protocol-Version", "2025-11-25");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("synthetic-private", body);
        Assert.DoesNotContain("traces.db", body);
        var json = response.Content.Headers.ContentType?.MediaType == "text/event-stream"
            ? body.Split('\n').First(line => line.StartsWith("data:", StringComparison.Ordinal))[5..] : body;
        Assert.True(JsonNode.Parse(json)!["result"]!["isError"]!.GetValue<bool>());
        Assert.Empty(factory.Services.GetRequiredService<ITraceRunStore>().List());
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("invalid")]
    public void Invalid_retention_configuration_prevents_host_startup(string limit)
    {
        using var root = new FlightRecorderApiFactory();
        using var factory = root.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, configuration) =>
            configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["FlightRecorder:Storage:MaxCompletedRuns"] = limit })));
        Assert.Throws<InvalidOperationException>(() => factory.CreateClient());
    }

    [Fact]
    public async Task Pruned_runs_return_not_found_without_being_recreated()
    {
        using var root = new FlightRecorderApiFactory();
        using var factory = root.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, configuration) =>
            configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["FlightRecorder:Storage:MaxCompletedRuns"] = "1" })));
        using var client = factory.CreateClient();
        var recorder = factory.Services.GetRequiredService<IFlightRecorderService>();
        TraceRun Start() => recorder.StartRun(new StartRunRequest { Request = "Synthetic", EntryPointAgent = "agent", RequestingIdentity = "identity" });
        var first = Start();
        var second = Start();
        var completed = DateTimeOffset.UtcNow;
        recorder.CompleteRun(first.Id, completed);
        recorder.CompleteRun(second.Id, completed.AddSeconds(1));
        using var response = await client.GetAsync($"/api/runs/{first.Id}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        using var append = await client.PostAsJsonAsync($"/api/runs/{first.Id}/events", new RecordEventRequest { Name = "Too late" });
        Assert.Equal(HttpStatusCode.NotFound, append.StatusCode);
    }
}