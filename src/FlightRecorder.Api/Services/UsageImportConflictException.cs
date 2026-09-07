namespace FlightRecorder.Api.Services;

public sealed class UsageImportConflictException(string message) : Exception(message);
