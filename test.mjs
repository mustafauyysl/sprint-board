import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessDaysBetween,
  evaluate,
  pickBoss,
  bolts,
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
  sprintHistory,
  ownershipStartedAt,
  emptyState,
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

test("pickBoss: picks by RATIO, not by day count", () => {
  const tasks = [
    { key: "A", daysInStatus: 8, threshold: 7, ratio: 8 / 7, alert: true },
    { key: "B", daysInStatus: 4, threshold: 2, ratio: 2, alert: true },
  ];
  assert.equal(pickBoss(tasks).key, "B", "fewer days but a higher ratio");
});

test("pickBoss: null when nothing is over threshold", () => {
  assert.equal(pickBoss([{ key: "A", alert: false, ratio: 0.5, daysInStatus: 1 }]), null);
  assert.equal(pickBoss([]), null);
});

test("pickBoss: a closed task cannot be the boss", () => {
  const tasks = [{ key: "A", alert: true, ratio: 9, daysInStatus: 30, done: true }];
  assert.equal(pickBoss(tasks), null);
});

// --- ownershipStartedAt ---------------------------------------------------
// The clock belongs to the PERSON, not to the ticket: a card that rotted
// unassigned for weeks must not land on its new owner as a boss alert.

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
  // 1 day in To Do (threshold 7) is not an alert; 24 would have been the boss.
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

test("bolts: stays within 1-5", () => {
  assert.equal(bolts(0.5), 1);
  assert.equal(bolts(3.7), 3);
  assert.equal(bolts(99), 5);
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

test("summarizePrs: a PR without a key is skipped, empty input does not crash", () => {
  const r = summarizePrs([{ title: "chore: bump", ciState: "FAILURE" }]);
  assert.deepEqual(r.byKey, {});
  assert.equal(r.broken.length, 0);
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
  const n = addNote([], "x".repeat(500), at("2026-08-20"));
  assert.equal(n[0].text.length, 140);
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
  const now = { bossKey: "DEMO-1", brokenIds: ["a#1"], reviewIds: ["b#2"] };
  assert.deepEqual(detectAlerts(emptyState(), now), [], "existing items must stay silent at launch");
  assert.deepEqual(detectAlerts(null, now), []);
});

test("detectAlerts: a new boss sounds, the same boss does not sound again", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: "DEMO-1", brokenIds: [], reviewIds: [] }), ["boss"]);
  const same = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(same, { bossKey: "DEMO-1", brokenIds: [], reviewIds: [] }), []);
});

test("detectAlerts: a changed boss sounds again", () => {
  const prev = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: "DEMO-2", brokenIds: [], reviewIds: [] }), ["boss"]);
});

test("detectAlerts: a boss disappearing makes no sound", () => {
  const prev = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: [], reviewIds: [] }), []);
});

test("detectAlerts: only NEW broken CI sounds", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: ["cs#1"], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: ["cs#1"], reviewIds: [] }), [],
    "an already-known breakage does not sound again");
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: ["cs#1", "shared-lib#2"], reviewIds: [] }), ["ci"]);
});

test("detectAlerts: a new review request sounds", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: [], reviewIds: ["r#1"] };
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: [], reviewIds: ["r#1", "r#2"] }), ["review"]);
});

test("detectAlerts: several events are reported together", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: [], reviewIds: [] };
  const now = { bossKey: "DEMO-9", brokenIds: ["a#1"], reviewIds: ["b#2"] };
  assert.deepEqual(detectAlerts(prev, now), ["boss", "ci", "review"]);
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
