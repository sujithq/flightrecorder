namespace FlightRecorder.Api.Services;

public sealed class TraceStorageOptions
{
    public string? DataDirectory { get; set; }
    public int MaxCompletedRuns { get; set; } = 10;

    public string ResolveDataDirectory()
    {
        if (MaxCompletedRuns <= 0)
            throw new InvalidOperationException("FlightRecorder:Storage:MaxCompletedRuns must be a positive integer.");
        var directory = DataDirectory;
        if (directory is null)
        {
            var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(localData))
                throw new InvalidOperationException("Configure FlightRecorder:Storage:DataDirectory with an absolute writable directory.");
            directory = Path.Combine(localData, "FlightRecorder");
        }
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory))
            throw new InvalidOperationException("FlightRecorder:Storage:DataDirectory must be an absolute writable directory.");
        try
        {
            return Path.GetFullPath(directory);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new InvalidOperationException("FlightRecorder:Storage:DataDirectory is invalid.");
        }
    }
}