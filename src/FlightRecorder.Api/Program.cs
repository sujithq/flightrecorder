using FlightRecorder.Api.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddSingleton<IFlightRecorderService, InMemoryFlightRecorderService>();

var app = builder.Build();
app.MapControllers();
app.Run();

public partial class Program { }
