# Issue #1: Implement Agent Flight Recorder

| Field  | Value  |
| ------ | ------ |
| Number | 1      |
| State  | OPEN   |
| Labels | _none_ |

---

Before starting. Everything must be in place to use the latest Squad from Brady Gaster

## Agent Flight Recorder

**Elevator pitch:**  
Agent Flight Recorder is an open observability and governance layer for AI agents. It records how an agent interpreted a request, which tools and identities it used, what information it retrieved, how it delegated work, what it cost, and why it ultimately succeeded or failed.

Think of it as a combination of:

- Application Insights for agent execution
- GitHub Actions run history for multi-agent workflows
- A distributed trace across agents, models, MCP servers and APIs
- A black-box recorder for investigating failures
- A governance record for security and compliance teams

The key difference from ordinary telemetry is that it reconstructs the agent’s **decision and action chain**, rather than merely showing HTTP requests and exceptions.

---

# 1. The problem it solves

Traditional applications normally follow paths explicitly written by developers. Agents are different:

- The execution path can change with each request
- The model chooses which tool to call
- One agent can delegate to another
- Retrieved content influences subsequent decisions
- Tools can have different identities and permissions
- Model, tool and network failures may trigger alternative paths
- A technically successful execution can still produce a poor outcome
- Cost can accumulate across retries and delegations
- Sensitive information can cross boundaries unexpectedly

When something goes wrong, a developer may only see:

> “The agent failed to complete the task.”

That does not answer:

- Which agent made the problematic decision?
- Was the model response malformed?
- Did retrieval return irrelevant information?
- Did an MCP server expose the wrong tool?
- Was the tool called with incorrect parameters?
- Did the agent lack permission?
- Did a policy block the action?
- Was the wrong identity used?
- Did an agent enter a delegation or retry loop?
- Was the response correct but unnecessarily expensive?
- Did the agent act on untrusted content?
- Can the run be reproduced?

Agent Flight Recorder converts an opaque execution into an inspectable trace.

---

# 2. The core demo story

For a Microsoft hackathon, the story should be understandable without explaining the entire agent architecture.

## Scenario

A developer asks an engineering agent:

> “Analyse the failed deployment, fix the issue and prepare a pull request.”

The primary agent:

1. Reads the repository.
2. Delegates log analysis to a diagnostic agent.
3. Queries deployment telemetry.
4. Asks a coding agent to propose a fix.
5. Runs tests.
6. Attempts to create a pull request.

The task fails or produces an unexpected fix.

## Without Flight Recorder

The user sees:

> “I couldn’t complete the pull request.”

The development team must inspect multiple logs, agent sessions and service dashboards.

## With Flight Recorder

The application displays a visual timeline:

```text
User request
   ↓
Orchestrator agent
   ├─ Repository tool            420 ms
   ├─ Diagnostic agent           3.8 s
   │    ├─ Log query             1.1 s
   │    └─ Deployment lookup     850 ms
   ├─ Coding agent               6.2 s
   │    ├─ File read
   │    ├─ Code generation
   │    └─ Test execution
   └─ Pull request tool          BLOCKED
        Reason: write permission not granted
```

The recorder highlights:

- The exact failing step
- The identity used
- The requested permission
- The policy decision
- The preceding agent decision
- The total latency and cost
- Whether the task could safely resume

Then Copilot provides a grounded explanation:

> “The code change and tests completed successfully. Pull request creation was blocked because the coding agent had repository read access but not pull-request write access. No repository changes were published.”

That is the three-minute “aha” moment.

---

# 3. What should be recorded

The event model is the heart of the project. Avoid storing only unstructured logs. Record events with a consistent schema.

## Run

The complete execution initiated by a user or system.

Suggested properties:

- Run ID
- Parent run ID
- Start and end time
- Requesting user or application
- Entry-point agent
- Environment
- Overall status
- Total duration
- Total model usage
- Estimated cost
- Risk classification
- Correlation ID

## Agent span

A period during which one agent works on a task.

- Agent name and version
- Agent instructions version
- Model deployment
- Input and output references
- Parent agent
- Delegation reason
- Duration
- Completion status
- Confidence or evaluation result
- Token usage

## Model call

- Model and deployment
- Input token count
- Output token count
- Latency
- Retry count
- Response format validation
- Safety intervention
- Cached or non-cached
- Prompt template version

For privacy, the recorder should support storing either:

- Full content
- Redacted content
- Hashes and metadata only
- A reference to content in a controlled store

## Tool call

- Tool name and version
- Tool description presented to the model
- MCP server or API endpoint
- Sanitised parameters
- Result status
- Duration
- Returned data classification
- Identity used
- Permission scope
- Policy outcome
- Retry information

## Retrieval event

- Query
- Search or vector index
- Retrieved document identifiers
- Ranking or relevance information
- Data classification
- Citations retained in the final response
- Documents retrieved but not used
- Access-control filtering

## Agent-to-agent hand-off

- Source agent
- Destination agent
- Delegated objective
- Context passed
- Context omitted
- Identity propagation
- Permission change
- Result returned
- Number of previous delegations

## Policy event

- Policy name
- Resource being protected
- Requested operation
- Decision: allow, deny, require approval or redact
- Reason
- Policy version
- User approval, if applicable

## Evaluation event

- Groundedness
- Task completion
- Citation quality
- Tool selection accuracy
- Output-format compliance
- Safety results
- Custom business evaluation

The MVP does not need every event. A strong first version needs just five:

1. Run
2. Agent span
3. Model call
4. Tool call
5. Policy decision

---

# 4. The visual experience

The interface should answer different questions for developers, security teams and product owners without becoming another wall of logs.

## A. Trace waterfall

The main view resembles a distributed-tracing waterfall.

```text
Run: Fix failed deployment                  14.7 s

Orchestrator     ████████████████████████████████
Repo lookup       ██
Diagnostics          ████████
Log query             ███
Coding agent                  █████████████
Tests                              █████
Pull request                              █ BLOCKED
```

Colour could communicate state:

- Green: succeeded
- Red: failed
- Amber: policy intervention
- Purple: agent delegation
- Blue: model or retrieval operation
- Grey: skipped or cached

## B. Agent graph

A graph shows the relationship between participants:

```text
                         ┌──────────────────┐
                         │  User request    │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │ Orchestrator     │
                         └───┬──────────┬───┘
                             │          │
                    ┌────────▼───┐  ┌───▼──────────┐
                    │ Diagnostic │  │ Coding agent │
                    │ agent      │  │              │
                    └─────┬──────┘  └──────┬───────┘
                          │                │
                    ┌─────▼─────┐    ┌─────▼─────────┐
                    │ Telemetry │    │ GitHub tools  │
                    └───────────┘    └───────────────┘
```

Selecting a connection shows:

- Objective delegated
- Context transferred
- Identity change
- Duration
- Result

## C. Decision inspector

Do not attempt to expose hidden model reasoning. Instead, display observable and auditable information:

- What objective was given to the agent
- Which tools were available
- Which tool the agent selected
- What arguments it supplied
- What result came back
- What action followed
- Which policy or validation influenced the outcome

Call this **decision evidence**, not chain of thought.

## D. Identity and permission view

This could become one of the strongest differentiators.

For each action:

```text
Action: Create pull request
Agent: Coding agent
Identity: agent-dev-042
Requested scope: pull_requests:write
Granted scope: contents:read
Decision: Blocked
Policy: Repository write actions require explicit approval
```

It makes least-privilege failures immediately understandable.

## E. Cost flame graph

Show where model usage accumulated:

```text
Orchestrator                           18%
Diagnostics                            14%
Coding agent                           51%
Evaluation                             10%
Retries                                 7%
```

Selecting a section shows the model, tokens, repeated calls and caching opportunities.

## F. Replay view

Replay does not need to rerun every external action. It could support three modes:

- **Visual replay:** Step through the previously captured events
- **Dry-run replay:** Re-execute reasoning and models while mocking write operations
- **Comparison replay:** Run the same task against a different prompt, model or agent version

For the hackathon, visual replay is sufficient. Comparison replay would be an excellent stretch goal.

---

# 5. Copilot-powered root-cause analysis

The recorder should not just display telemetry. It should transform traces into an explanation grounded in recorded events.

Example output:

> **Primary failure**
>
> The pull-request operation was denied because the coding agent requested `pull_requests:write`, while its workload identity had only repository read permission.
>
> **What succeeded**
>
> Repository analysis, log retrieval, code generation and test execution completed before the denied operation.
>
> **Recommended next step**
>
> Resume the run after explicit approval of the pull-request action. Broad repository write access is not required.

Useful generated sections:

- Failure summary
- First significant anomaly
- Contributing events
- Security and policy effects
- Work already completed
- Recoverable state
- Suggested remediation
- Similar previous failures
- Cost optimisation opportunities

Every statement should link back to one or more events. Clicking “permission denied” should select the corresponding policy event.

This prevents the explanation from becoming another ungrounded AI summary.

---

# 6. Proposed architecture

A practical architecture could look like this:

```text
Agent application
    │
    ├── Flight Recorder SDK
    │       ├── Run and span creation
    │       ├── Model instrumentation
    │       ├── Tool instrumentation
    │       ├── Redaction
    │       └── Context propagation
    │
    ▼
Telemetry ingestion
    │
    ├── Trace store
    ├── Event and audit store
    └── Optional protected content store
            │
            ▼
Flight Recorder service
    ├── Trace reconstruction
    ├── Cost calculation
    ├── Policy-event correlation
    ├── Evaluations
    └── Root-cause agent
            │
            ▼
Web interface / VS Code / GitHub checks
```

## Suggested Microsoft-oriented implementation

### Instrumentation

Use OpenTelemetry concepts:

- Trace = complete agent run
- Span = agent, model, retrieval or tool operation
- Span event = policy decision, retry or evaluation result
- Baggage = correlation context propagated between agents

Add agent-specific semantic attributes on top.

Examples:

```text
gen_ai.agent.name
gen_ai.agent.version
gen_ai.operation.name
gen_ai.tool.name
gen_ai.tool.server
gen_ai.delegation.target
gen_ai.policy.decision
gen_ai.identity.id
gen_ai.data.classification
```

Use existing conventions where available and keep custom attributes in a clearly namespaced experimental section.

### Ingestion and storage

Possible components:

- Azure Monitor or Application Insights for trace ingestion
- Log Analytics for queries
- Azure Data Explorer for large event volumes and timeline analysis
- Azure Storage for protected payloads
- Azure Key Vault for secrets
- Microsoft Entra ID for user and workload identity
- Azure Container Apps or Azure Functions for the collector and API
- Microsoft Foundry for the root-cause summarisation agent

For an MVP, avoid deploying all of these. Application Insights plus a small web API and interface is enough.

### Developer integration

Potential entry points:

- Python SDK
- .NET SDK
- JavaScript or TypeScript SDK
- Semantic Kernel middleware
- Microsoft Agent Framework integration
- MCP client and server wrappers
- OpenTelemetry-compatible exporter

For the hackathon, choose the language used by the sample agent and provide decorators or middleware.

Conceptually:

```python
@flight_recorder.agent("diagnostic-agent")
async def diagnose_incident(request):
    ...

@flight_recorder.tool("query-deployment-logs")
async def query_logs(environment):
    ...
```

A context object propagates the run and parent span across agent boundaries.

---

# 7. Privacy and responsible recording

This project becomes much more credible if privacy is part of the design rather than an afterthought.

## Recording modes

### Metadata only

Records:

- Timings
- Models
- Tool names
- Status
- Token counts
- Identities
- Policy outcomes

Does not record prompt or response content.

### Redacted

Records content after removing:

- Secrets
- Access tokens
- Personal identifiers
- Connection strings
- Configured sensitive patterns

### Full fidelity

Records content only in explicitly approved environments with restricted access and retention.

## Data controls

Include:

- Per-agent recording policy
- Per-tool recording policy
- Field-level redaction
- Configurable retention
- Separation between operational traces and content
- Encryption
- Role-based access
- Export and deletion
- Tamper-evident audit records

## Important design principle

The recorder itself must not become a new data-exfiltration path.

A useful rule:

> Diagnostic access to a trace must never provide broader access than the investigator already has to the underlying resources.

For example, a developer who cannot access a confidential document should not see that document’s retrieved text in the trace viewer.

---

# 8. Security scenarios

Agent Flight Recorder could detect several high-value patterns.

## Excessive permission request

An agent requests a scope substantially broader than required for the current action.

## Identity discontinuity

A task starts using the user’s delegated identity but a downstream tool unexpectedly uses a shared application identity.

## Untrusted-content influence

A retrieved document contains instructions that precede a sensitive tool call.

The recorder does not have to prove causation. It can show the sequence and flag the correlation for investigation.

## Tool substitution

The intended internal tool fails and the agent falls back to a different tool with another data boundary.

## Retry storm

The agent repeatedly calls a failing model or service, increasing cost without meaningful progress.

## Delegation loop

Agent A delegates to Agent B, which delegates back to Agent A or creates an equivalent task repeatedly.

## Output without evidence

The final answer contains assertions that cannot be mapped to retrieved evidence or tool results.

---

# 9. MVP scope for a hackathon

The biggest risk is trying to build a complete enterprise monitoring platform. Keep the MVP tightly scoped.

## Must have

1. One sample multi-agent workflow
2. One instrumentation library
3. A collector that receives structured events
4. A trace timeline
5. Model and tool-call details
6. One failed or blocked action
7. A Copilot-generated, evidence-linked explanation
8. Basic token, latency and cost reporting

## Nice to have

- Agent graph
- Policy visualisation
- OpenTelemetry export
- VS Code panel
- GitHub check summary
- Trace comparison
- PII or secret redaction
- Badger2040 companion

## Do not build initially

- A general-purpose SIEM
- A complete policy engine
- Support for every agent framework
- Production billing accuracy
- Full prompt-management functionality
- Autonomous remediation of unrestricted actions
- Employee-level productivity scoring

---

# 10. Suggested team split

For a small hackathon team:

## Agent workflow

Builds the orchestrator, diagnostic agent, coding agent and deliberate failure scenario.

## Instrumentation

Builds the run, span, model-call and tool-call SDK.

## Backend and telemetry

Builds ingestion, storage, trace querying and event correlation.

## Experience

Builds the waterfall, agent graph and detail panel.

## Copilot intelligence

Builds evidence-grounded root-cause summarisation and remediation suggestions.

You can combine backend and instrumentation if the team is small.

---

# 11. Three-minute demo script

## 0:00 to 0:25: Establish the problem

> “When a traditional service fails, we have distributed tracing. When an autonomous agent fails, we often have a conversation and several disconnected logs. But the agent may have called models, delegated to other agents, used multiple identities and attempted real actions.”

## 0:25 to 0:50: Start the task

Ask the agent:

> “Investigate the failed deployment, fix it and create a pull request.”

Show the live workflow progressing through diagnostics, repository analysis and test execution.

## 0:50 to 1:10: Show the failure

The agent reports that it could not complete the pull request.

> “This is the experience developers have today. Something failed, but the visible error does not explain the complete execution.”

## 1:10 to 2:10: Open Flight Recorder

Show:

- Full run timeline
- Agent delegations
- Model and tool calls
- Identity used
- Policy block
- Cost and latency

Click the blocked pull-request action and reveal the missing permission.

## 2:10 to 2:35: Generate the diagnosis

Select “Explain this run”.

Show the evidence-linked summary:

- Code generation succeeded
- Tests passed
- Publication was blocked
- No write occurred
- The run can resume after approval

## 2:35 to 3:00: End with the vision

> “Agent Flight Recorder makes autonomous systems observable, governable and recoverable. Developers can debug them, security teams can understand their actions, and organisations can adopt agents without losing control.”

---

# 12. The strongest differentiators

There will already be agent tracing products and framework-specific observability solutions. Your project needs a precise identity.

I would centre it on these differentiators:

### Identity-aware

Every meaningful action shows which human, agent or workload identity performed it.

### Policy-aware

Blocked and approval-required actions appear as first-class trace events, not generic errors.

### Multi-agent

The trace crosses agent and framework boundaries rather than stopping at a single model call.

### Action-oriented

It instruments real tool calls and external effects, not only prompts and responses.

### Evidence-grounded diagnosis

Root-cause explanations link directly to observable events.

### Privacy-conscious

Prompt and response recording is optional, redacted and separately controlled.

That positioning makes it more than “another LLM dashboard”.

---

# 13. Possible names

- Agent Flight Recorder
- Agent Black Box
- AgentScope
- AgentTrace
- AgentLens
- Mission Control for Agents
- Agent Replay
- TracePilot
- Agent Incident Explorer
- ControlPlane AI

My preference remains **Agent Flight Recorder** because it immediately communicates recording, investigation and safety.

A strong tagline would be:

> **See every decision. Trace every action. Trust every agent.**

Or, slightly more technical:

> **Distributed tracing for autonomous work.**

## Recommended first prototype

Start with **one Python or .NET multi-agent deployment-repair scenario**, instrument it using OpenTelemetry-style spans, and build a polished trace viewer around one deliberately blocked GitHub action. The blocked action produces a clearer enterprise story than a random exception because it connects debugging, identity, governance and safe agent autonomy in one moment.
