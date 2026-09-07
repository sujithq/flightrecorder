using System.Collections.Concurrent;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace FlightRecorder.Api.Tests;

public sealed class FlightRecorderApiFactory : WebApplicationFactory<Program>
{
    private readonly ConcurrentBag<string> directories = [];

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var directory = Directory.CreateTempSubdirectory("flightrecorder-api-tests-").FullName;
        directories.Add(directory);
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
            new Dictionary<string, string?> { ["FlightRecorder:Storage:DataDirectory"] = directory }));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) CleanUp();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        CleanUp();
    }

    private void CleanUp()
    {
        while (directories.TryTake(out var directory)) TestDirectory.Delete(directory);
    }
}