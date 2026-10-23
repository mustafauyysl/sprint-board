import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  goalBand,
  withGoalMarks,
  conflictIds,
  newConflicts,
  conflictNotifications,
  refreshSummary,
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
  const view = readFileSync(new URL("./view.html", import.meta.url), "utf8");
  assert.equal(Number(swift.match(/^let NOTE_LIMIT = (\d+)$/m)?.[1]), NOTE_LIMIT);
  assert.equal(Number(view.match(/class="ninput"[^>]*maxlength="(\d+)"/)?.[1]), NOTE_LIMIT,
    "typing must stop where saving would cut");
});

test("setup screen: a transparent page around a card panel, sized to the card, as on the board", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const [name, page, height] of [
    ["view.html", read("./view.html"), /postMessage\(\{ height: card\.offsetHeight \}\)/],
    ["setup.html", read("./setup.html"), /post\(\{ height: \$\("card"\)\.offsetHeight \}\)/],
  ]) {
    // A background on <body> paints the whole square window; the rounded panel needs its own element.
    assert.match(page, /html, body \{[^}]*background: transparent/, name);
    assert.match(page, /<div id="card">/, name);
    assert.match(page, height, `${name} reports the card's height`);
    assert.doesNotMatch(page, /scrollHeight \+/, name);
  }
});

test("both screens: one card radius, and no shadow outside the card", () => {
  const card = (f) => readFileSync(new URL(f, import.meta.url), "utf8").match(/#card \{([^}]*)\}/)?.[1] ?? "";
  const [view, setup] = [card("./view.html"), card("./setup.html")];
  const radius = (css) => css.match(/border-radius: ?([^;]+);/)?.[1];
  assert.equal(radius(view), "10px");
  assert.equal(radius(setup), radius(view));
  // The window is cut exactly to the card, so an outer shadow can only show in the corners
  // outside the curve, as a dark tip with a square edge. Only an inset shadow is allowed.
  for (const [name, css] of [["view.html", view], ["setup.html", setup]]) {
    const shadow = css.match(/box-shadow: ?([^;]+);/)?.[1] ?? "";
    for (const layer of shadow.split(/,(?![^(]*\))/).filter((l) => l.trim())) {
      assert.match(layer, /\binset\b/, `${name}: outer shadow "${layer.trim()}"`);
    }
  }
});

test("both screens: the window material is rounded with the card's radius", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const swift = Number(read("./SprintBoard.swift").match(/^let CARD_RADIUS: CGFloat = (\d+)$/m)?.[1]);
  assert.ok(swift > 0, "CARD_RADIUS not found");
  for (const f of ["./view.html", "./setup.html"]) {
    const css = read(f).match(/#card \{([^}]*)\}/)?.[1] ?? "";
    assert.equal(css.match(/border-radius: ?([^;]+);/)?.[1], `${swift}px`, f);
  }
});

test("both screens: the same panel colours and window buttons", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  // Tokens per scheme ("light" before the dark media query, "dark" inside it) and selector.
  const tokens = (page) => {
    const [light, dark] = page.split("@media (prefers-color-scheme: dark)");
    assert.ok(dark !== undefined, "no dark media query");
    const out = {};
    for (const [scheme, css] of [["light", light], ["dark", dark.slice(0, dark.indexOf("\n  }"))]]) {
      for (const [, sel, body] of css.matchAll(/(:root(?:\.glass)?) \{([^}]*)\}/g)) {
        for (const [, name, value] of body.matchAll(/(--[\w-]+): ?([^;}]+?)\s*(?:;|$)/g)) {
          out[`${scheme} ${sel} ${name}`] = value;
        }
      }
    }
    return out;
  };
  const buttons = (page) => Object.fromEntries([...page.matchAll(/(?:\.hdr )?(\.tl[\w.:-]*) \{([^}]*)\}/g)]
    .map(([, sel, body]) => [sel, body.replace(/\s+/g, " ").replace(/\s*([:;])\s*/g, "$1").trim()]));
  const [view, setup] = [read("./view.html"), read("./setup.html")];
  const [tv, ts] = [tokens(view), tokens(setup)];
  for (const key of ["light :root --panel", "light :root --fill",
    "dark :root --panel", "dark :root --fill"]) {
    assert.ok(key in tv && key in ts, `${key} missing`);
  }
  for (const key of Object.keys(ts).filter((k) => k in tv)) assert.equal(ts[key], tv[key], key);
  const [bv, bs] = [buttons(view), buttons(setup)];
  assert.deepEqual(Object.keys(bv).sort(), [".tl", ".tl.close", ".tl.fill", ".tl.min", ".tl:hover"]);
  assert.deepEqual(bs, bv);
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

test("goalRisk: a goal task is not coloured in the first week (day 7)", () => {
  assert.equal(goalRisk(at("2026-08-16"), goalStart, goalEnd, { key: "indeterminate" }), "ok");
});

test("goalRisk: from day 8 an open goal task is yellow", () => {
  assert.equal(goalRisk(at("2026-08-17"), goalStart, goalEnd, { key: "indeterminate" }), "yellow");
});

test("goalRisk: the 4th business day before the end is still yellow", () => {
  assert.equal(goalRisk(at("2026-08-18"), goalStart, goalEnd, { key: "new" }), "yellow");
});

test("goalRisk: the 3rd business day before the end is red, across the weekend", () => {
  assert.equal(goalRisk(at("2026-08-19"), goalStart, goalEnd, { key: "new" }), "red");
  assert.equal(goalRisk(at("2026-08-21"), goalStart, goalEnd, { key: "new" }), "red");
  assert.equal(goalRisk(at("2026-08-26"), goalStart, goalEnd, { key: "new" }), "red", "after the end it stays red");
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
    key: "DEMO-2", summary: "DEMO-2 summary", owner: "Ada Yilmaz", status: "In Progress",
    risk: "red", url: "https://example.invalid/browse/DEMO-2",
  });
});

test("goalBand: an unassigned goal task and a sprint with no goal tasks", () => {
  const one = goalBand([goalIssue("DEMO-3", "new", { assignee: null })],
    [goalSprint], at("2026-08-12"), "example.invalid", "customfield_1");
  assert.equal(one.rows[0].owner, null);
  assert.equal(one.worst, "ok");
  const none = goalBand([], [goalSprint], at("2026-08-12"), "example.invalid", "customfield_1");
  assert.deepEqual([none.done, none.total, none.worst, none.rows], [0, 0, "ok", []]);
});

test("withGoalMarks: my task that is also a goal task gets the GOAL mark", () => {
  const tasks = withGoalMarks([{ key: "DEMO-1" }, { key: "DEMO-2" }], { rows: [{ key: "DEMO-2" }] });
  assert.deepEqual(tasks.map((t) => t.goal), [false, true]);
  assert.deepEqual(withGoalMarks([{ key: "DEMO-1" }], null).map((t) => t.goal), [false]);
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
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === "api.github.com") return json({ data: { search: { nodes: [] } } });
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

function runReal(cfg, searches) {
  const home = mkdtempSync(join(tmpdir(), "sprint-board-real-"));
  try {
    mkdirSync(join(home, ".config", "sprint-widget"), { recursive: true });
    writeFileSync(join(home, ".config", "sprint-widget", "config.json"), JSON.stringify(cfg));
    writeFileSync(join(home, "fake.mjs"), FAKE_FETCH);
    writeFileSync(join(home, "fake.json"), JSON.stringify({ searches }));
    const out = execFileSync(process.execPath,
      ["--import", join(home, "fake.mjs"), fileURLToPath(new URL("./fetch.mjs", import.meta.url))],
      { env: { ...process.env, HOME: home, SB_FAKE_JIRA: join(home, "fake.json") },
        input: JSON.stringify({ jiraToken: "demo-token", githubToken: "demo-token" }), encoding: "utf8" });
    let jql = "";
    try { jql = readFileSync(join(home, "fake.json.jql"), "utf8"); } catch { /* no search made */ }
    return { out: JSON.parse(out), jql: jql.split("\n").filter(Boolean) };
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
  assert.deepEqual(out.sprintGoal.rows.map((r) => r.risk), ["red", "yellow", "done"]);
  assert.equal(out.sprintGoal.worst, "red");
  assert.deepEqual([out.sprintGoal.done, out.sprintGoal.total], [1, 3]);
  assert.deepEqual(out.tasks.filter((t) => t.goal).map((t) => t.key), ["DEMO-102"]);
});

test("--demo: with Show draft PRs off the draft leaves the band", () => {
  const out = runDemo({ host: "example.invalid", showDraftPrs: false });
  assert.deepEqual(out.pullRequests.map((r) => r.repo),
    ["editor-frontend", "web-frontend", "worker-jobs", "shared-lib", "template-generator"]);
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
  token: { email: "ada@example.invalid", authMode: "token", tokensOwnedByApp: true, showDraftPrs: false, sprintGoalTracking: true },
  handMade: { email: "ada@example.invalid", keychainService: "sprint-board-jira" },
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
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["hosts": hosts, "services": services, "orgs": orgs, "notes": notes, "dock": dock, "contexts": contexts]))
`;
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-swift-"));
  try {
    writeFileSync(join(dir, "main.swift"), driver);
    execFileSync("swiftc", [join(dir, "main.swift"), "-o", join(dir, "helpers")], { stdio: "pipe" });
    const out = JSON.parse(
      execFileSync(join(dir, "helpers"), { input: JSON.stringify({ hosts: hostInputs, configs: configInputs, orgs: orgInputs, results: resultInputs, setups: setupInputs }) }),
    );
    swiftCache = {
      host: Object.fromEntries(hostInputs.map((h, i) => [h, out.hosts[i]])),
      service: out.services,
      org: Object.fromEntries(orgInputs.map((o, i) => [o, out.orgs[i]])),
      notes: out.notes,
      dock: out.dock,
      contexts: out.contexts,
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
