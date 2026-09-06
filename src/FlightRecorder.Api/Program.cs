using FlightRecorder.Api.Services;
using FlightRecorder.Api.Tools;
using ModelContextProtocol.Server;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddSingleton(new TraceRedactor(builder.Configuration.GetSection("FlightRecorder:RedactionPatterns").Get<string[]>()));
builder.Services.AddSingleton<IFlightRecorderService, InMemoryFlightRecorderService>();
builder.Services.AddSingleton<TraceExportService>();
builder.Services.AddHttpClient<OtlpForwarder>(client => client.Timeout = TimeSpan.FromSeconds(10))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services
    .AddMcpServer(options =>
    {
        options.ServerInfo = new()
        {
            Name = "flightrecorder",
            Version = "1.0.0",
            Title = "Agent Flight Recorder",
            Description = "Record and analyze agent workflow traces, usage, policy decisions, and evidence."
        };
    })
    .WithHttpTransport()
    .WithTools<FlightRecorderMcpTools>();

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapControllers();
app.MapMcp("/mcp");
app.Run();

public partial class Program { }
