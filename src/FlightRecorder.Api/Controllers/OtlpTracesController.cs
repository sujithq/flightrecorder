using System.Globalization;
using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace FlightRecorder.Api.Controllers;

[ApiController]
[Route("v1/traces")]
public sealed class OtlpTracesController(IFlightRecorderService recorder) : ControllerBase
{
    private const int MaximumRequestBytes = 4 * 1024 * 1024;

    [HttpPost]
    [RequestSizeLimit(MaximumRequestBytes)]
    public IActionResult Export(JsonElement payload)
    {
        try
        {
            var events = Parse(payload);
            if (events.Any(item => recorder.GetRun(item.RunId) is not { EndedAt: null })) return NotFound();
            foreach (var item in events)
                Validator.ValidateObject(item.Request, new ValidationContext(item.Request), true);
            foreach (var item in events) recorder.RecordEvent(item.RunId, item.Request);
            return Ok(new { });
        }
        catch (Exception error) when (error is ArgumentException or FormatException or InvalidOperationException or
            JsonException or OverflowException or ValidationException)
        {
            return Problem(statusCode: 400, title: "Invalid OTLP trace payload", detail: error.Message);
        }
        catch (UsageImportConflictException error)
        {
            return Problem(statusCode: 409, title: "Conflicting usage source", detail: error.Message);
        }
    }

    private static IReadOnlyList<(Guid RunId, RecordEventRequest Request)> Parse(JsonElement payload)
    {
        var result = new List<(Guid, RecordEventRequest)>();
        foreach (var resourceSpan in Array(payload, "resourceSpans"))
        {
            var resourceAttributes = Attributes(Property(resourceSpan, "resource"));
            foreach (var scopeSpan in Array(resourceSpan, "scopeSpans"))
            foreach (var span in Array(scopeSpan, "spans"))
            {
                var attributes = new Dictionary<string, JsonElement>(resourceAttributes, StringComparer.Ordinal);
                foreach (var attribute in Attributes(span)) attributes[attribute.Key] = attribute.Value;
                var inputTokens = Integer(attributes, "gen_ai.usage.input_tokens");
                var outputTokens = Integer(attributes, "gen_ai.usage.output_tokens");
                if (inputTokens is null && outputTokens is null) continue;
                if (!Guid.TryParse(Text(attributes, "flightrecorder.run.id"), out var runId))
                    throw new ArgumentException("A measured GenAI span requires a valid flightrecorder.run.id attribute.");
                var traceId = RequiredHex(span, "traceId", 32);
                var spanId = RequiredHex(span, "spanId", 16);
                result.Add((runId, new RecordEventRequest
                {
                    Name = Text(attributes, "gen_ai.operation.name") ?? Text(span, "name") ?? "OTLP model call",
                    Type = FlightEventType.ModelCall,
                    StartedAt = Timestamp(span, "startTimeUnixNano") ?? DateTimeOffset.UtcNow,
                    EndedAt = Timestamp(span, "endTimeUnixNano"),
                    Status = Status(span),
                    AgentName = Text(attributes, "gen_ai.agent.name"),
                    Model = Text(attributes, "gen_ai.request.model") ?? Text(attributes, "gen_ai.response.model"),
                    InputTokens = inputTokens,
                    OutputTokens = outputTokens,
                    EstimatedCost = Decimal(attributes, "flightrecorder.estimated_cost"),
                    CostBasis = Text(attributes, "flightrecorder.cost_basis"),
                    TaskId = Identifier(attributes, "flightrecorder.task.id"),
                    ParentTaskId = Identifier(attributes, "flightrecorder.task.parent_id"),
                    ChatSessionId = Text(attributes, "flightrecorder.chat.session_id"),
                    ChatTurnId = Text(attributes, "flightrecorder.chat.turn_id"),
                    SubagentSessionId = Text(attributes, "flightrecorder.subagent.session_id"),
                    TraceId = traceId,
                    SpanId = spanId,
                    ReportedAiCredits = Decimal(attributes, "gen_ai.usage.ai_credits"),
                    EstimatedAiCredits = Decimal(attributes, "flightrecorder.usage.estimated_ai_credits"),
                    Attributes = new() { ["flightrecorder.ingest.source"] = "otlp" }
                }));
            }
        }
        return result;
    }

    private static IEnumerable<JsonElement> Array(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray() : [];

    private static JsonElement Property(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;

    private static Dictionary<string, JsonElement> Attributes(JsonElement element)
    {
        var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var attribute in Array(element, "attributes"))
            if (attribute.TryGetProperty("key", out var key) && key.ValueKind == JsonValueKind.String &&
                attribute.TryGetProperty("value", out var value)) result[key.GetString()!] = value;
        return result;
    }

    private static string? Text(IReadOnlyDictionary<string, JsonElement> attributes, string name)
        => attributes.TryGetValue(name, out var value) ? Text(value, "stringValue") : null;

    private static string? Text(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;

    private static int? Integer(IReadOnlyDictionary<string, JsonElement> attributes, string name)
    {
        if (!attributes.TryGetValue(name, out var value) || !value.TryGetProperty("intValue", out var number)) return null;
        var parsed = number.ValueKind == JsonValueKind.String
            ? long.Parse(number.GetString()!, NumberStyles.None, CultureInfo.InvariantCulture)
            : number.GetInt64();
        return checked((int)parsed);
    }

    private static decimal? Decimal(IReadOnlyDictionary<string, JsonElement> attributes, string name)
    {
        if (!attributes.TryGetValue(name, out var value)) return null;
        if (value.TryGetProperty("doubleValue", out var number)) return number.GetDecimal();
        if (value.TryGetProperty("intValue", out number))
            return number.ValueKind == JsonValueKind.String
                ? decimal.Parse(number.GetString()!, NumberStyles.Number, CultureInfo.InvariantCulture)
                : number.GetDecimal();
        return null;
    }

    private static Guid? Identifier(IReadOnlyDictionary<string, JsonElement> attributes, string name)
        => Guid.TryParse(Text(attributes, name), out var value) ? value : null;

    private static string RequiredHex(JsonElement element, string name, int length)
    {
        var value = Text(element, name);
        if (value is null || value.Length != length || value.Any(character => !Uri.IsHexDigit(character)))
            throw new ArgumentException($"OTLP {name} must contain {length} hexadecimal characters.");
        return value.ToLowerInvariant();
    }

    private static DateTimeOffset? Timestamp(JsonElement span, string name)
    {
        var text = Text(span, name);
        if (text is null) return null;
        return DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(text, CultureInfo.InvariantCulture) / 1_000_000);
    }

    private static FlightEventStatus Status(JsonElement span)
    {
        var status = Property(span, "status");
        var code = Text(status, "code");
        return code == "STATUS_CODE_ERROR" || code == "2" ? FlightEventStatus.Failed : FlightEventStatus.Succeeded;
    }
}