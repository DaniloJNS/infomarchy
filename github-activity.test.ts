import { describe, expect, test } from "bun:test";
import { activityCellIndex, parseJsonBounded } from "./collector.ts";
import { localDayStarts } from "./history-time.ts";
import {
  GITHUB_BACKFILL_MS, GITHUB_LOGIN_TTL_MS, GITHUB_RECONCILE_MS, GITHUB_REFRESH_MS, GITHUB_STALE_AFTER_MS, GITHUB_WINDOW_MS, compareEventIds, emptyGithubStore,
  githubCells, githubCounts, githubCoverageComplete, githubEventKind, githubKindLabel, githubRefreshDue, githubRefreshInterval, githubSearchQuery,
  githubSnapshot, normalizeGithubStore, parseGithubCommits, parseGithubEvents, parseGithubStoreText, pruneGithubStore, refreshGithubActivity,
  validGithubLogin,
} from "./github-activity.ts";

const now = new Date(2026, 8, 5, 21, 0, 0, 0).getTime();
const days = localDayStarts(now, 7);
const hour = 3600_000, day = 86_400_000, minute = 60_000;
const iso = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");

function commitsJson(items: Array<[string, number, string]>, total = items.length, incomplete = false): string {
  return JSON.stringify({ total, incomplete, items: items.map(([sha, ts, repo]) => ({ sha, ts: new Date(ts).toISOString(), repo })) });
}
function eventsJson(items: Array<[string, string, number, string]>): string {
  return JSON.stringify(items.map(([id, type, ts, repo]) => ({ id, type, ts: new Date(ts).toISOString(), repo })));
}
function sha(i: number): string { return i.toString(16).padStart(7, "0"); }
type Answers = {
  user?: string;
  events?: (page: number) => string;
  commits?: (range: { from: string; to: string }, page: number) => string;
};
// A scripted `gh`: answers by endpoint, range and page, records every call.
function runner(answers: Answers) {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[2] === "user") return answers.user ?? "";
    const arg = (flag: string, prefix: string) => String(cmd.find((value, i) => cmd[i - 1] === flag && value.startsWith(prefix)) || "").slice(prefix.length);
    const page = Number(arg("-F", "page=") || "1");
    if (cmd[4]?.startsWith("/users/")) return answers.events ? answers.events(page) : "[]";
    if (cmd[4] === "search/commits") {
      const match = /author-date:(\S+)\.\.(\S+)/.exec(arg("-f", "q="));
      return answers.commits ? answers.commits({ from: match?.[1] || "", to: match?.[2] || "" }, page) : commitsJson([]);
    }
    return "";
  };
  const searchCalls = () => calls.filter(cmd => cmd[4] === "search/commits");
  const eventCalls = () => calls.filter(cmd => String(cmd[4]).startsWith("/users/"));
  return { run, calls, searchCalls, eventCalls };
}
function readyStore(overrides: Partial<ReturnType<typeof emptyGithubStore>> = {}) {
  const store = emptyGithubStore();
  Object.assign(store, { login: "nixfred", loginCheckedAt: now - hour, attemptedAt: now - GITHUB_REFRESH_MS, fetchedAt: now - GITHUB_REFRESH_MS, okAt: now - GITHUB_REFRESH_MS, commitsAt: now - GITHUB_REFRESH_MS, reconciledAt: now - hour, coveredFrom: now - GITHUB_WINDOW_MS }, overrides);
  return store;
}

describe("github event classification", () => {
  test("maps event types to heatmap kinds and drops pushes", () => {
    expect(githubEventKind("PushEvent")).toBe("");
    expect(githubEventKind("PullRequestEvent")).toBe("pr");
    expect(githubEventKind("PullRequestReviewEvent")).toBe("review");
    expect(githubEventKind("IssuesEvent")).toBe("issue");
    expect(githubEventKind("IssueCommentEvent")).toBe("comment");
    expect(githubEventKind("WatchEvent")).toBe("other");
    expect(githubEventKind("MysteryEvent")).toBe("");
    expect(githubEventKind(undefined)).toBe("");
    expect(githubKindLabel("pr")).toBe("PRs");
  });

  test("validates logins the way GitHub does", () => {
    expect(validGithubLogin(" nixfred\n")).toBe("nixfred");
    expect(validGithubLogin("-bad")).toBe("");
    expect(validGithubLogin("a".repeat(40))).toBe("");
    expect(validGithubLogin({ toString: () => "x" })).toBe("");
  });

  test("orders event ids numerically past 2^53", () => {
    expect(compareEventIds("9", "10")).toBeLessThan(0);
    expect(compareEventIds("20194097375", "20193987829")).toBeGreaterThan(0);
    expect(compareEventIds("99999999999999999999", "100000000000000000000")).toBeLessThan(0);
    expect(compareEventIds("007", "7")).toBe(0);
  });
});

describe("github feed parsing", () => {
  test("keeps every well-formed event (pushes with an empty kind) and rejects malformed rows", () => {
    const rows = parseGithubEvents(eventsJson([
      ["1", "PullRequestEvent", now - hour, "nixfred/infomarchy"],
      ["2", "PushEvent", now - hour, "nixfred/infomarchy"],
      ["x", "IssuesEvent", now - hour, "nixfred/infomarchy"],
      ["3", "IssuesEvent", now - hour, "not a repo"],
    ]));
    expect(rows).toEqual([
      { id: "1", ts: now - hour, kind: "pr", repo: "nixfred/infomarchy" },
      { id: "2", ts: now - hour, kind: "", repo: "nixfred/infomarchy" },
    ]);
    expect(parseGithubEvents("not json")).toBeNull();
    expect(parseGithubEvents("{}")).toBeNull();
    expect(parseGithubEvents("[]")).toEqual([]);
  });

  test("keeps commit rows with author dates and reports the total and the incomplete flag", () => {
    const parsed = parseGithubCommits(commitsJson([["abc1234", now - 2 * hour, "nixfred/blip"], ["ZZZ", now, "nixfred/blip"]], 155, true));
    expect(parsed).toEqual({ total: 155, incomplete: true, items: [{ sha: "abc1234", ts: now - 2 * hour, repo: "nixfred/blip" }] });
    expect(parseGithubCommits(commitsJson([]))?.incomplete).toBe(false);
    expect(parseGithubCommits("")).toBeNull();
    expect(parseGithubCommits("[]")).toBeNull();
    expect(parseGithubCommits(JSON.stringify({ total: "many", items: [] }))).toBeNull();
  });

  test("search queries carry an explicit author-date range in UTC", () => {
    expect(githubSearchQuery("nixfred", Date.UTC(2026, 7, 29), Date.UTC(2026, 8, 4, 3, 48, 41)))
      .toBe("author:nixfred author-date:2026-08-29T00:00:00Z..2026-09-04T03:48:41Z");
  });
});

describe("github store", () => {
  test("normalizes a store from disk and discards junk", () => {
    const store = normalizeGithubStore({
      login: "nixfred", loginCheckedAt: now, fetchedAt: now, coveredFrom: now - day, failCount: 99, newestEventId: "12ab",
      backfill: { from: now - day, to: now - 2 * day, page: 1, fetched: 0 },
      commits: { abc1234: [now - hour, "nixfred/blip"], bad: [now, "nixfred/blip"], def5678: ["soon", "nixfred/blip"] },
      events: { "1": [now - hour, "pr", "nixfred/blip"], "2": [now - hour, "commit", "nixfred/blip"], "3": [now - hour, "pr", "../etc"] },
      error: 7,
    });
    expect(Object.keys(store.commits)).toEqual(["abc1234"]);
    expect(Object.keys(store.events)).toEqual(["1"]);
    expect(store.error).toBe("");
    expect(store.failCount).toBe(16);
    expect(store.newestEventId).toBe("");
    expect(store.backfill).toBeNull();   // to must be above from
    expect(normalizeGithubStore({ backfill: { from: now - 3 * day, to: now - day, page: 4, fetched: 300 } }).backfill).toEqual({ from: now - 3 * day, to: now - day, end: now - day, page: 4, fetched: 300 });
    expect(normalizeGithubStore(null)).toEqual(emptyGithubStore());
    expect(normalizeGithubStore("[]")).toEqual(emptyGithubStore());
  });

  test("a week of commits survives the disk round trip where the collector's general reader would reject it", () => {
    const store = readyStore();
    for (let i = 0; i < 2600; i++) store.commits[sha(i)] = [now - i * minute, "nixfred/blip"];
    const text = JSON.stringify(store);
    expect(parseJsonBounded(text)).toBeNull();   // the generic reader caps collections at 2048 entries
    const back = parseGithubStoreText(text);
    expect(Object.keys(back.commits)).toHaveLength(2600);
    expect(back.coveredFrom).toBe(store.coveredFrom);
    expect(parseGithubStoreText("")).toEqual(emptyGithubStore());
    expect(parseGithubStoreText("{not json")).toEqual(emptyGithubStore());
    expect(parseGithubStoreText(null)).toEqual(emptyGithubStore());
  });

  test("prunes rows outside the window and clamps coverage and backfill to it", () => {
    const store = emptyGithubStore();
    store.commits.old = [now - GITHUB_WINDOW_MS - 1, "a/b"];
    store.commits.kept = [now - GITHUB_WINDOW_MS + 1, "a/b"];
    store.commits.future = [now + 2 * hour, "a/b"];
    store.events["9"] = [now - 10 * day, "pr", "a/b"];
    store.coveredFrom = now - 30 * day;
    store.backfill = { from: now - 30 * day, to: now - 20 * day, page: 2, fetched: 100 };
    pruneGithubStore(store, now);
    expect(Object.keys(store.commits)).toEqual(["kept"]);
    expect(store.events).toEqual({});
    expect(store.coveredFrom).toBe(now - GITHUB_WINDOW_MS);
    expect(store.backfill).toBeNull();
  });

  test("refresh cadence: five minutes when complete, one minute while filling, backoff on failure, never every tick", () => {
    const store = emptyGithubStore();
    expect(githubRefreshDue(store, now)).toBe(true);
    Object.assign(store, { attemptedAt: now - GITHUB_REFRESH_MS + 1, fetchedAt: now - GITHUB_REFRESH_MS + 1, commitsAt: now - hour, coveredFrom: now - GITHUB_WINDOW_MS });
    expect(githubCoverageComplete(store, now)).toBe(true);
    expect(githubRefreshDue(store, now)).toBe(false);
    store.attemptedAt = store.fetchedAt = now - GITHUB_REFRESH_MS;
    expect(githubRefreshDue(store, now)).toBe(true);
    store.coveredFrom = now - day;
    store.attemptedAt = store.fetchedAt = now - GITHUB_BACKFILL_MS;
    expect(githubCoverageComplete(store, now)).toBe(false);
    expect(githubRefreshDue(store, now)).toBe(true);
    // A failed attempt is stamped even though nothing was fetched, and backs off.
    store.attemptedAt = now - 4000; store.fetchedAt = now - day; store.error = "commits fetch failed";
    store.failCount = 1; expect(githubRefreshInterval(store, now)).toBe(2 * GITHUB_BACKFILL_MS); expect(githubRefreshDue(store, now)).toBe(false);
    store.failCount = 3; expect(githubRefreshInterval(store, now)).toBe(GITHUB_REFRESH_MS);
    store.failCount = 12; expect(githubRefreshInterval(store, now)).toBe(GITHUB_REFRESH_MS);
    store.attemptedAt = now + 5000;   // clock went backwards: refresh rather than wait forever
    expect(githubRefreshDue(store, now)).toBe(true);
    Object.assign(store, { error: "", failCount: 0, coveredFrom: now - GITHUB_WINDOW_MS, forward: { from: now - day, to: now, end: now, page: 3, fetched: 200 } });
    expect(githubRefreshInterval(store, now)).toBe(GITHUB_BACKFILL_MS);   // a walk in progress steps every minute
  });

  test("cells and counts agree with the prompt heatmap's day/hour mapping", () => {
    const store = emptyGithubStore();
    const stamp = new Date(2026, 8, 3, 14, 30).getTime();
    store.commits.a = [stamp, "nixfred/blip"];
    store.commits.b = [stamp + minute, "nixfred/atmos"];
    store.events["1"] = [stamp + 2 * minute, "pr", "nixfred/blip"];
    store.events["2"] = [now - 30 * minute, "comment", "nixfred/blip"];
    store.events["3"] = [now - 8 * day, "issue", "nixfred/blip"];   // outside the grid
    const cells = githubCells(store, days, activityCellIndex);
    expect(cells).toHaveLength(168);
    expect(cells[activityCellIndex(stamp, days)]).toEqual([3, { commit: 2, pr: 1 }, { "nixfred/blip": 2, "nixfred/atmos": 1 }]);
    expect(cells.reduce((sum, cell) => sum + cell[0], 0)).toBe(4);
    expect(githubCounts(store, days[6], days[0])).toEqual({ commit: { today: 0, week: 2 }, pr: { today: 0, week: 1 }, comment: { today: 1, week: 1 } });
  });
});

describe("github refresh", () => {
  test("first fill: events until a short page, a forward commit range, partial coverage when the search is not exhausted", async () => {
    const commits = Array.from({ length: 200 }, (_, i): [string, number, string] => [sha(i), now - i * 20 * minute, "nixfred/blip"]);
    const gh = runner({
      user: "nixfred\n",
      events: page => page === 1
        ? eventsJson(Array.from({ length: 100 }, (_, i): [string, string, number, string] => [String(1000 - i), i % 2 ? "PushEvent" : "PullRequestEvent", now - i * minute, "nixfred/blip"]))
        : eventsJson([["12", "IssuesEvent", now - 2 * day, "nixfred/atmos"]]),
      commits: (_range, page) => commitsJson(page === 1 ? commits.slice(0, 100) : commits.slice(100, 200), 450),
    });
    const store = await refreshGithubActivity(emptyGithubStore(), now, gh.run);
    expect(store.login).toBe("nixfred");
    expect(store.error).toBe("");
    expect(store.fetchedAt).toBe(now);
    expect(store.okAt).toBe(now);
    expect(store.attemptedAt).toBe(now);
    expect(Object.keys(store.commits)).toHaveLength(200);
    expect(Object.keys(store.events)).toHaveLength(51);   // 50 PRs from page 1 + the issue; pushes are not stored
    expect(store.newestEventId).toBe("1000");
    // 450 rows: the forward walk is mid-way, so nothing is claimed as covered yet.
    expect(store.commitsAt).toBe(0);
    expect(store.coveredFrom).toBe(0);
    expect(store.forward).toEqual({ from: now - GITHUB_WINDOW_MS, to: now, end: now, page: 3, fetched: 200 });
    expect(store.backfill).toBeNull();
    expect(githubCoverageComplete(store, now)).toBe(false);
    expect(githubRefreshInterval(store, now)).toBe(GITHUB_BACKFILL_MS);
    expect(githubSnapshot(store, now, days, activityCellIndex, true)).toMatchObject({ state: "ok", coverage: "partial" });
    expect(gh.eventCalls()).toHaveLength(2);   // page 2 was short, page 3 never requested
    expect(gh.searchCalls()).toHaveLength(2);
    expect(gh.calls.some(cmd => cmd.includes("-f") && String(cmd[cmd.indexOf("-f") + 1]).startsWith("q=author:nixfred author-date:"))).toBe(true);
  });

  test("backfill walks one query page by page until exhausted, so timestamp ties cannot stall it", async () => {
    const tied = now - 3 * day;
    const older = Array.from({ length: 250 }, (_, i): [string, number, string] => [sha(1000 + i), i < 240 ? tied : tied - (i - 239) * hour, "nixfred/atmos"]);
    const ranges: string[] = [];
    const gh = runner({
      events: () => "[]",
      commits: (range, page) => {
        ranges.push(`${range.from}..${range.to}#${page}`);
        if (range.from !== iso(now - GITHUB_WINDOW_MS)) return commitsJson([]);   // forward walks: quiet
        return commitsJson(older.slice((page - 1) * 100, page * 100), 250);
      },
    });
    const store = readyStore({ coveredFrom: now - day, attemptedAt: now - GITHUB_BACKFILL_MS, fetchedAt: now - GITHUB_BACKFILL_MS });
    await refreshGithubActivity(store, now, gh.run);
    expect(Object.keys(store.commits)).toHaveLength(200);
    expect(store.backfill).toEqual({ from: now - GITHUB_WINDOW_MS, to: now - day, end: now - day, page: 3, fetched: 200 });
    expect(store.coveredFrom).toBe(now - GITHUB_REFRESH_MS - 48 * hour);   // the quiet forward walk completed and reached 48 h back; the rest is claimed only when the backfill walk completes
    expect(store.forward).toBeNull();
    expect(githubCoverageComplete(store, now)).toBe(false);
    const later = now + GITHUB_BACKFILL_MS;
    expect(githubRefreshDue(store, later)).toBe(true);
    await refreshGithubActivity(store, later, gh.run);
    expect(Object.keys(store.commits)).toHaveLength(250);
    expect(store.backfill).toBeNull();
    expect(githubCoverageComplete(store, later)).toBe(true);
    expect(githubRefreshInterval(store, later)).toBe(GITHUB_REFRESH_MS);
    // The second step asked for pages 3 and 4 of the same range rather than a new query at the boundary.
    expect(ranges.filter(r => r.startsWith(iso(now - GITHUB_WINDOW_MS))).map(r => r.split("#")[1])).toEqual(["1", "2", "3", "4"]);
  });

  test("a burst of commits inside the overlap keeps the forward walk going instead of restarting it", async () => {
    const recent = Array.from({ length: 250 }, (_, i): [string, number, string] => [sha(2000 + i), now - i * 5 * minute, "nixfred/blip"]);
    const pages: number[] = [];
    const gh = runner({
      events: () => "[]",
      commits: (range, page) => { pages.push(page); return range.to === iso(now) ? commitsJson(recent.slice((page - 1) * 100, page * 100), 250) : commitsJson([]); },
    });
    const store = readyStore();   // coverage complete before the burst
    await refreshGithubActivity(store, now, gh.run);
    expect(Object.keys(store.commits)).toHaveLength(200);
    expect(store.forward).toEqual({ from: now - GITHUB_REFRESH_MS - 48 * hour, to: now, end: now, page: 3, fetched: 200 });
    expect(store.commitsAt).toBe(now - GITHUB_REFRESH_MS);   // not advanced until the walk completes
    expect(store.backfill).toBeNull();
    const later = now + GITHUB_BACKFILL_MS;
    expect(githubRefreshDue(store, later)).toBe(true);
    await refreshGithubActivity(store, later, gh.run);
    expect(Object.keys(store.commits)).toHaveLength(250);
    expect(store.forward).toBeNull();
    expect(store.commitsAt).toBe(now);
    expect(githubCoverageComplete(store, later)).toBe(true);
    expect(pages).toEqual([1, 2, 3, 4]);
  });

  test("incomplete search results never advance coverage", async () => {
    const gh = runner({ events: () => "[]", commits: () => commitsJson([[sha(3000), now - hour, "nixfred/blip"]], 1, true) });
    const store = readyStore({ coveredFrom: now - day });
    await refreshGithubActivity(store, now, gh.run);
    expect(store.commits[sha(3000)]).toBeDefined();   // the rows are still worth keeping
    expect(store.coveredFrom).toBe(now - day);
    expect(store.commitsAt).toBe(now - GITHUB_REFRESH_MS);
    expect(store.forward?.page).toBe(1);              // the incomplete page is asked for again
    expect(store.backfill?.page).toBe(1);
    expect(githubCoverageComplete(store, now)).toBe(false);
  });

  test("events are paged until a known id and a failed page is reported, not treated as empty", async () => {
    const gh = runner({
      events: page => page === 1
        ? eventsJson(Array.from({ length: 100 }, (_, i): [string, string, number, string] => [String(700 - i), "IssueCommentEvent", now - i * minute, "nixfred/blip"]))
        : page === 2 ? eventsJson([["600", "PullRequestEvent", now - 100 * minute, "nixfred/blip"], ["500", "IssuesEvent", now - 200 * minute, "nixfred/blip"]]) : "[]",
      commits: () => commitsJson([]),
    });
    const store = readyStore({ newestEventId: "550" });
    await refreshGithubActivity(store, now, gh.run);
    expect(gh.eventCalls()).toHaveLength(2);
    expect(Object.keys(store.events)).toHaveLength(101);   // 100 new comments + PR 600; 500 was already known
    expect(store.newestEventId).toBe("700");
    expect(store.error).toBe("");
    const broken = runner({ events: page => page === 1 ? eventsJson(Array.from({ length: 100 }, (_, i): [string, string, number, string] => [String(900 - i), "IssuesEvent", now - i * minute, "nixfred/blip"])) : "", commits: () => commitsJson([]) });
    const store2 = readyStore({ newestEventId: "100" });
    await refreshGithubActivity(store2, now, broken.run);
    expect(Object.keys(store2.events)).toHaveLength(100);
    expect(store2.error).toBe("events fetch failed");
    expect(store2.newestEventId).toBe("100");   // not advanced past a page we could not read
    expect(store2.fetchedAt).toBe(now);          // commits still succeeded
  });

  test("a failed commit feed does not move the commit cursor even when events succeed", async () => {
    const gh = runner({ events: () => eventsJson([["42", "PullRequestEvent", now - minute, "nixfred/blip"]]), commits: () => "" });
    const store = readyStore({ commitsAt: now - 3 * day });
    await refreshGithubActivity(store, now, gh.run);
    expect(store.events["42"]).toBeDefined();
    expect(store.commitsAt).toBe(now - 3 * day);
    expect(store.error).toBe("commits fetch failed");
    expect(store.failCount).toBe(1);
    const recovered = runner({ events: () => "[]", commits: range => { expect(range.from).toBe(iso(now - 5 * day)); return commitsJson([]); } });
    await refreshGithubActivity(store, now + GITHUB_REFRESH_MS, recovered.run);   // forward range starts 48 h below the last good commit fetch
    expect(store.error).toBe("");
    expect(store.failCount).toBe(0);
  });

  test("the window is walked again every reconcile interval to catch late-indexed commits", async () => {
    const gh = runner({ events: () => "[]", commits: () => commitsJson([]) });
    const store = readyStore({ reconciledAt: now - GITHUB_RECONCILE_MS });
    await refreshGithubActivity(store, now, gh.run);
    expect(store.reconciledAt).toBe(now);
    expect(store.commitsAt).toBe(now);
    // Coverage was reset to the last verified point, and a backfill walk over the whole window started in the same step.
    const backfillCall = gh.searchCalls().find(cmd => cmd.join(" ").includes(`author-date:${iso(now - GITHUB_WINDOW_MS)}..${iso(now - GITHUB_REFRESH_MS)}`));
    expect(backfillCall).toBeDefined();
    expect(store.coveredFrom).toBe(now - GITHUB_WINDOW_MS);   // the account is quiet, so the walk finished at once
    expect(githubCoverageComplete(store, now)).toBe(true);
  });

  test("an account change starts the store over", async () => {
    const gh = runner({ user: "bob", events: () => "[]", commits: () => commitsJson([]) });
    const store = readyStore({ login: "alice", loginCheckedAt: now - 2 * GITHUB_LOGIN_TTL_MS });
    store.commits.deadbeef = [now - hour, "alice/private"];
    await refreshGithubActivity(store, now, gh.run);
    expect(store.login).toBe("bob");
    expect(store.commits.deadbeef).toBeUndefined();
    expect(store.commitsAt).toBe(now);
    expect(store.coveredFrom).toBe(now - GITHUB_WINDOW_MS);
    expect(gh.searchCalls()[0].join(" ")).toContain("author:bob");
  });

  test("a failed feed keeps the cached rows, says which feed failed, and goes stale only after a grace period", async () => {
    const store = readyStore({ fetchedAt: now - day, okAt: now - day });
    store.commits.cccccccc = [now - 2 * hour, "nixfred/blip"];
    const gh = runner({ events: () => "", commits: () => "" });
    await refreshGithubActivity(store, now, gh.run);
    expect(store.commits.cccccccc).toEqual([now - 2 * hour, "nixfred/blip"]);
    expect(store.error).toBe("events+commits fetch failed");
    expect(store.fetchedAt).toBe(now - day);   // nothing new landed
    expect(store.attemptedAt).toBe(now);       // but the attempt counts for throttling
    expect(store.okAt).toBe(now - day);
    const snapshot = githubSnapshot(store, now, days, activityCellIndex, true);
    expect(snapshot.state).toBe("stale");
    expect(snapshot.counts).toEqual({ commit: { today: 1, week: 1 } });
    store.okAt = now - GITHUB_STALE_AFTER_MS + 1;   // one timed-out call a minute ago is not "stale"
    expect(githubSnapshot(store, now, days, activityCellIndex, true).state).toBe("ok");
    store.okAt = now - GITHUB_STALE_AFTER_MS;
    expect(githubSnapshot(store, now, days, activityCellIndex, true).state).toBe("stale");
    delete store.commits.cccccccc;
    expect(githubSnapshot(store, now, days, activityCellIndex, true).state).toBe("unavailable");
  });

  test("no gh, no login, nothing fetched yet — each stamped so it is not retried every tick", async () => {
    const gh = runner({ user: "To get started with GitHub CLI, please run: gh auth login" });
    const unauth = await refreshGithubActivity(emptyGithubStore(), now, gh.run);
    expect(unauth.login).toBe("");
    expect(unauth.error).toBe("gh not authenticated");
    expect(unauth.attemptedAt).toBe(now);
    expect(githubRefreshDue(unauth, now + 4000)).toBe(false);
    expect(gh.calls).toHaveLength(1);
    expect(githubSnapshot(unauth, now, days, activityCellIndex, true).state).toBe("unauthenticated");
    const missing = await refreshGithubActivity(emptyGithubStore(), now, gh.run, false);
    expect(missing.error).toBe("gh not installed");
    expect(githubSnapshot(missing, now, days, activityCellIndex, false).state).toBe("missing");
    const pending = emptyGithubStore(); pending.login = "nixfred";
    expect(githubSnapshot(pending, now, days, activityCellIndex, true).state).toBe("pending");
    pending.error = "commits fetch failed";
    expect(githubSnapshot(pending, now, days, activityCellIndex, true).state).toBe("unavailable");
  });

  test("snapshot exposes the grid shape the view expects", () => {
    const store = readyStore({ fetchedAt: now, commitsAt: now });
    store.commits.ddddddd = [now - hour, "nixfred/blip"];
    const snapshot = githubSnapshot(store, now, days, activityCellIndex, true);
    expect(snapshot).toMatchObject({ state: "ok", login: "nixfred", coverage: "complete", days, error: "" });
    expect(snapshot.cells).toHaveLength(168);
    expect(snapshot.cells[activityCellIndex(now - hour, days)]).toEqual([1, { commit: 1 }, { "nixfred/blip": 1 }]);
  });
});
