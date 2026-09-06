namespace FlightRecorder.Api.Services;

public sealed class TraceStorageException() : Exception(
    "Trace storage is unavailable. Check the configured data directory, permissions, free space and database compatibility.");