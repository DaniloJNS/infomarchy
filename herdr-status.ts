// Live agent state from Herdr, instead of guessing it from a window title.
//
// The desk used to infer everything about a session from the terminal title:
// `titleLooksBusy()` for the pulsing dot, and `attentionSignal()`'s regexes for
// blocked / waiting / done. Both are guesses about a string an agent writes for
// a human, and both are wrong in the ways guesses are — a title describing the
// task ("fix the failed migration") reads as a failure, and a title an agent
// forgot to clear reads as busy forever.
//
// Herdr already does real detection, and the plugin already speaks to its
// socket to focus panes. `agent.list` returns one row per agent it hosts,
// measured at 4-6 ms over the same Unix socket, no subprocess:
//
//   {"id":"…","method":"agent.list","params":{}}
//   → {"result":{"type":"agent_list","agents":[{ agent, agent_session,
//        agent_status, cwd, focused, foreground_cwd, pane_id, revision,
//        state_change_seq, tab_id, terminal_id, terminal_title,
//        terminal_title_stripped, workspace_id }, …]}}
//
// The status vocabulary does NOT mean what the names suggest, so the mapping
// below is deliberate rather than nominal (quoting `herdr --skill`):
//
//   * `idle` — ready for input, and its tab has been seen in the focused
//     Herdr UI.
//   * `done` — the same underlying idle state, after work the user has NOT
//     seen finished. Focusing the tab or targeting the pane marks it seen;
//     CLI reads do not. So polling this every 4 s cannot erase the signal,
//     and clicking the card (which focuses the pane) clears it — exactly the
//     behaviour the desk wants.
//   * `blocked` — Herdr recognised an approval or question UI on screen. This
//     is the desk's *waiting*, not its *blocked*: the desk reserves blocked
//     for a real failure (a merge conflict, a crash). Mapping these two by
//     name would have turned every permission prompt into a red failure.
//   * `working` — producing output now. Replaces the title regex.
//   * `unknown` — an agent is present but Herdr cannot classify it
//     confidently, and it "does not prove completion". So it is never allowed
//     to read as healthy or done; it falls back to the old title heuristics,
//     the same way projectHealth() treats a repo it cannot inspect.
//
// Sessions are joined on `pane_id`, matching the `HERDR_PANE_ID` the collector
// already reads from /proc/<pid>/environ. NOT on `agent_session.value`: that
// id drifts. Verified on this machine — a session that had been through
// `/rewind` reported the pre-rewind id to Herdr while the plugin read the
// current one, so joining there invents a phantom card on every rewind or
// resume.

import { validHerdrPaneId, type HerdrRequest } from "./herdr-focus";
import { attentionSignal, type AttentionSignal } from "./ai-ops";

// A tick is 4 s and this call measured 4-6 ms. A hung socket must not spend
// the focus path's 1.5 s budget on every tick, so this read gives up early
// and the session simply keeps its title-derived state for that tick.
export const HERDR_STATUS_TIMEOUT_MS = 600;
export const HERDR_MAX_AGENTS = 128;
const MAX_TITLE = 180;

export const HERDR_STATUSES = ["working", "blocked", "done", "idle", "unknown"] as const;
export type HerdrStatus = (typeof HERDR_STATUSES)[number];

export type HerdrAgent = { paneId: string; status: HerdrStatus; title: string };
export type HerdrAgents = Record<string, HerdrAgent>;

export function herdrAgentListRequest(): HerdrRequest {
  return { id: "infomarchy:agents", method: "agent.list", params: {} };
}

// Any token Herdr has not documented is "unknown" rather than dropped: an
// agent Herdr reports but the desk cannot classify must still fall back to
// the title heuristics, not silently become idle.
export function herdrStatusOf(value: unknown): HerdrStatus {
  const status = String(value || "").trim().toLowerCase();
  return (HERDR_STATUSES as readonly string[]).includes(status) ? status as HerdrStatus : "unknown";
}

// Titles reach a Text element and an attention detail, never a shell.
function titleText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

// Output of `agent.list`, keyed by pane id. Returns null when the reply is not
// an agent list at all (a missing socket, a deadline and an error reply all
// arrive here as null from sendHerdrCommand), so the caller can tell "Herdr
// said nothing" from "Herdr knows about no agents".
export function parseHerdrAgents(result: unknown): HerdrAgents | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const rows = (result as Record<string, unknown>).agents;
  if (!Array.isArray(rows)) return null;
  const agents: HerdrAgents = {};
  for (const row of rows.slice(0, HERDR_MAX_AGENTS)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const paneId = validHerdrPaneId(entry.pane_id);
    if (!paneId) continue;
    agents[paneId] = {
      paneId,
      status: herdrStatusOf(entry.agent_status),
      // The stripped title is the same text without the status glyph Herdr
      // prepends; the raw one is the fallback for an older Herdr.
      title: titleText(entry.terminal_title_stripped) || titleText(entry.terminal_title),
    };
  }
  return agents;
}

export type HerdrSender = (socketPath: string, request: HerdrRequest, timeoutMs: number) => Promise<any>;

// One read per distinct socket, merged. Realistically there is one Herdr
// server, but the collector derives the socket per session from that session's
// own environment, so two are possible and neither should shadow the other.
// Returns null only when every socket failed — an empty object means Herdr
// answered and hosts no agents.
export async function fetchHerdrAgents(socketPaths: string[], send: HerdrSender, timeoutMs = HERDR_STATUS_TIMEOUT_MS): Promise<HerdrAgents | null> {
  const paths = [...new Set((socketPaths || []).filter(path => typeof path === "string" && path))];
  if (!paths.length) return null;
  const request = herdrAgentListRequest();
  const replies = await Promise.all(paths.map(path => send(path, request, timeoutMs).then(parseHerdrAgents).catch(() => null)));
  let merged: HerdrAgents | null = null;
  for (const reply of replies) {
    if (!reply) continue;
    merged = Object.assign(merged || {}, reply);
  }
  return merged;
}

// ---------------------------------------------------------------- places

// The card used to print the coordinates the click aims at: "Herdr wB / wB:t1
// / wB:p1". Those are the ids `pane.focus` needs, and they say nothing to the
// person reading the desk — wB is not a place anyone recognises, and it
// appears three times over because the tab and pane ids repeat it.
//
// Herdr already knows the names its own UI shows. `workspace.list` and
// `tab.list` each carry a `label`, and the three reads together measured 3-5 ms
// over the same socket, so the card can say "herdr ~ › recover" instead. The
// ids stay on the host record: the focus path still needs them, and the
// right-click inspector still prints them, which is where you want them when a
// click misses.
//
// An unnamed tab labels itself with its ordinal ("4"), because that is what
// Herdr's own UI shows for it. Matching the UI is the point, so that is
// forwarded as-is rather than dressed up.
const MAX_PLACE_LABEL = 48;
export const HERDR_MAX_PLACES = 256;
const HERDR_WORKSPACE_ID = /^w[A-Za-z0-9_-]{1,32}$/;
const HERDR_TAB_ID = /^w[A-Za-z0-9_-]{1,32}:t[A-Za-z0-9_-]{1,32}$/;

export type HerdrPlaces = { workspaces: Record<string, string>; tabs: Record<string, string> };

export function herdrWorkspaceListRequest(): HerdrRequest {
  return { id: "infomarchy:workspaces", method: "workspace.list", params: {} };
}
export function herdrTabListRequest(): HerdrRequest {
  return { id: "infomarchy:tabs", method: "tab.list", params: {} };
}

// A label is a name a human typed; it reaches a Text element and nothing else,
// but it is still stripped of control characters and bounded like every other
// string the collector forwards.
function placeLabel(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PLACE_LABEL);
}

function labelsById(result: unknown, collection: string, idField: string, valid: RegExp): Record<string, string> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const rows = (result as Record<string, unknown>)[collection];
  if (!Array.isArray(rows)) return null;
  const labels: Record<string, string> = {};
  for (const row of rows.slice(0, HERDR_MAX_PLACES)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const id = String(entry[idField] || "");
    if (!valid.test(id)) continue;
    // Herdr falls back to the ordinal itself when nothing was named, so an
    // empty label here means the row carried none at all — skip it and let
    // the caller fall back to the id form rather than print a blank name.
    const label = placeLabel(entry.label) || placeLabel(entry.number);
    if (label) labels[id] = label;
  }
  return labels;
}

// Returns null when neither list arrived, so the caller keeps the id form
// instead of showing a half-named line.
export function parseHerdrPlaces(workspaceResult: unknown, tabResult: unknown): HerdrPlaces | null {
  const workspaces = labelsById(workspaceResult, "workspaces", "workspace_id", HERDR_WORKSPACE_ID);
  const tabs = labelsById(tabResult, "tabs", "tab_id", HERDR_TAB_ID);
  if (!workspaces && !tabs) return null;
  return { workspaces: workspaces || {}, tabs: tabs || {} };
}

export async function fetchHerdrPlaces(socketPaths: string[], send: HerdrSender, timeoutMs = HERDR_STATUS_TIMEOUT_MS): Promise<HerdrPlaces | null> {
  const paths = [...new Set((socketPaths || []).filter(path => typeof path === "string" && path))];
  if (!paths.length) return null;
  const replies = await Promise.all(paths.map(path => Promise.all([
    send(path, herdrWorkspaceListRequest(), timeoutMs).catch(() => null),
    send(path, herdrTabListRequest(), timeoutMs).catch(() => null),
  ]).then(([workspaces, tabs]) => parseHerdrPlaces(workspaces, tabs)).catch(() => null)));
  let merged: HerdrPlaces | null = null;
  for (const reply of replies) {
    if (!reply) continue;
    merged = {
      workspaces: Object.assign(merged?.workspaces || {}, reply.workspaces),
      tabs: Object.assign(merged?.tabs || {}, reply.tabs),
    };
  }
  return merged;
}

// "herdr ~ › recover". The kind stays in front because a workspace can be
// named "~", which alone reads as a path, and because a desk can host tmux and
// Boomux sessions in the same row of cards. Returns "" when Herdr named
// neither the workspace nor the tab, and the caller keeps the id form.
export function herdrPlaceLabel(workspaceId: unknown, tabId: unknown, places: HerdrPlaces | null): string {
  if (!places) return "";
  const workspace = places.workspaces[String(workspaceId || "")] || "";
  const tab = places.tabs[String(tabId || "")] || "";
  const named = [workspace, tab].filter(Boolean).join(" \u203a ");
  return named ? "herdr " + named : "";
}

// ---------------------------------------------------------------- verdicts

// Herdr's `working` is the only status that means "producing output now".
// null means Herdr has no confident opinion, and the caller keeps its own
// signals — Claude's registry, the systemd turn inhibitor, the title regex.
export function herdrBusy(status: unknown): boolean | null {
  const known = herdrStatusOf(status);
  return known === "unknown" ? null : known === "working";
}

export type HerdrAttention = { known: boolean; signal: AttentionSignal | null };

// The attention signal Herdr's detection implies, in the desk's precedence:
//
//   1. a verifiable failure — merge conflicts, which come from git, not from a
//      string. Herdr can see an agent happily working inside a conflicted
//      tree; the conflict is still the thing that needs a human.
//   2. Herdr's own classification.
//   3. `unknown`, or a session Herdr does not host → the caller's fallback.
//
// Only the first tier is allowed to outrank Herdr, and only because it is a
// fact rather than a reading of a title. A title that merely contains "error"
// or "failed" loses to a confident Herdr status — that regex is exactly what
// this module exists to stop trusting.
export function herdrAttention(status: unknown, detail: unknown, conflicts = 0): HerdrAttention {
  const known = herdrStatusOf(status);
  if (known === "unknown") return { known: false, signal: null };
  const text = titleText(detail);
  if (Number(conflicts) > 0) return { known: true, signal: attentionSignal(text, Number(conflicts)) };
  switch (known) {
    case "blocked":
      return { known: true, signal: { state: "waiting", reason: "an approval or question is on screen", action: "answer", detail: text } };
    case "done":
      return { known: true, signal: { state: "done", reason: "finished work you have not seen", action: "review", detail: text } };
    // working and idle are both "nothing needs you".
    default:
      return { known: true, signal: null };
  }
}

// The pane a session runs in, or "" when it is not hosted by Herdr. The
// collector already validated this id when it built the host; re-checked here
// because it becomes a lookup key and, later, a focus target.
export function herdrPaneOf(session: unknown): string {
  const hosts = (session as Record<string, any>)?.hosts;
  if (!Array.isArray(hosts)) return "";
  for (const host of hosts) if (host && host.kind === "herdr") return validHerdrPaneId(host.paneId);
  return "";
}

// Every distinct Herdr socket the live sessions actually reference. Empty when
// nothing is Herdr-hosted, which is what lets the collector skip the socket
// entirely rather than dialling it on every tick for nothing.
export function herdrSocketsOf(sessions: unknown[], fallbackSocket = ""): string[] {
  const sockets = new Set<string>();
  for (const session of sessions || []) {
    const hosts = (session as Record<string, any>)?.hosts;
    if (!Array.isArray(hosts)) continue;
    for (const host of hosts) {
      if (!host || host.kind !== "herdr") continue;
      const socket = typeof host.socket === "string" && host.socket ? host.socket : fallbackSocket;
      if (socket) sockets.add(socket);
    }
  }
  return [...sockets];
}

// How urgently a session wants the human, for the session carousel's order.
// A carousel can push a card out of sight, so it may only ever hide an idle
// one: whatever needs an answer sorts first, then unseen finished work, then
// what is still running.
export const HERDR_URGENCY = ["waiting", "blocked", "done", "working", "idle"] as const;
export function sessionUrgency(session: unknown): number {
  const item = (session || {}) as Record<string, any>;
  const attention = String(item.attention || "");
  if (attention === "blocked" || attention === "waiting") return 0;
  if (attention === "done") return 1;
  if (item.busy === true) return 2;
  return 3;
}

// Ordered for a carousel, which can push a card off the visible strip: the
// most urgent first, so the only thing it can ever hide is an idle session.
// Within a group the order is the one the desk already had — newest first,
// with pid as the final tiebreak — so cards keep a stable place across ticks
// instead of swapping under the cursor while nothing has actually changed.
export function sortSessionsByUrgency<T>(sessions: T[]): T[] {
  return [...(sessions || [])].sort((a, b) => {
    const left = (a || {}) as Record<string, any>, right = (b || {}) as Record<string, any>;
    return sessionUrgency(a) - sessionUrgency(b)
      || Number(right.startedAt || 0) - Number(left.startedAt || 0)
      || Number(left.pid || 0) - Number(right.pid || 0);
  });
}
