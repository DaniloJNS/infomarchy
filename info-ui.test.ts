import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const settings = readFileSync(join(import.meta.dir, "InfoSettings.qml"), "utf8");
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");
const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
const collector = readFileSync(join(import.meta.dir, "collector.ts"), "utf8");
const herdrStatus = readFileSync(join(import.meta.dir, "herdr-status.ts"), "utf8");
const focus = readFileSync(join(import.meta.dir, "herdr-focus.ts"), "utf8");

describe("interactive information modules", () => {
  test("reordering skips hidden cards instead of producing a visual no-op", () => {
    const source = settings.match(/function adjacentEnabledIndex\([\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const adjacentEnabledIndex = Function(`return (${source})`)();
    expect(adjacentEnabledIndex(["usage", "localAi", "machine"], 0, 1, { localAi: false })).toBe(2);
    expect(adjacentEnabledIndex(["changes", "needs", "projects"], 2, -1, { needs: false })).toBe(0);
    expect(adjacentEnabledIndex(["usage", "localAi", "machine"], 0, -1, {})).toBe(0);
    expect(settings).toContain("adjacentEnabledIndex(next, from, direction, sections)");
  });

  test("persists seen change fingerprints and exposes the optional change module", () => {
    expect(settings).toContain('{ id: "changes", label: "CHANGES" }');
    expect(settings).toContain("property var seenChanges");
    expect(settings).toContain("function markChangeSeen");
    expect(view).toContain('title: "WHAT CHANGED"');
    expect(view).toContain("view.settings.markChangeSeen");
    expect(view).toContain("changeRow.change.files");
  });

  test("renders specific next-action reasons and contextual controls", () => {
    expect(settings).toContain('{ id: "needs", label: "NEXT ACTIONS" }');
    expect(view).toContain('title: "NEXT ACTIONS"');
    expect(view).toContain("attentionReason");
    expect(view).toContain("attentionPrimaryLabel");
    expect(view).toContain('text: "COPY DETAIL"');
    expect(view).toContain("activateAttention");
  });

  test("renders removable, reorderable project health with dashboard filtering", () => {
    expect(settings).toContain('{ id: "projects", label: "PROJECTS" }');
    expect(settings).toContain('property var opsOrder: ["changes", "needs", "projects"]');
    expect(settings).toContain("function enabledOpsCount");
    expect(settings).toContain("function opsVisibleIndex");
    expect(settings).toContain("function moveOps");
    expect(view).toContain('title: "PROJECT HEALTH"');
    expect(view).toContain('moveGroup: "ops"');
    expect(view).toContain('dragAxis: "horizontal"');
    expect(view).toContain("property string projectFilter");
    expect(view).toContain("function projectMatches");
    expect(view).toContain("readonly property var visibleCollisions");
    expect(view).toContain("view.projectFilter === projectRow.key");
    expect(view).toContain('text: "1–9, 0 MODULES');
    expect(view).toContain('"SUPER+I HIDE DESK · SUPER+D SHOW OVER WINDOWS"');
    expect(view).toContain('"SUPER+I HIDE DESK · SUPER+D / ESC CLOSE"');
    expect(overlay).toContain("event.key <= Qt.Key_9");
  });

  test("shows multiplexer hosting context on live cards and the inspector", () => {
    expect(view).toContain("function sessionHostLabel");
    expect(view).toContain("function sessionHostDetail");
    expect(view).toContain("text: view.sessionHostLabel");
    expect(view).toContain("view.sessionHostDetail(sessionInspector.session)");
    // Names on the card, ids in the inspector: the card reads "herdr ~ › recover"
    // while sessionHostDetail keeps the wB / wB:t1 / wB:p1 the click aims at.
    expect(view).toContain('if (host.kind === "herdr") return "Herdr " + [host.workspaceId, host.tabId, host.paneId]');
    // The click hint is conditional now. It was appended on every card, so the
    // 25 identical characters elided away the one case worth reading.
    expect(view).not.toContain('" · click jumps to the pane"');
    expect(view).toContain('" · click attaches a terminal"');
    expect(view).toContain('" · no client window found"');
  });

  test("offers safe selectable Ollama load and unload controls", () => {
    expect(settings).toContain("property string selectedOllamaModel");
    expect(settings).toContain("function setSelectedOllamaModel");
    expect(model).toContain('ollamaControlPath: Qt.resolvedUrl("ollama-control.ts")');
    expect(model).toContain("ollamaProcess.pendingFrame");
    expect(model).toContain("write(JSON.stringify(pendingFrame)");
    expect(view).toContain("function needsConfirmation");
    expect(view).toContain('view.desk.controlOllama("load"');
    expect(view).toContain('view.desk.controlOllama("unload"');
    expect(view).toContain('"CONFIRM"');
  });

  test("deduplicates configurable attention and lifecycle notifications", () => {
    expect(settings).toContain("property var notificationEvents");
    expect(settings).toContain("function claimNotificationEvent");
    expect(settings).toContain("function notificationsAllowed");
    expect(settings).toContain("function toggleNotificationProvider");
    expect(view).toContain('text: "ALERTS "');
    // The chip must reflect the configured window, not a hardcoded 22–08.
    expect(view).toContain('text: "QUIET " + (view.settings.quietStartHour < 10 ? "0" : "") + view.settings.quietStartHour');
    expect(view).not.toContain('"QUIET 22–08 "');
    expect(service).toContain('"omarchy-notification-send"');
    expect(service).toContain("dashboardSettings.claimNotificationEvent");
    expect(service).toContain('"nixfred.infomarchy", "{}"');
  });
});

describe("usage trend chart", () => {
  test("renders a per-provider 7-day series with a tokens / value toggle and estimated value lines", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain('property string usageMetric: "tokens"');
    expect(view).toContain("readonly property var usageSeries");
    expect(view).toContain("id: trendCanvas");
    expect(view).toContain('text: view.usageMetric === "value" ? "≈ $ VALUE" : "TOKENS"');
    expect(view).toContain("usageTrend.hovered");
    expect(view).toContain('"% cache reads"');
    expect(view).toContain('"unpriced"');
  });
});

describe("multiplexer-aware focus", () => {
  test("cards, attention rows and the inspector jump into the hosting multiplexer", () => {
    const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(model).toContain("function focusHerdrPane(host)");
    expect(model).toContain('["bun", root.herdrFocusPath, sock, workspace, tab, pane]');
    expect(model).toContain('["select-window", "-t", pane]');
    expect(model).not.toContain('["pane", "focus", "--pane", pane]');
    expect(view).toContain("else if (view.desk.focusSession(sc.modelData)) view.navigated()");
    expect(model).toContain("function focusBoomuxShell(host)");
    expect(model).toContain('["boomux", "open", shell]');
    expect(view).toContain("view.desk.focusSession(item); view.navigated(); return true");
    expect(view).toContain("view.desk.focusSession(sessionInspector.session)");
  });
});

describe("overlay shows the real desktop", () => {
  test("SUPER+D paints the wallpaper, and SUPER+I applies inside the overlay", () => {
    const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");
    expect(overlay).toContain("source: Util.fileUrl(root.background)");
    expect(overlay).toContain("opacity: dashboardSettings.ready && dashboardSettings.dashboardVisible ? root.wallpaperOpacity : 1.0");
    expect(overlay).toContain("visible: dashboardSettings.ready && dashboardSettings.dashboardVisible\n          onNavigated: root.close()");
    expect(overlay).not.toContain("Util.alpha(infoModel.themeBackground, 0.88)");
  });
});

describe("background sessions are reachable", () => {
  test("a card with a background host attaches a terminal on click", () => {
    const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(model).toContain("function attachBackground(session)");
    expect(model).toContain('["bun", root.resumePath, "claude-attach", id, String(item.cwd || "")]');
    expect(view).toContain('" · click attaches a terminal"');
  });
});

describe("zombie cleanup is explicit and two-click", () => {
  test("cards flag STALE and the inspector offers STOP SESSION / END PROCESS with confirmation", () => {
    const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain('text: "STALE · idle "');
    expect(view).toContain('text: armed ? "CONFIRM STOP" : "STOP SESSION"');
    expect(view).toContain('text: armed ? "CONFIRM END (SIGTERM)" : "END PROCESS"');
    expect(model).toContain('["bun", root.stopPath, "claude-stop", String(item.jobId)]');
    expect(model).toContain('["bun", root.stopPath, "term", String(Number(item.pid)), String(Math.round(Number(item.startedAt)))]');
  });
});

describe("right column fits a 1080p desk", () => {
  test("MACHINE is a two-column grid with a one-line footer, and the SUPER legend sits under it", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain("// Cockpit density: two meters per row");
    expect(view).toContain('text: "WAN " + (view.machine.externalIp || "—")');
    expect(view).toContain('"SUPER+I hide desk  ·  SUPER+D show desktop") + "  ·  right-click a card to inspect"');
    expect(view).toContain("readonly property int metaWidth");
  });
});

describe("LOCAL AI rows stay inside the card body", () => {
  const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
  test("the provider chips are a Flow, so no rigid row can raise the column minimum above the body width", () => {
    // Four rigid Tags in a RowLayout gave the column a 514 px minimum in a 512 px body: every
    // row then laid out 2 px past the clip and lost its right border. A Flow has no minimum.
    const start = view.indexOf("id: provRow");
    const opener = view.lastIndexOf("{", start);
    const type = view.slice(view.lastIndexOf("\n", opener) + 1, opener).trim();
    expect(type).toBe("Flow");
    expect(view.slice(start, view.indexOf("\n            }", start))).not.toContain("Item { Layout.fillWidth: true }");
  });
  test("the live geometry report is exposed over IPC for measuring, not guessing", () => {
    expect(view).toContain("function geometryReport(): string");
    const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
    expect(service).toContain("function geometry(): string { return root.deskView ? root.deskView.geometryReport() : \"{}\" }");
  });
});

describe("session card lines never spill into the neighbouring card", () => {
  test("every fill-width single-line text in a session card elides", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    const start = view.indexOf("text: view.sessionHostLabel(sc.modelData)");
    const block = view.slice(view.lastIndexOf("ColumnLayout", start), view.indexOf("\n                }", start));
    // The merged pid/cpu line had no elide: the taller first card's line ran under its
    // neighbour's git line ("git mainc·uclean · ram 360M"). Fill-width, one line ⇒ elide.
    for (const line of block.split("\n").filter(l => l.includes("PlainText {") && l.includes("Layout.fillWidth: true") && !l.includes("wrapMode")))
      expect(line).toMatch(/elide: Text\.Elide(Right|Middle|Left)/);
  });
});

describe("github activity heatmap", () => {
  test("registers GITHUB as a removable module beside ACTIVITY and reaches it from the keyboard", () => {
    const ids = [...settings.matchAll(/\{ id: "([a-zA-Z]+)", label: "[^"]+" \}/g)].map(match => match[1]);
    expect(ids.indexOf("github")).toBe(ids.indexOf("activity") + 1);
    // The number keys map definition indices 0-9, so the first ten are the
    // keyboard-reachable ones and must keep their exact positions. Modules
    // past the tenth are chip-only by design (see githubYou below).
    expect(ids.slice(0, 10)).toEqual(["needs", "sessions", "activity", "github", "recent", "usage", "localAi", "machine", "changes", "projects"]);
    expect(overlay).toContain("event.key >= Qt.Key_0 && event.key <= Qt.Key_9");
    expect(overlay).toContain("event.key === Qt.Key_0 ? 9 : event.key - Qt.Key_1");
    // Key n toggles definitions[n-1]; 0 is the tenth. Documented as 4 = GITHUB, 0 = PROJECTS.
    expect(ids[3]).toBe("github");
    expect(ids[9]).toBe("projects");
  });

  test("splits the activity row into two half-width heatmap cards sharing one HeatPanel", () => {
    expect(view).toContain("component HeatPanel: Item");
    expect(view.match(/HeatPanel \{/g)).toHaveLength(2);
    expect(view).toContain('title: "ACTIVITY · LAST 7 DAYS"');
    expect(view).toContain('title: "GITHUB · LAST 7 DAYS"');
    expect(view).toContain('visible: view.sectionEnabled("activity") || view.sectionEnabled("github")');
    // Both cards ask for an equal share; neither may impose a minimum that pushes the other off screen.
    expect(view.match(/Layout\.preferredWidth: 1\n\s+Layout\.minimumWidth: 0\n\s+visible: view\.sectionEnabled\("(activity|github)"\)/g)).toHaveLength(2);
    expect(view).toContain("cells: view.github.cells || []");
    expect(view).toContain("kindFiltersCells: true");
    expect(view).toContain("showRepos: true");
  });

  test("explains every GitHub feed state and keeps the AI activity filter wiring intact", () => {
    for (const state of ["missing", "unauthenticated", "pending", "unavailable", "stale", "ok"]) expect(view).toContain(`case "${state}":`);
    expect(view).toContain("run gh auth login");
    expect(view).toContain("onCellClicked: function(index) { view.toggleActivityCell(index) }");
    expect(view).toContain("onKindClicked: function(kind) { view.toggleActivityProvider(kind) }");
    expect(view).toContain("onCellClicked: function(index) { view.toggleGithubCell(index) }");
    expect(view).toContain('githubCellFilter = -1; githubKindFilter = ""');
    // A pinned GitHub cell keeps its breakdown in the status line once the pointer leaves it.
    expect(view).toContain("pinnedBreakdown: true");
    expect(view).toContain('"pinned · " + panel.cellLabel(panel.selectedCell)');
  });
});

describe("GITHUB · YOU", () => {
  test("registers an eleventh, chip-only module without touching the key map", () => {
    expect(settings).toContain('{ id: "githubYou", label: "GITHUB · YOU" }');
    const ids = [...settings.matchAll(/\{ id: "([a-zA-Z]+)", label: "[^"]+" \}/g)].map(match => match[1]);
    // Last, so the ten keyboard-reachable indices keep their meaning.
    expect(ids[ids.length - 1]).toBe("githubYou");
    expect(ids.indexOf("githubYou")).toBeGreaterThan(9);
    // The number keys still map 0-9 only, and the on-screen legend still says so.
    expect(overlay).toContain("event.key === Qt.Key_0 ? 9 : event.key - Qt.Key_1");
    expect(view).toContain('text: "1–9, 0 MODULES');
    // It is a loose card in the left column, not an ops or right-column card.
    expect(settings).toContain('property var rightOrder: ["usage", "localAi", "machine"]');
    expect(settings).toContain('property var opsOrder: ["changes", "needs", "projects"]');
    expect(settings).not.toContain('"githubYou", "');
  });

  test("draws the card between the heatmap row and RECENT TASKS", () => {
    expect(view).toContain('title: "GITHUB · YOU"');
    expect(view).toContain('visible: view.sectionEnabled("githubYou")');
    const heat = view.indexOf('title: "GITHUB · LAST 7 DAYS"');
    const you = view.indexOf('title: "GITHUB · YOU"');
    const recent = view.indexOf('title: "RECENT TASKS · WHAT GOT ASKED"');
    expect(heat).toBeGreaterThan(0);
    expect(you).toBeGreaterThan(heat);
    expect(recent).toBeGreaterThan(you);
  });

  test("two independently scrolling columns, both built from the shared ScrollList", () => {
    expect(view).toContain("component ScrollList: Item");
    expect(view).toContain('text: "MY PRS"');
    expect(view).toContain('text: "REVIEW REQUESTS"');
    // Three lists share one scrollbar implementation; the hand-rolled copy
    // RECENT TASKS grew is gone, not duplicated per column.
    expect(view.match(/ScrollList \{/g)).toHaveLength(3);
    expect(view).not.toContain("recentScrollTrack");
    expect(view).not.toContain("recentScrollThumb");
    // Two, on purpose: the vertical ScrollList and the horizontal ScrollRow.
    // Their wheel mapping, track geometry and edge affordances differ enough
    // that one component parameterised by orientation read worse than two.
    expect(view.match(/function applyWheel/g)).toHaveLength(2);
    expect(view).toContain("component ScrollRow: Item");
    // Each column asks for an equal share and imposes no minimum.
    expect(view.match(/Layout\.preferredHeight: view\.githubYouListHeight/g)).toHaveLength(2);
  });

  test("a PR row carries age, draft, short repo, number, ticket, title and CI", () => {
    expect(view).toContain("view.desk.ago(prRow.modelData.ts)");
    expect(view).toContain('text: "DRAFT"');
    expect(view).toContain("view.shortRepo(prRow.modelData.repo)");
    expect(view).toContain('"#" + Number(prRow.modelData.number || 0)');
    expect(view).toContain("text: String(prRow.modelData.ticket || \"\")");
    expect(view).toContain("view.githubCiMark(prRow.modelData.ci)");
    expect(view).toContain('String(prRow.modelData.review || "") === "REVIEW_REQUIRED"');
    // The owner is stripped from the repository, as RECENT TASKS does.
    expect(view).toContain('function shortRepo(repo) { return String(repo || "").replace(/^.*\\//, "") }');
    // The title is the only elastic cell, so it must elide on one line.
    const prBlock = view.slice(view.indexOf("id: prRow"), view.indexOf("id: prHover"));
    for (const line of prBlock.split("\n").filter(l => l.includes("Layout.fillWidth: true")))
      expect(prBlock.slice(prBlock.indexOf(line))).toContain("elide: Text.ElideRight");
  });

  test("reviews sit above unread notifications, separated by a rule, in one list", () => {
    expect(view).toContain("readonly property var githubYouInbox");
    expect(view).toContain('out.push({ kind: "review", row: reviews[i] })');
    expect(view).toContain('out.push({ kind: "rule", row: null })');
    expect(view).toContain('out.push({ kind: "note", row: notes[j] })');
    // The rule only appears when it actually separates two things.
    expect(view).toContain("if (reviews.length > 0 && notes.length > 0)");
    // A notification is tagged with its reason; a review is numbered.
    expect(view).toContain("view.githubReasonLabel(inboxRow.row.reason)");
    expect(view).toContain('visible: !inboxRow.isNote; text: "#" + Number(inboxRow.row.number || 0)');
    // The rule is not clickable.
    expect(view).toContain("enabled: view.interactive && !inboxRow.isRule");
  });

  test("a click opens the row in a browser and closes the overlay", () => {
    expect(view).toContain("function openGithub(url) { if (view.desk.openUrl(url)) view.navigated() }");
    expect(view).toContain("onTapped: view.openGithub(prRow.modelData.url)");
    expect(view).toContain("onTapped: view.openGithub(inboxRow.row.url)");
    expect(overlay).toContain("onNavigated: root.close()");
    // The model validates the URL before anything is launched: https,
    // github.com, and a launcher that takes one argument.
    expect(model).toContain("function openUrl(url)");
    expect(model).toContain("if (!canOpenUrl(url)) return false");
    expect(model).toContain('Quickshell.execDetached(["omarchy-launch-browser", String(url)])');
    expect(model).toContain("^https:\\/\\/github\\.com\\/");
  });

  test("the hint counts what is waiting, and says why when it cannot", () => {
    expect(view).toContain("hint: view.githubYouHint()");
    expect(view).toContain('" open · "');
    expect(view).toContain('" draft · "');
    expect(view).toContain('" CI✗ · "');
    expect(view).toContain('" unread"');
    // U+2709 is not in the shipped mono font; it rendered as tofu and broke
    // the hint's elide. Only glyphs the font actually has may reach the card.
    expect(view).not.toContain("✉");
    // The same six states, with the same words, as the heatmap's status line.
    for (const message of ["gh not installed", "gh not authenticated", "GitHub unreachable", "stale · "])
      expect(view.slice(view.indexOf("function githubYouStatus"))).toContain(message);
  });

  test("demo mode invents every repository, ticket and author it shows", () => {
    const demo = collector.slice(collector.indexOf("function demoSnapshot"), collector.indexOf("async function runCollector"));
    expect(demo).toContain("const githubYou = {");
    expect(demo).toContain("githubYou,");
    // Demo mode exists so a screenshot can be published; the live card shows
    // private employer repositories and issue keys, and neither may leak.
    for (const real of ["infleet", "hermes", "INFLTECH", "DaniloJNS", "Rebase-BR", "railsdb"])
      expect(demo).not.toContain(real);
    // Every repository named is under the fictional demo owner.
    for (const repo of [...demo.matchAll(/repo: "([^"]+)"/g)].map(match => match[1]))
      expect(repo).toMatch(/^demo\//);
    for (const url of [...demo.matchAll(/url: "(https:[^"]+)"/g)].map(match => match[1]))
      expect(url).toMatch(/^https:\/\/github\.com\/demo\//);
  });

  test("only the wallpaper collector calls the API, so SUPER+D costs nothing", () => {
    expect(collector).toContain('const GITHUB_INBOX_FILE = join(STATE_DIR, "github-inbox.json")');
    // Same writer gate as the heatmap: the overlay reads the shared file.
    const inbox = collector.slice(collector.indexOf("async function githubInbox"));
    expect(inbox.slice(0, inbox.indexOf("\n}"))).toContain('GITHUB_WRITER && ghAvailable && process.env.INFOMARCHY_SKIP_GITHUB !== "1" && inboxRefreshDue(store, now)');
    expect(collector).toContain('const GITHUB_WRITER = instanceId() !== "overlay"');
    expect(collector).toContain("writePrivateStateFile(STATE_DIR, basename(GITHUB_INBOX_FILE)");
  });
});

describe("live session state comes from Herdr", () => {
  test("the card's busy dot is the collector's verdict, not a title regex", () => {
    expect(view).toContain("readonly property bool busy: modelData.busy === true");
    // The guess this replaces. It overruled every real signal whenever an
    // agent forgot to clear "Processing…" from its terminal title.
    expect(view).not.toContain("/Processing|");
  });

  test("the collector joins Herdr's agent list on pane id, never on session id", () => {
    expect(collector).toContain('from "./herdr-status"');
    for (const named of ["fetchHerdrAgents", "herdrAttention", "herdrBusy", "herdrPaneOf", "herdrSocketsOf"])
      expect(collector).toContain(named);
    // Sockets resolved once, then the status read and the place-name read go
    // out together — three requests, one round trip, ~3-5 ms for all of them.
    expect(collector).toContain("const herdrSockets = herdrSocketsOf(sessions, validHerdrSocket(\"\"))");
    expect(collector).toContain("fetchHerdrAgents(herdrSockets, sendHerdrCommand)");
    expect(collector).toContain("fetchHerdrPlaces(herdrSockets, sendHerdrCommand)");
    // Names overwrite the env-derived id label only when Herdr supplied one,
    // so a socket that is down costs the names and nothing else.
    expect(collector).toContain("const named = herdrPlaceLabel(host.workspaceId, herdrPlaces)");
    expect(collector).toContain("if (named) host.label = named");
    // The tab name is carried on the host so attachSessionIdentity can reach
    // it later, and it is the card's identity line rather than the host line.
    expect(collector).toContain("host.tabName = herdrTabName(host.tabId, herdrPlaces)");
    expect(collector).toContain("attachSessionIdentity(sessions, recent)");
    // Human authorship outranks the local model instead of racing it.
    expect(collector).toContain("if (session.topicFromHuman) return");
    expect(collector).toContain("const pane = herdrPaneOf(s)");
    expect(collector).toContain("s.herdrStatus = herdrAgents && pane && herdrAgents[pane] ? herdrAgents[pane].status : \"\"");
    // agent_session.value drifts across /rewind; joining there would invent a
    // phantom card. It must not appear in the join at all.
    expect(collector).not.toContain("agent_session");
  });

  test("Herdr replaces the title regex but not the two facts above it", () => {
    const busy = collector.slice(collector.indexOf("const herdrSaysBusy"), collector.indexOf("// Each repo costs"));
    // Claude's own registry still wins, and the systemd turn inhibitor is a
    // running turn whatever Herdr believes it can see on screen.
    expect(busy).toContain("s._registryBusy !== null && s._registryBusy !== undefined ? s._registryBusy");
    expect(busy).toContain("herdrSaysBusy !== null ? (herdrSaysBusy || turnBusy.has(s.pid))");
    expect(busy).toContain("(titleBusy || turnBusy.has(s.pid))");
  });

  test("a confident Herdr verdict outranks the attention regex", () => {
    expect(collector).toContain("const fromHerdr = session.herdrStatus");
    expect(collector).toContain("let signal = fromHerdr.known ? fromHerdr.signal");
    // The old path stays for everything Herdr does not host or cannot classify.
    expect(collector).toContain("session.busy ? null : attentionSignal(session.window?.title");
  });

  test("demo mode fabricates all four states and never opens the socket", () => {
    const demo = collector.slice(collector.indexOf("function demoSnapshot"), collector.indexOf("async function runCollector"));
    for (const status of ["working", "blocked", "done", "idle"])
      expect(demo).toContain(`herdrStatus: "${status}"`);
    // demoSnapshot is returned before any collection runs, so no socket is
    // dialled; the states above are literals, not reads.
    expect(demo).not.toContain("fetchHerdrAgents");
    expect(collector).toContain('if (process.argv.includes("--demo"))');
    // Enough cards that the session carousel actually has something to scroll.
    expect((demo.match(/sessionIds: \[/g) || []).length).toBeGreaterThanOrEqual(5);
    // The demo attention list is derived, not a hardcoded index that silently
    // points at an idle session whenever the demo roster changes.
    expect(demo).toContain("attention: sessions.filter((s: any) => s.attention)");
  });

  test("the socket is not dialled at all when nothing is Herdr-hosted", () => {
    // A machine without Herdr must pay nothing for this feature.
    expect(herdrStatus).toContain("if (!paths.length) return null");
    expect(herdrStatus).toContain("export function herdrSocketsOf");
  });

  test("one read per tick, with a budget well inside the tick", () => {
    expect(herdrStatus).toContain("export const HERDR_STATUS_TIMEOUT_MS = 600");
    // Bun.connect throws synchronously on a malformed path; a rejection would
    // take the whole collector tick down.
    expect(focus).toContain("} catch { finish(null); }");
  });
});

describe("the session carousel", () => {
  test("one horizontal strip of fixed-width cards, not a wrapping Flow", () => {
    expect(view).toContain("component ScrollRow: Item");
    expect(view).toContain("orientation: ListView.Horizontal");
    expect(view).toContain("id: sessionRail");
    expect(view).toContain("width: sessionRail.cardWidth");
    expect(view).toContain("height: sessionRail.listHeight");
    // The Flow it replaces could not wrap without pushing RECENT TASKS off a
    // 1080p desk, so it shrank the cards until every line elided instead.
    expect(view).not.toContain("id: sessionFlow");
    expect(view).not.toContain("readonly property int fittedCardWidth");
  });

  test("a vertical wheel scrolls it sideways, and the track is draggable", () => {
    const rail = view.slice(view.indexOf("component ScrollRow: Item"), view.indexOf("component Tag: Rectangle"));
    // A vertical wheel over a horizontal list does nothing by default.
    expect(rail).toContain("Number(wheel.pixelDelta.x || 0) || Number(wheel.pixelDelta.y || 0)");
    expect(rail).toContain("Number(wheel.angleDelta.x || 0) || Number(wheel.angleDelta.y || 0)");
    expect(rail).toContain("list.contentX = Math.max(0, Math.min(Math.max(0, list.contentWidth - list.width), list.contentX - delta))");
    expect(rail).toContain("onPressed: function(mouse) { track.seek(mouse.x) }");
    expect(rail).toContain("onPositionChanged: function(mouse) { if (pressed) track.seek(mouse.x) }");
  });

  test("faded edges and a count, because the wallpaper has no keyboard", () => {
    const rail = view.slice(view.indexOf("component ScrollRow: Item"), view.indexOf("component Tag: Rectangle"));
    expect(rail.match(/orientation: Gradient\.Horizontal/g)).toHaveLength(2);
    expect(rail).toContain("visible: rail.scrollable && list.contentX > 1");
    expect(rail).toContain("visible: rail.scrollable && list.contentX < list.contentWidth - list.width - 1");
    // "6 running" alone lies about what is on screen once cards can hide.
    expect(view).toContain('(sessionRail.firstVisible + 1) + "–" + sessionRail.lastVisible + " of " + view.sessions.length');
  });

  test("J/K keeps the selected card on screen", () => {
    // A selection that steps off the strip makes the key look broken: it does
    // something and nothing visible changes.
    expect(view).toContain("currentIndex: view.keyboardSessionIndex");
    expect(view).toContain("list.positionViewAtIndex(rail.currentIndex, ListView.Contain)");
    expect(view).toContain("function keyboardStep(delta)");
  });

  test("nothing rotates on its own", () => {
    const rail = view.slice(view.indexOf("component ScrollRow: Item"), view.indexOf("component Tag: Rectangle"));
    // Periodic movement on a wallpaper steals attention all day and slides the
    // card out from under the pointer.
    expect(rail).not.toContain("Timer");
    expect(rail).not.toContain("NumberAnimation");
    expect(rail).not.toContain("loops: Animation.Infinite");
  });

  test("the card is five lines, and the detail moved to the inspector", () => {
    const card = view.slice(view.indexOf("id: sessionRail"), view.indexOf("MouseArea {\n                id: hover"));
    // Kept: status + provider + uptime, project, topic, git, host.
    expect(card).toContain("view.sessionStateLabel(sc.modelData)");
    expect(card).toContain("view.desk.dur(sc.modelData.uptimeSec)");
    expect(card).toContain("sc.modelData.project");
    expect(card).toContain("sc.modelData.topic");
    expect(card).toContain('"git " + sc.modelData.git.branch');
    expect(card).toContain("text: view.sessionHostLabel(sc.modelData)");
    // Gone: cwd duplicated the project, the window title duplicated the topic,
    // and the telemetry line repeated what MACHINE already reports.
    expect(card).not.toContain("text: sc.modelData.cwd");
    expect(card).not.toContain('"pid " + sc.modelData.pid');
    // All three are in the right-click inspector, `name` included, so the
    // carousel loses nothing that was only on the card.
    expect(view).toContain("text: sessionInspector.session.cwd");
    expect(view).toContain('(sessionInspector.session.window || {}).title || "no window title"');
    expect(view).toContain('if (s.name) parts.push(String(s.name))');
  });

  test("a stale card keeps how long it has been idle", () => {
    // STALE replaces the status word rather than sitting beside "IDLE" — a
    // stale session is idle by definition — and the duration is the part that
    // tells you whether to kill it.
    expect(view).toContain('text: "STALE · idle "');
    expect(view).toContain("Tag { visible: sc.modelData.stale !== true; text: view.sessionStateLabel(sc.modelData)");
  });

  test("the strip may only ever hide an idle session", () => {
    // Same lesson as MY PRS, where a broken build sorted to fourth while the
    // header counted the failure and the carousel hid which one it was.
    expect(herdrStatus).toContain("export function sortSessionsByUrgency");
    expect(collector).toContain("return sortSessionsByUrgency(sessions)");
    // Demo mode advertises the real order, not the literal array order.
    expect(collector).toContain("const sessions = sortSessionsByUrgency([");
  });
});
