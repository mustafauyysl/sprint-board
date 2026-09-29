// Pure decision logic. No I/O here, no Date.now() — "now" is always a parameter,
// which is what makes all of it deterministically testable.

const MS_PER_DAY = 86400000;

/** Local calendar day as an integer (unaffected by DST). */
export function dayIndex(date) {
  const d = new Date(date);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY);
}

/** dayIndex -> weekday (0=Sunday ... 6=Saturday). 1970-01-01 was a Thursday. */
export function dowOf(dayIdx) {
  return (((dayIdx % 7) + 7) % 7 + 4) % 7;
}

const isWeekend = (dayIdx) => {
  const d = dowOf(dayIdx);
  return d === 0 || d === 6;
};

/**
 * Whole business days between from and to (exclusive of from, inclusive of to).
 * Work that entered review on Friday evening counts as 1 day old on Monday
 * morning — a weekend must not trip the "stuck" alarm.
 */
export function businessDaysBetween(from, to) {
  const a = dayIndex(from);
  const b = dayIndex(to);
  if (b <= a) return 0;

  const total = b - a;
  const fullWeeks = Math.floor(total / 7);
  let count = fullWeeks * 5;
  for (let i = fullWeeks * 7 + 1; i <= total; i++) {
    if (!isWeekend(a + i)) count++;
  }
  return count;
}

/**
 * When the CURRENT owner's clock starts, or null when the changelog shows no
 * such moment.
 *
 * A ticket that sat unassigned in To Do for 23 days and was pulled into this
 * sprint today is NOT 23 days of this person's delay — it was nobody's. The
 * clock must start at the later of "assigned to me" and "added to this sprint".
 * Both events are already in the changelog we fetch for the status timestamp,
 * so this costs no extra request.
 *
 * Returns null for the common case (created already assigned and in the sprint):
 * the caller then keeps the plain status timestamp.
 */
export function ownershipStartedAt(histories, opts = {}) {
  const { accountId, sprintFieldId, sprintId } = opts;
  let latest = null;
  const bump = (at) => {
    const t = new Date(at);
    if (!Number.isNaN(t.getTime()) && (!latest || t > latest)) latest = t;
  };

  // Jira writes sprint membership as a COMMA-SEPARATED id list, not one id: a
  // ticket moved from sprint 4 to 5 reads from "4" to "5", and one added to a
  // second board reads from "4" to "4,5". Only an id that is in `to` and NOT in
  // `from` is an actual entry into that sprint.
  const idSet = (raw) =>
    new Set(String(raw ?? "").split(",").map((x) => x.trim()).filter(Boolean));

  for (const h of histories ?? []) {
    for (const item of h?.items ?? []) {
      if (!item) continue;
      const field = item.fieldId || item.field;
      if (accountId && field === "assignee" && item.to === accountId) bump(h.created);
      if (sprintId != null && (field === sprintFieldId || item.field === "Sprint")) {
        const id = String(sprintId);
        if (idSet(item.to).has(id) && !idSet(item.from).has(id)) bump(h.created);
      }
    }
  }
  return latest;
}

/**
 * Measures time-in-status against the threshold.
 * Exactly at the boundary (days === threshold) it does NOT fire yet — the
 * threshold means "a problem once this is exceeded".
 */
export function evaluate(status, daysInStatus, config) {
  const threshold = config.thresholds?.[status] ?? config.defaultThresholdDays;
  const alert = daysInStatus > threshold;
  // A threshold of 0 ("zero tolerance") is a valid setting; without clamping the
  // denominator to 1 the ratio would be 0 and both boss ranking and the critical
  // tier would silently collapse.
  const ratio = daysInStatus / Math.max(threshold, 1);
  const tier = !alert ? "ok" : ratio >= 2 ? "critical" : "warn";
  return { threshold, alert, ratio, tier };
}

/**
 * Boss = the task exceeding its threshold by the largest RATIO, not by the most
 * days: something sitting 4 days in code review (threshold 2, ratio 2.0) is more
 * urgent than something sitting 8 days in To Do (threshold 7, ratio 1.14).
 */
export function pickBoss(tasks) {
  const candidates = tasks.filter((t) => t.alert && !t.done);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, t) => {
    if (t.ratio !== best.ratio) return t.ratio > best.ratio ? t : best;
    return t.daysInStatus > best.daysInStatus ? t : best;
  });
}

/**
 * An issue's sprint history. Jira's sprint field returns an ARRAY and closed
 * sprints stay in it — that is how we detect carried-over work, no extra query.
 *
 * "future" sprints do not count: being placed in a plan that has not started
 * yet is not the same as carrying work over.
 */
export function sprintHistory(sprints) {
  const list = Array.isArray(sprints) ? sprints : [];
  const closed = list.filter((s) => s && s.state === "closed").length;
  const hasActive = list.some((s) => s && s.state === "active");
  return {
    carriedOver: closed > 0,
    closedSprints: closed,
    sprintCount: closed + (hasActive ? 1 : 0),
  };
}

/** Number of lightning bolts (1–5) based on how far past the threshold. */
export function bolts(ratio) {
  return Math.max(1, Math.min(5, Math.floor(ratio)));
}

/** Extracts the Jira key from a PR title ("DEMO-101 | Template gate" -> "DEMO-101"). */
export function extractIssueKey(title) {
  const m = String(title || "").match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

// Worst wins: if any of a task's PRs is broken, the badge must look broken.
const CI_RANK = { FAILURE: 3, ERROR: 3, PENDING: 2, EXPECTED: 2, SUCCESS: 1 };

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const WAITING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"]);

/**
 * Summarises a PR's status from its REQUIRED checks only.
 *
 * GitHub's statusCheckRollup.state counts optional checks too, so a Jest/lint
 * failure that never blocks the merge showed up as "FAILURE" (confirmed on three
 * PRs). What actually blocks a merge is the required checks, hence this filter.
 */
export function requiredRollup(contexts) {
  const required = (contexts || []).filter((c) => c && c.isRequired);

  // For re-run checks GitHub keeps BOTH the old and the new run in the list
  // (measured live: the same check appeared once CANCELLED and once SUCCESS).
  // Only the latest run counts — otherwise a cancelled old run looks "broken".
  const latest = new Map();
  for (const c of required) {
    const name = c.name || c.context || "?";
    const at = c.completedAt || c.startedAt || c.createdAt || null;
    const prev = latest.get(name);
    if (!prev) { latest.set(name, { c, at }); continue; }
    // Prefer timestamps when present; otherwise treat later-in-list as newer.
    if (!prev.at || (at && at >= prev.at)) latest.set(name, { c, at });
  }

  const failing = [];
  const pending = [];
  let rank = 0;

  for (const { c } of latest.values()) {
    const s = c.conclusion || c.state || null;
    const name = c.name || c.context || "?";
    if (FAILED.has(s)) {
      failing.push(name);
      rank = Math.max(rank, 3);
    } else if (WAITING.has(s) || s === null) {
      pending.push(name);
      rank = Math.max(rank, 2);
    } else {
      rank = Math.max(rank, 1);
    }
  }

  // With no required checks at all the state is unknown — it raises no warning.
  const state = rank === 3 ? "FAILURE" : rank === 2 ? "PENDING" : rank === 1 ? "SUCCESS" : null;
  return { state, failing, pending, requiredCount: latest.size };
}

/**
 * Statuses that ARE in the done category but have not shipped yet — an allow list.
 *
 * Why an allow list: the inverse (a list of "finished" statuses) left every
 * unrecognised status showing as "pending" forever. This Jira has 15 statuses in
 * the done category and six of them (Closed, Resolved, Problem Solved, Epic is
 * Done, Question, Unresolved) were misclassified that way. An unrecognised status
 * now falls through to "finished" — it stays quiet instead of producing permanent
 * noise.
 */
export const DEFAULT_PENDING_RELEASE_STATUSES = [
  "Ready For Release", "Awaiting Release", "Pending for Release",
  "Waiting for Release", "Waiting for SDK Release",
];

/** Falls back to the default when the configured list is malformed (not an array). */
export function pendingReleaseStatuses(config) {
  const c = config && config.pendingReleaseStatuses;
  return Array.isArray(c) ? c : DEFAULT_PENDING_RELEASE_STATUSES;
}

/**
 * Splits a done-category status three ways: finished / cancelled / waiting to ship.
 *
 * An unknown status counts as "finished" (fail-closed) — see the allow list above.
 */
export function releaseState(status, config) {
  const raw = typeof status === "string" ? status.trim() : "";
  if (/reject|cancel/i.test(raw)) return "cancelled";

  const norm = raw.toLowerCase();
  return pendingReleaseStatuses(config)
    .some((s) => String(s).trim().toLowerCase() === norm) ? "pending" : "finished";
}

/**
 * Everything keeping a PR from being merged — CI *and* code review together.
 *
 * Looking at CI alone was misleading: even with every required check green, a PR
 * awaiting review approval cannot be merged. rank 3 = action needed,
 * 2 = waiting, 0 = nothing blocking.
 */
export function prBlockers(pr) {
  const reasons = [];
  let rank = 0;

  // A conflict blocks the merge outright — even with green CI and an approval.
  // ONLY "CONFLICTING" counts: GitHub computes mergeable lazily and can return
  // "UNKNOWN" on the first query and "MERGEABLE" on the second (measured live:
  // 3 of 15 PRs did this). Treating UNKNOWN as a conflict would be a false alarm.
  if (pr.mergeable === "CONFLICTING") {
    reasons.push("conflict — needs rebase");
    rank = 3;
  }

  if (pr.ciState === "FAILURE" || pr.ciState === "ERROR") {
    reasons.push(`CI: ${(pr.failingRequired || []).join(", ") || "?"}`);
    rank = 3;
  } else if (pr.ciState === "PENDING" || pr.ciState === "EXPECTED") {
    reasons.push(`CI: ${(pr.pendingRequired || []).join(", ") || "?"}`);
    rank = Math.max(rank, 2);
  }

  // reviewDecision is only populated when review is REQUIRED; null means "not needed".
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    reasons.push("changes requested");
    rank = 3;
  } else if (pr.reviewDecision === "REVIEW_REQUIRED") {
    reasons.push("awaiting review");
    rank = Math.max(rank, 2);
  }

  return { rank, reasons };
}

/**
 * How long a PR has been waiting on YOUR review.
 *
 * Counted from the moment review was assigned to you, not from when the PR was
 * opened — a PR can sit open for weeks and only be assigned yesterday. For a
 * team request requestedReviewer is a Team (no login); that counts too.
 */
export function reviewWaitInfo(pr, login, now) {
  const events = (pr && pr.timelineItems && pr.timelineItems.nodes) || [];
  let latest = null;
  for (const e of events) {
    if (!e || !e.createdAt) continue;
    const who = e.requestedReviewer ? e.requestedReviewer.login || null : null;
    if (login && who && who !== login) continue; // request aimed at someone else
    if (!latest || e.createdAt > latest) latest = e.createdAt;
  }
  const at = latest || (pr && pr.createdAt) || null;
  return { requestedAt: at, days: at ? businessDaysBetween(at, now) : null };
}

/**
 * Summarises a PR list by task key.
 * Jira's dev-status comes back empty here, so PRs come from GitHub and are
 * matched by the key in the title — a PR without a key is silently skipped.
 */
export function summarizePrs(prs) {
  const byKey = {};
  const broken = [];
  const waiting = [];
  for (const pr of prs || []) {
    const key = extractIssueKey(pr?.title);
    if (!key) continue;

    const entry = byKey[key] || (byKey[key] = { count: 0, rated: 0, state: null, rank: 0 });
    entry.count++;

    // A draft PR is not ready yet: it COUNTS in the badge (work has started) but
    // produces no blocker — it neither joins a band nor plays a CI sound. Measured
    // live: 7 of 8 open PRs were drafts and 5 were REVIEW_REQUIRED, so drafts
    // filled the WAITING band on their own and the one real item was lost in them.
    if (pr?.isDraft) continue;

    const { rank, reasons } = prBlockers(pr);
    entry.rated++;
    // Always set on the FIRST PR: while rank is 0, "rank > entry.rank" never holds
    // and unblocked PRs would stay stateless (null). The counter must be rated, NOT
    // count — otherwise a draft first in the list leaves the next real PR stateless.
    if (entry.rated === 1 || rank > entry.rank) {
      entry.rank = rank;
      // With nothing blocking, reflect CI's own state: if unknown (null), do not show green.
      entry.state = rank === 3 ? "FAILURE" : rank === 2 ? "PENDING" : pr.ciState || null;
    } else if (rank === entry.rank && !entry.state && pr.ciState) {
      entry.state = pr.ciState;
    }

    const row = { key, repo: pr.repo, number: pr.number, url: pr.url, checks: reasons };
    if (rank === 3) broken.push(row);
    else if (rank === 2) waiting.push(row);
  }
  return { byKey, broken, waiting };
}

/**
 * "Ada Yilmaz" -> "Ada". Keeps the narrow column readable; the full name stays
 * in the tooltip.
 *
 * overrides: full name in Jira -> name to display. When the name someone goes by
 * on the team does not match their Jira record (e.g. "Kerem Demir" but everyone
 * says "KD") it is mapped from config, never hard-coded.
 */
export function firstName(displayName, overrides) {
  if (!displayName) return "";
  const full = String(displayName).trim();
  const alias = overrides && Object.prototype.hasOwnProperty.call(overrides, full)
    ? String(overrides[full] ?? "").trim()
    : null;
  if (alias) return alias.length > 9 ? alias.slice(0, 8) + "…" : alias;
  const first = full.split(/\s+/)[0] || "";
  return first.length > 9 ? first.slice(0, 8) + "…" : first;
}

// --- Quick notes (live on the browser side; never sent to Jira) ---
export const MAX_NOTES = 6;
const NOTE_LIMIT = 140;

/** Empty/whitespace notes are not added; when the list is full the OLDEST drops. */
export function addNote(notes, text, now) {
  const t = String(text ?? "").trim();
  if (!t) return Array.isArray(notes) ? notes : [];
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  const ms = new Date(now).getTime();
  const note = {
    id: `${ms}-${Math.floor(ms % 1000)}-${list.length}`,
    text: t.slice(0, NOTE_LIMIT),
    at: new Date(now).toISOString(),
  };
  return [...list, note].slice(-MAX_NOTES);
}

export function removeNote(notes, id) {
  return (Array.isArray(notes) ? notes : []).filter((n) => n && n.id !== id);
}


/**
 * Critical events that are NEW relative to the previous run.
 *
 * On the first run (prev.initialized !== true) it produces nothing — otherwise
 * the widget would play a sound for every existing boss/broken CI/review request
 * on first launch. An already-known event stays silent; only new ones count.
 */
export function detectAlerts(prev, now) {
  const alerts = [];
  if (!prev || prev.initialized !== true) return alerts;

  const prevBoss = prev.bossKey || null;
  if (now.bossKey && now.bossKey !== prevBoss) alerts.push("boss");

  const known = (list) => new Set(Array.isArray(list) ? list : []);
  const prevBroken = known(prev.brokenIds);
  if ((now.brokenIds || []).some((id) => !prevBroken.has(id))) alerts.push("ci");

  const prevReviews = known(prev.reviewIds);
  if ((now.reviewIds || []).some((id) => !prevReviews.has(id))) alerts.push("review");

  return alerts;
}

/**
 * Persisted state now serves ONE question: "did we already see this event on the
 * previous run?" — i.e. preventing repeated sounds.
 *
 * `initialized` is CRITICAL: detectAlerts relies on it to stay quiet on the first
 * run. Without it the widget would play a sound for every existing boss/broken CI
 * on every launch.
 */
export function emptyState() {
  return {
    initialized: false,
    bossKey: null,
    brokenIds: [],
    reviewIds: [],
  };
}

// --- Executable lookup --------------------------------------------------
// A GUI app launched from Finder does NOT see the shell PATH (it is limited to
// /usr/bin:/bin), so we cannot assume node/gh are "on PATH". Homebrew installs
// under /opt/homebrew on Apple Silicon and /usr/local on Intel Macs.

export const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/**
 * Tries the candidates in order and returns the first existing absolute path,
 * or null. `exists` is injected, which keeps this pure and testable.
 */
export function resolveExecutable(name, exists, dirs = BIN_DIRS) {
  if (!name) return null;
  for (const dir of dirs) {
    const path = `${dir}/${name}`;
    if (exists(path)) return path;
  }
  return null;
}

// --- Update check -------------------------------------------------------
// A signed bundle's contents CANNOT be modified (a single file breaks the
// signature and macOS SIGKILLs the app). So the app cannot update itself; all it
// does is say "a new version exists" and open the release page.

/** Compares versions numerically, part by part. -1 / 0 / 1. A "v" prefix is tolerated. */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? "").trim().replace(/^v/i, "").split(/[.\-+]/)
      .map((n) => parseInt(n, 10)).filter(Number.isFinite);
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;      // "1.2" and "1.2.0" must compare equal
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Details to show when the GitHub release is newer than what is running, else null.
 * With no `current` (a development build, no version embedded) we never warn —
 * saying "update available" on every refresh would just be noise while developing.
 */
export function updateInfo(current, release) {
  if (!current || !release || !release.tag_name) return null;
  if (compareVersions(release.tag_name, current) <= 0) return null;
  return {
    version: String(release.tag_name).replace(/^v/i, ""),
    url: release.html_url || null,
  };
}

// --- Jira request target ------------------------------------------------
// Two auth paths side by side: OAuth (new) and API token (existing installs).
// Under OAuth the request goes to Atlassian's gateway rather than the site, and
// the site is selected by `cloudId`; under Basic it goes straight to the site.
// Without collecting that difference in one place every call site would repeat it.

/**
 * The URL and headers to use for a Jira REST path.
 * `auth`: { mode: "oauth", token, cloudId } | { mode: "basic", token }
 */
export function jiraRequest(auth, host, path) {
  if (auth?.mode === "oauth") {
    if (!auth.cloudId) throw new Error("cloudId is required in OAuth mode");
    return {
      url: `https://api.atlassian.com/ex/jira/${auth.cloudId}${path}`,
      headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
    };
  }
  if (!host) throw new Error("host is required in Basic mode");
  return {
    url: `https://${host}${path}`,
    headers: { Authorization: `Basic ${auth?.token ?? ""}`, Accept: "application/json" },
  };
}
