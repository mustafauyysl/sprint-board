import "./SprintBoard.test.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  businessDaysBetween,
  evaluate,
  pickMostOverdue,
  alertSound,
  firstName,
  extractIssueKey,
  summarizePrs,
  requiredRollup,
  prBlockers,
  releaseState,
  reviewWaitInfo,
  detectAlerts,
  resolveExecutable,
  compareVersions,
  updateInfo,
  jiraRequest,
  BIN_DIRS,
  addNote,
  removeNote,
  MAX_NOTES,
  NOTE_LIMIT,
  sprintHistory,
  ownershipStartedAt,
  emptyState,
  watchedPrs,
  mergeBlocked,
  githubOrgQualifier,
  prSearch,
  reviewSearch,
  searchNodes,
  reviewIds,
  showDraftPrs,
  CONFLICT_SCOPE,
  sprintGoalTracking,
  activeSprints,
  goalJql,
  isGoalDone,
  goalRisk,
  goalRiskStages,
  DEFAULT_GOAL_RISK_STAGES,
  goalBand,
  withGoalMarks,
  conflictIds,
  newConflicts,
  conflictNotifications,
  refreshSummary,
  releasePrSearch,
  titleNamesKey,
  releasePrState,
  releasePrs,
  releaseBranchCheck,
  reachedReleaseBranch,
  releasedStatuses,
  isReleasedStatus,
  withOpenPrState,
  DEFAULT_RELEASED_STATUSES,
  groupByStatus,
} from "./lib.mjs";

const config = {
  defaultThresholdDays: 5,
  thresholds: { "To Do": 7, "In Code Review": 2, "Ready To Test": 3 },
};

const at = (iso) => new Date(`${iso}T12:00:00`);
// Reference days: 08-14 Fri · 08-17 Mon · 08-19 Wed · 08-20 Thu · 08-21 Fri · 08-24 Mon

test("businessDaysBetween: skips the weekend", () => {
  assert.equal(businessDaysBetween(at("2026-08-14"), at("2026-08-17")), 1, "Fri->Mon is 1 business day");
  assert.equal(businessDaysBetween(at("2026-08-21"), at("2026-08-24")), 1);
});

test("businessDaysBetween: same day 0, backwards 0", () => {
  assert.equal(businessDaysBetween(at("2026-08-20"), at("2026-08-20")), 0);
  assert.equal(businessDaysBetween(at("2026-08-20"), at("2026-08-17")), 0);
});

test("businessDaysBetween: within a week and a full week", () => {
  assert.equal(businessDaysBetween(at("2026-06-01"), at("2026-06-05")), 4, "Mon->Fri");
  assert.equal(businessDaysBetween(at("2026-06-01"), at("2026-06-08")), 5, "Mon->Mon full week");
});

test("businessDaysBetween: long span, measured live", () => {
  // Jul 16 Thu -> Aug 20 Thu = 5 full weeks = 25 business days
  assert.equal(businessDaysBetween(at("2026-07-16"), at("2026-08-20")), 25);
});

test("evaluate: does not fire exactly at the boundary", () => {
  assert.equal(evaluate("In Code Review", 2, config).alert, false, "days === threshold does not fire");
  assert.equal(evaluate("In Code Review", 3, config).alert, true);
});

test("evaluate: unknown status falls back to the default threshold", () => {
  const r = evaluate("Unknown Status", 6, config);
  assert.equal(r.threshold, 5);
  assert.equal(r.alert, true);
});

test("evaluate: twice over the threshold is critical", () => {
  assert.equal(evaluate("In Code Review", 3, config).tier, "warn");
  assert.equal(evaluate("In Code Review", 4, config).tier, "critical");
  assert.equal(evaluate("In Code Review", 1, config).tier, "ok");
});

test("evaluate: a zero-tolerance threshold does not collapse the ratio", () => {
  const zero = { ...config, thresholds: { "Ready To Test": 0 } };
  assert.equal(evaluate("Ready To Test", 0, zero).alert, false);
  const r = evaluate("Ready To Test", 3, zero);
  assert.equal(r.alert, true);
  assert.equal(r.ratio, 3, "denominator must clamp to 1, the ratio must not be 0");
  assert.equal(r.tier, "critical");
});

test("pickMostOverdue: picks by RATIO, not by day count", () => {
  const tasks = [
    { key: "A", daysInStatus: 8, threshold: 7, ratio: 8 / 7, alert: true },
    { key: "B", daysInStatus: 4, threshold: 2, ratio: 2, alert: true },
  ];
  assert.equal(pickMostOverdue(tasks).key, "B", "fewer days but a higher ratio");
});

test("pickMostOverdue: null when nothing is over threshold", () => {
  assert.equal(pickMostOverdue([{ key: "A", alert: false, ratio: 0.5, daysInStatus: 1 }]), null);
  assert.equal(pickMostOverdue([]), null);
});

test("pickMostOverdue: a closed task cannot be the most overdue", () => {
  const tasks = [{ key: "A", alert: true, ratio: 9, daysInStatus: 30, done: true }];
  assert.equal(pickMostOverdue(tasks), null);
});

// --- ownershipStartedAt ---------------------------------------------------
// The clock belongs to the PERSON, not to the ticket: a card that rotted
// unassigned for weeks must not land on its new owner as an overdue alert.

const ME = "557058:aaaa-bbbb";
const SPRINT_FIELD = "customfield_10020";

test("ownershipStartedAt: assignment to me starts the clock", () => {
  const at = ownershipStartedAt(
    [
      { created: "2026-01-05T09:00:00.000+0000",
        items: [{ fieldId: "status", field: "status", fromString: "Backlog", toString: "To Do" }] },
      { created: "2026-01-28T09:00:00.000+0000",
        items: [{ fieldId: "assignee", field: "assignee", from: null, to: ME }] },
    ],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at.toISOString(), "2026-01-28T09:00:00.000Z");
});

test("ownershipStartedAt: assignment to SOMEONE ELSE does not start my clock", () => {
  const at = ownershipStartedAt(
    [{ created: "2026-01-28T09:00:00.000+0000",
       items: [{ fieldId: "assignee", field: "assignee", from: null, to: "557058:other" }] }],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at, null);
});

test("ownershipStartedAt: entering the sprint starts the clock", () => {
  const at = ownershipStartedAt(
    [{ created: "2026-02-02T10:30:00.000+0000",
       items: [{ fieldId: SPRINT_FIELD, field: "Sprint", from: "", to: "42" }] }],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at.toISOString(), "2026-02-02T10:30:00.000Z");
});

test("ownershipStartedAt: the LATER of assignment and sprint entry wins", () => {
  const at = ownershipStartedAt(
    [
      { created: "2026-02-02T10:00:00.000+0000",
        items: [{ fieldId: SPRINT_FIELD, field: "Sprint", from: "", to: "42" }] },
      { created: "2026-02-04T08:00:00.000+0000",
        items: [{ fieldId: "assignee", field: "assignee", from: null, to: ME }] },
    ],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at.toISOString(), "2026-02-04T08:00:00.000Z");
});

test("ownershipStartedAt: an id already in `from` is not a new entry", () => {
  // Sprint membership is a comma-separated LIST. Being added to a second board
  // rewrites the field while sprint 42 never changed — that must not reset the clock.
  const at = ownershipStartedAt(
    [{ created: "2026-02-09T12:00:00.000+0000",
       items: [{ fieldId: SPRINT_FIELD, field: "Sprint", from: "42", to: "42,43" }] }],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at, null);
});

test("ownershipStartedAt: a move from sprint 41 into 42 does start the clock", () => {
  const at = ownershipStartedAt(
    [{ created: "2026-02-09T12:00:00.000+0000",
       items: [{ fieldId: SPRINT_FIELD, field: "Sprint", from: "41", to: "41,42" }] }],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at.toISOString(), "2026-02-09T12:00:00.000Z");
});

test("ownershipStartedAt: null when the changelog holds neither event", () => {
  const at = ownershipStartedAt(
    [{ created: "2026-01-05T09:00:00.000+0000",
       items: [{ fieldId: "status", field: "status", toString: "To Do" }] }],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(at, null);
});

test("ownershipStartedAt: survives a missing/empty changelog and missing ids", () => {
  assert.equal(ownershipStartedAt(null, { accountId: ME }), null);
  assert.equal(ownershipStartedAt([], {}), null);
  assert.equal(ownershipStartedAt([{ created: "2026-02-09T12:00:00.000+0000", items: null }], {}), null);
  // No accountId and no sprintId => nothing can match, even with real items.
  assert.equal(
    ownershipStartedAt(
      [{ created: "2026-02-09T12:00:00.000+0000",
         items: [{ fieldId: "assignee", field: "assignee", to: ME }] }], {}),
    null,
  );
});

test("ownershipStartedAt: the 23-day To Do card is 1 day old for its new owner", () => {
  // The bug this exists for: 23 business days in To Do, assigned today.
  const now = new Date("2026-02-06T09:00:00.000Z");        // Friday
  const statusAt = new Date("2026-01-05T09:00:00.000Z");
  const ownedAt = ownershipStartedAt(
    [{ created: "2026-02-05T09:00:00.000+0000",
       items: [{ fieldId: "assignee", field: "assignee", from: null, to: ME }] }],
    { accountId: ME, sprintFieldId: SPRINT_FIELD, sprintId: 42 },
  );
  assert.equal(businessDaysBetween(statusAt, now), 24);
  const from = ownedAt > statusAt ? ownedAt : statusAt;
  assert.equal(businessDaysBetween(from, now), 1);
  // 1 day in To Do (threshold 7) is not an alert; 24 would have been the most overdue task.
  assert.equal(evaluate("To Do", 1, config).alert, false);
  assert.equal(evaluate("To Do", 24, config).alert, true);
});

test("sprintHistory: active sprint only = not carried over", () => {
  const r = sprintHistory([{ name: "S#4", state: "active" }]);
  assert.deepEqual(r, { carriedOver: false, closedSprints: 0, sprintCount: 1 });
});

test("sprintHistory: closed + active = carried over, measured live", () => {
  const r = sprintHistory([
    { name: "Demo Team - Sprint#3", state: "closed" },
    { name: "Demo Team - Sprint#4", state: "active" },
  ]);
  assert.equal(r.carriedOver, true);
  assert.equal(r.sprintCount, 2, "the ×2 badge");
});

test("sprintHistory: a future sprint does not count as carried over", () => {
  const r = sprintHistory([
    { name: "S#4", state: "active" },
    { name: "S#5", state: "future" },
  ]);
  assert.equal(r.carriedOver, false);
  assert.equal(r.sprintCount, 1, "a planned future sprint must not enter the counter");
});

test("sprintHistory: carried over twice", () => {
  const r = sprintHistory([
    { state: "closed" }, { state: "closed" }, { state: "active" },
  ]);
  assert.equal(r.closedSprints, 2);
  assert.equal(r.sprintCount, 3);
});

test("sprintHistory: does not crash when the field is empty/missing", () => {
  assert.deepEqual(sprintHistory(null), { carriedOver: false, closedSprints: 0, sprintCount: 0 });
  assert.deepEqual(sprintHistory([]), { carriedOver: false, closedSprints: 0, sprintCount: 0 });
  assert.equal(sprintHistory([null, undefined]).carriedOver, false);
});

test("requiredRollup: an optional failure raises no warning, measured live", () => {
  const r = requiredRollup([
    { name: "check-sql-change", conclusion: "FAILURE", isRequired: false },
    { context: "AI Code Review", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "SUCCESS", "a broken check that is not required does not block the merge");
  assert.deepEqual(r.failing, []);
});

test("requiredRollup: a required failure is caught and named", () => {
  const r = requiredRollup([
    { name: "ESLintChecker", conclusion: "FAILURE", isRequired: true },
    { name: "Jest", conclusion: "FAILURE", isRequired: false },
    { context: "qa/smoke", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "FAILURE");
  assert.deepEqual(r.failing, ["ESLintChecker"], "only required checks are reported");
  assert.equal(r.requiredCount, 2);
});

test("requiredRollup: measured live — the required checks had passed", () => {
  const r = requiredRollup([
    { name: "functional_tests_pipeline", conclusion: "FAILURE", isRequired: false },
    { context: "AWS CodeBuild (RUNNER-ai-test-coverage)", state: "FAILURE", isRequired: false },
    { name: "coverage / AI Test Coverage", conclusion: "CANCELLED", isRequired: false },
    { name: "ESLintChecker", conclusion: "SUCCESS", isRequired: true },
    { context: "AI Code Review", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "SUCCESS");
  assert.equal(r.failing.length, 0);
});

test("requiredRollup: a pending required check yields PENDING but no failure", () => {
  const r = requiredRollup([
    { name: "build", conclusion: null, isRequired: true },
    { context: "smoke", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "PENDING");
  assert.deepEqual(r.failing, []);
  assert.deepEqual(r.pending, ["build"], "the pending check name goes in its own list");
});

test("requiredRollup: pending checks are collected by name, measured live", () => {
  const r = requiredRollup([
    { name: "ESLintChecker", conclusion: "SUCCESS", isRequired: true },
    { context: "AI Code Review", state: "PENDING", isRequired: true },
    { context: "AI Test Analyzer", state: "SUCCESS", isRequired: true },
    { name: "Jest", conclusion: "FAILURE", isRequired: false },
  ]);
  assert.equal(r.state, "PENDING");
  assert.deepEqual(r.pending, ["AI Code Review"]);
  assert.deepEqual(r.failing, [], "an optional Jest failure does not count");
});

test("releaseState: Released on Prod and Done count as finished", () => {
  // "Done" means finished too — it is not counted among the ones awaiting release.
  assert.equal(releaseState("Released on Prod", {}), "finished");
  assert.equal(releaseState("Done", {}), "finished");
});

test("releaseState: an UNRECOGNISED done status falls to 'finished', NOT to pending", () => {
  // The real trap: had the list been one of "finished" statuses, every unrecognised
  // status would have shown as "awaiting release" forever. Six statuses in this Jira
  // behaved that way (Closed, Resolved, Problem Solved, Epic is Done, Question,
  // Unresolved).
  for (const st of ["Closed", "Resolved", "Problem Solved", "Epic is Done",
                    "Question", "Unresolved", "Fixed", "Duplicate", "Unknown Status"]) {
    assert.equal(releaseState(st, {}), "finished", st);
  }
});

test("releaseState: done statuses awaiting release are 'pending'", () => {
  // This Jira project has 15 statuses in the done category; some of them mean
  // "work finished but not shipped yet" — those must not be struck through.
  for (const st of ["Ready For Release", "Awaiting Release", "Pending for Release",
                    "Waiting for Release", "Waiting for SDK Release"]) {
    assert.equal(releaseState(st, {}), "pending", st);
  }
});

test("releaseState: cancelled/rejected is its own bucket — not pending", () => {
  assert.equal(releaseState("Rejected", {}), "cancelled");
  assert.equal(releaseState("Cancelled", {}), "cancelled");
});

test("releaseState: matching ignores case and surrounding whitespace", () => {
  assert.equal(releaseState("  released on prod ", {}), "finished");
});

test("releaseState: the pending list can be extended from config", () => {
  const cfg = { pendingReleaseStatuses: ["Ready For Release", "Monitoring"] };
  assert.equal(releaseState("Monitoring", cfg), "pending");
  assert.equal(releaseState("Monitoring", {}), "finished");   // not in the default
});

test("releaseState: a string instead of an array in config falls back to the default", () => {
  // Writing `"finishedStatuses": "Released on Prod"` in a hand-edited config.json
  // blew up .some and dropped the WHOLE payload — the widget stayed on the error screen.
  assert.equal(releaseState("Ready For Release", { pendingReleaseStatuses: "Ready For Release" }), "pending");
  assert.equal(releaseState("Released on Prod", { pendingReleaseStatuses: 42 }), "finished");
});

test("releaseState: a missing status falls to finished (fail-closed) instead of throwing", () => {
  assert.equal(releaseState(null, {}), "finished");
  assert.equal(releaseState(undefined, undefined), "finished");
});

test("prBlockers: clean CI but awaiting review still blocks the PR (the real case)", () => {
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED" });
  assert.equal(r.rank, 2, "cannot be merged even with the required checks passing");
  assert.deepEqual(r.reasons, ["awaiting review"]);
});

test("prBlockers: a conflict blocks the merge (even with clean CI and an approval)", () => {
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: "APPROVED", mergeable: "CONFLICTING" });
  assert.equal(r.rank, 3);
  assert.ok(r.reasons.some((x) => x.includes("conflict")));
});

test("prBlockers: mergeable UNKNOWN does NOT count as a conflict (GitHub is lazy)", () => {
  // Measured live: 3 of 15 PRs returned UNKNOWN on the first query and MERGEABLE
  // on the second. Treating UNKNOWN as a conflict would be a direct false alarm.
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: null, mergeable: "UNKNOWN" });
  assert.deepEqual(r, { rank: 0, reasons: [] });
});

test("prBlockers: a missing mergeable field (older data) produces no blocker", () => {
  assert.deepEqual(prBlockers({ ciState: "SUCCESS", reviewDecision: null }),
                   { rank: 0, reasons: [] });
});

test("prBlockers: conflict + broken CI together, both listed as reasons", () => {
  const r = prBlockers({ ciState: "FAILURE", failingRequired: ["build"],
                         reviewDecision: null, mergeable: "CONFLICTING" });
  assert.equal(r.rank, 3);
  assert.equal(r.reasons.length, 2);
});

test("prBlockers: nothing blocks when review is not required (null)", () => {
  assert.deepEqual(prBlockers({ ciState: "SUCCESS", reviewDecision: null }),
    { rank: 0, reasons: [] });
  assert.equal(prBlockers({ ciState: "SUCCESS", reviewDecision: "APPROVED" }).rank, 0);
});

test("prBlockers: changes requested needs action (rank 3)", () => {
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: "CHANGES_REQUESTED" });
  assert.equal(r.rank, 3);
  assert.deepEqual(r.reasons, ["changes requested"]);
});

test("prBlockers: when CI and review both block, both are listed", () => {
  const r = prBlockers({
    ciState: "FAILURE", failingRequired: ["ESLintChecker"],
    reviewDecision: "REVIEW_REQUIRED",
  });
  assert.equal(r.rank, 3, "the heaviest blocker wins");
  assert.deepEqual(r.reasons, ["CI: ESLintChecker", "awaiting review"]);
});

test("prBlockers: CI pending with an approved review is still waiting", () => {
  const r = prBlockers({
    ciState: "PENDING", pendingRequired: ["AI Code Review"], reviewDecision: "APPROVED",
  });
  assert.equal(r.rank, 2);
  assert.deepEqual(r.reasons, ["CI: AI Code Review"]);
});

test("summarizePrs: an unblocked PR does not stay stateless (the rank 0 trap)", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-5 | a", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "r", number: 1 },
  ]);
  assert.equal(byKey["DEMO-5"].state, "SUCCESS", "with nothing blocking it must look green, not null");
});

test("summarizePrs: at the same rank an unknown state is filled by a known one", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-6 | a", ciState: null, reviewDecision: "APPROVED", repo: "r", number: 1 },
    { title: "DEMO-6 | b", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "r", number: 2 },
  ]);
  assert.equal(byKey["DEMO-6"].state, "SUCCESS");
});

test("summarizePrs: a PR awaiting review turns the task badge amber", () => {
  const { byKey, waiting } = summarizePrs([
    { title: "DEMO-9 | a", ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED", repo: "shared-lib", number: 320 },
  ]);
  assert.equal(byKey["DEMO-9"].state, "PENDING");
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].checks, ["awaiting review"]);
});

// --- Draft PRs: your own drafts must not look like they need action ---
// Measured live: 7 of 8 open PRs were drafts and 5 were REVIEW_REQUIRED, so they
// filled the WAITING band on their own — the one real item was lost among them.

test("summarizePrs: a draft PR does NOT enter waiting even when review is requested (the real case)", () => {
  const { waiting } = summarizePrs([
    { title: "DEMO-29638 | mobile-client", ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED",
      isDraft: true, repo: "mobile-client", number: 4384 },
  ]);
  assert.deepEqual(waiting, []);
});

test("summarizePrs: a draft PR with broken CI does NOT enter broken (and plays no sound)", () => {
  const { broken } = summarizePrs([
    { title: "DEMO-20 | a", ciState: "FAILURE", failingRequired: ["build"],
      isDraft: true, repo: "shared-lib", number: 1 },
  ]);
  assert.deepEqual(broken, []);
});

test("summarizePrs: a draft PR COUNTS in the badge but produces no state (stays grey)", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-21 | a", ciState: "FAILURE", reviewDecision: "REVIEW_REQUIRED",
      isDraft: true, repo: "shared-lib", number: 1 },
  ]);
  assert.equal(byKey["DEMO-21"].count, 1, "started work must remain visible");
  assert.equal(byKey["DEMO-21"].state, null, "a draft says nothing green/amber/red");
});

test("summarizePrs: draft + real PR together — count covers both, state reflects the real one", () => {
  const { byKey, waiting } = summarizePrs([
    { title: "DEMO-22 | draft", ciState: "FAILURE", isDraft: true, repo: "shared-lib", number: 1 },
    { title: "DEMO-22 | ready", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "shared-lib", number: 2 },
  ]);
  assert.equal(byKey["DEMO-22"].count, 2);
  assert.equal(byKey["DEMO-22"].state, "SUCCESS", "a draft's broken CI must not turn the badge red");
  assert.deepEqual(waiting, []);
});

// Regression: state assignment recognises the "first PR" via a counter. Because
// drafts bumped the counter and skipped the assignment, a draft first in the list
// left the second (real) PR stateless — while rank is 0, "rank > entry.rank" never holds.
test("summarizePrs: with a draft FIRST, the next real PR's state still reaches the badge", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-23 | draft", ciState: "SUCCESS", isDraft: true, repo: "shared-lib", number: 1 },
    { title: "DEMO-23 | ready", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "shared-lib", number: 2 },
  ]);
  assert.equal(byKey["DEMO-23"].state, "SUCCESS", "a leading draft must not leave the real PR stateless");
});

test("summarizePrs: a waiting PR lands in waiting, a broken one in broken", () => {
  const { broken, waiting } = summarizePrs([
    { title: "DEMO-1 | x", ciState: "PENDING", pendingRequired: ["AI Code Review"], repo: "backend-api", number: 1166 },
    { title: "DEMO-2 | y", ciState: "FAILURE", failingRequired: ["build"], repo: "hb", number: 1 },
    { title: "DEMO-3 | z", ciState: "SUCCESS", repo: "shared-lib", number: 2 },
  ]);
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].checks, ["CI: AI Code Review"]);
  assert.equal(waiting[0].repo, "backend-api");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].repo, "hb");
});

test("requiredRollup: for a re-run check only the LATEST run counts, measured live", () => {
  const r = requiredRollup([
    { name: "ESLintChecker", conclusion: "CANCELLED", isRequired: true, completedAt: "2026-08-20T09:00:00Z" },
    { name: "pr-linter", conclusion: "CANCELLED", isRequired: true, completedAt: "2026-08-20T09:00:00Z" },
    { name: "ESLintChecker", conclusion: "SUCCESS", isRequired: true, completedAt: "2026-08-20T11:00:00Z" },
    { name: "pr-linter", conclusion: "SUCCESS", isRequired: true, completedAt: "2026-08-20T11:00:00Z" },
  ]);
  assert.equal(r.state, "SUCCESS", "a cancelled older run must not count as broken");
  assert.deepEqual(r.failing, []);
  assert.equal(r.requiredCount, 2, "the same check must not be counted twice");
});

test("requiredRollup: without timestamps, later-in-list is treated as newer", () => {
  const r = requiredRollup([
    { name: "build", conclusion: "CANCELLED", isRequired: true },
    { name: "build", conclusion: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "SUCCESS");
});

test("requiredRollup: a genuinely broken latest run is caught", () => {
  const r = requiredRollup([
    { name: "build", conclusion: "SUCCESS", isRequired: true, completedAt: "2026-08-20T09:00:00Z" },
    { name: "build", conclusion: "FAILURE", isRequired: true, completedAt: "2026-08-20T11:00:00Z" },
  ]);
  assert.equal(r.state, "FAILURE", "a broken later run must raise a warning");
  assert.deepEqual(r.failing, ["build"]);
});

test("requiredRollup: a CANCELLED required check counts as a failure", () => {
  const r = requiredRollup([{ name: "build", conclusion: "CANCELLED", isRequired: true }]);
  assert.equal(r.state, "FAILURE");
  assert.deepEqual(r.failing, ["build"]);
});

test("requiredRollup: with no required checks the state is unknown (null), no warning", () => {
  assert.deepEqual(requiredRollup([{ name: "x", conclusion: "FAILURE", isRequired: false }]),
    { state: null, failing: [], pending: [], requiredCount: 0 });
  assert.deepEqual(requiredRollup([]), { state: null, failing: [], pending: [], requiredCount: 0 });
  assert.deepEqual(requiredRollup(null), { state: null, failing: [], pending: [], requiredCount: 0 });
});

test("extractIssueKey: pulls the key out of a PR title", () => {
  assert.equal(extractIssueKey("DEMO-146311 | Gate app-template Liquid"), "DEMO-146311");
  assert.equal(extractIssueKey("[ DONT MERGE ] -  DEMO-29095 | Point release"), "DEMO-29095");
  assert.equal(extractIssueKey("chore: bump deps"), null);
  assert.equal(extractIssueKey(null), null);
});

test("summarizePrs: one broken PR makes the task badge broken", () => {
  const { byKey, broken } = summarizePrs([
    { title: "DEMO-146311 | a", ciState: "SUCCESS", repo: "def", number: 327 },
    { title: "DEMO-146311 | b", ciState: "FAILURE", repo: "web-frontend", number: 4608 },
    { title: "DEMO-146311 | c", ciState: "SUCCESS", repo: "shared-lib", number: 320 },
  ]);
  assert.equal(byKey["DEMO-146311"].count, 3);
  assert.equal(byKey["DEMO-146311"].state, "FAILURE", "the worst state wins");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].repo, "web-frontend");
});

test("summarizePrs: PENDING overrides SUCCESS but cannot override FAILURE", () => {
  const a = summarizePrs([
    { title: "AB-1 | a", ciState: "SUCCESS" }, { title: "AB-1 | b", ciState: "PENDING" },
  ]);
  assert.equal(a.byKey["AB-1"].state, "PENDING");
  const b = summarizePrs([
    { title: "AB-1 | a", ciState: "PENDING" }, { title: "AB-1 | b", ciState: "FAILURE" },
  ]);
  assert.equal(b.byKey["AB-1"].state, "FAILURE");
});

test("summarizePrs: a PR without a key gets no task badge, empty input does not crash", () => {
  const r = summarizePrs([{ title: "chore: bump", ciState: "FAILURE" }]);
  assert.deepEqual(r.byKey, {});
  assert.deepEqual(summarizePrs(null), { byKey: {}, broken: [], waiting: [] });
});

test("summarizePrs: an unknown/null CI state does not break the count", () => {
  const r = summarizePrs([{ title: "AB-1 | a", ciState: null }]);
  assert.equal(r.byKey["AB-1"].count, 1);
  assert.equal(r.byKey["AB-1"].state, null);
  assert.equal(r.broken.length, 0);
});

test("addNote: an empty / whitespace-only note is not added", () => {
  const t = at("2026-08-20");
  assert.deepEqual(addNote([], "", t), []);
  assert.deepEqual(addNote([], "   ", t), []);
  assert.deepEqual(addNote([], null, t), []);
  const one = addNote([], "check after deploy", t);
  assert.equal(one.length, 1);
  assert.equal(one[0].text, "check after deploy");
});

test("addNote: surrounding whitespace is trimmed", () => {
  const n = addNote([], "   ask in standup   ", at("2026-08-20"));
  assert.equal(n[0].text, "ask in standup");
});

test("addNote: when the list is full the OLDEST note drops", () => {
  let notes = [];
  for (let i = 1; i <= MAX_NOTES + 2; i++) {
    notes = addNote(notes, `note ${i}`, at("2026-08-20"));
  }
  assert.equal(notes.length, MAX_NOTES);
  assert.equal(notes[0].text, "note 3", "the first two notes must drop");
  assert.equal(notes[notes.length - 1].text, `note ${MAX_NOTES + 2}`);
});

test("addNote: an over-long note is truncated", () => {
  const n = addNote([], "x".repeat(600), at("2026-08-20"));
  assert.equal(n[0].text.length, NOTE_LIMIT);
  assert.equal(NOTE_LIMIT, 500);
});

test("addNote: a 300-character note is kept whole", () => {
  const text = "a long sentence ".repeat(19).slice(0, 300);
  assert.equal(text.length, 300);
  assert.equal(addNote([], text, at("2026-08-20"))[0].text, text.trim());
});

test("NOTE_LIMIT: the Swift save limit and the note field's maxlength match lib.mjs", () => {
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  assert.equal(Number(swift.match(/^let NOTE_LIMIT = (\d+)$/m)?.[1]), NOTE_LIMIT);
  assert.equal(Number(sprints.match(/class="ninput"[^>]*maxlength="(\d+)"/)?.[1]), NOTE_LIMIT,
    "typing must stop where saving would cut");
});

test("setup screen: a transparent page around a card panel, sized to the card, as on the board", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const [name, page, height] of [
    ["popover/sprints.html", read("./popover/sprints.html"), /post\(\{ height: card\.offsetHeight \}\)/],
    ["setup.html", read("./setup.html"), /post\(\{ height: \$\("card"\)\.offsetHeight \}\)/],
  ]) {
    // A background on <body> paints the whole square window; the rounded panel needs its own element.
    assert.match(page, /html, body \{[^}]*background: transparent/, name);
    assert.match(page, /<div id="card">/, name);
    assert.match(page, height, `${name} reports the card's height`);
    assert.doesNotMatch(page, /scrollHeight \+/, name);
  }
});

test("setup screen: its card radius, and no shadow outside the card", () => {
  const card = (f) => readFileSync(new URL(f, import.meta.url), "utf8").match(/#card \{([^}]*)\}/)?.[1] ?? "";
  const setup = card("./setup.html");
  const radius = (css) => css.match(/border-radius: ?([^;]+);/)?.[1];
  assert.equal(radius(setup), "10px");
  // The window is cut exactly to the card, so an outer shadow can only show in the corners
  // outside the curve, as a dark tip with a square edge. Only an inset shadow is allowed.
  const shadow = setup.match(/box-shadow: ?([^;]+);/)?.[1] ?? "";
  for (const layer of shadow.split(/,(?![^(]*\))/).filter((l) => l.trim())) {
    assert.match(layer, /\binset\b/, `setup.html: outer shadow "${layer.trim()}"`);
  }
});

test("setup screen: the window material is rounded with the card's radius", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const swift = Number(read("./SprintBoard.swift").match(/^let CARD_RADIUS: CGFloat = (\d+)$/m)?.[1]);
  assert.ok(swift > 0, "CARD_RADIUS not found");
  const css = read("./setup.html").match(/#card \{([^}]*)\}/)?.[1] ?? "";
  assert.equal(css.match(/border-radius: ?([^;]+);/)?.[1], `${swift}px`);
});

test("setup screen: its panel colours and window buttons", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  // Tokens per scheme ("light" before the dark media query, "dark" inside it) and selector.
  const tokens = (page) => {
    const [light, dark] = page.split("@media (prefers-color-scheme: dark)");
    assert.ok(dark !== undefined, "no dark media query");
    const out = {};
    for (const [scheme, css] of [["light", light], ["dark", dark.slice(0, dark.indexOf("\n  }"))]]) {
      for (const [, sel, body] of css.matchAll(/(:root) \{([^}]*)\}/g)) {
        for (const [, name, value] of body.matchAll(/(--[\w-]+): ?([^;}]+?)\s*(?:;|$)/g)) {
          out[`${scheme} ${sel} ${name}`] = value;
        }
      }
    }
    return out;
  };
  const buttons = (page) => Object.fromEntries([...page.matchAll(/(?:\.hdr )?(\.tl[\w.:-]*) \{([^}]*)\}/g)]
    .map(([, sel, body]) => [sel, body.replace(/\s+/g, " ").replace(/\s*([:;])\s*/g, "$1").trim()]));
  const setup = read("./setup.html");
  const ts = tokens(setup);
  for (const key of ["light :root --panel", "light :root --fill",
    "dark :root --panel", "dark :root --fill"]) {
    assert.ok(key in ts, `${key} missing`);
  }
  assert.deepEqual(Object.keys(buttons(setup)).sort(), [".tl", ".tl.close", ".tl.fill", ".tl.min", ".tl:hover"]);
});

test("both screens: the page function Swift calls after fill mode exists", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  // Swift guards the call with `&&`, so a renamed function would fail silently.
  assert.match(read("./SprintBoard.swift"), /evaluateJavaScript\("window\.sbFit && window\.sbFit\(\)"\)/);
  assert.match(read("./setup.html"), /^\s*window\.sbFit = /m);
  // The tab pages get theirs from the widget's page script.
  assert.match(read("./SprintBoard.swift"), /^let WIDGET_PAGE_SCRIPT = [\s\S]*?^\s*window\.sbFit = /m);
});

test("both screens: a trackpad swipe does not pull the card off the window", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const f of ["./popover/sprints.html", "./popover/settings.html", "./setup.html"]) {
    assert.match(read(f), /^\s*html \{[^}]*\boverscroll-behavior: none;/m, f);
  }
});

test("board page: the page has no window buttons of its own, and a tall board scrolls", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  // The tab header holds the window buttons; the page shows the window material behind the board.
  assert.doesNotMatch(sprints, /class="lights"|data-win/);
  assert.match(sprints, /#card \{ padding: 14px 16px 16px; \}/);
  assert.match(sprints, /html, body \{[^}]*overflow-y: auto;/);
});

test("board page: the page takes the Hosts tab's greys", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const css = sprints.slice(0, sprints.indexOf("</style>"));
  assert.match(css, /--t1: rgba\(255,255,255,\.96\); --t2: rgba\(255,255,255,\.8\); --t3: rgba\(255,255,255,\.62\);/);
  // A system grey written directly would fade on the window material.
  assert.doesNotMatch(css, /-apple-system-(secondary|tertiary)-label/);
});

test("board page: every status folds, and Done and Released on Prod start folded", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  // The team goal's tasks open from its card, below the cards; they start folded.
  assert.match(sprints, /const open = isOpen\("goals", false\);/);
  assert.match(sprints, /\$\{g && isOpen\("goals", false\) \? foldBody\("goals", goalPanel\(g\)\) : ""\}/);
  // Work still tracked (phase 0 and 1) starts open; finished and cancelled (phase 2 and 3) folded.
  assert.match(sprints, /const key = "status:" \+ g\.status;\n\s*const open = isOpen\(key, g\.phase < 2\);/);
  // A click flips what the list shows now (a second click while it moves too), so a list open
  // by default can be folded.
  assert.match(sprints, /toggleFold\(el\.dataset\.fold, isOpen\(el\.dataset\.fold, el\.dataset\.open === "1"\)\);/);
  // The task's age stays in the row's tooltip; the popover has no age column.
  assert.doesNotMatch(sprints, /class="age"/);
  const start = sprints.indexOf("  const FOLD = new Map();");
  const end = sprints.indexOf("\n", sprints.indexOf("  const isOpen = ", start));
  const isOpen = new Function(`${sprints.slice(start, end)}\nreturn { FOLD, isOpen };`)();
  assert.equal(isOpen.isOpen("status:Done", false), false);
  assert.equal(isOpen.isOpen("status:In Review", true), true);
  isOpen.FOLD.set("status:In Review", false);
  assert.equal(isOpen.isOpen("status:In Review", true), false);
});

test("board page: in the panel a list folds and opens with motion, and the popover gets its final height once", async () => {
  const view = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  assert.match(view, /\$\{open \? foldBody\(key, g\.tasks\.map\(taskRow\)\.join\(""\)\) : ""\}/);
  assert.match(view, /const foldBody = \(key, html\) => `<div class="fold-body" data-body="\$\{esc\(key\)\}">\$\{html\}<\/div>`;/);
  // clip, not hidden: the rows' margins still merge with the next header's, so nothing moves.
  assert.match(view, /\.fold-body \{ overflow: clip; \}/);
  assert.match(view, /const fit = \(\) => \{\n\s*if \(foldMoving\) return;/);
  assert.match(view, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\* \{ transition: none !important; \}/);
  const start = view.indexOf("  const FOLD_MOTION = ");
  const end = view.indexOf("\n  };", view.indexOf("  const toggleFold = ", start));
  assert.ok(start > 0 && end > start);
  const KEY = "status:In Review";
  // A card 723 px high with the list open, 698 with it gone and 702 with it squeezed to 0:
  // the 4 px are the margins that merge once the list is gone.
  const make = ({ reduced = false, listShown = true } = {}) => {
    const log = [];
    const runs = [];
    let shown = listShown;
    const body = {
      offsetHeight: 21, style: { cssText: "" }, getAnimations: () => [],
      animate: (frames, options) => {
        log.push(["fold", frames.map((f) => `${f.height} ${f.marginBottom}`), options.fill ?? "none"]);
        return { finished: new Promise((resolve, reject) => runs.push({ resolve, reject })) };
      },
    };
    const chevron = { animate: (frames) => log.push(["turn", frames.map((f) => f.transform)]) };
    const card = {
      get offsetHeight() {
        if (!shown || body.style.cssText === "display: none") return 698;
        return body.style.cssText === "height: 0" ? 702 : 723;
      },
      querySelector: (selector) => selector.startsWith("[data-body") ? (shown ? body : null) : chevron,
    };
    const FOLD = new Map();
    const env = {
      FOLD, LAST: {}, CSS: { escape: (text) => text },
      draw: () => { shown = FOLD.get(KEY); log.push(["draw"]); },
      fit: () => log.push(["fit"]),
      matchMedia: () => ({ matches: reduced }),
      post: (message) => log.push(["post", message.height]),
      document: { getElementById: () => card },
    };
    const toggleFold = new Function(...Object.keys(env), `let foldMoving = false;\n${view.slice(start, end + 5)}\nreturn toggleFold;`)(...Object.values(env));
    return { toggleFold, log, runs };
  };
  const settled = () => new Promise(setImmediate);

  const closing = make();
  closing.toggleFold(KEY, true);
  assert.deepEqual(closing.log, [["post", 698], ["turn", ["rotate(0deg)", "rotate(180deg)"]], ["fold", ["21px 0px", "0px -4px"], "forwards"]]);
  closing.runs[0].resolve();
  await settled();
  assert.deepEqual(closing.log.slice(3), [["draw"], ["fit"]]);

  const opening = make({ listShown: false });
  opening.toggleFold(KEY, false);
  assert.deepEqual(opening.log, [["draw"], ["post", 723], ["turn", ["rotate(180deg)", "rotate(0deg)"]], ["fold", ["0px -4px", "21px 0px"], "none"]]);
  opening.runs[0].resolve();
  await settled();
  assert.deepEqual(opening.log.slice(4), [["fit"]]);

  const still = make({ reduced: true });
  still.toggleFold(KEY, true);
  assert.deepEqual(still.log, [["draw"]]);

  // A second click while the list folds opens it again: the fold still ends, on rows already
  // replaced, and must not draw the list again.
  const reopened = make();
  reopened.toggleFold(KEY, true);
  reopened.toggleFold(KEY, false);
  reopened.runs[0].resolve();
  reopened.runs[1].resolve();
  await settled();
  assert.deepEqual(reopened.log.filter(([kind]) => kind === "draw" || kind === "fit"), [["draw"], ["fit"]]);

  // A second click while the list opens folds it again: the opening is cancelled and settles nothing.
  const refolded = make({ listShown: false });
  refolded.toggleFold(KEY, false);
  refolded.toggleFold(KEY, true);
  refolded.runs[0].reject(new Error("AbortError"));
  refolded.runs[1].resolve();
  await settled();
  assert.deepEqual(refolded.log.filter(([kind]) => kind === "draw" || kind === "fit"), [["draw"], ["draw"], ["fit"]]);
});

test("board page: the goal counts leave out the empty ones and each row fades from its risk colour", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const start = sprints.indexOf("  const RISK_WORD = {");
  const end = sprints.indexOf("\n  const goalPanel = ", start);
  assert.ok(start > 0 && end > start);
  const esc = (text) => String(text);
  const { goalPills, goalRows } = new Function("esc", `${sprints.slice(start, end)}\nreturn { goalPills, goalRows };`)(esc);
  const pills = goalPills({ red: 2, yellow: 0, ok: 0, done: 1 });
  assert.equal((pills.match(/class="gpill /g) || []).length, 2);
  assert.match(pills, /<span class="gpill red" title="Critical for its stage: too few working days left for where it is">2 critical<\/span>/);
  assert.match(pills, /<span class="gpill done" title="Done in Jira">1 done<\/span>/);
  assert.doesNotMatch(pills, /at risk|on track/);
  const row = goalRows([{ risk: "yellow", key: "DEMO-101", summary: "Task", owner: "Ada Yilmaz", ownerShort: "Ada", status: "Design Testing In Progress", stage: "Design UAT", url: "#" }]);
  assert.match(row, /<div class="grow yellow"/);
  // Two pills of one style: the board column and the owner's first name; both in full in the tooltip.
  assert.match(row, /<span class="gstat">Design UAT<\/span>\s*<span class="gstat">Ada<\/span>/);
  assert.match(row, /title="Task&#10;Design Testing In Progress · Ada Yilmaz"/);
  assert.doesNotMatch(row, /class="dot/);
  const bare = goalRows([{ risk: "ok", key: "DEMO-102", summary: "Task", owner: null, ownerShort: "", status: "Something New", stage: "", url: "#" }]);
  assert.match(bare, /<span class="gstat">Something New<\/span>/, "without a column the pill shows the status");
  assert.match(bare, /<span class="gstat">Unassigned<\/span>/);
  // The pills stay at 18 px (a 20 px circle made every row 3 px taller), with 11 px text on white 10%,
  // as the Hosts tab's group pills.
  assert.match(sprints, /\.gstat \{[^}]*height: 18px; line-height: 18px;[^}]*font-size: 11px; color: var\(--t2\); background: rgba\(255,255,255,\.1\); \}/);
  assert.doesNotMatch(sprints, /gwho/);
  assert.match(sprints, /\.gpills \{ display: flex; gap: 6px; margin: 0 0 4px; \}/);
  assert.match(sprints, /\.gpanel \{ margin-top: 8px; padding: 4px; border-radius: 10px;/);
  assert.match(sprints, /return `<div class="gpanel"><div class="gpills">\$\{goalPills\(goalCounts\(g\)\)\}<\/div>\$\{goalRows\(g\.rows\)\}<\/div>`;/);
  // No strip on the left: the risk colour fades in from the left instead, the other way round to the task rows.
  assert.doesNotMatch(sprints, /\.grow::before/);
  // Hovered, a row turns a flat light grey, strong enough to stand out next to the coloured rows.
  assert.match(sprints, /\.grow:hover \{ background: var\(--hover\); \}/);
  assert.match(sprints, /\.grow \{[^}]*padding: 2px 2px 2px 6px; margin: 2px 0px 0;[^}]*background: linear-gradient\(90deg, color-mix\(in srgb, var\(--risk\) 22%, transparent\), transparent\); \}/);
  for (const [risk, colour] of [["red", "red"], ["yellow", "yellow"], ["ok", "gray"], ["done", "green"]]) {
    assert.match(sprints, new RegExp(`\\.grow\\.${risk} \\{ --risk: -apple-system-${colour}; \\}`), risk);
  }
});

test("board page: in the panel a row's gradient ends in its icon's colour", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  // One rule for the task, past-sprint and GitHub rows; white when the icon has no colour.
  assert.match(sprints, /\.row, \.brow, \.item \{[^}]*--icon: #fff;\s*background: linear-gradient\(90deg, transparent, color-mix\(in srgb, var\(--icon\) 8%, transparent\)\); \}/);
  // Every colour an icon class can carry has its gradient colour.
  for (const c of ["red", "orange", "yellow", "green", "blue", "purple", "gray"]) {
    assert.match(sprints, new RegExp(`:is\\(\\.row, \\.brow, \\.item\\):has\\(> \\.sym\\.c-${c}\\) \\{ --icon: -apple-system-${c}; \\}`), c);
  }
});

test("board page: the icon of work under way follows its status", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const of = (page, prefix) => {
    const start = page.indexOf("  const workIcon = (t) => {");
    const end = page.indexOf("\n  };", start);
    assert.ok(start > 0 && end > start);
    return new Function(`${prefix} const sym = (name) => name;\n${page.slice(start, end + 5)}\nreturn workIcon;`)();
  };
  const icon = of(sprints, "");
  assert.equal(icon({ status: "In Review" }), "eye");
  assert.equal(icon({ status: "Code Review" }), "eye");
  assert.equal(icon({ status: "IN TESTING" }), "checklist");
  assert.equal(icon({ status: "Ready To Test" }), "checklist");
  assert.equal(icon({ status: "Design UAT" }), "checklist");
  assert.equal(icon({ status: "In Progress" }), "circle.lefthalf.filled");
});

test("board page: the header holds the buttons, cards replace the bars, and every PR stays reachable", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  // The buttons sit in the header.
  assert.match(sprints, /<div class="hdr">\s*<span class="name">[^\n]*<\/span>\s*<span class="tools"><span class="rf expand" id="rf"/);
  assert.match(sprints, /\$\{topHtml\(d\)\}/);
  // The refresh button shows the data's age when hovered, kept current while the popover is open.
  assert.match(sprints, /<span class="when" id="ago">Updated \$\{ago\(d\.generatedAt\)\}<\/span>/);
  assert.match(sprints, /el\.textContent = "Updated " \+ ago\(LAST\.generatedAt\)/);
  assert.match(sprints, /\.rf\.expand:hover \.when \{ max-width: 140px; opacity: 1; margin-right: 6px; \}/);
  // The header buttons match the Hosts tab's: 30 x 26 boxes, 16 px icons.
  assert.match(sprints, /\.rf \{[^}]*width: 30px; height: 26px;\s*border-radius: 6px;[^}]*\}\n\s*\.rf \.sym \{ width: 16px; height: 16px; \}/);
  assert.match(readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8"), /\.icon \{ width: 30px; height: 26px;[\s\S]*?\.icon svg \{ display: block; width: 16px; height: 16px; \}/);
  // Text in a task row sits on one baseline, so a small "no PR" lines up with the day count.
  assert.match(sprints, /\.row \{ align-items: baseline; \}/);
  // No state word: PR numbers that do not fit wrap instead of being cut off.
  assert.doesNotMatch(sprints, /class="w"/);
  assert.match(sprints, /\.rp \{ flex: 1; min-width: 0; text-align: right; font-size: 11px; \}/);
  // A merged PR shows the merge mark and a deployed one a globe; the day count's tooltip also
  // gives the task's age.
  const start = sprints.indexOf("  const PR_STATE_MARK = ");
  const end = sprints.indexOf("\n", sprints.indexOf("  const prStateMark = ", start));
  assert.ok(start > 0 && end > start);
  const mark = new Function(`const sym = (name, cls) => name + "/" + cls;\n${sprints.slice(start, end)}\nreturn prStateMark;`)();
  assert.equal(mark("merged"), "arrow.triangle.merge/sm");
  assert.equal(mark("deployed"), "globe/sm");
  assert.equal(mark("open"), "");
  assert.match(sprints, /#\$\{esc\(p\.number\)\}\$\{prMark\(p\.ci\)\}\$\{prStateMark\(p\.status\)\}<\/span>/);
  assert.match(sprints, /<span class="d" title="[^"]*&#10;opened \$\{t\.ageDays\} business days ago">/);
});

test("board page: in the panel every section header under MY TASKS and GITHUB looks the same", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  assert.match(sprints, /<div class="h">My tasks/);
  // Main headers and the section headers under them differ in brightness, weight and case.
  assert.match(sprints, /\.h \{ display: flex;[^}]*font-size: 11px; font-weight: 700;\s*letter-spacing: \.1em; text-transform: uppercase; color: var\(--t1\); \}/);
  assert.match(sprints, /\.ghd \{ display: flex;[^}]*font-weight: 500; color: var\(--t3\); \}/);
  // The past sprints' header is a section header, without its icon.
  assert.match(sprints, /<div class="ghd">Past sprints · awaiting release/);
  // GITHUB and NOTES are main headers like MY TASKS; no zone header, no separators.
  assert.match(sprints, /<div class="h">GitHub\$\{count\}<\/div>/);
  assert.match(sprints, /<div class="h">Notes /);
  assert.doesNotMatch(sprints, /zone|<hr/);
});

test("panel tabs: the Sprint and Hosts tabs share one list text size, 13 px", () => {
  assert.match(readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8"), /body \{ font: 13px -apple-system/);
  assert.match(readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8"), /body \{\s*font: 13px\/1\.35 -apple-system/);
});

test("board page: the panel shows how old the data is, not a time that reads as the clock", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const start = sprints.indexOf("  const ago = (iso) => {");
  const end = sprints.indexOf("\n  };", start);
  assert.ok(start > 0 && end > start);
  const ago = new Function(`${sprints.slice(start, end + 5)}\nreturn ago;`)();
  const before = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  assert.equal(ago(before(0)), "just now");
  assert.equal(ago(before(12)), "12 min ago");
  assert.equal(ago(before(59)), "59 min ago");
  assert.equal(ago(before(90)), "1 h ago");
});

test("board page: GitHub splits into what needs you and what waits on others", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const start = sprints.indexOf("  const githubSplit = (d) => {");
  const end = sprints.indexOf("\n  };", start);
  assert.ok(start > 0 && end > start);
  const githubSplit = new Function(`${sprints.slice(start, end + 5)}\nreturn githubSplit;`)();
  const split = githubSplit({
    reviewRequests: [{ number: 1 }], waitingPrs: [{ number: 2 }],
    pullRequests: [{ number: 3, kind: "conflict" }, { number: 4, kind: "checking" }],
  });
  assert.deepEqual(split.reviews.map((p) => p.number), [1]);
  assert.deepEqual(split.blocked.map((p) => p.number), [3]);
  assert.deepEqual(split.waiting.map((p) => p.number), [2]);
  // GitHub has not settled the merge state yet: nothing for you to do.
  assert.deepEqual(split.checking.map((p) => p.number), [4]);
  assert.deepEqual(githubSplit({}), { reviews: [], blocked: [], waiting: [], checking: [] });
  const from = sprints.indexOf("  const ghItem = ");
  const to = sprints.indexOf("\n  };", sprints.indexOf("  const githubHtml = ", from));
  const stubs = { esc: (t) => String(t), sym: (name) => `[${name}]`, isOpen: (key, byDefault) => key !== "github:waiting" && byDefault,
    foldHeader: (cls, key, open, label) => `<div class="${cls} fold" data-fold="${key}" data-open="${open ? 1 : 0}">${label}</div>`,
    foldBody: (key, html) => html };
  const githubHtml = new Function(...Object.keys(stubs), `${sprints.slice(start, end + 5)}\n${sprints.slice(from, to + 5)}\nreturn githubHtml;`)(...Object.values(stubs));
  const html = githubHtml({
    reviewRequests: [{ number: 1, repo: "a", author: "Ada", days: 3 }], waitingPrs: [{ number: 2, repo: "b", checks: ["review"] }],
    pullRequests: [{ number: 3, repo: "c", kind: "conflict", reasons: ["conflict"] }, { number: 4, repo: "d", kind: "checking" }],
  });
  const heads = [...html.matchAll(/<div class="(h|ghd[^"]*)"[^>]*>([^<]*)<span class="n">(\d+)<\/span>/g)].map((m) => `${m[2].trim()} ${m[3]}`);
  // The order: Waiting, Awaiting your review, Merge blocked.
  assert.deepEqual(heads, ["GitHub 4", "Waiting For Review 1", "Awaiting Your Review 1", "Merge Blocked 2"]);
  // A PR GitHub has not settled sits under Merge Blocked, after the blocked ones.
  assert.ok(html.indexOf("Merge Blocked") < html.indexOf("c#3") && html.indexOf("c#3") < html.indexOf("d#4"));
  // A folded section keeps its header and drops its rows.
  assert.match(html, /data-fold="github:waiting" data-open="0">Waiting For Review/);
  assert.doesNotMatch(html, /b#2/);
  assert.match(githubHtml({ prsAvailable: true }), /<div class="h">GitHub<\/div><div class="clear">/);
  assert.match(sprints, /\$\{githubHtml\(d\)\}/);
});

test("board page: every SF Symbol the page names is in the list Swift injects", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const list = read("./SprintBoard.swift").match(/^let PAGE_SYMBOLS = \[([\s\S]*?)^\]/m)?.[1] ?? "";
  const known = new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  // A name missing from the list draws nothing: the page has no other way to get the image.
  const names = (page) => {
    const mapped = [...page.matchAll(/const PR_(?:STATE_)?MARK = \{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((name) => name[1]));
    // A symbol may be picked by a condition: sym(open ? "chevron.up" : "chevron.down", …).
    const named = [...page.matchAll(/sym\((?:[\w.]+ \? )?"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => m.slice(1).filter(Boolean));
    return { mapped, used: named.concat(mapped) };
  };
  const sprints = names(read("./popover/sprints.html"));
  assert.ok(sprints.mapped.includes("arrow.triangle.merge") && sprints.mapped.includes("checkmark"));
  assert.ok(sprints.used.includes("chevron.down") && sprints.used.includes("chevron.up"));
  assert.deepEqual(sprints.used.filter((name) => !known.has(name)), []);
});

test("panel tabs: each tab's page exists and reports its height to its own handler", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const block = read("./SprintBoard.swift").match(/^let PANEL_TABS[^\n]*\n([\s\S]*?)^\]/m)?.[1] ?? "";
  const handlers = { Sprint: "sb", Hosts: "hosts" };
  const tabs = [...block.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(([, title, page]) => ({ title, page, handler: handlers[title] }));
  assert.deepEqual(tabs.map((t) => t.title), ["Sprint", "Hosts"]);
  for (const { page, handler } of tabs) {
    // A page posting to another tab's handler would be ignored, and the panel would stay
    // at its start size. A page may post through a helper bound to its handler.
    const html = read(`./${page}`);
    const direct = new RegExp(`messageHandlers\\?\\.${handler}\\?\\.postMessage\\(\\{ height: `).test(html);
    const viaPost = new RegExp(`const post = \\(message\\) => window\\.webkit\\?\\.messageHandlers\\?\\.${handler}\\?\\.postMessage\\(message\\);`).test(html)
      && /post\(\{ height: /.test(html);
    assert.ok(direct || viaPost, page);
  }
});

test("widget tabs: the Hosts and Settings pages get the SF Symbol style sheet, as the board does", () => {
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  // Without it every icon on the Hosts and Settings pages is blank, while the board looks right.
  const page = swift.match(/func makeTabWebView[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(page, "makeTabWebView not found");
  assert.match(page, /addUserScript\(script\)/);
  assert.match(swift, /if let script = symbolScript\(\) \{ cfg\.userContentController\.addUserScript\(script\) \}\n\n\s*let frame = savedFrame\(\)/);
});

test("signing: a Developer ID build may send Apple Events to Chrome", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  // Under the hardened runtime macOS refuses Apple Events without this entitlement and never
  // asks, so the Chrome refresh after a Hosts switch would fail in every signed build.
  assert.match(read("./app.entitlements"), /<key>com\.apple\.security\.automation\.apple-events<\/key><true\/>/);
  assert.match(read("./build-app.sh"),
    /^\s*codesign --force --timestamp --options runtime --entitlements app\.entitlements --sign "\$DEV_ID" "\$APP"$/m);
});

test("release build: every page is copied into the bundle", () => {
  // A development build reads pages from the repo, so a page missing from this list only
  // breaks the distributed app.
  const script = readFileSync(new URL("./build-app.sh", import.meta.url), "utf8");
  const line = script.match(/^\s*cp (fetch\.mjs [^\n]*)"\$APP\/Contents\/Resources\/"$/m)?.[1] ?? "";
  const copied = line.trim().split(/\s+/);
  const pages = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.deepEqual(pages, ["setup.html"]);
  for (const page of pages) assert.ok(copied.includes(page), `${page} is not in build-app.sh's release copy list`);
  // The popover's pages travel as one folder.
  assert.match(script, /^\s*cp -R popover "\$APP\/Contents\/Resources\/"$/m);
  assert.deepEqual(readdirSync(new URL("./popover/", import.meta.url)).filter((f) => f.endsWith(".html")).sort(), ["hosts.html", "settings.html", "sprints.html"]);
});

test("addNote: every note gets a unique id", () => {
  const t = at("2026-08-20");
  const n = addNote(addNote([], "a", t), "b", t);
  assert.notEqual(n[0].id, n[1].id, "ids must not collide even when added at the same instant");
});

test("removeNote: only the target note is removed, the rest survive", () => {
  const t = at("2026-08-20");
  let n = addNote(addNote(addNote([], "a", t), "b", t), "c", t);
  const target = n[1].id;
  n = removeNote(n, target);
  assert.deepEqual(n.map((x) => x.text), ["a", "c"]);
  assert.deepEqual(removeNote(n, "no-such-id").map((x) => x.text), ["a", "c"]);
  assert.deepEqual(removeNote(null, "x"), []);
});

test("reviewWaitInfo: counts from when it was assigned to YOU, not from PR creation", () => {
  const pr = {
    createdAt: "2026-08-03T09:00:00Z",
    timelineItems: { nodes: [
      { createdAt: "2026-08-19T09:00:00Z", requestedReviewer: { login: "demo-user" } },
    ] },
  };
  const r = reviewWaitInfo(pr, "demo-user", at("2026-08-20"));
  assert.equal(r.days, 1, "opened 16 days ago but assigned yesterday");
});

test("reviewWaitInfo: a request aimed at someone else does not count", () => {
  const pr = {
    createdAt: "2026-08-19T09:00:00Z",
    timelineItems: { nodes: [
      { createdAt: "2026-08-20T09:00:00Z", requestedReviewer: { login: "someone-else" } },
    ] },
  };
  const r = reviewWaitInfo(pr, "demo-user", at("2026-08-20"));
  assert.equal(r.requestedAt, "2026-08-19T09:00:00Z", "falls back to PR creation");
});

test("reviewWaitInfo: a team request (no login) counts", () => {
  const pr = {
    createdAt: "2026-08-01T09:00:00Z",
    timelineItems: { nodes: [
      { createdAt: "2026-08-18T09:00:00Z", requestedReviewer: { name: "platform" } },
    ] },
  };
  const r = reviewWaitInfo(pr, "demo-user", at("2026-08-20"));
  assert.equal(r.requestedAt, "2026-08-18T09:00:00Z");
  assert.equal(r.days, 2);
});

test("reviewWaitInfo: with several requests the LATEST one applies", () => {
  const pr = { createdAt: "2026-08-01T09:00:00Z", timelineItems: { nodes: [
    { createdAt: "2026-08-10T09:00:00Z", requestedReviewer: { login: "demo-user" } },
    { createdAt: "2026-08-19T09:00:00Z", requestedReviewer: { login: "demo-user" } },
  ] } };
  assert.equal(reviewWaitInfo(pr, "demo-user", at("2026-08-20")).days, 1);
});

test("reviewWaitInfo: an empty timeline falls back to PR creation, missing data does not crash", () => {
  assert.equal(reviewWaitInfo({ createdAt: "2026-08-19T09:00:00Z" }, "x", at("2026-08-20")).days, 1);
  assert.deepEqual(reviewWaitInfo(null, "x", at("2026-08-20")), { requestedAt: null, days: null });
});

test("detectAlerts: plays no sound on the first run", () => {
  const now = { overdueKey: "DEMO-1", brokenIds: ["a#1"], reviewIds: ["b#2"] };
  assert.deepEqual(detectAlerts(emptyState(), now), [], "existing items must stay silent at launch");
  assert.deepEqual(detectAlerts(null, now), []);
});

test("detectAlerts: a new overdue task sounds, the same one does not sound again", () => {
  const prev = { initialized: true, overdueKey: null, brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { overdueKey: "DEMO-1", brokenIds: [], reviewIds: [] }), ["overdue"]);
  const same = { initialized: true, overdueKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(same, { overdueKey: "DEMO-1", brokenIds: [], reviewIds: [] }), []);
});

test("detectAlerts: a changed overdue task sounds again", () => {
  const prev = { initialized: true, overdueKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { overdueKey: "DEMO-2", brokenIds: [], reviewIds: [] }), ["overdue"]);
});

test("detectAlerts: an overdue task disappearing makes no sound", () => {
  const prev = { initialized: true, overdueKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { overdueKey: null, brokenIds: [], reviewIds: [] }), []);
});

test("detectAlerts: only NEW broken CI sounds", () => {
  const prev = { initialized: true, overdueKey: null, brokenIds: ["cs#1"], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { overdueKey: null, brokenIds: ["cs#1"], reviewIds: [] }), [],
    "an already-known breakage does not sound again");
  assert.deepEqual(detectAlerts(prev, { overdueKey: null, brokenIds: ["cs#1", "shared-lib#2"], reviewIds: [] }), ["ci"]);
});

test("detectAlerts: a new review request sounds", () => {
  const prev = { initialized: true, overdueKey: null, brokenIds: [], reviewIds: ["r#1"] };
  assert.deepEqual(detectAlerts(prev, { overdueKey: null, brokenIds: [], reviewIds: ["r#1", "r#2"] }), ["review"]);
});

test("detectAlerts: the bossKey that older versions saved still counts as known", () => {
  const prev = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { overdueKey: "DEMO-1", brokenIds: [], reviewIds: [] }), [],
    "the first run after an update must not sound for an already-known task");
  assert.deepEqual(detectAlerts(prev, { overdueKey: "DEMO-2", brokenIds: [], reviewIds: [] }), ["overdue"]);
});

test("alertSound: picks one sound by priority overdue > CI > review", () => {
  const sound = { enabled: true, overdue: "o.aiff", ci: "c.aiff", review: "r.aiff" };
  assert.deepEqual(alertSound(sound, ["review", "ci", "overdue"]), { pick: "overdue", file: "o.aiff" });
  assert.deepEqual(alertSound(sound, ["review", "ci"]), { pick: "ci", file: "c.aiff" });
  assert.deepEqual(alertSound(sound, ["review"]), { pick: "review", file: "r.aiff" });
});

test("alertSound: an older config's boss sound still plays for an overdue task", () => {
  assert.deepEqual(alertSound({ enabled: true, boss: "b.aiff" }, ["overdue"]), { pick: "overdue", file: "b.aiff" });
  assert.deepEqual(alertSound({ enabled: true, boss: "b.aiff", overdue: "o.aiff" }, ["overdue"]),
    { pick: "overdue", file: "o.aiff" }, "the new key wins over the old one");
});

test("alertSound: silent when sound is off, nothing is new, or no file is set", () => {
  assert.equal(alertSound({ enabled: false, overdue: "o.aiff" }, ["overdue"]), null);
  assert.equal(alertSound({ enabled: true, overdue: "o.aiff" }, []), null);
  assert.equal(alertSound(undefined, ["overdue"]), null);
  assert.equal(alertSound({ enabled: true }, ["ci"]), null);
});

test("detectAlerts: several events are reported together", () => {
  const prev = { initialized: true, overdueKey: null, brokenIds: [], reviewIds: [] };
  const now = { overdueKey: "DEMO-9", brokenIds: ["a#1"], reviewIds: ["b#2"] };
  assert.deepEqual(detectAlerts(prev, now), ["overdue", "ci", "review"]);
});

test("firstName: takes the first name, shortens long ones, tolerates empty", () => {
  assert.equal(firstName("Ada Yilmaz"), "Ada");
  assert.equal(firstName("Kerem Demir"), "Kerem");
  assert.equal(firstName("Mahmut Mustafa Uyan"), "Mahmut");
  assert.equal(firstName("Konstantinopolis Yilmaz"), "Konstant…", "a first name over 9 chars is shortened");
  assert.equal(firstName("Sol"), "Sol");
  assert.equal(firstName(null), "");
  assert.equal(firstName("   "), "");
});

test("firstName: an alias from config replaces the Jira name", () => {
  const ov = { "Kerem Demir": "KD" };
  assert.equal(firstName("Kerem Demir", ov), "KD");
  assert.equal(firstName("Ada Yilmaz", ov), "Ada", "a non-matching name behaves normally");
  assert.equal(firstName("Kerem Demir"), "Kerem", "without an override the Jira name stands");
});

test("firstName: the alias matches the full name, never partially", () => {
  const ov = { "Kerem Demir": "KD" };
  assert.equal(firstName("Kerem Demirci", ov), "Kerem", "a different person must not be affected");
  assert.equal(firstName("Kerem", ov), "Kerem");
});

test("firstName: an empty/broken alias falls back to the Jira name", () => {
  assert.equal(firstName("Kerem Demir", { "Kerem Demir": "" }), "Kerem");
  assert.equal(firstName("Kerem Demir", { "Kerem Demir": null }), "Kerem");
  assert.equal(firstName("Kerem Demir", {}), "Kerem");
});

// --- resolveExecutable: a GUI app does not see the shell PATH ---
// A hard-coded /opt/homebrew path broke on Intel Macs and on machines without Homebrew.

test("resolveExecutable: returns the first candidate that exists", () => {
  const exists = (p) => p === "/usr/local/bin/gh";
  assert.equal(resolveExecutable("gh", exists), "/usr/local/bin/gh");
});

test("resolveExecutable: order matters — the Homebrew path wins over /usr/bin", () => {
  const exists = (p) => p === "/opt/homebrew/bin/node" || p === "/usr/bin/node";
  assert.equal(resolveExecutable("node", exists), "/opt/homebrew/bin/node");
});

test("resolveExecutable: null when no candidate exists (so the caller can fall back)", () => {
  assert.equal(resolveExecutable("no-such-binary", () => false), null);
});

test("resolveExecutable: an empty name returns null without touching the filesystem", () => {
  let calls = 0;
  assert.equal(resolveExecutable("", () => { calls++; return true; }), null);
  assert.equal(calls, 0);
});

test("resolveExecutable: candidate directories can be supplied by the caller", () => {
  const exists = (p) => p === "/opt/custom/bin/gh";
  assert.equal(resolveExecutable("gh", exists, ["/opt/custom/bin"]), "/opt/custom/bin/gh");
  assert.equal(resolveExecutable("gh", exists, BIN_DIRS), null, "not in the default directories");
});

// --- Update check ---

test("compareVersions: basic ordering", () => {
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.1.0", "1.0.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("compareVersions: a 'v' prefix and a missing part are tolerated", () => {
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0, "the v prefix must make no difference");
  assert.equal(compareVersions("1.2", "1.2.0"), 0, "a missing part must count as 0");
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "numeric comparison, not lexical");
});

test("updateInfo: returns details when a newer version exists", () => {
  const r = updateInfo("1.0.0", { tag_name: "v1.1.0", html_url: "https://x/releases/v1.1.0" });
  assert.deepEqual(r, { version: "1.1.0", url: "https://x/releases/v1.1.0" });
});

test("updateInfo: NO warning for the same or an older version", () => {
  assert.equal(updateInfo("1.1.0", { tag_name: "v1.1.0" }), null);
  assert.equal(updateInfo("1.2.0", { tag_name: "v1.1.0" }), null, "must never go backwards");
});

test("updateInfo: never warns when no version is embedded (a development build)", () => {
  assert.equal(updateInfo(null, { tag_name: "v9.9.9" }), null);
  assert.equal(updateInfo("", { tag_name: "v9.9.9" }), null);
});

test("updateInfo: stays quiet when the release could not be fetched", () => {
  assert.equal(updateInfo("1.0.0", null), null);
  assert.equal(updateInfo("1.0.0", {}), null, "no tag_name means no warning");
});

// --- jiraRequest: the OAuth and API-token paths side by side ---

test("jiraRequest: an OAuth request goes to the gateway, not to the site", () => {
  const r = jiraRequest({ mode: "oauth", token: "AT", cloudId: "cid-1" }, "company.atlassian.net", "/rest/api/3/myself");
  assert.equal(r.url, "https://api.atlassian.com/ex/jira/cid-1/rest/api/3/myself");
  assert.equal(r.headers.Authorization, "Bearer AT");
});

test("jiraRequest: a Basic request goes straight to the site", () => {
  const r = jiraRequest({ mode: "basic", token: "B64" }, "company.atlassian.net", "/rest/api/3/myself");
  assert.equal(r.url, "https://company.atlassian.net/rest/api/3/myself");
  assert.equal(r.headers.Authorization, "Basic B64");
});

test("jiraRequest: OAuth without a cloudId throws instead of SILENTLY hitting the wrong host", () => {
  assert.throws(() => jiraRequest({ mode: "oauth", token: "AT" }, "s.atlassian.net", "/x"), /cloudId/);
});

test("jiraRequest: Basic without a host throws", () => {
  assert.throws(() => jiraRequest({ mode: "basic", token: "B" }, "", "/x"), /host/);
});

test("jiraRequest: no mode means Basic (older installs)", () => {
  const r = jiraRequest({ token: "B64" }, "legacy.atlassian.net", "/rest/api/3/field");
  assert.equal(r.url, "https://legacy.atlassian.net/rest/api/3/field");
  assert.ok(r.headers.Authorization.startsWith("Basic "));
});

// --- PR list, conflict notifications, refresh summary ---

const demoPr = (number, extra = {}) => ({
  repo: "demo-repo", number, url: `https://example.invalid/demo-repo/pull/${number}`,
  title: `DEMO-${number} | demo change`, isDraft: false, mergeable: "MERGEABLE", ciState: "SUCCESS", ...extra,
});

test("mergeBlocked: conflicts, then failing required checks, then changes requested, then checking", () => {
  const rows = mergeBlocked([
    demoPr(1, { mergeable: "UNKNOWN" }),
    demoPr(2, { reviewDecision: "CHANGES_REQUESTED" }),
    demoPr(3, { ciState: "FAILURE", failingRequired: ["Lint"] }),
    demoPr(4, { mergeable: "CONFLICTING" }),
    demoPr(5, { ciState: "ERROR", failingRequired: ["Build"] }),
  ]);
  assert.deepEqual(rows.map((r) => r.number), [4, 3, 5, 2, 1]);
  assert.deepEqual(rows.map((r) => r.kind), ["conflict", "ci", "ci", "changes", "checking"]);
});

test("mergeBlocked: each row names its reason", () => {
  const rows = mergeBlocked([
    demoPr(1, { mergeable: "CONFLICTING" }),
    demoPr(2, { ciState: "FAILURE", failingRequired: ["Lint", "Build"] }),
    demoPr(3, { reviewDecision: "CHANGES_REQUESTED" }),
    demoPr(4, { mergeable: null }),
  ]);
  assert.deepEqual(rows.map((r) => r.reasons), [["conflict"], ["CI: Lint, Build"], ["changes requested"], ["checking"]]);
});

test("mergeBlocked: a PR with several blockers lists all of them", () => {
  const [row] = mergeBlocked([demoPr(1, {
    mergeable: "CONFLICTING", ciState: "FAILURE", failingRequired: ["Lint"], reviewDecision: "CHANGES_REQUESTED",
  })]);
  assert.equal(row.kind, "conflict");
  assert.deepEqual(row.reasons, ["conflict", "CI: Lint", "changes requested"]);
});

test("mergeBlocked: a blocked PR whose merge state is unsettled stays in its group and says so", () => {
  const rows = mergeBlocked([
    demoPr(1, { mergeable: "UNKNOWN" }),
    demoPr(2, { mergeable: "UNKNOWN", ciState: "FAILURE", failingRequired: ["Lint"] }),
  ]);
  assert.deepEqual(rows.map((r) => [r.number, r.kind]), [[2, "ci"], [1, "checking"]]);
  assert.deepEqual(rows[0].reasons, ["CI: Lint", "merge checking"]);
});

test("mergeBlocked: a clean PR is not shown, nor is pending CI or a review that is only required", () => {
  assert.deepEqual(mergeBlocked([
    demoPr(1),
    demoPr(2, { ciState: "PENDING", pendingRequired: ["Lint"] }),
    demoPr(3, { reviewDecision: "REVIEW_REQUIRED" }),
  ]), []);
});

test("mergeBlocked: drafts are left out unless the setting includes them", () => {
  assert.deepEqual(mergeBlocked([demoPr(1, { mergeable: "CONFLICTING", isDraft: true })]), []);
});

test("mergeBlocked: a PR without a Jira key shows in the band", () => {
  const [row] = mergeBlocked([demoPr(2, { mergeable: "CONFLICTING", title: "no key here" })]);
  assert.deepEqual(row, {
    key: null, repo: "demo-repo", number: 2, url: "https://example.invalid/demo-repo/pull/2",
    title: "no key here", kind: "conflict", reasons: ["conflict"],
  });
});

test("summarizePrs: a PR without a key shows in WAITING and gets no task badge", () => {
  const r = summarizePrs([demoPr(4, { title: "chore: bump", reviewDecision: "REVIEW_REQUIRED" })]);
  assert.deepEqual(r.waiting.map((w) => [w.key, w.number, w.checks]), [[null, 4, ["awaiting review"]]]);
  assert.deepEqual(r.byKey, {});
});

test("summarizePrs: a keyless draft stays out of WAITING", () => {
  const r = summarizePrs([demoPr(5, { title: "chore: bump", isDraft: true, reviewDecision: "REVIEW_REQUIRED" })]);
  assert.deepEqual(r.waiting, []);
});

test("summarizePrs: the task badge still links a PR by the key in its title", () => {
  const r = summarizePrs([demoPr(6, { title: "DEMO-6 | fix" }), demoPr(7, { title: "chore: bump" })]);
  assert.deepEqual(Object.keys(r.byKey), ["DEMO-6"]);
  assert.equal(r.byKey["DEMO-6"].count, 1);
});

test("mergeBlocked: a row carries what the band needs", () => {
  const [row] = mergeBlocked([demoPr(7, { mergeable: "CONFLICTING" })]);
  assert.deepEqual(row, {
    key: "DEMO-7", repo: "demo-repo", number: 7, url: "https://example.invalid/demo-repo/pull/7",
    title: "DEMO-7 | demo change", kind: "conflict", reasons: ["conflict"],
  });
});

test("mergeBlocked: no PR data gives an empty list", () => {
  assert.deepEqual(mergeBlocked(null), []);
});

test("watchedPrs: every PR the search returned, no drafts by default, a Jira key not needed", () => {
  const prs = [demoPr(1), demoPr(2, { isDraft: true }), demoPr(3, { title: "no key" }), null];
  assert.deepEqual(watchedPrs(prs).map((p) => p.number), [1, 3]);
  assert.deepEqual(watchedPrs(null), []);
});

test("newConflicts: a hidden draft does not notify, a keyless PR does", () => {
  const prev = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: [] };
  const prs = [
    demoPr(1, { mergeable: "CONFLICTING", isDraft: true }),
    demoPr(2, { mergeable: "CONFLICTING", title: "no key" }),
    demoPr(3, { mergeable: "CONFLICTING" }),
  ];
  assert.deepEqual(newConflicts(prev, prs).map((p) => p.number), [2, 3]);
});

test("conflictIds: only the conflicts the band shows are remembered", () => {
  const prs = [demoPr(1, { mergeable: "CONFLICTING", isDraft: true }), demoPr(2, { mergeable: "CONFLICTING" })];
  assert.deepEqual(conflictIds(prs), ["demo-repo#2"]);
});

test("refreshSummary: counts only the PRs the band covers, keyless ones included", () => {
  const s = refreshSummary([
    demoPr(1, { mergeable: "CONFLICTING", title: "no key" }),
    demoPr(2, { mergeable: "UNKNOWN", isDraft: true }),
    demoPr(3),
  ]);
  assert.equal(s.title, "1 conflict");
  assert.equal(s.body, "demo-repo#1");
});

test("newConflicts: the first run after keyless PRs joined the band only remembers", () => {
  const old = { initialized: true, conflictIds: ["demo-repo#3"] };
  const prs = [demoPr(1, { mergeable: "CONFLICTING", title: "no key" }), demoPr(3, { mergeable: "CONFLICTING" })];
  assert.deepEqual(newConflicts(old, prs), [], "no burst for conflicts that already existed");
  const next = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds(prs, old.conflictIds) };
  assert.deepEqual(next.conflictIds, ["demo-repo#1", "demo-repo#3"]);
  const later = [...prs, demoPr(4, { mergeable: "CONFLICTING", title: "no key either" })];
  assert.deepEqual(newConflicts(next, later).map((p) => p.number), [4]);
});

test("conflictIds: only CONFLICTING PRs", () => {
  assert.deepEqual(conflictIds([demoPr(1), demoPr(2, { mergeable: "CONFLICTING" })]), ["demo-repo#2"]);
});

test("newConflicts: only conflicts the previous run did not have", () => {
  const prev = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: ["demo-repo#1"] };
  const prs = [demoPr(1, { mergeable: "CONFLICTING" }), demoPr(2, { mergeable: "CONFLICTING" }), demoPr(3)];
  assert.deepEqual(newConflicts(prev, prs).map((p) => p.number), [2]);
});

test("newConflicts: silent on the first run and on a state file without a conflict list", () => {
  const prs = [demoPr(1, { mergeable: "CONFLICTING" })];
  assert.deepEqual(newConflicts(emptyState(), prs), []);
  assert.deepEqual(newConflicts({ initialized: true, brokenIds: [] }, prs), []);
});

test("conflictNotifications: one per PR, with its link", () => {
  const [n] = conflictNotifications([demoPr(7, { mergeable: "CONFLICTING" })]);
  assert.equal(n.title, "Conflict: demo-repo #7");
  assert.equal(n.url, "https://example.invalid/demo-repo/pull/7");
  assert.equal(n.id, "conflict-demo-repo#7");
});

test("conflictNotifications: a PR without a title gets the fallback body", () => {
  const [n] = conflictNotifications([demoPr(8, { mergeable: "CONFLICTING", title: "" })]);
  assert.equal(n.body, "This PR no longer merges into its base branch");
});

test("conflictNotifications: a PR without a url gets a null link", () => {
  const [n] = conflictNotifications([demoPr(9, { mergeable: "CONFLICTING", url: undefined })]);
  assert.equal(n.url, null);
});

test("refreshSummary: all clean", () => {
  const s = refreshSummary([demoPr(1), demoPr(2)]);
  assert.equal(s.title, "No conflicts, no CI errors");
  assert.equal(s.body, "2 open PRs checked");
});

test("refreshSummary: names conflicts and CI errors, a PR with both once", () => {
  const s = refreshSummary([
    demoPr(1, { mergeable: "CONFLICTING", ciState: "FAILURE" }),
    demoPr(2, { mergeable: "CONFLICTING" }),
    demoPr(3, { ciState: "ERROR" }),
    demoPr(4),
  ]);
  assert.equal(s.title, "2 conflicts, 2 CI errors");
  assert.equal(s.body, "demo-repo#1, demo-repo#2, demo-repo#3");
});

test("refreshSummary: a draft's failing CI is not an error", () => {
  assert.equal(refreshSummary([demoPr(1, { isDraft: true, ciState: "FAILURE" })]).title, "No conflicts, no CI errors");
});

test("refreshSummary: no PR data says so instead of reporting clean", () => {
  assert.equal(refreshSummary(null).title, "PRs not checked");
});

test("refreshSummary: a failed CI query is not reported as no CI errors", () => {
  const s = refreshSummary([demoPr(1, { ciState: null })], "GitHub HTTP 502");
  assert.equal(s.title, "No conflicts found");
  assert.equal(s.body, "CI not checked · 1 open PRs");
});

test("refreshSummary: PRs GitHub is still computing are counted, not called clean", () => {
  const s = refreshSummary([demoPr(1), demoPr(2, { mergeable: "UNKNOWN" })]);
  assert.equal(s.title, "No conflicts found");
  assert.equal(s.body, "1 still checking · 2 open PRs");
});

test("refreshSummary: problems keep their caveats", () => {
  const s = refreshSummary([demoPr(1, { mergeable: "CONFLICTING" }), demoPr(2, { mergeable: "UNKNOWN" })]);
  assert.equal(s.title, "1 conflict");
  assert.equal(s.body, "demo-repo#1 · 1 still checking");
});

test("conflictIds: a remembered conflict GitHub has not settled this run stays remembered", () => {
  const prs = [demoPr(1, { mergeable: "UNKNOWN" }), demoPr(2, { mergeable: "CONFLICTING" }), demoPr(3)];
  assert.deepEqual(conflictIds(prs, ["demo-repo#1", "demo-repo#3"]), ["demo-repo#2", "demo-repo#1"]);
});

test("conflictIds + newConflicts: a conflict that flickers to UNKNOWN does not notify twice", () => {
  const run1 = [demoPr(1, { mergeable: "CONFLICTING" })];
  const run2 = [demoPr(1, { mergeable: "UNKNOWN" })];
  const run3 = [demoPr(1, { mergeable: "CONFLICTING" })];
  let state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: [] };
  assert.equal(newConflicts(state, run1).length, 1);
  state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds(run1, state.conflictIds) };
  assert.equal(newConflicts(state, run2).length, 0);
  state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds(run2, state.conflictIds) };
  assert.equal(newConflicts(state, run3).length, 0, "the same conflict must not notify again");
});

// --- GitHub organization filter ---

const orgValid = ["acme", " Acme-Labs ", "a", "a1-b2", "a".repeat(39)];
const orgEmpty = ["", "   "];
const orgInvalid = ["-acme", "acme-", "ac--me", "a".repeat(40), 'ac"me', "ac me", "acme/x", "ac_me", "org:acme"];

test("githubOrgQualifier: a valid organization name becomes the search qualifier", () => {
  for (const org of orgValid) assert.equal(githubOrgQualifier(org), `org:${org.trim()} `, org);
});

test("githubOrgQualifier: empty or missing means all PRs", () => {
  for (const org of [...orgEmpty, undefined, null]) assert.equal(githubOrgQualifier(org), "", String(org));
});

test("githubOrgQualifier: an invalid name is refused, never passed into the query", () => {
  for (const org of [...orgInvalid, 42, {}]) assert.equal(githubOrgQualifier(org), null, String(org));
});

test("prSearch / reviewSearch: both searches carry the organization qualifier", () => {
  assert.equal(prSearch("org:acme "), "org:acme author:@me is:pr is:open");
  assert.equal(reviewSearch("org:acme "), "org:acme is:open is:pr review-requested:@me");
});

test("prSearch / reviewSearch: no organization searches all PRs", () => {
  assert.equal(prSearch(""), "author:@me is:pr is:open");
  assert.equal(reviewSearch(""), "is:open is:pr review-requested:@me");
});

test("searchNodes: a GraphQL error answer without a search result is unavailable, not empty", () => {
  assert.equal(searchNodes({ errors: [{ message: "Something went wrong" }] }), null);
  assert.equal(searchNodes({ data: { search: null }, errors: [{ message: "timeout" }] }), null);
  assert.equal(searchNodes({ data: null }), null);
  assert.equal(searchNodes(null), null);
});

test("searchNodes: a search result is returned as is, an empty one as []", () => {
  assert.deepEqual(searchNodes({ data: { search: { nodes: [] } } }), []);
  assert.deepEqual(searchNodes({ data: { search: { nodes: [{ number: 1 }] } } }), [{ number: 1 }]);
});

test("conflictIds: with no PR data the remembered conflicts are kept", () => {
  assert.deepEqual(conflictIds(null, ["demo-repo#1"]), ["demo-repo#1"]);
  assert.deepEqual(conflictIds(null, undefined), []);
});

test("conflictIds + newConflicts: a run without PR data does not make a known conflict notify again", () => {
  const run1 = [demoPr(1, { mergeable: "CONFLICTING" })];
  let state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds(run1, []) };
  state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds(null, state.conflictIds) };
  assert.equal(newConflicts(state, run1).length, 0);
});

test("reviewIds: the review requests of a good run", () => {
  assert.deepEqual(reviewIds([{ repo: "demo-repo", number: 3 }, { repo: "demo-api", number: 9 }], ["old#1"]),
    ["demo-repo#3", "demo-api#9"]);
  assert.deepEqual(reviewIds([], ["old#1"]), []);
});

test("reviewIds: a failed review search keeps the previous list", () => {
  assert.deepEqual(reviewIds(null, ["demo-repo#3"]), ["demo-repo#3"]);
  assert.deepEqual(reviewIds(null, undefined), []);
});

test("reviewIds + detectAlerts: a failed run does not make known review requests sound on the next good run", () => {
  const good = [{ repo: "demo-repo", number: 3 }];
  let state = { initialized: true, reviewIds: reviewIds(good, []) };
  state = { initialized: true, reviewIds: reviewIds(null, state.reviewIds) };
  assert.deepEqual(detectAlerts(state, { reviewIds: reviewIds(good, state.reviewIds) }), []);
});

// --- Show draft PRs setting ---

test("showDraftPrs: a missing key means drafts are shown", () => {
  assert.equal(showDraftPrs({}), true);
  assert.equal(showDraftPrs(null), true);
  assert.equal(showDraftPrs({ showDraftPrs: true }), true);
  assert.equal(showDraftPrs({ showDraftPrs: false }), false);
});

test("watchedPrs: drafts are kept when the setting is on and dropped when it is off", () => {
  const prs = [demoPr(1), demoPr(2, { isDraft: true }), demoPr(3, { isDraft: true, title: "no key" })];
  assert.deepEqual(watchedPrs(prs, true).map((p) => p.number), [1, 2, 3]);
  assert.deepEqual(watchedPrs(prs, false).map((p) => p.number), [1]);
});

test("newConflicts: a conflicting draft notifies only when drafts are shown", () => {
  const prev = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: [] };
  const prs = [demoPr(1, { isDraft: true, mergeable: "CONFLICTING" })];
  assert.deepEqual(newConflicts(prev, prs, true).map((p) => p.number), [1]);
  assert.deepEqual(newConflicts(prev, prs, false), []);
});

test("refreshSummary: a conflicting draft is counted only when drafts are shown", () => {
  const prs = [demoPr(1, { isDraft: true, mergeable: "CONFLICTING" })];
  assert.equal(refreshSummary(prs, null, true).title, "1 conflict");
  assert.equal(refreshSummary(prs, null, false).title, "No conflicts, no CI errors");
});

test("mergeBlocked: a draft row is marked as a draft", () => {
  const [row] = mergeBlocked([demoPr(1, { isDraft: true, mergeable: "CONFLICTING" })], true);
  assert.deepEqual(row.reasons, ["conflict", "draft"]);
  assert.deepEqual(mergeBlocked([demoPr(1, { isDraft: true, mergeable: "CONFLICTING" })], false), []);
});

test("summarizePrs: the WAITING band still leaves drafts out, whatever the setting", () => {
  const prs = [demoPr(1, { isDraft: true, reviewDecision: "REVIEW_REQUIRED", mergeable: "UNKNOWN" })];
  assert.deepEqual(summarizePrs(prs).waiting, []);
  assert.equal(mergeBlocked(prs, true).length, 1);
});

test("conflictIds: a draft conflict hidden by the setting stays remembered and does not notify again", () => {
  const draft = demoPr(1, { isDraft: true, mergeable: "CONFLICTING" });
  let state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: [] };
  assert.equal(newConflicts(state, [draft], true).length, 1);
  state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds([draft], state.conflictIds, true) };
  state = { initialized: true, conflictScope: CONFLICT_SCOPE, conflictIds: conflictIds([draft], state.conflictIds, false) };
  assert.deepEqual(state.conflictIds, ["demo-repo#1"], "switching drafts off must not forget it");
  assert.equal(newConflicts(state, [draft], true).length, 0, "switching drafts back on must not notify again");
});

test("conflictIds: a hidden draft that no longer conflicts is forgotten", () => {
  const draft = demoPr(1, { isDraft: true, mergeable: "MERGEABLE" });
  assert.deepEqual(conflictIds([draft], ["demo-repo#1"], false), []);
});

// --- Sprint goal tracking ---
// Sprint: Mon 2026-08-10 → Mon 2026-08-24. Day 8 = Mon 08-17. Business days before the
// end: Tue 08-18 = 4th, Wed 08-19 = 3rd (the weekend 08-22/23 lies between).
const goalStart = "2026-08-10T07:00:00.000Z";
const goalEnd = "2026-08-24T15:00:00.000Z";

test("sprintGoalTracking: a missing key means off", () => {
  assert.equal(sprintGoalTracking({}), false);
  assert.equal(sprintGoalTracking(null), false);
  assert.equal(sprintGoalTracking({ sprintGoalTracking: "yes" }), false);
  assert.equal(sprintGoalTracking({ sprintGoalTracking: true }), true);
});

test("isGoalDone: done is the status category, not a status name", () => {
  assert.equal(isGoalDone({ key: "done", name: "Done" }), true);
  assert.equal(isGoalDone({ key: "done", name: "Released on Prod" }), true);
  assert.equal(isGoalDone({ key: "indeterminate", name: "Done-ish" }), false);
  assert.equal(isGoalDone(null), false);
});

// A real sprint: Thursday 22 Oct to Wednesday 4 Nov; Jira's end is Thursday 5 Nov 07:00.
const riskStart = "2026-10-22T14:03:10.336Z";
const riskEnd = "2026-11-05T07:00:00.000Z";
const colourOn = (day, status, category = "indeterminate", stages) =>
  goalRisk(at(day), riskStart, riskEnd, { key: category }, status, stages);

test("goalRisk: the sprint's last day counts as its last 1 day, the Monday before as its last 3", () => {
  assert.equal(businessDaysBetween(at("2026-11-04"), riskEnd), 1);
  assert.equal(businessDaysBetween(at("2026-11-02"), riskEnd), 3);
  assert.equal(businessDaysBetween(at("2026-10-22"), riskEnd), 10);
});

test("goalRisk: each stage turns at risk and critical in its own last days", () => {
  const cases = [
    // [status, last day still on track, first at-risk day, first critical day]
    ["To Do", "2026-10-27", "2026-10-28", "2026-10-30"],
    ["In Progress", "2026-10-28", "2026-10-29", "2026-11-02"],
    ["In Code Review", "2026-10-28", "2026-10-29", "2026-11-02"],
    ["Ready To Test", "2026-10-29", "2026-10-30", "2026-11-03"],
    ["IN TESTING", "2026-10-29", "2026-10-30", "2026-11-03"],
    ["IN AUTO TESTING", "2026-10-29", "2026-10-30", "2026-11-03"],
    ["Design UAT", "2026-10-30", "2026-11-02", "2026-11-04"],
    ["UAT", "2026-10-30", "2026-11-02", "2026-11-04"],
  ];
  for (const [status, calm, risky, critical] of cases) {
    assert.equal(colourOn(calm, status), "ok", `${status} on ${calm}`);
    assert.equal(colourOn(risky, status), "yellow", `${status} on ${risky}`);
    assert.equal(colourOn(critical, status), "red", `${status} on ${critical}`);
  }
});

test("goalRisk: security check is at risk in the last 2 days and never critical", () => {
  assert.equal(colourOn("2026-11-02", "In Security Check"), "ok");
  assert.equal(colourOn("2026-11-03", "In Security Check"), "yellow");
  assert.equal(colourOn("2026-11-04", "In Security Check"), "yellow");
  assert.equal(colourOn("2026-11-06", "In Security Check"), "yellow", "after the end too");
});

test("goalRisk: a status the board files under a later column follows that column, not its Jira category", () => {
  assert.equal(colourOn("2026-11-02", "QA Check", "new"), "yellow", "QA, not To Do");
  assert.equal(colourOn("2026-11-02", "Design Testing Done", "new"), "yellow", "Design UAT, not To Do");
});

test("goalRisk: a status is matched in any case; one no stage lists counts as In Progress", () => {
  assert.equal(colourOn("2026-11-02", "in testing"), "yellow");
  assert.equal(colourOn("2026-10-29", "Something New"), "yellow");
  assert.equal(colourOn("2026-11-02", "Something New"), "red");
});

test("goalRisk: a waiting-for-release task is never coloured, and the config's stages replace the defaults", () => {
  assert.equal(colourOn("2026-11-04", "Ready For Release", "done"), "done");
  const stages = [{ name: "Waiting", never: true, statuses: ["Parked"] }, { name: "UAT", atRisk: 5, critical: 2, statuses: ["UAT"] }];
  assert.equal(colourOn("2026-11-04", "Parked", "indeterminate", stages), "ok");
  assert.equal(colourOn("2026-10-29", "UAT", "indeterminate", stages), "yellow");
  assert.equal(colourOn("2026-11-03", "UAT", "indeterminate", stages), "red");
  assert.equal(goalRiskStages({ goalRiskStages: stages }), stages);
  assert.equal(goalRiskStages({ goalRiskStages: "broken" }), DEFAULT_GOAL_RISK_STAGES);
  assert.equal(goalRiskStages(null), DEFAULT_GOAL_RISK_STAGES);
});

test("goalRisk: the default stages are the agreed table", () => {
  const table = DEFAULT_GOAL_RISK_STAGES.map((st) => `${st.name} ${st.never ? "never" : `${st.atRisk}/${st.critical}`}`);
  assert.deepEqual(table, ["To Do 6/4", "In Progress 5/3", "In Review 5/3", "Ready to Test 4/2", "QA 4/2",
    "Automation Test 4/2", "Design UAT 3/1", "UAT 3/1", "Security 2/null", "Released never"]);
  const example = JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8"));
  assert.deepEqual(example.goalRiskStages, DEFAULT_GOAL_RISK_STAGES, "the example config shows the same list");
});

test("goalRisk: a done goal task is done whatever the date", () => {
  assert.equal(goalRisk(at("2026-08-21"), goalStart, goalEnd, { key: "done" }), "done");
});

test("goalRisk: without sprint dates an open goal task is not coloured", () => {
  assert.equal(goalRisk(at("2026-08-21"), null, null, { key: "new" }), "ok");
});

const goalSprint = { id: 60509, name: "Demo - Sprint#2", state: "active", startDate: goalStart, endDate: goalEnd };

test("activeSprints: the active sprints of my tasks, once each", () => {
  const issues = [
    { fields: { customfield_1: [{ id: 1, state: "closed" }, goalSprint] } },
    { fields: { customfield_1: [goalSprint] } },
    { fields: { customfield_1: null } },
  ];
  assert.deepEqual(activeSprints(issues, "customfield_1"), [
    { id: 60509, name: "Demo - Sprint#2", startDate: goalStart, endDate: goalEnd },
  ]);
});

test("goalJql: flagged issues of the sprint, whoever owns them", () => {
  assert.equal(goalJql([60509]), "sprint = 60509 AND Flagged is not EMPTY");
  assert.equal(goalJql([1, 2]), "sprint in (1, 2) AND Flagged is not EMPTY");
});

test("goalJql: no sprint, or an id that is not a number, gives no query", () => {
  assert.equal(goalJql([]), null);
  assert.equal(goalJql(["1 OR project = X"]), null);
});

const goalIssue = (key, category, extra = {}) => ({
  key,
  fields: {
    summary: `${key} summary`,
    status: { name: category === "done" ? "Done" : "In Progress", statusCategory: { key: category } },
    assignee: { displayName: "Ada Yilmaz" },
    customfield_1: [goalSprint],
    ...extra,
  },
});

test("goalBand: counts done goal tasks and takes the worst colour", () => {
  const band = goalBand([goalIssue("DEMO-1", "done"), goalIssue("DEMO-2", "indeterminate")],
    [goalSprint], at("2026-08-19"), "example.invalid", "customfield_1");
  assert.equal(band.done, 1);
  assert.equal(band.total, 2);
  assert.equal(band.worst, "red");
  assert.deepEqual(band.rows.map((r) => [r.key, r.risk]), [["DEMO-2", "red"], ["DEMO-1", "done"]]);
  assert.deepEqual(band.rows[0], {
    key: "DEMO-2", summary: "DEMO-2 summary", owner: "Ada Yilmaz", ownerShort: "Ada", status: "In Progress", stage: "In Progress",
    risk: "red", url: "https://example.invalid/browse/DEMO-2",
  });
});

test("goalBand: a goal task's status name reaches its colour", () => {
  const testing = goalIssue("DEMO-4", "indeterminate");
  testing.fields.status.name = "In Testing";
  const band = goalBand([goalIssue("DEMO-2", "indeterminate"), testing], [goalSprint], at("2026-08-19"), "example.invalid", "customfield_1");
  assert.deepEqual(band.rows.map((r) => [r.key, r.risk]), [["DEMO-2", "red"], ["DEMO-4", "yellow"]]);
  const calm = { goalRiskStages: [{ name: "Anything", atRisk: 1, critical: null, statuses: ["In Progress", "In Testing"] }] };
  const configured = goalBand([goalIssue("DEMO-2", "indeterminate"), testing], [goalSprint], at("2026-08-19"), "example.invalid", "customfield_1", calm);
  assert.deepEqual(configured.rows.map((r) => r.risk), ["ok", "ok"], "the config's stages reach every row");
  assert.deepEqual(configured.rows.map((r) => r.stage), ["Anything", "Anything"]);
  const unlisted = goalIssue("DEMO-5", "indeterminate");
  unlisted.fields.status.name = "Something New";
  assert.equal(goalBand([unlisted], [goalSprint], at("2026-08-19"), "example.invalid", "customfield_1").rows[0].stage, "",
    "a status no stage lists has no column");
});

test("goalBand: an unassigned goal task and a sprint with no goal tasks", () => {
  const one = goalBand([goalIssue("DEMO-3", "new", { assignee: null })],
    [goalSprint], at("2026-08-12"), "example.invalid", "customfield_1");
  assert.equal(one.rows[0].owner, null);
  assert.equal(one.rows[0].ownerShort, "");
  // The first name follows the config's nameOverrides, like the QA name.
  const named = goalBand([goalIssue("DEMO-3", "new")], [goalSprint], at("2026-08-12"), "example.invalid", "customfield_1",
    { nameOverrides: { "Ada Yilmaz": "Ayşe" } });
  assert.equal(named.rows[0].ownerShort, "Ayşe");
  assert.equal(one.worst, "ok");
  const none = goalBand([], [goalSprint], at("2026-08-12"), "example.invalid", "customfield_1");
  assert.deepEqual([none.done, none.total, none.worst, none.rows], [0, 0, "ok", []]);
});

test("withGoalMarks: my task that is also a goal task gets the GOAL mark", () => {
  const tasks = withGoalMarks([{ key: "DEMO-1" }, { key: "DEMO-2" }], { rows: [{ key: "DEMO-2" }] });
  assert.deepEqual(tasks.map((t) => t.goal), [false, true]);
  assert.deepEqual(withGoalMarks([{ key: "DEMO-1" }], null).map((t) => t.goal), [false]);
});

test("releasePrSearch: one task's PRs by key, open and merged, scoped to the org", () => {
  assert.equal(releasePrSearch("org:demo-org ", "DEMO-101"), "org:demo-org is:pr DEMO-101 in:title");
});

test("releasePrSearch: without an org it stays on PRs that involve me", () => {
  assert.equal(releasePrSearch("", "DEMO-101"), "involves:@me is:pr DEMO-101 in:title");
});

test("releasePrSearch: anything but a Jira key, or an invalid org, never reaches the query", () => {
  assert.equal(releasePrSearch("org:demo-org ", 'DEMO-1" OR is:pr'), null);
  assert.equal(releasePrSearch("org:demo-org ", "demo-101"), null);
  assert.equal(releasePrSearch(null, "DEMO-101"), null);
});

test("titleNamesKey: the key as a whole token — DEMO-10 does not claim DEMO-101", () => {
  assert.equal(titleNamesKey("DEMO-10 | Template gate", "DEMO-10"), true);
  assert.equal(titleNamesKey("[DEMO-10] Template gate", "DEMO-10"), true);
  assert.equal(titleNamesKey("DEMO-101 | Template gate", "DEMO-10"), false);
  assert.equal(titleNamesKey("XDEMO-10 | Template gate", "DEMO-10"), false);
  assert.equal(titleNamesKey(null, "DEMO-10"), false);
});

test("releasePrState: open, merged, and deployed only on a task whose status says released", () => {
  assert.equal(releasePrState({ state: "OPEN" }, false), "open");
  assert.equal(releasePrState({ state: "OPEN" }, true), "open");
  assert.equal(releasePrState({ state: "MERGED" }, false), "merged");
  assert.equal(releasePrState({ state: "MERGED" }, true), "deployed");
});

test("releasePrState: merged reads deployed once it has reached master, whatever the status", () => {
  assert.equal(releasePrState({ state: "MERGED" }, false, true), "deployed");
  assert.equal(releasePrState({ state: "OPEN" }, false, true), "open");
});

test("isReleasedStatus: only a status on the released list proves a release; Closed or Done do not", () => {
  assert.equal(isReleasedStatus("Released on Prod", {}), true);
  assert.equal(isReleasedStatus(" released on prod ", {}), true);
  assert.equal(isReleasedStatus("Closed", {}), false);
  assert.equal(isReleasedStatus("Done", {}), false);
  assert.equal(isReleasedStatus(undefined, {}), false);
  assert.equal(isReleasedStatus("Shipped", { releasedStatuses: ["Shipped"] }), true);
  assert.equal(isReleasedStatus("Released on Prod", { releasedStatuses: ["Shipped"] }), false);
  assert.deepEqual(releasedStatuses({ releasedStatuses: "Shipped" }), DEFAULT_RELEASED_STATUSES);
  assert.deepEqual(releasedStatuses(null), DEFAULT_RELEASED_STATUSES);
});

test("releaseBranchCheck: a PR merged into main or develop is asked about master; one merged into master is not", () => {
  const oid = "a".repeat(40);
  const merged = (base, extra = {}) => ({ state: "MERGED", baseRefName: base, mergeCommit: { oid },
    repository: { name: "demo-repo", owner: { login: "demo-org" } }, ...extra });
  assert.deepEqual(releaseBranchCheck(merged("main")), { owner: "demo-org", name: "demo-repo", oid });
  assert.deepEqual(releaseBranchCheck(merged("develop")), { owner: "demo-org", name: "demo-repo", oid });
  assert.equal(releaseBranchCheck(merged("master")), null, "a merge into master is not always a release");
  assert.equal(releaseBranchCheck({ ...merged("main"), state: "OPEN" }), null);
  assert.equal(releaseBranchCheck(null), null);
});

test("releaseBranchCheck: nothing that is not a plain name or commit id reaches the query", () => {
  const node = (owner, name, oid) => ({ state: "MERGED", baseRefName: "main", mergeCommit: { oid },
    repository: { name, owner: { login: owner } } });
  assert.equal(releaseBranchCheck(node('demo-org") { x }', "demo-repo", "a".repeat(40))), null);
  assert.equal(releaseBranchCheck(node("demo-org", "demo repo", "a".repeat(40))), null);
  assert.equal(releaseBranchCheck(node("demo-org", "demo-repo", "main")), null);
  assert.equal(releaseBranchCheck(node(undefined, "demo-repo", "a".repeat(40))), null);
  assert.equal(releaseBranchCheck({ state: "MERGED", baseRefName: "main" }), null);
});

test("reachedReleaseBranch: master at the merge commit or past it", () => {
  assert.equal(reachedReleaseBranch("BEHIND"), true);
  assert.equal(reachedReleaseBranch("IDENTICAL"), true);
  assert.equal(reachedReleaseBranch("AHEAD"), false);
  assert.equal(reachedReleaseBranch("DIVERGED"), false);
  assert.equal(reachedReleaseBranch(undefined), false);
});

test("releasePrState: a PR closed without merging is not shown", () => {
  assert.equal(releasePrState({ state: "CLOSED" }, true), null);
  assert.equal(releasePrState(null, true), null);
});

test("releasePrs: drops closed PRs, other keys and duplicates; open PRs first", () => {
  const node = (number, title, state, repo = "demo-repo") =>
    ({ number, title, state, url: `https://example.invalid/${repo}/${number}`, repository: { name: repo } });
  const rows = releasePrs([
    node(1, "DEMO-101 | Merged first", "MERGED"),
    node(2, "DEMO-101 | Abandoned", "CLOSED"),
    node(3, "DEMO-1010 | Another task", "OPEN"),
    node(4, "DEMO-101 | Still open", "OPEN", "other-repo"),
    node(1, "DEMO-101 | Merged first", "MERGED"),
    null,
  ], "DEMO-101", false);
  assert.deepEqual(rows.map((r) => [r.repo, r.number, r.status]),
    [["other-repo", 4, "open"], ["demo-repo", 1, "merged"]]);
  assert.equal(rows[0].url, "https://example.invalid/other-repo/4");
});

test("releasePrs: a merged PR that has reached master reads deployed, the others merged", () => {
  const node = (number, owner) => ({ number, title: `DEMO-101 | Part ${number}`, url: "#", state: "MERGED",
    repository: { name: "demo-repo", owner: { login: owner } } });
  const rows = releasePrs([node(1, "demo-org"), node(2, "demo-org"), node(1, "other-org")], "DEMO-101", false,
    new Set(["demo-org/demo-repo#1"]));
  assert.deepEqual(rows.map((r) => `${r.repo}#${r.number} ${r.status}`),
    ["demo-repo#1 deployed", "demo-repo#2 merged", "demo-repo#1 merged"]);
});

test("withOpenPrState: an open PR carries the badge state of its own CI, conflict and review", () => {
  const row = (repo, number, status = "open") => ({ repo, number, status });
  const rows = [row("demo-repo", 1), row("demo-repo", 2), row("demo-repo", 3), row("demo-repo", 4),
    row("demo-repo", 5, "merged"), row("other-repo", 1), row("demo-repo", 6)];
  const prs = [
    { repo: "demo-repo", number: 1, ciState: "FAILURE", failingRequired: ["LintChecker"], mergeable: "MERGEABLE" },
    { repo: "demo-repo", number: 2, ciState: "SUCCESS", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED" },
    { repo: "demo-repo", number: 3, ciState: "SUCCESS", mergeable: "MERGEABLE" },
    { repo: "demo-repo", number: 4, ciState: "SUCCESS", isDraft: true },
    { repo: "demo-repo", number: 6, ciState: "SUCCESS", mergeable: "CONFLICTING" },
    null,
  ];
  const out = withOpenPrState(rows, prs);
  assert.deepEqual(out.map((r) => (r.status === "open" ? r.ci : "-")), ["FAILURE", "PENDING", "SUCCESS", null, "-", null, "FAILURE"]);
  assert.deepEqual(out[6].checks, ["conflict — needs rebase"]);
  assert.deepEqual(out[0].checks, ["CI: LintChecker"]);
  assert.deepEqual(out[1].checks, ["awaiting review"]);
  assert.equal("ci" in out[4], false, "a merged PR has no CI state");
  assert.deepEqual(withOpenPrState([row("demo-repo", 1)], null).map((r) => r.ci), [null]);
  assert.equal(withOpenPrState(null, prs), null);
  assert.equal(withOpenPrState(undefined, prs), undefined);
});

test("releasePrs: no PRs found is an empty column, a failed search is null", () => {
  assert.deepEqual(releasePrs([], "DEMO-101", true), []);
  assert.equal(releasePrs(undefined, "DEMO-101", true), null);
});

test("groupByStatus: one section per status — active, then waiting, then shipped, then cancelled", () => {
  const t = (key, status, done = false, release = null) => ({ key, status, done, release });
  const groups = groupByStatus([
    t("DEMO-1", "Ready To Test"),
    t("DEMO-2", "In Review"),
    t("DEMO-3", "Ready To Test"),
    t("DEMO-4", "Released on Prod", true, "finished"),
    t("DEMO-5", "Rejected", true, "cancelled"),
    t("DEMO-6", "Ready For Release", true, "pending"),
    t("DEMO-7", "Awaiting Release", true, "pending"),
    t("DEMO-8", "Released on Prod", true, "finished"),
  ]);
  assert.deepEqual(groups.map((g) => [g.status, g.tasks.map((x) => x.key)]), [
    ["Ready To Test", ["DEMO-1", "DEMO-3"]],
    ["In Review", ["DEMO-2"]],
    ["Ready For Release", ["DEMO-6"]],
    ["Awaiting Release", ["DEMO-7"]],
    ["Released on Prod", ["DEMO-4", "DEMO-8"]],
    ["Rejected", ["DEMO-5"]],
  ]);
  assert.deepEqual(groupByStatus(undefined), []);
});

// --demo returns before any token or keychain read, so a temporary HOME holding only a
// config keeps the real config and keychain out of the test.
function runDemo(cfg) {
  const home = mkdtempSync(join(tmpdir(), "sprint-board-demo-"));
  try {
    mkdirSync(join(home, ".config", "sprint-widget"), { recursive: true });
    writeFileSync(join(home, ".config", "sprint-widget", "config.json"), JSON.stringify(cfg));
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("./fetch.mjs", import.meta.url)), "--demo"],
      { env: { ...process.env, HOME: home }, encoding: "utf8" });
    return JSON.parse(out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// The real (non-demo) path, against canned Jira and GitHub answers. A preload swaps
// globalThis.fetch inside the child only; the tokens come through stdin, so no keychain
// is read, and HOME is a temp folder, so the real config and state are never touched.
const FAKE_FETCH = `
import { appendFileSync, readFileSync } from "node:fs";
const fake = JSON.parse(readFileSync(process.env.SB_FAKE_JIRA, "utf8"));
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === "api.github.com") {
    const query = JSON.parse(init?.body || "{}").query || "";
    if (fake.failReleaseSearch && query.includes("r0: search(")) return new Response("boom", { status: 500 });
    if (query.includes("r0: search(")) {
      appendFileSync(process.env.SB_FAKE_JIRA + ".gh", query + "\\n");
      const data = {};
      for (const m of query.matchAll(/(r[0-9]+): search[(]query: "[^"]* ([A-Z][A-Z0-9]*-[0-9]+) in:title"/g)) {
        data[m[1]] = (fake.releaseSearch || {})[m[2]] || { nodes: [] };
      }
      return json({ data });
    }
    if (fake.failReviews && query.includes("review-requested")) return new Response("boom", { status: 500 });
    if (query.includes("c0: repository(")) {
      appendFileSync(process.env.SB_FAKE_JIRA + ".gh", query + "\\n");
      if (fake.failReleaseCompare) return new Response("boom", { status: 500 });
      const data = {};
      for (const m of query.matchAll(/(c[0-9]+): repository[(][^]*?compare[(]headRef: "([0-9a-f]{40})"/g)) {
        data[m[1]] = (fake.releaseCompare || {})[m[2]] ?? null;
      }
      return json({ data });
    }
    if (fake.openPrs && query.includes("author:@me is:pr is:open")) return json({ data: { search: { nodes: fake.openPrs } } });
    return json({ data: { search: { nodes: [] } } });
  }
  if (u.pathname.endsWith("/search/jql")) {
    const jql = u.searchParams.get("jql");
    appendFileSync(process.env.SB_FAKE_JIRA + ".jql", jql + "\\n");
    const hit = fake.searches.find((r) => jql.includes(r.match));
    return json({ issues: hit ? hit.issues : [] });
  }
  if (u.pathname.endsWith("/myself")) return json({ accountId: "demo-account" });
  return new Response("not found", { status: 404 });
};
`;

function runReal(cfg, searches, { releaseSearch = null, releaseCompare = null, failReviews = false, failReleaseSearch = false, failReleaseCompare = false, openPrs = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sprint-board-real-"));
  try {
    mkdirSync(join(home, ".config", "sprint-widget"), { recursive: true });
    writeFileSync(join(home, ".config", "sprint-widget", "config.json"), JSON.stringify(cfg));
    writeFileSync(join(home, "fake.mjs"), FAKE_FETCH);
    writeFileSync(join(home, "fake.json"), JSON.stringify({ searches, releaseSearch, releaseCompare, failReviews, failReleaseSearch, failReleaseCompare, openPrs }));
    const out = execFileSync(process.execPath,
      ["--import", join(home, "fake.mjs"), fileURLToPath(new URL("./fetch.mjs", import.meta.url))],
      { env: { ...process.env, HOME: home, SB_FAKE_JIRA: join(home, "fake.json") },
        input: JSON.stringify({ jiraToken: "demo-token", githubToken: "demo-token" }), encoding: "utf8" });
    let jql = "";
    try { jql = readFileSync(join(home, "fake.json.jql"), "utf8"); } catch { /* no search made */ }
    let gh = "";
    try { gh = readFileSync(join(home, "fake.json.gh"), "utf8"); } catch { /* no release search made */ }
    return { out: JSON.parse(out), jql: jql.split("\n").filter(Boolean), gh };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const realCfg = { host: "example.invalid", email: "demo-user@example.invalid", sprintFieldId: "customfield_1", qaFieldId: null };
const realSprint = { id: 9002, name: "Demo Team - Sprint#4", state: "active",
  startDate: "2026-01-05T07:00:00.000Z", endDate: "2026-01-19T15:00:00.000Z" };
const myTask = {
  key: "DEMO-101",
  fields: {
    summary: "Template generator", created: "2026-01-02T09:00:00.000Z",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    priority: null, issuetype: { name: "Task" },
    assignee: { accountId: "demo-account", displayName: "Demo User" },
    customfield_1: [realSprint],
  },
  changelog: { total: 0, histories: [] },
};
const releaseEnteredAt = "2026-01-05T10:00:00.000Z";
const pendingIssue = {
  key: "DEMO-107",
  fields: {
    summary: "Missing font-display setting", created: "2025-12-01T09:00:00.000Z",
    status: { name: "Ready For Release", statusCategory: { key: "done" } },
    customfield_1: [{ id: 9001, name: "Demo Team - Sprint#2", state: "closed" }],
  },
  changelog: { total: 1, histories: [{ created: releaseEnteredAt, items: [{ field: "status" }] }] },
};
const realSearches = [
  { match: "NOT IN openSprints()", issues: [pendingIssue] },
  { match: "Flagged is not EMPTY", issues: [myTask] },
  { match: "sprint in openSprints()", issues: [myTask] },
];

test("real run: AWAITING RELEASE fills, counted from the last status change", () => {
  const { out } = runReal(realCfg, realSearches);
  assert.equal(out.ok, true);
  assert.equal(out.pendingReleaseError ?? null, null);
  assert.deepEqual(out.pendingRelease.map((r) => [r.key, r.status, r.sprint]),
    [["DEMO-107", "Ready For Release", "Demo Team - Sprint#2"]]);
  assert.equal(out.pendingRelease[0].days, businessDaysBetween(releaseEnteredAt, new Date()));
});

test("real run: with sprint goal tracking off there is no goal search and no goal data", () => {
  const { out, jql } = runReal(realCfg, realSearches);
  assert.equal(out.sprintGoal, null);
  assert.ok(jql.length >= 2, "the main and pending-release searches ran");
  assert.ok(!jql.some((q) => q.includes("Flagged")), jql.join(" | "));
  assert.ok(out.tasks.every((t) => !t.goal));
});

test("real run: with sprint goal tracking on the goal search runs and my goal task is marked", () => {
  const { out, jql } = runReal({ ...realCfg, sprintGoalTracking: true }, realSearches);
  assert.ok(jql.includes("sprint = 9002 AND Flagged is not EMPTY"), jql.join(" | "));
  assert.deepEqual(out.sprintGoal.rows.map((r) => [r.key, r.owner, r.status]),
    [["DEMO-101", "Demo User", "In Progress"]]);
  assert.deepEqual([out.sprintGoal.done, out.sprintGoal.total], [0, 1]);
  assert.deepEqual(out.tasks.filter((t) => t.goal).map((t) => t.key), ["DEMO-101"]);
});

test("--demo: the board shows the MERGE BLOCKED band, in its order, drafts included by default", () => {
  const out = runDemo({ host: "example.invalid" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.pullRequests.map((r) => [r.repo, r.kind]), [
    ["editor-frontend", "conflict"],
    ["rate-limiter", "conflict"],
    ["web-frontend", "ci"],
    ["worker-jobs", "ci"],
    ["shared-lib", "changes"],
    ["template-generator", "checking"],
  ]);
  assert.deepEqual(out.pullRequests[1].reasons, ["conflict", "draft"]);
});

test("--demo: with sprint goal tracking off there is no goal data and no GOAL mark", () => {
  const out = runDemo({ host: "example.invalid" });
  assert.equal(out.sprintGoal, null);
  assert.ok(out.tasks.every((t) => !t.goal));
});

test("--demo: with sprint goal tracking on the band shows every colour and my goal task is marked", () => {
  const out = runDemo({ host: "example.invalid", sprintGoalTracking: true });
  assert.deepEqual(out.sprintGoal.rows.map((r) => r.risk), ["red", "yellow", "ok", "done"]);
  assert.equal(out.sprintGoal.worst, "red");
  assert.deepEqual([out.sprintGoal.done, out.sprintGoal.total], [1, 4]);
  assert.deepEqual(out.tasks.filter((t) => t.goal).map((t) => t.key), ["DEMO-102"]);
});

test("--demo: with Show draft PRs off the draft leaves the band", () => {
  const out = runDemo({ host: "example.invalid", showDraftPrs: false });
  assert.deepEqual(out.pullRequests.map((r) => r.repo),
    ["editor-frontend", "web-frontend", "worker-jobs", "shared-lib", "template-generator"]);
});

test("--demo: the board is grouped by status and every row carries its PRs", () => {
  const out = runDemo({ host: "example.invalid" });
  assert.deepEqual(out.groups.map((g) => g.status).slice(-2), ["Ready For Release", "Released on Prod"]);
  const prs = Object.fromEntries(out.tasks.filter((t) => t.releasePrs)
    .map((t) => [t.key, t.releasePrs.map((p) => `${p.repo}#${p.number} ${p.status}${p.status === "open" ? " " + p.ci : ""}`)]));
  assert.deepEqual(prs["DEMO-101"], ["web-frontend#4608 open FAILURE", "editor-frontend#327 open FAILURE",
    "template-generator#243 open SUCCESS"]);
  assert.deepEqual(prs["DEMO-102"], ["backend-api#1166 open PENDING", "shared-lib#97 open FAILURE"]);
  assert.deepEqual(prs["DEMO-104"], ["rate-limiter#52 open null"], "a draft has no state");
  assert.ok(out.tasks.every((t) => Array.isArray(t.releasePrs)), "every row carries its PRs");
  assert.deepEqual(prs["DEMO-105"], [], "a task without PRs reads no PR");
  assert.deepEqual(prs["DEMO-106"], ["worker-jobs#288 open FAILURE", "shared-lib#96 merged"]);
  assert.deepEqual(prs["DEMO-112"], ["web-frontend#4590 deployed"]);
  assert.equal(out.done, out.tasks.filter((t) => t.done).length);
});

const sprintIssue = (key, status, category) => ({
  key,
  fields: { ...myTask.fields, summary: `Task ${key}`, status: { name: status, statusCategory: { key: category } } },
  changelog: { total: 0, histories: [] },
});

test("real run: every row gets its PRs from one search; merged on a released task reads deployed", () => {
  const prNode = (number, title, state) =>
    ({ number, title, state, url: `https://example.invalid/pr/${number}`, repository: { name: "demo-repo" } });
  const { out, gh } = runReal({ ...realCfg, githubOrg: "demo-org" }, [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [
      myTask,
      sprintIssue("DEMO-113", "Released on Prod", "done"),
      sprintIssue("DEMO-114", "Ready For Release", "done"),
    ] },
  ], { releaseSearch: {
    "DEMO-113": { nodes: [prNode(41, "DEMO-113 | Export retry", "MERGED")] },
    "DEMO-114": { nodes: [prNode(7, "DEMO-114 | Font fix", "OPEN"), prNode(8, "DEMO-114 | Font fix, part 2", "MERGED")] },
  } });
  assert.match(gh, /"org:demo-org is:pr DEMO-113 in:title"/);
  assert.match(gh, /"org:demo-org is:pr DEMO-114 in:title"/);
  assert.match(gh, /"org:demo-org is:pr DEMO-101 in:title"/, "an active task is searched too");
  assert.equal((gh.match(/r0: search[(]/g) || []).length, 1, "every task in ONE request");
  assert.deepEqual(out.groups.map((g) => g.status), ["In Progress", "Ready For Release", "Released on Prod"]);
  const prs = Object.fromEntries(out.tasks.map((t) => [t.key, (t.releasePrs ?? null) && t.releasePrs.map((p) => p.status)]));
  assert.deepEqual(prs, { "DEMO-101": [], "DEMO-113": ["deployed"], "DEMO-114": ["open", "merged"] });
});

test("real run: a waiting task's PR merged into main reads deployed once master has its merge commit", () => {
  const oid = (c) => c.repeat(40);
  const prNode = (number, title, base, commit) => ({ number, title, state: "MERGED", baseRefName: base,
    mergeCommit: { oid: oid(commit) }, url: `https://example.invalid/pr/${number}`,
    repository: { name: "demo-repo", owner: { login: "demo-org" } } });
  const { out, gh } = runReal({ ...realCfg, githubOrg: "demo-org" }, [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [
      myTask,
      sprintIssue("DEMO-113", "Released on Prod", "done"),
      sprintIssue("DEMO-114", "Ready For Release", "done"),
    ] },
  ], {
    releaseSearch: {
      "DEMO-113": { nodes: [prNode(41, "DEMO-113 | Export retry", "main", "f")] },
      "DEMO-114": { nodes: [
        prNode(8, "DEMO-114 | Font fix", "main", "a"),
        prNode(9, "DEMO-114 | Font fix, part 2", "develop", "b"),
        prNode(10, "DEMO-114 | Font fix, hotfix", "master", "c"),
      ] },
    },
    releaseCompare: {
      [oid("a")]: { ref: { compare: { status: "BEHIND" } } },
      [oid("b")]: { ref: { compare: { status: "DIVERGED" } } },
    },
  });
  assert.match(gh, /c0: repository\(owner: "demo-org", name: "demo-repo"\)/);
  assert.match(gh, /qualifiedName: "refs\/heads\/master"/);
  assert.match(gh, new RegExp(`compare\\(headRef: "${oid("a")}"\\)`));
  assert.match(gh, new RegExp(`c1: [^]*compare\\(headRef: "${oid("b")}"\\)`));
  assert.doesNotMatch(gh, new RegExp(oid("c")), "a PR merged into master is not asked about");
  assert.doesNotMatch(gh, new RegExp(oid("f")), "a finished task is already deployed by Jira");
  const prs = Object.fromEntries(out.tasks.filter((t) => t.releasePrs)
    .map((t) => [t.key, t.releasePrs.map((p) => `#${p.number} ${p.status}`)]));
  assert.deepEqual(prs, { "DEMO-101": [], "DEMO-113": ["#41 deployed"], "DEMO-114": ["#8 deployed", "#9 merged", "#10 merged"] });
});

test("real run: when the master check fails, merged PRs stay merged and the board carries on", () => {
  const prNode = { number: 8, title: "DEMO-114 | Font fix", state: "MERGED", baseRefName: "main",
    mergeCommit: { oid: "a".repeat(40) }, url: "#", repository: { name: "demo-repo", owner: { login: "demo-org" } } };
  const { out } = runReal({ ...realCfg, githubOrg: "demo-org" }, [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [myTask, sprintIssue("DEMO-114", "Ready For Release", "done")] },
  ], { releaseSearch: { "DEMO-114": { nodes: [prNode] } }, releaseCompare: { ["a".repeat(40)]: { ref: null } } });
  assert.deepEqual(out.tasks.find((t) => t.key === "DEMO-114").releasePrs.map((p) => p.status), ["merged"]);
});

test("real run: when the master check request fails with HTTP 500, merged PRs stay merged and no error is shown", () => {
  const prNode = { number: 8, title: "DEMO-114 | Font fix", state: "MERGED", baseRefName: "main",
    mergeCommit: { oid: "a".repeat(40) }, url: "#", repository: { name: "demo-repo", owner: { login: "demo-org" } } };
  const { out, gh } = runReal({ ...realCfg, githubOrg: "demo-org" }, [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [myTask, sprintIssue("DEMO-114", "Ready For Release", "done")] },
  ], { releaseSearch: { "DEMO-114": { nodes: [prNode] } }, failReleaseCompare: true });
  assert.match(gh, /c0: repository\(owner: "demo-org", name: "demo-repo"\)/, "the master check was asked");
  assert.deepEqual(out.tasks.find((t) => t.key === "DEMO-114").releasePrs.map((p) => p.status), ["merged"]);
  assert.equal(out.releasePrsError, null);
});

test("real run: a task closed without a released status reads merged unless master has the commit", () => {
  const prNode = (number, title, commit) => ({ number, title, state: "MERGED", baseRefName: "develop",
    mergeCommit: { oid: commit.repeat(40) }, url: "#", repository: { name: "demo-repo", owner: { login: "demo-org" } } });
  const { out, gh } = runReal({ ...realCfg, githubOrg: "demo-org" }, [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [
      myTask,
      sprintIssue("DEMO-115", "Closed", "done"),
      sprintIssue("DEMO-116", "Done", "done"),
    ] },
  ], {
    releaseSearch: {
      "DEMO-115": { nodes: [prNode(51, "DEMO-115 | Cleanup", "d")] },
      "DEMO-116": { nodes: [prNode(52, "DEMO-116 | Copy fix", "e")] },
    },
    releaseCompare: {
      ["d".repeat(40)]: { ref: { compare: { status: "BEHIND" } } },
      ["e".repeat(40)]: { ref: { compare: { status: "DIVERGED" } } },
    },
  });
  assert.match(gh, new RegExp(`c0: [^]*compare\\(headRef: "${"d".repeat(40)}"\\)`));
  assert.match(gh, new RegExp(`c1: [^]*compare\\(headRef: "${"e".repeat(40)}"\\)`));
  const prs = Object.fromEntries(out.tasks.filter((t) => t.releasePrs)
    .map((t) => [t.key, t.releasePrs.map((p) => `#${p.number} ${p.status}`)]));
  assert.deepEqual(prs, { "DEMO-101": [], "DEMO-115": ["#51 deployed"], "DEMO-116": ["#52 merged"] });
});

test("real run: a failed release search marks the PR column unknown, says why and keeps the badge data", () => {
  const searches = [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [myTask, sprintIssue("DEMO-114", "Ready For Release", "done")] },
  ];
  const ok = runReal({ ...realCfg, githubOrg: "demo-org" }, searches, { releaseSearch: { "DEMO-114": { nodes: [] } } }).out;
  assert.equal(ok.releasePrsError, null);
  assert.deepEqual(ok.tasks.find((t) => t.key === "DEMO-114").releasePrs, []);
  const openPrs = [{ number: 7, title: "DEMO-114 | Font fix", url: "#7", isDraft: false, mergeable: "CONFLICTING",
    repository: { name: "demo-repo", nameWithOwner: "demo-org/demo-repo" } }];
  const failed = runReal({ ...realCfg, githubOrg: "demo-org" }, searches, { failReleaseSearch: true, openPrs }).out;
  const task = failed.tasks.find((t) => t.key === "DEMO-114");
  assert.equal(task.releasePrs, null);
  assert.deepEqual(task.pr, { count: 1, state: "FAILURE" }, "the row falls back to the badge the open-PR search still gives");
  assert.match(failed.releasePrsError, /HTTP 500/);
});

test("real run: an active task's open PR carries its own state; a conflict reads as broken", () => {
  const repository = { name: "demo-repo", owner: { login: "demo-org" } };
  const { out } = runReal({ ...realCfg, githubOrg: "demo-org" }, [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [myTask] },
  ], {
    releaseSearch: { "DEMO-101": { nodes: [
      { number: 7, title: "DEMO-101 | Generator", state: "OPEN", url: "#7", repository },
      { number: 8, title: "DEMO-101 | Generator, part 2", state: "MERGED", baseRefName: "master",
        mergeCommit: { oid: "c".repeat(40) }, url: "#8", repository },
    ] } },
    openPrs: [{ number: 7, title: "DEMO-101 | Generator", url: "#7", isDraft: false, mergeable: "CONFLICTING",
      repository: { name: "demo-repo", nameWithOwner: "demo-org/demo-repo" } }],
  });
  const rows = out.tasks.find((t) => t.key === "DEMO-101").releasePrs;
  assert.deepEqual(rows.map((r) => [r.number, r.status, r.status === "open" ? r.ci : "-"]),
    [[7, "open", "FAILURE"], [8, "merged", "-"]]);
  assert.deepEqual(rows[0].checks, ["conflict — needs rebase"]);
});

test("real run: a failed review search is reported, so the board never calls GitHub clear", () => {
  const searches = [
    { match: "NOT IN openSprints()", issues: [] },
    { match: "sprint in openSprints()", issues: [myTask] },
  ];
  const ok = runReal({ ...realCfg, githubOrg: "demo-org" }, searches).out;
  assert.equal(ok.reviewsAvailable, true);
  const failed = runReal({ ...realCfg, githubOrg: "demo-org" }, searches, { failReviews: true }).out;
  assert.equal(failed.reviewsAvailable, false);
  assert.deepEqual(failed.reviewRequests, []);
  assert.equal(runDemo({ host: "example.invalid" }).reviewsAvailable, true);
});

const swiftAvailable = spawnSync("swiftc", ["--version"]).status === 0;

function swiftSource(src, name) {
  const start = src.indexOf(`\nfunc ${name}(`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${name} not found in SprintBoard.swift`);
  return src.slice(start + 1, end + 3);
}

const hostInputs = [
  "acme.atlassian.net",
  "https://ACME.atlassian.net/",
  "other.example?.atlassian.net",
  "x#.atlassian.net",
  "evil.com/.atlassian.net",
  ".atlassian.net",
  "a..atlassian.net",
  "user@x.atlassian.net",
];

const configInputs = {
  missing: {},
  notOwned: { tokensOwnedByApp: false },
  oauthAfterToken: { tokensOwnedByApp: true, authMode: "oauth", keychainService: "sprint-board-jira-token" },
  oauthLegacy: { tokensOwnedByApp: true, authMode: "oauth", keychainService: "sprint-board-jira" },
  ownedDefault: { tokensOwnedByApp: true },
  ownedNamed: { tokensOwnedByApp: true, keychainService: "sprint-board-jira-token" },
};

const orgInputs = [...orgValid, ...orgEmpty, ...orgInvalid];

const conflictNote = { id: "conflict-demo-repo#7", title: "Conflict: demo-repo #7", body: "DEMO-7 | demo change", url: "https://example.invalid/demo-repo/pull/7" };
const goodResult = { ok: true, notify: [conflictNote], summary: { id: "refresh", title: "1 conflict", body: "demo-repo#7", url: null } };
const resultInputs = {
  setupScreen: { obj: goodResult, ok: true, manual: false, onSetupScreen: true },
  setupScreenManual: { obj: goodResult, ok: true, manual: true, onSetupScreen: true },
  boardAuto: { obj: goodResult, ok: true, manual: false, onSetupScreen: false },
  boardManual: { obj: goodResult, ok: true, manual: true, onSetupScreen: false },
  boardManualFailed: { obj: { ok: false, error: "GitHub HTTP 502" }, ok: false, manual: true, onSetupScreen: false },
};

const setupInputs = {
  signedOut: {},
  disconnected: { githubOrg: "acme", showDraftPrs: false },
  emptyEmail: { email: "" },
  oauth: { email: "ada@example.invalid", authMode: "oauth", tokensOwnedByApp: true, githubOrg: "acme" },
  token: { email: "ada@example.invalid", authMode: "token", tokensOwnedByApp: true, showDraftPrs: false, sprintGoalTracking: true,
    partnerDomainSuffixes: ["panel.example.test", "API.example.test", "bad name"] },
  handMade: { email: "ada@example.invalid", keychainService: "sprint-board-jira" },
};

// A typed partner domain list and what Settings saves for it; null = refused.
const partnerListInputs = {
  "": [], " , ": [], "panel.example.test": ["panel.example.test"],
  " Panel.Example.TEST , api.example.test,panel.example.test ": ["panel.example.test", "api.example.test"],
  "panel.example.test, bad name": null, "single": null,
};

let swiftCache;
function swiftHelpers() {
  if (swiftCache) return swiftCache;
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const keychainConsts = ["JIRA_KEYCHAIN", "JIRA_TOKEN_KEYCHAIN"].map((name) => {
    const line = src.match(new RegExp(`^let ${name} = .*$`, "m"));
    assert.ok(line, `${name} not found in SprintBoard.swift`);
    return line[0];
  });
  const driver = `import Foundation
${keychainConsts.join("\n")}
${swiftSource(src, "jiraCloudHost")}
${swiftSource(src, "appWrittenTokenService")}
${swiftSource(src, "githubOrgName")}
${swiftSource(src, "hostsName")}
${swiftSource(src, "partnerDomainSuffixes")}
${swiftSource(src, "partnerSuffixList")}
${swiftSource(src, "resultNotifications")}
${swiftSource(src, "dockChoice")}
${swiftSource(src, "toggledDockChoice")}
${swiftSource(src, "disconnectHint")}
${swiftSource(src, "setupContext")}
let input = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
let hosts: [Any] = (input["hosts"] as! [String]).map { h in jiraCloudHost(h).map { $0 as Any } ?? NSNull() }
let configs = input["configs"] as! [String: [String: Any]]
var services: [String: Any] = [:]
for (key, cfg) in configs { services[key] = appWrittenTokenService(cfg).map { $0 as Any } ?? NSNull() }
let orgs: [Any] = (input["orgs"] as! [String]).map { o in githubOrgName(o).map { $0 as Any } ?? NSNull() }
let partnerLists: [Any] = (input["partnerLists"] as! [String]).map { p in partnerSuffixList(p).map { $0 as Any } ?? NSNull() }
var notes: [String: Any] = [:]
for (key, r) in input["results"] as! [String: [String: Any]] {
  notes[key] = resultNotifications(r["obj"] as? [String: Any], ok: r["ok"] as! Bool,
                                   manual: r["manual"] as! Bool, onSetupScreen: r["onSetupScreen"] as! Bool)
}
let dock: [String: Bool] = [
  "unset": dockChoice(nil), "storedTrue": dockChoice(true), "storedFalse": dockChoice(false),
  "toggledFromUnset": toggledDockChoice(nil), "toggledFromTrue": toggledDockChoice(true),
]
var contexts: [String: Any] = [:]
for (key, cfg) in input["setups"] as! [String: [String: Any]] { contexts[key] = setupContext(cfg) ?? NSNull() }
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["hosts": hosts, "services": services, "orgs": orgs, "notes": notes, "dock": dock, "contexts": contexts, "partnerLists": partnerLists]))
`;
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-swift-"));
  try {
    writeFileSync(join(dir, "main.swift"), driver);
    execFileSync("swiftc", [join(dir, "main.swift"), "-o", join(dir, "helpers")], { stdio: "pipe" });
    const out = JSON.parse(
      execFileSync(join(dir, "helpers"), { input: JSON.stringify({ hosts: hostInputs, configs: configInputs, orgs: orgInputs, results: resultInputs, setups: setupInputs, partnerLists: Object.keys(partnerListInputs) }) }),
    );
    swiftCache = {
      host: Object.fromEntries(hostInputs.map((h, i) => [h, out.hosts[i]])),
      service: out.services,
      org: Object.fromEntries(orgInputs.map((o, i) => [o, out.orgs[i]])),
      notes: out.notes,
      dock: out.dock,
      contexts: out.contexts,
      partnerLists: Object.fromEntries(Object.keys(partnerListInputs).map((p, i) => [p, out.partnerLists[i]])),
    };
    return swiftCache;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("jiraCloudHost: a bare atlassian.net host is accepted as-is", { skip: !swiftAvailable }, () => {
  assert.equal(swiftHelpers().host["acme.atlassian.net"], "acme.atlassian.net");
});

test("jiraCloudHost: scheme, upper case and trailing slash are normalised away", { skip: !swiftAvailable }, () => {
  assert.equal(swiftHelpers().host["https://ACME.atlassian.net/"], "acme.atlassian.net");
});

test("jiraCloudHost: a non-host character before the suffix is refused", { skip: !swiftAvailable }, () => {
  const { host } = swiftHelpers();
  for (const raw of ["other.example?.atlassian.net", "x#.atlassian.net", "evil.com/.atlassian.net", "user@x.atlassian.net"]) {
    assert.equal(host[raw], null, raw);
  }
});

test("jiraCloudHost: an empty label is refused", { skip: !swiftAvailable }, () => {
  const { host } = swiftHelpers();
  assert.equal(host[".atlassian.net"], null);
  assert.equal(host["a..atlassian.net"], null);
});

test("appWrittenTokenService: a token the app did not write is left alone", { skip: !swiftAvailable }, () => {
  const { service } = swiftHelpers();
  assert.equal(service.missing, null);
  assert.equal(service.notOwned, null);
});

test("appWrittenTokenService: after switching from an API token to OAuth, the token entry is still the app's", { skip: !swiftAvailable }, () => {
  assert.equal(swiftHelpers().service.oauthAfterToken, "sprint-board-jira-token");
});

test("appWrittenTokenService: under OAuth an older keychainService name is left alone", { skip: !swiftAvailable }, () => {
  assert.equal(swiftHelpers().service.oauthLegacy, null);
});

test("appWrittenTokenService: an owned token without keychainService is the first version's entry", { skip: !swiftAvailable }, () => {
  assert.equal(swiftHelpers().service.ownedDefault, "sprint-board-jira");
});

test("appWrittenTokenService: an owned token's keychainService names the entry", { skip: !swiftAvailable }, () => {
  assert.equal(swiftHelpers().service.ownedNamed, "sprint-board-jira-token");
});

test("githubOrgName: a valid organization name is kept, trimmed", { skip: !swiftAvailable }, () => {
  const { org } = swiftHelpers();
  for (const raw of orgValid) assert.equal(org[raw], raw.trim(), raw);
});

test("githubOrgName: empty means all PRs", { skip: !swiftAvailable }, () => {
  const { org } = swiftHelpers();
  for (const raw of orgEmpty) assert.equal(org[raw], "", JSON.stringify(raw));
});

test("githubOrgName: an invalid name is refused", { skip: !swiftAvailable }, () => {
  const { org } = swiftHelpers();
  for (const raw of orgInvalid) assert.equal(org[raw], null, raw);
});

test("resultNotifications: a conflict found while the setup screen is open still notifies", { skip: !swiftAvailable }, () => {
  const { notes } = swiftHelpers();
  assert.deepEqual(notes.setupScreen, [conflictNote]);
  assert.deepEqual(notes.setupScreenManual, [conflictNote], "the setup screen cancels the refresh summary only");
});

test("resultNotifications: an automatic refresh sends only the new conflicts", { skip: !swiftAvailable }, () => {
  assert.deepEqual(swiftHelpers().notes.boardAuto, [conflictNote]);
});

test("resultNotifications: a refresh the user asked for also reports its summary", { skip: !swiftAvailable }, () => {
  assert.deepEqual(swiftHelpers().notes.boardManual,
    [conflictNote, { id: "refresh", title: "1 conflict", body: "demo-repo#7" }]);
});

test("setupContext: signed out (first run, after Disconnect) gives no context, so the sign-in block shows", { skip: !swiftAvailable }, () => {
  const { contexts } = swiftHelpers();
  assert.equal(contexts.signedOut, null);
  assert.equal(contexts.disconnected, null);
  assert.equal(contexts.emptyEmail, null);
});

test("setupContext: signed in, in any mode, gives a context, so the sign-in block hides", { skip: !swiftAvailable }, () => {
  const { contexts } = swiftHelpers();
  assert.equal(contexts.oauth.mode, "oauth");
  assert.equal(contexts.token.mode, "token");
  assert.equal(contexts.handMade.mode, "token");
  for (const key of ["oauth", "token", "handMade"]) assert.equal(contexts[key].email, "ada@example.invalid", key);
});

test("setupContext: carries the board settings, with their defaults", { skip: !swiftAvailable }, () => {
  const { contexts } = swiftHelpers();
  assert.equal(contexts.oauth.githubOrg, "acme");
  assert.equal(contexts.oauth.showDraftPrs, true);
  assert.equal(contexts.token.githubOrg, "");
  assert.equal(contexts.token.showDraftPrs, false);
});

test("partnerSuffixList: a comma-separated list of domain names, trimmed, lower case and without repeats; any other entry refuses it all", { skip: !swiftAvailable }, () => {
  assert.deepEqual(swiftHelpers().partnerLists, partnerListInputs);
});

test("setupContext: carries the partner domain suffixes, none by default", { skip: !swiftAvailable }, () => {
  const { contexts } = swiftHelpers();
  assert.deepEqual(contexts.token.partnerDomainSuffixes, ["panel.example.test", "api.example.test"]);
  assert.deepEqual(contexts.oauth.partnerDomainSuffixes, []);
});

test("saveSettings: the popover's Settings saves the partner domains; a save that does not send them keeps them", () => {
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const save = methodSource(swift, "saveSettings");
  assert.match(save, /if let typed = s\["partnerDomainSuffixes"\] as\? String \{\n\s*guard let partners = partnerSuffixList\(typed\) else \{/);
  assert.match(save, /cfg\["partnerDomainSuffixes"\] = partners/);
  assert.match(save, /"partnerDomainSuffixes": partnerDomainSuffixes\(cfg\)\], to: page\)/);
  const page = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  assert.match(page, /<input id="partners" placeholder="empty = no Add partner"/);
  assert.match(page, /\$\("partners"\)\.value = \(s\.partnerDomainSuffixes \|\| \[\]\)\.join\(", "\);/);
  assert.match(page, /partnerDomainSuffixes: \$\("partners"\)\.value \}/);
  assert.doesNotMatch(readFileSync(new URL("./setup.html", import.meta.url), "utf8"), /partnerDomainSuffixes/, "the widget's Settings does not send them");
});

test("setupContext: sprint goal tracking is off unless the config turns it on", { skip: !swiftAvailable }, () => {
  const { contexts } = swiftHelpers();
  assert.equal(contexts.oauth.sprintGoalTracking, false);
  assert.equal(contexts.token.sprintGoalTracking, true);
});

test("disconnectHint: Atlassian sign-in points to connected apps", { skip: !swiftAvailable }, () => {
  const { hint } = swiftHelpers().contexts.oauth;
  assert.match(hint.text, /Connected apps/);
  assert.equal(hint.url, "https://id.atlassian.com/manage-profile/apps");
});

test("disconnectHint: an API token the app saved points to the API tokens page", { skip: !swiftAvailable }, () => {
  const { hint } = swiftHelpers().contexts.token;
  assert.match(hint.text, /removes the token from this Mac/);
  assert.equal(hint.url, "https://id.atlassian.com/manage-profile/security/api-tokens");
});

test("disconnectHint: a keychain entry made by hand says Disconnect deletes nothing", { skip: !swiftAvailable }, () => {
  const { hint } = swiftHelpers().contexts.handMade;
  assert.match(hint.text, /deletes nothing/);
  assert.equal(hint.url, undefined);
});

test("dockChoice: with no stored choice the app is not in the Dock", { skip: !swiftAvailable }, () => {
  const { dock } = swiftHelpers();
  assert.equal(dock.unset, false);
  assert.equal(dock.storedFalse, false);
  assert.equal(dock.storedTrue, true);
});

test("toggledDockChoice: Show in Dock turns it on, a second click turns it off", { skip: !swiftAvailable }, () => {
  const { dock } = swiftHelpers();
  assert.equal(dock.toggledFromUnset, true);
  assert.equal(dock.toggledFromTrue, false);
});

test("resultNotifications: a failed refresh the user asked for says so", { skip: !swiftAvailable }, () => {
  assert.deepEqual(swiftHelpers().notes.boardManualFailed,
    [{ id: "refresh", title: "Refresh failed", body: "GitHub HTTP 502" }]);
});

// --- Hosts: Sprint Board's block in /etc/hosts -----------------------------------------
// The functions are cut out of SprintBoard.swift and compiled once into a driver that takes
// a list of operations on stdin. Writes only ever go to files in a temp dir — never to the
// real /etc/hosts.

// Like swiftSource, for a top-level declaration that is not a function (a struct).
function swiftDecl(src, header) {
  const start = src.indexOf(`\n${header}`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${header} not found in SprintBoard.swift`);
  return src.slice(start + 1, end + 3);
}

let hostsDriver;
function hostsRun(ops) {
  if (!hostsDriver) {
    const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
    const consts = ["HOSTS_BLOCK_START", "HOSTS_BLOCK_END", "HOSTS_LEGACY_BLOCK_START", "HOSTS_LEGACY_BLOCK_END",
      "HOSTS_SYSTEM_NAMES", "HOSTS_LOCAL_ADDRESSES", "HOSTS_DELETE_BACKUP_PREFIX", "HOSTS_DELETE_BACKUPS_KEPT", "PARTNERS_GROUP", "CHROME_INSECURE_FLAGS"].map((name) => {
      const line = src.match(new RegExp(`^let ${name} = .*$`, "m"));
      assert.ok(line, `${name} not found in SprintBoard.swift`);
      return line[0];
    });
    const structs = ["struct HostsGroup", "struct HostsList", "struct HostsRow", "struct HostsEdit"].map((header) => swiftDecl(src, header));
    const funcs = ["hostsName", "hostsEntry", "hostsMarkers", "hostsBlockRange", "managedHosts", "hostsLocalLine", "hostsCommented",
      "hostsUncommented", "hostsLineWithout", "hostsEntryWithout", "hostsRows", "hostsSwitched", "hostsAdded", "hostsRemoved", "hostsEdited",
      "hostsPartnerName", "partnerDomainSuffixes", "hostsGroupName", "hostsList", "hostsListJSON", "hostsApply", "hostsStatus",
      "hostsFileText", "hostsDeleteBackupName", "hostsDeleteBackupPath", "hostsDeleteBackupsPast", "writeHostsFile", "chromeRefreshScript", "chromeRefreshNote", "chromeMissingFlags"].map((name) => swiftSource(src, name));
    const driver = `import Foundation
${consts.join("\n")}
${structs.join("\n")}
${funcs.join("\n")}
func listOut(_ list: HostsList) -> [String: Any] {
    ["domains": list.domains, "groups": list.groups.map { ["name": $0.name, "domains": $0.domains] }]
}
let ops = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
let results: [Any] = ops.map { op in
    let text = op["text"] as? String ?? ""
    let names = op["names"] as? [String] ?? []
    switch op["op"] as! String {
    case "name": return hostsName(op["raw"] as! String).map { $0 as Any } ?? NSNull()
    case "managed": return managedHosts(text).map { $0 as Any } ?? NSNull()
    case "rows": return hostsRows(text).map { ["name": $0.name, "local": $0.local] }
    case "switch": return hostsSwitched(text, Set(names), local: op["local"] as! Bool)
    case "add": return hostsAdded(text, names).map { $0 as Any } ?? NSNull()
    case "remove": return hostsRemoved(text, names).map { $0 as Any } ?? NSNull()
    case "status":
        return hostsStatus(text, hostsList(fromJSON: op["list"]) ?? HostsList(), writable: op["writable"] as? Bool ?? true)
    case "groupName": return hostsGroupName(op["raw"] as! String).map { $0 as Any } ?? NSNull()
    case "partnerName": return hostsPartnerName(op["raw"] as! String).map { $0 as Any } ?? NSNull()
    case "partnerSuffixes": return partnerDomainSuffixes(op["config"] as? [String: Any] ?? [:])
    case "list": return hostsList(fromJSON: op["json"]).map { listOut($0) as Any } ?? NSNull()
    case "saved": return hostsListJSON(hostsList(fromJSON: op["json"])!)
    case "apply":
        let r = hostsApply(hostsList(fromJSON: op["list"])!, local: op["local"] as? [String] ?? [],
                           op["action"] as! [String: Any], partners: op["partners"] as? [String] ?? [])
        return ["list": listOut(r.list), "local": r.local, "error": r.error.map { $0 as Any } ?? NSNull()]
    case "write":
        let edit = HostsEdit(added: op["added"] as? [String] ?? [], removed: op["removed"] as? [String] ?? [],
                             toLocal: op["toLocal"] as? [String] ?? [], toProd: op["toProd"] as? [String] ?? [])
        return writeHostsFile(edit, path: op["path"] as! String, backupDir: op["backupDir"] as! String)
            .map { $0 as Any } ?? NSNull()
    case "deleteBackupName": return hostsDeleteBackupName(Date(timeIntervalSince1970: (op["ms"] as! Double) / 1000))
    case "deleteBackupPath":
        return hostsDeleteBackupPath(in: op["dir"] as! String, at: Date(timeIntervalSince1970: (op["ms"] as! Double) / 1000))
    case "deleteBackupsPast": return hostsDeleteBackupsPast(op["names"] as! [String])
    case "chromeScript": return chromeRefreshScript()
    case "missingFlags": return chromeMissingFlags(op["commandLine"] as! String)
    case "insecureFlags": return CHROME_INSECURE_FLAGS
    case "chromeNote":
        return chromeRefreshNote(status: Int32(op["status"] as! Int), stderr: op["stderr"] as? String ?? "",
                                 timedOut: op["timedOut"] as? Bool ?? false).map { $0 as Any } ?? NSNull()
    default: return NSNull()
    }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: results, options: [.fragmentsAllowed]))
`;
    const dir = mkdtempSync(join(tmpdir(), "sprint-board-hosts-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "main.swift"), driver);
    execFileSync("swiftc", [join(dir, "main.swift"), "-o", join(dir, "hosts")], { stdio: "pipe" });
    hostsDriver = join(dir, "hosts");
  }
  return JSON.parse(execFileSync(hostsDriver, { input: JSON.stringify(ops) }));
}
const hostsOne = (op) => hostsRun([op])[0];

const SAMPLE_HOSTS = [
  "##",
  "# Host Database",
  "127.0.0.1\tlocalhost",
  "255.255.255.255\tbroadcasthost",
  "",
  "# Hand-kept",
  "127.0.0.1 app.example.test api.example.test",
  "#127.0.0.1 old.example.test",
  "10.0.0.5 pinned.example.test",
  "",
].join("\n");
const BLOCK_START = "# >>> extension manages >>>";
const BLOCK_END = "# <<< extension manages <<<";
// The markers before the rename: files written then still carry them.
const LEGACY_START = "# >>> sprint-board hosts managed >>>";
const LEGACY_END = "# <<< sprint-board hosts managed <<<";
// A file with active lines in the managed block, as a fixture.
const withBlock = (text, names) => `${text}${BLOCK_START}\n${names.map((name) => `127.0.0.1\t${name}\n`).join("")}${BLOCK_END}\n`;

test("hostsName: a typed domain is normalised to the bare host name", { skip: !swiftAvailable }, () => {
  const cases = {
    "  App.Example.TEST  ": "app.example.test",
    "https://app.example.test:8080/path?q=1": "app.example.test",
    "app.example.test.": "app.example.test",
    "app.example.test:3000": "app.example.test",
    "a-b.c1.example.test": "a-b.c1.example.test",
  };
  const out = hostsRun(Object.keys(cases).map((raw) => ({ op: "name", raw })));
  assert.deepEqual(out, Object.values(cases));
});

test("hostsName: anything that is not a host name is refused, so it can never reach /etc/hosts", { skip: !swiftAvailable }, () => {
  const bad = [
    "", "localhost", "app", "a b.example.test", "app.example.test\n10.0.0.1 evil.example.test",
    "app.example.test\t10.0.0.1", "-app.example.test", "app-.example.test", "app_x.example.test",
    "1.2.3.4", "ünicode.example.test", "app..example.test", `${"a".repeat(64)}.example.test`,
    `${"a.".repeat(127)}test`,
  ];
  assert.deepEqual(hostsRun(bad.map((raw) => ({ op: "name", raw }))), bad.map(() => null), "every input must be refused");
});

// The page checks an entry before it sends it (hosts.html: hostName, partnerName). Those checks
// must answer as Swift's hostsName and hostsPartnerName do, or the page would refuse a name Swift
// accepts, or the reverse; a comma-separated add relies on them for every entry.
function pageChecks() {
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  const body = (name) => {
    const start = page.indexOf(`  function ${name}(`);
    assert.ok(start >= 0, `${name} not found in hosts.html`);
    let depth = 0, end = page.indexOf("{", start);
    for (; end < page.length; end++) {
      if (page[end] === "{") depth++;
      else if (page[end] === "}" && --depth === 0) break;
    }
    return page.slice(start, end + 1);
  };
  return new Function(`${body("hostName")}\n${body("partnerName")}\nreturn { hostName, partnerName };`)();
}

test("hosts.html checks domains and partner names exactly as Swift does", { skip: !swiftAvailable }, () => {
  const { hostName, partnerName } = pageChecks();
  const domains = [
    "  App.Example.TEST  ", "https://app.example.test:8080/path?q=1", "app.example.test.", "app.example.test:3000",
    "a-b.c1.example.test", "app.example.test:", "HTTP://X.Example.TEST/z#w", "",
    "localhost", "app", "a b.example.test", "app.example.test\n10.0.0.1 evil.example.test", "app.example.test\t10.0.0.1",
    "-app.example.test", "app-.example.test", "app_x.example.test", "1.2.3.4", "ünicode.example.test", "app..example.test",
    `${"a".repeat(64)}.example.test`, `${"a.".repeat(127)}test`, "a.example.test,b.example.test", "host:",
  ];
  const partners = [
    "demoshop", "DemoShop", "https://demoshop.panel.example.test/x", "demo-shop", "demo.shop", "bad name",
    "-x", "x-", "a".repeat(60), "a".repeat(61), "", "ünï",
  ];
  assert.deepEqual(domains.map(hostName), hostsRun(domains.map((raw) => ({ op: "name", raw }))));
  assert.deepEqual(partners.map(partnerName), hostsRun(partners.map((raw) => ({ op: "partnerName", raw }))));
});

test("managedHosts: no block is [], a block gives its names, a broken block is null", { skip: !swiftAvailable }, () => {
  const local = withBlock(SAMPLE_HOSTS, ["cdn.example.test", "app.example.test"]);
  const damaged = [
    `${SAMPLE_HOSTS}${BLOCK_START}\n127.0.0.1\tcdn.example.test\n`,                       // no end
    `${SAMPLE_HOSTS}127.0.0.1\tcdn.example.test\n${BLOCK_END}\n`,                         // no start
    `${SAMPLE_HOSTS}${BLOCK_END}\n${BLOCK_START}\n`,                                      // reversed
    `${local}${BLOCK_START}\n${BLOCK_END}\n`,                                             // two blocks
  ];
  const out = hostsRun([SAMPLE_HOSTS, local, ...damaged].map((text) => ({ op: "managed", text })));
  assert.deepEqual(out[0], []);
  assert.deepEqual(out[1], ["cdn.example.test", "app.example.test"]);
  assert.deepEqual(out.slice(2), [null, null, null, null]);
});

test("hostsAdded: a new domain goes into a new block at the end, in Prod, and leaves every other byte alone", { skip: !swiftAvailable }, () => {
  assert.equal(hostsOne({ op: "add", text: SAMPLE_HOSTS, names: ["cdn.example.test"] }),
    `${SAMPLE_HOSTS}${BLOCK_START}\n#127.0.0.1\tcdn.example.test\n${BLOCK_END}\n`);
});

test("hostsAdded: an existing block takes the new line at its end, where it stands", { skip: !swiftAvailable }, () => {
  const [head, tail] = ["##\n127.0.0.1\tlocalhost\n", "# after the block\n10.0.0.5 pinned.example.test\n"];
  const text = `${head}${BLOCK_START}\n127.0.0.1\told.example.test\n${BLOCK_END}\n${tail}`;
  assert.equal(hostsOne({ op: "add", text, names: ["cdn.example.test", "api.example.test"] }),
    `${head}${BLOCK_START}\n127.0.0.1\told.example.test\n#127.0.0.1\tcdn.example.test\n#127.0.0.1\tapi.example.test\n${BLOCK_END}\n${tail}`);
});

test("hostsRemoved: the last line out takes the block with it and gives back the original file exactly", { skip: !swiftAvailable }, () => {
  const added = hostsOne({ op: "add", text: SAMPLE_HOSTS, names: ["cdn.example.test", "api2.example.test"] });
  const one = hostsOne({ op: "remove", text: added, names: ["api2.example.test"] });
  assert.equal(one, `${SAMPLE_HOSTS}${BLOCK_START}\n#127.0.0.1\tcdn.example.test\n${BLOCK_END}\n`);
  assert.equal(hostsOne({ op: "remove", text: one, names: ["cdn.example.test"] }), SAMPLE_HOSTS);
});

test("hostsRemoved: a file without a final newline also comes back exactly", { skip: !swiftAvailable }, () => {
  const text = "##\n127.0.0.1\tlocalhost";
  const added = hostsOne({ op: "add", text, names: ["cdn.example.test"] });
  assert.equal(added, `${text}\n${BLOCK_START}\n#127.0.0.1\tcdn.example.test\n${BLOCK_END}`);
  assert.equal(hostsOne({ op: "remove", text: added, names: ["cdn.example.test"] }), text);
});

test("hostsAdded: names are checked again and de-duplicated before they are written", { skip: !swiftAvailable }, () => {
  const out = hostsOne({ op: "add", text: SAMPLE_HOSTS, names: ["cdn.example.test\n10.0.0.1 evil.example.test", "Cdn.Example.Test", "cdn.example.test", "app.example.test"] });
  assert.equal(out, `${SAMPLE_HOSTS}${BLOCK_START}\n#127.0.0.1\tcdn.example.test\n${BLOCK_END}\n`, "a name already in the file is not added again");
  assert.doesNotMatch(out, /evil/);
});

test("hostsAdded, hostsRemoved: a broken block is never rewritten", { skip: !swiftAvailable }, () => {
  const text = `${SAMPLE_HOSTS}${BLOCK_START}\n`;
  assert.deepEqual(hostsRun([{ op: "add", text, names: ["cdn.example.test"] }, { op: "remove", text, names: ["cdn.example.test"] }]), [null, null]);
});

test("hostsStatus: each row and its state come from the file, with its groups", { skip: !swiftAvailable }, () => {
  const list = { groups: [{ name: "Web", domains: ["cdn.example.test"] }] };
  const text = withBlock(SAMPLE_HOSTS, ["cdn.example.test"]);
  const [state, damaged] = hostsRun([
    { op: "status", text, list },
    { op: "status", text: `${SAMPLE_HOSTS}${BLOCK_END}\n`, list, writable: false },
  ]);
  assert.equal(state.mode, "ok");
  assert.deepEqual(state.domains, [
    { name: "app.example.test", local: true, groups: [] },
    { name: "api.example.test", local: true, groups: [] },
    { name: "old.example.test", local: false, groups: [] },
    { name: "cdn.example.test", local: true, groups: ["Web"] },
  ]);
  assert.deepEqual(state.groups, ["Web"]);
  assert.equal(damaged.mode, "damaged");
  assert.equal(damaged.writable, false);
  assert.ok(!("conflicts" in state) && !("importable" in state), "nothing is left to import");
});

const LIST = {
  domains: ["nova.example.test", "cortex.example.test", "shared.example.test", "shop.example.test"],
  groups: [
    { name: "NOVA", domains: ["nova.example.test", "cortex.example.test", "shared.example.test"] },
    { name: "Shop", domains: ["shop.example.test", "shared.example.test"] },
  ],
};
// Invented partner domain suffixes; the app reads its own from the config (partnerDomainSuffixes).
const PARTNER_SUFFIXES = ["panel.example.test", "api.example.test", "ops.example.test"];
const apply = (action, local = [], list = LIST, partners = PARTNER_SUFFIXES) =>
  hostsOne({ op: "apply", list, local, action, partners });

test("hostsList: a list saved before groups reads as the same domains with no groups", { skip: !swiftAvailable }, () => {
  assert.deepEqual(hostsOne({ op: "list", json: { domains: ["a.example.test", "B.example.test", "a.example.test", "bad name"] } }),
    { domains: ["a.example.test", "b.example.test"], groups: [] });
  assert.equal(hostsOne({ op: "list", json: { nope: true } }), null);
});

test("hostsList: groups keep only listed domains and the first of two names that differ only in case", { skip: !swiftAvailable }, () => {
  const out = hostsOne({ op: "list", json: {
    domains: ["a.example.test"],
    groups: [{ name: " NOVA ", domains: ["a.example.test", "x.example.test"] }, { name: "nova", domains: [] }, { name: "", domains: [] }],
  } });
  assert.deepEqual(out.groups, [{ name: "NOVA", domains: ["a.example.test"] }]);
});

test("hostsList: a group of the wrong shape makes the file unreadable instead of being dropped", { skip: !swiftAvailable }, () => {
  // Dropped quietly, the group would be lost for good at the next save.
  const bad = [
    { domains: ["a.example.test"], groups: {} },
    { domains: ["a.example.test"], groups: [{ name: "Web", domains: ["a.example.test"] }, "oops"] },
    { domains: ["a.example.test"], groups: [{ name: "Web", domains: ["a.example.test", 7] }] },
    { domains: ["a.example.test"], groups: [{ name: 7, domains: [] }] },
  ];
  assert.deepEqual(hostsRun(bad.map((json) => ({ op: "list", json }))), [null, null, null, null]);
});

test("hostsGroupName: 1 to 40 characters on one line", { skip: !swiftAvailable }, () => {
  assert.deepEqual(hostsRun(["  Cortex  ", "", "   ", "a\nb", "x".repeat(41), "x".repeat(40)].map((raw) => ({ op: "groupName", raw }))),
    ["Cortex", null, null, null, null, "x".repeat(40)]);
});

test("managedHosts: a block under the markers from before the rename is still the managed block", { skip: !swiftAvailable }, () => {
  const old = `${SAMPLE_HOSTS}${LEGACY_START}\n127.0.0.1\tcdn.example.test\n${LEGACY_END}\n`;
  assert.deepEqual(hostsOne({ op: "managed", text: old }), ["cdn.example.test"]);
  const both = `${old}${BLOCK_START}\n127.0.0.1\tapi.example.test\n${BLOCK_END}\n`;
  assert.equal(hostsOne({ op: "managed", text: both }), null, "a block under each kind of marker is a damaged file");
  assert.equal(hostsOne({ op: "add", text: both, names: ["cdn2.example.test"] }), null, "and a damaged file is never written");
});

test("hostsAdded: the next write puts an old block back in place under the current markers", { skip: !swiftAvailable }, () => {
  const head = `${SAMPLE_HOSTS}# before\n`, tail = "# after\n";
  const old = `${head}${LEGACY_START}\n127.0.0.1\tcdn.example.test\n${LEGACY_END}\n${tail}`;
  assert.equal(hostsOne({ op: "add", text: old, names: ["cdn2.example.test"] }),
    `${head}${BLOCK_START}\n127.0.0.1\tcdn.example.test\n#127.0.0.1\tcdn2.example.test\n${BLOCK_END}\n${tail}`);
  assert.equal(hostsOne({ op: "remove", text: old, names: ["cdn.example.test"] }), `${head}${tail}`, "the last line out removes the old block as well");
});

test("hostsApply: switching names changes only those domains; the rest keep their state", { skip: !swiftAvailable }, () => {
  const local = apply({ setMode: "local", names: ["nova.example.test", "cortex.example.test"] }, ["shop.example.test"]);
  assert.deepEqual(local.local, ["nova.example.test", "cortex.example.test", "shop.example.test"], "in list order");
  const prod = apply({ setMode: "prod", names: ["nova.example.test", "shop.example.test"] }, local.local);
  assert.deepEqual(prod.local, ["cortex.example.test"]);
  assert.deepEqual(apply({ setMode: "local", names: ["unknown.example.test"] }).local, [], "only listed domains can be switched");
});

test("hostsApply: a domain in two groups has one state", { skip: !swiftAvailable }, () => {
  // Switching the NOVA group to prod turns shared.example.test off for Shop too: the file has one line for it.
  const r = apply({ setMode: "prod", names: LIST.groups[0].domains }, ["shared.example.test", "shop.example.test"]);
  assert.deepEqual(r.local, ["shop.example.test"]);
});

test("hostsApply: add puts a new domain in prod, in the selected group, and refuses non-domains", { skip: !swiftAvailable }, () => {
  const r = apply({ add: "New.Example.Test", group: "nova" }, ["nova.example.test"]);
  assert.deepEqual(r.list.domains.at(-1), "new.example.test");
  assert.deepEqual(r.list.groups[0].domains.at(-1), "new.example.test");
  assert.deepEqual(r.local, ["nova.example.test"], "a new domain starts in prod");
  assert.equal(r.error, null);
  const bad = apply({ add: "not a domain" });
  assert.match(bad.error, /not a domain name/);
  assert.deepEqual(bad.list, LIST);
});

test("hostsApply: remove deletes a domain everywhere, including from the block", { skip: !swiftAvailable }, () => {
  const r = apply({ remove: "shared.example.test" }, ["shared.example.test", "nova.example.test"]);
  assert.ok(!r.list.domains.includes("shared.example.test"));
  assert.ok(r.list.groups.every((g) => !g.domains.includes("shared.example.test")));
  assert.deepEqual(r.local, ["nova.example.test"]);
});

test("hostsApply: groups are created, renamed and deleted; deleting one keeps its domains", { skip: !swiftAvailable }, () => {
  const added = apply({ groupAdd: "Template" });
  assert.deepEqual(added.list.groups.map((g) => g.name), ["NOVA", "Shop", "Template"]);
  assert.match(apply({ groupAdd: "nova" }).error, /already a group/);
  const renamed = apply({ groupRename: { from: "shop", to: "Store" } });
  assert.deepEqual(renamed.list.groups.map((g) => g.name), ["NOVA", "Store"]);
  assert.match(apply({ groupRename: { from: "Shop", to: "NOVA" } }).error, /already a group/);
  const deleted = apply({ groupDelete: "NOVA" }, ["nova.example.test"]);
  assert.deepEqual(deleted.list.groups.map((g) => g.name), ["Shop"]);
  assert.deepEqual(deleted.list.domains, LIST.domains);
  assert.deepEqual(deleted.local, ["nova.example.test"], "deleting a group switches nothing");
});

test("hostsApply: a domain joins and leaves groups without changing its state", { skip: !swiftAvailable }, () => {
  const joined = apply({ member: { domain: "nova.example.test", group: "Shop", on: true } }, ["nova.example.test"]);
  assert.deepEqual(joined.list.groups[1].domains, ["shop.example.test", "shared.example.test", "nova.example.test"]);
  const left = apply({ member: { domain: "shared.example.test", group: "NOVA", on: false } }, ["shared.example.test"]);
  assert.deepEqual(left.list.groups[0].domains, ["nova.example.test", "cortex.example.test"]);
  assert.deepEqual(joined.local, ["nova.example.test"]);
  assert.deepEqual(left.local, ["shared.example.test"]);
  const fromMenu = apply({ groupAdd: "Template", domain: "shop.example.test" });
  assert.deepEqual(fromMenu.list.groups[2], { name: "Template", domains: ["shop.example.test"] });
  const intoExisting = apply({ groupAdd: "nova", domain: "shop.example.test" });
  assert.equal(intoExisting.error, null, "New group… with an existing name just adds the domain to it");
  assert.ok(intoExisting.list.groups[0].domains.includes("shop.example.test"));
});

function withHostsFile(content, mode, fn) {
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-hostsfile-"));
  const path = join(dir, "hosts"), backupDir = join(dir, "state");
  try {
    writeFileSync(path, content);
    chmodSync(path, mode);
    fn({ path, backupDir, read: () => readFileSync(path, "utf8") });
  } finally {
    chmodSync(path, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeHostsFile: writes in place, keeps owner and mode, and backs the file up first", { skip: !swiftAvailable }, () => {
  withHostsFile(SAMPLE_HOSTS, 0o664, ({ path, backupDir, read }) => {
    const before = statSync(path);
    const off = SAMPLE_HOSTS.replace("127.0.0.1 app.example.test api.example.test\n", "127.0.0.1 api.example.test\n#127.0.0.1\tapp.example.test\n");
    assert.equal(hostsOne({ op: "write", path, backupDir, toProd: ["app.example.test"] }), null);
    assert.equal(read(), off);
    const after = statSync(path);
    // In place: the same file, not a new one renamed over it (/etc is not writable by the user).
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o664);
    assert.equal(after.uid, before.uid);
    assert.equal(readFileSync(join(backupDir, "hosts.bak"), "utf8"), SAMPLE_HOSTS);
    assert.equal(readFileSync(join(backupDir, "hosts.before-sprint-board"), "utf8"), SAMPLE_HOSTS);

    assert.equal(hostsOne({ op: "write", path, backupDir, toLocal: ["old.example.test"] }), null);
    assert.equal(read(), off.replace("#127.0.0.1 old.example.test", "127.0.0.1 old.example.test"));
    assert.equal(readFileSync(join(backupDir, "hosts.bak"), "utf8"), off);
    assert.equal(readFileSync(join(backupDir, "hosts.before-sprint-board"), "utf8"), SAMPLE_HOSTS,
      "the copy taken before the first change is never overwritten");
  });
});

test("writeHostsFile: nothing to change means no write and no backup", { skip: !swiftAvailable }, () => {
  withHostsFile(SAMPLE_HOSTS, 0o644, ({ path, backupDir, read }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir }), null);
    assert.equal(read(), SAMPLE_HOSTS);
    assert.throws(() => statSync(join(backupDir, "hosts.bak")));
  });
});

test("writeHostsFile: a file the user cannot write is reported and left alone", { skip: !swiftAvailable || process.getuid?.() === 0 }, () => {
  withHostsFile(SAMPLE_HOSTS, 0o444, ({ path, backupDir, read }) => {
    assert.match(hostsOne({ op: "write", path, backupDir, toProd: ["app.example.test"] }), /not writable/);
    assert.equal(read(), SAMPLE_HOSTS);
  });
});

test("writeHostsFile: a broken block is reported and the file left alone", { skip: !swiftAvailable }, () => {
  const broken = `${SAMPLE_HOSTS}${BLOCK_START}\n127.0.0.1\tcdn.example.test\n`;
  withHostsFile(broken, 0o644, ({ path, backupDir, read }) => {
    assert.match(hostsOne({ op: "write", path, backupDir, added: ["new.example.test"] }), /damaged/);
    assert.equal(read(), broken);
  });
});

test("writeHostsFile: a byte-order mark at the start of the file survives a switch and its way back", { skip: !swiftAvailable }, () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("127.0.0.1 app.example.test\n")]);
  withHostsFile(bytes, 0o644, ({ path, backupDir }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, toProd: ["app.example.test"] }), null);
    assert.deepEqual(readFileSync(path).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.equal(hostsOne({ op: "write", path, backupDir, toLocal: ["app.example.test"] }), null);
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(readFileSync(join(backupDir, "hosts.before-sprint-board")), bytes, "backups keep the exact bytes");
  });
});

test("writeHostsFile: a file that is not UTF-8 is refused, never read as empty", { skip: !swiftAvailable }, () => {
  const bytes = Buffer.from("# caf\xe9\n127.0.0.1 localhost\n", "latin1");
  withHostsFile(bytes, 0o644, ({ path, backupDir }) => {
    assert.match(hostsOne({ op: "write", path, backupDir, added: ["cdn.example.test"] }), /Could not read/);
    assert.deepEqual(readFileSync(path), bytes);
  });
});

test("chromeRefreshScript: flushes in an open web tab of every window, active tab first, opens nothing, never starts Chrome", { skip: !swiftAvailable }, () => {
  const script = hostsOne({ op: "chromeScript" });
  for (const part of ["chrome.benchmarking.clearHostResolverCache()", "chrome.benchmarking.closeConnections()",
    "repeat with w in (every window)", "set candidates to {activeTab}", `starts with "http"`,
    `if application id "com.google.Chrome" is not running then return`, "with timeout of", "9101", "-1728"]) {
    assert.ok(script.includes(part), `missing: ${part}`);
  }
  assert.ok(!/make new (tab|window)/.test(script), "no tab or window is opened");
});

const chromeInstalled = existsSync("/Applications/Google Chrome.app");
test("chromeRefreshScript: is valid AppleScript", { skip: !swiftAvailable || !chromeInstalled }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-chrome-"));
  try {
    writeFileSync(join(dir, "refresh.applescript"), hostsOne({ op: "chromeScript" }));
    execFileSync("osacompile", ["-o", join(dir, "refresh.scpt"), join(dir, "refresh.applescript")], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chromeRefreshNote: what the Hosts tab says after a Chrome refresh", { skip: !swiftAvailable }, () => {
  const off = "Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events. For more information: https://support.google.com/chrome/?p=applescript";
  const notes = hostsRun([
    { op: "chromeNote", status: 0, stderr: "" },
    { op: "chromeNote", status: 1, stderr: `214:1180: execution error: ${off} (12)\n` },
    { op: "chromeNote", status: 1, stderr: `1:2: execution error: Google Chrome got an error: ${off} (12)\n` },
    { op: "chromeNote", status: 1, stderr: "1:2: execution error: Not authorized to send Apple events to Google Chrome. (-1743)\n" },
    { op: "chromeNote", status: 1, stderr: "1:2: execution error: Google Chrome got an error: Application isn’t running. (-600)\n" },
    { op: "chromeNote", status: 1, stderr: "1:2: execution error: Google Chrome got an error: Connection is invalid. (-609)\n" },
    { op: "chromeNote", status: 15, stderr: "", timedOut: true },
    { op: "chromeNote", status: 1, stderr: "1:2: execution error: Chrome answered missing value (9102)\n" },
    { op: "chromeNote", status: 1, stderr: "" },
    { op: "chromeNote", status: 1, stderr: "1:2: execution error: Chrome was not started with --enable-net-benchmarking (9101)\n" },
  ]);
  assert.equal(notes[0], null, "success says nothing");
  assert.match(notes[1], /Allow JavaScript from Apple Events/);
  assert.match(notes[2], /Allow JavaScript from Apple Events/, "Chrome's own error prefix too");
  assert.match(notes[3], /Privacy & Security › Automation/);
  assert.equal(notes[4], null, "Chrome quit meanwhile: nothing to refresh");
  assert.equal(notes[5], null, "Chrome quit meanwhile: nothing to refresh");
  assert.match(notes[6], /did not answer/);
  assert.match(notes[7], /Chrome answered missing value/, "an unknown failure keeps its own text");
  assert.ok(notes[8], "a failure without output is still reported");
  assert.match(notes[9], /open it with the Chrome button/);
});

test("chromeMissingFlags: which insecure-Chrome flags a running Chrome lacks", { skip: !swiftAvailable }, () => {
  const bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const flags = hostsOne({ op: "insecureFlags" });
  assert.deepEqual(flags, ["--ignore-certificate-errors", "--allow-insecure-localhost", "--enable-net-benchmarking"]);
  const missing = hostsRun([
    { op: "missingFlags", commandLine: `${bin} ${flags.join(" ")}` },
    { op: "missingFlags", commandLine: `${bin} --enable-net-benchmarking --ignore-certificate-errors --lang=tr --allow-insecure-localhost` },
    { op: "missingFlags", commandLine: bin },
    { op: "missingFlags", commandLine: `${bin} --ignore-certificate-errors --allow-insecure-localhost` },
    { op: "missingFlags", commandLine: `${bin} --enable-net-benchmarking-x --ignore-certificate-errors-spki-list=abc` },
  ]);
  assert.deepEqual(missing[0], [], "all present");
  assert.deepEqual(missing[1], [], "order and extra flags do not matter");
  assert.deepEqual(missing[2], flags, "a plain Chrome lacks them all");
  assert.deepEqual(missing[3], ["--enable-net-benchmarking"]);
  assert.deepEqual(missing[4], flags, "a longer flag is not the flag");
});

// A partner's domains under the tests' invented suffixes.
const partnerDomains = (p) => PARTNER_SUFFIXES.map((suffix) => `${p}.${suffix}`);

test("hostsPartnerName: a panel name, or the first label of a pasted partner domain", { skip: !swiftAvailable }, () => {
  const ok = {
    " DemoPartner ": "demopartner", "demo-partner2": "demo-partner2", "demopartner.panel.example.test": "demopartner",
    "https://demopartner.panel.example.test/": "demopartner", ["x".repeat(60)]: "x".repeat(60),
  };
  const bad = ["", "-demo", "demo-", "demo partner", "demo_partner", "ünicode", "x".repeat(61)];
  assert.deepEqual(hostsRun(Object.keys(ok).map((raw) => ({ op: "partnerName", raw }))), Object.values(ok));
  assert.deepEqual(hostsRun(bad.map((raw) => ({ op: "partnerName", raw }))), bad.map(() => null));
});

test("hostsApply: addPartner adds the three partner domains in prod, in the Partners group", { skip: !swiftAvailable }, () => {
  const r = apply({ addPartner: "DemoPartner" }, ["nova.example.test"]);
  assert.deepEqual(r.list.domains.slice(-3), partnerDomains("demopartner"));
  assert.deepEqual(r.list.groups.at(-1), { name: "Partners", domains: partnerDomains("demopartner") });
  assert.deepEqual(apply({ addPartner: "acme" }, [], r.list).list.groups.at(-1).domains,
    [...partnerDomains("demopartner"), ...partnerDomains("acme")], "every partner goes into the one group");
  assert.deepEqual(r.local, ["nova.example.test"], "new domains start in prod");
  assert.equal(r.error, null);
});

test("hostsApply: a partner domain joins Partners when a broader suffix comes first", { skip: !swiftAvailable }, () => {
  const r = apply({ addPartner: "acme" }, [], LIST, ["example.test", "panel.example.test"]);
  assert.equal(r.error, null);
  assert.deepEqual(r.list.groups.at(-1), { name: "Partners", domains: ["acme.example.test", "acme.panel.example.test"] });
  const other = apply({ add: "shop.acme.other.test" }, [], LIST, ["example.test", "panel.example.test"]);
  assert.ok(!other.list.groups.some((g) => g.name === "Partners"), "no suffix fits, so no Partners group");
  const deep = apply({ add: "a.b.example.test" }, [], LIST, ["example.test", "panel.example.test"]);
  assert.ok(!deep.list.groups.some((g) => g.name === "Partners"), "the partner is one label");
});

test("hostsApply: addPartner also joins the selected group and reuses an existing Partners group", { skip: !swiftAvailable }, () => {
  const list = { domains: [], groups: [{ name: "Picked", domains: [] }, { name: "PARTNERS", domains: [] }] };
  const r = apply({ addPartner: "demopartner", group: "picked" }, [], list);
  assert.deepEqual(r.list.groups, [
    { name: "Picked", domains: partnerDomains("demopartner") },
    { name: "PARTNERS", domains: partnerDomains("demopartner") },
  ], "no group of the partner's own name is made");
  assert.match(apply({ addPartner: "demo partner" }).error, /not a partner name/);
});

test("hostsApply: a partner domain added on its own joins the Partners group, made when missing", { skip: !swiftAvailable }, () => {
  const [panel, api] = partnerDomains("demopartner");
  let r = apply({ add: `https://${panel.toUpperCase()}/x` });
  assert.deepEqual(r.list.groups.at(-1), { name: "Partners", domains: [panel] });
  r = apply({ add: api, group: "Shop" }, [], r.list);
  assert.deepEqual(r.list.groups.find((g) => g.name === "Partners").domains, [panel, api], "the Partners group is reused");
  assert.ok(r.list.groups.find((g) => g.name === "Shop").domains.includes(api), "and the selected group is joined too");
  const list = { domains: [], groups: [{ name: "partners", domains: [] }] };
  assert.deepEqual(apply({ add: panel }, [], list).list.groups, [{ name: "partners", domains: [panel] }],
    "the group is found without regard to case");
  const [long] = partnerDomains("x".repeat(60)), [tooLong] = partnerDomains("x".repeat(61));
  assert.deepEqual(apply({ add: long }).list.groups.at(-1), { name: "Partners", domains: [long] }, "a 60-character partner joins");
  r = apply({ add: tooLong });
  assert.ok(r.list.domains.includes(tooLong) && !r.list.groups.some((g) => g.name === "Partners"),
    "a 61-character one is listed but is not a partner");
});

test("hostsApply: only <partner>.<suffix> is a partner domain", { skip: !swiftAvailable }, () => {
  let r = apply({ add: "a.b.panel.example.test" });
  r = apply({ add: "panel.example.test" }, [], r.list);
  r = apply({ add: "plain.example.test" }, [], r.list);
  assert.deepEqual(r.list.groups.map((g) => g.name), ["NOVA", "Shop"]);
  for (const name of partnerDomains("acme").slice(0, 2)) r = apply({ add: name }, [], r.list);
  assert.deepEqual(r.list.groups.at(-1), { name: "Partners", domains: partnerDomains("acme").slice(0, 2) });
});

test("partnerDomainSuffixes: the config's list as domain names, repeats and non-domains dropped; none without it", { skip: !swiftAvailable }, () => {
  const [listed, missing, wrong] = hostsRun([
    { op: "partnerSuffixes", config: { partnerDomainSuffixes: ["Panel.Example.TEST", "api.example.test", "panel.example.test", "bad name", "single"] } },
    { op: "partnerSuffixes", config: {} },
    { op: "partnerSuffixes", config: { partnerDomainSuffixes: "panel.example.test" } },
  ]);
  assert.deepEqual(listed, ["panel.example.test", "api.example.test"]);
  assert.deepEqual(missing, []);
  assert.deepEqual(wrong, [], "a string is not a list");
});

test("hostsApply: without partner suffixes no partner is added and no domain joins Partners", { skip: !swiftAvailable }, () => {
  const r = apply({ addPartner: "demopartner" }, [], LIST, []);
  assert.match(r.error, /partnerDomainSuffixes in the config/);
  assert.deepEqual(r.list, LIST);
  const [panel] = partnerDomains("demopartner");
  assert.ok(!apply({ add: panel }, [], LIST, []).list.groups.some((g) => g.name === "Partners"));
});

test("Hosts tab: the partner suffixes come from the config with every state; the page offers Add partner only with some", () => {
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(swift, "replyHosts"), /state\["partnerSuffixes"\] = hostsPartnerSuffixes\(\)/);
  assert.match(methodSource(swift, "hostsMessage"), /hostsApply\(before, local: wasLocal, body, partners: self\.hostsPartnerSuffixes\(\)\)/);
  assert.match(methodSource(swift, "hostsPartnerSuffixes"), /CONFIG_PATH[\s\S]*partnerDomainSuffixes\(config\)/);
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  assert.match(page, /\$\{canAddPartner \? `<button data-open="partner">\+ Add partner<\/button>` : ""\}/);
  const start = page.indexOf("  const partnerSuffixes = ");
  const end = page.indexOf("\n  };", page.indexOf("  const partnerLabels = ", start));
  assert.ok(start > 0 && end > start);
  const labels = (state) => new Function("last", `${page.slice(start, end + 5)}\nreturn partnerLabels();`)(state);
  assert.equal(labels({ partnerSuffixes: PARTNER_SUFFIXES }), ".panel, .api and .ops");
  assert.equal(labels({ partnerSuffixes: ["panel.example.test"] }), ".panel");
  assert.equal(labels({}), "");
  assert.equal(labels(null), "");
  assert.deepEqual(JSON.parse(readFileSync(new URL("./config.example.json", import.meta.url), "utf8")).partnerDomainSuffixes, [],
    "off by default: the example is copied into every new config");
});

test("hostsApply: deleting a group with its domains removes them everywhere, including the block", { skip: !swiftAvailable }, () => {
  const added = apply({ addPartner: "demopartner", group: "Shop" }, ["nova.example.test"]);
  const local = apply({ setMode: "local", names: partnerDomains("demopartner") }, added.local, added.list);
  const r = apply({ groupDeleteWithDomains: "partners" }, local.local, local.list);
  assert.deepEqual(r.list.domains, LIST.domains);
  assert.deepEqual(r.list.groups, LIST.groups, "gone from the other group too, and the Partners group is deleted");
  assert.deepEqual(r.local, ["nova.example.test"]);
});

test("menu bar icon: the exclamation mark lights only for a late review or a PR that cannot merge", { skip: !swiftAvailable }, () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-icon-"));
  try {
    writeFileSync(join(dir, "main.swift"), `import Foundation
${swiftDecl(src, "struct MenuIconState")}
${swiftSource(src, "menuIconState")}
let steps = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
var state = MenuIconState()
let out: [[String: Any]] = steps.map { step in
    state = menuIconState(step["obj"] as? [String: Any], ok: step["ok"] as! Bool, previous: state)
    return ["progress": state.progress.map { $0 as Any } ?? NSNull(), "needsYou": state.needsYou, "stale": state.stale]
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`);
    execFileSync("swiftc", [join(dir, "main.swift"), "-o", join(dir, "icon")], { stdio: "pipe" });
    const run = (steps) => JSON.parse(execFileSync(join(dir, "icon"), { input: JSON.stringify(steps) }));
    const base = { ok: true, done: 5, total: 8, reviewRequests: [], pullRequests: [] };
    const one = (obj) => run([{ ok: true, obj }])[0];
    assert.deepEqual(one(base), { progress: 0.625, needsYou: false, stale: false });
    // A fresh review request or a PR GitHub is still checking is no alert.
    assert.equal(one({ ...base, reviewRequests: [{ days: 1 }], pullRequests: [{ kind: "checking" }] }).needsYou, false);
    assert.equal(one({ ...base, reviewRequests: [{ days: 2 }] }).needsYou, true);
    assert.equal(one({ ...base, pullRequests: [{ kind: "conflict" }] }).needsYou, true);
    assert.equal(one({ ...base, pullRequests: [{ kind: "ci" }] }).needsYou, true);
    // An overdue task stays in the popover; the icon would otherwise never leave the alert.
    assert.equal(one({ ...base, overdue: { key: "DEMO-1" } }).needsYou, false);
    assert.equal(one({ ...base, total: 0, done: 0 }).progress, 0);
    // A failed refresh keeps the last state, faded; before any data it is the loading dots.
    const [first, failed] = run([{ ok: true, obj: { ...base, pullRequests: [{ kind: "ci" }] } }, { ok: false }]);
    assert.deepEqual(failed, { ...first, stale: true });
    assert.deepEqual(run([{ ok: false }])[0], { progress: null, needsYou: false, stale: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("menu bar icon: it is redrawn from every fetch result", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(src, /self\.menuIcon = menuIconState\(obj, ok: ok, previous: self\.menuIcon\)\n\s*self\.statusItem\.button\?\.image = ringIcon\(18, self\.menuIcon\)/);
  assert.match(swiftSource(src, "ringIcon"), /img\.isTemplate = true/);
});

test("menu bar icon: signing out resets it, so it never shows the account that left", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(src, "clearBoardData"), /menuIcon = MenuIconState\(\)\n\s*statusItem\.button\?\.image = ringIcon\(18, menuIcon\)/);
});

test("refresh: saved settings reach the board without waiting for the timer", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const save = methodSource(src, "saveSettings");
  const wrote = save.indexOf("(try? data.write(to: URL(fileURLWithPath: CONFIG_PATH))) != nil");
  const asked = save.indexOf("settingsChanged = true");
  assert.ok(wrote >= 0 && asked > wrote, "only a save that reached the file asks for a refresh");
  assert.ok(save.indexOf("reload()", asked) > asked);
  assert.ok(save.indexOf("reload()") < save.lastIndexOf("settingsResult("), "the page hears the result after the refresh starts");
  const reload = methodSource(src, "reload");
  // A fetch reads the config when it starts, so only a fetch that starts after the save counts.
  assert.ok(reload.indexOf("settingsChanged = false") > reload.indexOf("guard !fetchInFlight else { return }"));
  assert.ok(reload.indexOf("settingsChanged = false") < reload.indexOf("DispatchQueue.global"));
  // A save during a fetch: that fetch read the old config, so another runs when it ends.
  assert.match(reload, /self\.fetchInFlight = false\n\s*if generation != self\.boardGeneration \|\| self\.settingsChanged \{ self\.reload\(\) \}/);
});

test("refresh: a fetch that ran while the account left is dropped, and the account now signed in gets its own", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(src, "clearBoardData"), /boardGeneration \+= 1/);
  const reload = methodSource(src, "reload");
  assert.match(reload, /fetchInFlight = true\n\s*let generation = boardGeneration/);
  // Every result carries the generation its fetch started in.
  assert.equal((reload.match(/self\.push\(/g) || []).length, 3);
  assert.equal((reload.match(/for: generation\)/g) || []).length, 3);
  assert.match(reload, /self\.fetchInFlight = false\n\s*if generation != self\.boardGeneration \|\| self\.settingsChanged \{ self\.reload\(\) \}/);
  // Such a result reaches no board and not the icon.
  const push = methodSource(src, "push");
  assert.match(push, /if generation != self\.boardGeneration \{ return \}/);
  assert.ok(push.indexOf("generation != self.boardGeneration") < push.indexOf("self.lastJSON = json"));
});

test("settings: while the user browses Settings the widget keeps refreshing; a setup screen stops it", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(src, /var setupBlocksFetch: Bool \{ onSetupScreen \}/);
  // Settings is a page over the tabs, not a setup screen, so refreshes go on.
  assert.doesNotMatch(methodSource(src, "showWidgetSettings"), /onSetupScreen = true/);
  assert.match(src, /func menuSetup\(\) \{\n\s*manualRefreshPending = false\n\s*setupFromSettings = false\n\s*onSetupScreen = true/);
  assert.match(src, /self\.setupFromSettings = canGoBack\n/);
  // The refresh and its result ask the same question.
  assert.match(src, /if setupBlocksFetch \{ manualRefreshPending = false; return \}/);
  assert.match(src, /if self\.setupBlocksFetch \{ return \}/);
  assert.doesNotMatch(src, /if self\.onSetupScreen \{ return \}/);
});

// A method of the App class: indented one level, @objc or not.
function methodSource(src, name) {
  const at = src.search(new RegExp(`\\n    (?:@objc )?func ${name}\\(`));
  const end = src.indexOf("\n    }\n", at);
  assert.ok(at >= 0 && end > at, `${name} not found in SprintBoard.swift`);
  return src.slice(at + 1, end + 7);
}

test("settings in the widget: the gears and Settings… open the Settings page over the tabs", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  // The Settings page, on the board's handler, over the tabs.
  assert.match(src, /widgetSettingsWeb = makeTabWebView\(handler: "sb"\)/);
  assert.match(src, /if body\["settings"\] != nil \{ menuSettings\(\) \}/);
  assert.match(src, /NSMenuItem\(title: "Settings…", action: #selector\(menuSettings\)/);
  assert.match(methodSource(src, "menuSettings"), /\} else if needsSetup\(\) \{\n\s*menuSetup\(\)\n\s*\} else \{\n\s*showWidgetSettings\(\)/);
  // Shown over the tabs; the back arrow returns to the tab that was open.
  const show = methodSource(src, "showWidgetSettings");
  // Loaded once, with the tabs; each opening fills it first and shows it after, at its new height.
  assert.equal((src.match(/loadPage\("popover\/settings\.html", in: widgetSettingsWeb\)/g) || []).length, 1);
  assert.match(methodSource(src, "setUpWidgetTabs"), /loadPage\("popover\/settings\.html", in: widgetSettingsWeb\)/);
  assert.match(show, /fillWidgetSettings \{ \[weak self\] height in[\s\S]*?self\.widgetPageHeights\[self\.widgetSettingsWeb\] = height[\s\S]*?self\.swapWidgetPage\(\)/);
  assert.match(methodSource(src, "fillWidgetSettings"), /window\.sbSettingsShow \? window\.sbSettingsShow\(\.\.\.\\\(args\)\) : null/);
  assert.match(methodSource(src, "layoutWidget"), /widgetTabControl\.isHidden = target === widgetSettingsWeb/);
  assert.match(methodSource(src, "hideWidgetSettings"), /widgetSettingsShown = false\n\s*swapWidgetPage/);
  assert.match(src, /widgetPages\.contains\(w\), let posted = body\["height"\]/);
  // The board's message never sends anyone elsewhere.
  assert.doesNotMatch(src, /Action needed in the Sprint Board window/);
});

test("settings in the widget: it signs in, saves and disconnects like the setup screen; the board page cannot", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(src, /let fromSetupPage = fromWidget \|\| fromSettingsPage/);
  assert.match(src, /if body\["atlassianLogin"\] != nil, fromSetupPage \{\n\s*setupResultTarget = msg\.webView/);
  assert.match(src, /if fromSetupPage, let t = body\["tokenLogin"\][\s\S]{0,200}?setupResultTarget = msg\.webView/);
  assert.match(src, /let setupOpen = \(fromWidget && onSetupScreen\) \|\| fromSettingsPage/);
  assert.match(src, /if let s = body\["saveSettings"\] as\? \[String: Any\], setupOpen, let page = msg\.webView \{ saveSettings\(s, reply: page\) \}/);
  assert.match(src, /if body\["disconnect"\] != nil, setupOpen \{ disconnect\(\) \}/);
  // Results go back to the page that asked.
  assert.match(methodSource(src, "setupFailed"), /\(self\.setupResultTarget \?\? self\.web\)\.evaluateJavaScript/);
  assert.match(methodSource(src, "settingsResult"), /page\.evaluateJavaScript/);
  // Back: the setup screen goes to the board and retries; the Settings page returns to its tab.
  assert.match(src, /if body\["backToBoard"\] != nil, fromWidget, onSetupScreen \{ showBoard\(\) \}/);
  assert.match(src, /if body\["backToBoard"\] != nil, fromSettingsPage \{ hideWidgetSettings\(\) \}/);
  // A finished sign-in or Back to board closes the Settings page too; Disconnect shows the sign-in screen.
  assert.match(methodSource(src, "showBoard"), /widgetSettingsShown = false/);
  assert.match(methodSource(src, "disconnect"), /widgetSettingsShown = false[\s\S]*?loadPage\("setup\.html"\)/);
});

test("settings in the widget: the page stays loaded, so each opening first clears what the last one left", () => {
  const page = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  const start = page.indexOf("  window.sbSettingsShow = (ctx, errors) => {");
  const end = page.indexOf("\n  };", start);
  assert.ok(start > 0 && end > start);
  const show = page.slice(start, end);
  for (const reset of ['clearTimeout(disarm);', '$("disconnect").classList.remove("armed");', "resetSignInButtons();",
    '$("tokenForm").hidden = true;', '$("useToken").hidden = false;', '[$("host"), $("email"), $("token")].forEach((el) => { el.value = ""; });',
    '$("saved").textContent = "";', '$("err").hidden = true;', '$("signin").hidden = false;']) {
    assert.ok(show.includes(reset), reset);
  }
  // Cleared before it is filled; the height is answered last.
  assert.ok(show.indexOf('$("signin").hidden = false;') < show.indexOf("window.sbSetupContext(ctx);"));
  assert.match(show, /if \(errors\.length\) window\.sbSetupResult\(\{ errors \}\);\n\s*return \$\("card"\)\.offsetHeight;$/);
});

test("settings in the widget: a needed sign-in leaves Settings for the setup screen, and a closed widget stays closed", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const login = methodSource(src, "requireLogin");
  assert.match(login, /self\.widgetSettingsShown = false/);
  assert.match(login, /let widgetClosed = !self\.window\.isVisible && !self\.window\.isMiniaturized\n\s*if widgetClosed \{/);
  assert.ok(login.indexOf("widgetClosed {") < login.indexOf("self.lendWidgetToSetup()"), "the closed path comes before the widget is lent");
  // The page shows the account when the config holds one.
  assert.match(methodSource(src, "fillWidgetSettings"), /let raw = [\s\S]*?let signedIn = setupContext\(cfg\)/);
  // Opened before its first load finished: filled when it finishes.
  assert.match(src, /if w === widgetSettingsWeb, widgetSettingsShown \{ fillWidgetSettings\(\) \}/);
});

test("panel pages: the gear and the back arrow never come back hovered after their page swaps", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const view = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const setup = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  // Every panel page starts with hover off and turns it on at the first real mouse move only.
  const script = src.match(/let PANEL_PAGE_SCRIPT = """\n([\s\S]*?)\n"""/)[1];
  assert.match(script, /classList\.add\('nohover'\)/);
  assert.match(script, /if \(e\.movementX \|\| e\.movementY\) document\.documentElement\.classList\.remove\('nohover'\)/);
  assert.match(src, /source: PANEL_PAGE_SCRIPT, injectionTime: \.atDocumentStart/);
  // One way to change the page: the page being left turns hover off and paints that, then the
  // two pages trade places in one step (no overlap); a stuck frame cannot block the swap.
  const swap = methodSource(src, "swapWidgetPage");
  assert.match(swap, /leaving\.callAsyncJavaScript\("\\\(hoverOff\); await new Promise\(\(done\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(done\)\)\)"/);
  assert.match(methodSource(src, "layoutWidget"), /for page in widgetPages \{ page\.isHidden = page !== target \}/);
  assert.match(swap, /asyncAfter\(deadline: \.now\(\) \+ 0\.2\) \{ swap\(\) \}/);
  // Only a closed host (nothing on screen to paint) or the same page swaps at once.
  assert.match(swap, /guard leaving !== page, boardVisible else \{\n\s*leaving\.evaluateJavaScript\(hoverOff\)\n\s*swap\(\)/);
  assert.match(swap, /guard self\.widgetTargetPage === page else \{ return \}/);
  assert.match(methodSource(src, "widgetTabChanged"), /swapWidgetPage \{/);
  // Only the two buttons that swap pages wait for the move; no other hover is touched.
  assert.match(view, /\n  :where\(html:not\(\.nohover\)\) \.rf:hover \{ background: var\(--hover\); color: -apple-system-label; \}/);
  assert.match(setup, /:where\(html:not\(\.nohover\)\) \.back:hover \{/);
  assert.match(setup, /\.nohover \.back \{ transition: none; \}/);
  assert.equal((view.match(/nohover/g) || []).length, 2, "sprints.html: the gear only");
  assert.equal((setup.match(/nohover/g) || []).length, 3, "settings.html: the back arrow only");
});

test("panel tabs: every grey hover is one colour, white 12%, on every popover page", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const pages = { sprints: read("./popover/sprints.html"), hosts: read("./popover/hosts.html"), settings: read("./popover/settings.html") };
  for (const [name, page] of Object.entries(pages)) {
    assert.match(page, /--hover: rgba\(255,255,255,\.12\);/, name);
    // No hover writes a grey of its own; only Settings' filled buttons brighten their own fill.
    const own = [...page.matchAll(/^\s*([^{\n]*:hover[^{\n]*)\{[^}]*background: rgba\(255,255,255,/gm)].map((m) => m[1].trim());
    assert.deepEqual(own, name === "settings" ? ["button:hover"] : [], name);
  }
  // Rows, headers, cards and buttons all take it.
  assert.match(pages.sprints, /\.grow:hover \{ background: var\(--hover\); \}/);
  assert.match(pages.sprints, /\.row:hover, \.brow:hover, \.item:hover \{ background: var\(--hover\); \}/);
  assert.match(pages.sprints, /\.tile\.fold:hover, \.tile\.open \{ background: var\(--hover\); \}/);
  assert.match(pages.sprints, /\.fold:hover \{ background: var\(--hover\); \}/);
  assert.match(pages.hosts, /\.row:hover \{ background: var\(--hover\); \}/);
  assert.match(pages.hosts, /\.gi:hover \{ background: var\(--hover\); \}/);
  // An open Hosts row and its group menu read as one block.
  assert.match(pages.hosts, /\.row\.open \{ background: var\(--hover\);/);
  assert.match(pages.hosts, /\.gmenu \{[^}]*background: var\(--hover\); \}/);
  assert.match(pages.settings, /\.back:hover \{ color: -apple-system-label; background: var\(--hover\); \}/);
  assert.doesNotMatch(Object.values(pages).join(""), /--row-hover/);
});

test("Hosts tab: rows as tall as the switch, 4 px apart; a local one fades from yellow on the left, sliding in", () => {
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  assert.match(page, /\.row \{[^}]*height: 28px;/);
  assert.match(page, /\.sw \{[^}]*height: 24px;/, "the switch fits the row");
  assert.match(page, /\.row \+ \.row \{ margin-top: 4px; \}/);
  // The gradient is a layer under the row's content, so it can slide in from the left as the domain turns local.
  assert.match(page, /\.row \{[^}]*position: relative; isolation: isolate;/);
  const layer = page.match(/\.row::before \{([^}]*)\}/)[1].replace(/\s+/g, " ");
  for (const rule of ["position: absolute", "inset: 0", "z-index: -1", "border-radius: inherit",
    "background: linear-gradient(90deg, color-mix(in srgb, var(--y) 22%, transparent), transparent)",
    "opacity: 0", "transform: scaleX(.3)", "transform-origin: left", "transition: opacity .2s, transform .2s var(--ease)"]) {
    assert.ok(layer.includes(rule), rule);
  }
  assert.match(page, /\.row\.local::before \{ opacity: 1; transform: none; \}/);
  // Hover and an open row show their own fill in its place.
  assert.match(page, /\.row\.local:hover::before, \.row\.local\.open::before \{ opacity: 0; \}/);
  assert.doesNotMatch(page, /\.row\.local \{ background/);
  // The group pills as the team goal's: 11 px on white 10%.
  assert.match(page, /\.tag \{[^}]*font-size: 11px;[^}]*background: rgba\(255,255,255,\.1\);/);
});

test("Hosts tab: opening the tab only reads /etc/hosts; only a change writes it and refreshes Chrome", () => {
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const message = methodSource(swift, "hostsMessage");
  assert.match(message, /if body\["status"\] == nil, list == result\.list, !edit\.isEmpty \{/);
  // The Chrome refresh rides only on that write.
  assert.equal((message.match(/scheduleChromeRefresh\(\)/g) || []).length, 1);
  assert.ok(message.indexOf(`if body["status"] == nil,`) < message.indexOf("scheduleChromeRefresh()"));
  // Showing the tab asks for a status and nothing else.
  assert.match(methodSource(swift, "widgetTabChanged"), /self\.hostsMessage\(\["status": true\]\)/);
});

test("Hosts tab: nothing is redrawn and no key acts while a reply is on its way, so a comma-separated add counts only Swift's replies", () => {
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  const line = page.match(/^ *const redraw = .*$/m)[0];
  assert.match(line, /const redraw = \(\) => \{ if \(last && !busy\) draw\(last\); \};/);
  assert.match(page, /card\.addEventListener\("keydown", \(e\) => \{\n\s*if \(busy\) return;/);
  assert.match(page, /document\.addEventListener\("keydown", \(e\) => \{\n\s*if \(busy \|\| e\.key !== "Escape"\) return;/);
  // draw takes its state for the reply, so only redraw and Swift's reply (sbHosts) call it.
  const callers = page.split("\n").filter((l) => /(^|[^\w.])draw\(/.test(l)).map((l) => l.trim());
  assert.deepEqual(callers, ["function draw(s) {", line.trim(), "draw(s);"]);
});

test("Hosts tab: while an action waits, a state Swift sent on its own is not taken for its reply", () => {
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  assert.match(page, /post\(\{ \.\.\.message, requestId: \+\+requestId \}\);/);
  const handler = page.match(/^  window\.sbHosts = \(s\) => \{[\s\S]*?\n  \};$/m)[0];
  const received = (busy, s) => {
    const log = [], window = {};
    new Function("window", "busy", "requestId", "orderGroups", "draw", handler)(
      window, busy, 3, () => log.push("order"), () => log.push("draw"));
    window.sbHosts(s);
    return log;
  };
  assert.deepEqual(received(true, { groups: [] }), [], "the panel opened while an add waits");
  assert.deepEqual(received(true, { groups: [], requestId: 2 }), [], "an older action's reply");
  assert.deepEqual(received(true, { groups: [], requestId: 3 }), ["draw"]);
  assert.deepEqual(received(false, { groups: [] }), ["order", "draw"]);
  // Swift sends the id back on every reply to a Hosts message.
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(swift, "replyHosts"), /state\["requestId"\] = body\["requestId"\]/);
  const message = methodSource(swift, "hostsMessage");
  assert.equal((message.match(/replyHosts\(/g) || []).length, 5);
  assert.equal((message.match(/self\.replyHosts\(state, to: body\)/g) || []).length, 5);
});

test("Hosts tab: a gear opens Settings, and the back arrow returns to Hosts", () => {
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(swift, "userContentController"), /if msg\.name == "hosts" \{[^\n]*\n[^\n]*\n\s*if body\["settings"\] != nil \{ menuSettings\(\) \} else \{ hostsMessage\(body\) \}/);
  assert.match(methodSource(swift, "hideWidgetSettings"), /self\.widgetShownPage === self\.hostsWeb \{ self\.hostsMessage\(\["status": true\]\) \}/);
  assert.match(swift.match(/^let PAGE_SYMBOLS = \[([\s\S]*?)^\]/m)[1], /"gearshape"/);
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  // The last header button, as the gear is on the Sprint tab.
  assert.match(page, /<button class="icon" id="gearBtn" title="Settings" aria-label="Settings"><i class="sym s-gearshape"><\/i><\/button>\n\s*<\/span>/);
  assert.match(page, /else if \(at\("#gearBtn"\)\) post\(\{ settings: true \}\);/);
  // It swaps the page, so its hover waits for a real mouse move; the other buttons keep theirs.
  assert.match(page, /:where\(html:not\(\.nohover\)\) #gearBtn:hover \{/);
  assert.match(page, /\.icon:not\(#gearBtn\):hover, \.icon\.on \{/);
});

let widgetDriver;
function widgetRun(ops) {
  if (!widgetDriver) {
    const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
    const constant = (name) => {
      const m = src.match(new RegExp(`^let ${name}[^\\n]*(?:= \\[\\n[\\s\\S]*?^\\]|=[^\\n]*)$`, "m"));
      assert.ok(m, `${name} not found`);
      return m[0];
    };
    const driver = `import Foundation
${constant("PANEL_TABS")}
${constant("PANEL_HEADER_HEIGHT")}
${swiftSource(src, "widgetTabIndex")}
${swiftSource(src, "widgetPageName")}
${swiftSource(src, "widgetWindowHeight")}
${constant("PANEL_START_HEIGHT")}
${src.match(/^enum DisplayMode: String \{[\s\S]*?^\}$/m)[0]}
${swiftSource(src, "displayModeChoice")}
${swiftSource(src, "boardHeaderShown")}
${swiftSource(src, "panelContentHeight")}
let ops = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
let out: [Any] = ops.map { op in
    switch op["op"] as! String {
    case "tab": return widgetTabIndex(op["saved"] as! Int)
    case "page": return widgetPageName(onSetupScreen: op["setup"] as! Bool, settingsShown: op["settings"] as! Bool, tab: op["tab"] as! Int)
    case "mode": return displayModeChoice(op["stored"]).rawValue
    case "header": return boardHeaderShown(onSetupScreen: op["setup"] as! Bool, settingsShown: op["settings"] as! Bool, mode: DisplayMode(rawValue: op["mode"] as! String)!)
    case "panel": return Double(panelContentHeight(pageHeight: (op["page"] as? Double).map { CGFloat($0) }, header: CGFloat(op["header"] as! Double), screenHeight: CGFloat(op["screen"] as! Double)))
    default: return Double(widgetWindowHeight(pageHeight: CGFloat(op["height"] as! Double), onSetupScreen: op["setup"] as! Bool))
    }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;
    const dir = mkdtempSync(join(tmpdir(), "sprint-board-widget-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "main.swift"), driver);
    execFileSync("swiftc", [join(dir, "main.swift"), "-o", join(dir, "widget")], { stdio: "pipe" });
    widgetDriver = join(dir, "widget");
  }
  return JSON.parse(execFileSync(widgetDriver, { input: JSON.stringify(ops) }));
}

test("widget tabs: the page follows the tab; Settings goes over the tabs and the setup screen over all", { skip: !swiftAvailable }, () => {
  const page = (setup, settings, tab) => ({ op: "page", setup, settings, tab });
  assert.deepEqual(widgetRun([page(false, false, 0), page(false, false, 1), page(false, true, 0), page(false, true, 1), page(true, false, 1), page(true, true, 0)]),
    ["popover/sprints.html", "popover/hosts.html", "popover/settings.html", "popover/settings.html", "setup.html", "setup.html"]);
  // The tab bar drives the same answer, and the page the state names is the one on screen.
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(src, /action: #selector\(widgetTabChanged\)/);
  assert.match(src, /widgetPageName\(onSetupScreen: onSetupScreen, settingsShown: widgetSettingsShown,\n\s*tab: widgetTabControl\.selectedSegment\)/);
});

test("widget tabs: the selected tab is kept across launches, and a tab that does not exist gives Sprint", { skip: !swiftAvailable }, () => {
  assert.deepEqual(widgetRun([0, 1, 2, -1].map((saved) => ({ op: "tab", saved }))), [0, 1, 0, 0]);
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(src, "widgetTabChanged"), /UserDefaults\.standard\.set\(widgetTabControl\.selectedSegment, forKey: WIDGET_TAB_KEY\)/);
  assert.match(methodSource(src, "setUpWidgetTabs"), /integer\(forKey: WIDGET_TAB_KEY\)[\s\S]*?widgetTabControl\.selectedSegment = widgetTabIndex\(saved\)/);
});

test("widget height: the window follows the page on screen, and only the setup screen has no header", { skip: !swiftAvailable }, () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const header = Number(src.match(/^let PANEL_HEADER_HEIGHT: CGFloat = (\d+)$/m)[1]);
  assert.deepEqual(widgetRun([{ op: "height", height: 500, setup: false }, { op: "height", height: 500, setup: true }]), [500 + header, 500]);
  // Each page keeps its own height; a page behind another moves nothing, and a tab change fits again.
  const message = methodSource(src, "userContentController");
  assert.match(message, /widgetPageHeights\[w\] = CGFloat\(posted\)\n\s*if w === widgetShownPage \{ fitWidget\(/);
  assert.match(message, /let posted = body\["height"\] as\? Double, posted > 60 \{/);
  const fit = methodSource(src, "fitWidget");
  assert.match(fit, /let height = widgetPageHeights\[widgetShownPage\] else \{ return \}/);
  assert.match(fit, /f\.origin\.y = top - f\.height/);
  assert.match(methodSource(src, "layoutWidget"), /fitWidget\(\)\n\s*\}/);
});

test("widget height: pages without their own sbFit report through the page script, to their own handler", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const script = src.match(/^let WIDGET_PAGE_SCRIPT = #"""\n([\s\S]*?)\n"""#/m)?.[1] ?? "";
  assert.ok(script);
  const run = (handlers, own) => {
    const posted = [], ready = [];
    const window = { webkit: { messageHandlers: Object.fromEntries(handlers.map((h) => [h, { postMessage: (m) => posted.push([h, m]) }])) } };
    if (own) window.sbFit = own;
    const document = { getElementById: () => ({ offsetHeight: 321 }) };
    new Function("window", "document", "addEventListener", "requestAnimationFrame", script)(
      window, document, (_, f) => ready.push(f), (f) => f());
    ready.forEach((f) => f());
    window.sbFit();
    return posted;
  };
  assert.deepEqual(run(["sb"]), [["sb", { height: 321 }]]);
  assert.deepEqual(run(["hosts"]), [["hosts", { height: 321 }]]);
  assert.deepEqual(run(["sb"], () => {}), [], "a page with its own sbFit keeps it");
});

test("widget Settings: Back returns to the tab, hides a widget that was closed, and an open setup screen only comes forward", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const settings = methodSource(src, "menuSettings");
  assert.match(settings, /if onSetupScreen \{\n[^\n]*\n\s*showHost\(\)/);
  assert.ok(settings.indexOf("if onSetupScreen {") < settings.indexOf("needsSetup()"));
  assert.match(methodSource(src, "showWidgetSettings"), /lendWidgetToSetup\(\)/);
  const hide = methodSource(src, "hideWidgetSettings");
  assert.match(hide, /if self\.widgetHiddenBeforeSetup == true \{ self\.window\.orderOut\(nil\) \}\n\s*self\.widgetHiddenBeforeSetup = nil/);
  // Partner domains saved in Settings reach the Hosts tab at once.
  assert.match(hide, /self\.hostsMessage\(\["status": true\]\)/);
  const page = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  assert.match(page, /id="partners"/);
  assert.match(page, /backToBoard: true/);
});

test("menu bar icon: in Widget mode every click opens the menu; in Popover mode a left click toggles the popover", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const apply = methodSource(src, "applyDisplayMode");
  assert.match(apply, /statusItem\.menu = popover \? nil : statusMenu\n/);
  // An attached menu takes every click, so the button's action fires only in Popover mode.
  assert.match(src, /statusItem\.button\?\.action = #selector\(statusItemClicked\)/);
  assert.match(src, /statusItem\.button\?\.sendAction\(on: \[\.leftMouseUp, \.rightMouseUp\]\)/);
  const click = methodSource(src, "statusItemClicked");
  assert.match(click, /event\.type == \.rightMouseUp \|\| event\.modifierFlags\.contains\(\.control\)/);
  assert.match(click, /panel\.performClose\(nil\)\n\s*statusItem\.menu = statusMenu\n\s*statusItem\.button\?\.performClick\(nil\)\n\s*statusItem\.menu = nil\n\s*return/);
  assert.ok(click.indexOf("performClick") < click.indexOf("togglePanel()"), "a right click never toggles the popover");
  // The mouse-down that closes the popover must not reopen it on its mouse-up.
  assert.match(click, /if let closedAt = panelClosedByIconAt, event\.timestamp - closedAt < 1 \{/);
  assert.match(methodSource(src, "popoverWillClose"), /panelClosedByIconAt = event\.timestamp/);
  // Quit stays in the menu, and the menu stays reachable in both modes.
  assert.match(src, /NSMenuItem\(title: "Quit Sprint Board", action: #selector\(NSApplication\.terminate\(_:\)\)/);
  assert.match(src, /statusMenu = menu\n/);
});

test("display mode: with no stored choice, or an unknown one, the app is a widget", { skip: !swiftAvailable }, () => {
  const mode = (stored) => ({ op: "mode", stored });
  assert.deepEqual(widgetRun([mode(null), mode("widget"), mode("popover"), mode("window"), mode(7), { op: "mode" }]),
    ["widget", "widget", "popover", "widget", "widget", "widget"]);
});

test("display mode: the header shows with the tabs; the popover's Settings and every setup screen have none", { skip: !swiftAvailable }, () => {
  const header = (setup, settings, mode) => ({ op: "header", setup, settings, mode });
  assert.deepEqual(widgetRun([header(false, false, "widget"), header(false, true, "widget"), header(true, false, "widget"),
    header(false, false, "popover"), header(false, true, "popover"), header(true, false, "popover")]),
  [true, true, false, true, false, false]);
});

test("display mode: the popover fits the page, starts at the default height, and never leaves the screen", { skip: !swiftAvailable }, () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const start = Number(src.match(/^let PANEL_START_HEIGHT: CGFloat = (\d+)$/m)[1]);
  const panel = (page, header, screen) => ({ op: "panel", page, header, screen });
  assert.deepEqual(widgetRun([panel(500, 38, 900), panel(null, 38, 900), panel(5000, 38, 900), panel(5000, 0, 900), panel(10, 0, 900)]),
    [538, start + 38, 860, 860, 40]);
  const fit = methodSource(src, "fitWidget");
  assert.match(fit, /^\s*func fitWidget\(animated: Bool = false\) \{\n\s*if displayMode == \.popover \{ fitPanel\(\); return \}\n/);
  const panelFit = methodSource(src, "fitPanel");
  assert.match(panelFit, /pageHeight: widgetPageHeights\[widgetShownPage\]/);
  // The shown popover owns its view's frame; a closed one keeps a stale size for the next layout.
  assert.match(panelFit, /if !panel\.isShown \{ panelRoot\.setFrameSize\(size\) \}\n\s*panel\.contentSize = size/);
});

test("display mode: one set of pages moves between the hosts, in paint order", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.equal((src.match(/DragWebView\(frame:/g) || []).length, 1);
  assert.equal((src.match(/makeTabWebView\(handler:/g) || []).length, 3, "the two tab pages and the declaration");
  assert.equal((src.match(/NSPopover\(\)/g) || []).length, 1);
  const move = methodSource(src, "moveBoard");
  assert.match(move, /for view in \[tint\] \+ \(widgetPages as \[NSView\]\) \+ \[header\] \{\n\s*view\.removeFromSuperview\(\)\n\s*host\.addSubview\(view\)/);
  assert.match(move, /tint\.frame = host\.bounds/);
  assert.match(move, /y: host\.bounds\.height - PANEL_HEADER_HEIGHT/);
  assert.match(methodSource(src, "layoutWidget"), /let material = header\.superview else/);
  const setUp = methodSource(src, "setUpPanel");
  assert.match(setUp, /panel\.behavior = \.transient/);
  assert.match(setUp, /panel\.delegate = self/);
  assert.doesNotMatch(setUp, /loadPage|makeTabWebView/);
});

test("display mode: the switch owns the host, the menu, the window buttons and the widget's own memory, both ways", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const apply = methodSource(src, "applyDisplayMode");
  assert.match(apply, /if popover \{ window\.orderOut\(nil\) \} else \{ panel\.close\(\) \}/);
  assert.match(apply, /moveBoard\(to: popover \? panelRoot : window\.contentView!\)/);
  assert.match(apply, /for light in widgetLights \{ light\.isHidden = popover \}/);
  assert.match(apply, /frontItem\?\.isHidden = popover/);
  assert.match(apply, /panelClosedByIconAt = nil/);
  assert.match(apply, /layoutWidget\(\)/);
  const set = methodSource(src, "setDisplayMode");
  assert.match(set, /guard mode != displayMode else \{ return \}/);
  for (const [first, second] of [["UserDefaults.standard.set(mode.rawValue, forKey: DISPLAY_MODE_KEY)", "displayMode = mode"],
    ["if restoreFrame != nil { toggleFill() }", "displayMode = mode"], ["widgetHiddenBeforeSetup = nil", "applyDisplayMode()"],
    ["displayMode = mode", "applyDisplayMode()"], ["applyDisplayMode()", "showHost()"]]) {
    assert.ok(set.includes(first) && set.indexOf(first) < set.indexOf(second), `${first} before ${second}`);
  }
});

test("display mode: the saved choice applies at launch and the window stays hidden in Popover mode", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(src, /var displayMode = displayModeChoice\(UserDefaults\.standard\.object\(forKey: DISPLAY_MODE_KEY\)\)/);
  const launch = methodSource(src, "applicationDidFinishLaunching");
  // In Popover mode the first layout fits the popover, before the status item exists: a nil
  // here ends every launch, and the saved choice has no way back.
  assert.ok(launch.indexOf("setUpPanel()") < launch.indexOf("setUpWidgetTabs(in: material)"));
  assert.match(methodSource(src, "fitPanel"), /statusItem\?\.button\?\.window\?\.screen/);
  assert.ok(launch.indexOf("statusItem = NSStatusBar") < launch.indexOf("applyDisplayMode()"));
  assert.match(launch, /if displayMode == \.widget \{ window\.orderFront\(nil\) \}/);
  const active = methodSource(src, "applicationDidBecomeActive");
  assert.match(active, /if displayMode == \.popover \{\n\s*if panel\.isShown \{ panel\.contentViewController\?\.view\.window\?\.makeKey\(\) \}\n\s*return\n\s*\}/);
  assert.ok(active.indexOf("return") < active.indexOf("window.orderFront"), "activation never shows the window in Popover mode");
  assert.match(methodSource(src, "menuFront"), /^\s*@objc func menuFront\(\) \{\n\s*if displayMode == \.popover \{ showHost\(\); return \}/);
});

test("display mode: every way to bring the board forward goes through the host of the mode", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  for (const name of ["menuSetup", "menuSettings", "showWidgetSettings"]) {
    const body = methodSource(src, name);
    assert.match(body, /[Hh]ost\(\)|showWidgetSettings\(\)/, name);
    assert.doesNotMatch(body, /makeKeyAndOrderFront/, name);
  }
  const host = methodSource(src, "showHost");
  assert.match(host, /if displayMode == \.popover \{\n\s*if !panel\.isShown \{ openPanel\(\) \}\n\s*return\n\s*\}\n\s*NSApp\.activate\(ignoringOtherApps: true\)\n\s*window\.makeKeyAndOrderFront\(nil\)/);
  // A closed popover must hold the page before it opens, so it opens at that page's height.
  const show = methodSource(src, "showWidgetSettings");
  assert.ok(show.indexOf("self.swapWidgetPage()") < show.indexOf("self.showHost()"));
  assert.match(src, /var boardVisible: Bool \{ displayMode == \.popover \? panel\.isShown : window\.isVisible \}/);
  // The accessory app's popover gets keystrokes only when the app is active.
  const open = methodSource(src, "openPanel");
  assert.ok(open.indexOf("panel.show(") < open.indexOf("NSApp.activate(ignoringOtherApps: true)"));
  assert.match(methodSource(src, "popoverDidShow"), /makeKey\(\)/);
  // The closed widget's memory has no meaning in the popover.
  assert.match(methodSource(src, "lendWidgetToSetup"), /if displayMode == \.popover \{ return \}/);
});

test("display mode: a drag moves the widget window and leaves the popover at the icon", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(src, /guard window is BoardWindow, p\.y < DragWebView\.handleHeight else \{\n\s*super\.mouseDown\(with: event\)/);
});

test("display mode: Settings offers both modes, shows the current one and applies a click at once", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const page = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  const block = page.slice(page.indexOf('<div id="settings" hidden>'), page.indexOf("</div>\n<div id=\"err\""));
  assert.match(block, /data-mode="widget">Widget</);
  assert.match(block, /data-mode="popover">Popover</);
  assert.match(page, /showMode\(button\.dataset\.mode\);\n\s*post\(\{ displayMode: button\.dataset\.mode \}\);/);
  assert.match(page, /showSettings\(ctx\);\n\s*showMode\(ctx\.displayMode\);/);
  assert.doesNotMatch(page.match(/post\(\{ saveSettings: \{[\s\S]*?\} \}\);/)[0], /displayMode/, "the choice does not wait for Save settings");
  assert.match(methodSource(src, "fillWidgetSettings"), /signedIn\.merging\(\["displayMode": displayMode\.rawValue\]\)/);
  // Only the Settings page reaches the switch, and only with a mode this build knows.
  assert.match(methodSource(src, "userContentController"), /if fromSettingsPage, let raw = body\["displayMode"\] as\? String, let mode = DisplayMode\(rawValue: raw\) \{\n\s*setDisplayMode\(mode\)/);
});

test("display mode: sign-in uses the setup page in both modes, without the window buttons in the popover", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const setup = readFileSync(new URL("./setup.html", import.meta.url), "utf8");
  assert.match(setup, /\.in-popover \.lights \{ display: none \}/);
  const finish = src.slice(src.indexOf("func webView(_ w: WKWebView, didFinish"), src.indexOf("func webView(_ w: WKWebView, didFail nav"));
  assert.match(finish, /classList\.toggle\('in-popover', \\\(displayMode == \.popover\)\)/);
  // A hidden window takes the closed path: the page changes and nothing comes forward.
  assert.match(methodSource(src, "requireLogin"), /let widgetClosed = !self\.window\.isVisible && !self\.window\.isMiniaturized\n\s*if widgetClosed \{\n\s*self\.loadPage\("setup\.html"\)/);
  // The result of a sign-in depends on no page or host being on screen.
  const start = methodSource(src, "startAtlassianLogin");
  assert.doesNotMatch(start, /panel|window\.|isVisible/);
  assert.doesNotMatch(methodSource(src, "finishAtlassianLogin"), /panel|window\.|isVisible/);
});

test("widget fold: the window edge moves with the page's own time and curve, pinned to the top", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const page = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const [, duration, a, b, c, d] = page.match(/const FOLD_MOTION = \{ duration: (\d+), easing: "cubic-bezier\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)" \};/);
  assert.equal(Number(src.match(/^let WIDGET_FIT_SECONDS: TimeInterval = ([\d.]+)$/m)?.[1]) * 1000, Number(duration));
  assert.deepEqual(src.match(/^let WIDGET_FIT_CURVE = CAMediaTimingFunction\(controlPoints: ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)$/m)?.slice(1).map(Number), [a, b, c, d].map(Number));
  // Only a later height of the board animates: not a first report, a hidden window, or reduced motion.
  assert.match(methodSource(src, "userContentController"), /fitWidget\(animated: known && w === web && !onSetupScreen\)/);
  const fit = methodSource(src, "fitWidget");
  assert.match(fit, /let move = animated && window\.isVisible && !NSWorkspace\.shared\.accessibilityDisplayShouldReduceMotion/);
  // A fold reports its height more than once; the second report does not start the move again.
  assert.match(fit, /if let target = widgetFitTarget \{[^\n]*\n[^\n]*\n\s*if abs\(f\.height - target\) < 0\.5 \{ return \}/);
  // The pages stay pinned to the top during the move, and only the newest move finishes.
  assert.match(fit, /if move \{ pinWidgetPages\(windowHeight: f\.height\) \}/);
  assert.match(fit, /guard let self, run == self\.widgetFitRun else \{ return \}/);
  assert.match(fit, /for page in self\.widgetPages \{ page\.autoresizingMask = \[\.width, \.height\] \}/);
  assert.match(methodSource(src, "pinWidgetPages"), /page\.autoresizingMask = \[\.width, \.minYMargin\]/);
});

test("board page: a 100% ring value stays inside the ring", () => {
  const page = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  assert.match(page, /\.ring \{ width: 48px; height: 48px; flex: none; \}/);
  const size = Number(page.match(/\.ring text \{ font: 700 ([\d.]+)px /)?.[1]);
  assert.ok(size <= 7.5, `ring text ${size}`);
  assert.match(page, /\.ring text \{[^}]*letter-spacing: -\.2px;/);
  assert.match(page, /r="14" fill="none" stroke="rgba\(255,255,255,\.14\)" stroke-width="4"/);
});

test("setup screen: in the panel the back arrow, buttons and inputs follow the board's", () => {
  const setup = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  // The back arrow is an SF Symbol in the header button's box, as the Sprint page's gear.
  assert.match(setup, /<span class="back" id="back" role="button" title="Back"><i class="sym s-chevron-left"><\/i><\/span>/);
  assert.match(swift.match(/^let PAGE_SYMBOLS = \[([\s\S]*?)^\]/m)[1], /"chevron\.left"/);
  assert.match(sprints, /\.rf \{[^}]*width: 30px; height: 26px;\s*border-radius: 6px;/);
  assert.match(sprints, /\.rf \.sym \{ width: 16px; height: 16px; \}/);
  assert.match(setup, /\.back \{[^}]*width: 30px; height: 26px;[^}]*border-radius: 6px;/);
  assert.match(setup, /\.back \.sym \{ display: block; width: 16px; height: 16px;/);
  // Save is a filled blue button like the sign-in ones; the inputs are the note field's.
  assert.match(setup, /<button id="saveSettings" class="primary">Save settings<\/button>/);
  assert.match(setup, /button\.primary \{ color: #fff; background: -apple-system-control-accent; \}/);
  assert.match(setup, /button \{ display: block; width: 100%; height: 28px;/);
  const note = sprints.match(/\.notes \.ninput \{([^}]*)\}/)[1].replace(/\s+/g, " ");
  const input = setup.match(/input:not\(\[type="checkbox"\]\) \{([^}]*)\}/)[1].replace(/\s+/g, " ");
  for (const rule of ["height: 26px", "padding: 0 10px", "border-radius: 7px", "background: rgba(255,255,255,.12)", "border: 1px solid rgba(255,255,255,.14)"]) {
    assert.ok(note.includes(rule) && input.includes(rule), rule);
  }
});

test("setup screen: in the panel a back arrow and a Settings title replace the window buttons", () => {
  const setup = readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8");
  assert.match(setup, /<h1><span class="back" id="back" role="button" title="Back">[^\n]*<\/span>Settings<\/h1>/);
  assert.match(setup, /\$\("back"\)\.addEventListener\("click", \(\) => post\(\{ backToBoard: true \}\)\);/);
  // The widget's own controls are not on the popover's page; the popover material shows through.
  assert.doesNotMatch(setup, /class="lights"|data-win|Back to board/);
  assert.match(setup, /#card \{ padding: 14px 16px 16px; \}/);
});

test("board page: in the panel the could-not-refresh strip keeps clear of the header buttons", () => {
  assert.match(readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8"), /\.stale \{ margin: 10px 0 0;/);
});

test("board page: in the panel the task rows and the GitHub rows share one box and are set in alike", () => {
  const sprints = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  // Task rows, past sprints' rows and GitHub rows: one box, the same spacing.
  assert.match(sprints, /\.row, \.brow, \.item \{ display: flex; align-items: center; gap: 6px; margin: 0 0 4px 6px; padding: 2px 4px; border-radius: 8px;/);
  assert.match(sprints, /\.ghd \{[^}]*margin: 8px 0 4px; padding: 2px 8px;/);
  // The late review keeps its yellow box over the common fill.
  assert.match(sprints, /\.item\.late \{ background: color-mix\(in srgb, -apple-system-yellow 16%, transparent\); \}/);
});

test("panel tabs: neither page shows a scroll bar, so a tab switch or an opened list does not flash one", () => {
  for (const page of [readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8"), readFileSync(new URL("./popover/settings.html", import.meta.url), "utf8")]) {
    assert.match(page, /html, body \{[^}]*scrollbar-width: none; \}\n\s*html::-webkit-scrollbar, body::-webkit-scrollbar \{ display: none; \}/);
  }
  assert.match(readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8"), /html, body \{ scrollbar-width: none; \}\n\s*html::-webkit-scrollbar, body::-webkit-scrollbar \{ display: none; \}/);
});

test("real run: the config's goal stages and name overrides reach the goal band", () => {
  const stages = [{ name: "Anything", atRisk: 1, critical: null, statuses: ["In Progress"] }];
  const { out } = runReal({ ...realCfg, sprintGoalTracking: true, goalRiskStages: stages, nameOverrides: { "Demo User": "Dee" } }, realSearches);
  const { out: plain } = runReal({ ...realCfg, sprintGoalTracking: true }, realSearches);
  assert.deepEqual(plain.sprintGoal.rows.map((r) => [r.key, r.stage, r.risk, r.ownerShort]), [["DEMO-101", "In Progress", "red", "Demo"]]);
  assert.deepEqual(out.sprintGoal.rows.map((r) => [r.key, r.stage, r.risk, r.ownerShort]), [["DEMO-101", "Anything", "yellow", "Dee"]]);
  assert.equal(out.sprintGoal.worst, "yellow");
});

// App methods that touch /etc/hosts, the keychain and Chrome, compiled with stand-ins: temp
// files for the paths, an in-memory keychain, fake NSWorkspace and NSRunningApplication, and the
// page's replies and notes recorded instead of sent. Each run is its own process.
let appDriver, appDir;
function appRun(input, env = {}) {
  if (!appDriver) {
    const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
    const consts = ["HOSTS_BLOCK_START", "HOSTS_BLOCK_END", "HOSTS_LEGACY_BLOCK_START", "HOSTS_LEGACY_BLOCK_END",
      "HOSTS_SYSTEM_NAMES", "HOSTS_LOCAL_ADDRESSES", "HOSTS_DELETE_BACKUP_PREFIX", "HOSTS_DELETE_BACKUPS_KEPT", "PARTNERS_GROUP", "CHROME_INSECURE_FLAGS", "JIRA_KEYCHAIN", "JIRA_OAUTH_KEYCHAIN", "WORKER_URL"].map((name) => {
      const line = src.match(new RegExp(`^let ${name} = .*$`, "m"));
      assert.ok(line, `${name} not found in SprintBoard.swift`);
      return line[0];
    });
    const decls = ["struct HostsGroup", "struct HostsList", "struct HostsRow", "struct HostsEdit", "enum TokenResult"].map((header) => swiftDecl(src, header));
    const funcs = ["hostsName", "hostsEntry", "hostsMarkers", "hostsBlockRange", "managedHosts", "hostsLocalLine", "hostsCommented",
      "hostsUncommented", "hostsLineWithout", "hostsEntryWithout", "hostsRows", "hostsSwitched", "hostsAdded", "hostsRemoved", "hostsEdited",
      "hostsPartnerName", "hostsGroupName",
      "hostsList", "hostsListJSON", "hostsApply", "hostsStatus", "hostsFileText", "hostsDeleteBackupName", "hostsDeleteBackupPath", "hostsDeleteBackupsPast", "writeHostsFile", "chromeMissingFlags",
      "partnerDomainSuffixes", "needsSetup"].map((name) => swiftSource(src, name));
    const methods = ["readHostsList", "writeHostsList", "migrateHostsList", "hostsMessage", "readHostsText", "hostsPartnerSuffixes", "scheduleChromeRefresh",
      "openInsecureChrome", "cachedKeychainGet", "forgetCachedTokens", "currentJiraAccessToken", "tokenPayload"].map((name) => methodSource(src, name));
    const driver = `import Foundation
let env = ProcessInfo.processInfo.environment
let HOSTS_PATH = env["SB_HOSTS"] ?? ""
let HOSTS_LIST_PATH = env["SB_LIST"] ?? ""
let HOSTS_BACKUP_DIR = env["SB_BACKUP"] ?? ""
let CONFIG_PATH = env["SB_CONFIG"] ?? ""
${consts.join("\n")}
${decls.join("\n")}
${funcs.join("\n")}
func dbg(_ s: String) {}
// No network here: a refresh that gets this far reports an unreachable server.
func postJSON(_ urlString: String, _ body: [String: Any]) -> (status: Int?, json: [String: Any]?) { (nil, nil) }

// The keychain: items by service and account. A denied item exists but its secret is not handed
// over (Deny in macOS's dialog). Secret reads are counted, and one can run a step while it is under way.
var keychainItems: [String: String] = [:]
var deniedItems: Set<String> = []
var secretReads = 0
var duringRead: (() -> Void)?
func keychainGet(service: String, account: String) -> String? {
    secretReads += 1
    let key = service + "\\n" + account
    let value = deniedItems.contains(key) ? nil : keychainItems[key]
    let step = duringRead
    duringRead = nil
    step?()
    return value
}
func keychainHas(service: String, account: String) -> Bool { keychainItems[service + "\\n" + account] != nil }
func keychainSet(service: String, account: String, value: String) { keychainItems[service + "\\n" + account] = value }

final class NSRunningApplication {
    static var running: [NSRunningApplication] = []
    let processIdentifier: Int32
    init(_ pid: Int32) { processIdentifier = pid }
    static func runningApplications(withBundleIdentifier id: String) -> [NSRunningApplication] { running }
}
final class NSWorkspace {
    final class OpenConfiguration { var arguments: [String] = []; var activates = false }
    static let shared = NSWorkspace()
    var installed = true
    var launches: [[String]] = []
    func urlForApplication(withBundleIdentifier id: String) -> URL? {
        installed ? URL(fileURLWithPath: "/Applications/Google Chrome.app") : nil
    }
    func openApplication(at url: URL, configuration: OpenConfiguration, completionHandler: @escaping (Any?, Error?) -> Void) {
        launches.append(configuration.arguments)
        completionHandler(nil, nil)
    }
}

final class App {
    let hostsQueue = DispatchQueue(label: "test.hosts")
    let chromeQueue = DispatchQueue(label: "test.chrome")
    var chromeRefresh: DispatchWorkItem?
    var keychainCache: [String: String] = [:]
    var keychainCacheGeneration = 0
    let keychainCacheLock = NSLock()
    var replies: [[String: Any]] = []
    var notes: [Any] = []
    var chromeRefreshes = 0
    func replyHosts(_ state: [String: Any], to body: [String: Any]) { replies.append(state) }
    func showChromeNote(_ note: String?) { notes.append(note.map { $0 as Any } ?? NSNull()) }
    func refreshChrome() { chromeRefreshes += 1 }
    var jiraAccessToken: String?
    var jiraAccessExpiry: Date?
${methods.join("\n")}
}

func settle(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
func waitUntil(_ done: () -> Bool) {
    let end = Date().addingTimeInterval(2)
    while !done(), Date() < end { settle(0.01) }
}
func setItems(_ items: [[String: Any]]) {
    keychainItems = [:]
    deniedItems = []
    for item in items {
        let key = (item["service"] as! String) + "\\n" + (item["account"] as! String)
        keychainItems[key] = item["value"] as? String ?? ""
        if item["denied"] as? Bool == true { deniedItems.insert(key) }
    }
}
func writeConfig(_ config: Any?) {
    if let config, !(config is NSNull) {
        FileManager.default.createFile(atPath: CONFIG_PATH, contents: try! JSONSerialization.data(withJSONObject: config))
    } else {
        try? FileManager.default.removeItem(atPath: CONFIG_PATH)
    }
}
let input = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
let app = App()
var out: [String: Any] = [:]
switch input["op"] as! String {
case "hosts":
    app.hostsMessage(input["body"] as! [String: Any])
    app.hostsQueue.sync {}
    out = ["reply": app.replies.last ?? [:]]
case "keychain":
    let key = "svc\\nada@example.invalid"
    var values: [Any] = []
    for step in input["steps"] as! [[String: Any]] {
        if let value = step["set"] as? String { keychainItems[key] = value }
        if step["forget"] != nil { app.forgetCachedTokens() }
        if let next = step["forgetDuringRead"] as? String {
            duringRead = { app.forgetCachedTokens(); keychainItems[key] = next }
        }
        if step["get"] != nil || step["forgetDuringRead"] != nil {
            values.append(app.cachedKeychainGet(service: "svc", account: "ada@example.invalid").map { $0 as Any } ?? NSNull())
        }
    }
    out = ["values": values, "reads": secretReads]
case "payload":
    writeConfig(input["config"])
    setItems(input["items"] as! [[String: Any]])
    out = ["payload": try! JSONSerialization.jsonObject(with: app.tokenPayload())]
case "needsSetup":
    var results: [Any] = []
    for c in input["cases"] as! [[String: Any]] {
        writeConfig(c["config"])
        setItems(c["items"] as? [[String: Any]] ?? [])
        results.append(needsSetup())
    }
    out = ["needsSetup": results, "reads": secretReads]
case "openChrome":
    var results: [Any] = []
    for c in input["cases"] as! [[String: Any]] {
        NSRunningApplication.running = (c["pid"] as? Int).map { [NSRunningApplication(Int32($0))] } ?? []
        NSWorkspace.shared.installed = c["installed"] as? Bool ?? true
        NSWorkspace.shared.launches = []
        app.notes = []
        app.openInsecureChrome()
        waitUntil { !app.notes.isEmpty }
        results.append(["launches": NSWorkspace.shared.launches, "notes": app.notes])
    }
    out = ["results": results]
case "chromeBurst":
    app.scheduleChromeRefresh()
    settle(0.05)
    app.scheduleChromeRefresh()
    waitUntil { app.chromeRefreshes >= 1 }
    // Long enough for a refresh the second switch failed to cancel to run too.
    settle(0.15)
    let afterBurst = app.chromeRefreshes
    app.scheduleChromeRefresh()
    waitUntil { app.chromeRefreshes >= 2 }
    out = ["refreshes": [afterBurst, app.chromeRefreshes]]
default:
    break
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;
    appDir = mkdtempSync(join(tmpdir(), "sprint-board-app-"));
    process.on("exit", () => rmSync(appDir, { recursive: true, force: true }));
    writeFileSync(join(appDir, "main.swift"), driver);
    execFileSync("swiftc", [join(appDir, "main.swift"), "-o", join(appDir, "app")], { stdio: "pipe" });
    appDriver = join(appDir, "app");
  }
  return JSON.parse(execFileSync(appDriver, { input: JSON.stringify(input),
    env: { ...process.env, SB_CONFIG: join(appDir, "config.json"), ...env } }));
}

const SAVED = { groups: LIST.groups };
// One Hosts message on temp files: /etc/hosts, the saved list (in a folder of its own, so it can
// be made read-only) and the backups.
function hostsMessageRun(body, { hosts, list = JSON.stringify(SAVED), lockHosts = false, lockList = false }) {
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-message-"));
  const listDir = join(dir, "list");
  const env = { SB_HOSTS: join(dir, "hosts"), SB_LIST: join(listDir, "hosts.json"), SB_BACKUP: join(dir, "backup") };
  mkdirSync(listDir);
  writeFileSync(env.SB_HOSTS, hosts);
  writeFileSync(env.SB_LIST, list);
  if (lockHosts) chmodSync(env.SB_HOSTS, 0o444);
  if (lockList) chmodSync(listDir, 0o555);
  try {
    const { reply } = appRun({ op: "hosts", body }, env);
    const backup = join(env.SB_BACKUP, "hosts.json.before-file-rows");
    return { reply, hosts: readFileSync(env.SB_HOSTS), list: readFileSync(env.SB_LIST, "utf8"),
      listBackup: existsSync(backup) ? readFileSync(backup, "utf8") : null };
  } finally {
    chmodSync(listDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
}
const localDomains = (reply) => reply.domains.filter((d) => d.local).map((d) => d.name);

test("Hosts message: when /etc/hosts cannot be written, the saved list is rolled back and the error is shown", { skip: !swiftAvailable }, () => {
  const hosts = withBlock(SAMPLE_HOSTS, ["shop.example.test"]);
  const r = hostsMessageRun({ remove: "shop.example.test" }, { hosts, lockHosts: true });
  assert.match(r.reply.error, /is not writable by your user/);
  assert.deepEqual(JSON.parse(r.list), SAVED);
  assert.deepEqual(r.hosts, Buffer.from(hosts));
  assert.ok(localDomains(r.reply).includes("shop.example.test"));
});

test("Hosts message: when the domain list cannot be saved, /etc/hosts is not written", { skip: !swiftAvailable }, () => {
  const hosts = withBlock(SAMPLE_HOSTS, ["shop.example.test"]);
  const r = hostsMessageRun({ remove: "shop.example.test" }, { hosts, lockList: true });
  assert.match(r.reply.error, /^Could not save the domain list/);
  assert.deepEqual(JSON.parse(r.list), SAVED);
  assert.deepEqual(r.hosts, Buffer.from(hosts));
  assert.ok(localDomains(r.reply).includes("shop.example.test"));
});

test("Hosts message: an /etc/hosts that is not text is shown as unreadable and nothing is applied", { skip: !swiftAvailable }, () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const r = hostsMessageRun({ add: "new.example.test" }, { hosts: bytes });
  assert.equal(r.reply.mode, "unreadable");
  assert.match(r.reply.error, /^Could not read \/etc\/hosts as text/);
  assert.equal(r.list, JSON.stringify(SAVED));
  assert.deepEqual(r.hosts, bytes);
});

test("Hosts message: a domain list that does not parse is left as it is", { skip: !swiftAvailable }, () => {
  const hosts = withBlock(SAMPLE_HOSTS, ["shop.example.test"]);
  const r = hostsMessageRun({ add: "new.example.test" }, { hosts, list: "{not json" });
  assert.match(r.reply.error, /^Could not read the domain list/);
  assert.equal(r.list, "{not json");
  assert.deepEqual(r.hosts, Buffer.from(hosts));
});

test("Hosts message: with a damaged block nothing that writes the file runs", { skip: !swiftAvailable }, () => {
  const damaged = `${SAMPLE_HOSTS}${BLOCK_START}\n127.0.0.1 shop.example.test\n`;
  for (const body of [{ remove: "shop.example.test" }, { setMode: "prod", names: ["shop.example.test"] }, { groupDeleteWithDomains: "Shop" }, { add: "new.example.test" }, { addPartner: "acme" }]) {
    const r = hostsMessageRun(body, { hosts: damaged });
    assert.match(r.reply.error, /block in \/etc\/hosts is damaged/, JSON.stringify(body));
    assert.equal(r.list, JSON.stringify(SAVED), JSON.stringify(body));
    assert.deepEqual(r.hosts, Buffer.from(damaged));
  }
  const grouped = hostsMessageRun({ groupAdd: "Fresh" }, { hosts: damaged });
  assert.equal(grouped.reply.error ?? null, null, "a group lives in hosts.json only");
  assert.ok(JSON.parse(grouped.list).groups.some((g) => g.name === "Fresh"));
  assert.deepEqual(grouped.hosts, Buffer.from(damaged));
  assert.equal(hostsMessageRun({ status: true }, { hosts: damaged }).reply.error ?? null, null);
});

// A hosts file as the Hosts tab finds it: system lines, hand-kept lines, a tool's own section.
const HOSTS_FIXTURE = [
  "##",
  "# Host Database",
  "##",
  "127.0.0.1\tlocalhost",
  "255.255.255.255\tbroadcasthost",
  "::1             localhost",
  "fe80::1%lo0\tlocalhost",
  "",
  "# 127.0.0.1 is where this machine answers",
  "127.0.0.1 app.example.test",
  "#127.0.0.1 off.example.test",
  "127.0.0.1\tone.example.test  two.example.test three.example.test # shared",
  "10.0.0.5 pinned.example.test",
  "#10.0.0.6 away.example.test",
  "#Host manager BEGIN",
  "127.0.0.1 hm.example.test",
  "#127.0.0.1 hmoff.example.test hmoff2.example.test",
  "#Host manager END",
  "",
].join("\n");
const swap = (text, from, to) => { assert.ok(text.includes(from), from); return text.replace(from, to); };
const rowsOf = (text) => hostsOne({ op: "rows", text });

test("Hosts rule: a row shows each local domain in the file, wherever its line is, in file order", { skip: !swiftAvailable }, () => {
  assert.deepEqual(rowsOf(HOSTS_FIXTURE).map((r) => [r.name, r.local]), [
    ["app.example.test", true], ["off.example.test", false], ["one.example.test", true], ["two.example.test", true], ["three.example.test", true],
    ["hm.example.test", true], ["hmoff.example.test", false], ["hmoff2.example.test", false],
  ]);
});

test("Hosts rule: the rows come from /etc/hosts on every load; hosts.json adds no row and no state", { skip: !swiftAvailable }, () => {
  const list = JSON.stringify({ domains: ["gone.example.test", "app.example.test"], local: ["off.example.test"], groups: [] });
  const first = hostsMessageRun({ status: true }, { hosts: HOSTS_FIXTURE, list });
  assert.deepEqual(first.reply.domains.map((d) => [d.name, d.local]), rowsOf(HOSTS_FIXTURE).map((r) => [r.name, r.local]));
  const edited = swap(HOSTS_FIXTURE, "127.0.0.1 app.example.test", "#127.0.0.1 app.example.test");
  const next = hostsMessageRun({ status: true }, { hosts: edited });
  assert.equal(next.reply.domains.find((d) => d.name === "app.example.test").local, false, "a hand edit shows on the next load");
});

test("Hosts rule: Prod keeps the line in its place as a comment, and Local makes it active again, byte for byte", { skip: !swiftAvailable }, () => {
  const prod = hostsOne({ op: "switch", text: HOSTS_FIXTURE, names: ["hm.example.test"], local: false });
  assert.equal(prod, swap(HOSTS_FIXTURE, "\n127.0.0.1 hm.example.test\n", "\n#127.0.0.1 hm.example.test\n"));
  assert.equal(prod.split("\n").length, HOSTS_FIXTURE.split("\n").length, "no line is added or deleted");
  assert.equal(hostsOne({ op: "switch", text: prod, names: ["hm.example.test"], local: true }), HOSTS_FIXTURE);
  const spaced = "  # 127.0.0.1 note.example.test\n";
  assert.equal(hostsOne({ op: "switch", text: spaced, names: ["note.example.test"], local: true }), "  127.0.0.1 note.example.test\n");
});

test("Hosts rule: on a line with several domains a switch changes only that domain", { skip: !swiftAvailable }, () => {
  const prod = hostsOne({ op: "switch", text: HOSTS_FIXTURE, names: ["two.example.test"], local: false });
  assert.equal(prod, swap(HOSTS_FIXTURE, "127.0.0.1\tone.example.test  two.example.test three.example.test # shared\n",
    "127.0.0.1\tone.example.test three.example.test # shared\n#127.0.0.1\ttwo.example.test\n"));
  assert.deepEqual(rowsOf(prod).filter((r) => r.local).map((r) => r.name),
    ["app.example.test", "one.example.test", "three.example.test", "hm.example.test"]);
  // The same from a commented line: the others stay commented.
  const local = hostsOne({ op: "switch", text: HOSTS_FIXTURE, names: ["hmoff.example.test"], local: true });
  assert.equal(local, swap(HOSTS_FIXTURE, "#127.0.0.1 hmoff.example.test hmoff2.example.test\n",
    "#127.0.0.1 hmoff2.example.test\n127.0.0.1\thmoff.example.test\n"));
  // All of a line's domains: the line itself turns.
  const all = hostsOne({ op: "switch", text: HOSTS_FIXTURE, names: ["one.example.test", "two.example.test", "three.example.test"], local: false });
  assert.equal(all, swap(HOSTS_FIXTURE, "127.0.0.1\tone.example.test", "#127.0.0.1\tone.example.test"));
  // A name that is no row stays active with the rest of its line.
  const odd = "127.0.0.1 myhost a.example.test\n";
  assert.equal(hostsOne({ op: "switch", text: odd, names: ["a.example.test"], local: false }), "127.0.0.1 myhost\n#127.0.0.1\ta.example.test\n");
});

test("Hosts rule: a domain on two lines has one row; Prod turns both off, Local turns one on", { skip: !swiftAvailable }, () => {
  const text = "127.0.0.1 a.example.test\n::1 a.example.test\n#127.0.0.1 b.example.test\n#::1 b.example.test\n";
  assert.deepEqual(rowsOf(text).map((r) => [r.name, r.local]), [["a.example.test", true], ["b.example.test", false]]);
  assert.equal(hostsOne({ op: "switch", text, names: ["a.example.test"], local: false }),
    "#127.0.0.1 a.example.test\n#::1 a.example.test\n#127.0.0.1 b.example.test\n#::1 b.example.test\n");
  assert.equal(hostsOne({ op: "switch", text, names: ["b.example.test"], local: true }),
    "127.0.0.1 a.example.test\n::1 a.example.test\n127.0.0.1 b.example.test\n#::1 b.example.test\n");
  const half = "127.0.0.1 c.example.test\n#::1 c.example.test\n";
  assert.equal(hostsOne({ op: "switch", text: half, names: ["c.example.test"], local: true }), half, "already Local: nothing turns");
});

test("Hosts rule: only a comment that is clearly a host entry is a Prod row", { skip: !swiftAvailable }, () => {
  const comments = ["# 127.0.0.1 is where this machine answers", "#Host manager BEGIN", "## 127.0.0.1 double.example.test", "# see a.example.test",
    "#127.0.0.1", "#10.0.0.6 away.example.test", "#127.0.0.1 a.example.test and more", "#fe80::1 link.example.test"];
  assert.deepEqual(rowsOf(`${comments.join("\n")}\n`), []);
  assert.deepEqual(rowsOf("# 127.0.0.1 spaced.example.test\n#::1 six.example.test # why\n").map((r) => [r.name, r.local]),
    [["spaced.example.test", false], ["six.example.test", false]]);
});

test("Hosts rule: system entries are never shown or changed", { skip: !swiftAvailable }, () => {
  const system = ["127.0.0.1\tlocalhost", "255.255.255.255\tbroadcasthost", "::1             localhost", "fe80::1%lo0\tlocalhost",
    "127.0.0.1 localhost app.example.test", "127.0.0.1 localhost.localdomain", "#127.0.0.1 localhost", "#127.0.0.1 broadcasthost"];
  const text = `${system.join("\n")}\n`;
  assert.deepEqual(rowsOf(text), [], "a line with a system name is left out as a whole");
  const names = ["localhost", "broadcasthost", "app.example.test", "localhost.localdomain"];
  assert.equal(hostsOne({ op: "switch", text, names, local: false }), text);
  assert.equal(hostsOne({ op: "switch", text, names, local: true }), text);
});

test("Hosts rule: every other line stays byte for byte", { skip: !swiftAvailable }, () => {
  const text = `\r\n${HOSTS_FIXTURE}   \n\t# indented\n#  two  spaces\n\n\n`.replace("\r\n", "\n");
  const out = hostsOne({ op: "switch", text, names: ["app.example.test", "off.example.test", "hm.example.test"], local: false });
  const [before, after] = [text.split("\n"), out.split("\n")];
  assert.equal(after.length, before.length);
  const changed = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
  assert.deepEqual(changed, [["127.0.0.1 app.example.test", "#127.0.0.1 app.example.test"], ["127.0.0.1 hm.example.test", "#127.0.0.1 hm.example.test"]]);
});

test("Hosts rule: + adds to the managed block only; a switch outside it leaves the block alone", { skip: !swiftAvailable }, () => {
  const added = hostsMessageRun({ add: "new.example.test" }, { hosts: HOSTS_FIXTURE });
  assert.equal(added.hosts.toString(), `${HOSTS_FIXTURE}${BLOCK_START}\n#127.0.0.1\tnew.example.test\n${BLOCK_END}\n`);
  const row = added.reply.domains.find((d) => d.name === "new.example.test");
  assert.equal(row.local, false);
  const switched = hostsMessageRun({ setMode: "prod", names: ["app.example.test"] }, { hosts: added.hosts.toString() });
  assert.equal(switched.hosts.toString(), swap(added.hosts.toString(), "\n127.0.0.1 app.example.test\n", "\n#127.0.0.1 app.example.test\n"));
  const gone = hostsMessageRun({ remove: "new.example.test" }, { hosts: added.hosts.toString() });
  assert.equal(gone.hosts.toString(), HOSTS_FIXTURE);
});

test("Hosts rule: a group deleted with its domains removes their lines, in the block and outside it", { skip: !swiftAvailable }, () => {
  const hosts = `${HOSTS_FIXTURE}${BLOCK_START}\n127.0.0.1\tnew.example.test\n${BLOCK_END}\n`;
  const list = JSON.stringify({ groups: [{ name: "Mix", domains: ["new.example.test", "app.example.test"] }] });
  const r = hostsMessageRun({ groupDeleteWithDomains: "Mix" }, { hosts, list });
  assert.equal(r.hosts.toString(), swap(HOSTS_FIXTURE, "127.0.0.1 app.example.test\n", ""));
  assert.deepEqual(JSON.parse(r.list), { groups: [] });
});

test("Hosts delete: on a line with several domains only that domain goes; the others and the trailing comment stay", { skip: !swiftAvailable }, () => {
  assert.equal(hostsOne({ op: "remove", text: HOSTS_FIXTURE, names: ["two.example.test"] }),
    swap(HOSTS_FIXTURE, "one.example.test  two.example.test three.example.test # shared", "one.example.test three.example.test # shared"));
  assert.equal(hostsOne({ op: "remove", text: "127.0.0.1 myhost a.example.test\n", names: ["a.example.test"] }), "127.0.0.1 myhost\n",
    "a name that is no row keeps its line");
});

test("Hosts delete: the last domain on a line takes the line", { skip: !swiftAvailable }, () => {
  assert.equal(hostsOne({ op: "remove", text: HOSTS_FIXTURE, names: ["one.example.test", "two.example.test", "three.example.test"] }),
    swap(HOSTS_FIXTURE, "127.0.0.1\tone.example.test  two.example.test three.example.test # shared\n", ""));
  assert.equal(hostsOne({ op: "remove", text: "# keep\n127.0.0.1 a.example.test\n# keep too\n", names: ["a.example.test"] }), "# keep\n# keep too\n");
});

test("Hosts delete: a commented Prod line loses that domain and stays a comment, with its own spacing", { skip: !swiftAvailable }, () => {
  assert.equal(hostsOne({ op: "remove", text: HOSTS_FIXTURE, names: ["hmoff.example.test"] }),
    swap(HOSTS_FIXTURE, "#127.0.0.1 hmoff.example.test hmoff2.example.test\n", "#127.0.0.1 hmoff2.example.test\n"));
  assert.equal(hostsOne({ op: "remove", text: HOSTS_FIXTURE, names: ["off.example.test"] }), swap(HOSTS_FIXTURE, "#127.0.0.1 off.example.test\n", ""));
  assert.equal(hostsOne({ op: "remove", text: "  # 127.0.0.1  a.example.test  b.example.test # why\n", names: ["a.example.test"] }),
    "  # 127.0.0.1  b.example.test # why\n");
  // The same shape on the way to Local: the rest stays as the user wrote it.
  assert.equal(hostsOne({ op: "switch", text: "# 127.0.0.1 a.example.test b.example.test\n", names: ["a.example.test"], local: true }),
    "# 127.0.0.1 b.example.test\n127.0.0.1\ta.example.test\n");
});

test("Hosts delete: a line outside the block goes, and every line of a domain goes", { skip: !swiftAvailable }, () => {
  const r = hostsMessageRun({ remove: "app.example.test" }, { hosts: HOSTS_FIXTURE });
  assert.equal(r.reply.error ?? null, null);
  assert.equal(r.hosts.toString(), swap(HOSTS_FIXTURE, "127.0.0.1 app.example.test\n", ""));
  assert.ok(!r.reply.domains.some((d) => d.name === "app.example.test"));
  assert.equal(hostsOne({ op: "remove", text: "127.0.0.1 a.example.test\n#::1 a.example.test b.example.test\n", names: ["a.example.test"] }),
    "#::1 b.example.test\n");
  const both = `127.0.0.1 a.example.test\n# between\n${BLOCK_START}\n::1 a.example.test\n${BLOCK_END}\n# after\n`;
  assert.equal(hostsOne({ op: "remove", text: both, names: ["a.example.test"] }), "# between\n# after\n", "a block left empty goes too");
  const old = `127.0.0.1 a.example.test\n${LEGACY_START}\n127.0.0.1 b.example.test\n${LEGACY_END}\n`;
  assert.equal(hostsOne({ op: "remove", text: old, names: ["a.example.test"] }), `${LEGACY_START}\n127.0.0.1 b.example.test\n${LEGACY_END}\n`,
    "a block the delete does not reach stays byte for byte");
});

test("Hosts delete: system lines are refused by the writer and by the message", { skip: !swiftAvailable }, () => {
  const system = ["127.0.0.1\tlocalhost", "255.255.255.255\tbroadcasthost", "::1             localhost", "fe80::1%lo0\tlocalhost", "::1 ip6-localhost ip6-loopback",
    "127.0.0.1 localhost app.example.test", "#127.0.0.1 localhost"];
  const text = `${system.join("\n")}\n`;
  const names = ["localhost", "broadcasthost", "ip6-localhost", "ip6-loopback", "app.example.test"];
  assert.equal(hostsOne({ op: "remove", text, names }), text);
  for (const name of ["localhost", "broadcasthost", "ip6-localhost", "LocalHost"]) {
    const r = hostsMessageRun({ remove: name }, { hosts: text });
    assert.match(r.reply.error, /system entry/, name);
    assert.deepEqual(r.hosts, Buffer.from(text), name);
    assert.deepEqual(r.reply.domains, [], "and no system row reaches the page");
  }
});

test("Hosts delete: the backup is taken before each delete", { skip: !swiftAvailable }, () => {
  withHostsFile(HOSTS_FIXTURE, 0o644, ({ path, backupDir, read }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, removed: ["app.example.test"] }), null);
    const one = swap(HOSTS_FIXTURE, "127.0.0.1 app.example.test\n", "");
    assert.equal(read(), one);
    assert.equal(readFileSync(join(backupDir, "hosts.bak"), "utf8"), HOSTS_FIXTURE);
    assert.equal(hostsOne({ op: "write", path, backupDir, removed: ["off.example.test"] }), null);
    assert.equal(readFileSync(join(backupDir, "hosts.bak"), "utf8"), one);
  });
});

const DELETE_BACKUP_NAME = /^hosts\.before-delete-\d{8}T\d{6}\.\d{3}Z$/;
const deleteBackups = (dir) => (existsSync(dir) ? readdirSync(dir) : []).filter((name) => DELETE_BACKUP_NAME.test(name)).sort();

test("Hosts delete: each delete keeps its own timestamped copy of the file", { skip: !swiftAvailable }, () => {
  withHostsFile(HOSTS_FIXTURE, 0o644, ({ path, backupDir, read }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, removed: ["app.example.test"] }), null);
    const one = read();
    assert.equal(hostsOne({ op: "write", path, backupDir, removed: ["off.example.test"] }), null);
    const kept = deleteBackups(backupDir);
    assert.equal(kept.length, 2);
    assert.equal(readFileSync(join(backupDir, kept[0]), "utf8"), HOSTS_FIXTURE, "the older copy is not overwritten");
    assert.equal(readFileSync(join(backupDir, kept[1]), "utf8"), one);
    assert.equal(readFileSync(join(backupDir, "hosts.bak"), "utf8"), one, "hosts.bak still holds the last version");
    assert.equal(readFileSync(join(backupDir, "hosts.before-sprint-board"), "utf8"), HOSTS_FIXTURE, "and the first copy stays");
  });
});

test("Hosts delete: a copy holds the exact bytes of the file", { skip: !swiftAvailable }, () => {
  const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("127.0.0.1 app.example.test\r\n127.0.0.1 two.example.test\n")]);
  withHostsFile(bytes, 0o644, ({ path, backupDir }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, removed: ["two.example.test"] }), null);
    assert.deepEqual(readFileSync(join(backupDir, deleteBackups(backupDir)[0])), bytes);
  });
});

test("Hosts delete: only a write that deletes takes a timestamped copy", { skip: !swiftAvailable }, () => {
  withHostsFile(HOSTS_FIXTURE, 0o644, ({ path, backupDir }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, toProd: ["app.example.test"] }), null);
    assert.equal(hostsOne({ op: "write", path, backupDir, added: ["new.example.test"] }), null);
    assert.deepEqual(deleteBackups(backupDir), [], "a switch and an add use hosts.bak only");
    assert.ok(existsSync(join(backupDir, "hosts.bak")));
  });
});

test("Hosts delete: a delete that changes nothing takes no copy", { skip: !swiftAvailable }, () => {
  withHostsFile(HOSTS_FIXTURE, 0o644, ({ path, backupDir, read }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, removed: ["absent.example.test"] }), null);
    assert.equal(read(), HOSTS_FIXTURE);
    assert.deepEqual(deleteBackups(backupDir), []);
  });
});

test("Hosts delete: the last 20 copies stay and the older ones go", { skip: !swiftAvailable }, () => {
  const names = Array.from({ length: 25 }, (_, i) => `d${String(i).padStart(2, "0")}.example.test`);
  const file = names.map((name) => `127.0.0.1 ${name}\n`).join("");
  withHostsFile(file, 0o644, ({ path, backupDir, read }) => {
    mkdirSync(backupDir);
    const foreign = ["hosts.before-delete-notes", "hosts.before-delete-20000101T000000.000Z.keep", "other-20000101T000000.000Z"];
    for (const name of foreign) writeFileSync(join(backupDir, name), "mine");
    const old = "hosts.before-delete-20000101T000000.000Z";
    writeFileSync(join(backupDir, old), "old");
    writeFileSync(join(backupDir, "hosts.bak"), "previous");
    writeFileSync(join(backupDir, "hosts.before-sprint-board"), "first");

    const results = hostsRun(names.map((name) => ({ op: "write", path, backupDir, removed: [name] })));
    assert.deepEqual(results, names.map(() => null));
    assert.equal(read(), "");

    const kept = deleteBackups(backupDir);
    assert.equal(kept.length, 20);
    assert.ok(!kept.includes(old), "a copy from an earlier run counts as well");
    const expected = names.slice(5).map((_, i) => names.slice(5 + i).map((name) => `127.0.0.1 ${name}\n`).join(""));
    assert.deepEqual(kept.map((name) => readFileSync(join(backupDir, name), "utf8")), expected, "newest 20, in time order");
    for (const name of foreign) assert.equal(readFileSync(join(backupDir, name), "utf8"), "mine", `${name} is not ours`);
    assert.equal(readFileSync(join(backupDir, "hosts.before-sprint-board"), "utf8"), "first");
  });
});

test("Hosts delete: 20 copies are all kept, and the 21st removes one", { skip: !swiftAvailable }, () => {
  const names = (count) => Array.from({ length: count }, (_, i) => `hosts.before-delete-202611${String(i + 1).padStart(2, "0")}T090000.000Z`);
  assert.deepEqual(hostsOne({ op: "deleteBackupsPast", names: names(20) }), []);
  assert.deepEqual(hostsOne({ op: "deleteBackupsPast", names: [...names(21)].reverse() }), [names(21)[0]], "the oldest, in any list order");
});

test("Hosts delete: copy names are UTC, sort by time, and never repeat", { skip: !swiftAvailable }, () => {
  const at = Date.UTC(2026, 10, 5, 9, 7, 3, 42);
  assert.equal(hostsOne({ op: "deleteBackupName", ms: at }), "hosts.before-delete-20261105T090703.042Z");
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-backupname-"));
  try {
    const first = hostsOne({ op: "deleteBackupPath", dir, ms: at });
    assert.equal(first, join(dir, "hosts.before-delete-20261105T090703.042Z"));
    writeFileSync(first, "taken");
    const second = hostsOne({ op: "deleteBackupPath", dir, ms: at });
    assert.equal(second, join(dir, "hosts.before-delete-20261105T090703.043Z"), "the same moment gets the next name");
    assert.ok(first < second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hosts delete: a copy that cannot be written stops the delete", { skip: !swiftAvailable }, () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const writer = swiftSource(src, "writeHostsFile");
  assert.match(writer, /guard \(try\? data\.write\(to: URL\(fileURLWithPath: copy\), options: \.atomic\)\) != nil else \{\n\s+return "Could not back up/);
  assert.ok(writer.indexOf("fileURLWithPath: copy") < writer.indexOf("out.write(to:"), "the copy comes first");
  assert.ok(writer.indexOf("hostsDeleteBackupsPast(") > writer.indexOf("did not keep the change"),
    "old copies go only after the change is read back, so a failed delete removes none");

  withHostsFile(HOSTS_FIXTURE, 0o644, ({ path, backupDir, read }) => {
    mkdirSync(backupDir);
    chmodSync(backupDir, 0o555);
    try {
      assert.match(hostsOne({ op: "write", path, backupDir, removed: ["app.example.test"] }), /Could not back up/);
      assert.equal(read(), HOSTS_FIXTURE);
    } finally {
      chmodSync(backupDir, 0o755);
    }
  });
});

test("Hosts delete: a Local domain refreshes Chrome and a Prod one does not", { skip: !swiftAvailable }, () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  assert.match(methodSource(src, "hostsMessage"), /removedLocal: rows\.contains \{ \$0\.local && gone\.contains\(\$0\.name\) \}/);
});

test("Hosts rule: Add them, the Found note and the also-active warning are gone", () => {
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  const swift = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  for (const word of ["Add them", "importBtn", "local entr", "also active elsewhere", "toggleConflicts", "conflictsOpen", "importable", "s.conflicts"]) {
    assert.ok(!page.includes(word), word);
  }
  for (const name of ["hostsConflicts", "hostsImportable", "hostsImportGroups", "hostsGroupHeader", "importAll", "addMany"]) {
    assert.ok(!swift.includes(name), name);
  }
  // Every row offers its delete; a system line never reaches the page as a row.
  assert.match(page, /const canDelete = canChange;/);
});

test("Hosts rule: hosts.json keeps groups only", { skip: !swiftAvailable }, () => {
  assert.deepEqual(hostsOne({ op: "saved", json: { domains: ["a.example.test"], groups: [{ name: "G", domains: ["a.example.test"] }] } }),
    { groups: [{ name: "G", domains: ["a.example.test"] }] });
  // A group may name a domain that is not in the file now; it is back in the group when the line returns.
  assert.deepEqual(hostsOne({ op: "list", json: { groups: [{ name: "G", domains: ["later.example.test", "bad name"] }] } }),
    { domains: [], groups: [{ name: "G", domains: ["later.example.test"] }] });
  const r = hostsMessageRun({ setMode: "prod", names: ["app.example.test"] }, { hosts: HOSTS_FIXTURE });
  assert.equal(r.list, JSON.stringify(SAVED), "a switch does not touch hosts.json");
});

test("Hosts rule: an old hosts.json is migrated once, with its group names and a copy of the file", { skip: !swiftAvailable }, () => {
  const old = JSON.stringify({ domains: ["app.example.test", "gone.example.test"], groups: [{ name: "Keep", domains: ["app.example.test", "gone.example.test"] }, { name: "Empty", domains: [] }] });
  const r = hostsMessageRun({ status: true }, { hosts: HOSTS_FIXTURE, list: old });
  assert.deepEqual(JSON.parse(r.list), { groups: [{ name: "Keep", domains: ["app.example.test", "gone.example.test"] }, { name: "Empty", domains: [] }] });
  assert.equal(r.listBackup, old);
  assert.deepEqual(r.reply.groups, ["Keep", "Empty"]);
  assert.deepEqual(r.reply.domains.find((d) => d.name === "app.example.test").groups, ["Keep"]);
  assert.deepEqual(r.hosts, Buffer.from(HOSTS_FIXTURE), "opening the tab does not write /etc/hosts");
  const again = hostsMessageRun({ status: true }, { hosts: HOSTS_FIXTURE, list: r.list });
  assert.equal(again.list, r.list);
  assert.equal(again.listBackup, null, "a migrated file is left alone");
  // A list that cannot be saved stays as it is, and its groups still show.
  const locked = hostsMessageRun({ status: true }, { hosts: HOSTS_FIXTURE, list: old, lockList: true });
  assert.equal(locked.list, old);
  assert.deepEqual(locked.reply.groups, ["Keep", "Empty"]);
});

test("Hosts rule: every write keeps the backup, the unwritable message and the Chrome refresh", { skip: !swiftAvailable }, () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const message = methodSource(src, "hostsMessage");
  assert.match(message, /writeHostsFile\(edit, path: HOSTS_PATH, backupDir: HOSTS_BACKUP_DIR\)/);
  // A switch and a removed local domain change what resolves; a new Prod line does not.
  assert.match(message, /if edit\.changesResolution \{ self\.scheduleChromeRefresh\(\) \}/);
  withHostsFile(HOSTS_FIXTURE, 0o644, ({ path, backupDir, read }) => {
    assert.equal(hostsOne({ op: "write", path, backupDir, toProd: ["app.example.test"] }), null);
    assert.equal(readFileSync(join(backupDir, "hosts.bak"), "utf8"), HOSTS_FIXTURE);
    assert.notEqual(read(), HOSTS_FIXTURE);
  });
  const locked = hostsMessageRun({ setMode: "prod", names: ["app.example.test"] }, { hosts: HOSTS_FIXTURE, lockHosts: true });
  assert.match(locked.reply.error, /is not writable by your user/);
  assert.deepEqual(locked.hosts, Buffer.from(HOSTS_FIXTURE));
});

test("token cache: an empty read is not kept, and a read under way when the tokens are forgotten keeps nothing", { skip: !swiftAvailable }, () => {
  const out = appRun({ op: "keychain", steps: [
    { get: true },
    { set: "token-1" }, { get: true }, { get: true },
    { forget: true }, { set: "token-2" }, { get: true },
    { forget: true }, { forgetDuringRead: "token-3" },
    { get: true },
  ] });
  assert.deepEqual(out.values, [null, "token-1", "token-1", "token-2", "token-2", "token-3"]);
  // The empty read, token-1 once, token-2 twice (once per forget) and token-3.
  assert.equal(out.reads, 5);
});

test("token cache: Disconnect and a new token both forget the cached tokens", () => {
  const src = readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8");
  const disconnect = methodSource(src, "disconnect");
  assert.ok(disconnect.indexOf("forgetCachedTokens()") > disconnect.indexOf("keychainDelete(service: JIRA_OAUTH_KEYCHAIN"));
  assert.ok(disconnect.indexOf("forgetCachedTokens()") < disconnect.indexOf("clearBoardData()"));
  const login = methodSource(src, "finishTokenLogin");
  const saved = login.indexOf("keychainSet(service: JIRA_TOKEN_KEYCHAIN");
  assert.ok(saved >= 0 && login.indexOf("forgetCachedTokens()") > saved);
  assert.ok(login.indexOf("forgetCachedTokens()") < login.indexOf("self.showBoard()"));
});

test("token payload: a token the keychain will not hand over is told apart from a missing one", { skip: !swiftAvailable }, () => {
  const config = { email: "ada@example.invalid", tokensOwnedByApp: true };
  const item = { service: "sprint-board-jira", account: "ada@example.invalid" };
  const payload = (items) => appRun({ op: "payload", config, items }).payload;
  assert.deepEqual(payload([{ ...item, value: "demo-token" }]), { jiraToken: "demo-token" });
  assert.deepEqual(payload([{ ...item, value: "demo-token", denied: true }]), { jiraAuthState: "tokenDenied" });
  assert.deepEqual(payload([]), { jiraAuthState: "tokenMissing" });
  // Both stop the refresh before fetch.mjs runs; only a denied read offers Back to board.
  const reload = methodSource(readFileSync(new URL("./SprintBoard.swift", import.meta.url), "utf8"), "reload");
  assert.match(reload, /case "tokenMissing":\n\s*self\.requireLogin\("[^"]+"\)\n\s*return/);
  assert.match(reload, /case "tokenDenied":\n\s*self\.requireLogin\("[^"]+",\n\s*canGoBack: true\)\n\s*return/);
});

test("token payload: with Atlassian sign-in, a refused read keeps the session and a missing token ends it", { skip: !swiftAvailable }, () => {
  const config = { email: "ada@example.invalid", tokensOwnedByApp: true, authMode: "oauth" };
  const item = { service: "sprint-board-jira-oauth", account: "ada@example.invalid", value: "demo-refresh" };
  const payload = (items) => appRun({ op: "payload", config, items }).payload;
  assert.deepEqual(payload([{ ...item, denied: true }]), { jiraAuthState: "tokenDenied" });
  assert.deepEqual(payload([]), { jiraAuthState: "needsLogin" });
  assert.deepEqual(payload([item]), { jiraAuthState: "temporary" }, "a readable token goes on to the refresh");
});

test("needsSetup: tells whether someone is signed in without reading a secret", { skip: !swiftAvailable }, () => {
  const email = "ada@example.invalid";
  const has = (service, extra = {}) => [{ service, account: email, value: "x", ...extra }];
  const cases = [
    [null, [], true],
    [{ email: "you@company.com" }, [{ service: "sprint-board-jira", account: "you@company.com", value: "x" }], true],
    [{ email }, has("sprint-board-jira"), false],
    [{ email }, [], true],
    [{ email }, has("sprint-board-jira", { denied: true }), false],
    [{ email, keychainService: "custom-service" }, has("custom-service"), false],
    [{ email, keychainService: "custom-service" }, has("sprint-board-jira"), true],
    [{ email, authMode: "oauth" }, has("sprint-board-jira-oauth"), false],
    [{ email, authMode: "oauth" }, has("sprint-board-jira"), true],
  ];
  const out = appRun({ op: "needsSetup", cases: cases.map(([config, items]) => ({ config, items })) });
  assert.deepEqual(out.needsSetup, cases.map((c) => c[2]));
  assert.equal(out.reads, 0, "no secret is read, so macOS shows no permission dialog");
});

test("Open Insecure Chrome: a Chrome running without the flags is left alone; otherwise Chrome starts with them", { skip: !swiftAvailable }, async () => {
  const flags = hostsOne({ op: "insecureFlags" });
  const idle = "setInterval(() => {}, 1000)";
  const plain = spawn(process.execPath, ["-e", idle], { stdio: "ignore" });
  const flagged = spawn(process.execPath, ["-e", idle, "--", ...flags], { stdio: "ignore" });
  try {
    await Promise.all([once(plain, "spawn"), once(flagged, "spawn")]);
    const gone = spawnSync("/usr/bin/true").pid;
    const [notRunning, withoutFlags, withFlags, quit, missing] = appRun({ op: "openChrome", cases: [
      {}, { pid: plain.pid }, { pid: flagged.pid }, { pid: gone }, { installed: false },
    ] }).results;
    assert.deepEqual(notRunning, { launches: [flags], notes: [null] });
    assert.deepEqual(withoutFlags.launches, []);
    assert.equal(withoutFlags.notes.length, 1);
    assert.ok(withoutFlags.notes[0].startsWith(`Chrome is already open without ${flags.join(" ")}: quit it (⌘Q)`), withoutFlags.notes[0]);
    assert.deepEqual(withFlags, { launches: [flags], notes: [null] });
    // ps answers nothing for a process that is gone: Chrome quit meanwhile, so it starts.
    assert.deepEqual(quit, { launches: [flags], notes: [null] });
    assert.deepEqual(missing, { launches: [], notes: ["Google Chrome is not installed."] });
  } finally {
    plain.kill();
    flagged.kill();
  }
});

test("Chrome refresh: a burst of switches refreshes Chrome once", { skip: !swiftAvailable }, () => {
  assert.deepEqual(appRun({ op: "chromeBurst" }).refreshes, [1, 2]);
});

test("hosts.html trims a domain and a partner name as Swift does, invisible characters included", { skip: !swiftAvailable }, () => {
  const { hostName, partnerName } = pageChecks();
  const domains = ["\u0085app.example.test\u0085", "app.example.test\ufeff",
    "\u2028app.example.test\u2029", "\u00a0app.example.test\u3000", "\u000bapp.example.test\u000c"];
  assert.deepEqual(domains.map(hostName), hostsRun(domains.map((raw) => ({ op: "name", raw }))));
  const partners = ["\u0085demoshop\u0085", "\u00a0demoshop\u2029"];
  assert.deepEqual(partners.map(partnerName), hostsRun(partners.map((raw) => ({ op: "partnerName", raw }))));
});

test("Hosts tab: an action Swift refused stays refused after its error moves under the field", () => {
  const page = readFileSync(new URL("./popover/hosts.html", import.meta.url), "utf8");
  const draw = page.slice(page.indexOf("  function draw(s) {"), page.indexOf("  function fitChips() {"));
  const kept = draw.indexOf("const refused = Boolean(s.error);");
  assert.ok(kept >= 0 && kept < draw.indexOf("if (s.error) { fieldError = s.error; s = { ...s, error: null }; }"));
  // Nothing after it reads the error that was moved: the field keeps the text, no group is picked or carried over.
  assert.equal((draw.match(/!s\.error/g) || []).length, 0);
  assert.equal((draw.match(/!refused/g) || []).length, 4);
  assert.match(draw, /else if \(fieldEl && adding && !refused && !bulk\) fieldEl\.value = "";/);
});

test("board page: the refresh button keeps spinning through redraws until the result arrives", () => {
  const page = readFileSync(new URL("./popover/sprints.html", import.meta.url), "utf8");
  assert.match(page, /if \(refreshing\) return;[^\n]*\n\s*refreshing = true;\n\s*el\.classList\.add\("spin"\);\n\s*post\(\{ refresh: true \}\);/);
  assert.match(page, /`;\n\s*if \(refreshing\) card\.querySelector\("#rf"\)\.classList\.add\("spin"\);/);
  assert.match(page, /window\.sbRender = \(d\) => \{\n\s*clearInterval\(waitTimer\);\n\s*refreshing = false;/);
});
