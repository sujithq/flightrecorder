using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace FlightRecorder.Api.Services;

public sealed class TraceRedactor
{
    public const string Replacement = "[REDACTED]";
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(100);
    private static readonly Regex SecretKey = new(
        "password|passwd|pwd|secret|token|apikey|authorization|connectionstring|accountkey|cookie|credential",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, Timeout);
    private static readonly Regex Assignments = new(
        "\\b(password|passwd|pwd|token|secret|api[_-]?key|accountkey|sharedaccesssignature|connectionstring)(\\s*[:=]\\s*)(?:\"[^\"]*\"|'[^']*'|[^\\s,;]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, Timeout);
    private readonly Regex[] patterns;

    public TraceRedactor(IEnumerable<string>? additionalPatterns = null)
    {
        string[] builtInPatterns =
        [
            @"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+",
            @"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
            @"\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b",
            @"\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b",
            @"(?<!\w)(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\w)",
            @"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"
        ];
        patterns = builtInPatterns.Concat(additionalPatterns ?? [])
            .Select(pattern => new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.Compiled, Timeout))
            .ToArray();
    }

    public bool IsSecretKey(string key) => SecretKey.IsMatch(key.Replace("_", "").Replace("-", ""));

    public string? Redact(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return value;
        try
        {
            if (value.TrimStart().StartsWith('{') || value.TrimStart().StartsWith('['))
            {
                try
                {
                    var node = JsonNode.Parse(value);
                    SanitizeNode(node);
                    return node?.ToJsonString();
                }
                catch (JsonException) { }
            }
            return RedactText(value);
        }
        catch (RegexMatchTimeoutException)
        {
            return Replacement;
        }
    }

    private string RedactText(string value)
    {
        foreach (var pattern in patterns) value = pattern.Replace(value, Replacement);
        return Assignments.Replace(value, "$1$2" + Replacement);
    }

    private void SanitizeNode(JsonNode? node)
    {
        if (node is JsonObject objectNode)
        {
            foreach (var property in objectNode.ToArray())
            {
                var safeKey = RedactText(property.Key);
                if (safeKey != property.Key)
                {
                    objectNode.Remove(property.Key);
                    objectNode[safeKey] = property.Value;
                }
                if (IsSecretKey(property.Key)) objectNode[safeKey] = Replacement;
                else if (property.Value is JsonValue jsonValue && jsonValue.TryGetValue<string>(out var text))
                    objectNode[safeKey] = Redact(text);
                else SanitizeNode(property.Value);
            }
        }
        else if (node is JsonArray arrayNode)
        {
            for (var index = 0; index < arrayNode.Count; index++)
            {
                if (arrayNode[index] is JsonValue jsonValue && jsonValue.TryGetValue<string>(out var text))
                    arrayNode[index] = Redact(text);
                else SanitizeNode(arrayNode[index]);
            }
        }
    }
}