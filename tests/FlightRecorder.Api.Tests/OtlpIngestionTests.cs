using System.Net;
using System.Net.Http.Json;
using FlightRecorder.Api.Models;

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
}