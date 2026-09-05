using FlightRecorder.Api.Services;
using FlightRecorder.Api.Tools;
using ModelContextProtocol.Server;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddSingleton<IFlightRecorderService, InMemoryFlightRecorderService>();
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
app.MapControllers();
app.MapMcp("/mcp");
app.Run();

public partial class Program { }
