using System.Net.Http.Json;

namespace FlightRecorder.Api.Tests;

public sealed class McpEndpointTests : IClassFixture<FlightRecorderApiFactory>
{
    private readonly HttpClient client;

    public McpEndpointTests(FlightRecorderApiFactory factory)
    {
        client = factory.CreateClient();
    }

    [Fact]
    public async Task Lists_flight_recorder_tools_over_streamable_http()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mcp")
        {
            Content = JsonContent.Create(new
            {
                jsonrpc = "2.0",
                id = 1,
                method = "tools/list",
                @params = new { }
            })
        };
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        request.Headers.Add("MCP-Protocol-Version", "2025-11-25");

        using var response = await client.SendAsync(request);
        var payload = await response.Content.ReadAsStringAsync();

        response.EnsureSuccessStatusCode();
        Assert.Contains("start_flight_run", payload);
        Assert.Contains("record_flight_event", payload);
        Assert.Contains("complete_flight_run", payload);
        Assert.Contains("get_flight_trace", payload);
        Assert.Contains("analyze_flight_run", payload);
        Assert.Contains("list_flight_runs", payload);
        Assert.Contains("start_flight_task", payload);
        Assert.Contains("start_flight_subtask", payload);
        Assert.Contains("complete_current_flight_task", payload);
        Assert.Contains("assign_current_chat_turn_to_flight_task", payload);
        Assert.Contains("show_flight_task_usage", payload);
    }
}
