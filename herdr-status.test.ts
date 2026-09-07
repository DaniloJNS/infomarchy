import { describe, expect, test } from "bun:test";
import {
  HERDR_MAX_AGENTS, HERDR_STATUS_TIMEOUT_MS, fetchHerdrAgents, herdrAgentListRequest,
  herdrAttention, herdrBusy, herdrPaneOf, herdrSocketsOf, herdrStatusOf, parseHerdrAgents,
  sessionUrgency,
} from "./herdr-status.ts";
import { HERDR_TIMEOUT_MS } from "./herdr-focus.ts";

// The shape below is `agent.list`'s real reply, captured from Danilo's Herdr
// on 2026-09-07 (six panes, one working, the rest idle). `terminal_title_stripped`
// and `workspace_id` are in it too, which the field list in the docs omits.
function agentRow(paneId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    terminal_id: "term_65ad8ac7a20921",
    agent: "claude",
    terminal_title: "✳ " + status + " thing",
    terminal_title_stripped: status + " thing",
    agent_status: status,
    agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "066eb229-08ee-45f6-996c-19fa04c1c847" },
    workspace_id: paneId.split(":")[0],
    tab_id: paneId.split(":")[0] + ":t1",
    pane_id: paneId,
    focused: false,
    state_change_seq: 107,
    cwd: "/home/danilo",
    foreground_cwd: "/home/danilo",
    revision: 17,
    ...overrides,
  };
}
function listResult(rows: unknown[]) { return { type: "agent_list", agents: rows }; }
function herdrSession(paneId: string, overrides: Record<string, unknown> = {}) {
  return { hosts: [{ kind: "herdr", label: "Herdr", paneId, workspaceId: paneId.split(":")[0], tabId: paneId.split(":")[0] + ":t1" }], ...overrides };
}

describe("herdr agent.list parsing", () => {
  test("keys the agents by pane id and keeps the stripped title", () => {
    const agents = parseHerdrAgents(listResult([agentRow("wB:p1", "done"), agentRow("wB:p5", "working")]));
    expect(Object.keys(agents!)).toEqual(["wB:p1", "wB:p5"]);
    expect(agents!["wB:p5"]).toEqual({ paneId: "wB:p5", status: "working", title: "working thing" });
  });

  test("falls back to the unstripped title when Herdr sends no stripped one", () => {
    const agents = parseHerdrAgents(listResult([agentRow("wB:p1", "idle", { terminal_title_stripped: undefined })]));
    expect(agents!["wB:p1"].title).toBe("✳ idle thing");
  });

  test("an empty agent list is not the same as no answer", () => {
    // Herdr answered and hosts nothing: every session falls back, but nothing
    // is broken. A failed read is null, and the caller must tell them apart.
    expect(parseHerdrAgents(listResult([]))).toEqual({});
    expect(parseHerdrAgents(null)).toBeNull();
  });

  test("rejects a malformed reply instead of throwing inside the collector", () => {
    for (const bad of [null, undefined, "", "agent_list", 7, [], [agentRow("wB:p1", "idle")], {}, { agents: null }, { agents: "wB:p1" }, { agents: {} }])
      expect(parseHerdrAgents(bad as unknown)).toBeNull();
    // Rows that are not objects, or carry no usable pane id, are dropped.
    const agents = parseHerdrAgents(listResult([
      null, "nonsense", 42, [],
      agentRow("", "idle"),
      agentRow("not-a-pane", "idle"),
      { ...agentRow("wB:p1", "idle"), pane_id: { evil: true } },
      agentRow("wB:p9", "idle"),
    ]));
    expect(Object.keys(agents!)).toEqual(["wB:p9"]);
  });

  test("caps the roster so a hostile or runaway reply cannot bury the desk", () => {
    const many = Array.from({ length: HERDR_MAX_AGENTS + 40 }, (_, i) => agentRow(`wB:p${i.toString(36)}`, "idle"));
    expect(Object.keys(parseHerdrAgents(listResult(many))!).length).toBeLessThanOrEqual(HERDR_MAX_AGENTS);
  });

  test("titles are text, never objects or control characters", () => {
    const agents = parseHerdrAgents(listResult([
      { ...agentRow("wB:p1", "idle"), terminal_title_stripped: { toString: () => "nope" }, terminal_title: "line\nbreak\ttabbed" },
      { ...agentRow("wB:p2", "idle"), terminal_title_stripped: "x".repeat(400), terminal_title: "" },
    ]));
    expect(agents!["wB:p1"].title).toBe("line break tabbed");
    expect(agents!["wB:p2"].title).toHaveLength(180);
  });
});

describe("the status vocabulary", () => {
  test("keeps Herdr's five documented tokens", () => {
    for (const status of ["working", "blocked", "done", "idle", "unknown"]) expect(herdrStatusOf(status)).toBe(status);
    expect(herdrStatusOf(" WORKING ")).toBe("working");
  });

  test("anything undocumented is unknown, never silently idle", () => {
    // An agent Herdr reports but the desk cannot classify has to fall back to
    // the title heuristics; reading it as idle would claim it needs nothing.
    for (const odd of ["", "busy", "running", "waiting", null, undefined, {}, 7, "idle-ish"])
      expect(herdrStatusOf(odd as unknown)).toBe("unknown");
  });
});

describe("busy comes from Herdr, not the title", () => {
  test("only working means producing output now", () => {
    expect(herdrBusy("working")).toBe(true);
    expect(herdrBusy("idle")).toBe(false);
    expect(herdrBusy("done")).toBe(false);
    expect(herdrBusy("blocked")).toBe(false);
  });

  test("no confident status yields no opinion, so the caller keeps its own", () => {
    // null, not false: Claude's registry and the systemd turn inhibitor are
    // still allowed to say the session is busy.
    expect(herdrBusy("unknown")).toBeNull();
    expect(herdrBusy("")).toBeNull();
    expect(herdrBusy(undefined)).toBeNull();
  });
});

describe("attention mapping and precedence", () => {
  test("Herdr's blocked is the desk's waiting, not the desk's blocked", () => {
    // Herdr's blocked means "an approval or question UI is on screen". The
    // desk's blocked means a failure. Mapping by name would paint every
    // permission prompt as a red failure.
    const verdict = herdrAttention("blocked", "Bash(rm -rf build)");
    expect(verdict.known).toBe(true);
    expect(verdict.signal).toMatchObject({ state: "waiting", action: "answer" });
    expect(verdict.signal!.state).not.toBe("blocked");
  });

  test("done is finished-and-unseen, and asks for a review", () => {
    const verdict = herdrAttention("done", "Ingest replay queue");
    expect(verdict.signal).toMatchObject({ state: "done", action: "review", detail: "Ingest replay queue" });
  });

  test("working and idle need nothing, but are still a confident answer", () => {
    for (const status of ["working", "idle"]) {
      const verdict = herdrAttention(status, "anything at all");
      expect(verdict.known).toBe(true);
      expect(verdict.signal).toBeNull();
    }
  });

  test("unknown defers to the caller's fallback", () => {
    expect(herdrAttention("unknown", "waiting for permission")).toEqual({ known: false, signal: null });
    expect(herdrAttention("", "waiting for permission")).toEqual({ known: false, signal: null });
  });

  // The three worked examples from the spec.
  test("working plus merge conflicts is BLOCKED — a git fact outranks Herdr", () => {
    const verdict = herdrAttention("working", "Implementing the parser", 3);
    expect(verdict.known).toBe(true);
    expect(verdict.signal).toMatchObject({ state: "blocked", action: "resolve" });
    expect(verdict.signal!.reason).toBe("3 merge conflicts need resolution");
  });

  test("blocked plus a clean title is WAITING", () => {
    expect(herdrAttention("blocked", "Editing collector.ts").signal).toMatchObject({ state: "waiting" });
  });

  test("done plus a title containing 'error' is DONE — Herdr beats the regex", () => {
    // attentionSignal() would call this a failure off `/\berror\s*:/`. That
    // regex is exactly what this module exists to stop trusting.
    const verdict = herdrAttention("done", "Fixed the error: timeout on retry");
    expect(verdict.signal!.state).toBe("done");
    expect(verdict.signal!.state).not.toBe("blocked");
  });

  test("the conflict signal is attentionSignal's own, wording and all", () => {
    // Deliberately not reworded here: this string is part of the notification
    // dedup key, and the desk's singular has always read "conflict need"
    // (ai-ops.ts pluralises the noun but not the verb). Fixing that typo
    // re-fires every conflict alert once, so it is not this commit's business.
    expect(herdrAttention("idle", "x", 1).signal!.reason).toBe("1 merge conflict need resolution");
    expect(herdrAttention("idle", "x", 2).signal!.reason).toBe("2 merge conflicts need resolution");
  });
});

describe("joining sessions to panes", () => {
  test("reads the pane id off the session's own Herdr host", () => {
    expect(herdrPaneOf(herdrSession("wD:p2"))).toBe("wD:p2");
  });

  test("a session Herdr does not host has no pane", () => {
    expect(herdrPaneOf({ hosts: [{ kind: "tmux", paneId: "%4" }] })).toBe("");
    expect(herdrPaneOf({ hosts: [] })).toBe("");
    expect(herdrPaneOf({})).toBe("");
    expect(herdrPaneOf(null)).toBe("");
    // A tmux pane id must never be mistaken for a Herdr one.
    expect(herdrPaneOf({ hosts: [{ kind: "herdr", paneId: "%4" }] })).toBe("");
  });

  test("the join is on pane id, never on agent_session.value", () => {
    // Verified live: a session that had been through /rewind reported its
    // PRE-rewind id to Herdr while the plugin read the current one. Joining
    // there invents a phantom card on every rewind or resume, so the parsed
    // roster does not even carry the session id.
    const agents = parseHerdrAgents(listResult([
      agentRow("wB:p1", "done", { agent_session: { agent: "claude", kind: "id", value: "066eb229-08ee-45f6-996c-19fa04c1c847" } }),
    ]));
    expect(JSON.stringify(agents)).not.toContain("066eb229");
    // The plugin's own id for that pane has drifted, and the join still works.
    const session = herdrSession("wB:p1", { session: "c4830594-1111-2222-3333-444455556666" });
    expect(agents![herdrPaneOf(session)].status).toBe("done");
  });

  test("collects the distinct sockets the live sessions actually reference", () => {
    const sessions = [
      herdrSession("wB:p1", { hosts: [{ kind: "herdr", paneId: "wB:p1", socket: "/run/a.sock" }] }),
      herdrSession("wB:p2", { hosts: [{ kind: "herdr", paneId: "wB:p2", socket: "/run/a.sock" }] }),
      herdrSession("wB:p3", { hosts: [{ kind: "herdr", paneId: "wB:p3", socket: "/run/b.sock" }] }),
      { hosts: [{ kind: "tmux", paneId: "%1" }] },
    ];
    expect(herdrSocketsOf(sessions, "/run/default.sock")).toEqual(["/run/a.sock", "/run/b.sock"]);
    // A Herdr host with no socket of its own falls back to the default.
    expect(herdrSocketsOf([herdrSession("wB:p1")], "/run/default.sock")).toEqual(["/run/default.sock"]);
  });

  test("nothing Herdr-hosted means the socket is never dialled", () => {
    // The whole point: a machine without Herdr pays nothing for this feature.
    expect(herdrSocketsOf([{ hosts: [{ kind: "tmux", paneId: "%1" }] }, {}], "/run/default.sock")).toEqual([]);
    expect(herdrSocketsOf([], "/run/default.sock")).toEqual([]);
    expect(herdrSocketsOf(null as unknown as unknown[], "/run/default.sock")).toEqual([]);
  });
});

describe("reading the socket", () => {
  test("asks for agent.list with no parameters", () => {
    expect(herdrAgentListRequest()).toEqual({ id: "infomarchy:agents", method: "agent.list", params: {} });
  });

  test("gives up early: a tick is 4 s and this read measured 4-6 ms", () => {
    expect(HERDR_STATUS_TIMEOUT_MS).toBeLessThan(HERDR_TIMEOUT_MS);
    expect(HERDR_STATUS_TIMEOUT_MS).toBeGreaterThanOrEqual(300);
  });

  test("reads each socket once and merges the rosters", async () => {
    const calls: Array<{ path: string; timeoutMs: number }> = [];
    const send = async (path: string, _request: unknown, timeoutMs: number) => {
      calls.push({ path, timeoutMs });
      return listResult([agentRow(path === "/run/a.sock" ? "wB:p1" : "wD:p1", "working")]);
    };
    const agents = await fetchHerdrAgents(["/run/a.sock", "/run/b.sock", "/run/a.sock"], send, 500);
    expect(calls.map(call => call.path)).toEqual(["/run/a.sock", "/run/b.sock"]);   // deduplicated
    expect(calls.every(call => call.timeoutMs === 500)).toBe(true);
    expect(Object.keys(agents!).sort()).toEqual(["wB:p1", "wD:p1"]);
  });

  test("a missing or timed-out socket is null, and the desk keeps its own state", async () => {
    expect(await fetchHerdrAgents(["/run/a.sock"], async () => null, 500)).toBeNull();
    // Bun.connect throws synchronously on a malformed path; a rejection here
    // would take the whole collector tick down with it.
    expect(await fetchHerdrAgents(["/run/a.sock"], async () => { throw new Error("ECONNREFUSED"); }, 500)).toBeNull();
    expect(await fetchHerdrAgents([], async () => listResult([]), 500)).toBeNull();
    expect(await fetchHerdrAgents(["", null as unknown as string], async () => listResult([]), 500)).toBeNull();
  });

  test("one dead socket does not discard a live one's roster", async () => {
    const send = async (path: string) => (path === "/run/dead.sock" ? null : listResult([agentRow("wB:p1", "blocked")]));
    const agents = await fetchHerdrAgents(["/run/dead.sock", "/run/live.sock"], send, 500);
    expect(agents).toEqual({ "wB:p1": { paneId: "wB:p1", status: "blocked", title: "blocked thing" } });
  });

  test("a garbled reply is null, not a crash", async () => {
    expect(await fetchHerdrAgents(["/run/a.sock"], async () => "<html>404</html>", 500)).toBeNull();
    expect(await fetchHerdrAgents(["/run/a.sock"], async () => ({ result: "nested wrong" }), 500)).toBeNull();
  });
});

describe("carousel order", () => {
  test("ranks by urgency, because a carousel can push a card out of sight", () => {
    // It may only ever hide an idle session.
    expect(sessionUrgency({ attention: "waiting" })).toBe(0);
    expect(sessionUrgency({ attention: "blocked" })).toBe(0);
    expect(sessionUrgency({ attention: "done" })).toBe(1);
    expect(sessionUrgency({ busy: true })).toBe(2);
    expect(sessionUrgency({})).toBe(3);
    expect(sessionUrgency(null)).toBe(3);
  });

  test("a busy session that also needs an answer still sorts first", () => {
    expect(sessionUrgency({ attention: "waiting", busy: true })).toBe(0);
    expect(sessionUrgency({ attention: "done", busy: true })).toBe(1);
  });

  test("orders a realistic desk so nothing that needs the human is hidden", () => {
    const sessions = [
      { project: "sonar", attention: "", busy: false },
      { project: "atlas", attention: "", busy: true },
      { project: "relay", attention: "done", busy: false },
      { project: "orbit", attention: "waiting", busy: false },
    ];
    const ordered = [...sessions].sort((a, b) => sessionUrgency(a) - sessionUrgency(b)).map(s => s.project);
    expect(ordered).toEqual(["orbit", "relay", "atlas", "sonar"]);
  });
});
