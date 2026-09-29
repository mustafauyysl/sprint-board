#!/usr/bin/env node
// I/O layer: Jira + keychain + the state file. All decision logic lives in lib.mjs.
// Output: single-line JSON. Even on failure it prints VALID JSON.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  businessDaysBetween, evaluate, pickBoss, bolts,
  releaseState, pendingReleaseStatuses, emptyState, sprintHistory, firstName,
  summarizePrs, requiredRollup, reviewWaitInfo, detectAlerts, resolveExecutable,
  updateInfo, jiraRequest, ownershipStartedAt,
} from "./lib.mjs";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(homedir(), ".config", "sprint-widget", "config.json");
const STATE_PATH = join(homedir(), ".local", "state", "sprint-widget", "state.json");
const DEBUG = process.argv.includes("--debug");

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
};

const writeJson = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
};

function getToken(service, account) {
  try {
    // stderr is swallowed: if it were merged into stdout, JSON parsing would break.
    return execFileSync("/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Tokens are handed over by the Swift side through stdin.
 *
 * WHY: whichever app WRITES a keychain item must also be the one that READS it.
 * When the app writes the item and then `security` (a separate binary) tries to
 * read it, macOS opens a permission dialog — measured: the command hung waiting
 * on that dialog. So the app reads what it wrote itself, silently, via
 * SecItemCopyMatching, and passes it in here.
 *
 * Run by hand from a terminal stdin is a tty; then we fall through to the
 * `security` path below (which is also how older, hand-made items still work).
 */
async function pipedTokens() {
  if (process.stdin.isTTY) return {};
  // NEVER readFileSync(0): on a pipe that is still empty it throws EAGAIN and we
  // carried on as if there were no token (measured — in OAuth mode the app side
  // makes a network request while building the payload, so the pipe is briefly
  // empty). Here we read to EOF; the writer writes and then closes.
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let apiCalls = 0;

async function api(cfg, auth, path) {
  apiCalls++;
  const { url, headers } = jiraRequest(auth, cfg.host, path);
  const res = await fetch(url, { headers });
  return { status: res.status, ok: res.ok, body: res.ok ? await res.json() : await res.text() };
}

/**
 * Custom field ids differ per installation — we discover them at runtime and
 * write them into config, so they are never hard-coded anywhere.
 */
async function discoverFields(cfg, auth, names) {
  const r = await api(cfg, auth, "/rest/api/3/field");
  if (!r.ok) throw new Error(`could not fetch the field list (HTTP ${r.status})`);
  const out = {};
  for (const name of names) {
    const f = r.body.find((x) => x.name === name && String(x.id).startsWith("customfield_"));
    out[name] = f ? f.id : null;
  }
  return out;
}

/** The new /search/jql first; the retired /search only on 404/410. */
async function searchIssues(cfg, auth, jql, fields) {
  const qs = (base) =>
    `${base}?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}` +
    `&expand=changelog&maxResults=100`;

  let r = await api(cfg, auth, qs("/rest/api/3/search/jql"));
  if (!r.ok && (r.status === 404 || r.status === 410)) {
    r = await api(cfg, auth, qs("/rest/api/3/search"));
  }
  if (!r.ok) {
    const hint = r.status === 401 ? " — is the token invalid?" : "";
    throw new Error(`Jira search failed (HTTP ${r.status})${hint}`);
  }
  return r.body.issues ?? [];
}

/**
 * Work left behind in past sprints that still has not shipped.
 *
 * Because the main query says `sprint in openSprints()`, these never appeared in
 * the widget at all: once a sprint closes the work vanishes from view, even when
 * it never reached prod. Finished (Released on Prod / Done) and cancelled items
 * are filtered out — only the genuinely pending ones remain.
 */
async function fetchPendingRelease(cfg, auth, sprintField, now) {
  const wanted = pendingReleaseStatuses(cfg);
  if (wanted.length === 0) return [];
  try {
    // The status filter moved into the JQL. We used to fetch "statusCategory = Done"
    // and filter client-side; searchIssues caps at maxResults=100 and does NOT
    // paginate, and the sort was `updated DESC` — so the longest-waiting records,
    // the very reason this band exists, fell outside the window and were silently
    // dropped. Filtering server-side keeps the result set small, and `updated ASC`
    // puts the stalest first, removing the truncation risk entirely.
    const issues = await searchIssues(
      cfg, auth,
      "assignee = currentUser() AND statusCategory = Done " +
      `AND status IN (${wanted.map((x) => JSON.stringify(String(x))).join(", ")}) ` +
      "AND (sprint IS EMPTY OR sprint NOT IN openSprints()) ORDER BY updated ASC",
      `summary,status,created,${sprintField}`
    );

    const rows = [];
    for (const issue of issues) {
      const status = issue.fields?.status?.name ?? "";
      if (releaseState(status, cfg) !== "pending") continue;

      const enteredAt = await statusEnteredAt(cfg, auth, issue);
      const sprints = (issue.fields?.[sprintField] ?? [])
        .map((x) => x && x.name).filter(Boolean);
      rows.push({
        key: issue.key,
        summary: issue.fields?.summary ?? "",
        status,
        url: `https://${cfg.host}/browse/${issue.key}`,
        sprint: sprints.length ? sprints[sprints.length - 1] : null,
        days: businessDaysBetween(enteredAt, now),
      });
    }
    return rows.sort((a, b) => b.days - a.days);
  } catch (err) {
    // Optional layer: the rest of the widget must not crash. But it must not stay
    // SILENT either — otherwise "the query broke" and "nothing is pending" look
    // identical and the band just disappears.
    pendingReleaseError = String(err && err.message ? err.message : err).slice(0, 200);
    return null;
  }
}

function latestStatusChange(histories) {
  let latest = null;
  for (const h of histories ?? []) {
    if (!(h.items ?? []).some((i) => i.field === "status" || i.fieldId === "status")) continue;
    const t = new Date(h.created);
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

/**
 * The issue's changelog entries. If the changelog is missing or truncated
 * (search caps at 100 records) we fetch that issue's changelog on its own —
 * otherwise every duration derived from it comes out silently wrong.
 *
 * One fetch serves both the status timestamp AND the ownership timestamp, so
 * measuring the person's clock costs no extra request.
 */
async function changelogOf(cfg, auth, issue) {
  const cl = issue.changelog;
  const truncated = cl && typeof cl.total === "number" && cl.total > (cl.histories?.length ?? 0);
  if (cl && !truncated) return cl.histories ?? [];

  const r = await api(cfg, auth,
    `/rest/api/3/issue/${issue.key}?expand=changelog&fields=created`);
  if (!r.ok) return cl?.histories ?? [];
  return r.body?.changelog?.histories ?? cl?.histories ?? [];
}

const GH_KEYCHAIN = "sprint-board-github";
// The service name comes from config; this default applies when it is absent.
// Older installs carry their own name in config, so nothing breaks for them.
const JIRA_KEYCHAIN = "sprint-board-jira";

/**
 * The GitHub token. Keychain first, so the app works WITHOUT `gh` installed.
 * When gh is present and the keychain is empty we borrow its token, which keeps
 * existing installs working without a single change.
 */
function githubToken(cfg) {
  const stored = getToken(cfg.githubKeychainService || GH_KEYCHAIN, cfg.email);
  if (stored) return stored;
  const gh = resolveExecutable("gh", existsSync);
  if (!gh) return null;
  try {
    return execFileSync(gh, ["auth", "token"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim() || null;
  } catch {
    return null;
  }
}

// With no org the filter is omitted entirely: all of the user's open PRs come back.
// The org used to be hard-coded, which returned nothing on any other installation.
const prQuery = (org) => `
{
  search(query: "${org ? `org:${org} ` : ""}author:@me is:pr is:open", type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft
      repository { name nameWithOwner }
      reviewDecision
      mergeable
    } }
  }
}`;

/** GitHub GraphQL — direct HTTP rather than a `gh` subprocess (same path as Jira). */
async function ghGraphql(query, token) {
  apiCalls++;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      // The GitHub API rejects requests without a User-Agent.
      "User-Agent": "sprint-board",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

/**
 * Open PRs, via a SINGLE search query (~6s).
 * Returns null when there is no token or the request fails — PR data is optional
 * and the rest of the widget must not go down because of it.
 */
async function fetchPrs(org, token) {
  if (!token) return null;
  try {
    const nodes = (await ghGraphql(prQuery(org), token))?.data?.search?.nodes ?? [];
    return nodes.filter((n) => n && n.number).map((n) => ({
      number: n.number,
      title: n.title,
      url: n.url,
      repo: n.repository?.name ?? "?",
      // The owner comes from the PR ITSELF; we cannot assume a single org.
      owner: n.repository?.nameWithOwner?.split("/")[0] ?? null,
      isDraft: !!n.isDraft,
      reviewDecision: n.reviewDecision ?? null,
      mergeable: n.mergeable ?? null,
      ciState: null,
      failingRequired: [],
      pendingRequired: [],
    }));
  } catch {
    return null;
  }
}

/**
 * The status of ONLY the required checks, per PR.
 *
 * This needs its own query because the `isRequired` field takes the PR number as
 * an argument and that value cannot be dynamic inside the search query — so we
 * build one alias per PR and collect them in a single call.
 *
 * Without this filter an optional Jest/lint failure read as "CI broken": measured
 * live, three PRs all showed "FAILURE" while their required checks had passed.
 *
 * If the query fails the state stays "unknown" (null) — staying quiet beats
 * raising a false alarm.
 */
let requiredError = null;
let pendingReleaseError = null;

async function attachRequiredChecks(prs, token) {
  if (!prs || prs.length === 0 || !token) return;
  const usable = prs.filter((pr) => pr.owner);
  if (usable.length === 0) return;
  const aliases = usable.map((pr, i) => `
    p${i}: repository(owner: ${JSON.stringify(pr.owner)}, name: ${JSON.stringify(pr.repo)}) {
      pullRequest(number: ${pr.number}) {
        mergeable
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { name conclusion startedAt completedAt isRequired(pullRequestNumber: ${pr.number}) }
          ... on StatusContext { context state createdAt isRequired(pullRequestNumber: ${pr.number}) }
        } } } } } }
      }
    }`);
  try {
    const data = (await ghGraphql(`{${aliases.join("\n")}}`, token))?.data ?? {};
    prs.forEach((pr, i) => {
      const ctx = data[`p${i}`]?.pullRequest?.commits?.nodes?.[0]
        ?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      // The second query = the settled value. The first search may have returned
      // UNKNOWN; by now it has resolved to MERGEABLE/CONFLICTING. If it is still
      // UNKNOWN, leave it alone.
      const settled = data[`p${i}`]?.pullRequest?.mergeable;
      if (settled && settled !== "UNKNOWN") pr.mergeable = settled;

      const rr = requiredRollup(ctx);
      pr.ciState = rr.state;
      pr.failingRequired = rr.failing;
      pr.pendingRequired = rr.pending;
      pr.requiredCount = rr.requiredCount;
    });
  } catch (err) {
    requiredError = String(err && err.message ? err.message : err).slice(0, 200);
  }
}

const REVIEW_QUERY = `
{
  viewer { login }
  search(query: "is:open is:pr review-requested:@me", type: ISSUE, first: 30) {
    nodes { ... on PullRequest {
      number title url createdAt isDraft
      repository { name }
      author { login }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
        nodes { ... on ReviewRequestedEvent {
          createdAt
          requestedReviewer { ... on User { login } ... on Team { name } }
        } }
      }
    } }
  }
}`;

/**
 * The most recent published release. GitHub itself filters out drafts and
 * pre-releases. Returns null on failure — the update check is optional and must
 * not take the board down.
 */
async function fetchLatestRelease(repo, token) {
  if (!repo || !token) return null;
  try {
    apiCalls++;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Authorization: `bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "sprint-board",
      },
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** PRs awaiting your review (the widget's equivalent of github.com/pulls/reviews). */
async function fetchReviewRequests(now, token) {
  if (!token) return null;
  try {
    const d = (await ghGraphql(REVIEW_QUERY, token))?.data;
    const login = d?.viewer?.login || null;
    return (d?.search?.nodes ?? []).filter((n) => n && n.number).map((n) => {
      const { requestedAt, days } = reviewWaitInfo(n, login, now);
      return {
        repo: n.repository?.name ?? "?",
        number: n.number,
        title: n.title ?? "",
        url: n.url,
        author: n.author?.login ?? "?",
        isDraft: !!n.isDraft,
        requestedAt,
        days,
      };
    }).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  } catch {
    return null;
  }
}

/**
 * Plays a single system sound on a critical event (priority boss > CI > review).
 * spawn+unref so the sound never blocks the refresh; failures are ignored quietly.
 */
function playAlert(cfg, alerts) {
  const snd = cfg.sound || {};
  if (!snd.enabled || alerts.length === 0) return null;
  const pick = alerts.includes("boss") ? "boss" : alerts.includes("ci") ? "ci" : "review";
  const file = snd[pick];
  if (!file) return null;
  try {
    spawn("/usr/bin/afplay", [file], { detached: true, stdio: "ignore" }).unref();
    return pick;
  } catch {
    return null;
  }
}

function activeSprint(issues, sprintField) {
  for (const issue of issues) {
    const raw = issue.fields?.[sprintField];
    if (!Array.isArray(raw)) continue;
    const s = raw.find((x) => x && x.state === "active");
    if (s) return s;
  }
  return null;
}

/**
 * --demo: shows every visual state in one frame without touching Jira.
 * The input is fake but the logic is REAL — evaluate/pickBoss/summarizePrs run
 * exactly as they do live, so what you see here matches real data.
 */
function demoPayload(cfg) {
  const now = new Date();
  // ENTIRELY FICTIONAL. No real Jira record, customer name or person's name may
  // go here — sharing the repo shares the demo data with it.
  const seed = [
    { key: "DEMO-101", summary: "Template engine: dynamic tag support", status: "Ready To Test", daysInStatus: 11, ageDays: 25, priority: "3 Medium", carriedOver: true, sprintCount: 3, qa: "Ada Yilmaz" },
    { key: "DEMO-102", summary: "Clean up duplicate registration ids", status: "In Code Review", daysInStatus: 5, ageDays: 12, priority: "2 High", carriedOver: false, sprintCount: 1, qa: "Konstantin Petrov" },
    { key: "DEMO-103", summary: "Generate content from chat in the editor", status: "UAT", daysInStatus: 4, ageDays: 15, priority: "4 Low", carriedOver: true, sprintCount: 2, qa: "Kerem Demir" },
    { key: "DEMO-104", summary: "Rate limit alarm regressed again", status: "IN AUTO TESTING", daysInStatus: 2, ageDays: 6, priority: "2 High", carriedOver: false, sprintCount: 1, qa: "Kerem Demir" },
    { key: "DEMO-105", summary: "Editor endpoint returns 404", status: "To Do", daysInStatus: 0, ageDays: 3, priority: "2 High", carriedOver: false, sprintCount: 1 },
    { key: "DEMO-106", summary: "Upgrade vulnerable dependencies", status: "Ready For Release", daysInStatus: 1, ageDays: 17, priority: "3 Medium", carriedOver: false, sprintCount: 1, qa: "Zeynep Aksu", done: true },
  ];

  const tasks = seed.map((t) => {
    const e = evaluate(t.status, t.daysInStatus, cfg);
    return {
      ...t,
      done: !!t.done,
      release: t.done ? releaseState(t.status, cfg) : null,
      qaShort: firstName(t.qa || "", cfg.nameOverrides),
      statusCategory: t.done ? "done" : t.status === "To Do" ? "new" : "indeterminate",
      threshold: e.threshold,
      ratio: e.ratio,
      alert: e.alert && !t.done,
      tier: t.done ? "done" : e.tier,
      url: `https://${cfg.host}/browse/${t.key}`,
    };
  });

  const demoPrs = [
    { title: "DEMO-101 | Template gate", ciState: "FAILURE", failingRequired: ["LintChecker"], repo: "web-frontend", number: 4608, url: "#" },
    { title: "DEMO-101 | Template UI", ciState: "SUCCESS", repo: "editor-frontend", number: 327, url: "#" },
    { title: "DEMO-101 | Template generator", ciState: "SUCCESS", repo: "template-generator", number: 243, url: "#" },
    { title: "DEMO-102 | Shared library upgrade", ciState: "PENDING", pendingRequired: ["AI Code Review"], repo: "backend-api", number: 1166, url: "#" },
    { title: "DEMO-102 | Submit guard", ciState: "SUCCESS", repo: "shared-lib", number: 97, url: "#" },
    { title: "DEMO-106 | Dependency upgrade", ciState: "FAILURE", failingRequired: ["qa/smoke"], repo: "worker-jobs", number: 288, url: "#" },
    { title: "DEMO-103 | Catalog service search", ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED", repo: "catalog-service", number: 33957, url: "#" },
  ];
  const { byKey: demoByKey, broken: demoBroken, waiting: demoWaiting } = summarizePrs(demoPrs);
  for (const t of tasks) {
    const p = demoByKey[t.key];
    t.pr = p ? { count: p.count, state: p.state } : null;
  }

  const boss = pickBoss(tasks);

  return {
    ok: true, demo: true, generatedAt: now.toISOString(), apiCalls: 0,
    sprint: { name: "Demo Team - Sprint#4", endDate: null, daysLeft: 2 },
    cleared: 1, total: tasks.length,
    boss: boss && {
      key: boss.key, summary: boss.summary, status: boss.status,
      daysInStatus: boss.daysInStatus, threshold: boss.threshold,
      ratio: Number(boss.ratio.toFixed(2)), bolts: bolts(boss.ratio), url: boss.url,
      carriedOver: boss.carriedOver, sprintCount: boss.sprintCount,
    },
    prsAvailable: true,
    pendingRelease: [
      { key: "DEMO-107", summary: "Missing font-display setting", status: "Ready For Release",
        url: "https://example.invalid/browse/DEMO-107", sprint: "Demo Team - Sprint#2", days: 17 },
    ],
    position: cfg.position || { top: 40, right: 40 },
    reviewRequests: [
      { repo: "catalog-service", number: 34101, author: "demo-reviewer", days: 3,
        title: "DEMO-108 | bug fix", url: "#" },
      { repo: "backend-api", number: 331, author: "demo-author", days: 1,
        title: "DEMO-109 | new feature", url: "#" },
    ],
    brokenPrs: demoBroken,
    waitingPrs: demoWaiting,
    tasks: [...tasks].sort((a, b) =>
      a.done !== b.done ? (a.done ? 1 : -1) : b.ratio - a.ratio || b.daysInStatus - a.daysInStatus),
  };
}

async function main() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg) throw new Error(`could not read config: ${CONFIG_PATH}`);
  if (process.argv.includes("--demo")) return demoPayload(cfg);

  const piped = await pipedTokens();

  // Two auth paths. Under OAuth the Swift side supplies the access token
  // (refreshing it through the Worker first when expired) and the site is chosen
  // by `cloudId`. Otherwise we fall back to the old API-token path so existing
  // installs keep working without a single change.
  const auth = piped.jiraAccessToken && cfg.cloudId
    ? { mode: "oauth", token: piped.jiraAccessToken, cloudId: cfg.cloudId }
    : null;

  const token = auth ? null : (piped.jiraToken || getToken(cfg.keychainService || JIRA_KEYCHAIN, cfg.email));
  if (!auth && !token) {
    // The app side distinguishes a network failure from an expired session; we
    // preserve that distinction here so a transient outage never reads as
    // "sign in again".
    throw new Error(
      piped.jiraAuthState === "temporary"
        ? "Could not reach Atlassian — it will retry automatically once you are back online"
        : "No Jira session, or it has expired — sign in again from ⚔ > Settings in the menu bar"
    );
  }
  const jiraAuth = auth || { mode: "basic", token: Buffer.from(`${cfg.email}:${token}`).toString("base64") };

  let sprintField = cfg.sprintFieldId;
  let qaField = cfg.qaFieldId;
  if (!sprintField || qaField === undefined) {
    const found = await discoverFields(cfg, jiraAuth, ["Sprint", "QA Tester"]);
    sprintField = sprintField || found["Sprint"];
    if (!sprintField) throw new Error("could not find the 'Sprint' field in Jira");
    qaField = qaField === undefined ? found["QA Tester"] : qaField;
    writeJson(CONFIG_PATH, { ...cfg, sprintFieldId: sprintField, qaFieldId: qaField });
  }

  const issues = await searchIssues(
    cfg, jiraAuth,
    "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC",
    `summary,status,priority,issuetype,created,assignee,${sprintField}${qaField ? "," + qaField : ""}`
  );

  // An empty board has two causes: there really is no work, OR the token is
  // invalid. Jira treats an invalid identity as ANONYMOUS and answers the search
  // with HTTP 200 + an empty list (measured: search 200 {"issues":[]}, /myself
  // 401 with the same token). So someone with a bad token saw a blank widget
  // rather than an error. We verify the identity ONLY when the result is empty —
  // a populated board costs no extra request.
  if (issues.length === 0) {
    const me = await api(cfg, jiraAuth, "/rest/api/3/myself");
    if (!me.ok) {
      throw new Error(
        me.status === 401
          ? "Jira token is invalid — refresh it from ⚔ > Settings in the menu bar"
          : `Jira authentication failed (HTTP ${me.status})`
      );
    }
  }

  const now = new Date();
  // An optional layer must NOT hold up the main load: it is only started here,
  // and its result is collected after the task loop.
  const pendingReleaseP = fetchPendingRelease(cfg, jiraAuth, sprintField, now);
  // Resolved BEFORE the loop: each task's clock needs the current sprint's id.
  const sprint = activeSprint(issues, sprintField);
  const tasks = [];
  for (const issue of issues) {
    const f = issue.fields;
    const status = f.status?.name ?? "Unknown";
    const done = f.status?.statusCategory?.key === "done";
    const histories = await changelogOf(cfg, jiraAuth, issue);
    const statusAt = latestStatusChange(histories) ?? new Date(f.created);
    // The clock is the PERSON's, not the ticket's. A card that sat unassigned in
    // To Do for 23 days and was handed over today is 1 day of THIS person's
    // delay, not 23 — otherwise it lands on its new owner as an instant boss
    // alert for a queue they never saw. Whichever came later wins: a status
    // change after the handover is the real bottleneck again.
    // Every issue here matched `assignee = currentUser()`, so f.assignee IS me.
    const ownedAt = ownershipStartedAt(histories, {
      accountId: f.assignee?.accountId,
      sprintFieldId: sprintField,
      sprintId: sprint?.id,
    });
    const enteredAt = ownedAt && ownedAt > statusAt ? ownedAt : statusAt;
    const daysInStatus = businessDaysBetween(enteredAt, now);
    // Time-in-status shows the bottleneck, age shows total delay — two different signals.
    const ageDays = businessDaysBetween(new Date(f.created), now);
    const { threshold, alert, ratio, tier } = evaluate(status, daysInStatus, cfg);
    // A closed sprint in the array means the work was carried over (no extra query needed).
    const { carriedOver, sprintCount } = sprintHistory(f[sprintField]);

    tasks.push({
      key: issue.key,
      summary: f.summary ?? "",
      status,
      statusCategory: f.status?.statusCategory?.key ?? "new",
      done,
      // The done category alone is not enough: "finished" and "waiting to ship"
      // are different. NOTE: this distinction is VISUAL ONLY. The `cleared` counter
      // still looks at `done` — once the development work is finished the sprint
      // considers it closed, and waiting on a release must not hold the counter
      // back. Not an inconsistency; deliberate.
      release: done ? releaseState(f.status?.name, cfg) : null,
      priority: f.priority?.name ?? null,
      daysInStatus,
      ageDays,
      carriedOver,
      sprintCount,
      qa: (qaField && f[qaField]?.displayName) || null,
      qaShort: firstName((qaField && f[qaField]?.displayName) || "", cfg.nameOverrides),
      threshold,
      alert: alert && !done,
      ratio,
      tier: done ? "done" : tier,
      url: `https://${cfg.host}/browse/${issue.key}`,
    });
  }

  // The org is optional: without it the PR search runs with no org filter.
  const githubOrg = cfg.githubOrg || "";
  const ghToken = piped.githubToken || githubToken(cfg);
  const prs = await fetchPrs(githubOrg, ghToken);
  const reviewRequests = await fetchReviewRequests(new Date(), ghToken);
  await attachRequiredChecks(prs, ghToken);
  const { byKey: prByKey, broken: brokenPrs, waiting: waitingPrs } = summarizePrs(prs);
  for (const t of tasks) {
    const p = prByKey[t.key];
    t.pr = p ? { count: p.count, state: p.state } : null;
  }

  const prevState = readJson(STATE_PATH, emptyState());

  // Critical-event detection: compare against the previous run so only NEW items sound.
  const bossNow = pickBoss(tasks);
  const signals = {
    bossKey: bossNow ? bossNow.key : null,
    brokenIds: brokenPrs.map((p) => `${p.repo}#${p.number}`),
    reviewIds: (reviewRequests || []).map((r) => `${r.repo}#${r.number}`),
  };
  const alerts = detectAlerts(prevState, signals);
  const played = playAlert(cfg, alerts);
  // `initialized` is REQUIRED: this is how detectAlerts recognises the first run.
  // Without it every launch counts as "first launch" and every existing boss or
  // broken CI plays a sound all over again.
  writeJson(STATE_PATH, { initialized: true, ...signals });

  // Closed items are NOT dropped from the list, only sorted to the end: statuses
  // like "Awaiting Release" sit in Jira's done category while the work may not have
  // shipped yet — it must not disappear from view.
  const visible = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.ratio - a.ratio || b.daysInStatus - a.daysInStatus;
  });

  // The version is only embedded in a distribution build; without it we skip the
  // release query entirely — no wasted request and no noisy warning while developing.
  const update = piped.appVersion
    ? updateInfo(piped.appVersion,
        await fetchLatestRelease(cfg.updateRepo || "mustafauyysl/sprint-board", ghToken))
    : null;

  const boss = pickBoss(tasks);
  const daysLeft = sprint?.endDate
    ? Math.max(0, Math.ceil((new Date(sprint.endDate) - now) / 86400000))
    : null;

  return {
    ok: true,
    generatedAt: now.toISOString(),
    apiCalls,
    sprint: { name: sprint?.name ?? "Sprint", endDate: sprint?.endDate ?? null, daysLeft },
    cleared: tasks.filter((t) => t.done).length,
    total: tasks.length,
    boss: boss
      ? {
          key: boss.key, summary: boss.summary, status: boss.status,
          daysInStatus: boss.daysInStatus, threshold: boss.threshold,
          ratio: Number(boss.ratio.toFixed(2)), bolts: bolts(boss.ratio), url: boss.url,
          carriedOver: boss.carriedOver, sprintCount: boss.sprintCount,
        }
      : null,
    tasks: visible,
    prsAvailable: prs !== null,
    pendingRelease: (await pendingReleaseP) || [],
    pendingReleaseError,
    reviewRequests: reviewRequests || [],
    position: cfg.position || { top: 40, right: 40 },
    alerts,
    played,
    requiredError,
    brokenPrs,
    waitingPrs,
    update,
  };
}

main()
  .then((out) => process.stdout.write(JSON.stringify(out, null, DEBUG ? 2 : 0)))
  .catch((err) => {
    // A silently empty widget is the worst outcome — errors are emitted as valid JSON too.
    process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  });
