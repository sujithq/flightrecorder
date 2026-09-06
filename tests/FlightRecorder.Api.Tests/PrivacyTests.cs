using System.Text.Json;
using FlightRecorder.Api.Models;
using FlightRecorder.Api.Services;

namespace FlightRecorder.Api.Tests;

public sealed class PrivacyTests
{
    [Theory]
    [InlineData("Contact fixture@example.invalid", "fixture@example.invalid")]
    [InlineData("Authorization: Bearer synthetic-test-value", "synthetic-test-value")]
    [InlineData("password=\"synthetic value with spaces\"", "synthetic value")]
    [InlineData("Call +1 202-555-0100", "202-555-0100")]
    [InlineData("{\"api_key\":\"synthetic-value\",\"nested\":[{\"email\":\"fixture@example.invalid\"}]}", "synthetic-value")]
    public void Redacts_common_secrets_and_personal_identifiers(string input, string forbidden)
    {
        var result = new TraceRedactor().Redact(input)!;
        Assert.DoesNotContain(forbidden, result);
        Assert.Contains("[REDACTED]", result);
    }

    [Fact]
    public void Redaction_covers_run_metadata_event_fields_and_attributes_before_storage()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "Contact fixture@example.invalid token=synthetic-request",
            EntryPointAgent = "orchestrator",
            RequestingIdentity = "fixture@example.invalid",
            RecordingMode = RecordingMode.Redacted
        });
        var attributes = new Dictionary<string, string>
        {
            ["api_key"] = "synthetic-attribute",
            ["nested"] = "{\"password\":\"synthetic-json\"}",
            ["owner"] = "fixture@example.invalid"
        };
        service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "Contact fixture@example.invalid",
            Identity = "fixture@example.invalid",
            Objective = "token=synthetic-objective",
            PolicyReason = "secret=synthetic-reason",
            Input = "password=synthetic-input",
            Output = "Bearer synthetic-output",
            Attributes = attributes
        });
        attributes["api_key"] = "synthetic-mutated";

        var stored = JsonSerializer.Serialize(service.GetRun(run.Id));
        Assert.DoesNotContain("fixture@example.invalid", stored);
        Assert.DoesNotContain("synthetic-", stored);
    }

    [Fact]
    public void Metadata_only_omits_content_and_unapproved_attributes()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "synthetic request content",
            EntryPointAgent = "agent",
            RequestingIdentity = "identity"
        });
        var recorded = service.RecordEvent(run.Id, new RecordEventRequest
        {
            Name = "tool",
            Input = "synthetic input",
            Output = "synthetic output",
            Objective = "synthetic objective",
            Attributes = new() { ["prompt"] = "synthetic prompt", ["gen_ai.operation.name"] = "chat" }
        })!;

        Assert.Equal("[Content omitted]", run.Request);
        Assert.Null(recorded.Input);
        Assert.Null(recorded.Output);
        Assert.Null(recorded.Objective);
        Assert.Single(recorded.Attributes!);
        Assert.Equal("chat", recorded.Attributes!["gen_ai.operation.name"]);
    }

    [Fact]
    public void Full_mode_preserves_content_and_custom_patterns_are_supported()
    {
        var service = new FlightRecorderService();
        var run = service.StartRun(new StartRunRequest
        {
            Request = "token=synthetic-value",
            EntryPointAgent = "agent",
            RequestingIdentity = "identity",
            RecordingMode = RecordingMode.Full
        });
        Assert.Equal("token=synthetic-value", run.Request);
        Assert.Equal("[REDACTED]", new TraceRedactor([@"INTERNAL-\d+"]).Redact("INTERNAL-1234"));
    }
}