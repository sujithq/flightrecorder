using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace FlightRecorder.Api.Tests;

public sealed class McpEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient client;

    public McpEndpointTests(WebApplicationFactory<Program> factory)
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
    }
}
