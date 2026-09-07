namespace FlightRecorder.Api.Tests;

internal static class TestDirectory
{
    public static void Delete(string directory)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
                return;
            }
            // Workspace watchers can briefly retain a directory handle after SQLite closes.
            catch (IOException) when (OperatingSystem.IsWindows() && attempt < 3)
            {
                Thread.Sleep(100 * (attempt + 1));
            }
        }
    }
}
