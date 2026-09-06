using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;

namespace FlightRecorder.Api.Tests;

public sealed class RecorderInfoTests : IClassFixture<FlightRecorderApiFactory>
{
    private readonly FlightRecorderApiFactory factory;
    public RecorderInfoTests(FlightRecorderApiFactory factory) => this.factory = factory;

    [Theory]
    [InlineData("1.0.0")]
    [InlineData("0.3.0")]
    [InlineData("1.1.0-rc.1+abc")]
    public async Task Reports_only_the_running_deployments_release_version(string version)
    {
        using var configured = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["FlightRecorder:ReleaseVersion"] = version })));
        using var client = configured.CreateClient();
        using var response = await client.GetAsync("/api/info");
        response.EnsureSuccessStatusCode();
        var info = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Single(info);
        Assert.Equal(version, info["version"]!.GetValue<string>());
        Assert.True(response.Headers.CacheControl?.NoStore);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task Unversioned_build_does_not_claim_the_default_assembly_or_VSIX_version(string? version)
    {
        using var configured = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["FlightRecorder:ReleaseVersion"] = version })));
        using var client = configured.CreateClient();
        var info = (await client.GetFromJsonAsync<JsonObject>("/api/info"))!;
        Assert.True(info.ContainsKey("version"));
        Assert.Null(info["version"]);
    }

    [Theory]
    [InlineData("<script>invalid-version</script>")]
    [InlineData("01.0.0")]
    [InlineData("not-a-version")]
    public async Task Invalid_metadata_is_reported_without_echoing_configuration(string version)
    {
        using var configured = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["FlightRecorder:ReleaseVersion"] = version })));
        using var client = configured.CreateClient();
        using var response = await client.GetAsync("/api/info");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("version metadata is invalid", body);
        Assert.DoesNotContain(version, body);
        using var runs = await client.GetAsync("/api/runs");
        runs.EnsureSuccessStatusCode();
    }
}
