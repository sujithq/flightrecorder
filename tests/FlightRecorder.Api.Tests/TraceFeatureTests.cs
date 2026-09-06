using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.Extensions.Configuration;

namespace FlightRecorder.Api.Tests;

public sealed class TraceFeatureTests : IClassFixture<FlightRecorderApiFactory>
{
    private readonly HttpClient client;

    public TraceFeatureTests(FlightRecorderApiFactory factory)
    {
        client = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((context, configuration) =>
            configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["FlightRecorder:EnableDemo"] = "true" }))).CreateClient();
    }

    private async Task<TraceRun> Demo(string scenario = "blocked")
    {
        using var response = await client.PostAsJsonAsync("/api/demo/runs", new { scenario });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<TraceRun>())!;
    }

    [Fact]
    public async Task Graph_preserves_hierarchy_and_identity_transitions()
    {
        var run = await Demo();
        var graph = (await client.GetFromJsonAsync<TraceGraph>($"/api/runs/{run.Id}/graph"))!;
        Assert.Equal(run.Events.Count + 1, graph.Nodes.Count);
        Assert.Equal(run.Events.Count, graph.Edges.Count);
        var coding = run.Events.Single(evt => evt.Name == "Prepare fix");
        var edge = graph.Edges.Single(edge => edge.TargetId == coding.Id);
        Assert.Equal(coding.ParentEventId, edge.SourceId);
        Assert.True(edge.IdentityChanged);
        Assert.Equal(coding.Objective, edge.Objective);
    }

    [Fact]
    public async Task Comparison_matches_events_across_runs_and_reports_policy_and_cost_changes()
    {
        var baseline = await Demo();
        var candidate = await Demo("approved");
        var comparison = (await client.GetFromJsonAsync<TraceComparison>($"/api/runs/{baseline.Id}/compare/{candidate.Id}"))!;
        Assert.Equal(baseline.Events.Count, comparison.Events.Count);
        Assert.All(comparison.Events, evt => Assert.NotNull(evt.Baseline));
        Assert.True(comparison.Delta.EstimatedCost < 0);
        Assert.Equal(-1, comparison.Delta.PolicyInterventions);
        var policy = comparison.Events.Single(evt => evt.Baseline!.Type == FlightEventType.PolicyDecision);
        Assert.Contains("Status", policy.ChangedFields);
        Assert.Contains("GrantedScope", policy.ChangedFields);
    }

    [Fact]
    public void Comparison_handles_duplicate_operations_added_removed_and_empty_traces()
    {
        var service = new FlightRecorderService();
        TraceRun Start() => service.StartRun(new StartRunRequest { Request = "test", EntryPointAgent = "agent", RequestingIdentity = "test" });
        var baseline = Start();
        var candidate = Start();
        Assert.Empty(TraceViewService.Compare(baseline, candidate).Events);
        foreach (var run in new[] { baseline, candidate })
        {
            service.RecordEvent(run.Id, new RecordEventRequest { Name = "retry", InputTokens = 10 });
            service.RecordEvent(run.Id, new RecordEventRequest { Name = "retry", InputTokens = 20 });
        }
        service.RecordEvent(baseline.Id, new RecordEventRequest { Name = "removed" });
        service.RecordEvent(candidate.Id, new RecordEventRequest { Name = "added" });
        var result = TraceViewService.Compare(service.GetRun(baseline.Id)!, service.GetRun(candidate.Id)!);
        Assert.Equal(2, result.Events.Count(evt => evt.Change == "Unchanged"));
        Assert.Single(result.Events, evt => evt.Change == "Added");
        Assert.Single(result.Events, evt => evt.Change == "Removed");
    }

    [Fact]
    public async Task Otlp_download_has_valid_wire_ids_timestamps_attributes_and_parent_spans()
    {
        var run = await Demo();
        using var response = await client.GetAsync($"/api/runs/{run.Id}/exports/otlp");
        response.EnsureSuccessStatusCode();
        Assert.Contains(".otlp.json", response.Content.Headers.ContentDisposition!.FileName);
        var document = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        var spans = document["resourceSpans"]![0]!["scopeSpans"]![0]!["spans"]!.AsArray();
        Assert.Equal(run.Events.Count + 1, spans.Count);
        Assert.All(spans, span =>
        {
            Assert.Matches("^[a-f0-9]{32}$", span!["traceId"]!.GetValue<string>());
            Assert.Matches("^[a-f0-9]{16}$", span["spanId"]!.GetValue<string>());
            Assert.True(ulong.Parse(span["endTimeUnixNano"]!.GetValue<string>()) >= ulong.Parse(span["startTimeUnixNano"]!.GetValue<string>()));
        });
        var firstChild = spans[1]!;
        Assert.Equal(spans[0]!["spanId"]!.GetValue<string>(), firstChild["parentSpanId"]!.GetValue<string>());
        Assert.Equal(2, spans.Last()!["status"]!["code"]!.GetValue<int>());
    }

    [Fact]
    public async Task GitHub_payload_is_evidence_linked_and_marks_policy_blocks_as_action_required()
    {
        var run = await Demo();
        var check = (await client.GetFromJsonAsync<JsonObject>($"/api/runs/{run.Id}/exports/github"))!;
        Assert.Equal("completed", check["status"]!.GetValue<string>());
        Assert.Equal("action_required", check["conclusion"]!.GetValue<string>());
        Assert.Contains(run.Events.Last().Id.ToString(), check["output"]!["text"]!.GetValue<string>());
        Assert.Contains("pull\\_requests:write", check["output"]!["text"]!.GetValue<string>());
        Assert.DoesNotContain("head_sha", check.ToJsonString());
    }

    [Fact]
    public void GitHub_output_respects_byte_limits_and_preserves_viewer_links()
    {
        var startedAt = DateTimeOffset.UtcNow;
        var runId = Guid.NewGuid();
        var longMetadata = new string('\u4e00', 400);
        var events = Enumerable.Range(0, 50).Select(index => new FlightEvent(
            Guid.NewGuid(), runId, FlightEventType.PolicyDecision, $"Policy {index}",
            startedAt, startedAt.AddSeconds(1), FlightEventStatus.Blocked,
            Identity: longMetadata, RequestedScope: longMetadata, GrantedScope: longMetadata,
            PolicyName: longMetadata, PolicyReason: longMetadata)).ToArray();
        var run = new TraceRun(runId, "synthetic trace", "test-agent", "test-identity",
            RecordingMode.Redacted, startedAt, startedAt.AddSeconds(1), events);
        var check = new TraceExportService(new TraceRedactor()).GitHubCheck(run, new Uri("https://recorder.example/"));
        var text = check["output"]!["text"]!.GetValue<string>();
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(text) <= 65_535);
        Assert.Contains("Showing ", text);
        Assert.Contains($"https://recorder.example/?run={runId}&event={events[0].Id}", text);
        Assert.Equal($"https://recorder.example/?run={runId}", check["details_url"]!.GetValue<string>());
    }

    [Fact]
    public void Exports_omit_bodies_and_redact_full_mode_metadata()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "synthetic private request", EntryPointAgent = "fixture@example.invalid",
            RequestingIdentity = "fixture@example.invalid", RecordingMode = RecordingMode.Full
        });
        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "token=synthetic-secret", Input = "synthetic input body", Output = "synthetic output body",
            Identity = "fixture@example.invalid", Attributes = new() { ["secret"] = "synthetic-attribute" }
        });
        var exports = new TraceExportService(new TraceRedactor());
        var stored = service.GetRun(run.Id)!;
        var payload = exports.Otlp(stored).ToJsonString() + exports.GitHubCheck(stored).ToJsonString()
            + System.Text.Json.JsonSerializer.Serialize(exports.Badge(stored));
        Assert.DoesNotContain("synthetic", payload);
        Assert.DoesNotContain("fixture@example.invalid", payload);
        Assert.DoesNotContain("conclusion", exports.GitHubCheck(stored).ToJsonString());
    }

    [Fact]
    public async Task Badge_endpoint_returns_only_the_versioned_compact_contract()
    {
        var run = await Demo();
        var badge = (await client.GetFromJsonAsync<BadgeSummary>($"/api/runs/{run.Id}/badge"))!;
        Assert.Equal(2, badge.Version);
        Assert.Equal("Blocked", badge.Status);
        Assert.Equal(run.Events.Count, badge.EventCount);
        Assert.True(badge.Alert!.Length <= 64);
        Assert.Equal(run.Id.ToString(), badge.RunId);
    }

    [Theory]
    [InlineData("graph")]
    [InlineData("exports/otlp")]
    [InlineData("exports/github")]
    [InlineData("badge")]
    public async Task Unknown_traces_return_not_found(string path)
        => Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/runs/{Guid.NewGuid()}/{path}")).StatusCode);

    [Fact]
    public async Task Foreign_parent_returns_bad_request_and_unconfigured_export_returns_unavailable()
    {
        var run = await Demo();
        using var invalid = await client.PostAsJsonAsync($"/api/runs/{run.Id}/events",
            new RecordEventRequest { Name = "invalid", ParentEventId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using var export = await client.PostAsync($"/api/runs/{run.Id}/exports/otlp", null);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, export.StatusCode);
    }

    [Fact]
    public async Task Otlp_forwarder_posts_json_and_detects_partial_success()
    {
        var handler = new CollectorHandler();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FlightRecorder:OtlpEndpoint"] = "http://localhost:4318/v1/traces"
        }).Build();
        var exporter = new OtlpForwarder(new HttpClient(handler), configuration);
        await exporter.SendAsync(new JsonObject { ["resourceSpans"] = new JsonArray() }, CancellationToken.None);
        Assert.Equal("application/json", handler.ContentType);
        Assert.Equal("/v1/traces", handler.Path);
        handler.PartialFailure = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => exporter.SendAsync(new JsonObject(), CancellationToken.None));
    }

    private sealed class CollectorHandler : HttpMessageHandler
    {
        public string? ContentType { get; private set; }
        public string? Path { get; private set; }
        public bool PartialFailure { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            ContentType = request.Content!.Headers.ContentType!.MediaType;
            Path = request.RequestUri!.AbsolutePath;
            Assert.Equal(HttpMethod.Post, request.Method);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(PartialFailure ? "{\"partialSuccess\":{\"rejectedSpans\":\"1\"}}" : "{}")
            });
        }
    }
}