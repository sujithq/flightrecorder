import { graphlib, layout } from "@dagrejs/dagre";
import {
  createIcons, RadioTower, RefreshCw, Plus, ChevronDown, ChevronRight, Search, Database,
  ListTree, Network, ShieldCheck, ShieldAlert, GitCompareArrows, Download, ExternalLink,
  X, Cpu, Wrench, Bot, CircleCheck, CircleX, Clock, Braces, ArrowRight, ZoomIn, ZoomOut,
  Maximize2, Play, Pause, SkipBack, SkipForward, FileJson, Send, GitPullRequest, Monitor,
  ScanSearch, Check, ArrowUpRight, ArrowDownRight
} from "lucide";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import {
  escapeHtml, statusName, eventTypeName, recordingModeName, durationMs,
  formatDuration, formatNumber, formatCost, formatUsage, reportedTokens, estimatedTokens, importQualityCounts, formatCredits,
  usageComplete, usageLabel, recorderVersionLabel, eventDepth, timelineBounds
} from "./model.js";

const icons = {
  RadioTower, RefreshCw, Plus, ChevronDown, ChevronRight, Search, Database, ListTree,
  Network, ShieldCheck, ShieldAlert, GitCompareArrows, Download, ExternalLink, X, Cpu,
  Wrench, Bot, CircleCheck, CircleX, Clock, Braces, ArrowRight, ZoomIn, ZoomOut, Maximize2,
  Play, Pause, SkipBack, SkipForward, FileJson, Send, GitPullRequest, Monitor, ScanSearch,
  Check, ArrowUpRight, ArrowDownRight
};
const query = new URLSearchParams(location.search);
const views = ["timeline", "graph", "policies", "comparison"];
const state = {
  runs: [], run: null, graph: null, comparison: null, selectedEvent: query.get("event"),
  selectedEdge: null, view: views.includes(query.get("view")) ? query.get("view") : "timeline",
  baseline: query.get("baseline"), search: "", filter: "all", policyFilter: "all",
  changeFilter: "all", zoom: null, replayIndex: -1, replayTimer: null, generation: 0, versionGeneration: 0
};
const element = selector => document.querySelector(selector);
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const refreshIcons = () => createIcons({ icons, attrs: { "aria-hidden": "true", "stroke-width": 1.7 } });
const typeIcon = type => ({ Run: "radio-tower", AgentSpan: "bot", ModelCall: "cpu", ToolCall: "wrench", PolicyDecision: "shield-check" })[eventTypeName(type)] ?? "braces";
const statusIcon = value => ({ Started: "clock", Succeeded: "circle-check", Failed: "circle-x", Blocked: "shield-alert", RequiresApproval: "shield-alert" })[statusName(value)] ?? "clock";
const statusBadge = value => `<span class="status status-${statusName(value).toLowerCase()}">${icon(statusIcon(value))}${statusName(value) === "Started" ? "Running" : statusName(value) === "RequiresApproval" ? "Approval required" : statusName(value)}</span>`;

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options, headers: { "Content-Type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.title ?? `Recorder returned HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function notify(message, failure = true) {
  const banner = element("#message");
  banner.hidden = !message;
  banner.className = failure ? "error-message" : "success-message";
  banner.replaceChildren(document.createTextNode(message ?? ""));
  if (message) {
    const close = document.createElement("button");
    close.className = "icon-button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.innerHTML = icon("x");
    close.addEventListener("click", () => { banner.hidden = true; });
    banner.append(close);
    refreshIcons();
  }
}

async function refreshVersion() {
  const generation = ++state.versionGeneration;
  const label = element("#recorder-version");
  try {
    const info = await api("info", { cache: "no-store" });
    if (generation !== state.versionGeneration) return;
    label.textContent = recorderVersionLabel(info);
    label.dataset.state = "ready";
    label.title = info.version === null
      ? "This server has no release version metadata. It is not the installed VSIX version."
      : "Version of the running recorder API and viewer. Installing a VSIX alone does not upgrade the server.";
  } catch (error) {
    if (generation !== state.versionGeneration) return;
    label.textContent = "Version unavailable";
    label.dataset.state = "error";
    label.title = `${error.message} Use Refresh runs to retry; traces remain available independently.`;
  }
}

function syncUrl() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries({
    run: state.run?.id, event: state.selectedEvent, view: state.view,
    baseline: state.view === "comparison" ? state.baseline : null
  })) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
}

function renderRuns() {
  const filtered = state.runs.filter(run =>
    (state.filter === "all" || statusName(run.status) === state.filter) &&
    `${run.request} ${run.entryPointAgent} ${run.id}`.toLowerCase().includes(state.search.toLowerCase()));
  element("#run-count").textContent = state.runs.length;
  element("#run-list").innerHTML = filtered.length ? filtered.map(run => `
    <button class="run-item ${run.id === state.run?.id ? "selected" : ""}" data-run="${escapeHtml(run.id)}" ${run.id === state.run?.id ? 'aria-current="true"' : ""}>
      <span class="run-item-top">${statusBadge(run.status)}<time>${escapeHtml(new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time></span>
      <strong>${escapeHtml(run.request)}</strong>
      <span class="run-item-meta"><span>${escapeHtml(run.entryPointAgent)}</span><span>${run.eventCount} events</span></span>
      <span class="run-item-id">${escapeHtml(run.id.slice(0, 8))}<span>${formatDuration(durationMs(run))}</span></span>
    </button>`).join("") : '<div class="empty compact">No matching runs</div>';
  refreshIcons();
}

async function refreshRuns(initial = false, forceCurrent = false) {
  try {
    state.runs = await api("runs");
    renderRuns();
    if (initial) {
      const requested = query.get("run");
      if (requested) await selectRun(requested, true);
      else if (state.runs.length) await selectRun(state.runs[0].id);
    } else if (state.run && (!state.run.endedAt || state.run.usageImports?.length || forceCurrent)) {
      await selectRun(state.run.id, true);
    }
  } catch (error) { notify(error.message); }
}

async function selectRun(runId, preserveSelection = false) {
  const generation = ++state.generation;
  stopReplay();
  try {
    const run = await api(`runs/${encodeURIComponent(runId)}`);
    if (generation !== state.generation) return;
    state.run = run;
    state.graph = null;
    state.comparison = null;
    state.selectedEdge = null;
    state.zoom = null;
    state.replayIndex = -1;
    if (!preserveSelection) state.selectedEvent = null;
    element("#analysis").hidden = true;
    renderRuns();
    renderOverview();
    renderInspector();
    await showView(state.view);
    syncUrl();
  } catch (error) { if (generation === state.generation) notify(error.message); }
}

function metric(label, value, className = "") {
  return `<div class="metric ${className}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderOverview() {
  const run = state.run;
  const imported = importQualityCounts(run.events);
  const hasImports = Object.values(imported).some(count => count > 0);
  element("#trace-tools").hidden = false;
  const interventionCount = run.events.filter(event => ["Blocked", "RequiresApproval"].includes(statusName(event.status)) && eventTypeName(event.type) === "PolicyDecision").length;
  element("#run-overview").innerHTML = `
    <div class="run-heading"><div><div class="eyebrow">RUN <span>${escapeHtml(run.id.slice(0, 8))}</span>${statusBadge(run.status)}</div>
    <h2>${escapeHtml(run.request)}</h2><div class="run-subtitle"><span>${icon("bot")}${escapeHtml(run.entryPointAgent)}</span><span>${icon("shield-check")}${recordingModeName(run.recordingMode)}</span></div></div>
    <div class="run-actions"><button class="command" data-action="analyze">${icon("scan-search")}<span>Explain run</span></button>
    <details class="menu export-menu"><summary class="icon-button" title="Export run" aria-label="Export run">${icon("download")}</summary><div class="menu-items">
      <button data-export="otlp">${icon("file-json")}OTLP JSON</button><button data-action="send-otlp">${icon("send")}Send to collector</button>
      <button data-export="github">${icon("git-pull-request")}GitHub check JSON</button><button data-export="badge">${icon("monitor")}Badger summary</button>
    </div></details></div></div>
    <div class="metrics">${metric("Duration", formatDuration(durationMs(run)))}${metric("Events", formatNumber(run.events.length))}${metric("Reported tokens", usageLabel(run, "tokens"))}${metric("Reported est. cost", usageLabel(run, "cost"))}${metric("Interventions", interventionCount, interventionCount ? "metric-warning" : "")}</div>
    ${hasImports ? `<div class="metrics imported-metrics">
      ${metric("Text estimate (tokens)", formatUsage(estimatedTokens(run)))}
      ${metric("Reported Copilot credits", formatCredits(run.copilotCredits))}
      ${metric("Credit-equivalent USD", formatCost(run.copilotUsageValueUsd))}
    </div><p class="usage-note import-summary">Local imports: ${imported.measured} measured, ${imported.estimated} estimated, ${imported.unavailable} unavailable observations.
      Text estimates count visible transcript characters, not full model context. Credit-equivalent USD is source billing usage value, not your invoice or a provider/API estimate.</p>` : ""}
    <p class="usage-note">Usage covers reported events only, not unobserved model calls. Local Copilot session collection must be explicitly enabled in the extension. Missing measurements are not zero; measured tokens, text estimates, API price estimates and Copilot credits remain separate.</p>`;
  refreshIcons();
}

async function showView(view) {
  state.view = view;
  stopReplay();
  document.querySelectorAll("[data-view]").forEach(tab => {
    const active = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  const panel = element("#view-panel");
  panel.setAttribute("aria-labelledby", `tab-${view}`);
  if (!state.run) return;
  syncUrl();
  if (view === "timeline") renderTimeline();
  else if (view === "policies") renderPolicies();
  else {
    panel.innerHTML = '<div class="empty">Loading trace view...</div>';
    const runId = state.run.id;
    try {
      if (view === "graph") {
        const graph = state.graph ?? await api(`runs/${runId}/graph`);
        if (state.run?.id !== runId || state.view !== view) return;
        state.graph = graph;
        renderGraph();
      } else {
        renderComparisonShell();
        if (state.baseline) await loadComparison();
      }
    } catch (error) {
      if (state.run?.id !== runId || state.view !== view) return;
      panel.innerHTML = '<div class="empty">Trace view unavailable</div>';
      notify(error.message);
    }
  }
  refreshIcons();
}

function renderTimeline() {
  const run = state.run;
  const bounds = timelineBounds(run);
  const events = [...run.events].sort((first, second) => Date.parse(first.startedAt) - Date.parse(second.startedAt));
  element("#view-panel").innerHTML = `
    <div class="panel-toolbar"><h3>Execution timeline <span class="count">${events.length}</span></h3><div class="replay-tools">
      <button class="icon-button" data-action="replay-back" title="Previous event" aria-label="Previous event">${icon("skip-back")}</button>
      <button class="icon-button" data-action="replay-play" title="Play recorded events" aria-label="Play recorded events">${icon(state.replayTimer ? "pause" : "play")}</button>
      <button class="icon-button" data-action="replay-next" title="Next event" aria-label="Next event">${icon("skip-forward")}</button>
      <input aria-label="Replay position" id="replay-position" type="range" min="0" max="${Math.max(0, events.length - 1)}" value="${Math.max(0, state.replayIndex)}" ${events.length ? "" : "disabled"}>
    </div></div>
    <div class="timeline-scroll"><div class="timeline"><div class="timeline-axis"><span>Operation</span><div><span>0 s</span><span>${formatDuration(bounds.duration / 2)}</span><span>${formatDuration(bounds.duration)}</span></div><span>Duration</span></div>
    ${events.length ? events.map((event, index) => {
      const offset = Math.max(0, (Date.parse(event.startedAt) - bounds.start) / bounds.duration * 100);
      const width = Math.max(0.5, Math.min(100 - offset, durationMs(event) / bounds.duration * 100));
      return `<button class="timeline-row ${state.selectedEvent === event.id ? "selected" : ""} ${state.replayIndex >= 0 && index > state.replayIndex ? "replay-future" : ""}" data-event="${escapeHtml(event.id)}" aria-label="${escapeHtml(event.name)}, ${statusName(event.status)}">
        <span class="operation" style="--depth:${Math.min(eventDepth(event, run.events), 5)}"><span class="type-icon type-${eventTypeName(event.type).toLowerCase()}">${icon(typeIcon(event.type))}</span><span><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(event.agentName ?? eventTypeName(event.type))}</small></span></span>
        <span class="waterfall-track"><span class="waterfall-bar bar-${statusName(event.status).toLowerCase()} type-${eventTypeName(event.type).toLowerCase()}" style="left:${offset}%;width:${width}%" title="${formatDuration(durationMs(event))}"></span></span>
        <span class="row-duration">${icon(statusIcon(event.status))}${formatDuration(durationMs(event))}</span>
      </button>`;
    }).join("") : '<div class="empty">No events recorded</div>'}</div></div>
    <div class="legend"><span class="legend-agent">${icon("bot")}Agent</span><span class="legend-model">${icon("cpu")}Model</span><span class="legend-tool">${icon("wrench")}Tool</span><span class="legend-policy">${icon("shield-alert")}Policy</span></div>`;
  refreshIcons();
}

function renderGraph() {
  const graph = new graphlib.Graph().setGraph({ rankdir: "TB", ranksep: 54, nodesep: 24, marginx: 24, marginy: 24 }).setDefaultEdgeLabel(() => ({}));
  for (const node of state.graph.nodes) graph.setNode(node.id, { width: 216, height: 76 });
  for (const edge of state.graph.edges) graph.setEdge(edge.sourceId, edge.targetId);
  layout(graph);
  const { width, height } = graph.graph();
  const available = Math.max(280, element("#view-panel").clientWidth - 36);
  const zoom = state.zoom ?? Math.max(0.15, Math.min(1, available / width));
  state.renderedZoom = zoom;
  element("#view-panel").innerHTML = `
    <div class="panel-toolbar"><h3>Agent relationships <span class="count">${state.graph.nodes.length}</span></h3><div class="zoom-tools">
      <button class="icon-button" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">${icon("zoom-out")}</button><span class="mono">${Math.round(zoom * 100)}%</span>
      <button class="icon-button" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">${icon("zoom-in")}</button><button class="icon-button" data-action="zoom-fit" title="Fit graph" aria-label="Fit graph">${icon("maximize-2")}</button>
    </div></div><div class="graph-scroll"><div class="graph-canvas" style="width:${width * zoom}px;height:${height * zoom}px"><div class="graph-stage" style="width:${width}px;height:${height}px;transform:scale(${zoom})">
    <svg class="graph-edges" width="${width}" height="${height}" aria-label="Recorded hand-offs"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>
    ${state.graph.edges.map((edge, index) => {
      const points = graph.edge(edge.sourceId, edge.targetId).points;
      const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
      const label = state.graph.nodes.find(node => node.id === edge.targetId)?.name ?? "connection";
      return `<g data-edge="${index}" tabindex="0" role="button" aria-label="Hand-off to ${escapeHtml(label)}" class="graph-edge ${edge.identityChanged ? "identity-changed" : ""}"><path class="edge-hit" d="${path}"/><path class="edge-line" d="${path}" marker-end="url(#arrow)"/></g>`;
    }).join("")}</svg>
    ${state.graph.nodes.map(node => {
      const position = graph.node(node.id);
      return `<button class="graph-node ${state.selectedEvent === node.id ? "selected" : ""} node-${statusName(node.status).toLowerCase()}" style="left:${position.x - 108}px;top:${position.y - 38}px" data-event="${escapeHtml(node.id)}" aria-label="${escapeHtml(node.name)}, ${statusName(node.status)}"><span class="graph-node-icon type-${eventTypeName(node.type).toLowerCase()}">${icon(typeIcon(node.type))}</span><span class="graph-node-label"><strong>${escapeHtml(node.name)}</strong><small>${eventTypeName(node.type).replace(/([a-z])([A-Z])/g, "$1 $2")} <span>${formatDuration(node.durationMilliseconds)}</span></small></span><span class="node-status">${icon(statusIcon(node.status))}</span></button>`;
    }).join("")}</div></div></div><div class="legend"><span>${icon("network")}Recorded parent links</span><span class="legend-policy">${icon("shield-alert")}Identity change</span></div>`;
  refreshIcons();
}

function renderPolicies() {
  const policies = state.run.events.filter(event => eventTypeName(event.type) === "PolicyDecision");
  const interventions = policies.filter(event => ["Blocked", "RequiresApproval"].includes(statusName(event.status)));
  const filtered = policies.filter(event => state.policyFilter === "all" || (state.policyFilter === "interventions" ? interventions.includes(event) : statusName(event.status) === "Succeeded"));
  element("#view-panel").innerHTML = `<div class="panel-toolbar"><h3>Policy decisions <span class="count">${policies.length}</span></h3><select id="policy-filter" aria-label="Filter policy decisions"><option value="all">All decisions</option><option value="interventions">Interventions</option><option value="allowed">Allowed</option></select></div>
    <div class="policy-summary">${metric("Allowed", policies.filter(event => statusName(event.status) === "Succeeded").length)}${metric("Blocked / approval", interventions.length, interventions.length ? "metric-warning" : "")}</div>
    <div class="policy-list">${filtered.length ? filtered.map(event => `<button class="policy-row ${state.selectedEvent === event.id ? "selected" : ""}" data-event="${escapeHtml(event.id)}"><div class="policy-title">${icon(statusIcon(event.status))}<strong>${escapeHtml(event.name)}</strong>${statusBadge(event.status)}</div><p>${escapeHtml(event.policyName ?? "Unnamed policy")}</p><div class="scope-flow"><span><small>Requested</small><code>${escapeHtml(event.requestedScope ?? "Not recorded")}</code></span>${icon("arrow-right")}<span><small>Granted</small><code>${escapeHtml(event.grantedScope ?? "Not recorded")}</code></span></div><div class="policy-identity">${icon("bot")}${escapeHtml(event.agentName)}<span>${escapeHtml(event.identity ?? "Identity not recorded")}</span></div></button>`).join("") : '<div class="empty">No policy decisions match</div>'}</div>`;
  element("#policy-filter").value = state.policyFilter;
  refreshIcons();
}

function renderComparisonShell() {
  const candidates = state.runs.filter(run => run.id !== state.run.id);
  if (!candidates.some(run => run.id === state.baseline)) state.baseline = candidates[0]?.id ?? null;
  element("#view-panel").innerHTML = `<div class="panel-toolbar comparison-toolbar"><h3>Trace comparison</h3><label>Baseline<select id="baseline-select" aria-label="Baseline run">${candidates.map(run => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.id.slice(0, 8))} - ${escapeHtml(run.request)} (${statusName(run.status)})</option>`).join("")}</select></label><button class="icon-button" data-action="compare" title="Refresh comparison" aria-label="Refresh comparison">${icon("refresh-cw")}</button></div><div id="comparison-results"><div class="empty">${candidates.length ? "Loading comparison..." : "No other run available"}</div></div>`;
  if (state.baseline) element("#baseline-select").value = state.baseline;
  refreshIcons();
}

async function loadComparison() {
  if (!state.baseline) return;
  const runId = state.run.id;
  const baseline = state.baseline;
  try {
    const comparison = await api(`runs/${encodeURIComponent(baseline)}/compare/${runId}`);
    if (state.run?.id !== runId || state.baseline !== baseline || state.view !== "comparison") return;
    state.comparison = comparison;
    renderComparison();
    syncUrl();
  } catch (error) {
    if (state.run?.id === runId && state.view === "comparison") notify(error.message);
  }
}

function deltaMetric(label, baseline, candidate, formatter = formatNumber, comparable = true, partialBefore = false, partialAfter = false) {
  const delta = comparable && Number.isFinite(baseline) && Number.isFinite(candidate) ? candidate - baseline : null;
  return `<div class="delta-metric"><span>${escapeHtml(label)}</span><div><span>${formatter(baseline)}${partialBefore ? " (partial)" : ""}</span>${icon("arrow-right")}<strong>${formatter(candidate)}${partialAfter ? " (partial)" : ""}</strong></div><small class="${delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : ""}">${delta === null ? "Not comparable" : `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${formatter(Math.abs(delta))}`}</small></div>`;
}

function renderComparison() {
  const comparison = state.comparison;
  const events = comparison.events.filter(event => state.changeFilter === "all" || event.change.toLowerCase() === state.changeFilter);
  const usageDelta = kind => {
    const before = comparison.baseline;
    const after = comparison.candidate;
    const value = item => kind === "cost" ? item.estimatedCost : reportedTokens(item);
    return deltaMetric(kind === "cost" ? "Reported est. cost" : "Reported tokens",
      value(before), value(after), kind === "cost" ? formatCost : formatUsage,
      usageComplete(before, kind) && usageComplete(after, kind),
      Number.isFinite(value(before)) && !usageComplete(before, kind),
      Number.isFinite(value(after)) && !usageComplete(after, kind));
  };
  element("#comparison-results").innerHTML = `<div class="comparison-metrics">${deltaMetric("Duration", comparison.baseline.durationMilliseconds, comparison.candidate.durationMilliseconds, formatDuration)}${usageDelta("tokens")}${usageDelta("cost")}${deltaMetric("Interventions", comparison.baseline.policyInterventions, comparison.candidate.policyInterventions)}</div>
    ${[comparison.baseline, comparison.candidate].some(item => estimatedTokens(item) !== null || Number.isFinite(item.copilotCredits)) ? `<div class="comparison-metrics">
      ${deltaMetric("Text estimate (tokens)", estimatedTokens(comparison.baseline), estimatedTokens(comparison.candidate), formatUsage, false)}
      ${deltaMetric("Reported Copilot credits", comparison.baseline.copilotCredits, comparison.candidate.copilotCredits, formatCredits, false)}
      ${deltaMetric("Credit-equivalent USD", comparison.baseline.copilotUsageValueUsd, comparison.candidate.copilotUsageValueUsd, formatCost, false)}
    </div><p class="usage-note">Source estimates and credit usage may have different coverage; no savings delta is inferred. Credit equivalents are not invoice charges.</p>` : ""}
    <div class="panel-toolbar"><h3>Event changes <span class="count">${events.length}</span></h3><select id="change-filter" aria-label="Filter event changes"><option value="all">All events</option><option value="changed">Changed</option><option value="added">Added</option><option value="removed">Removed</option><option value="unchanged">Unchanged</option></select></div>
    <div class="comparison-list">${events.map((comparisonEvent, index) => {
      const event = comparisonEvent.candidate ?? comparisonEvent.baseline;
      return `<button class="comparison-row" data-comparison="${comparison.events.indexOf(comparisonEvent)}"><span class="type-icon type-${eventTypeName(event.type).toLowerCase()}">${icon(typeIcon(event.type))}</span><span class="comparison-name"><strong>${escapeHtml(event.name)}</strong><small>${escapeHtml(comparisonEvent.changedFields.join(", ") || "No changes")}</small></span><span class="comparison-statuses">${comparisonEvent.baseline ? statusBadge(comparisonEvent.baseline.status) : "Absent"}${icon("arrow-right")}${comparisonEvent.candidate ? statusBadge(comparisonEvent.candidate.status) : "Absent"}</span><span class="change-label change-${["changed", "added", "removed", "unchanged"].includes(comparisonEvent.change.toLowerCase()) ? comparisonEvent.change.toLowerCase() : "changed"}">${escapeHtml(comparisonEvent.change)}</span></button>`;
    }).join("") || '<div class="empty">No matching changes</div>'}</div>`;
  element("#change-filter").value = state.changeFilter;
  refreshIcons();
}

function detail(label, value) {
  return value === null || value === undefined || value === "" ? "" : `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderInspector(override = null, comparisonLabel = "") {
  const event = override ?? state.run?.events.find(item => item.id === state.selectedEvent);
  const inspector = element("#inspector");
  inspector.hidden = !event;
  element("#workbench").classList.toggle("with-inspector", !!event);
  if (!event) return;
  const parent = state.run.events.find(item => item.id === event.parentEventId);
  const edge = state.selectedEdge;
  inspector.innerHTML = `<div class="inspector-heading"><span>${edge ? "Hand-off evidence" : comparisonLabel || "Decision evidence"}</span><button class="icon-button" data-action="close-inspector" title="Close inspector" aria-label="Close inspector">${icon("x")}</button></div>
    <div class="inspector-title"><span class="type-icon type-${eventTypeName(event.type).toLowerCase()}">${icon(typeIcon(event.type))}</span><h2>${escapeHtml(event.name)}</h2>${statusBadge(event.status)}</div>
    ${edge ? `<section><h3>Recorded connection</h3><dl>${detail("Delegated objective", edge.objective)}${detail("Source identity", edge.sourceIdentity)}${detail("Destination identity", edge.targetIdentity)}${detail("Identity changed", edge.identityChanged ? "Yes" : "No")}${detail("Duration", formatDuration(edge.durationMilliseconds))}</dl></section>` : ""}
    ${event.policyName || event.requestedScope || event.policyReason ? `<section class="policy-evidence"><h3>${icon("shield-check")}Identity & permission</h3><dl>${detail("Identity", event.identity)}${detail("Requested scope", event.requestedScope)}${detail("Granted scope", event.grantedScope)}${detail("Policy", event.policyName)}${detail("Decision", statusName(event.status))}${detail("Reason", event.policyReason)}</dl></section>` : ""}
    <section><h3>Operation</h3><dl>${detail("Event ID", event.id)}${detail("Type", eventTypeName(event.type))}${detail("Agent", event.agentName)}${detail("Agent version", event.agentVersion)}${detail("Identity", event.identity)}${detail("Parent identity", parent?.identity)}${detail("Objective", event.objective)}${detail("Model", event.model)}${detail("Tool server", event.toolServer)}${detail(event.importedUsage ? "Observation / import time" : "Started", new Date(event.startedAt).toLocaleString())}${detail("Duration", event.importedUsage ? "Not reported" : formatDuration(durationMs(event)))}</dl></section>
    <section><h3>Reported usage</h3><dl>${detail("Input tokens", formatUsage(event.inputTokens))}${detail("Output tokens", formatUsage(event.outputTokens))}${detail("Estimated cost (USD)", formatCost(event.estimatedCost))}${detail("Pricing basis", event.costBasis ?? (Number.isFinite(event.estimatedCost) ? "Not reported (legacy estimate)" : null))}</dl>
    ${event.usageSchemaVersion == null ? '<p class="usage-note">Legacy event: default zeros could not be distinguished from measured zero. Missing usage cannot be reconstructed.</p>' : ""}</section>
    ${event.importedUsage ? `<section class="usage-provenance"><h3>Local usage provenance</h3><dl>
      ${detail("Quality", event.importedUsage.quality)}
      ${detail("Source", event.importedUsage.sourceKind)}
      ${detail("Format", event.importedUsage.format)}
      ${detail("Timestamp meaning", event.importedUsage.timestampMeaning)}
      ${detail("Estimated input tokens", formatUsage(event.importedUsage.estimatedInputTokens))}
      ${detail("Estimated output tokens", formatUsage(event.importedUsage.estimatedOutputTokens))}
      ${detail("Cache-read tokens", formatUsage(event.importedUsage.cacheReadTokens))}
      ${detail("Cache-write tokens", formatUsage(event.importedUsage.cacheWriteTokens))}
      ${detail("Reported billing nano-AIU", formatUsage(event.importedUsage.nanoAiu))}
      ${detail("Source fingerprint", event.importedUsage.sourceId)}
    </dl><p class="usage-note">Imported metadata only; the local session's conversation text and file path are not stored here. Estimates are not measured usage; billing values are not additional charges.</p></section>` : ""}
    ${event.input ? `<section><h3>Recorded input</h3><pre>${escapeHtml(event.input)}</pre></section>` : ""}${event.output ? `<section><h3>Recorded output</h3><pre>${escapeHtml(event.output)}</pre></section>` : ""}
    ${event.attributes && Object.keys(event.attributes).length ? `<section><h3>Attributes</h3><dl>${Object.entries(event.attributes).map(([key, value]) => detail(key, value)).join("")}</dl></section>` : ""}
    <details class="raw-event"><summary>${icon("braces")}Event JSON</summary><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></details>`;
  refreshIcons();
}

function selectEvent(eventId, edge = null) {
  state.selectedEvent = eventId === state.run.id ? null : eventId;
  state.selectedEdge = edge;
  renderInspector();
  if (state.view === "graph" && state.graph && state.zoom === null) renderGraph();
  document.querySelectorAll("[data-event]").forEach(row => row.classList.toggle("selected", row.dataset.event === state.selectedEvent));
  syncUrl();
  if (state.selectedEvent && matchMedia("(max-width: 700px)").matches) element("#inspector").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function analyze() {
  const runId = state.run.id;
  const result = await api(`runs/${runId}/analysis`);
  if (state.run?.id !== runId) return;
  const panel = element("#analysis");
  panel.hidden = false;
  panel.innerHTML = `<div class="panel-toolbar"><h3>${icon("scan-search")}Recorded diagnosis</h3><button class="icon-button" data-action="close-analysis" title="Close diagnosis" aria-label="Close diagnosis">${icon("x")}</button></div><p>${escapeHtml(result.summary)}</p><dl>${detail("Failure", result.failure)}${detail("Completed work", result.succeeded)}${detail("Next step", result.recommendedNextStep)}</dl><div class="evidence-links">${result.evidence.map(reference => `<button class="evidence-link" data-event="${escapeHtml(reference.eventId)}">${icon("arrow-up-right")}${escapeHtml(reference.label)}</button>`).join("")}</div>`;
  refreshIcons();
}

async function downloadExport(kind) {
  const runId = state.run.id;
  element(".export-menu").open = false;
  const data = await api(`runs/${runId}/${kind === "badge" ? "badge" : `exports/${kind}`}`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `flight-${runId}.${kind}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stopReplay() {
  clearInterval(state.replayTimer);
  state.replayTimer = null;
}

function replayStep(index) {
  const events = [...state.run.events].sort((first, second) => Date.parse(first.startedAt) - Date.parse(second.startedAt));
  if (!events.length) return;
  state.replayIndex = Math.max(0, Math.min(events.length - 1, index));
  if (state.replayIndex === events.length - 1) stopReplay();
  selectEvent(events[state.replayIndex].id);
  renderTimeline();
}

const actions = {
  analyze,
  "close-analysis": () => { element("#analysis").hidden = true; },
  "close-inspector": () => selectEvent(state.run.id),
  "send-otlp": async () => {
    await api(`runs/${state.run.id}/exports/otlp`, { method: "POST" });
    notify("Trace accepted by the configured OTLP collector.", false);
  },
  "zoom-in": () => { state.zoom = Math.min(1.8, state.renderedZoom + 0.15); renderGraph(); },
  "zoom-out": () => { state.zoom = Math.max(0.15, state.renderedZoom - 0.15); renderGraph(); },
  "zoom-fit": () => { state.zoom = null; renderGraph(); },
  compare: loadComparison,
  "replay-back": () => { stopReplay(); replayStep(state.replayIndex - 1); },
  "replay-next": () => { stopReplay(); replayStep(state.replayIndex + 1); },
  "replay-play": () => {
    if (!state.run.events.length) return;
    if (state.replayTimer) { stopReplay(); renderTimeline(); return; }
    if (state.replayIndex >= state.run.events.length - 1) state.replayIndex = -1;
    state.replayTimer = setInterval(() => replayStep(state.replayIndex + 1), 850);
    replayStep(state.replayIndex + 1);
  }
};

document.addEventListener("click", async event => {
  const target = event.target.closest("[data-run], [data-event], [data-view], [data-edge], [data-action], [data-scenario], [data-export], [data-comparison]");
  if (!target || target.disabled) return;
  try {
    if (target.dataset.run) await selectRun(target.dataset.run);
    else if (target.dataset.event) selectEvent(target.dataset.event);
    else if (target.dataset.view) await showView(target.dataset.view);
    else if (target.dataset.edge !== undefined) {
      const edge = state.graph.edges[Number(target.dataset.edge)];
      selectEvent(edge.targetId, edge);
    } else if (target.dataset.comparison !== undefined) {
      const comparison = state.comparison.events[Number(target.dataset.comparison)];
      state.selectedEdge = null;
      if (comparison.candidate) selectEvent(comparison.candidate.id);
      else renderInspector(comparison.baseline, "Baseline evidence");
    } else if (target.dataset.scenario) {
      target.disabled = true;
      element("#demo-menu").open = false;
      const run = await api("demo/runs", { method: "POST", body: JSON.stringify({ scenario: target.dataset.scenario }) });
      await refreshRuns();
      await selectRun(run.id);
    } else if (target.dataset.export) await downloadExport(target.dataset.export);
    else if (target.dataset.action && actions[target.dataset.action]) await actions[target.dataset.action]();
  } catch (error) { notify(error.message); }
  finally { if (target instanceof HTMLButtonElement) target.disabled = false; }
});

document.addEventListener("keydown", event => {
  const edge = event.target.closest("[data-edge]");
  if (edge && ["Enter", " "].includes(event.key)) { event.preventDefault(); edge.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
  if (event.key === "Escape" && state.run) {
    selectEvent(state.run.id);
    document.querySelectorAll("details.menu").forEach(menu => { menu.open = false; });
  }
  const tab = event.target.closest("[role=tab]");
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const current = views.indexOf(tab.dataset.view);
    const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length;
    element(`#tab-${views[next]}`).focus();
    void showView(views[next]);
  }
});

element("#run-search").addEventListener("input", event => { state.search = event.target.value; renderRuns(); });
element("#status-filter").addEventListener("change", event => { state.filter = event.target.value; renderRuns(); });
element("#refresh").addEventListener("click", () => { void refreshVersion(); void refreshRuns(false, true); });
document.addEventListener("change", event => {
  if (event.target.id === "policy-filter") { state.policyFilter = event.target.value; renderPolicies(); }
  if (event.target.id === "baseline-select") { state.baseline = event.target.value; void loadComparison(); }
  if (event.target.id === "change-filter") { state.changeFilter = event.target.value; renderComparison(); }
});
document.addEventListener("input", event => {
  if (event.target.id === "replay-position") { stopReplay(); replayStep(Number(event.target.value)); }
});
document.addEventListener("click", event => {
  document.querySelectorAll("details.menu[open]").forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
});
setInterval(() => { if (!document.hidden) void refreshRuns(); }, 8000);
window.addEventListener("pagehide", stopReplay);
refreshIcons();
void refreshVersion();
void refreshRuns(true);