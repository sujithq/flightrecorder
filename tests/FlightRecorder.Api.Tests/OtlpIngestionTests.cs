using System.Net;
using System.Net.Http.Json;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;

namespace FlightRecorder.Api.Tests;

public sealed class OtlpIngestionTests : IClassFixture<FlightRecorderApiFactory>
{
    private readonly HttpClient client;
    public OtlpIngestionTests(FlightRecorderApiFactory factory) => client = factory.CreateClient();

    [Fact]
    public async Task Imports_measured_genai_span_once_with_task_and_chat_attribution()
    {
        using var started = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
        {
            Request = "OTLP ingestion", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        var run = (await started.Content.ReadFromJsonAsync<TraceRun>())!;
        var taskId = Guid.NewGuid();
        var payload = Payload(run.Id, taskId);

        using var first = await client.PostAsJsonAsync("/v1/traces", payload);
        using var retry = await client.PostAsJsonAsync("/v1/traces", payload);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        var trace = await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}");
        var modelCall = Assert.Single(trace!.Events);
        Assert.Equal(FlightEventType.ModelCall, modelCall.Type);
        Assert.Equal("chat", modelCall.Name);
        Assert.Equal("gpt-test", modelCall.Model);
        Assert.Equal(12, modelCall.InputTokens);
        Assert.Equal(3, modelCall.OutputTokens);
        Assert.Equal(0.00015m, modelCall.EstimatedCost);
        Assert.Equal("Synthetic price table 2026-09-08", modelCall.CostBasis);
        Assert.Equal(taskId, modelCall.TaskId);
        Assert.Equal("session-1", modelCall.ChatSessionId);
        Assert.Equal("turn-1", modelCall.ChatTurnId);
        Assert.Equal("0123456789abcdef0123456789abcdef", modelCall.TraceId);
        Assert.Equal("0123456789abcdef", modelCall.SpanId);
    }

    [Fact]
    public async Task Rejects_measured_span_without_run_attribution()
    {
        using var response = await client.PostAsJsonAsync("/v1/traces", Payload(null, Guid.NewGuid()));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Rejects_malformed_attribute_value_as_bad_request()
    {
        var payload = new
        {
            resourceSpans = new[] { new { scopeSpans = new[] { new { spans = new[] { new
            {
                traceId = "0123456789abcdef0123456789abcdef", spanId = "0123456789abcdef",
                attributes = new[] { new { key = "gen_ai.usage.input_tokens", value = "invalid" } }
            } } } } } }
        };
        using var response = await client.PostAsJsonAsync("/v1/traces", payload);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Imports_numeric_error_status_and_rolls_back_an_invalid_batch()
    {
        using var started = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
        {
            Request = "OTLP atomicity", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        var run = (await started.Content.ReadFromJsonAsync<TraceRun>())!;
        var first = Span(Guid.NewGuid(), status: 2);
        var invalid = Span(Guid.NewGuid(), parentEventId: Guid.NewGuid());
        var payload = new { resourceSpans = new[] { Resource(run.Id, first, invalid) } };

        using var rejected = await client.PostAsJsonAsync("/v1/traces", payload);

        Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}"))!.Events);

        using var accepted = await client.PostAsJsonAsync("/v1/traces",
            new { resourceSpans = new[] { Resource(run.Id, first) } });
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        Assert.Equal(FlightEventStatus.Failed,
            Assert.Single((await client.GetFromJsonAsync<TraceRun>($"/api/runs/{run.Id}"))!.Events).Status);
    }

    [Fact]
    public async Task Rejects_cross_run_batches_without_mutating_either_run()
    {
        using var firstStarted = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
        {
            Request = "First OTLP run", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        using var secondStarted = await client.PostAsJsonAsync("/api/runs", new StartRunRequest
        {
            Request = "Second OTLP run", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        var firstRun = (await firstStarted.Content.ReadFromJsonAsync<TraceRun>())!;
        var secondRun = (await secondStarted.Content.ReadFromJsonAsync<TraceRun>())!;
        var payload = new
        {
            resourceSpans = new[]
            {
                Resource(firstRun.Id, Span(Guid.NewGuid())),
                Resource(secondRun.Id, Span(Guid.NewGuid()))
            }
        };

        using var response = await client.PostAsJsonAsync("/v1/traces", payload);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<TraceRun>($"/api/runs/{firstRun.Id}"))!.Events);
        Assert.Empty((await client.GetFromJsonAsync<TraceRun>($"/api/runs/{secondRun.Id}"))!.Events);
    }

    [Fact]
    public void RecordEvents_rolls_back_in_memory_and_RecordEvent_keeps_single_event_behavior()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "Service atomicity", EntryPointAgent = "test", RequestingIdentity = "test"
        });
        var single = service.RecordEvent(run.Id, new RecordEventRequest { Name = "Existing event" });
        var before = service.GetRun(run.Id);

        Assert.NotNull(single);
        Assert.Throws<ArgumentException>(() => service.RecordEvents(run.Id,
        [
            new RecordEventRequest { Name = "Tentative event" },
            new RecordEventRequest { Name = "Invalid event", ParentEventId = Guid.NewGuid() }
        ]));

        var after = service.GetRun(run.Id);
        Assert.Same(before, after);
        Assert.Equal(single.Id, Assert.Single(after!.Events).Id);
    }

    private static object Payload(Guid? runId, Guid taskId) => new
    {
        resourceSpans = new[]
        {
            new
            {
                resource = new { attributes = runId is null ? Array.Empty<object>() : new[] { Attribute("flightrecorder.run.id", runId.ToString()!) } },
                scopeSpans = new[]
                {
                    new
                    {
                        spans = new[]
                        {
                            new
                            {
                                traceId = "0123456789abcdef0123456789abcdef",
                                spanId = "0123456789abcdef",
                                name = "chat",
                                startTimeUnixNano = "1757318400000000000",
                                endTimeUnixNano = "1757318401000000000",
                                attributes = new[]
                                {
                                    Attribute("gen_ai.request.model", "gpt-test"),
                                    Attribute("gen_ai.usage.input_tokens", 12),
                                    Attribute("gen_ai.usage.output_tokens", 3),
                                    Attribute("flightrecorder.estimated_cost", 0.00015),
                                    Attribute("flightrecorder.cost_basis", "Synthetic price table 2026-09-08"),
                                    Attribute("flightrecorder.task.id", taskId.ToString()),
                                    Attribute("flightrecorder.chat.session_id", "session-1"),
                                    Attribute("flightrecorder.chat.turn_id", "turn-1")
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    private static object Attribute(string key, string value) => new { key, value = new { stringValue = value } };
    private static object Attribute(string key, long value) => new { key, value = new { intValue = value.ToString() } };
    private static object Attribute(string key, double value) => new { key, value = new { doubleValue = value } };

    private static object Resource(Guid runId, params object[] spans) => new
    {
        resource = new { attributes = new[] { Attribute("flightrecorder.run.id", runId.ToString()) } },
        scopeSpans = new[] { new { spans } }
    };

    private static object Span(Guid id, int? status = null, Guid? parentEventId = null) => new
    {
        traceId = "fedcba9876543210fedcba9876543210",
        spanId = id.ToString("N")[..16],
        name = "chat",
        status = status.HasValue ? new { code = status.Value } : null,
        attributes = new object[]
        {
            Attribute("gen_ai.usage.input_tokens", 1),
            Attribute("gen_ai.usage.output_tokens", 1),
            Attribute("flightrecorder.event.parent_id", parentEventId?.ToString() ?? Guid.Empty.ToString())
        }.Where((_, index) => index < 2 || parentEventId.HasValue).ToArray()
    };
}