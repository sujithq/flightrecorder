using FlightRecorder.Api.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace FlightRecorder.Api.Controllers;

// Bound deserialization even when the host does not implement Kestrel's size-limit feature.
[AttributeUsage(AttributeTargets.Method)]
public sealed class UsageImportBodyLimitAttribute : Attribute, IAsyncResourceFilter
{
    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        var request = context.HttpContext.Request;
        if (request.ContentLength > UsageImportValidation.MaximumRequestBytes)
        {
            context.Result = TooLarge();
            return;
        }
        var original = request.Body;
        using var buffered = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await original.ReadAsync(buffer.AsMemory(0,
                (int)Math.Min(buffer.Length, UsageImportValidation.MaximumRequestBytes + 1 - buffered.Length)),
                context.HttpContext.RequestAborted);
            if (read == 0) break;
            buffered.Write(buffer, 0, read);
            if (buffered.Length > UsageImportValidation.MaximumRequestBytes)
            {
                context.Result = TooLarge();
                return;
            }
        }
        buffered.Position = 0;
        request.Body = buffered;
        try { await next(); }
        finally { request.Body = original; }
    }

    private static ObjectResult TooLarge() => new(new ProblemDetails
    {
        Status = StatusCodes.Status413PayloadTooLarge, Title = "Usage snapshot is too large",
        Detail = "Usage snapshot requests must not exceed 1 MiB."
    }) { StatusCode = StatusCodes.Status413PayloadTooLarge };
}
