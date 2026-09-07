import { describe, expect, test } from "bun:test";
import { GITHUB_BACKFILL_MS, GITHUB_REFRESH_MS, GITHUB_STALE_AFTER_MS } from "./github-activity.ts";
import {
  INBOX_COMMAND_TIMEOUT_MS, INBOX_GRAPHQL_QUERY, INBOX_MAX_ITEMS, INBOX_STORE_MAX_BYTES,
  emptyInboxStore, inboxCounts, inboxRefreshDue, inboxRefreshInterval, inboxSnapshot,
  normalizeInboxStore, notificationReasonLabel, notificationWebUrl, parseInboxGraphql,
  parseInboxNotifications, parseInboxStoreText, refreshInbox, splitTicket, validGithubUrl,
} from "./github-inbox.ts";

const now = new Date(2026, 8, 5, 21, 0, 0, 0).getTime();
const minute = 60_000, hour = 3600_000;
const iso = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");

// The shapes below are the real payloads, verified against Danilo's gh on
// 2026-09-06: a draft PR with a passing rollup, a PR with no rollup at all,
// a failing one, a review request from another author, and the CheckSuite
// notification whose subject.url is null.
function graphqlJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    login: "octocat",
    prsTotal: 3,
    prs: [
      { number: 4653, title: "[INFLTECH-14351] Um caminho único para atribuir motorista", isDraft: true, ts: iso(now - 2 * hour), url: "https://github.com/acme/hermes/pull/4653", repo: "acme/hermes", review: "REVIEW_REQUIRED", ci: "SUCCESS" },
      { number: 4686, title: "[ABC-15421] Filtro de divergência", isDraft: true, ts: iso(now - 3 * hour), url: "https://github.com/acme/hermes/pull/4686", repo: "acme/hermes", review: null, ci: null },
      { number: 4632, title: "Ranking de candidatos", isDraft: false, ts: iso(now - 30 * hour), url: "https://github.com/acme/hermes/pull/4632", repo: "acme/hermes", review: "REVIEW_REQUIRED", ci: "FAILURE" },
    ],
    reviewsTotal: 1,
    reviews: [
      { number: 4651, title: "fix(g40pro): três débitos técnicos", isDraft: false, ts: iso(now - 40 * hour), url: "https://github.com/acme/hermes/pull/4651", repo: "acme/hermes", author: "someone-else" },
    ],
    ...overrides,
  });
}
function notificationsJson(rows: unknown[] | null = null): string {
  return JSON.stringify(rows ?? [
    { id: "25315046944", reason: "ci_activity", ts: iso(now - 5 * hour), title: "CI workflow run failed for a branch", subjectUrl: null, repo: "acme/hermes", repoUrl: "https://github.com/acme/hermes" },
    { id: "25315046999", reason: "mention", ts: iso(now - hour), title: "You were mentioned", subjectUrl: "https://api.github.com/repos/acme/hermes/issues/77", repo: "acme/hermes", repoUrl: "https://github.com/acme/hermes" },
  ]);
}

// A scripted `gh`: answers by endpoint, records every call and its timeout.
function runner(answers: { graphql?: string; notifications?: string; user?: string } = {}) {
  const calls: Array<{ cmd: string[]; timeoutMs: number }> = [];
  const run = async (cmd: string[], timeoutMs: number) => {
    calls.push({ cmd, timeoutMs });
    if (cmd[2] === "graphql") return answers.graphql ?? graphqlJson();
    if (cmd[2] === "user") return answers.user ?? "octocat";
    if (cmd.includes("/notifications")) return answers.notifications ?? notificationsJson();
    return "";
  };
  return { run, calls };
}
function readyStore(overrides: Partial<ReturnType<typeof emptyInboxStore>> = {}) {
  const store = emptyInboxStore();
  Object.assign(store, { login: "octocat", attemptedAt: now - GITHUB_REFRESH_MS, fetchedAt: now - GITHUB_REFRESH_MS, okAt: now - GITHUB_REFRESH_MS }, overrides);
  return store;
}

describe("github inbox parsing", () => {
  test("reads the graphql document into three sorted, capped lists", async () => {
    const parsed = parseInboxGraphql(graphqlJson());
    expect(parsed).toBeTruthy();
    expect(parsed!.login).toBe("octocat");
    expect(parsed!.prsTotal).toBe(3);
    expect(parsed!.reviewsTotal).toBe(1);
    expect(parsed!.prs.map(pr => pr.number)).toEqual([4632, 4653, 4686]);   // failing CI, then updatedAt desc
    expect(parsed!.reviews[0]).toMatchObject({ number: 4651, repo: "acme/hermes", author: "someone-else" });
  });

  // 4632 is the failing PR and also the least recently touched one, so plain
  // newest-first put it third. MY PRS renders three rows on a 1080p desk, and
  // the header already counted the failure — the card must not then hide it.
  test("a failing build sorts above fresher PRs instead of below the fold", () => {
    const prs = parseInboxGraphql(graphqlJson())!.prs;
    expect(prs[0]).toMatchObject({ number: 4632, ci: "FAILURE" });
    expect(prs.map(pr => pr.number)).toEqual([4632, 4653, 4686]);
  });

  test("ERROR counts as broken too, and ties fall back to newest-first", () => {
    const parsed = parseInboxGraphql(graphqlJson({
      prsTotal: 4,
      prs: [
        { number: 1, title: "old error", ts: iso(now - 50 * hour), url: "https://github.com/acme/hermes/pull/1", repo: "acme/hermes", ci: "ERROR" },
        { number: 2, title: "fresh and green", ts: iso(now - hour), url: "https://github.com/acme/hermes/pull/2", repo: "acme/hermes", ci: "SUCCESS" },
        { number: 3, title: "newer failure", ts: iso(now - 2 * hour), url: "https://github.com/acme/hermes/pull/3", repo: "acme/hermes", ci: "FAILURE" },
        { number: 4, title: "pending is not broken", ts: iso(now - 3 * hour), url: "https://github.com/acme/hermes/pull/4", repo: "acme/hermes", ci: "PENDING" },
      ],
    }))!;
    expect(parsed.prs.map(pr => pr.number)).toEqual([3, 1, 2, 4]);
  });

  test("draft is a flag on an open PR, not a state that gets filtered out", () => {
    const prs = parseInboxGraphql(graphqlJson())!.prs;
    expect(prs.filter(pr => pr.isDraft).map(pr => pr.number)).toEqual([4653, 4686]);
    expect(prs).toHaveLength(3);
  });

  test("a null statusCheckRollup is no CI, never a failure", () => {
    const prs = parseInboxGraphql(graphqlJson())!.prs;
    expect(prs.find(pr => pr.number === 4686)!.ci).toBe("");
    expect(prs.find(pr => pr.number === 4653)!.ci).toBe("SUCCESS");
    expect(prs.find(pr => pr.number === 4632)!.ci).toBe("FAILURE");
    // A null reviewDecision is likewise absent, not a decision.
    expect(prs.find(pr => pr.number === 4686)!.review).toBe("");
  });

  test("rejects anything that is not the reshaped payload", () => {
    expect(parseInboxGraphql("")).toBeNull();
    expect(parseInboxGraphql("not json")).toBeNull();
    expect(parseInboxGraphql("[]")).toBeNull();
    expect(parseInboxGraphql(JSON.stringify({ prs: [] }))).toBeNull();          // reviews missing
    expect(parseInboxGraphql(JSON.stringify({ prs: {}, reviews: [] }))).toBeNull();
    expect(parseInboxNotifications("")).toBeNull();
    expect(parseInboxNotifications("{}")).toBeNull();
  });

  test("drops rows that cannot address a real pull request", () => {
    const parsed = parseInboxGraphql(JSON.stringify({
      prs: [
        { number: 0, repo: "acme/hermes", ts: iso(now) },                       // no number
        { number: 5, repo: "../../etc", ts: iso(now) },                         // not a repo
        { number: 6, repo: "acme/hermes", ts: "not a date" },                   // no stamp
        { number: 7, repo: "acme/..", ts: iso(now) },                           // traversal segment
        "nonsense", null, 42,
        { number: 8, repo: "acme/hermes", ts: iso(now) },                       // the only good one
      ],
      reviews: [],
    }));
    expect(parsed!.prs.map(pr => pr.number)).toEqual([8]);
  });

  test("a PR with no url of its own still gets a working one", () => {
    const parsed = parseInboxGraphql(JSON.stringify({
      prs: [{ number: 12, repo: "acme/hermes", ts: iso(now), url: "javascript:alert(1)" }],
      reviews: [],
    }));
    expect(parsed!.prs[0].url).toBe("https://github.com/acme/hermes/pull/12");
  });

  test("caps each list at INBOX_MAX_ITEMS but keeps GitHub's own total", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, repo: "acme/hermes", ts: iso(now - i * minute), title: "t" }));
    const parsed = parseInboxGraphql(JSON.stringify({ prs: many, reviews: [], prsTotal: 97 }));
    expect(parsed!.prs).toHaveLength(INBOX_MAX_ITEMS);
    expect(parsed!.prs[0].number).toBe(1);            // newest first
    expect(parsed!.prsTotal).toBe(97);
  });
});

describe("ticket keys", () => {
  test("splits a leading issue key off the title, in every bracket style", () => {
    expect(splitTicket("[INFLTECH-14351] Um caminho único")).toEqual({ ticket: "INFLTECH-14351", title: "Um caminho único" });
    expect(splitTicket("ABC-12: do the thing")).toEqual({ ticket: "ABC-12", title: "do the thing" });
    expect(splitTicket("(XY-9) do the thing")).toEqual({ ticket: "XY-9", title: "do the thing" });
    expect(splitTicket("PROJ-100 - do the thing")).toEqual({ ticket: "PROJ-100", title: "do the thing" });
  });

  test("leaves a title with no key alone", () => {
    expect(splitTicket("fix(g40pro): três débitos técnicos")).toEqual({ ticket: "", title: "fix(g40pro): três débitos técnicos" });
    expect(splitTicket("lowercase-12 not a key")).toEqual({ ticket: "", title: "lowercase-12 not a key" });
    // A key in the middle is not a prefix and must not be torn out.
    expect(splitTicket("revert ABC-12 for now")).toEqual({ ticket: "", title: "revert ABC-12 for now" });
  });

  test("a title that is only a key keeps it as its text", () => {
    expect(splitTicket("[ABC-12]")).toEqual({ ticket: "", title: "[ABC-12]" });
  });

  test("titles are text, never objects or control characters", () => {
    expect(splitTicket({ toString: () => "nope" }).title).toBe("");
    expect(splitTicket(["a"]).title).toBe("");
    expect(splitTicket("line\nbreak\tand nul").title).toBe("line break and nul");
    expect(splitTicket("x".repeat(400)).title).toHaveLength(200);
  });
});

describe("notification urls", () => {
  test("rewrites an API subject url to the web page nobody can click otherwise", () => {
    expect(notificationWebUrl("https://api.github.com/repos/acme/hermes/pulls/4653", "https://github.com/acme/hermes"))
      .toBe("https://github.com/acme/hermes/pull/4653");
    expect(notificationWebUrl("https://api.github.com/repos/acme/hermes/issues/77", "https://github.com/acme/hermes"))
      .toBe("https://github.com/acme/hermes/issues/77");
  });

  test("falls back to the repository when subject.url is null — the CheckSuite case", () => {
    expect(notificationWebUrl(null, "https://github.com/acme/hermes")).toBe("https://github.com/acme/hermes");
    expect(notificationWebUrl(undefined, "https://github.com/acme/hermes")).toBe("https://github.com/acme/hermes");
    // A subject kind with no obvious web equivalent lands on the repo too.
    expect(notificationWebUrl("https://api.github.com/repos/acme/hermes/releases/9", "https://github.com/acme/hermes"))
      .toBe("https://github.com/acme/hermes");
  });

  test("a null subject url on a real notification row resolves to the repo", () => {
    const rows = parseInboxNotifications(notificationsJson())!.rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.reason === "ci_activity")!.url).toBe("https://github.com/acme/hermes");
    expect(rows.find(row => row.reason === "mention")!.url).toBe("https://github.com/acme/hermes/issues/77");
  });

  test("never hands the browser anything but an https github.com url", () => {
    expect(validGithubUrl("https://github.com/acme/hermes")).toBe("https://github.com/acme/hermes");
    for (const hostile of [
      "http://github.com/acme/hermes",                 // not https
      "https://github.com.evil.test/acme",             // suffix on the host
      "https://evil.test/github.com/acme",             // host in the path
      "https://github.com\\@evil.test/x",              // backslash-authority trick
      "https://user:pw@github.com/acme",               // credentials
      "javascript:alert(1)",
      "https://github.com/acme hermes",                // whitespace
      "https://github.com/" + "x".repeat(500),         // over the length cap
      null, 42, {},
    ]) expect(validGithubUrl(hostile as unknown)).toBe("");
    // A hostile url in the store is dropped, and the row falls back.
    expect(notificationWebUrl("javascript:alert(1)", "javascript:alert(1)")).toBe("");
  });

  test("drops notification rows with no id, repo or stamp", () => {
    const parsed = parseInboxNotifications(JSON.stringify([
      { id: "not-an-id", repo: "acme/hermes", ts: iso(now) },
      { id: "1", repo: "../etc", ts: iso(now) },
      { id: "2", repo: "acme/hermes", ts: 0 },
      { id: "3", repo: "acme/hermes", ts: iso(now) },
    ]));
    expect(parsed!.rows.map(row => row.id)).toEqual(["3"]);
  });
});

describe("notification reasons", () => {
  test("shortens GitHub's slugs to something that fits a tag", () => {
    expect(notificationReasonLabel("ci_activity")).toBe("CI");
    expect(notificationReasonLabel("mention")).toBe("MENTION");
    expect(notificationReasonLabel("review_requested")).toBe("REVIEW");
    expect(notificationReasonLabel("security_alert")).toBe("SECURITY");
    expect(notificationReasonLabel("subscribed")).toBe("WATCH");
  });

  test("an unknown reason stays legible instead of disappearing", () => {
    expect(notificationReasonLabel("brand_new_reason")).toBe("BRAND NEW");
    expect(notificationReasonLabel("")).toBe("NOTICE");
    expect(notificationReasonLabel(null)).toBe("NOTICE");
    expect(notificationReasonLabel({})).toBe("NOTICE");
  });
});

describe("inbox store on disk", () => {
  test("a truncated or non-object file degrades to an empty store", () => {
    expect(parseInboxStoreText('{"prs":[{"number":1,')).toEqual(emptyInboxStore());
    expect(parseInboxStoreText("")).toEqual(emptyInboxStore());
    expect(parseInboxStoreText(null)).toEqual(emptyInboxStore());
    expect(parseInboxStoreText("[]")).toEqual(emptyInboxStore());
    expect(parseInboxStoreText("7")).toEqual(emptyInboxStore());
    // Over the byte cap it is not even parsed.
    expect(parseInboxStoreText("x".repeat(INBOX_STORE_MAX_BYTES + 1))).toEqual(emptyInboxStore());
  });

  test("an older schema loses the fields it lacks instead of throwing", () => {
    // The heatmap store's shape, read by mistake: nothing here is an inbox.
    const store = normalizeInboxStore({ login: "octocat", commits: { abc1234: [now, "acme/hermes"] }, coveredFrom: now });
    expect(store.login).toBe("octocat");
    expect(store.prs).toEqual([]);
    expect(store.reviews).toEqual([]);
    expect(store.notifications).toEqual([]);
  });

  test("wrong types where lists and numbers belong are ignored", () => {
    const store = normalizeInboxStore({
      login: 42, attemptedAt: "soon", fetchedAt: -1, okAt: NaN, failCount: 9999,
      prs: "not a list", reviews: {}, notifications: 7, prsTotal: "many", error: { message: "x" },
    });
    expect(store.login).toBe("");
    expect(store.attemptedAt).toBe(0);
    expect(store.fetchedAt).toBe(0);
    expect(store.okAt).toBe(0);
    expect(store.failCount).toBe(16);          // clamped, not unbounded
    expect(store.prs).toEqual([]);
    expect(store.prsTotal).toBe(0);
    expect(store.error).toBe("");
  });

  test("round-trips a real store and re-validates every row on the way in", () => {
    const store = readyStore();
    store.prs = parseInboxGraphql(graphqlJson())!.prs;
    store.notifications = parseInboxNotifications(notificationsJson())!.rows;
    store.prsTotal = 3;
    const reloaded = parseInboxStoreText(JSON.stringify(store));
    expect(reloaded.prs.map(pr => pr.number)).toEqual([4632, 4653, 4686]);
    // By number, not by index: the order is the urgency order, not the input one.
    expect(reloaded.prs.find(pr => pr.number === 4653)!.ticket).toBe("INFLTECH-14351");
    expect(reloaded.notifications.map(row => row.id)).toEqual(["25315046999", "25315046944"]);
    expect(reloaded.prsTotal).toBe(3);
  });

  test("a hand-edited store cannot smuggle a url into the browser", () => {
    const reloaded = parseInboxStoreText(JSON.stringify({
      login: "octocat",
      prs: [{ number: 1, repo: "acme/hermes", ts: iso(now), url: "https://evil.test/x" }],
      notifications: [{ id: "1", repo: "acme/hermes", ts: iso(now), subjectUrl: "https://evil.test/x", repoUrl: "https://evil.test/x" }],
      reviews: [],
    }));
    expect(reloaded.prs[0].url).toBe("https://github.com/acme/hermes/pull/1");
    expect(reloaded.notifications[0].url).toBe("");
  });
});

describe("inbox throttling", () => {
  test("a settled store refreshes on the heatmap's five-minute cadence", () => {
    const store = readyStore({ attemptedAt: now - GITHUB_REFRESH_MS + minute, fetchedAt: now - GITHUB_REFRESH_MS + minute });
    expect(inboxRefreshInterval(store)).toBe(GITHUB_REFRESH_MS);
    expect(inboxRefreshDue(store, now)).toBe(false);
    expect(inboxRefreshDue(readyStore(), now)).toBe(true);
  });

  test("an empty or future-stamped store is always due", () => {
    expect(inboxRefreshDue(emptyInboxStore(), now)).toBe(true);
    expect(inboxRefreshDue(readyStore({ attemptedAt: now + hour, fetchedAt: now + hour }), now)).toBe(true);
  });

  test("failures back off exponentially and settle at the normal interval", () => {
    const intervals = [1, 2, 3, 4, 8].map(failCount => inboxRefreshInterval(readyStore({ error: "boom", failCount })));
    // Doubling, but never past the normal cadence — a broken feed must not
    // end up retrying more slowly than a healthy one.
    expect(intervals).toEqual([2 * minute, 4 * minute, GITHUB_REFRESH_MS, GITHUB_REFRESH_MS, GITHUB_REFRESH_MS]);
    expect(inboxRefreshInterval(readyStore({ error: "boom", failCount: 0 }))).toBe(GITHUB_BACKFILL_MS);
  });

  test("throttling is keyed on the attempt, so a broken feed cannot spin", async () => {
    const store = emptyInboxStore();
    const { run } = runner({ graphql: "", notifications: "" });
    await refreshInbox(store, now, run, true);
    expect(store.attemptedAt).toBe(now);
    expect(store.fetchedAt).toBe(0);              // nothing succeeded
    expect(inboxRefreshDue(store, now + minute)).toBe(false);
  });
});

describe("one refresh", () => {
  test("issues exactly two calls, in parallel, inside the raised timeout", async () => {
    const store = emptyInboxStore();
    const { run, calls } = runner();
    await refreshInbox(store, now, run, true);
    expect(calls).toHaveLength(2);
    expect(calls.some(call => call.cmd[2] === "graphql")).toBe(true);
    expect(calls.some(call => call.cmd.includes("/notifications"))).toBe(true);
    // 4000 ms is the heatmap's budget and too tight for the search backend.
    for (const call of calls) expect(call.timeoutMs).toBe(INBOX_COMMAND_TIMEOUT_MS);
    expect(INBOX_COMMAND_TIMEOUT_MS).toBeGreaterThan(4000);
  });

  test("asks for unread notifications only, and does not narrow to participating", async () => {
    const { run, calls } = runner();
    await refreshInbox(emptyInboxStore(), now, run, true);
    const notifications = calls.find(call => call.cmd.includes("/notifications"))!.cmd;
    expect(notifications).toContain("all=false");
    expect(notifications).toContain("participating=false");
    // Read-only: a GET, and nothing that could mark a thread read.
    expect(notifications[notifications.indexOf("-X") + 1]).toBe("GET");
    expect(notifications.filter(arg => ["PUT", "PATCH", "POST", "DELETE"].includes(arg))).toEqual([]);
  });

  test("the query asks for open PRs and reviews requested of the viewer", () => {
    expect(INBOX_GRAPHQL_QUERY).toContain("states: OPEN");
    expect(INBOX_GRAPHQL_QUERY).toContain("review-requested:@me");
    expect(INBOX_GRAPHQL_QUERY).toContain("statusCheckRollup");
    expect(INBOX_GRAPHQL_QUERY).toContain("login");
    expect(INBOX_GRAPHQL_QUERY).toContain(`first: ${INBOX_MAX_ITEMS}`);
  });

  test("a successful refresh fills the store and clears the error", async () => {
    const store = emptyInboxStore();
    const { run } = runner();
    await refreshInbox(store, now, run, true);
    expect(store.login).toBe("octocat");
    expect(store.error).toBe("");
    expect(store.failCount).toBe(0);
    expect(store.okAt).toBe(now);
    expect(store.prs).toHaveLength(3);
    expect(store.reviews).toHaveLength(1);
    expect(store.notifications).toHaveLength(2);
  });

  test("one failed feed keeps the other's rows and marks the reason", async () => {
    const store = readyStore();
    store.prs = parseInboxGraphql(graphqlJson())!.prs;
    const { run } = runner({ notifications: "" });
    await refreshInbox(store, now, run, true);
    expect(store.prs).toHaveLength(3);            // graphql still worked
    expect(store.error).toBe("notifications fetch failed");
    expect(store.failCount).toBe(1);
    expect(store.fetchedAt).toBe(now);            // partial success is still a fetch
    expect(store.okAt).not.toBe(now);
  });

  test("a timed-out refresh leaves yesterday's inbox in place rather than emptying it", async () => {
    const store = readyStore();
    store.prs = parseInboxGraphql(graphqlJson())!.prs;
    store.notifications = parseInboxNotifications(notificationsJson())!.rows;
    const { run } = runner({ graphql: "", notifications: "" });
    await refreshInbox(store, now, run, true);
    expect(store.prs).toHaveLength(3);
    expect(store.notifications).toHaveLength(2);
    expect(store.error).toBe("pull requests+notifications fetch failed");
  });

  test("gh missing is reported without any call at all", async () => {
    const { run, calls } = runner();
    const store = await refreshInbox(emptyInboxStore(), now, run, false);
    expect(calls).toHaveLength(0);
    expect(store.error).toBe("gh not installed");
    expect(inboxSnapshot(store, now, false).state).toBe("missing");
  });

  test("both feeds failing on a fresh store probes gh once to tell logged-out from unreachable", async () => {
    const loggedOut = runner({ graphql: "", notifications: "", user: "" });
    const store = await refreshInbox(emptyInboxStore(), now, loggedOut.run, true);
    expect(loggedOut.calls).toHaveLength(3);
    expect(store.error).toBe("gh not authenticated");
    expect(inboxSnapshot(store, now, true).state).toBe("unauthenticated");

    // Logged in but unreachable: the probe answers, so the state is honest.
    const unreachable = runner({ graphql: "", notifications: "" });
    const other = await refreshInbox(emptyInboxStore(), now, unreachable.run, true);
    expect(other.login).toBe("octocat");
    expect(inboxSnapshot(other, now, true).state).toBe("unavailable");
  });

  test("a store that already knows its login never spends the extra probe", async () => {
    const { run, calls } = runner({ graphql: "", notifications: "" });
    await refreshInbox(readyStore(), now, run, true);
    expect(calls).toHaveLength(2);
  });

  test("switching accounts does not leave the previous one's notifications behind", async () => {
    const store = readyStore({ login: "someone-else" });
    store.notifications = parseInboxNotifications(notificationsJson())!.rows;
    store.notificationsTotal = 2;
    const { run } = runner();
    await refreshInbox(store, now, run, true);
    expect(store.login).toBe("octocat");
    expect(store.notifications.map(row => row.id)).toEqual(["25315046999", "25315046944"]);
    expect(store.notificationsTotal).toBe(2);

    // Nothing new arrives for the new account: the old rows are gone, not kept.
    const emptied = readyStore({ login: "someone-else" });
    emptied.notifications = parseInboxNotifications(notificationsJson())!.rows;
    emptied.notificationsTotal = 2;
    await refreshInbox(emptied, now, runner({ notifications: "" }).run, true);
    expect(emptied.notifications).toEqual([]);
    expect(emptied.notificationsTotal).toBe(0);
  });
});

describe("the card's counts and states", () => {
  test("counts what the hint promises: open, draft, CI failures, unread", async () => {
    const store = emptyInboxStore();
    await refreshInbox(store, now, runner().run, true);
    expect(inboxCounts(store)).toEqual({ open: 3, draft: 2, ciFail: 1, unread: 2, reviews: 1 });
  });

  test("a CI error counts as a failure; pending and absent do not", () => {
    const store = emptyInboxStore();
    store.prs = parseInboxGraphql(JSON.stringify({
      prs: [
        { number: 1, repo: "a/b", ts: iso(now), ci: "ERROR" },
        { number: 2, repo: "a/b", ts: iso(now), ci: "PENDING" },
        { number: 3, repo: "a/b", ts: iso(now), ci: null },
        { number: 4, repo: "a/b", ts: iso(now), ci: "FAILURE" },
      ],
      reviews: [],
    }))!.prs;
    expect(inboxCounts(store).ciFail).toBe(2);
  });

  test("mirrors the heatmap's state machine, message for message", async () => {
    expect(inboxSnapshot(emptyInboxStore(), now, false).state).toBe("missing");
    expect(inboxSnapshot(emptyInboxStore(), now, true).state).toBe("pending");

    const ok = emptyInboxStore();
    await refreshInbox(ok, now, runner().run, true);
    expect(inboxSnapshot(ok, now, true).state).toBe("ok");

    // A fresh failure keeps the card "ok" for the stale grace period, so one
    // timed-out gh does not flash a warning at the user for a minute.
    const failing = readyStore({ error: "boom", failCount: 1, okAt: now - minute });
    failing.prs = parseInboxGraphql(graphqlJson())!.prs;
    expect(inboxSnapshot(failing, now, true).state).toBe("ok");

    const stale = readyStore({ error: "boom", failCount: 4, okAt: now - GITHUB_STALE_AFTER_MS - minute });
    stale.prs = parseInboxGraphql(graphqlJson())!.prs;
    expect(inboxSnapshot(stale, now, true).state).toBe("stale");

    // Persistent failure with nothing cached is unavailable, not stale.
    expect(inboxSnapshot(readyStore({ error: "boom", failCount: 4, okAt: now - hour }), now, true).state).toBe("unavailable");
  });

  test("the snapshot carries only the three lists and the counts", async () => {
    const store = emptyInboxStore();
    await refreshInbox(store, now, runner().run, true);
    expect(Object.keys(inboxSnapshot(store, now, true)).sort())
      .toEqual(["counts", "error", "fetchedAt", "login", "notifications", "prs", "reviews", "state"]);
  });
});
