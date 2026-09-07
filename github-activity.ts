// GitHub activity for the GITHUB · LAST 7 DAYS heatmap.
//
// Two feeds, both through the already-authenticated `gh` CLI, both slimmed by
// gh's own --jq so the collector never parses issue bodies or commit messages:
//
//   * commits  — `search/commits` by author and author-date. The user events
//     feed reports a PushEvent with no commit list (payload.size is null on the
//     per-user endpoint), so pushes cannot be counted from it. Search returns
//     one row per commit with the author date, which is when the work happened.
//     GitHub caps a search at 1000 rows and 30 calls a minute, so the 7-day
//     window is filled by "walks": one query over a fixed author-date range,
//     read two pages per refresh until exhausted, so a burst of commits or a
//     run of identical timestamps only takes more steps, never stalls. A
//     forward walk (from 48 h below the last verified point up to now) and a
//     backward walk (from the window start up to `coveredFrom`) run side by
//     side; coverage is only claimed when a walk completes. The window is
//     re-walked every GITHUB_RECONCILE_MS to catch commits that became
//     searchable late (merged to the default branch days after they were
//     authored). Search indexes default branches only.
//   * events   — `/users/<login>/events` for everything that is not a push:
//     pull requests, reviews, issues, comments, releases, forks, stars. The
//     authenticated user sees their private events here too. Pages are read
//     until an already-known event id appears, so a busy hour cannot open a
//     gap between refreshes.
//
// Rows are keyed (sha / event id) in a private state file shared by the
// wallpaper and overlay collectors, pruned to the window, and turned into
// 7×24 cells on every tick. Only one collector instance (the wallpaper) writes
// the store; the overlay reads it. Every attempt — success or failure — is
// stamped, so a failing feed backs off instead of retrying every tick.

export const GITHUB_REFRESH_MS = 5 * 60_000;
export const GITHUB_BACKFILL_MS = 60_000;
export const GITHUB_RECONCILE_MS = 6 * 3600_000;
export const GITHUB_LOGIN_TTL_MS = 24 * 3600_000;
export const GITHUB_WINDOW_MS = 7 * 86_400_000 + 3_600_000;
export const GITHUB_FORWARD_OVERLAP_MS = 48 * 3600_000;
export const GITHUB_COMMAND_TIMEOUT_MS = 4000;
export const GITHUB_PAGE_SIZE = 100;
export const GITHUB_PAGES_PER_FETCH = 2;
export const GITHUB_SEARCH_MAX_PAGES = 10;   // GitHub returns at most 1000 search rows per query
export const GITHUB_EVENT_MAX_PAGES = 3;     // the events feed itself stops at 300
// One timed-out gh call must not flip the card to "stale" for a minute; the
// cached rows are current enough until failures have persisted this long.
export const GITHUB_STALE_AFTER_MS = 15 * 60_000;
export const GITHUB_STORE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_STORE_ROWS = 6000;
const MAX_REPO_NAME = 140;

export const GITHUB_KINDS = ["commit", "pr", "review", "issue", "comment", "other"] as const;
export type GithubKind = (typeof GITHUB_KINDS)[number];

export type GithubCommitRow = [number, string];          // ts, repo
export type GithubEventRow = [number, string, string];   // ts, kind, repo
// One search query [from, to] read page by page. `end` is the upper bound
// the walk was started for; `to` drops below it when a query passes GitHub's
// 1000-row cap and has to be restarted beneath the oldest row received.
export type GithubWalk = { from: number; to: number; end: number; page: number; fetched: number };
export type GithubStore = {
  login: string;
  loginCheckedAt: number;
  attemptedAt: number;     // last refresh attempt, success or not — drives throttling
  fetchedAt: number;       // last refresh where at least one feed succeeded
  okAt: number;            // last refresh with no failures
  commitsAt: number;       // last successful forward commit fetch — the next forward range starts below it
  reconciledAt: number;    // last full-window re-walk
  failCount: number;
  coveredFrom: number;     // commits are complete from here to commitsAt
  forward: GithubWalk | null;
  backfill: GithubWalk | null;
  newestEventId: string;
  commits: Record<string, GithubCommitRow>;
  events: Record<string, GithubEventRow>;
  error: string;
};
export type GithubRunner = (cmd: string[], timeoutMs: number) => Promise<string>;

export function emptyGithubStore(): GithubStore {
  return {
    login: "", loginCheckedAt: 0, attemptedAt: 0, fetchedAt: 0, okAt: 0, commitsAt: 0, reconciledAt: 0, failCount: 0,
    coveredFrom: 0, forward: null, backfill: null, newestEventId: "", commits: {}, events: {}, error: "",
  };
}

export function validGithubLogin(value: unknown): string {
  if (typeof value !== "string") return "";
  const login = value.trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? login : "";
}
// owner/name as GitHub allows them; "." and ".." segments are never a repo
// and must never reach a path or a query.
export function validGithubRepo(value: unknown): string {
  if (typeof value !== "string") return "";
  const repo = value.trim();
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/.exec(repo);
  return match && match[2] !== "." && match[2] !== ".." && repo.length <= MAX_REPO_NAME ? repo : "";
}
function validEventId(value: unknown): string {
  const id = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  return /^[0-9]{1,24}$/.test(id) ? id : "";
}
// GitHub event ids are decimal strings that only grow; compare as numbers
// without losing precision on ids past 2^53.
export function compareEventIds(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, ""), right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}
function stampOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Anything read back from disk is untrusted: the file is private but a
// truncated write or an older schema must not throw inside the collector.
export function normalizeGithubStore(raw: unknown): GithubStore {
  const store = emptyGithubStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return store;
  const source = raw as Record<string, unknown>;
  store.login = validGithubLogin(source.login);
  store.loginCheckedAt = finite(source.loginCheckedAt);
  store.attemptedAt = finite(source.attemptedAt);
  store.fetchedAt = finite(source.fetchedAt);
  store.okAt = finite(source.okAt);
  store.commitsAt = finite(source.commitsAt);
  store.reconciledAt = finite(source.reconciledAt);
  store.failCount = Math.min(16, Math.floor(finite(source.failCount)));
  store.coveredFrom = finite(source.coveredFrom);
  store.newestEventId = validEventId(source.newestEventId);
  store.error = typeof source.error === "string" ? source.error.slice(0, 120) : "";
  store.forward = normalizeWalk(source.forward);
  store.backfill = normalizeWalk(source.backfill);
  const commits = source.commits && typeof source.commits === "object" && !Array.isArray(source.commits) ? source.commits as Record<string, unknown> : {};
  for (const [sha, row] of Object.entries(commits).slice(0, MAX_STORE_ROWS)) {
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !Array.isArray(row)) continue;
    const ts = finite(row[0]), repo = validGithubRepo(row[1]);
    if (ts && repo) store.commits[sha] = [ts, repo];
  }
  const events = source.events && typeof source.events === "object" && !Array.isArray(source.events) ? source.events as Record<string, unknown> : {};
  for (const [id, row] of Object.entries(events).slice(0, MAX_STORE_ROWS)) {
    if (!validEventId(id) || !Array.isArray(row)) continue;
    const ts = finite(row[0]), kind = String(row[1] || ""), repo = validGithubRepo(row[2]);
    if (ts && repo && (GITHUB_KINDS as readonly string[]).includes(kind) && kind !== "commit") store.events[id] = [ts, kind as GithubKind, repo];
  }
  return store;
}

function normalizeWalk(raw: unknown): GithubWalk | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const walk = raw as Record<string, unknown>;
  const from = finite(walk.from), to = finite(walk.to), end = Math.max(to, finite(walk.end)), page = Math.floor(finite(walk.page)), fetched = Math.floor(finite(walk.fetched));
  return from && to && to > from && page >= 1 && page <= GITHUB_SEARCH_MAX_PAGES ? { from, to, end, page, fetched: Math.max(0, fetched) } : null;
}

// The collector's general JSON reader rejects any collection over 2048
// entries — right for hostile inputs, wrong for our own store, which holds
// one entry per commit of the week. The store is flat and every row is
// validated above, so parse it here under a byte cap instead.
export function parseGithubStoreText(text: string | null | undefined): GithubStore {
  if (typeof text !== "string" || !text || text.length > GITHUB_STORE_MAX_BYTES) return emptyGithubStore();
  try { return normalizeGithubStore(JSON.parse(text)); } catch { return emptyGithubStore(); }
}

// PushEvent is deliberately "": commits are counted from search, one row per
// commit, and counting the push as well would show the same work twice.
export function githubEventKind(type: unknown): GithubKind | "" {
  switch (String(type || "")) {
    case "PushEvent": return "";
    case "PullRequestEvent": return "pr";
    case "PullRequestReviewEvent":
    case "PullRequestReviewCommentEvent":
    case "PullRequestReviewThreadEvent": return "review";
    case "IssuesEvent": return "issue";
    case "IssueCommentEvent":
    case "CommitCommentEvent":
    case "DiscussionCommentEvent": return "comment";
    case "CreateEvent":
    case "DeleteEvent":
    case "ForkEvent":
    case "GollumEvent":
    case "MemberEvent":
    case "PublicEvent":
    case "ReleaseEvent":
    case "SponsorshipEvent":
    case "WatchEvent":
    case "DiscussionEvent": return "other";
    default: return "";
  }
}

export function githubKindLabel(kind: string): string {
  switch (kind) {
    case "commit": return "commits";
    case "pr": return "PRs";
    case "review": return "reviews";
    case "issue": return "issues";
    case "comment": return "comments";
    case "other": return "other";
    default: return kind;
  }
}

export type GithubEventItem = { id: string; ts: number; kind: GithubKind | ""; repo: string };
// Output of: gh api /users/<login>/events --jq '[.[] | {id, type, ts: .created_at, repo: .repo.name}]'
// Rows of every type come back (kind "" for pushes and unknown types) so the
// caller can track the newest id seen; only rows with a kind are stored.
// Returns null when the text is not an event page at all.
export function parseGithubEvents(text: string): GithubEventItem[] | null {
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const result: GithubEventItem[] = [];
  for (const row of rows.slice(0, 1000)) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const id = validEventId(entry.id), ts = stampOf(entry.ts), repo = validGithubRepo(entry.repo);
    if (!id || !ts || !repo) continue;
    result.push({ id, ts, kind: githubEventKind(entry.type), repo });
  }
  return result;
}

export type GithubCommitPage = { total: number; incomplete: boolean; items: Array<{ sha: string; ts: number; repo: string }> };
// Output of: gh api search/commits ... --jq '{total: .total_count, incomplete: .incomplete_results, items: [...]}'
export function parseGithubCommits(text: string): GithubCommitPage | null {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const total = Number(source.total);
  if (!Number.isFinite(total) || total < 0 || !Array.isArray(source.items)) return null;
  const items: GithubCommitPage["items"] = [];
  for (const row of source.items.slice(0, 1000)) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const sha = String(entry.sha ?? "").toLowerCase();
    const ts = stampOf(entry.ts), repo = validGithubRepo(entry.repo);
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !ts || !repo) continue;
    items.push({ sha, ts, repo });
  }
  return { total: Math.floor(total), incomplete: source.incomplete === true, items };
}

export function githubWindowStart(now: number): number { return now - GITHUB_WINDOW_MS; }

export function githubCoverageComplete(store: GithubStore, now: number): boolean {
  return store.commitsAt > 0 && store.coveredFrom > 0 && store.coveredFrom <= githubWindowStart(now);
}

// Throttling is keyed on the last attempt, not the last success, so a broken
// feed retries at one, two, four, then five minutes instead of every tick.
// While a walk is mid-way, or the window is not yet covered, steps come every
// minute; a settled store refreshes every five.
export function githubRefreshInterval(store: GithubStore, now: number): number {
  if (store.error) return Math.min(GITHUB_REFRESH_MS, GITHUB_BACKFILL_MS * Math.pow(2, Math.min(store.failCount, 8)));
  return !store.forward && !store.backfill && githubCoverageComplete(store, now) ? GITHUB_REFRESH_MS : GITHUB_BACKFILL_MS;
}
export function githubRefreshDue(store: GithubStore, now: number): boolean {
  const last = Math.max(store.attemptedAt, store.fetchedAt);
  if (!(last > 0) || last > now) return true;
  return now - last >= githubRefreshInterval(store, now);
}

export function pruneGithubStore(store: GithubStore, now: number): GithubStore {
  const floor = githubWindowStart(now), ceiling = now + 3_600_000;
  for (const [sha, row] of Object.entries(store.commits)) if (row[0] < floor || row[0] > ceiling) delete store.commits[sha];
  for (const [id, row] of Object.entries(store.events)) if (row[0] < floor || row[0] > ceiling) delete store.events[id];
  if (store.coveredFrom > 0 && store.coveredFrom < floor) store.coveredFrom = floor;
  if (store.backfill && store.backfill.to <= floor) store.backfill = null;
  if (store.forward && store.forward.to <= floor) store.forward = null;
  return store;
}

// Cells mirror the prompt heatmap: [total, byKind, byRepo], oldest day first,
// local wall-clock hours. `cellIndex` is the collector's activityCellIndex so
// both panels agree about DST days.
export function githubCells(store: GithubStore, dayStarts: number[], cellIndex: (ts: number, days: number[]) => number): Array<[number, Record<string, number>, Record<string, number>]> {
  const cells: Array<[number, Record<string, number>, Record<string, number>]> = [];
  for (let i = 0; i < 168; i++) cells.push([0, {}, {}]);
  const add = (ts: number, kind: string, repo: string) => {
    const index = cellIndex(ts, dayStarts);
    if (index < 0 || index >= 168) return;
    const cell = cells[index];
    cell[0]++;
    cell[1][kind] = (cell[1][kind] || 0) + 1;
    cell[2][repo] = (cell[2][repo] || 0) + 1;
  };
  for (const row of Object.values(store.commits)) add(row[0], "commit", row[1]);
  for (const row of Object.values(store.events)) add(row[0], row[1], row[2]);
  return cells;
}

export function githubCounts(store: GithubStore, todayStart: number, weekStart: number): Record<string, { today: number; week: number }> {
  const counts: Record<string, { today: number; week: number }> = {};
  const bump = (ts: number, kind: string) => {
    if (ts < weekStart) return;
    const entry = counts[kind] || (counts[kind] = { today: 0, week: 0 });
    entry.week++;
    if (ts >= todayStart) entry.today++;
  };
  for (const row of Object.values(store.commits)) bump(row[0], "commit");
  for (const row of Object.values(store.events)) bump(row[0], row[1]);
  return counts;
}

function isoStamp(ts: number): string { return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z"); }

export function githubSearchQuery(login: string, from: number, to: number): string {
  return `author:${login} author-date:${isoStamp(from)}..${isoStamp(to)}`;
}

type CommitFetch = {
  items: GithubCommitPage["items"];
  total: number;
  received: number;     // rows in the pages read this call
  pagesRead: number;    // consecutive pages consumed, starting at firstPage
  ended: boolean;       // a short page was seen: nothing follows
  reliable: boolean;    // every requested page parsed and GitHub did not flag incomplete results
};
async function fetchCommitRange(run: GithubRunner, login: string, from: number, to: number, firstPage: number, pages: number): Promise<CommitFetch | null> {
  if (to <= from) return { items: [], total: 0, received: 0, pagesRead: 0, ended: true, reliable: true };
  const query = githubSearchQuery(login, from, to);
  const outputs = await Promise.all(Array.from({ length: pages }, (_, index) => run([
    "gh", "api", "-X", "GET", "search/commits",
    "-f", `q=${query}`, "-F", `per_page=${GITHUB_PAGE_SIZE}`, "-F", `page=${firstPage + index}`,
    "-F", "sort=author-date", "-F", "order=desc",
    "--jq", "{total: .total_count, incomplete: .incomplete_results, items: [.items[] | {sha, ts: .commit.author.date, repo: .repository.full_name}]}",
  ], GITHUB_COMMAND_TIMEOUT_MS)));
  const first = parseGithubCommits(outputs[0]);
  if (!first) return null;
  // A page GitHub flags as incomplete (search timed out) still yields rows
  // worth keeping, but it is not consumed: the walk asks for it again.
  const result: CommitFetch = { items: first.items.slice(), total: first.total, received: 0, pagesRead: 0, ended: false, reliable: !first.incomplete };
  if (first.incomplete) return result;
  result.received = first.items.length; result.pagesRead = 1; result.ended = first.items.length < GITHUB_PAGE_SIZE;
  for (let index = 1; index < outputs.length && !result.ended; index++) {
    // A later page is only meaningful when the previous one was full; a page
    // that failed to arrive must not be mistaken for the end of the results.
    const page = parseGithubCommits(outputs[index]);
    if (!page) { result.reliable = false; break; }
    result.items.push(...page.items);
    if (page.incomplete) { result.reliable = false; break; }
    result.received += page.items.length;
    result.pagesRead++;
    result.ended = page.items.length < GITHUB_PAGE_SIZE;
  }
  return result;
}

type EventFetch = { rows: GithubEventItem[]; failed: boolean; newestId: string };
// Pages are read in order until one holds an id we already know (or is
// short), so nothing between two refreshes is skipped and a quiet account
// costs one call.
async function fetchEvents(run: GithubRunner, login: string, newestKnownId: string, maxPages: number): Promise<EventFetch> {
  const result: EventFetch = { rows: [], failed: false, newestId: newestKnownId };
  for (let page = 1; page <= maxPages; page++) {
    const output = await run([
      "gh", "api", "-X", "GET", `/users/${login}/events`,
      "-F", `per_page=${GITHUB_PAGE_SIZE}`, "-F", `page=${page}`,
      "--jq", "[.[] | {id, type, ts: .created_at, repo: .repo.name}]",
    ], GITHUB_COMMAND_TIMEOUT_MS);
    const rows = parseGithubEvents(output);
    if (rows === null) { result.failed = true; break; }
    let reachedKnown = false;
    for (const row of rows) {
      if (newestKnownId && compareEventIds(row.id, newestKnownId) <= 0) { reachedKnown = true; continue; }
      result.rows.push(row);
      if (!result.newestId || compareEventIds(row.id, result.newestId) > 0) result.newestId = row.id;
    }
    if (reachedKnown || rows.length < GITHUB_PAGE_SIZE) break;
  }
  return result;
}

function resetGithubRows(store: GithubStore): void {
  store.commits = {}; store.events = {};
  store.coveredFrom = 0; store.forward = null; store.backfill = null; store.newestEventId = "";
  store.commitsAt = 0; store.fetchedAt = 0; store.okAt = 0; store.reconciledAt = 0;
}

function oldestOf(items: Array<{ ts: number }>, fallback: number): number {
  return items.reduce((min, row) => Math.min(min, row.ts), fallback);
}

// One refresh step. Never throws; a failed feed leaves the previous rows in
// place and records a short reason. `store` is mutated and returned.
export async function refreshGithubActivity(store: GithubStore, now: number, run: GithubRunner, ghAvailable = true): Promise<GithubStore> {
  store.attemptedAt = now;
  const fail = (message: string) => { store.error = message; store.failCount = Math.min(16, store.failCount + 1); return store; };
  if (!ghAvailable) return fail("gh not installed");
  if (!store.login || now - store.loginCheckedAt >= GITHUB_LOGIN_TTL_MS || store.loginCheckedAt > now) {
    const login = validGithubLogin(await run(["gh", "api", "user", "--jq", ".login"], GITHUB_COMMAND_TIMEOUT_MS));
    if (login) {
      // Another account's history must not be shown under this login.
      if (store.login && store.login !== login) resetGithubRows(store);
      store.login = login; store.loginCheckedAt = now;
    } else if (!store.login) return fail("gh not authenticated");
  }
  const windowStart = githubWindowStart(now);
  const firstFill = !(store.commitsAt > 0);
  // Periodically forget coverage so late-indexed commits (merged days after
  // they were authored) are picked up by a fresh walk of the window.
  if (firstFill || !(store.reconciledAt > 0)) store.reconciledAt = now;
  else if (now - store.reconciledAt >= GITHUB_RECONCILE_MS) { store.reconciledAt = now; store.coveredFrom = store.commitsAt; store.backfill = null; }

  if (!store.forward) {
    const from = firstFill ? windowStart : Math.max(windowStart, store.commitsAt - GITHUB_FORWARD_OVERLAP_MS);
    store.forward = { from, to: now, end: now, page: 1, fetched: 0 };
  }
  if (!store.backfill && !firstFill && store.coveredFrom > windowStart) store.backfill = { from: windowStart, to: store.coveredFrom, end: store.coveredFrom, page: 1, fetched: 0 };
  const forwardWalk = store.forward, backfillWalk = store.backfill;
  const [events, forward, backward] = await Promise.all([
    fetchEvents(run, store.login, store.newestEventId, GITHUB_EVENT_MAX_PAGES),
    fetchCommitRange(run, store.login, forwardWalk.from, forwardWalk.to, forwardWalk.page, GITHUB_PAGES_PER_FETCH),
    backfillWalk ? fetchCommitRange(run, store.login, backfillWalk.from, backfillWalk.to, backfillWalk.page, GITHUB_PAGES_PER_FETCH) : Promise.resolve(null),
  ]);
  const failures: string[] = [];

  for (const row of events.rows) if (row.kind) store.events[row.id] = [row.ts, row.kind, row.repo];
  if (events.failed) failures.push("events");
  else store.newestEventId = events.newestId;

  if (forward) {
    for (const row of forward.items) store.commits[row.sha] = [row.ts, row.repo];
    if (advanceWalk(forwardWalk, forward)) {
      // [from, end] is complete and from lies inside the previous coverage, so
      // the covered span now reaches end.
      const previous = store.coveredFrom > 0 ? store.coveredFrom : Number.POSITIVE_INFINITY;
      store.coveredFrom = Math.min(previous, forwardWalk.from);
      store.commitsAt = forwardWalk.end;
      store.forward = null;
    }
  } else failures.push("commits");

  if (backfillWalk) {
    if (!backward) failures.push("backfill");
    else {
      for (const row of backward.items) store.commits[row.sha] = [row.ts, row.repo];
      if (advanceWalk(backfillWalk, backward)) {
        store.coveredFrom = Math.min(store.coveredFrom, backfillWalk.from);
        store.backfill = null;
      }
    }
  }

  if (!events.failed || forward) store.fetchedAt = now;
  if (failures.length) { store.error = `${failures.join("+")} fetch failed`; store.failCount = Math.min(16, store.failCount + 1); }
  else { store.error = ""; store.failCount = 0; store.okAt = now; }
  pruneGithubStore(store, now);
  return store;
}

// Folds one fetch into a walk. Returns true when the walk's whole [from, end]
// range has been read. A walk that passes GitHub's 1000-row cap restarts as a
// new query beneath the oldest row it has, so no range is ever given up on.
function advanceWalk(walk: GithubWalk, fetch: CommitFetch): boolean {
  walk.fetched += fetch.received;
  if (fetch.reliable && (fetch.ended || walk.fetched >= fetch.total)) return true;
  if (fetch.pagesRead === 0) return false;   // nothing consumed; the same pages are retried next step
  const nextPage = walk.page + fetch.pagesRead;
  if (nextPage <= GITHUB_SEARCH_MAX_PAGES) { walk.page = nextPage; return false; }
  const oldest = oldestOf(fetch.items, walk.to);
  // Ties at the boundary would repeat the same query forever; give up one second of them instead.
  walk.to = oldest < walk.to ? oldest : walk.to - 1000;
  walk.page = 1; walk.fetched = 0;
  return walk.to <= walk.from;
}

export function githubSnapshot(store: GithubStore, now: number, dayStarts: number[], cellIndex: (ts: number, days: number[]) => number, ghAvailable: boolean) {
  const todayStart = dayStarts[6] || now, weekStart = dayStarts[0] || githubWindowStart(now);
  const hasData = Object.keys(store.commits).length + Object.keys(store.events).length > 0;
  let state = "ok";
  if (!ghAvailable) state = "missing";
  else if (!store.login) state = "unauthenticated";
  else if (!(store.fetchedAt > 0)) state = store.error && !hasData ? "unavailable" : "pending";
  else if (store.error && !(store.okAt > 0 && now >= store.okAt && now - store.okAt < GITHUB_STALE_AFTER_MS)) state = hasData ? "stale" : "unavailable";
  return {
    state,
    login: store.login,
    fetchedAt: store.fetchedAt,
    coverage: githubCoverageComplete(store, now) ? "complete" : "partial",
    coveredFrom: store.coveredFrom,
    error: store.error,
    days: dayStarts,
    cells: githubCells(store, dayStarts, cellIndex),
    counts: githubCounts(store, todayStart, weekStart),
  };
}
