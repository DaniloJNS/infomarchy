// GitHub inbox for the GITHUB · YOU card: the three lists that answer "what is
// waiting on me right now" — my open pull requests, the reviews I owe someone
// else, and my unread notifications.
//
// Two calls per refresh, issued in parallel, both through the already
// authenticated `gh` CLI and both slimmed by gh's own --jq so the collector
// never parses a pull request body:
//
//   * graphql  — `viewer.pullRequests(states: OPEN)` and a
//     `search(review-requested:@me)` in a single document (~1.3 s measured).
//     OPEN already includes drafts on GitHub, so nothing is filtered out here;
//     `isDraft` is carried through and the card labels it instead. The last
//     commit's `statusCheckRollup` is the CI verdict, and it is null both for a
//     PR no workflow has run on and for one whose checks have not reported, so
//     a missing rollup is "no CI", never a failure. `viewer.login` rides along
//     for free, which is what identifies the account the rows belong to — no
//     separate `gh api user` call is needed while the query succeeds.
//   * /notifications — unread, non-participating-filtered, one page (~0.6 s).
//     `subject.url` is null for whole classes of notification (CheckSuite is
//     the common one: a failed workflow run has no single API object), so the
//     row falls back to the repository page. When it is present it is an API
//     URL and has to be rewritten to the web one, or the click opens JSON.
//
// The three lists are cached whole in a private state file shared by the
// wallpaper and overlay collectors — they are a snapshot, not an accumulation,
// so a refresh replaces them rather than merging. Only one instance (the
// wallpaper) writes; the overlay reads the same file, so summoning the overlay
// costs no API calls. Every attempt is stamped, so a failing feed backs off
// instead of retrying on every tick.
//
// Read-only by design. Nothing here marks a notification read, requests a
// review or posts a comment; the card is ambient, and acting on any of it
// happens in the browser or in the bar's own GitHub plugin.

import { GITHUB_BACKFILL_MS, GITHUB_REFRESH_MS, GITHUB_STALE_AFTER_MS, validGithubLogin, validGithubRepo } from "./github-activity";

// The heatmap's 4 s budget is too tight here: the same GraphQL document
// measured 1.3 s warm but GitHub's search backend has been seen past 3 s, and
// a timeout costs a whole refresh interval rather than one page of a walk.
export const INBOX_COMMAND_TIMEOUT_MS = 6000;
export const INBOX_MAX_ITEMS = 20;
export const INBOX_NOTIFICATION_PAGE = 50;
export const INBOX_STORE_MAX_BYTES = 512 * 1024;
const MAX_TITLE = 200;
const MAX_URL = 400;
const MAX_REASON = 32;

// A leading issue key, as every tracker writes it: "[ABC-123] title",
// "ABC-123: title", "(ABC-123) title". Kept generic on purpose — the card
// shows whatever project prefix this account happens to use, and hardcoding
// one team's would make the card lie for every other repository.
const TICKET_RE = /^\s*[[(]?([A-Z][A-Z0-9]{1,14}-\d{1,7})[\])]?\s*[:–—-]?\s*/;

export type InboxPr = {
  number: number;
  title: string;
  ticket: string;
  isDraft: boolean;
  ts: number;
  url: string;
  repo: string;
  review: string;    // GitHub's reviewDecision, "" when it has none
  ci: string;        // statusCheckRollup state, "" when there is no rollup
};
export type InboxReview = {
  number: number;
  title: string;
  ticket: string;
  ts: number;
  url: string;
  repo: string;
  author: string;
};
export type InboxNotification = {
  id: string;
  reason: string;
  title: string;
  ts: number;
  url: string;
  repo: string;
};
export type InboxStore = {
  login: string;
  attemptedAt: number;   // last refresh attempt, success or not — drives throttling
  fetchedAt: number;     // last refresh where at least one call succeeded
  okAt: number;          // last refresh with no failures
  failCount: number;
  prs: InboxPr[];
  reviews: InboxReview[];
  notifications: InboxNotification[];
  prsTotal: number;          // GitHub's own count, which can exceed INBOX_MAX_ITEMS
  reviewsTotal: number;
  notificationsTotal: number;
  error: string;
};
export type InboxRunner = (cmd: string[], timeoutMs: number) => Promise<string>;

export function emptyInboxStore(): InboxStore {
  return {
    login: "", attemptedAt: 0, fetchedAt: 0, okAt: 0, failCount: 0,
    prs: [], reviews: [], notifications: [], prsTotal: 0, reviewsTotal: 0, notificationsTotal: 0, error: "",
  };
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
function stampOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
// Titles reach a Text element, never a shell or a URL. Objects and arrays from
// external JSON are not text: "[object Object]" on a card is a bug. Control
// characters would break the single-line elide the card relies on.
function uiText(value: unknown, limit: number): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
function positiveInt(value: unknown, limit: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= limit ? number : 0;
}

// Every URL here is handed to a browser by InfoModel.openUrl, which re-checks
// the prefix. Validate the whole shape anyway: only https, only github.com,
// and only the characters a GitHub path can hold — never a scheme, a
// credential, a redirect or whitespace smuggled in through a title.
export function validGithubUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (!url || url.length > MAX_URL) return "";
  return /^https:\/\/github\.com\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(url) ? url : "";
}

// /notifications carries an API URL, which opens JSON in a browser instead of
// a page. Only the two subject kinds with an obvious web equivalent are
// rewritten; anything else (CheckSuite, Release, Discussion, a null url) lands
// on the repository, which is always better than a dead click.
export function notificationWebUrl(subjectUrl: unknown, repoUrl: unknown): string {
  const api = typeof subjectUrl === "string" ? subjectUrl.trim() : "";
  const match = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/(pulls|issues)\/(\d{1,12})$/.exec(api);
  if (match) return `https://github.com/${match[1]}/${match[2]}/${match[3] === "pulls" ? "pull" : "issues"}/${match[4]}`;
  // Already a web URL (a future API shape, or a hand-written store) is kept.
  return validGithubUrl(api) || validGithubUrl(repoUrl);
}

// The ticket becomes its own Tag and the title loses the prefix, so the card
// spends its width on words instead of repeating the key. A title that is
// nothing but a key keeps it as the text — an empty row is unreadable.
export function splitTicket(raw: unknown): { ticket: string; title: string } {
  const text = uiText(raw, MAX_TITLE);
  const match = TICKET_RE.exec(text);
  if (!match) return { ticket: "", title: text };
  const title = text.slice(match[0].length).trim();
  return title ? { ticket: match[1], title } : { ticket: "", title: text };
}

// Short enough to sit in a Tag beside the repository name. GitHub's reason
// slugs are a closed set; an unknown one is shown as its own slug rather than
// hidden, so a new reason is legible the day GitHub adds it.
export function notificationReasonLabel(reason: unknown): string {
  // Only a string is a reason. String({}) is "[object Object]", which the
  // fallback below would happily render as "OBJECTOBJE" on the card.
  if (typeof reason !== "string") return "NOTICE";
  switch (reason) {
    case "approval_requested": return "APPROVAL";
    case "assign": return "ASSIGN";
    case "author": return "AUTHOR";
    case "ci_activity": return "CI";
    case "comment": return "COMMENT";
    case "invitation": return "INVITE";
    case "manual": return "MANUAL";
    case "member_feature_requested": return "FEATURE";
    case "mention": return "MENTION";
    case "review_requested": return "REVIEW";
    case "security_advisory_credit":
    case "security_alert": return "SECURITY";
    case "state_change": return "STATE";
    case "subscribed": return "WATCH";
    case "team_mention": return "TEAM";
    default: {
      const slug = reason.replace(/[^a-z_]/gi, "").slice(0, 10);
      return slug ? slug.toUpperCase().replace(/_/g, " ").trim() : "NOTICE";
    }
  }
}

const REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"];
const CI_STATES = ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"];
function oneOf(value: unknown, allowed: string[]): string {
  const text = String(value ?? "").toUpperCase();
  return allowed.includes(text) ? text : "";
}
function newestFirst<T extends { ts: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.ts - a.ts).slice(0, INBOX_MAX_ITEMS);
}

// ---------------------------------------------------------------- parsing

function inboxPr(raw: unknown): InboxPr | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const number = positiveInt(source.number, 9_999_999), repo = validGithubRepo(source.repo), ts = stampOf(source.ts);
  if (!number || !repo || !ts) return null;
  // A row read back from disk already had its title stripped, so the ticket
  // cannot be re-derived from it — keep the stored key when it is one, and
  // only split the title for a row that came straight from the API.
  const split = splitTicket(source.title);
  const stored = typeof source.ticket === "string" ? source.ticket.trim() : "";
  const ticket = /^[A-Z][A-Z0-9]{1,14}-\d{1,7}$/.test(stored) ? stored : split.ticket;
  return {
    number, repo, ts, ticket, title: split.title,
    isDraft: source.isDraft === true,
    url: validGithubUrl(source.url) || `https://github.com/${repo}/pull/${number}`,
    review: oneOf(source.review, REVIEW_DECISIONS),
    ci: oneOf(source.ci, CI_STATES),
  };
}
function inboxReview(raw: unknown): InboxReview | null {
  const pr = inboxPr(raw);
  if (!pr) return null;
  const source = raw as Record<string, unknown>;
  return { number: pr.number, title: pr.title, ticket: pr.ticket, ts: pr.ts, url: pr.url, repo: pr.repo, author: validGithubLogin(source.author) };
}
function inboxNotification(raw: unknown): InboxNotification | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = /^[0-9]{1,24}$/.test(String(source.id ?? "")) ? String(source.id) : "";
  const repo = validGithubRepo(source.repo), ts = stampOf(source.ts);
  if (!id || !repo || !ts) return null;
  const url = notificationWebUrl(source.subjectUrl ?? source.url, source.repoUrl ?? `https://github.com/${repo}`);
  return {
    id, repo, ts, url,
    reason: uiText(source.reason, MAX_REASON),
    title: uiText(source.title, MAX_TITLE),
  };
}

export type InboxGraphql = { prs: InboxPr[]; reviews: InboxReview[]; prsTotal: number; reviewsTotal: number; login: string };
// Output of the graphql document in INBOX_GRAPHQL_QUERY, already reshaped by
// --jq. Returns null when the text is not that payload at all, which is what
// an unauthenticated or unreachable gh produces (run() returns "").
export function parseInboxGraphql(text: string): InboxGraphql | null {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  if (!Array.isArray(source.prs) || !Array.isArray(source.reviews)) return null;
  const prs: InboxPr[] = [], reviews: InboxReview[] = [];
  for (const row of source.prs.slice(0, 200)) { const pr = inboxPr(row); if (pr) prs.push(pr); }
  for (const row of source.reviews.slice(0, 200)) { const review = inboxReview(row); if (review) reviews.push(review); }
  return {
    prs: newestFirst(prs),
    reviews: newestFirst(reviews),
    // GitHub's totals are the honest count; the lists are capped for the card.
    prsTotal: Math.max(prs.length, Math.floor(finite(source.prsTotal))),
    reviewsTotal: Math.max(reviews.length, Math.floor(finite(source.reviewsTotal))),
    login: validGithubLogin(source.login),
  };
}

export type InboxNotifications = { rows: InboxNotification[]; total: number };
// Output of: gh api /notifications --jq '[.[] | {id, reason, ts, title, subjectUrl, repo, repoUrl}]'
export function parseInboxNotifications(text: string): InboxNotifications | null {
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const result: InboxNotification[] = [];
  for (const row of rows.slice(0, 200)) { const note = inboxNotification(row); if (note) result.push(note); }
  return { rows: newestFirst(result), total: result.length };
}

// ---------------------------------------------------------------- throttling

// Keyed on the last attempt, not the last success, so a broken feed retries at
// one, two, four minutes and then settles at the normal five rather than
// hammering gh on every tick. Cadence is the heatmap's: these lists change on
// human timescales, and both feeds sit in the same 5000/h core bucket.
export function inboxRefreshInterval(store: InboxStore): number {
  if (store.error) return Math.min(GITHUB_REFRESH_MS, GITHUB_BACKFILL_MS * Math.pow(2, Math.min(store.failCount, 8)));
  return GITHUB_REFRESH_MS;
}
export function inboxRefreshDue(store: InboxStore, now: number): boolean {
  const last = Math.max(store.attemptedAt, store.fetchedAt);
  if (!(last > 0) || last > now) return true;
  return now - last >= inboxRefreshInterval(store);
}

// ---------------------------------------------------------------- store I/O

// Anything read back from disk is untrusted: the file is private, but a
// truncated write, an older schema or a hand-edit must degrade to an empty
// store instead of throwing inside the collector or reaching the card.
export function normalizeInboxStore(raw: unknown): InboxStore {
  const store = emptyInboxStore();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return store;
  const source = raw as Record<string, unknown>;
  store.login = validGithubLogin(source.login);
  store.attemptedAt = finite(source.attemptedAt);
  store.fetchedAt = finite(source.fetchedAt);
  store.okAt = finite(source.okAt);
  store.failCount = Math.min(16, Math.floor(finite(source.failCount)));
  store.error = typeof source.error === "string" ? source.error.slice(0, 120) : "";
  const prs = Array.isArray(source.prs) ? source.prs : [];
  const reviews = Array.isArray(source.reviews) ? source.reviews : [];
  const notifications = Array.isArray(source.notifications) ? source.notifications : [];
  for (const row of prs.slice(0, INBOX_MAX_ITEMS)) { const pr = inboxPr(row); if (pr) store.prs.push(pr); }
  for (const row of reviews.slice(0, INBOX_MAX_ITEMS)) { const review = inboxReview(row); if (review) store.reviews.push(review); }
  for (const row of notifications.slice(0, INBOX_MAX_ITEMS)) { const note = inboxNotification(row); if (note) store.notifications.push(note); }
  store.prs = newestFirst(store.prs);
  store.reviews = newestFirst(store.reviews);
  store.notifications = newestFirst(store.notifications);
  store.prsTotal = Math.max(store.prs.length, Math.floor(finite(source.prsTotal)));
  store.reviewsTotal = Math.max(store.reviews.length, Math.floor(finite(source.reviewsTotal)));
  store.notificationsTotal = Math.max(store.notifications.length, Math.floor(finite(source.notificationsTotal)));
  return store;
}

// The collector's general JSON reader rejects any collection over 2048
// entries and any deep nesting — right for hostile inputs, wrong for our own
// store. This one is flat, capped at three short lists, and every field is
// validated above, so parse it here under a byte cap instead.
export function parseInboxStoreText(text: string | null | undefined): InboxStore {
  if (typeof text !== "string" || !text || text.length > INBOX_STORE_MAX_BYTES) return emptyInboxStore();
  try { return normalizeInboxStore(JSON.parse(text)); } catch { return emptyInboxStore(); }
}

// ---------------------------------------------------------------- fetching

// One document for both lists: two round trips would double the latency for
// data that is always read together. `states: OPEN` includes drafts — draft is
// a flag on an open PR, not a state of its own — so nothing is dropped here.
export const INBOX_GRAPHQL_QUERY = `
query {
  viewer {
    login
    pullRequests(states: OPEN, first: ${INBOX_MAX_ITEMS}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes { number title isDraft updatedAt url repository { nameWithOwner } reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
  reviews: search(query: "is:open is:pr review-requested:@me", type: ISSUE, first: ${INBOX_MAX_ITEMS}) {
    issueCount
    nodes { ... on PullRequest { number title isDraft updatedAt url repository { nameWithOwner } author { login } } }
  }
}`;

const INBOX_GRAPHQL_JQ = [
  "{login: .data.viewer.login,",
  "prsTotal: .data.viewer.pullRequests.totalCount,",
  "prs: [.data.viewer.pullRequests.nodes[] | {number, title, isDraft, ts: .updatedAt, url, repo: .repository.nameWithOwner, review: .reviewDecision, ci: .commits.nodes[0].commit.statusCheckRollup.state}],",
  "reviewsTotal: .data.reviews.issueCount,",
  "reviews: [.data.reviews.nodes[] | {number, title, isDraft, ts: .updatedAt, url, repo: .repository.nameWithOwner, author: .author.login}]}",
].join(" ");

const INBOX_NOTIFICATIONS_JQ =
  "[.[] | {id, reason, ts: .updated_at, title: .subject.title, subjectUrl: .subject.url, repo: .repository.full_name, repoUrl: .repository.html_url}]";

async function fetchInboxGraphql(run: InboxRunner): Promise<InboxGraphql | null> {
  return parseInboxGraphql(await run([
    "gh", "api", "graphql", "-f", `query=${INBOX_GRAPHQL_QUERY}`, "--jq", INBOX_GRAPHQL_JQ,
  ], INBOX_COMMAND_TIMEOUT_MS));
}
// Unread only, and not narrowed to threads this account has posted in:
// `participating=false` is GitHub's "do not filter", not "exclude me".
async function fetchInboxNotifications(run: InboxRunner): Promise<InboxNotifications | null> {
  return parseInboxNotifications(await run([
    "gh", "api", "-X", "GET", "/notifications",
    "-F", "all=false", "-F", "participating=false", "-F", `per_page=${INBOX_NOTIFICATION_PAGE}`,
    "--jq", INBOX_NOTIFICATIONS_JQ,
  ], INBOX_COMMAND_TIMEOUT_MS));
}

// One refresh. Never throws; a failed call leaves the previous rows in place
// and records a short reason, so the card keeps showing the last known inbox
// (marked stale) rather than emptying itself on one timed-out gh.
export async function refreshInbox(store: InboxStore, now: number, run: InboxRunner, ghAvailable = true): Promise<InboxStore> {
  store.attemptedAt = now;
  const fail = (message: string) => { store.error = message; store.failCount = Math.min(16, store.failCount + 1); return store; };
  if (!ghAvailable) return fail("gh not installed");

  const [graphql, notifications] = await Promise.all([fetchInboxGraphql(run), fetchInboxNotifications(run)]);
  const failures: string[] = [];

  if (graphql) {
    // Another account's notifications must never appear under this login; the
    // graphql lists are replaced wholesale below, so only the REST rows can be
    // left over from a previous account.
    if (graphql.login && store.login && graphql.login !== store.login) { store.notifications = []; store.notificationsTotal = 0; }
    if (graphql.login) store.login = graphql.login;
    store.prs = graphql.prs;
    store.reviews = graphql.reviews;
    store.prsTotal = graphql.prsTotal;
    store.reviewsTotal = graphql.reviewsTotal;
  } else failures.push("pull requests");

  if (notifications) {
    store.notifications = notifications.rows;
    store.notificationsTotal = notifications.total;
  } else failures.push("notifications");

  // Both calls failing on a store that never succeeded is the one case worth
  // one extra call: it separates "gh is not logged in" — which the user can
  // fix — from "GitHub is unreachable", which they cannot. While the graphql
  // document works, its own viewer.login answers this for free.
  if (failures.length === 2 && !store.login) {
    const login = validGithubLogin(await run(["gh", "api", "user", "--jq", ".login"], INBOX_COMMAND_TIMEOUT_MS));
    if (!login) return fail("gh not authenticated");
    store.login = login;
  }

  if (failures.length < 2) store.fetchedAt = now;
  if (failures.length) { store.error = `${failures.join("+")} fetch failed`; store.failCount = Math.min(16, store.failCount + 1); }
  else { store.error = ""; store.failCount = 0; store.okAt = now; }
  return store;
}

// ---------------------------------------------------------------- snapshot

export type InboxCounts = { open: number; draft: number; ciFail: number; unread: number; reviews: number };
export function inboxCounts(store: InboxStore): InboxCounts {
  return {
    open: store.prsTotal,
    draft: store.prs.filter(pr => pr.isDraft).length,
    ciFail: store.prs.filter(pr => pr.ci === "FAILURE" || pr.ci === "ERROR").length,
    unread: store.notificationsTotal,
    reviews: store.reviewsTotal,
  };
}

// Same states, in the same order of precedence, as githubSnapshot: the two
// GitHub cards must never disagree about whether gh works.
export function inboxSnapshot(store: InboxStore, now: number, ghAvailable: boolean) {
  const hasData = store.prs.length + store.reviews.length + store.notifications.length > 0;
  let state = "ok";
  if (!ghAvailable) state = "missing";
  else if (!store.login) state = store.error === "gh not authenticated" ? "unauthenticated" : "pending";
  else if (!(store.fetchedAt > 0)) state = store.error && !hasData ? "unavailable" : "pending";
  else if (store.error && !(store.okAt > 0 && now >= store.okAt && now - store.okAt < GITHUB_STALE_AFTER_MS)) state = hasData ? "stale" : "unavailable";
  return {
    state,
    login: store.login,
    fetchedAt: store.fetchedAt,
    error: store.error,
    prs: store.prs,
    reviews: store.reviews,
    notifications: store.notifications,
    counts: inboxCounts(store),
  };
}
