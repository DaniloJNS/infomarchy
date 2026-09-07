import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons

// The dashboard itself. Hosted by Infomarchy.qml (background layer) and Overlay.qml
// (summoned fullscreen). Everything is sized from Style.* and colored from the
// active theme via InfoModel, so it follows whatever Omarchy theme is set.
Item {
  id: view
  required property InfoModel desk
  required property InfoSettings settings
  property bool interactive: true
  // The background layer is created with WlrKeyboardFocus.None, so a text
  // field there can never receive keystrokes. The host sets this false and
  // the search box becomes a pointer to the overlay instead of a dead input.
  property bool keyboardAvailable: true
  property int activityCellFilter: -1
  property string activityProviderFilter: ""
  // GITHUB · LAST 7 DAYS has no list to filter, so a selected cell is a pin
  // (its breakdown stays in the status line) and a selected kind recolours
  // the grid to that kind alone.
  property int githubCellFilter: -1
  property string githubKindFilter: ""
  property var inspectedSession: null
  property var selectedPrompt: null
  property string usageProviderFilter: ""
  property bool usageForecastMode: false
  // Trend chart metric: tokens processed per day, or their estimated API value.
  property string usageMetric: "tokens"
  function usageMoney(value) {
    var n = Number(value || 0)
    return n >= 1000 ? "$" + (n / 1000).toFixed(1) + "k" : n >= 100 ? "$" + n.toFixed(0) : "$" + n.toFixed(2)
  }
  // Each provider's blended $/token over its lifetime, used to scale its daily
  // token series into an estimated daily value. Null when unpriced.
  function usageBlendedRate(u) {
    var v = (u || {}).value || {}, totals = v.totals || {}
    var tokens = Number(totals.inputTokens || 0) + Number(totals.outputTokens || 0) + Number(totals.cacheReadInputTokens || 0) + Number(totals.cacheCreationInputTokens || 0)
    return v.lifetime === null || v.lifetime === undefined || tokens <= 0 ? null : Number(v.lifetime) / tokens
  }
  readonly property var usageSeries: {
    var out = []
    var keys = Object.keys(usage).filter(function(k) { return usage[k] && usage[k].ready !== false && (!usageProviderFilter || usageProviderFilter === k) })
    for (var i = 0; i < keys.length; i++) {
      var u = usage[keys[i]], daily = Array.isArray(u.dailyTokens) ? u.dailyTokens : []
      if (!daily.some(function(x) { return Number(x) > 0 })) continue
      var rate = usageBlendedRate(u)
      if (usageMetric === "value" && rate === null) continue
      out.push({ provider: keys[i], points: daily.map(function(x) { return usageMetric === "value" ? Number(x) * rate : Number(x) }) })
    }
    return out
  }
  property bool previewsEnabled: false
  // Delegates are rebuilt on every snapshot; without this, a hovered card
  // recaptured its preview every poll. Keyed by window address.
  property var previewCache: ({})
  function dropPreviews(addresses) {
    var next = {}, dropped = 0
    for (var key in previewCache) {
      if (addresses === null || addresses.indexOf(key) >= 0) { view.desk.removePreview(previewCache[key]); dropped++ }
      else next[key] = previewCache[key]
    }
    if (dropped) previewCache = next
    return dropped
  }
  // Previews are deleted when replaced (below), when the feature is turned
  // off, when their session is gone, and when this view goes away.
  onPreviewsEnabledChanged: if (!previewsEnabled) dropPreviews(null)
  onAllSessionsChanged: {
    var live = {}
    for (var i = 0; i < allSessions.length; i++) if (allSessions[i].window && allSessions[i].window.address) live[String(allSessions[i].window.address)] = true
    var gone = []
    for (var key in previewCache) if (!live[key]) gone.push(key)
    if (gone.length) dropPreviews(gone)
  }
  Component.onDestruction: dropPreviews(null)
  property int keyboardSessionIndex: -1
  property string promptSearch: ""
  property string expandedChangeKey: ""
  property string projectFilter: ""
  signal navigated()

  function navigateTo(address) {
    if (!address) return
    view.desk.focusWindow(address)
    view.navigated()
  }
  // Room for the bar. The background layer ignores exclusion zones on purpose,
  // so we leave a top strip free instead of drawing under the bar.
  property int topInset: Math.round(40 * Style.fontScale)

  readonly property var snap: (desk && desk.snap) ? desk.snap : ({})
  readonly property var machine: snap.machine || ({})
  readonly property var ai: snap.ai || ({})
  readonly property var allSessions: ai.sessions || []
  readonly property var projects: ai.projects || []
  readonly property var sessions: !projectFilter ? allSessions : allSessions.filter(function(item) { return projectMatches(item) })
  readonly property var activeNotificationProviders: {
    var result = []
    for (var i = 0; i < allSessions.length; i++) {
      var provider = String(allSessions[i].provider || "").toLowerCase()
      if (provider && result.indexOf(provider) < 0) result.push(provider)
    }
    return result
  }
  readonly property var changeProjects: {
    var result = projects.filter(function(item) { return !!item.changes && projectMatches(item) })
    return result.sort(function(a, b) {
      return Number(changeUnseen(b)) - Number(changeUnseen(a)) || Number((b.changes || {}).committedAt || 0) - Number((a.changes || {}).committedAt || 0)
    })
  }
  readonly property var attention: ai.attention || []
  readonly property var visibleAttention: {
    var source = attention, stamp = Number(snap.ts || Date.now())
    return source.filter(function(item) { return projectMatches(item) && settings.attentionVisible(attentionKey(item), stamp) })
  }
  readonly property var collisions: ai.collisions || []
  readonly property var visibleCollisions: collisions.filter(function(item) { return projectMatches(item) })
  readonly property var usage: (ai && ai.usage) ? ai.usage : ({})
  readonly property bool activityFilterActive: sectionEnabled("activity") && (activityCellFilter >= 0 || activityProviderFilter !== "")
  readonly property var visibleRecentTasks: {
    var rows = ai.recent || []
    if (projectFilter) rows = rows.filter(function(row) { return projectMatches(row) })
    var chosen = !activityFilterActive ? rows : rows.filter(function(row) {
      return (activityCellFilter < 0 || Number(row.activityCell) === activityCellFilter) &&
        (!activityProviderFilter || String(row.provider) === activityProviderFilter)
    })
    var query = String(promptSearch || "").trim().toLowerCase()
    if (query) chosen = chosen.filter(function(row) {
      return (String(row.text || "") + " " + String(row.project || "") + " " + String(row.provider || "")).toLowerCase().indexOf(query) >= 0
    })
    var limit = query || activityFilterActive ? 200 : 80
    // Sort BEFORE slicing. Slicing first dropped every pinned prompt older than
    // the newest 80 rows — which defeats the only reason to pin one.
    return chosen.slice().sort(function(a, b) {
      return Number(settings.promptPinned(promptKey(b))) - Number(settings.promptPinned(promptKey(a))) || Number(b.ts || 0) - Number(a.ts || 0)
    }).slice(0, limit)
  }
  // Columns are fractions of the view, never constants: a fixed right column
  // wider than the space left of the screen edge ran clean off the desk.
  readonly property int rightColumnWidth: Math.round(Math.max(300, Math.min(0.28 * width, 560)))
  readonly property int pad: Style.spacing.xl
  readonly property int gap: Style.spacing.lg
  // Three whole rows of the GITHUB · YOU columns (row pitch measured at 32 px
  // on a 1080p eDP-1 at fontScale 1.17). The card sits above the only elastic
  // element of the left column, so this is the knob that decides how much of
  // RECENT TASKS it costs — and a height that is not a whole number of rows
  // leaves a sliver at the bottom that reads as a glitch, not as "more below".
  readonly property real githubYouListHeight: Math.round(82 * Style.fontScale)
  // Layout instrumentation — `omarchy-shell infomarchy geometry`. Widths the
  // layout actually settled on; read these before touching any constant.
  function geometryReport(): string {
    return JSON.stringify({
      view: width, gap: gap, pad: pad, fontScale: Style.fontScale,
      rightColumnWidth: rightColumnWidth, rightColumn: rightColumn.width, rightColumnX: rightColumn.x,
      leftColumn: leftColumn.width,
      localAi: {
        card: localAiCard.width, cardX: localAiCard.x, body: localAiCard.bodyWidth, column: localAiColumn.width,
        selectorRow: selectorRow.width, selectorRowX: selectorRow.x, loadTagRight: loadTag.x + loadTag.width, loadTag: loadTag.width,
        gpuMeter: gpuMeter.width, gpuMeterX: gpuMeter.x,
        columnImplicit: localAiColumn.implicitWidth, provRow: provRow.width, provRowImplicit: provRow.implicitWidth,
        selectorRowImplicit: selectorRow.implicitWidth
      }
    })
  }
  readonly property int radius: Math.max(Style.cornerRadius, 0)
  readonly property color cardBg: Util.alpha(view.desk.themeBackground, 0.62)
  readonly property color cardBorder: Util.alpha(view.desk.themeForeground, 0.14)
  readonly property color textDim: Util.alpha(view.desk.themeForeground, 0.62)
  readonly property color textFaint: Util.alpha(view.desk.themeForeground, 0.38)
  readonly property string mono: Style.resolvedFontFamily

  component PlainText: Text { textFormat: Text.PlainText }

  function sectionEnabled(id) { return view.settings.sectionEnabled(id) }
  function attentionKey(item) { return String(item.provider || "") + ":" + String(item.pid || "") + ":" + String(item.attention || "") + ":" + String(item.attentionReason || "") }
  function promptKey(item) { return String(item.provider || "") + ":" + String(item.session || "") + ":" + String(item.ts || "") }
  function projectKey(item) { return String(item.repoRoot || item.repo || item.cwd || item.project || "") }
  function projectMatches(item) {
    if (!projectFilter) return true
    var key = projectKey(item)
    // History rows carry the agent's cwd, which may be a subdirectory of the
    // repository the filter was set from.
    return key === projectFilter || key.indexOf(projectFilter + "/") === 0
  }
  function projectTone(item) {
    return item.status === "blocked" ? view.desk.red : item.status === "running" ? view.desk.cyan : item.status === "behind" || item.status === "changed" ? view.desk.yellow : item.status === "unknown" ? view.textFaint : view.desk.green
  }
  function projectStatusLabel(item) {
    return item.status === "blocked" ? "BLOCKED" : item.status === "running" ? "ACTIVE" : item.status === "behind" ? "BEHIND" : item.status === "changed" ? "CHANGED" : item.status === "unknown" ? "NO REPO" : "HEALTHY"
  }
  // The session's own state, as one word. Since Herdr reports this for every
  // pane it hosts (see herdr-status.ts), the card can finally say it outright
  // instead of leaving the pulsing dot to imply it.
  function sessionStateLabel(item) {
    var session = item || {}
    if (session.attention === "blocked") return "BLOCKED"
    if (session.attention === "waiting") return "WAITING"
    if (session.attention === "done") return "DONE"
    return session.busy === true ? "WORKING" : "IDLE"
  }
  function sessionStateTone(item) {
    var session = item || {}
    if (session.attention === "blocked") return desk.red
    if (session.attention === "waiting") return desk.yellow
    if (session.attention === "done") return desk.green
    return session.busy === true ? desk.cyan : textFaint
  }
  function ciLabel(item) {
    var ci = item.ci || {}, state = String(ci.state || "unavailable")
    return state === "unavailable" ? "CI —" : "CI " + state.replace(/_/g, " ").toUpperCase() + (ci.stale ? " · STALE" : "")
  }
  function changeUnseen(item) { var change = item.changes || {}; return !!change.fingerprint && !settings.changeSeen(projectKey(item), change.fingerprint) }
  function sessionHostLabel(item) {
    return (item.hosts || []).map(function(host) { return String(host.label || host.kind || "") }).filter(Boolean).join(" · ")
  }
  function sessionHostDetail(item) {
    return (item.hosts || []).map(function(host) {
      if (host.kind === "boomux") return "Boomux shell " + String(host.shellId || "—").slice(0, 8) + " · run " + String(host.runId || "—").slice(0, 8)
      if (host.kind === "herdr") return "Herdr " + [host.workspaceId, host.tabId, host.paneId].filter(Boolean).join(" / ")
      if (host.kind === "tmux") return "tmux " + String(host.session || "?") + ":" + String(host.window || "?") + "." + String(host.pane || "?") + " · pane " + String(host.paneId || "—")
      return String(host.label || host.kind || "")
    }).filter(Boolean).join("   ·   ")
  }
  function changeSummary(item) {
    var change = item.changes || {}, parts = []
    if (change.count) parts.push(change.count + " file" + (change.count === 1 ? "" : "s"))
    if (change.staged) parts.push(change.staged + " staged")
    if (change.untracked) parts.push(change.untracked + " new")
    if (change.testFiles) parts.push(change.testFiles + " test")
    if (change.additions || change.deletions) parts.push("+" + (change.additions || 0) + "/−" + (change.deletions || 0))
    return parts.length ? parts.join(" · ") : "clean at " + (change.headShort || "HEAD")
  }
  function attentionPrimaryLabel(item) {
    if (!(item.window && item.window.address) && view.desk.canResume(item.provider, item.session)) return "RESUME"
    if (!(item.window && item.window.address) && view.desk.canOpenProject(item.cwd)) return "OPEN PROJECT"
    return item.attentionAction === "answer" ? "ANSWER" : item.attentionAction === "review" ? "REVIEW" : item.attentionAction === "resolve" ? "RESOLVE" : "FOCUS"
  }
  function activateAttention(item) {
    if (item.window && item.window.address) { view.desk.focusSession(item); view.navigated(); return true }
    if (view.desk.canResume(item.provider, item.session)) return view.desk.resumeSession(item.provider, item.session, item.cwd)
    if (view.desk.canOpenProject(item.cwd)) return view.desk.openProject(item.cwd)
    return false
  }
  function usageWindowMs(label) { return /week|7-day/i.test(String(label || "")) ? 7 * 86400000 : /session|5-hour/i.test(String(label || "")) ? 5 * 3600000 : 0 }
  // The collector ships forecast from ai-ops.limitForecast (tested). The local
  // math stays only as a fallback for snapshots from an older collector.
  function usageProjection(limit) {
    if (limit && limit.forecast !== undefined) return limit.forecast === null ? null : Number(limit.forecast)
    var duration = usageWindowMs(limit.label || limit.title), remaining = Date.parse(limit.resetsAt || "") - Date.now(), elapsed = duration - remaining
    if (!duration || !isFinite(remaining) || remaining < 0 || elapsed < duration * 0.03) return null
    return Math.max(0, Number(limit.percent || 0) * duration / elapsed)
  }
  function keyboardStep(delta) {
    if (!sessions.length) { keyboardSessionIndex = -1; return }
    keyboardSessionIndex = (keyboardSessionIndex + Number(delta) + sessions.length) % sessions.length
  }
  function activateKeyboardSession() {
    var session = sessions[keyboardSessionIndex]
    if (session && session.window && session.window.address) navigateTo(session.window.address)
  }
  // inspectedSession/selectedPrompt hold a copy of the delegate's modelData from
  // click time. sessions is replaced on every 4s snapshot, so the drawer used to
  // freeze — showing stale CPU/git and offering FOCUS on an exited window.
  // Re-resolve against the current snapshot each tick and close it when the
  // session is gone.
  readonly property var liveInspectedSession: {
    var pinnedSession = inspectedSession
    if (!pinnedSession) return null
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].pid === pinnedSession.pid && sessions[i].provider === pinnedSession.provider) return sessions[i]
    }
    return null
  }
  function toggleActivityCell(index) { activityCellFilter = activityCellFilter === index ? -1 : index }
  function toggleActivityProvider(provider) { activityProviderFilter = activityProviderFilter === provider ? "" : provider }
  function clearActivityFilter() { activityCellFilter = -1; activityProviderFilter = ""; githubCellFilter = -1; githubKindFilter = "" }
  readonly property var github: ai.github || ({})
  readonly property var githubKinds: ["commit", "pr", "review", "issue", "comment", "other"]
  readonly property bool githubFilterActive: sectionEnabled("github") && (githubCellFilter >= 0 || githubKindFilter !== "")
  function toggleGithubCell(index) { githubCellFilter = githubCellFilter === index ? -1 : index }
  function toggleGithubKind(kind) { githubKindFilter = githubKindFilter === kind ? "" : kind }
  function githubKindColor(kind) {
    switch (String(kind)) {
      case "commit": return desk.green
      case "pr": return desk.magenta
      case "review": return desk.cyan
      case "issue": return desk.yellow
      case "comment": return desk.blue
      default: return textDim
    }
  }
  function githubKindLabel(kind) {
    switch (String(kind)) {
      case "commit": return "commits"
      case "pr": return "PRs"
      case "review": return "reviews"
      case "issue": return "issues"
      case "comment": return "comments"
      case "other": return "other"
      default: return String(kind)
    }
  }
  function githubHint() {
    var c = github.counts || {}, parts = []
    for (var i = 0; i < githubKinds.length; i++) {
      var k = githubKinds[i]
      if (c[k] && (c[k].week > 0 || c[k].today > 0)) parts.push(githubKindLabel(k) + " " + c[k].today + "/" + c[k].week)
    }
    if (!parts.length) return github.login ? "@" + github.login : ""
    return "today/week · " + parts.join(" · ")
  }
  // Why the GitHub grid is empty or behind, in the words the user needs.
  function githubStatus() {
    switch (String(github.state || "")) {
      case "missing": return "gh not installed · pacman -S github-cli"
      case "unauthenticated": return "gh not authenticated · run gh auth login"
      case "pending": return "fetching GitHub activity…"
      case "unavailable": return "GitHub unreachable · " + String(github.error || "fetch failed")
      case "stale": return "stale · " + String(github.error || "fetch failed") + " · cached rows"
      case "ok": return (github.login ? "@" + github.login + " · " : "") + (github.coverage === "partial" ? "filling older days · " : "") + "hover · click pins · red = now"
      default: return ""
    }
  }
  function githubFilterLabel() {
    var parts = []
    if (githubCellFilter >= 0) {
      var days = github.days || []
      var day = Math.floor(githubCellFilter / 24), hour = githubCellFilter % 24
      if (Number(days[day] || 0) > 0) parts.push(Qt.formatDate(new Date(days[day]), "ddd d MMM") + " " + (hour < 10 ? "0" : "") + hour + ":00")
    }
    if (githubKindFilter) parts.push(githubKindLabel(githubKindFilter))
    return parts.join(" · ")
  }
  function activityFilterLabel() {
    var parts = []
    if (activityCellFilter >= 0) {
      var days = (ai.heatmap || {}).days || []
      var day = Math.floor(activityCellFilter / 24), hour = activityCellFilter % 24
      var dt = new Date(days[day] || 0)
      if (Number(days[day] || 0) > 0) parts.push(Qt.formatDate(dt, "ddd d MMM") + " " + (hour < 10 ? "0" : "") + hour + ":00")
    }
    if (activityProviderFilter) parts.push(desk.providerLabel(activityProviderFilter))
    return parts.join(" · ")
  }

  // ---- GITHUB · YOU -------------------------------------------------------
  // The card is read-only and ambient: three lists of what is waiting on this
  // account, each row a link. Acting on any of it happens in the browser.
  readonly property var githubYou: ai.githubYou || ({})
  readonly property var githubYouPrs: githubYou.prs || []
  // One scrollable column holds the reviews owed and then the unread
  // notifications, with a rule between them: they are different kinds of
  // "someone is waiting", but they compete for the same glance, and two
  // separately scrolling lists in half a card would each be two rows tall.
  readonly property var githubYouInbox: {
    var out = [], reviews = view.githubYou.reviews || [], notes = view.githubYou.notifications || []
    for (var i = 0; i < reviews.length; i++) out.push({ kind: "review", row: reviews[i] })
    if (reviews.length > 0 && notes.length > 0) out.push({ kind: "rule", row: null })
    for (var j = 0; j < notes.length; j++) out.push({ kind: "note", row: notes[j] })
    return out
  }
  // A row's CI verdict in one glyph. A pull request with no rollup at all and
  // one whose checks have not reported yet both read as "·" — the difference
  // is the colour, not the shape, because the column is two characters wide.
  function githubCiMark(state) {
    switch (String(state || "")) {
      case "SUCCESS": return "✓"
      case "FAILURE":
      case "ERROR": return "✗"
      default: return "·"
    }
  }
  function githubCiTone(state) {
    switch (String(state || "")) {
      case "SUCCESS": return desk.green
      case "FAILURE":
      case "ERROR": return desk.red
      case "PENDING":
      case "EXPECTED": return desk.yellow
      default: return textFaint
    }
  }
  // GitHub's notification reasons, shortened to fit a Tag. Mirrors
  // notificationReasonLabel() in github-inbox.ts; an unknown reason keeps its
  // own slug so a new one stays legible.
  function githubReasonLabel(reason) {
    // Only a string is a reason; String({}) would render as "OBJECTOBJE".
    if (typeof reason !== "string") return "NOTICE"
    switch (reason) {
      case "approval_requested": return "APPROVAL"
      case "assign": return "ASSIGN"
      case "author": return "AUTHOR"
      case "ci_activity": return "CI"
      case "comment": return "COMMENT"
      case "invitation": return "INVITE"
      case "manual": return "MANUAL"
      case "member_feature_requested": return "FEATURE"
      case "mention": return "MENTION"
      case "review_requested": return "REVIEW"
      case "security_advisory_credit":
      case "security_alert": return "SECURITY"
      case "state_change": return "STATE"
      case "subscribed": return "WATCH"
      case "team_mention": return "TEAM"
      default: {
        var slug = reason.replace(/[^A-Za-z_]/g, "").slice(0, 10)
        return slug ? slug.toUpperCase().replace(/_/g, " ").trim() : "NOTICE"
      }
    }
  }
  // Why the card is empty or behind, in the same words as the heatmap's.
  function githubYouStatus() {
    switch (String(githubYou.state || "")) {
      case "missing": return "gh not installed · pacman -S github-cli"
      case "unauthenticated": return "gh not authenticated · run gh auth login"
      case "pending": return "fetching your GitHub inbox…"
      case "unavailable": return "GitHub unreachable · " + String(githubYou.error || "fetch failed")
      case "stale": return "stale · " + String(githubYou.error || "fetch failed") + " · cached rows"
      default: return ""
    }
  }
  function githubYouHint() {
    var state = String(githubYou.state || "")
    // Anything but a working feed: the hint is the only place to say why, and
    // a row of zeroes would read as "nothing waiting on you", which is a lie.
    if (state !== "ok" && state !== "stale") return githubYouStatus()
    var c = githubYou.counts || {}
    // An envelope glyph (U+2709) is absent from the shipped JetBrainsMono
    // Nerd Font: it fell back to a tofu box, and the wrong advance width
    // elided the whole hint. U+2713/U+2717 below are in the font; a word is
    // safe in whatever font the user has set.
    return Number(c.open || 0) + " open · " + Number(c.draft || 0) + " draft · " + Number(c.ciFail || 0) + " CI✗ · " + Number(c.unread || 0) + " unread"
  }
  function openGithub(url) { if (view.desk.openUrl(url)) view.navigated() }
  function shortRepo(repo) { return String(repo || "").replace(/^.*\//, "") }

  // ---- reusable pieces -------------------------------------------------------
  component Card: Rectangle {
    id: card
    property string title: ""
    property string hint: ""
    property string moveId: ""
    property string moveGroup: "right"
    property string dragAxis: "vertical"
    property bool draggable: false
    property bool dragging: false
    property real dragOffsetX: 0
    property real dragOffsetY: 0
    property bool glow: false
    property color glowTone: view.desk.yellow
    default property alias content: body.data
    readonly property real bodyWidth: body.width
    color: view.cardBg
    border.color: view.cardBorder
    border.width: 1
    radius: view.radius
    z: card.dragging ? 50 : 0
    transform: Translate { x: card.dragOffsetX; y: card.dragOffsetY }
    Behavior on dragOffsetX {
      enabled: !card.dragging
      NumberAnimation { duration: 170; easing.type: Easing.OutBack }
    }
    Behavior on dragOffsetY {
      enabled: !card.dragging
      NumberAnimation { duration: 170; easing.type: Easing.OutBack }
    }
    Rectangle {
      anchors { fill: parent; margins: -3 }
      z: -1
      visible: card.glow
      color: "transparent"
      radius: card.radius + 3
      border.width: 2
      border.color: card.glowTone
      SequentialAnimation on opacity {
        running: card.glow && card.visible
        loops: Animation.Infinite
        NumberAnimation { from: 0.12; to: 0.42; duration: 1200; easing.type: Easing.InOutSine }
        NumberAnimation { from: 0.42; to: 0.12; duration: 1200; easing.type: Easing.InOutSine }
      }
    }
    implicitHeight: col.implicitHeight + view.pad * 2
    // Swallow clicks on card chrome so the overlay's click-outside-to-close
    // only fires on the real backdrop.
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(m) { m.accepted = true } }
    ColumnLayout {
      id: col
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      Item {
        id: cardHeader
        Layout.fillWidth: true
        implicitHeight: cardHeaderRow.implicitHeight
        visible: card.title !== ""
        RowLayout {
          id: cardHeaderRow
          anchors.fill: parent
          PlainText { visible: card.draggable; text: "⋮⋮"; color: card.dragging ? view.desk.cyan : view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
          PlainText { text: card.title; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; font.letterSpacing: 1.5; font.bold: true }
          Item { Layout.fillWidth: true }
          // A non-fill item is never shrunk below its preferred width by the
          // layout, so a long hint would run past a half-width card; fill and
          // cap at the natural width instead, and elide when there is no room.
          PlainText { text: card.hint; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight; horizontalAlignment: Text.AlignRight; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.maximumWidth: implicitWidth }
        }
        MouseArea {
          anchors.fill: parent
          z: 2
          enabled: view.interactive && card.draggable
          hoverEnabled: true
          cursorShape: enabled ? (pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor) : Qt.ArrowCursor
          property real pressViewX: 0
          property real pressViewY: 0
          onPressed: function(mouse) {
            var pointer = mapToItem(view, mouse.x, mouse.y)
            pressViewX = pointer.x
            pressViewY = pointer.y
            card.dragging = true
            mouse.accepted = true
          }
          onPositionChanged: function(mouse) {
            if (!pressed) return
            var pointer = mapToItem(view, mouse.x, mouse.y)
            if (card.dragAxis === "horizontal") card.dragOffsetX = Math.max(-card.width * 0.7, Math.min(card.width * 0.7, pointer.x - pressViewX))
            else card.dragOffsetY = Math.max(-card.height * 0.7, Math.min(card.height * 0.7, pointer.y - pressViewY))
          }
          onReleased: function(mouse) {
            var offset = card.dragAxis === "horizontal" ? card.dragOffsetX : card.dragOffsetY
            var extent = card.dragAxis === "horizontal" ? card.width : card.height
            var threshold = Math.min(extent * 0.24, Math.round(46 * Style.fontScale))
            if (Math.abs(offset) >= threshold) {
              if (card.moveGroup === "ops") view.settings.moveOps(card.moveId, offset > 0 ? 1 : -1)
              else view.settings.moveRight(card.moveId, offset > 0 ? 1 : -1)
            }
            card.dragging = false
            card.dragOffsetX = 0
            card.dragOffsetY = 0
            mouse.accepted = true
          }
          onCanceled: { card.dragging = false; card.dragOffsetX = 0; card.dragOffsetY = 0 }
        }
      }
      Item {
        id: body
        clip: true
        Layout.fillWidth: true
        Layout.fillHeight: true
        // Flexible cards such as Recent Tasks intentionally size their children
        // from this item. Only use a sole content item's implicit size here, so
        // that parent-sized children cannot form an implicit-height loop.
        implicitHeight: children.length === 1 ? Number(children[0].implicitHeight || 0) : 0
      }
    }
  }

  // One 7×24 hour grid with its tooltip and legend. ACTIVITY and GITHUB share
  // it; the host decides what a kind is, what colour it gets, and what a click
  // means. `kindFiltersCells` recolours the grid to the selected kind alone.
  component HeatPanel: Item {
    id: panel
    property var cells: []
    property var days: []
    property real startTs: 0
    property var kinds: []
    property var colorFor: function(kind) { return view.desk.providerColor(kind) }
    property var labelFor: function(kind) { return view.desk.providerLabel(kind) }
    property string unit: "prompts"
    property bool showRepos: false
    property bool kindFiltersCells: false
    property int selectedCell: -1
    property string selectedKind: ""
    property bool filterActive: false
    property string filterLabel: ""
    property string idleStatus: "hover · click filters tasks · red = now"
    property string hoverStatus: "click to filter tasks"
    property string emptyText: ""
    // A pinned cell keeps its full breakdown in the status line (GitHub has no
    // list to filter, so the pin is the detail view).
    property bool pinnedBreakdown: false
    signal cellClicked(int index)
    signal kindClicked(string kind)
    signal clearClicked()
    width: parent ? parent.width : 400
    implicitHeight: heat.height + Style.spacing.md + legend.implicitHeight
    function dayTs(index) { return days[index] || (startTs + index * 86400000) }
    function cellCount(cell) {
      if (kindFiltersCells && selectedKind) return Number((cell[1] || {})[selectedKind] || 0)
      return Number(cell[0] || 0)
    }
    function cellLabel(index) {
      if (index < 0) return ""
      var c = cells[index] || [0, {}, {}], d = Math.floor(index / 24), h = index % 24
      var dt = new Date(dayTs(d)), parts = []
      for (var k in c[1]) parts.push(labelFor(k) + " " + c[1][k])
      var label = Qt.formatDate(dt, "ddd d MMM") + " " + (h < 10 ? "0" : "") + h + ":00 · " + c[0] + " " + unit + (parts.length ? " · " + parts.join(" · ") : "")
      if (showRepos && c[2]) {
        var repos = []
        for (var r in c[2]) repos.push([r, c[2][r]])
        repos.sort(function(a, b) { return b[1] - a[1] })
        var names = repos.slice(0, 3).map(function(entry) { return String(entry[0]).replace(/^[^/]*\//, "") })
        if (names.length) label += " · " + names.join(", ") + (repos.length > 3 ? " +" + (repos.length - 3) : "")
      }
      return label
    }
    readonly property bool hasData: {
      for (var i = 0; i < cells.length; i++) if (Number((cells[i] || [0])[0]) > 0) return true
      return false
    }
    Canvas {
      id: heat
      width: parent.width
      height: Math.round(7 * 13 * Style.fontScale)
      property int hoverIdx: -1
      Connections { target: panel; function onCellsChanged() { heat.requestPaint() } function onSelectedCellChanged() { heat.requestPaint() } function onSelectedKindChanged() { heat.requestPaint() } }
      Connections { target: view.desk; function onGreenChanged() { heat.requestPaint() } function onThemeForegroundChanged() { heat.requestPaint() } }
      onPaint: {
        var ctx = getContext("2d"); ctx.reset()
        var labelW = Math.round(34 * Style.fontScale)
        var cw = (width - labelW) / 24, ch = height / 7
        var cells = panel.cells
        var maxN = 1
        for (var i = 0; i < cells.length; i++) { var count = panel.cellCount(cells[i] || [0, {}]); if (count > maxN) maxN = count }
        ctx.font = Style.font.caption + "px \"" + view.mono + "\""
        ctx.textBaseline = "middle"
        var dayNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
        for (var d = 0; d < 7; d++) {
          var dt = new Date(panel.dayTs(d))
          ctx.fillStyle = Qt.rgba(view.textFaint.r, view.textFaint.g, view.textFaint.b, view.textFaint.a)
          ctx.fillText(dayNames[dt.getDay()], 0, d * ch + ch / 2)
          for (var h = 0; h < 24; h++) {
            var idx = d * 24 + h
            var c = cells[idx] || [0, {}]
            var n = panel.cellCount(c), x = labelW + h * cw, y = d * ch
            var base = view.desk.themeForeground
            ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.05)
            ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2)
            if (n > 0) {
              // dominant kind colours the cell; intensity = count
              var best = "", bn = 0
              if (panel.kindFiltersCells && panel.selectedKind) best = panel.selectedKind
              else for (var k in c[1]) if (c[1][k] > bn) { bn = c[1][k]; best = k }
              var col = panel.colorFor(best)
              var a = 0.25 + 0.75 * Math.min(1, n / maxN)
              ctx.fillStyle = Qt.rgba(col.r, col.g, col.b, a)
              ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2)
            }
            if (idx === panel.selectedCell) {
              var selected = panel.selectedKind ? panel.colorFor(panel.selectedKind) : view.desk.themeForeground
              ctx.strokeStyle = Qt.rgba(selected.r, selected.g, selected.b, 1)
              ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2)
            } else if (idx === hoverIdx) {
              ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, 0.9)
              ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1)
            }
          }
        }
        // "now" marker
        var nowD = new Date(), nd = -1
        for (var di = 0; di < 7; di++) {
          var markerDay = new Date(panel.dayTs(di))
          if (markerDay.getFullYear() === nowD.getFullYear() && markerDay.getMonth() === nowD.getMonth() && markerDay.getDate() === nowD.getDate()) { nd = di; break }
        }
        if (nd >= 0 && nd < 7) {
          var nx = labelW + (nowD.getHours() + nowD.getMinutes() / 60) * cw
          ctx.strokeStyle = Qt.rgba(view.desk.red.r, view.desk.red.g, view.desk.red.b, 0.8)
          ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(nx, nd * ch); ctx.lineTo(nx, nd * ch + ch); ctx.stroke()
        }
      }
      MouseArea {
        id: heatMouse
        property real pointerX: 0
        property real pointerY: 0
        anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
        cursorShape: heat.hoverIdx >= 0 ? Qt.PointingHandCursor : Qt.ArrowCursor
        onPositionChanged: function(m) {
          pointerX = m.x; pointerY = m.y
          var labelW = Math.round(34 * Style.fontScale)
          var cw = (heat.width - labelW) / 24, ch = heat.height / 7
          var h = Math.floor((m.x - labelW) / cw), d = Math.floor(m.y / ch)
          heat.hoverIdx = (h >= 0 && h < 24 && d >= 0 && d < 7) ? d * 24 + h : -1
          heat.requestPaint()
        }
        onExited: { heat.hoverIdx = -1; heat.requestPaint() }
        onClicked: if (heat.hoverIdx >= 0) panel.cellClicked(heat.hoverIdx)
      }
      PlainText {
        anchors.centerIn: parent
        visible: !panel.hasData && panel.emptyText !== ""
        text: panel.emptyText
        color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption
      }
      Rectangle {
        id: heatTooltip
        z: 20
        visible: heat.hoverIdx >= 0
        width: Math.min(implicitWidth, heat.width - Style.spacing.md * 2)
        implicitWidth: heatTooltipText.implicitWidth + Style.spacing.lg * 2
        height: heatTooltipText.implicitHeight + Style.spacing.md * 2
        x: Math.max(0, Math.min(heat.width - width, heatMouse.pointerX + 14))
        y: Math.max(0, Math.min(heat.height - height, heatMouse.pointerY - height - 10))
        radius: view.radius
        color: Util.alpha(view.desk.themeBackground, 0.96)
        border.color: Util.alpha(view.desk.themeForeground, 0.55)
        border.width: 1
        PlainText {
          id: heatTooltipText
          anchors.centerIn: parent
          width: Math.min(implicitWidth, heat.width - Style.spacing.xl * 2)
          text: panel.cellLabel(heat.hoverIdx)
          color: view.desk.themeForeground
          font.family: view.mono
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
    RowLayout {
      id: legend
      anchors { top: heat.bottom; topMargin: Style.spacing.md; left: parent.left; right: parent.right }
      spacing: Style.spacing.md
      Repeater {
        model: panel.kinds
        delegate: Rectangle {
          id: kindChip
          required property string modelData
          readonly property bool selected: panel.selectedKind === modelData
          readonly property color tone: panel.colorFor(modelData)
          implicitWidth: kindChipRow.implicitWidth + Style.spacing.sm * 2
          implicitHeight: kindChipRow.implicitHeight + Style.spacing.xs * 2
          radius: view.radius
          color: selected ? Util.alpha(tone, 0.16) : "transparent"
          border.color: selected ? Util.alpha(tone, 0.8) : "transparent"
          border.width: selected ? 1 : 0
          opacity: panel.selectedKind && !selected ? 0.34 : 1
          RowLayout {
            id: kindChipRow
            anchors.centerIn: parent
            spacing: Style.spacing.xs
            Rectangle { width: 8; height: 8; radius: 2; color: kindChip.tone }
            PlainText { text: panel.labelFor(kindChip.modelData); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
          }
          MouseArea {
            anchors.fill: parent
            enabled: view.interactive
            cursorShape: Qt.PointingHandCursor
            onClicked: panel.kindClicked(kindChip.modelData)
          }
        }
      }
      Item { Layout.fillWidth: true; Layout.minimumWidth: 0 }
      PlainText {
        id: heatStatus
        Layout.fillWidth: true
        Layout.minimumWidth: 0
        horizontalAlignment: Text.AlignRight
        elide: Text.ElideRight
        text: {
          if (heat.hoverIdx >= 0) return panel.hoverStatus
          if (!panel.filterActive) return panel.idleStatus
          if (panel.pinnedBreakdown && panel.selectedCell >= 0) return "pinned · " + panel.cellLabel(panel.selectedCell) + (panel.selectedKind ? " · " + panel.labelFor(panel.selectedKind) : "") + " · clear"
          return "filtered · " + panel.filterLabel + " · clear"
        }
        color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption
        MouseArea {
          anchors.fill: parent
          enabled: view.interactive && panel.filterActive && heat.hoverIdx < 0
          cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
          onClicked: panel.clearClicked()
        }
      }
    }
  }

  component Meter: Item {
    property string label: ""
    property string value: ""
    property real fraction: 0
    property color tone: Color.accent
    implicitHeight: mrow.implicitHeight + bar.height + Style.spacing.xs
    width: parent ? parent.width : 200
    RowLayout {
      id: mrow
      width: parent.width
      PlainText { text: label; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.maximumWidth: Math.round(parent.width * 0.55) }
      Item { Layout.fillWidth: true; Layout.minimumWidth: Style.spacing.sm }
      PlainText { text: value; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight; horizontalAlignment: Text.AlignRight; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.maximumWidth: Math.round(parent.width * 0.7) }
    }
    Rectangle {
      id: bar
      anchors { top: mrow.bottom; topMargin: Style.spacing.xs; left: parent.left; right: parent.right }
      height: Math.max(3, Math.round(4 * Style.fontScale))
      radius: height / 2
      color: Util.alpha(view.desk.themeForeground, 0.10)
      Rectangle {
        width: parent.width * Math.max(0, Math.min(1, fraction))
        height: parent.height; radius: parent.radius; color: tone
        Behavior on width { NumberAnimation { duration: 400; easing.type: Easing.OutCubic } }
      }
    }
  }

  // A ListView with the hand-drawn scrollbar RECENT TASKS grew: wheel travel
  // that works from anywhere over the list (touchpads report tiny pixel
  // deltas, mouse wheels 120 units a notch, and both need to feel immediate),
  // a track that is also draggable, and a thumb sized to the content. Three
  // lists use it now, so it lives here once instead of three times.
  //
  // The list is inset by the track's width rather than overlapping it, so a
  // row's own hover and click never fight the scrollbar for the same pixels.
  component ScrollList: Item {
    id: scroller
    property alias model: list.model
    property alias delegate: list.delegate
    property alias count: list.count
    property alias contentY: list.contentY
    property alias contentHeight: list.contentHeight
    // Delegates size themselves from this, not from the ListView, so nothing
    // has to know about the track.
    readonly property real rowWidth: list.width
    property real rowSpacing: Style.spacing.xs
    readonly property real trackWidth: Math.max(12, Math.round(14 * Style.fontScale))
    function applyWheel(wheel) {
      var pixelY = wheel.pixelDelta ? Number(wheel.pixelDelta.y || 0) : 0
      var angleY = wheel.angleDelta ? Number(wheel.angleDelta.y || 0) : 0
      var delta = pixelY !== 0 ? pixelY * 2.75 : (angleY / 120) * Math.round(120 * Style.fontScale)
      if (!isFinite(delta) || delta === 0) { wheel.accepted = false; return }
      list.contentY = Math.max(0, Math.min(Math.max(0, list.contentHeight - list.height), list.contentY - delta))
      wheel.accepted = true
    }
    ListView {
      id: list
      width: Math.max(0, scroller.width - scroller.trackWidth)
      height: scroller.height
      spacing: scroller.rowSpacing
      clip: true
      interactive: view.interactive
      boundsBehavior: Flickable.StopAtBounds
      flickableDirection: Flickable.VerticalFlick
      maximumFlickVelocity: Math.round(6000 * Style.fontScale)
      flickDeceleration: Math.round(1500 * Style.fontScale)
      WheelHandler {
        enabled: view.interactive
        target: null
        onWheel: function(event) { scroller.applyWheel(event) }
      }
    }
    Rectangle {
      id: track
      visible: list.contentHeight > list.height && list.height > 0
      width: scroller.trackWidth
      radius: width / 2
      color: trackMouse.containsMouse ? Util.alpha(view.desk.themeForeground, 0.09) : "transparent"
      x: scroller.width - width
      y: 0
      height: list.height
      function seek(pointerY) {
        var usable = Math.max(1, height - thumb.height)
        var ratio = Math.max(0, Math.min(1, (pointerY - thumb.height / 2) / usable))
        list.contentY = ratio * Math.max(0, list.contentHeight - list.height)
      }
      Rectangle {
        id: thumb
        width: Math.max(6, Math.round(8 * Style.fontScale))
        x: (parent.width - width) / 2
        radius: width / 2
        color: trackMouse.pressed ? view.desk.cyan : Util.alpha(view.desk.cyan, trackMouse.containsMouse ? 0.78 : 0.55)
        y: Math.max(0, Math.min(parent.height - height, (list.contentY / Math.max(1, list.contentHeight - list.height)) * Math.max(0, parent.height - height)))
        height: Math.max(Math.round(24 * Style.fontScale), parent.height * parent.height / Math.max(parent.height, list.contentHeight))
      }
      MouseArea {
        id: trackMouse
        anchors.fill: parent
        enabled: view.interactive
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onWheel: function(wheel) { scroller.applyWheel(wheel) }
        onPressed: function(mouse) { track.seek(mouse.y) }
        onPositionChanged: function(mouse) { if (pressed) track.seek(mouse.y) }
      }
    }
  }

  // The horizontal sibling of ScrollList, for the session carousel: cards of a
  // fixed width on one scrolling strip. Deliberately a second component rather
  // than a two-axis ScrollList — the wheel mapping, the track geometry, the
  // edge fades and keeping a keyboard selection on screen are all different
  // enough that one component parameterised by orientation read worse than two.
  //
  // Nothing here rotates on its own. Periodic movement on a wallpaper steals
  // attention all day and slides the card out from under the pointer, so the
  // strip only ever moves when the user (or the keyboard selection) moves it.
  component ScrollRow: Item {
    id: rail
    property alias model: list.model
    property alias delegate: list.delegate
    property alias count: list.count
    property real cardWidth: Math.round(380 * Style.fontScale)
    // Uniform cards: a carousel wants them interchangeable, and it is what
    // makes "which ones are on screen" arithmetic instead of a hit test.
    property real cardHeight: Math.round(118 * Style.fontScale)
    property real emptyHeight: Math.round(24 * Style.fontScale)
    // The keyboard selection (J/K in the overlay). Kept on screen, because a
    // selection that steps off the strip makes J/K look broken: the key does
    // something and nothing visible changes.
    property int currentIndex: -1
    readonly property real trackHeight: Math.max(8, Math.round(10 * Style.fontScale))
    readonly property real listHeight: rail.cardHeight
    width: parent ? parent.width : 400
    // The track is only paid for when there is something to scroll, so a desk
    // with three sessions hands those pixels back to RECENT TASKS below.
    implicitHeight: list.count === 0 ? rail.emptyHeight : rail.cardHeight + (rail.scrollable ? rail.trackHeight + Style.spacing.xs : 0)
    readonly property real pitch: rail.cardWidth + list.spacing
    readonly property bool scrollable: list.contentWidth > list.width + 1
    // Cards are uniform, so which ones are on screen is arithmetic rather than
    // a hit test — and it stays correct mid-flick.
    readonly property int firstVisible: rail.pitch > 0 ? Math.max(0, Math.min(Math.max(0, list.count - 1), Math.round(list.contentX / rail.pitch))) : 0
    // Rounded, not floored: a card showing three quarters of itself is one the
    // eye counts, and "1-2 of 6" beside three visible cards reads as a bug.
    readonly property int visibleCount: rail.pitch > 0 ? Math.max(1, Math.round((list.width + list.spacing) / rail.pitch)) : 1
    readonly property int lastVisible: Math.min(list.count, rail.firstVisible + rail.visibleCount)
    function applyWheel(wheel) {
      // A vertical wheel over a horizontal strip does nothing by default, so
      // both axes are mapped here: a touchpad's horizontal swipe if it sent
      // one, otherwise the vertical notch everyone actually has.
      var pixel = wheel.pixelDelta ? (Number(wheel.pixelDelta.x || 0) || Number(wheel.pixelDelta.y || 0)) : 0
      var angle = wheel.angleDelta ? (Number(wheel.angleDelta.x || 0) || Number(wheel.angleDelta.y || 0)) : 0
      var delta = pixel !== 0 ? pixel * 2.75 : (angle / 120) * Math.round(120 * Style.fontScale)
      if (!isFinite(delta) || delta === 0) { wheel.accepted = false; return }
      list.contentX = Math.max(0, Math.min(Math.max(0, list.contentWidth - list.width), list.contentX - delta))
      wheel.accepted = true
    }
    onCurrentIndexChanged: if (rail.currentIndex >= 0 && rail.currentIndex < list.count) list.positionViewAtIndex(rail.currentIndex, ListView.Contain)
    ListView {
      id: list
      orientation: ListView.Horizontal
      width: rail.width
      height: rail.cardHeight
      spacing: Style.spacing.md
      clip: true
      interactive: view.interactive
      boundsBehavior: Flickable.StopAtBounds
      flickableDirection: Flickable.HorizontalFlick
      maximumFlickVelocity: Math.round(6000 * Style.fontScale)
      flickDeceleration: Math.round(1500 * Style.fontScale)
      WheelHandler {
        enabled: view.interactive
        target: null
        onWheel: function(event) { rail.applyWheel(event) }
      }
    }
    // There is no keyboard on the wallpaper, so the fades are the only hint
    // that the strip continues. They sit over the list, under the pointer.
    Rectangle {
      width: Math.round(28 * Style.fontScale)
      height: list.height
      x: 0
      visible: rail.scrollable && list.contentX > 1
      gradient: Gradient {
        orientation: Gradient.Horizontal
        GradientStop { position: 0.0; color: Util.alpha(view.desk.themeBackground, 0.9) }
        GradientStop { position: 1.0; color: "transparent" }
      }
    }
    Rectangle {
      width: Math.round(28 * Style.fontScale)
      height: list.height
      x: rail.width - width
      visible: rail.scrollable && list.contentX < list.contentWidth - list.width - 1
      gradient: Gradient {
        orientation: Gradient.Horizontal
        GradientStop { position: 0.0; color: "transparent" }
        GradientStop { position: 1.0; color: Util.alpha(view.desk.themeBackground, 0.9) }
      }
    }
    Rectangle {
      id: track
      visible: rail.scrollable
      height: rail.trackHeight
      width: rail.width
      radius: height / 2
      y: list.height + Style.spacing.xs
      color: trackMouse.containsMouse ? Util.alpha(view.desk.themeForeground, 0.09) : "transparent"
      function seek(pointerX) {
        var usable = Math.max(1, width - thumb.width)
        var ratio = Math.max(0, Math.min(1, (pointerX - thumb.width / 2) / usable))
        list.contentX = ratio * Math.max(0, list.contentWidth - list.width)
      }
      Rectangle {
        id: thumb
        height: Math.max(4, Math.round(6 * Style.fontScale))
        y: (parent.height - height) / 2
        radius: height / 2
        color: trackMouse.pressed ? view.desk.cyan : Util.alpha(view.desk.cyan, trackMouse.containsMouse ? 0.78 : 0.55)
        width: Math.max(Math.round(28 * Style.fontScale), parent.width * list.width / Math.max(list.width, list.contentWidth))
        x: Math.max(0, Math.min(parent.width - width, (list.contentX / Math.max(1, list.contentWidth - list.width)) * Math.max(0, parent.width - width)))
      }
      MouseArea {
        id: trackMouse
        anchors.fill: parent
        enabled: view.interactive
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onWheel: function(wheel) { rail.applyWheel(wheel) }
        onPressed: function(mouse) { track.seek(mouse.x) }
        onPositionChanged: function(mouse) { if (pressed) track.seek(mouse.x) }
      }
    }
  }

  component Tag: Rectangle {
    property string text: ""
    property color tone: Color.accent
    color: Util.alpha(tone, 0.18)
    border.color: Util.alpha(tone, 0.5)
    border.width: 1
    radius: view.radius
    implicitWidth: tl.implicitWidth + Style.spacing.md * 2
    implicitHeight: tl.implicitHeight + Style.spacing.xs * 2
    PlainText { id: tl; anchors.centerIn: parent; text: parent.text; color: tone; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
  }

  component SectionChip: Rectangle {
    id: sectionChip
    required property var section
    readonly property bool selected: view.settings.sectionEnabled(section.id)
    readonly property bool needsAttention: section.id === "needs" && view.visibleAttention.length > 0
    color: Util.alpha(selected ? view.desk.green : view.desk.themeForeground, selected ? 0.13 : 0.035)
    border.color: Util.alpha(selected ? view.desk.green : view.desk.themeForeground, selected ? 0.45 : 0.13)
    border.width: 1
    SequentialAnimation on opacity {
      running: sectionChip.needsAttention && sectionChip.visible
      loops: Animation.Infinite
      NumberAnimation { from: 0.72; to: 1; duration: 1200; easing.type: Easing.InOutSine }
      NumberAnimation { from: 1; to: 0.72; duration: 1200; easing.type: Easing.InOutSine }
    }
    radius: view.radius
    implicitWidth: sectionLabel.implicitWidth + Style.spacing.lg * 2
    implicitHeight: sectionLabel.implicitHeight + Style.spacing.xs * 2
    PlainText {
      id: sectionLabel
      anchors.centerIn: parent
      text: (parent.selected ? "● " : "○ ") + parent.section.label
      color: parent.selected ? view.textDim : view.textFaint
      font.family: view.mono
      font.pixelSize: Style.font.caption
      font.bold: parent.selected
    }
    MouseArea {
      anchors.fill: parent
      enabled: view.interactive
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: view.settings.toggleSection(parent.section.id)
    }
  }

  // ---- layout ----------------------------------------------------------------
  Item {
    anchors { fill: parent; topMargin: view.topInset + view.gap; leftMargin: view.gap * 2; rightMargin: view.gap * 2; bottomMargin: view.gap * 2 }

    ColumnLayout {
      anchors.fill: parent
      spacing: Style.spacing.sm

      Flow {
        id: moduleStrip
        Layout.fillWidth: true
        Layout.preferredHeight: implicitHeight
        spacing: Style.spacing.sm
        Repeater {
          model: view.settings.definitions
          delegate: SectionChip { required property var modelData; section: modelData }
        }
        Tag {
          visible: view.projectFilter !== ""
          text: "PROJECT · " + view.projectFilter.replace(/^.*\//, "") + " ×"
          tone: view.desk.cyan
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.projectFilter = "" }
        }
        // Discoverability, faint and in the strip: the two keys everyone needs.
        // On the wallpaper SUPER+D opens the desktop view; in that view it closes it.
        Tag { text: view.keyboardAvailable ? "SUPER+I HIDE DESK · SUPER+D / ESC CLOSE" : "SUPER+I HIDE DESK · SUPER+D SHOW OVER WINDOWS"; tone: view.textFaint }
        // Keyboard shortcuts only reach the overlay (the wallpaper layer has no keyboard focus).
        Tag { visible: view.keyboardAvailable; text: "1–9, 0 MODULES · J/K SESSION · ENTER FOCUS · A CLEAR"; tone: view.textFaint }
        Tag {
          visible: view.desk.bunChecked && !view.desk.bunAvailable
          text: "⚠ " + view.desk.missingDependencyHint
          tone: view.desk.red
        }
      }

      RowLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        spacing: view.gap

      // LEFT COLUMN: sessions + heatmap + recent
      ColumnLayout {
        id: leftColumn
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.preferredWidth: 3
        Layout.maximumWidth: view.width - view.rightColumnWidth - view.gap * 5
        spacing: view.gap

        // ---- live sessions ----
        Card {
          Layout.fillWidth: true
          visible: view.sectionEnabled("sessions")
          title: "LIVE AI SESSIONS"
          // With a carousel, "6 running" alone is a lie about what you can
          // see, so the hint says which of them are on screen.
          hint: view.sessions.length + " running"
            + (sessionRail.scrollable ? " · " + (sessionRail.firstVisible + 1) + "–" + sessionRail.lastVisible + " of " + view.sessions.length + " · wheel scrolls" : "")
            + " · left focus · right inspect" + (view.desk.error ? " · ⚠ " + view.desk.error : "")
          ScrollRow {
            id: sessionRail
            model: view.sessions
            // J/K in the overlay moves this; the strip follows so the outlined
            // card is always the one you can see.
            currentIndex: view.keyboardSessionIndex
            delegate: Rectangle {
              id: sc
              required property var modelData
              required property int index
              readonly property color tone: view.desk.providerColor(modelData.provider)
              // The collector decides this, and no longer by reading the
              // terminal title: Herdr reports the pane's real state, Claude's
              // own registry reports its own, and the systemd turn inhibitor
              // is a running turn. A title regex here would have overruled all
              // three whenever an agent forgot to clear "Processing…".
              readonly property bool busy: modelData.busy === true
              property string previewSource: view.previewCache[String((sc.modelData.window || {}).address || "")] || ""
              // Uniform, so the strip is a carousel rather than a ragged row.
              width: sessionRail.cardWidth
              height: sessionRail.listHeight
              // A daemon-hosted background session is real but unattended; dim it so it reads as secondary next to the interactive one.
              opacity: (sc.modelData.hosts || []).some(function(h) { return h && h.kind === "background" }) ? 0.72 : 1
              color: hover.containsMouse ? Util.alpha(tone, 0.16) : Util.alpha(tone, 0.08)
              border.color: view.keyboardSessionIndex === index ? tone : Util.alpha(tone, hover.containsMouse ? 0.9 : 0.45); border.width: view.keyboardSessionIndex === index ? 2 : 1; radius: view.radius
              clip: true
              Image { anchors.fill: parent; visible: hover.containsMouse && view.previewsEnabled && sc.previewSource !== ""; source: sc.previewSource; fillMode: Image.PreserveAspectCrop; opacity: 0.28 }
              Timer { interval: 600; running: hover.containsMouse && view.previewsEnabled && sc.previewSource === "" && !!(sc.modelData.window && sc.modelData.window.address); onTriggered: if (!previewProc.running) previewProc.running = true }
              Process {
                id: previewProc
                command: ["bun", view.desk.previewPath, (sc.modelData.window || {}).address || ""]
                stdout: StdioCollector { onStreamFinished: {
                  var path = String(text || "").trim()
                  if (!path) return
                  var source = "file://" + path + "?" + Date.now(), address = String((sc.modelData.window || {}).address || "")
                  var next = {}
                  for (var key in view.previewCache) next[key] = view.previewCache[key]
                  // Replacing a preview for this window: delete the old artifact first.
                  if (next[address]) view.desk.removePreview(next[address])
                  next[address] = source
                  view.previewCache = next
                  sc.previewSource = source
                } }
              }
              // Five lines, and only five. The window title duplicated the
              // topic, the cwd duplicated the project, and the telemetry line
              // repeated what MACHINE already reports — all three moved to the
              // right-click inspector, which is where you go when you want the
              // detail. What is left is what distinguishes one session from
              // another at a glance, which is the thing the old narrow cards
              // elided away.
              ColumnLayout {
                id: scol
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: Style.spacing.lg }
                spacing: Style.spacing.xs
                RowLayout {
                  Layout.fillWidth: true
                  spacing: Style.spacing.sm
                  Rectangle { id: dot; width: 8; height: 8; radius: 4; color: sc.tone
                    SequentialAnimation { running: sc.busy && sc.visible; loops: Animation.Infinite
                      onRunningChanged: if (!running) dot.opacity = 1
                      NumberAnimation { target: dot; property: "opacity"; from: 1; to: 0.2; duration: 700 }
                      NumberAnimation { target: dot; property: "opacity"; from: 0.2; to: 1; duration: 700 } } }
                  PlainText { text: view.desk.providerLabel(sc.modelData.provider); color: sc.tone; font.family: view.mono; font.bold: true; font.pixelSize: Style.font.body }
                  // A stale session is idle by definition, so STALE replaces the
                  // status word instead of sitting redundantly beside "IDLE" —
                  // and keeps how long it has been idle, which is the part that
                  // tells you whether to kill it.
                  Tag { visible: sc.modelData.stale !== true; text: view.sessionStateLabel(sc.modelData); tone: view.sessionStateTone(sc.modelData) }
                  // Unattended and idle for hours: probably a zombie. Right-click → inspector → STOP / END.
                  Tag { visible: sc.modelData.stale === true; text: "STALE · idle " + view.desk.dur((Date.now() - Number(sc.modelData.idleSince || Date.now())) / 1000); tone: view.desk.yellow }
                  Item { Layout.fillWidth: true; Layout.minimumWidth: 0 }
                  PlainText { text: view.desk.dur(sc.modelData.uptimeSec); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                }
                PlainText { Layout.fillWidth: true; text: sc.modelData.project || "/"; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.subtitle; elide: Text.ElideMiddle }
                PlainText {
                  Layout.fillWidth: true
                  text: sc.modelData.topic ? "↳ " + sc.modelData.topic : "↳ " + ((sc.modelData.window || {}).title || "topic unavailable")
                  color: sc.modelData.topic ? sc.tone : view.textDim
                  font.family: view.mono
                  font.pixelSize: Style.font.bodySmall
                  font.bold: !!sc.modelData.topic
                  wrapMode: Text.Wrap
                  maximumLineCount: 2
                  elide: Text.ElideRight
                }
                PlainText { Layout.fillWidth: true; visible: !!sc.modelData.git; text: sc.modelData.git ? ("git " + sc.modelData.git.branch + (sc.modelData.git.dirty ? " · " + sc.modelData.git.dirty + " changed" : " · clean") + (sc.modelData.git.ahead ? " · ↑" + sc.modelData.git.ahead : "") + (sc.modelData.git.behind ? " · ↓" + sc.modelData.git.behind : "") + (sc.modelData.git.conflicts ? " · " + sc.modelData.git.conflicts + " conflicts" : "")) : ""; color: sc.modelData.git && sc.modelData.git.conflicts ? view.desk.red : sc.modelData.git && sc.modelData.git.dirty ? view.desk.yellow : view.desk.green; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                // Where the session lives, by the names Herdr's own UI shows —
                // "herdr ~ › recover", not the wB:t1:p1 the click aims at. The
                // ids are on the host record still, and the right-click
                // inspector prints them, which is where they help.
                //
                // The click hint is only appended when the click does something
                // other than jump to the pane. It used to be there always, so
                // 25 characters that were identical on every card pushed the
                // one abnormal case — the click that does nothing — off the end
                // of an elided line.
                PlainText { Layout.fillWidth: true; visible: (sc.modelData.hosts || []).length > 0; text: "hosted in " + view.sessionHostLabel(sc.modelData) + (sc.modelData.window ? "" : ((sc.modelData.hosts || []).some(function(h) { return h && h.kind === "background" && h.attachId }) ? " · click attaches a terminal" : " · no client window found")); color: sc.tone; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
              }
              MouseArea {
                id: hover; anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
                cursorShape: sc.modelData.window || (sc.modelData.hosts || []).some(function(h) { return h && ((h.kind === "boomux" && h.shellId) || (h.kind === "background" && h.attachId)) }) ? Qt.PointingHandCursor : Qt.ArrowCursor
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(mouse) {
                  if (mouse.button === Qt.RightButton) view.inspectedSession = sc.modelData
                  else if (view.desk.focusSession(sc.modelData)) view.navigated()
                }
              }
            }
            PlainText {
              anchors { left: parent.left; right: parent.right; top: parent.top }
              visible: view.sessions.length === 0
              wrapMode: Text.Wrap
              text: view.desk.bunChecked && !view.desk.bunAvailable ? view.desk.missingDependencyHint
                : view.desk.ready ? "no agents running — go start something"
                : view.desk.error ? "collector error · " + view.desk.error
                : "collecting…"
              color: view.desk.bunChecked && !view.desk.bunAvailable ? view.desk.red : view.textFaint
              font.family: view.mono; font.pixelSize: Style.font.body
            }
          }
        }

        // ---- draggable operations intelligence ----
        GridLayout {
          visible: view.sectionEnabled("changes") || view.sectionEnabled("needs") || view.sectionEnabled("projects")
          Layout.fillWidth: true
          columns: Math.max(1, view.settings.enabledOpsCount())
          columnSpacing: view.gap
          Card {
            Layout.column: view.settings.opsVisibleIndex("changes")
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignTop
            visible: view.sectionEnabled("changes")
            moveId: "changes"
            moveGroup: "ops"
            dragAxis: "horizontal"
            draggable: true
            title: "WHAT CHANGED"
            hint: view.changeProjects.filter(function(item) { return view.changeUnseen(item) }).length + " unseen · click to inspect"
            glow: view.changeProjects.some(function(item) { return view.changeUnseen(item) })
            glowTone: view.desk.cyan
            ColumnLayout {
              width: parent.width
              spacing: Style.spacing.sm
              Repeater {
                model: {
                  var shown = view.changeProjects.slice(0, 3)
                  // Marking a row seen re-sorts it; keep the one being inspected on screen.
                  if (view.expandedChangeKey && !shown.some(function(item) { return view.projectKey(item) === view.expandedChangeKey })) {
                    var expanded = view.changeProjects.filter(function(item) { return view.projectKey(item) === view.expandedChangeKey })
                    if (expanded.length) shown = shown.slice(0, 2).concat(expanded)
                  }
                  return shown
                }
                delegate: Rectangle {
                  id: changeRow
                  required property var modelData
                  readonly property string key: view.projectKey(modelData)
                  readonly property var change: modelData.changes || ({})
                  readonly property bool unseen: view.changeUnseen(modelData)
                  readonly property bool expanded: view.expandedChangeKey === key
                  readonly property color tone: view.projectTone(modelData)
                  Layout.fillWidth: true
                  implicitHeight: changeColumn.implicitHeight + Style.spacing.sm * 2
                  radius: view.radius
                  color: Util.alpha(tone, unseen ? 0.13 : changeHover.hovered ? 0.09 : 0.035)
                  border.color: Util.alpha(tone, unseen ? 0.7 : 0.18)
                  border.width: 1
                  ColumnLayout {
                    id: changeColumn
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: Style.spacing.sm }
                    spacing: Style.spacing.xs
                    RowLayout {
                      Layout.fillWidth: true
                      Rectangle { width: 7; height: 7; radius: 4; color: changeRow.unseen ? changeRow.tone : view.textFaint }
                      PlainText { text: changeRow.modelData.project || changeRow.key; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; font.bold: changeRow.unseen; Layout.preferredWidth: Math.round(120 * Style.fontScale); elide: Text.ElideMiddle }
                      PlainText { Layout.fillWidth: true; text: view.changeSummary(changeRow.modelData); color: changeRow.unseen ? changeRow.tone : view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                      PlainText { text: changeRow.expanded ? "▴" : "▾"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                    }
                    Flow {
                      Layout.fillWidth: true
                      visible: changeRow.expanded
                      spacing: Style.spacing.xs
                      Repeater {
                        model: changeRow.change.files || []
                        delegate: Tag {
                          required property string modelData
                          text: modelData
                          tone: changeRow.tone
                          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.copyText(parent.modelData) }
                        }
                      }
                      Tag { visible: !!changeRow.modelData.cwd; text: "OPEN PROJECT"; tone: view.desk.green; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.openProject(changeRow.modelData.cwd) } }
                    }
                    PlainText { Layout.fillWidth: true; visible: changeRow.expanded && !!changeRow.change.commitSubject; text: (changeRow.change.headShort || "HEAD") + " · " + changeRow.change.commitSubject; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                  }
                  HoverHandler { id: changeHover; enabled: view.interactive; cursorShape: Qt.PointingHandCursor }
                  TapHandler {
                    enabled: view.interactive
                    onTapped: {
                      view.settings.markChangeSeen(changeRow.key, changeRow.change.fingerprint)
                      view.expandedChangeKey = changeRow.expanded ? "" : changeRow.key
                    }
                  }
                }
              }
              PlainText { visible: view.changeProjects.length === 0; text: "no active repositories"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
            }
          }

          Card {
            Layout.column: view.settings.opsVisibleIndex("needs")
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignTop
            visible: view.sectionEnabled("needs")
            moveId: "needs"
            moveGroup: "ops"
            dragAxis: "horizontal"
            draggable: true
            title: "NEXT ACTIONS"
            hint: view.visibleAttention.length + " signals · " + view.visibleCollisions.length + " shared repos"
            glow: view.visibleAttention.length > 0
            glowTone: view.desk.yellow
            ColumnLayout {
              width: parent.width
              spacing: Style.spacing.sm
              Flow {
                Layout.fillWidth: true
                spacing: Style.spacing.xs
                Tag {
                  text: "ALERTS " + (view.settings.notificationsEnabled ? "ON" : "OFF")
                  tone: view.settings.notificationsEnabled ? view.desk.green : view.textFaint
                  MouseArea { anchors.fill: parent; enabled: view.interactive; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.toggleNotificationsEnabled() }
                }
                Tag {
                  text: "QUIET " + (view.settings.quietStartHour < 10 ? "0" : "") + view.settings.quietStartHour + "–" + (view.settings.quietEndHour < 10 ? "0" : "") + view.settings.quietEndHour + " " + (view.settings.quietHoursEnabled ? "ON" : "OFF")
                  tone: view.settings.quietHoursEnabled ? view.desk.yellow : view.textFaint
                  MouseArea { anchors.fill: parent; enabled: view.interactive; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.toggleQuietHoursEnabled() }
                }
                Repeater {
                  model: view.activeNotificationProviders
                  delegate: Tag {
                    required property string modelData
                    text: view.desk.providerLabel(modelData) + " " + (view.settings.notificationProviderEnabled(modelData) ? "●" : "○")
                    tone: view.settings.notificationProviderEnabled(modelData) ? view.desk.providerColor(modelData) : view.textFaint
                    MouseArea { anchors.fill: parent; enabled: view.interactive; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.toggleNotificationProvider(parent.modelData) }
                  }
                }
              }
              Repeater {
                model: view.visibleAttention.slice(0, 3)
                delegate: Rectangle {
                  id: attentionRow
                  required property var modelData
                  readonly property color tone: modelData.attention === "blocked" ? view.desk.red : modelData.attention === "waiting" ? view.desk.yellow : view.desk.green
                  Layout.fillWidth: true
                  implicitHeight: attentionColumn.implicitHeight + Style.spacing.sm * 2
                  radius: view.radius
                  color: Util.alpha(tone, 0.07)
                  border.color: Util.alpha(tone, 0.35)
                  border.width: 1
                  ColumnLayout {
                    id: attentionColumn
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: Style.spacing.sm }
                    spacing: Style.spacing.xs
                    RowLayout {
                      Layout.fillWidth: true
                      Tag { text: attentionRow.modelData.attention === "blocked" ? "⚠ BLOCKED" : attentionRow.modelData.attention === "waiting" ? "? WAITING" : "✓ REVIEW"; tone: attentionRow.tone }
                      PlainText { Layout.fillWidth: true; text: attentionRow.modelData.project; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; font.bold: true; elide: Text.ElideMiddle }
                      PlainText { text: view.desk.ago(attentionRow.modelData.startedAt); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                    }
                    PlainText { Layout.fillWidth: true; text: attentionRow.modelData.attentionReason || "session needs attention"; color: attentionRow.tone; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight }
                    Flow {
                      Layout.fillWidth: true
                      spacing: Style.spacing.xs
                      Tag { text: view.attentionPrimaryLabel(attentionRow.modelData); tone: attentionRow.tone; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.activateAttention(attentionRow.modelData) } }
                      Tag { visible: !!attentionRow.modelData.attentionDetail; text: "COPY DETAIL"; tone: view.desk.cyan; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.copyText(attentionRow.modelData.attentionDetail) } }
                      Tag { text: "10M"; tone: view.textDim; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.snoozeAttention(view.attentionKey(attentionRow.modelData)) } }
                      Tag { text: "×"; tone: view.textFaint; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.dismissAttention(view.attentionKey(attentionRow.modelData)) } }
                    }
                  }
                }
              }
              Flow {
                Layout.fillWidth: true
                visible: view.visibleCollisions.length > 0
                spacing: Style.spacing.xs
                Repeater {
                  model: view.visibleCollisions
                  delegate: Tag { required property var modelData; text: "⚠ SHARED · " + modelData.project + " · " + modelData.agents.length + " agents"; tone: view.desk.yellow }
                }
              }
              PlainText { visible: view.visibleAttention.length === 0 && view.visibleCollisions.length === 0; text: "nothing waiting — all sessions can continue"; color: view.desk.green; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
            }
          }

          Card {
            Layout.column: view.settings.opsVisibleIndex("projects")
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignTop
            visible: view.sectionEnabled("projects")
            moveId: "projects"
            moveGroup: "ops"
            dragAxis: "horizontal"
            draggable: true
            title: "PROJECT HEALTH"
            hint: view.projects.length + " repos · click to filter"
            glow: view.projects.some(function(item) { return item.status === "blocked" })
            glowTone: view.desk.red
            ColumnLayout {
              width: parent.width
              spacing: Style.spacing.sm
              Repeater {
                model: view.projects.slice(0, 4)
                delegate: Rectangle {
                  id: projectRow
                  required property var modelData
                  readonly property string key: view.projectKey(modelData)
                  readonly property color tone: view.projectTone(modelData)
                  readonly property var git: modelData.git || ({})
                  readonly property var change: modelData.changes || ({})
                  Layout.fillWidth: true
                  implicitHeight: projectColumn.implicitHeight + Style.spacing.sm * 2
                  radius: view.radius
                  color: Util.alpha(tone, projectHover.hovered || view.projectFilter === key ? 0.15 : 0.06)
                  border.color: Util.alpha(tone, view.projectFilter === key ? 0.85 : 0.35)
                  border.width: view.projectFilter === key ? 2 : 1
                  RowLayout {
                    id: projectColumn
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: Style.spacing.sm }
                    spacing: Style.spacing.sm
                    Tag { text: view.projectStatusLabel(projectRow.modelData); tone: projectRow.tone }
                    PlainText { text: projectRow.modelData.project || projectRow.key; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; font.bold: true; elide: Text.ElideMiddle; Layout.maximumWidth: Math.round(120 * Style.fontScale) }
                    PlainText {
                      Layout.fillWidth: true
                      text: (projectRow.git.branch || "no branch") + (projectRow.git.dirty ? " · " + projectRow.git.dirty + " changed" : " · clean") + (projectRow.git.ahead ? " · ↑" + projectRow.git.ahead : "") + (projectRow.git.behind ? " · ↓" + projectRow.git.behind : "") + (projectRow.git.conflicts ? " · " + projectRow.git.conflicts + " conflicts" : "") + " · " + view.ciLabel(projectRow.modelData)
                      color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight
                    }
                    PlainText { text: (projectRow.modelData.agents || []).length + " AI"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                    Tag { visible: view.desk.canOpenProject(projectRow.modelData.cwd); text: "OPEN"; tone: view.desk.green; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.openProject(projectRow.modelData.cwd) } }
                  }
                  HoverHandler { id: projectHover; enabled: view.interactive; cursorShape: Qt.PointingHandCursor }
                  TapHandler { enabled: view.interactive; onTapped: view.projectFilter = view.projectFilter === projectRow.key ? "" : projectRow.key }
                }
              }
              PlainText { visible: view.projects.length === 0; text: "no active repositories"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
            }
          }
        }

        // ---- heatmaps: AI prompts on the left, GitHub on the right ----
        RowLayout {
          Layout.fillWidth: true
          visible: view.sectionEnabled("activity") || view.sectionEnabled("github")
          spacing: view.gap
          Card {
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            Layout.minimumWidth: 0
            visible: view.sectionEnabled("activity")
            title: "ACTIVITY · LAST 7 DAYS"
            hint: {
              var c = view.ai.counts || {}; var parts = []
              for (var k in c) parts.push(view.desk.providerLabel(k) + " " + c[k].today + "/" + c[k].week)
              return parts.length ? "today/week · " + parts.join(" · ") : ""
            }
            HeatPanel {
              cells: (view.ai.heatmap || {}).cells || []
              startTs: (view.ai.heatmap || {}).start || 0
              days: (view.ai.heatmap || {}).days || []
              kinds: ["claude", "codex", "grok", "opencode", "gemini", "ollama"]
              unit: "prompts"
              selectedCell: view.activityCellFilter
              selectedKind: view.activityProviderFilter
              filterActive: view.activityFilterActive
              filterLabel: view.activityFilterLabel()
              onCellClicked: function(index) { view.toggleActivityCell(index) }
              onKindClicked: function(kind) { view.toggleActivityProvider(kind) }
              onClearClicked: view.clearActivityFilter()
            }
          }
          Card {
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            Layout.minimumWidth: 0
            visible: view.sectionEnabled("github")
            title: "GITHUB · LAST 7 DAYS"
            hint: view.githubHint()
            HeatPanel {
              cells: view.github.cells || []
              startTs: (view.github.days || [])[0] || 0
              days: view.github.days || []
              kinds: view.githubKinds
              colorFor: function(kind) { return view.githubKindColor(kind) }
              labelFor: function(kind) { return view.githubKindLabel(kind) }
              unit: "events"
              showRepos: true
              kindFiltersCells: true
              selectedCell: view.githubCellFilter
              selectedKind: view.githubKindFilter
              filterActive: view.githubFilterActive
              filterLabel: view.githubFilterLabel()
              idleStatus: view.githubStatus()
              hoverStatus: "click to pin"
              pinnedBreakdown: true
              emptyText: view.github.state === "ok" ? "no GitHub activity in the last 7 days" : view.githubStatus()
              onCellClicked: function(index) { view.toggleGithubCell(index) }
              onKindClicked: function(kind) { view.toggleGithubKind(kind) }
              onClearClicked: { view.githubCellFilter = -1; view.githubKindFilter = "" }
            }
          }
        }

        // ---- GITHUB · YOU: my open PRs, and what is waiting on me ----
        // Deliberately short. RECENT TASKS below is the only elastic element
        // in this column, so every pixel spent here comes out of it; both
        // lists scroll instead of growing.
        Card {
          Layout.fillWidth: true
          visible: view.sectionEnabled("githubYou")
          title: "GITHUB · YOU"
          hint: view.githubYouHint()
          clip: true
          RowLayout {
            id: githubYouColumns
            width: parent.width
            spacing: view.gap
            ColumnLayout {
              Layout.fillWidth: true
              Layout.preferredWidth: 1
              Layout.minimumWidth: 0
              Layout.alignment: Qt.AlignTop
              spacing: Style.spacing.xs
              PlainText { text: "MY PRS"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; font.letterSpacing: 1.2; font.bold: true }
              ScrollList {
                id: prScroll
                Layout.fillWidth: true
                Layout.preferredHeight: view.githubYouListHeight
                model: view.githubYouPrs
                delegate: Rectangle {
                  id: prRow
                  required property var modelData
                  readonly property color tone: view.desk.magenta
                  width: prScroll.rowWidth
                  height: prLine.implicitHeight + Style.spacing.xs
                  radius: view.radius
                  color: prHover.hovered ? Util.alpha(prRow.tone, 0.14) : "transparent"
                  border.color: prHover.hovered ? Util.alpha(prRow.tone, 0.5) : "transparent"
                  border.width: prHover.hovered ? 1 : 0
                  RowLayout {
                    id: prLine
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; leftMargin: Style.spacing.sm; rightMargin: Style.spacing.sm }
                    spacing: Style.spacing.sm
                    PlainText { text: view.desk.ago(prRow.modelData.ts); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(32 * Style.fontScale); horizontalAlignment: Text.AlignRight }
                    // One letter, always present: a conditional tag shifted every
                    // cell behind it, so draft rows and open rows never lined up.
                    Tag { readonly property bool draft: prRow.modelData.isDraft === true; text: draft ? "D" : "O"; tone: draft ? view.textFaint : view.desk.magenta }
                    PlainText { text: view.shortRepo(prRow.modelData.repo); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight; Layout.maximumWidth: Math.round(74 * Style.fontScale) }
                    PlainText { text: "#" + Number(prRow.modelData.number || 0); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                    PlainText {
                      Layout.fillWidth: true
                      Layout.minimumWidth: 0
                      text: String(prRow.modelData.title || "")
                      color: view.desk.themeForeground
                      font.family: view.mono; font.pixelSize: Style.font.bodySmall
                      elide: Text.ElideRight; maximumLineCount: 1
                    }
                    PlainText { text: view.githubCiMark(prRow.modelData.ci); color: view.githubCiTone(prRow.modelData.ci); font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
                    PlainText { visible: String(prRow.modelData.review || "") === "REVIEW_REQUIRED"; text: "REVIEW"; color: view.desk.yellow; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
                  }
                  HoverHandler { id: prHover; enabled: view.interactive; cursorShape: Qt.PointingHandCursor }
                  TapHandler { enabled: view.interactive; acceptedButtons: Qt.LeftButton; onTapped: view.openGithub(prRow.modelData.url) }
                }
                PlainText {
                  anchors.centerIn: parent
                  width: parent.width - Style.spacing.md * 2
                  visible: view.githubYouPrs.length === 0
                  text: String(view.githubYou.state || "") === "ok" ? "no open pull requests" : view.githubYouStatus()
                  color: view.textFaint
                  font.family: view.mono; font.pixelSize: Style.font.bodySmall
                  horizontalAlignment: Text.AlignHCenter
                  elide: Text.ElideRight
                }
              }
            }
            ColumnLayout {
              Layout.fillWidth: true
              Layout.preferredWidth: 1
              Layout.minimumWidth: 0
              Layout.alignment: Qt.AlignTop
              spacing: Style.spacing.xs
              PlainText { text: "REVIEW REQUESTS"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; font.letterSpacing: 1.2; font.bold: true }
              ScrollList {
                id: inboxScroll
                Layout.fillWidth: true
                Layout.preferredHeight: view.githubYouListHeight
                model: view.githubYouInbox
                delegate: Rectangle {
                  id: inboxRow
                  required property var modelData
                  readonly property bool isRule: String(modelData.kind || "") === "rule"
                  readonly property bool isNote: String(modelData.kind || "") === "note"
                  readonly property var row: modelData.row || ({})
                  readonly property color tone: inboxRow.isNote ? view.desk.cyan : view.desk.magenta
                  width: inboxScroll.rowWidth
                  height: inboxRow.isRule ? Math.round(9 * Style.fontScale) : inboxLine.implicitHeight + Style.spacing.xs
                  radius: view.radius
                  color: (!inboxRow.isRule && inboxHover.hovered) ? Util.alpha(inboxRow.tone, 0.14) : "transparent"
                  border.color: (!inboxRow.isRule && inboxHover.hovered) ? Util.alpha(inboxRow.tone, 0.5) : "transparent"
                  border.width: (!inboxRow.isRule && inboxHover.hovered) ? 1 : 0
                  // Reviews owed above, unread notifications below.
                  Rectangle {
                    visible: inboxRow.isRule
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; leftMargin: Style.spacing.sm; rightMargin: Style.spacing.sm }
                    height: 1
                    color: Util.alpha(view.desk.themeForeground, 0.16)
                  }
                  RowLayout {
                    id: inboxLine
                    visible: !inboxRow.isRule
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; leftMargin: Style.spacing.sm; rightMargin: Style.spacing.sm }
                    spacing: Style.spacing.sm
                    // Age first, as in MY PRS: it is the column both lists are
                    // scanned by, and it read as an afterthought on the right.
                    // Four characters wide, not three: a review requested 588
                    // days ago outgrew the old slot and pushed its own row out
                    // of line. A preferred width with no maximum means a
                    // freak five-character age shifts one row instead of
                    // eliding to "109…".
                    PlainText { text: view.desk.ago(inboxRow.row.ts); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(32 * Style.fontScale); horizontalAlignment: Text.AlignRight }
                    // A review owed gets the one-letter tag that keeps the
                    // repository column aligned with MY PRS; a notification
                    // keeps its reason, which is the only thing explaining why
                    // it is in the list at all.
                    Tag { visible: !inboxRow.isNote; text: "R"; tone: inboxRow.tone }
                    Tag { visible: inboxRow.isNote; text: view.githubReasonLabel(inboxRow.row.reason); tone: view.desk.cyan }
                    PlainText { text: view.shortRepo(inboxRow.row.repo); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight; Layout.maximumWidth: Math.round(74 * Style.fontScale) }
                    PlainText { visible: !inboxRow.isNote; text: "#" + Number(inboxRow.row.number || 0); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                    PlainText {
                      Layout.fillWidth: true
                      Layout.minimumWidth: 0
                      text: String(inboxRow.row.title || "")
                      color: view.desk.themeForeground
                      font.family: view.mono; font.pixelSize: Style.font.bodySmall
                      elide: Text.ElideRight; maximumLineCount: 1
                    }
                  }
                  HoverHandler { id: inboxHover; enabled: view.interactive && !inboxRow.isRule; cursorShape: Qt.PointingHandCursor }
                  TapHandler { enabled: view.interactive && !inboxRow.isRule; acceptedButtons: Qt.LeftButton; onTapped: view.openGithub(inboxRow.row.url) }
                }
                PlainText {
                  anchors.centerIn: parent
                  width: parent.width - Style.spacing.md * 2
                  visible: view.githubYouInbox.length === 0
                  text: String(view.githubYou.state || "") === "ok" ? "nothing waiting on you" : ""
                  color: view.textFaint
                  font.family: view.mono; font.pixelSize: Style.font.bodySmall
                  horizontalAlignment: Text.AlignHCenter
                  elide: Text.ElideRight
                }
              }
            }
          }
        }

        // ---- recent prompts / task history ----
        Card {
          Layout.fillWidth: true
          Layout.fillHeight: true
          Layout.minimumHeight: Math.round(150 * Style.fontScale)
          visible: view.sectionEnabled("recent")
          title: "RECENT TASKS · WHAT GOT ASKED"
          hint: view.promptSearch ? (view.visibleRecentTasks.length + " matches") : view.activityFilterActive ? ("filtered · " + view.visibleRecentTasks.length + " shown") : "80 loaded · wheel anywhere · drag scrollbar"
          clip: true
          Rectangle {
            id: promptSearchBox
            width: parent.width
            height: Math.round(28 * Style.fontScale)
            radius: view.radius
            color: Util.alpha(view.desk.themeForeground, promptSearchInput.activeFocus ? 0.10 : 0.045)
            border.color: Util.alpha(promptSearchInput.activeFocus ? view.desk.cyan : view.desk.themeForeground, promptSearchInput.activeFocus ? 0.65 : 0.14)
            border.width: 1
            PlainText { anchors { left: parent.left; leftMargin: Style.spacing.md; verticalCenter: parent.verticalCenter } text: "⌕"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.body }
            TextInput {
              id: promptSearchInput
              anchors { left: parent.left; leftMargin: Style.spacing.xl * 2; right: clearSearch.left; rightMargin: Style.spacing.sm; verticalCenter: parent.verticalCenter }
              text: view.promptSearch
              color: view.desk.themeForeground
              selectionColor: Util.alpha(view.desk.cyan, 0.45)
              font.family: view.mono
              font.pixelSize: Style.font.bodySmall
              clip: true
              enabled: view.keyboardAvailable
              onTextChanged: view.promptSearch = text
              PlainText { visible: !parent.text && !parent.activeFocus; text: view.keyboardAvailable ? "search prompt, project, or provider…" : "search in the overlay · SUPER+D"; color: view.textFaint; font: parent.font }
            }
            PlainText {
              id: clearSearch
              anchors { right: parent.right; rightMargin: Style.spacing.md; verticalCenter: parent.verticalCenter }
              visible: view.promptSearch !== ""
              text: "×"
              color: view.textDim
              font.family: view.mono; font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; anchors.margins: -Style.spacing.sm; cursorShape: Qt.PointingHandCursor; onClicked: { promptSearchInput.text = ""; promptSearchInput.forceActiveFocus() } }
            }
          }
          ScrollList {
            id: recentScroll
            y: promptSearchBox.height + Style.spacing.sm
            width: parent.width
            height: Math.max(0, (parent.height > 0 ? parent.height : 300) - y)
            model: view.visibleRecentTasks
            delegate: Rectangle {
              id: ri
              required property var modelData
              readonly property bool live: modelData.live === true
              readonly property bool navigable: live && !!(modelData.window && modelData.window.address)
              readonly property bool resumable: !live && view.desk.canResume(modelData.provider, modelData.session)
              readonly property bool pinned: view.settings.promptPinned(view.promptKey(modelData))
              readonly property color tone: view.desk.providerColor(modelData.provider)
              width: recentScroll.rowWidth
              height: rrow.implicitHeight + Style.spacing.sm
              radius: view.radius
              color: (live || resumable) ? Util.alpha(tone, recentHover.hovered ? 0.16 : (live ? 0.07 : 0.025)) : "transparent"
              border.color: (live || (resumable && recentHover.hovered)) ? Util.alpha(tone, recentHover.hovered ? 0.65 : 0.22) : "transparent"
              border.width: live || (resumable && recentHover.hovered) ? 1 : 0
              opacity: live ? 1.0 : (resumable ? 0.62 : 0.40)
              RowLayout {
                id: rrow
                anchors {
                  left: parent.left
                  right: parent.right
                  verticalCenter: parent.verticalCenter
                  leftMargin: Style.spacing.sm
                  rightMargin: Style.spacing.sm
                }
                spacing: Style.spacing.md
                PlainText { text: (ri.pinned ? "★" : "") + view.desk.ago(ri.modelData.ts); color: ri.pinned ? ri.tone : view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(28 * Style.fontScale); horizontalAlignment: Text.AlignRight }
                Tag { text: view.desk.providerLabel(ri.modelData.provider); tone: view.desk.providerColor(ri.modelData.provider) }
                PlainText { text: (ri.modelData.project || "").replace(/^.*\//, "") ; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(110 * Style.fontScale); elide: Text.ElideLeft }
                PlainText { Layout.fillWidth: true; text: ri.modelData.text || ""; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight; maximumLineCount: 1 }
                PlainText {
                  visible: recentHover.hovered && (ri.navigable || ri.resumable)
                  text: ri.navigable ? "FOCUS" : "RESUME"
                  color: ri.tone
                  font.family: view.mono
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }
              HoverHandler {
                id: recentHover
                enabled: view.interactive
                cursorShape: (ri.navigable || ri.resumable) ? Qt.PointingHandCursor : Qt.ArrowCursor
              }
              TapHandler {
                enabled: view.interactive
                acceptedButtons: Qt.LeftButton
                onTapped: {
                  if (ri.navigable) view.navigateTo(ri.modelData.window.address)
                  else if (ri.resumable && view.desk.resumeSession(ri.modelData.provider, ri.modelData.session, ri.modelData.project)) view.navigated()
                }
              }
              TapHandler {
                enabled: view.interactive
                acceptedButtons: Qt.RightButton
                onTapped: view.selectedPrompt = ri.modelData
              }
            }
          }
          PlainText {
            anchors.centerIn: parent
            visible: view.activityFilterActive && view.visibleRecentTasks.length === 0
            text: "no prompts in this filter"
            color: view.textFaint
            font.family: view.mono
            font.pixelSize: Style.font.bodySmall
          }
        }
      }

      // RIGHT COLUMN: usage + local AI + machine corner
      GridLayout {
        id: rightColumn
        visible: view.sectionEnabled("usage") || view.sectionEnabled("localAi") || view.sectionEnabled("machine")
        Layout.fillHeight: true
        // A fixed column: content-driven widths let the column drift narrower
        // whenever card text became shrinkable, and rows then overran the border.
        Layout.preferredWidth: view.rightColumnWidth
        Layout.maximumWidth: view.rightColumnWidth
        Layout.minimumWidth: view.rightColumnWidth
        columns: 1
        rowSpacing: view.gap
        columnSpacing: 0

        // ---- subscription usage (from omarchy.agents cache when present) ----
        Card {
          Layout.row: view.settings.rightIndex("usage")
          Layout.column: 0
          Layout.fillWidth: true
          visible: view.sectionEnabled("usage")
          moveId: "usage"
          draggable: true
          title: "USAGE & LIMITS"
          hint: {
            var keys = Object.keys(view.usage); return keys.length ? "via omarchy agents" : "enable the Agents bar widget"
          }
          ColumnLayout {
            width: parent.width
            spacing: Style.spacing.md
            Flow {
              Layout.fillWidth: true
              spacing: Style.spacing.xs
              Repeater {
                model: Object.keys(view.usage).filter(function(k) { return view.usage[k] && view.usage[k].ready !== false })
                delegate: Tag {
                  required property string modelData
                  text: view.desk.providerLabel(modelData)
                  tone: view.desk.providerColor(modelData)
                  opacity: !view.usageProviderFilter || view.usageProviderFilter === modelData ? 1 : 0.35
                  MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.usageProviderFilter = view.usageProviderFilter === parent.modelData ? "" : parent.modelData }
                }
              }
              Tag { text: view.usageMetric === "value" ? "≈ $ VALUE" : "TOKENS"; tone: view.usageMetric === "value" ? view.desk.green : view.desk.cyan; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.usageMetric = view.usageMetric === "value" ? "tokens" : "value" } }
              Tag { text: view.usageForecastMode ? "FORECAST" : "PERCENT"; tone: view.desk.cyan; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.usageForecastMode = !view.usageForecastMode } }
            }
            // ---- 7-day trend: one line per provider, tokens or estimated value ----
            Item {
              id: usageTrend
              Layout.fillWidth: true
              visible: view.usageSeries.length > 0
              implicitHeight: trendCanvas.height + trendReadout.implicitHeight + Style.spacing.xs
              property int hovered: -1
              readonly property var days: view.ai.usageDays || []
              readonly property int labelWidth: Math.round(38 * Style.fontScale)
              function fmt(n) { return view.usageMetric === "value" ? view.usageMoney(n) : view.desk.tokens(n) }
              function dayLabel(index) {
                var key = String(days[index] || ""); if (!key) return ""
                var parts = key.split("-"); return parts.length === 3 ? parts[1] + "-" + parts[2] : key
              }
              Canvas {
                id: trendCanvas
                width: parent.width
                height: Math.round(62 * Style.fontScale)
                readonly property var series: view.usageSeries
                onSeriesChanged: requestPaint()
                onWidthChanged: requestPaint()
                Connections { target: usageTrend; function onHoveredChanged() { trendCanvas.requestPaint() } }
                Connections { target: view.desk; function onThemeForegroundChanged() { trendCanvas.requestPaint() } function onGreenChanged() { trendCanvas.requestPaint() } }
                onPaint: {
                  var ctx = getContext("2d"); ctx.reset()
                  // top padding keeps the topmost gridline label inside the canvas
                  var left = usageTrend.labelWidth, top = Math.round(7 * Style.fontScale), bottom = height - 4, plot = width - left - 2
                  var list = series, n = list.length ? list[0].points.length : 0
                  if (!n) return
                  var max = 1
                  for (var s = 0; s < list.length; s++) for (var i = 0; i < n; i++) max = Math.max(max, Number(list[s].points[i]) || 0)
                  ctx.font = Style.font.caption + "px \"" + view.mono + "\""
                  ctx.textBaseline = "middle"
                  ctx.lineWidth = 1
                  var grid = Qt.rgba(view.textFaint.r, view.textFaint.g, view.textFaint.b, 0.35)
                  for (var t = 0; t < 3; t++) {
                    var y = top + (bottom - top) * t / 2
                    ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width, y); ctx.stroke()
                    ctx.fillStyle = Qt.rgba(view.textFaint.r, view.textFaint.g, view.textFaint.b, 1)
                    ctx.textAlign = "left"; ctx.fillText(usageTrend.fmt(max * (1 - t / 2)), 0, y)
                  }
                  for (var k = 0; k < list.length; k++) {
                    var tone = view.desk.providerColor(list[k].provider)
                    ctx.beginPath()
                    for (var p = 0; p < n; p++) {
                      var x = left + (n === 1 ? plot / 2 : p * plot / (n - 1))
                      var yy = bottom - (Number(list[k].points[p]) || 0) / max * (bottom - top)
                      if (p === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy)
                    }
                    ctx.strokeStyle = tone; ctx.lineWidth = 2; ctx.stroke()
                    if (list.length <= 3 && n > 1) { ctx.lineTo(left + plot, bottom); ctx.lineTo(left, bottom); ctx.closePath(); ctx.fillStyle = Qt.rgba(tone.r, tone.g, tone.b, 0.08); ctx.fill() }
                  }
                  if (usageTrend.hovered >= 0 && usageTrend.hovered < n) {
                    var hx = left + (n === 1 ? plot / 2 : usageTrend.hovered * plot / (n - 1))
                    ctx.strokeStyle = Qt.rgba(view.desk.themeForeground.r, view.desk.themeForeground.g, view.desk.themeForeground.b, 0.35)
                    ctx.beginPath(); ctx.moveTo(hx, top); ctx.lineTo(hx, bottom); ctx.stroke()
                    for (var q = 0; q < list.length; q++) {
                      var py = bottom - (Number(list[q].points[usageTrend.hovered]) || 0) / max * (bottom - top)
                      ctx.beginPath(); ctx.arc(hx, py, 3, 0, 2 * Math.PI); ctx.fillStyle = view.desk.providerColor(list[q].provider); ctx.fill()
                    }
                  }
                }
                MouseArea {
                  anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
                  onPositionChanged: function(mouse) {
                    var n = trendCanvas.series.length ? trendCanvas.series[0].points.length : 0
                    if (n < 2) { usageTrend.hovered = n ? 0 : -1; return }
                    var plot = trendCanvas.width - usageTrend.labelWidth - 2
                    usageTrend.hovered = Math.max(0, Math.min(n - 1, Math.round((mouse.x - usageTrend.labelWidth) / plot * (n - 1))))
                  }
                  onExited: usageTrend.hovered = -1
                }
              }
              PlainText {
                id: trendReadout
                anchors { top: trendCanvas.bottom; topMargin: Style.spacing.xs; left: parent.left; right: parent.right }
                elide: Text.ElideRight
                font.family: view.mono; font.pixelSize: Style.font.caption
                color: usageTrend.hovered >= 0 ? view.desk.themeForeground : view.textFaint
                text: {
                  var list = view.usageSeries, n = list.length ? list[0].points.length : 0
                  if (!n) return ""
                  if (usageTrend.hovered < 0) {
                    var parts = []
                    for (var i = 0; i < list.length; i++) {
                      var sum = 0; for (var d = 0; d < n; d++) sum += Number(list[i].points[d]) || 0
                      parts.push(view.desk.providerLabel(list[i].provider) + " " + usageTrend.fmt(sum))
                    }
                    return usageTrend.dayLabel(0) + " → " + usageTrend.dayLabel(n - 1) + " · 7d " + parts.join(" · ") + (view.usageMetric === "value" ? " est." : "")
                  }
                  var at = []
                  for (var j = 0; j < list.length; j++) at.push(view.desk.providerLabel(list[j].provider) + " " + usageTrend.fmt(list[j].points[usageTrend.hovered]))
                  return usageTrend.dayLabel(usageTrend.hovered) + " · " + at.join(" · ")
                }
              }
            }
            Repeater {
              model: Object.keys(view.usage).filter(function(k) { return view.usage[k] && view.usage[k].ready !== false && (!view.usageProviderFilter || view.usageProviderFilter === k) })
              delegate: ColumnLayout {
                id: up
                required property string modelData
                readonly property var u: view.usage[modelData] || ({})
                readonly property color tone: view.desk.providerColor(modelData)
                Layout.fillWidth: true
                spacing: Style.spacing.xs
                RowLayout {
                  Layout.fillWidth: true
                  PlainText { text: up.u.name || up.modelData; color: up.tone; font.family: view.mono; font.bold: true; font.pixelSize: Style.font.body }
                  PlainText { text: up.u.tierLabel || ""; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                  Item { Layout.fillWidth: true }
                  PlainText { text: "today " + (up.u.todayPrompts || 0) + "p · " + view.desk.tokens(up.u.todayTotalTokens) + " tok" + (up.u.value && up.u.value.today !== null && up.u.value.today !== undefined ? " · ≈" + view.usageMoney(up.u.value.today) : ""); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption }
                }
                PlainText {
                  Layout.fillWidth: true
                  // A provider with no lifetime tokens has nothing to say here.
                  visible: !!(up.u.value && up.u.value.totals) && (Number((up.u.value.totals || {}).inputTokens || 0) + Number((up.u.value.totals || {}).outputTokens || 0) + Number((up.u.value.totals || {}).cacheReadInputTokens || 0) + Number((up.u.value.totals || {}).cacheCreationInputTokens || 0)) > 0
                  elide: Text.ElideRight
                  text: {
                    var v = up.u.value || {}, t = v.totals || {}
                    var all = Number(t.inputTokens || 0) + Number(t.outputTokens || 0) + Number(t.cacheReadInputTokens || 0) + Number(t.cacheCreationInputTokens || 0)
                    var parts = ["lifetime " + view.desk.tokens(all) + " tok"]
                    if (all > 0) parts.push(Math.round(100 * Number(t.cacheReadInputTokens || 0) / all) + "% cache reads")
                    if (v.lifetime !== null && v.lifetime !== undefined) parts.push("≈" + view.usageMoney(v.lifetime) + (v.pricedShare < 0.999 ? " (" + Math.round(v.pricedShare * 100) + "% priced)" : "") + " est.")
                    else if (all > 0) parts.push("unpriced")
                    if (up.u.totalSessions) parts.push(up.u.totalSessions + " sessions")
                    return parts.join(" · ")
                  }
                  color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption
                }
                Repeater {
                  model: up.u.limits || []
                  delegate: Meter {
                    required property var modelData
                    readonly property var projection: view.usageProjection(modelData)
                    Layout.fillWidth: true
                    label: modelData.label || modelData.title || ""
                    value: (view.usageForecastMode ? (projection === null ? "learning" : "→ " + Math.round(projection * 100) + "% at reset") : Math.round((modelData.percent || 0) * 100) + "%") + (modelData.resetsAt ? "  ↻ " + view.desk.until(Date.parse(modelData.resetsAt)) : "")
                    fraction: modelData.percent || 0
                    tone: (modelData.percent || 0) > 0.85 ? view.desk.red : (modelData.percent || 0) > 0.6 ? view.desk.yellow : up.tone
                  }
                }
              }
            }
            PlainText { visible: Object.keys(view.usage).length === 0; text: "no usage cache yet"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
          }
        }

        // ---- local AI ----
        Card {
          id: localAiCard
          Layout.row: view.settings.rightIndex("localAi")
          Layout.column: 0
          Layout.fillWidth: true
          visible: view.sectionEnabled("localAi")
          moveId: "localAi"
          draggable: true
          title: "LOCAL AI"
          readonly property var ol: (view.ai.providers || {}).ollama || ({})
          readonly property var availableModels: ol && Array.isArray(ol.models) ? ol.models : []
          readonly property var selectedModel: modelObject(view.settings.selectedOllamaModel)
          property string pendingLargeModel: ""
          property string loadNotice: ""
          // One width for every action tag (LOAD / LOADED / CONFIRM / WORKING / UNLOAD)
          // so the column lines up; arrows are a compact fixed pair beside it.
          readonly property int actionWidth: Math.round(66 * Style.fontScale)
          readonly property int arrowWidth: Math.round(20 * Style.fontScale)
          // Meta text keeps its natural width up to this cap; the fixed arrow and
          // action slots after it are what line the rows up.
          readonly property int metaWidth: Math.round(130 * Style.fontScale)

          function modelName(item) { return String((item && typeof item === "object") ? (item.name || "") : (item || "")) }
          function modelList() { return Array.isArray(availableModels) ? availableModels : [] }
          function modelObject(name) {
            var wanted = String(name || ""), models = modelList()
            for (var i = 0; i < models.length; i++) {
              var item = models[i], itemName = modelName(item)
              if (itemName === wanted) return (item && typeof item === "object") ? item : ({ name: itemName, size: 0 })
            }
            if (models.length) {
              var first = models[0]
              return (first && typeof first === "object") ? first : ({ name: modelName(first), size: 0 })
            }
            return ({ name: "", size: 0 })
          }
          function modelIndex(name) {
            var models = modelList()
            for (var i = 0; i < models.length; i++) if (modelName(models[i]) === String(name || "")) return i
            return -1
          }
          function ensureSelection() {
            var models = modelList()
            if (models.length && modelIndex(view.settings.selectedOllamaModel) < 0)
              view.settings.setSelectedOllamaModel(modelName(models[0]))
          }
          function stepModel(delta) {
            var models = modelList()
            if (!models.length) return
            var index = modelIndex(view.settings.selectedOllamaModel)
            if (index < 0) index = 0
            index = (index + Number(delta) + models.length) % models.length
            view.settings.setSelectedOllamaModel(modelName(models[index]))
            pendingLargeModel = ""
            loadNotice = ""
          }
          function modelLoaded(name) {
            var loaded = ol.loaded || []
            for (var i = 0; i < loaded.length; i++) if (String(loaded[i].name || "") === String(name || "")) return true
            return false
          }
          function needsConfirmation(model) {
            var size = Number((model || {}).size || 0)
            if (!size) return false
            var gpu = view.machine.gpu || null
            var gpuPresent = !!(gpu && Number(gpu.memTotal || 0) > 0)
            var gpuFree = gpuPresent ? Math.max(0, Number(gpu.memTotal || 0) - Number(gpu.memUsed || 0)) : 0
            var mem = view.machine.mem || {}, ramFree = Math.max(0, Number(mem.total || 0) - Number(mem.used || 0))
            // A full GPU is still a GPU: confirm when the model will not fit in what is free.
            if (size >= 8 * 1024 * 1024 * 1024) return true
            if (gpuPresent) return size > gpuFree
            return ramFree > 0 && size > ramFree * 0.65
          }
          function requestLoad() {
            var name = String(selectedModel.name || "")
            if (!name || view.desk.ollamaBusy || modelLoaded(name)) return
            if (needsConfirmation(selectedModel) && pendingLargeModel !== name) {
              pendingLargeModel = name
              loadNotice = "large model · press confirm to pin in memory"
              return
            }
            pendingLargeModel = ""
            loadNotice = ""
            view.desk.controlOllama("load", name)
          }
          function requestUnload(name) {
            if (view.desk.ollamaBusy) return
            pendingLargeModel = ""
            loadNotice = ""
            view.desk.controlOllama("unload", name)
          }
          onOlChanged: ensureSelection()
          Component.onCompleted: ensureSelection()
          hint: ol.up ? "ollama up · " + (ol.modelCount || 0) + " models" : "ollama down"
          ColumnLayout {
            id: localAiColumn
            // Anchors, not a width binding: the rows must be handed exactly the
            // card's inner width so their fill items shrink instead of overflowing.
            anchors { left: parent.left; right: parent.right }
            spacing: Style.spacing.sm
            Repeater {
              model: ((view.ai.providers || {}).ollama || {}).loaded || []
              delegate: RowLayout {
                id: loadedModelRow
                required property var modelData
                Layout.fillWidth: true
                spacing: Style.spacing.sm
                Rectangle { width: 8; height: 8; radius: 4; color: view.desk.green }
                PlainText { text: modelData.name; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; Layout.fillWidth: true; Layout.minimumWidth: 0; elide: Text.ElideRight }
                PlainText { text: "vram " + view.desk.bytes(modelData.vram); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideLeft; horizontalAlignment: Text.AlignRight; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.maximumWidth: localAiCard.metaWidth }
                // Reserve the selector's arrow slot so every action tag is one column.
                Item { Layout.preferredWidth: localAiCard.arrowWidth * 2 + Style.spacing.xs; Layout.preferredHeight: 1 }
                Tag {
                  Layout.preferredWidth: localAiCard.actionWidth
                  text: view.desk.ollamaBusy && view.desk.ollamaModel === loadedModelRow.modelData.name ? "WORKING" : "UNLOAD"
                  tone: view.desk.ollamaBusy ? view.textFaint : view.desk.red
                  MouseArea { anchors.fill: parent; enabled: view.interactive && !view.desk.ollamaBusy; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: localAiCard.requestUnload(loadedModelRow.modelData.name) }
                }
              }
            }
            PlainText { visible: !((((view.ai.providers || {}).ollama || {}).loaded || []).length); text: "no model loaded"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
            // Same columns as a loaded row: indicator · name · meta · action. The
            // selector arrows sit beside LOAD so every action shares one right edge.
            RowLayout {
              id: selectorRow
              visible: !!localAiCard.ol.up && (localAiCard.availableModels || []).length > 0
              Layout.fillWidth: true
              spacing: Style.spacing.sm
              Rectangle { width: 8; height: 8; radius: 4; color: "transparent"; border.width: 1; border.color: view.textFaint }
              PlainText { text: localAiCard.selectedModel.name || "no installed model"; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; font.bold: true; Layout.fillWidth: true; Layout.minimumWidth: 0; elide: Text.ElideRight }
              PlainText {
                text: [localAiCard.selectedModel.parameterSize || "", localAiCard.selectedModel.quantization || "", localAiCard.selectedModel.size ? view.desk.bytes(localAiCard.selectedModel.size) : ""].filter(Boolean).join(" · ")
                color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideLeft
                horizontalAlignment: Text.AlignRight
                Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.maximumWidth: localAiCard.metaWidth
              }
              RowLayout {
                spacing: Style.spacing.xs
                Tag { Layout.preferredWidth: localAiCard.arrowWidth; text: "‹"; tone: view.textDim; MouseArea { anchors.fill: parent; enabled: view.interactive && !view.desk.ollamaBusy && localAiCard.availableModels.length > 1; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: localAiCard.stepModel(-1) } }
                Tag { Layout.preferredWidth: localAiCard.arrowWidth; text: "›"; tone: view.textDim; MouseArea { anchors.fill: parent; enabled: view.interactive && !view.desk.ollamaBusy && localAiCard.availableModels.length > 1; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: localAiCard.stepModel(1) } }
              }
              Tag {
                id: loadTag
                Layout.preferredWidth: localAiCard.actionWidth
                text: localAiCard.modelLoaded(localAiCard.selectedModel.name) ? "LOADED" : localAiCard.pendingLargeModel === localAiCard.selectedModel.name ? "CONFIRM" : view.desk.ollamaBusy ? "WORKING" : "LOAD"
                tone: localAiCard.modelLoaded(localAiCard.selectedModel.name) ? view.desk.green : localAiCard.pendingLargeModel === localAiCard.selectedModel.name ? view.desk.yellow : view.desk.cyan
                MouseArea { anchors.fill: parent; enabled: view.interactive && !view.desk.ollamaBusy && !localAiCard.modelLoaded(localAiCard.selectedModel.name); cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: localAiCard.requestLoad() }
              }
            }
            PlainText { Layout.fillWidth: true; visible: !!localAiCard.loadNotice; text: localAiCard.loadNotice; color: view.desk.yellow; font.family: view.mono; font.pixelSize: Style.font.caption; wrapMode: Text.Wrap }
            PlainText { Layout.fillWidth: true; visible: !!view.desk.ollamaStatus; text: view.desk.ollamaStatus; color: view.desk.green; font.family: view.mono; font.pixelSize: Style.font.caption; wrapMode: Text.Wrap }
            PlainText { Layout.fillWidth: true; visible: !!view.desk.ollamaError; text: view.desk.ollamaError; color: view.desk.red; font.family: view.mono; font.pixelSize: Style.font.caption; wrapMode: Text.Wrap }
            Meter {
              id: gpuMeter
              visible: !!view.machine.gpu
              Layout.fillWidth: true
              label: view.machine.gpu ? "GPU " + String(view.machine.gpu.name).replace(/NVIDIA |GeForce |Laptop GPU/g, "") : "GPU"
              value: view.machine.gpu ? view.machine.gpu.util + "% · " + view.desk.bytes(view.machine.gpu.memUsed) + "/" + view.desk.bytes(view.machine.gpu.memTotal) + " · " + view.machine.gpu.temp + "°" : ""
              fraction: view.machine.gpu ? view.machine.gpu.memUsed / Math.max(1, view.machine.gpu.memTotal) : 0
              tone: view.desk.green
            }
            // A Flow, never a RowLayout: four rigid chips in a RowLayout handed the
            // whole column a 514 px minimum inside a 512 px body, so every row laid
            // out 2 px past the clip and lost its right border (the "clipped LOAD").
            // A Flow has no minimum width; if the labels ever grow it wraps instead.
            Flow {
              id: provRow
              Layout.fillWidth: true
              spacing: Style.spacing.sm
              readonly property var ps: view.ai.providers || ({})
              Tag { visible: !!(provRow.ps.claude && provRow.ps.claude.present); text: "claude " + (provRow.ps.claude ? provRow.ps.claude.prompts : 0) + "p"; tone: view.desk.providerColor("claude") }
              Tag { visible: !!(provRow.ps.codex && provRow.ps.codex.present); text: "codex " + (provRow.ps.codex ? provRow.ps.codex.threadCount : 0) + " threads"; tone: view.desk.providerColor("codex") }
              Tag { visible: !!(provRow.ps.grok && provRow.ps.grok.present); text: "grok " + (provRow.ps.grok ? provRow.ps.grok.sessions : 0) + " sess"; tone: view.desk.providerColor("grok") }
              Tag { visible: !!(provRow.ps.grokBot && provRow.ps.grokBot.present); text: "grok bot " + (provRow.ps.grokBot ? provRow.ps.grokBot.sessions : 0) + " bots" + (provRow.ps.grokBot && provRow.ps.grokBot.unread ? " · " + provRow.ps.grokBot.unread + " unread" : ""); tone: view.desk.providerColor("grok-bot") }
              Tag { visible: !!(provRow.ps.opencode && provRow.ps.opencode.present); text: "opencode " + (provRow.ps.opencode ? provRow.ps.opencode.sessions : 0) + " sess"; tone: view.desk.providerColor("opencode") }
            }
          }
        }

        // ---- machine corner (the boring stats) ----
        Card {
          Layout.row: view.settings.rightIndex("machine")
          Layout.column: 0
          Layout.fillWidth: true
          visible: view.sectionEnabled("machine")
          moveId: "machine"
          draggable: true
          title: "MACHINE"
          hint: ((view.snap.user ? view.snap.user + "@" : "") + (view.snap.host || "")) + " · up " + view.desk.dur(view.machine.uptime)
          readonly property var net: view.machine.net || ({})
          readonly property var mem: view.machine.mem || ({})
          readonly property var cpu: view.machine.cpu || ({})
          readonly property var ping: view.machine.ping || ({})
          readonly property var disks: view.machine.disks || []
          readonly property var bat: view.machine.battery
          id: mc
          // Cockpit density: two meters per row, one footer line for the scalars.
          // Seven single-line rows used to push BAT off the bottom of a 1080p desk.
          GridLayout {
            width: parent.width
            columns: 2
            columnSpacing: Style.spacing.lg
            rowSpacing: Style.spacing.sm
            Meter { Layout.fillWidth: true; Layout.preferredWidth: 1; label: "CPU"; value: view.desk.pct(mc.cpu.pct) + " · " + ((mc.cpu.load || [0])[0] || 0).toFixed(2) + (view.machine.temp ? " · " + Math.round(view.machine.temp) + "°" : ""); fraction: (mc.cpu.pct || 0) / 100; tone: (mc.cpu.pct || 0) > 85 ? view.desk.red : view.desk.blue }
            Meter { Layout.fillWidth: true; Layout.preferredWidth: 1; label: "RAM"; value: view.desk.bytes(mc.mem.used) + "/" + view.desk.bytes(mc.mem.total) + " · " + view.desk.pct(mc.mem.pct); fraction: (mc.mem.pct || 0) / 100; tone: (mc.mem.pct || 0) > 90 ? view.desk.red : view.desk.green }
            Repeater {
              model: mc.disks.slice(0, 2)
              delegate: Meter { required property var modelData; Layout.fillWidth: true; Layout.preferredWidth: 1; label: "DISK " + modelData.mount; value: view.desk.bytes(modelData.used) + "/" + view.desk.bytes(modelData.size) + " · " + view.desk.pct(modelData.pct); fraction: (modelData.pct || 0) / 100; tone: (modelData.pct || 0) > 90 ? view.desk.red : view.desk.yellow }
            }
            Meter {
              Layout.fillWidth: true; Layout.preferredWidth: 1
              label: mc.net.wireless ? "WIFI " + (mc.net.ssid || "") : "NET " + (mc.net.dev || "—")
              value: mc.net.signal !== null && mc.net.signal !== undefined ? mc.net.signal + " dBm" : (mc.net.dev ? "up" : "—")
              // -30 dBm great … -90 dBm dead
              fraction: mc.net.signal !== null && mc.net.signal !== undefined ? Math.max(0, Math.min(1, (Number(mc.net.signal) + 90) / 60)) : (mc.net.dev ? 1 : 0)
              tone: mc.net.signal !== null && mc.net.signal !== undefined && Number(mc.net.signal) < -75 ? view.desk.yellow : view.desk.green
            }
            // Scalars on two footer lines: addresses, then rates · ping · battery.
            RowLayout {
              Layout.columnSpan: 2
              Layout.fillWidth: true
              spacing: Style.spacing.md
              PlainText { text: "WAN " + (view.machine.externalIp || "—"); color: view.machine.externalIp ? view.desk.cyan : view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideMiddle }
              PlainText { visible: !!mc.net.addr; text: "LAN " + (mc.net.addr || ""); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideMiddle }
              Item { Layout.fillWidth: true }
            }
            RowLayout {
              Layout.columnSpan: 2
              Layout.fillWidth: true
              spacing: Style.spacing.md
              PlainText { text: "↓" + view.desk.rate(mc.net.rxRate) + " ↑" + view.desk.rate(mc.net.txRate); color: view.desk.green; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
              PlainText { text: "⇄ " + (mc.ping.ok ? mc.ping.ms.toFixed(0) + " ms" : "timeout"); color: !mc.ping.ok ? view.desk.red : mc.ping.ms > 80 ? view.desk.yellow : view.desk.green; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
              Item { Layout.fillWidth: true }
              PlainText { visible: !!mc.bat; text: mc.bat ? "BAT " + mc.bat.pct + "% " + String(mc.bat.status || "").toLowerCase() : ""; color: mc.bat && mc.bat.pct < 20 && mc.bat.status !== "Charging" ? view.desk.red : view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption }
            }
          }
        }
        // Legend — readable, one line, under the last card. Wording follows the surface.
        PlainText {
          Layout.row: 98; Layout.column: 0
          Layout.fillWidth: true
          elide: Text.ElideRight
          text: (view.keyboardAvailable ? "SUPER+I hide desk  ·  SUPER+D / ESC close" : "SUPER+I hide desk  ·  SUPER+D show desktop") + "  ·  right-click a card to inspect"
          color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption
        }
        Item { Layout.row: 99; Layout.column: 0; Layout.fillHeight: true }
        }
      }
    }
  }

  Rectangle {
    id: sessionInspector
    z: 100
    anchors.centerIn: parent
    visible: !!view.liveInspectedSession && view.sectionEnabled("sessions")
    width: Math.min(parent.width - view.gap * 4, Math.round(620 * Style.fontScale))
    implicitHeight: inspectorColumn.implicitHeight + view.pad * 2
    radius: view.radius
    color: Util.alpha(view.desk.themeBackground, 0.97)
    border.color: Util.alpha(view.liveInspectedSession ? view.desk.providerColor(view.liveInspectedSession.provider) : view.desk.themeForeground, 0.8)
    border.width: 1
    readonly property var session: view.liveInspectedSession || ({})
    readonly property color tone: view.desk.providerColor(session.provider)

    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(mouse) { mouse.accepted = true } }
    ColumnLayout {
      id: inspectorColumn
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      RowLayout {
        Layout.fillWidth: true
        Rectangle { width: 9; height: 9; radius: 5; color: sessionInspector.tone }
        PlainText { text: view.desk.providerLabel(sessionInspector.session.provider) + " SESSION"; color: sessionInspector.tone; font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true }
        Item { Layout.fillWidth: true }
        PlainText { text: view.desk.dur(sessionInspector.session.uptimeSec) + " · pid " + (sessionInspector.session.pid || "—"); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption }
        Tag {
          text: "CLOSE"
          tone: view.textDim
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.inspectedSession = null }
        }
      }
      PlainText { Layout.fillWidth: true; text: sessionInspector.session.cwd || "unknown project"; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.subtitle; elide: Text.ElideMiddle }
      PlainText { Layout.fillWidth: true; text: (sessionInspector.session.window || {}).title || "no window title"; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight }
      PlainText { Layout.fillWidth: true; visible: (sessionInspector.session.hosts || []).length > 0; text: view.sessionHostDetail(sessionInspector.session); color: sessionInspector.tone; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight }
      PlainText { Layout.fillWidth: true; text: "CPU " + (sessionInspector.session.resources && sessionInspector.session.resources.cpuPct !== null ? sessionInspector.session.resources.cpuPct.toFixed(1) + "%" : "—") + "   ·   RAM " + ((sessionInspector.session.resources || {}).rss !== null ? view.desk.bytes((sessionInspector.session.resources || {}).rss) : "—") + "   ·   " + ((sessionInspector.session.resources || {}).processes !== null ? ((sessionInspector.session.resources || {}).processes || 0) : "—") + " PROCESSES" + ((sessionInspector.session.resources || {}).gpuMemory ? "   ·   GPU " + view.desk.bytes(sessionInspector.session.resources.gpuMemory) : ""); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
      PlainText {
        Layout.fillWidth: true
        text: {
          var s = sessionInspector.session, w = s.window || {}, g = s.git || null
          var parts = ["workspace " + (w.workspace === null || w.workspace === undefined ? "—" : w.workspace)]
          if (s.name) parts.push(String(s.name))
        if (s.session) parts.push("session " + String(s.session).slice(0, 13) + "…")
          if (g) parts.push("git " + g.branch + (g.dirty ? " · " + g.dirty + " changed" : " · clean") + (g.conflicts ? " · " + g.conflicts + " conflicts" : ""))
          return parts.join("   ·   ")
        }
        color: sessionInspector.session.git && sessionInspector.session.git.conflicts ? view.desk.red : view.textDim
        font.family: view.mono; font.pixelSize: Style.font.bodySmall; wrapMode: Text.Wrap
      }
      ColumnLayout {
        Layout.fillWidth: true
        visible: !!(sessionInspector.session.window && sessionInspector.session.window.address)
        spacing: Style.spacing.xs
        PlainText { text: "MOVE TO WORKSPACE"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
        Flow {
          Layout.fillWidth: true
          spacing: Style.spacing.xs
          Repeater {
            model: 10
            delegate: Tag {
              required property int modelData
              readonly property int workspaceNumber: modelData + 1
              text: String(workspaceNumber)
              tone: Number((sessionInspector.session.window || {}).workspace) === workspaceNumber ? sessionInspector.tone : view.textDim
              opacity: Number((sessionInspector.session.window || {}).workspace) === workspaceNumber ? 1 : 0.72
              MouseArea {
                anchors.fill: parent
                enabled: view.interactive && Number((sessionInspector.session.window || {}).workspace) !== parent.workspaceNumber
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: {
                  if (view.desk.moveWindowToWorkspace(sessionInspector.session.window.address, parent.workspaceNumber)) view.inspectedSession = null
                }
              }
            }
          }
        }
      }
      RowLayout {
        Layout.fillWidth: true
        spacing: Style.spacing.md
        Tag {
          visible: !!(sessionInspector.session.window && sessionInspector.session.window.address)
          text: "FOCUS WINDOW"
          tone: sessionInspector.tone
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { view.desk.focusSession(sessionInspector.session); view.navigated() } }
        }
        Tag {
          visible: view.desk.canOpenProject(sessionInspector.session.cwd)
          text: "OPEN PROJECT TERMINAL"
          tone: view.desk.green
          MouseArea {
            anchors.fill: parent; cursorShape: Qt.PointingHandCursor
            onClicked: if (view.desk.openProject(sessionInspector.session.cwd)) view.inspectedSession = null
          }
        }
        Tag {
          text: view.previewsEnabled ? "PREVIEWS ON" : "PREVIEWS OFF"
          tone: view.previewsEnabled ? view.desk.green : view.textFaint
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.previewsEnabled = !view.previewsEnabled }
        }
        // Cleanup, two clicks, only for sessions nobody is attached to.
        Tag {
          id: stopTag
          property bool armed: false
          visible: view.desk.canStopSession(sessionInspector.session)
          text: armed ? "CONFIRM STOP" : "STOP SESSION"
          tone: armed ? view.desk.red : view.desk.yellow
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { if (stopTag.armed) { view.desk.stopSession(sessionInspector.session); view.inspectedSession = null } else stopTag.armed = true } }
          Timer { interval: 4000; running: stopTag.armed; onTriggered: stopTag.armed = false }
        }
        Tag {
          id: endTag
          property bool armed: false
          visible: !view.desk.canStopSession(sessionInspector.session) && sessionInspector.session.stale === true && view.desk.canEndProcess(sessionInspector.session)
          text: armed ? "CONFIRM END (SIGTERM)" : "END PROCESS"
          tone: armed ? view.desk.red : view.desk.yellow
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { if (endTag.armed) { view.desk.endProcess(sessionInspector.session); view.inspectedSession = null } else endTag.armed = true } }
          Timer { interval: 4000; running: endTag.armed; onTriggered: endTag.armed = false }
        }
        Item { Layout.fillWidth: true }
        PlainText { text: "right-click another card to inspect"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
      }
    }
  }

  Rectangle {
    id: promptDrawer
    z: 110
    anchors.centerIn: parent
    visible: !!view.selectedPrompt && view.sectionEnabled("recent")
    width: Math.min(parent.width - view.gap * 4, Math.round(720 * Style.fontScale))
    implicitHeight: promptColumn.implicitHeight + view.pad * 2
    radius: view.radius
    color: Util.alpha(view.desk.themeBackground, 0.97)
    border.color: Util.alpha(view.selectedPrompt ? view.desk.providerColor(view.selectedPrompt.provider) : view.textDim, 0.8)
    readonly property var prompt: view.selectedPrompt || ({})
    readonly property var group: (view.ai.recent || []).filter(function(item) { return item.provider === promptDrawer.prompt.provider && item.session && item.session === promptDrawer.prompt.session }).slice(0, 5)
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(mouse) { mouse.accepted = true } }
    ColumnLayout {
      id: promptColumn
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      RowLayout {
        Layout.fillWidth: true
        PlainText { text: view.desk.providerLabel(promptDrawer.prompt.provider) + " PROMPT ACTIONS"; color: view.desk.providerColor(promptDrawer.prompt.provider); font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true }
        Item { Layout.fillWidth: true }
        Tag { text: "CLOSE"; tone: view.textDim; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.selectedPrompt = null } }
      }
      PlainText { Layout.fillWidth: true; text: promptDrawer.prompt.text || ""; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.body; wrapMode: Text.Wrap }
      RowLayout {
        spacing: Style.spacing.sm
        Tag { text: "COPY EXCERPT"; tone: view.desk.cyan; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.copyText(promptDrawer.prompt.text) } }
        Tag { text: view.settings.promptPinned(view.promptKey(promptDrawer.prompt)) ? "UNPIN" : "PIN"; tone: view.desk.yellow; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.togglePromptPin(view.promptKey(promptDrawer.prompt)) } }
        Tag { visible: view.desk.canOpenProject(promptDrawer.prompt.project); text: "OPEN PROJECT"; tone: view.desk.green; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.openProject(promptDrawer.prompt.project) } }
        Item { Layout.fillWidth: true }
      }
      PlainText { visible: promptDrawer.group.length > 1; text: "SAME SESSION · " + promptDrawer.group.length + " RECENT PROMPTS"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
      Repeater {
        model: promptDrawer.group
        delegate: PlainText { required property var modelData; Layout.fillWidth: true; text: "• " + modelData.text; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight }
      }
    }
  }
}
