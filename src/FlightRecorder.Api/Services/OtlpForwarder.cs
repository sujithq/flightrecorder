using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace FlightRecorder.Api.Services;

public sealed class OtlpForwarder(HttpClient client, IConfiguration configuration)
{
    public async Task SendAsync(JsonObject payload, CancellationToken cancellationToken)
    {
        var endpoint = configuration["FlightRecorder:OtlpEndpoint"];
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var address) ||
            (address.Scheme != "https" && !(address.Scheme == "http" && address.IsLoopback)))
            throw new InvalidOperationException("Configure FlightRecorder:OtlpEndpoint with an HTTPS or loopback HTTP /v1/traces endpoint.");
        using var request = new HttpRequestMessage(HttpMethod.Post, address) { Content = JsonContent.Create(payload) };
        using var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength != 0)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!string.IsNullOrWhiteSpace(body) && JsonNode.Parse(body)?["partialSuccess"] is JsonObject partial &&
                (partial["rejectedSpans"]?.ToString() is { } rejected && rejected != "0" ||
                 !string.IsNullOrEmpty(partial["errorMessage"]?.ToString())))
                throw new HttpRequestException("The collector reported a partial export failure.");
        }
    }
}