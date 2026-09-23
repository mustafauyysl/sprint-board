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
  validateSetup,
  compareVersions,
  updateInfo,
  jiraRequest,
  BIN_DIRS,
  addNote,
  removeNote,
  MAX_NOTES,
  sprintHistory,
  emptyState,
} from "./lib.mjs";

const config = {
  defaultThresholdDays: 5,
  thresholds: { "To Do": 7, "In Code Review": 2, "Ready To Test": 3 },
};

const at = (iso) => new Date(`${iso}T12:00:00`);
// Referans günler: 08-14 Cuma · 08-17 Pzt · 08-19 Çar · 08-20 Per · 08-21 Cum · 08-24 Pzt

test("businessDaysBetween: hafta sonunu atlar", () => {
  assert.equal(businessDaysBetween(at("2026-08-14"), at("2026-08-17")), 1, "Cuma->Pazartesi 1 iş günü");
  assert.equal(businessDaysBetween(at("2026-08-21"), at("2026-08-24")), 1);
});

test("businessDaysBetween: aynı gün 0, geriye doğru 0", () => {
  assert.equal(businessDaysBetween(at("2026-08-20"), at("2026-08-20")), 0);
  assert.equal(businessDaysBetween(at("2026-08-20"), at("2026-08-17")), 0);
});

test("businessDaysBetween: hafta içi ve tam hafta", () => {
  assert.equal(businessDaysBetween(at("2026-06-01"), at("2026-06-05")), 4, "Pzt->Cum");
  assert.equal(businessDaysBetween(at("2026-06-01"), at("2026-06-08")), 5, "Pzt->Pzt tam hafta");
});

test("businessDaysBetween: uzun aralık canlı ölçüm", () => {
  // 16 Tem Per -> 20 Ağu Per = 5 tam hafta = 25 iş günü
  assert.equal(businessDaysBetween(at("2026-07-16"), at("2026-08-20")), 25);
});

test("evaluate: tam sınırda henüz yanmaz", () => {
  assert.equal(evaluate("In Code Review", 2, config).alert, false, "days === threshold yanmaz");
  assert.equal(evaluate("In Code Review", 3, config).alert, true);
});

test("evaluate: bilinmeyen statü default eşiğe düşer", () => {
  const r = evaluate("Bilinmeyen Statü", 6, config);
  assert.equal(r.threshold, 5);
  assert.equal(r.alert, true);
});

test("evaluate: iki kat aşım critical", () => {
  assert.equal(evaluate("In Code Review", 3, config).tier, "warn");
  assert.equal(evaluate("In Code Review", 4, config).tier, "critical");
  assert.equal(evaluate("In Code Review", 1, config).tier, "ok");
});

test("evaluate: sıfır tolerans eşiği oranı çökertmez", () => {
  const zero = { ...config, thresholds: { "Ready To Test": 0 } };
  assert.equal(evaluate("Ready To Test", 0, zero).alert, false);
  const r = evaluate("Ready To Test", 3, zero);
  assert.equal(r.alert, true);
  assert.equal(r.ratio, 3, "payda 1'e sabitlenmeli, oran 0 olmamalı");
  assert.equal(r.tier, "critical");
});

test("pickBoss: gün sayısını değil ORANI seçer", () => {
  const tasks = [
    { key: "A", daysInStatus: 8, threshold: 7, ratio: 8 / 7, alert: true },
    { key: "B", daysInStatus: 4, threshold: 2, ratio: 2, alert: true },
  ];
  assert.equal(pickBoss(tasks).key, "B", "daha az gün ama daha yüksek oran");
});

test("pickBoss: eşiği aşan yoksa null", () => {
  assert.equal(pickBoss([{ key: "A", alert: false, ratio: 0.5, daysInStatus: 1 }]), null);
  assert.equal(pickBoss([]), null);
});

test("pickBoss: kapanmış task boss olamaz", () => {
  const tasks = [{ key: "A", alert: true, ratio: 9, daysInStatus: 30, done: true }];
  assert.equal(pickBoss(tasks), null);
});

test("sprintHistory: sadece aktif sprint = devretmemiş", () => {
  const r = sprintHistory([{ name: "S#4", state: "active" }]);
  assert.deepEqual(r, { carriedOver: false, closedSprints: 0, sprintCount: 1 });
});

test("sprintHistory: kapalı + aktif = devretmiş canlı ölçüm", () => {
  const r = sprintHistory([
    { name: "Demo Takım - Sprint#3", state: "closed" },
    { name: "Demo Takım - Sprint#4", state: "active" },
  ]);
  assert.equal(r.carriedOver, true);
  assert.equal(r.sprintCount, 2, "×2 rozeti");
});

test("sprintHistory: future sprint devretme saymaz", () => {
  const r = sprintHistory([
    { name: "S#4", state: "active" },
    { name: "S#5", state: "future" },
  ]);
  assert.equal(r.carriedOver, false);
  assert.equal(r.sprintCount, 1, "planlanmış gelecek sprint sayaca girmemeli");
});

test("sprintHistory: iki kez devretmiş", () => {
  const r = sprintHistory([
    { state: "closed" }, { state: "closed" }, { state: "active" },
  ]);
  assert.equal(r.closedSprints, 2);
  assert.equal(r.sprintCount, 3);
});

test("sprintHistory: alan boş/eksikse çökmez", () => {
  assert.deepEqual(sprintHistory(null), { carriedOver: false, closedSprints: 0, sprintCount: 0 });
  assert.deepEqual(sprintHistory([]), { carriedOver: false, closedSprints: 0, sprintCount: 0 });
  assert.equal(sprintHistory([null, undefined]).carriedOver, false);
});

test("bolts: 1-5 arasında kalır", () => {
  assert.equal(bolts(0.5), 1);
  assert.equal(bolts(3.7), 3);
  assert.equal(bolts(99), 5);
});

test("requiredRollup: opsiyonel fail uyarı üretmez canlı ölçüm", () => {
  const r = requiredRollup([
    { name: "check-sql-change", conclusion: "FAILURE", isRequired: false },
    { context: "AI Code Review", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "SUCCESS", "kırık check required değilse merge bloke değil");
  assert.deepEqual(r.failing, []);
});

test("requiredRollup: required fail yakalanır ve adı verilir", () => {
  const r = requiredRollup([
    { name: "ESLintChecker", conclusion: "FAILURE", isRequired: true },
    { name: "Jest", conclusion: "FAILURE", isRequired: false },
    { context: "qa/smoke", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "FAILURE");
  assert.deepEqual(r.failing, ["ESLintChecker"], "sadece required olan raporlanır");
  assert.equal(r.requiredCount, 2);
});

test("requiredRollup: canlı ölçüm — required'lar geçmiş", () => {
  const r = requiredRollup([
    { name: "pandora_functional_tests_pipeline", conclusion: "FAILURE", isRequired: false },
    { context: "AWS CodeBuild (RUNNER-ai-test-coverage)", state: "FAILURE", isRequired: false },
    { name: "coverage / AI Test Coverage", conclusion: "CANCELLED", isRequired: false },
    { name: "ESLintChecker", conclusion: "SUCCESS", isRequired: true },
    { context: "AI Code Review", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "SUCCESS");
  assert.equal(r.failing.length, 0);
});

test("requiredRollup: bekleyen required PENDING verir ama fail listesine girmez", () => {
  const r = requiredRollup([
    { name: "build", conclusion: null, isRequired: true },
    { context: "smoke", state: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "PENDING");
  assert.deepEqual(r.failing, []);
  assert.deepEqual(r.pending, ["build"], "bekleyen check adı ayrı listede");
});

test("requiredRollup: bekleyenler adıyla toplanır canlı ölçüm", () => {
  const r = requiredRollup([
    { name: "ESLintChecker", conclusion: "SUCCESS", isRequired: true },
    { context: "AI Code Review", state: "PENDING", isRequired: true },
    { context: "AI Test Analyzer", state: "SUCCESS", isRequired: true },
    { name: "Jest", conclusion: "FAILURE", isRequired: false },
  ]);
  assert.equal(r.state, "PENDING");
  assert.deepEqual(r.pending, ["AI Code Review"]);
  assert.deepEqual(r.failing, [], "opsiyonel Jest hatası sayılmaz");
});

test("releaseState: Released on Prod ve Done bitmiş sayılır", () => {
  // "Done" da bitmiş demek — canlıya çıkmayı bekleyenler arasında sayılmaz.
  assert.equal(releaseState("Released on Prod", {}), "finished");
  assert.equal(releaseState("Done", {}), "finished");
});

test("releaseState: TANIMASIZ done statüsü 'finished'e düşer, pending'e DEĞİL", () => {
  // Asıl tuzak: liste "bitmişler" olsaydı, tanınmayan her statü sonsuza dek
  // "canlıya çıkmayı bekliyor" görünürdü. Bu Jira'da 6 statü böyleydi
  // (Closed, Resolved, Problem Solved, Epic is Done, Question, Unresolved).
  for (const st of ["Closed", "Resolved", "Problem Solved", "Epic is Done",
                    "Question", "Unresolved", "Fixed", "Duplicate", "Bilinmeyen Statü"]) {
    assert.equal(releaseState(st, {}), "finished", st);
  }
});

test("releaseState: release bekleyen done statüleri 'pending'", () => {
  // Jira'da SD projesinin done kategorisinde 15 statü var; bir kısmı
  // "iş bitti ama daha prod'a çıkmadı" demek — üstü çizilmemeli.
  for (const st of ["Ready For Release", "Awaiting Release", "Pending for Release",
                    "Waiting for Release", "Waiting for SDK Release"]) {
    assert.equal(releaseState(st, {}), "pending", st);
  }
});

test("releaseState: iptal/reddedilen ayrı — bekleyen değil", () => {
  assert.equal(releaseState("Rejected", {}), "cancelled");
  assert.equal(releaseState("Cancelled", {}), "cancelled");
});

test("releaseState: eşleşme büyük/küçük harf ve boşluğa duyarsız", () => {
  assert.equal(releaseState("  released on prod ", {}), "finished");
});

test("releaseState: bekleyen statü listesi config'ten genişletilebilir", () => {
  const cfg = { pendingReleaseStatuses: ["Ready For Release", "Monitoring"] };
  assert.equal(releaseState("Monitoring", cfg), "pending");
  assert.equal(releaseState("Monitoring", {}), "finished");   // varsayılanda değil
});

test("releaseState: config'e dizi yerine tek metin yazılırsa varsayılana düşer", () => {
  // Elle düzenlenen config.json'da `"finishedStatuses": "Released on Prod"` yazmak
  // .some'u patlatıp TÜM payload'ı düşürüyordu — widget hata ekranında kalıyordu.
  assert.equal(releaseState("Ready For Release", { pendingReleaseStatuses: "Ready For Release" }), "pending");
  assert.equal(releaseState("Released on Prod", { pendingReleaseStatuses: 42 }), "finished");
});

test("releaseState: statü yoksa finished'e düşer (fail-closed), patlamaz", () => {
  assert.equal(releaseState(null, {}), "finished");
  assert.equal(releaseState(undefined, undefined), "finished");
});

test("prBlockers: CI temiz ama review bekliyorsa PR yine engelli (asıl vaka)", () => {
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED" });
  assert.equal(r.rank, 2, "required check'ler geçse de merge edilemez");
  assert.deepEqual(r.reasons, ["review bekliyor"]);
});

test("prBlockers: conflict merge'i engeller (CI temiz, review onaylı olsa bile)", () => {
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: "APPROVED", mergeable: "CONFLICTING" });
  assert.equal(r.rank, 3);
  assert.ok(r.reasons.some((x) => x.includes("conflict")));
});

test("prBlockers: mergeable UNKNOWN conflict SAYILMAZ (GitHub tembel hesaplıyor)", () => {
  // Canlı ölçüm: 15 PR'ın 3'ü ilk sorguda UNKNOWN, ikinci sorguda MERGEABLE döndü.
  // UNKNOWN'ı conflict saymak doğrudan yanlış alarm olurdu.
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: null, mergeable: "UNKNOWN" });
  assert.deepEqual(r, { rank: 0, reasons: [] });
});

test("prBlockers: mergeable alanı hiç yoksa (eski veri) engel üretmez", () => {
  assert.deepEqual(prBlockers({ ciState: "SUCCESS", reviewDecision: null }),
                   { rank: 0, reasons: [] });
});

test("prBlockers: conflict + kırık CI birlikte, ikisi de sebep listesinde", () => {
  const r = prBlockers({ ciState: "FAILURE", failingRequired: ["build"],
                         reviewDecision: null, mergeable: "CONFLICTING" });
  assert.equal(r.rank, 3);
  assert.equal(r.reasons.length, 2);
});

test("prBlockers: review gerekmiyorsa (null) engel yok", () => {
  assert.deepEqual(prBlockers({ ciState: "SUCCESS", reviewDecision: null }),
    { rank: 0, reasons: [] });
  assert.equal(prBlockers({ ciState: "SUCCESS", reviewDecision: "APPROVED" }).rank, 0);
});

test("prBlockers: changes requested aksiyon gerektirir (rank 3)", () => {
  const r = prBlockers({ ciState: "SUCCESS", reviewDecision: "CHANGES_REQUESTED" });
  assert.equal(r.rank, 3);
  assert.deepEqual(r.reasons, ["değişiklik istendi"]);
});

test("prBlockers: CI ve review birlikte engelliyse ikisi de listelenir", () => {
  const r = prBlockers({
    ciState: "FAILURE", failingRequired: ["ESLintChecker"],
    reviewDecision: "REVIEW_REQUIRED",
  });
  assert.equal(r.rank, 3, "en ağır engel kazanır");
  assert.deepEqual(r.reasons, ["CI: ESLintChecker", "review bekliyor"]);
});

test("prBlockers: CI beklerken review onaylıysa yine bekleme", () => {
  const r = prBlockers({
    ciState: "PENDING", pendingRequired: ["AI Code Review"], reviewDecision: "APPROVED",
  });
  assert.equal(r.rank, 2);
  assert.deepEqual(r.reasons, ["CI: AI Code Review"]);
});

test("summarizePrs: engelsiz PR durumsuz kalmaz (rank 0 tuzağı)", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-5 | a", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "r", number: 1 },
  ]);
  assert.equal(byKey["DEMO-5"].state, "SUCCESS", "engel yoksa yeşil görünmeli, null değil");
});

test("summarizePrs: aynı rank'te bilinmeyen durum bilinen tarafından doldurulur", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-6 | a", ciState: null, reviewDecision: "APPROVED", repo: "r", number: 1 },
    { title: "DEMO-6 | b", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "r", number: 2 },
  ]);
  assert.equal(byKey["DEMO-6"].state, "SUCCESS");
});

test("summarizePrs: review bekleyen PR taskın rozetini sarıya çeker", () => {
  const { byKey, waiting } = summarizePrs([
    { title: "DEMO-9 | a", ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED", repo: "shared-lib", number: 320 },
  ]);
  assert.equal(byKey["DEMO-9"].state, "PENDING");
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].checks, ["review bekliyor"]);
});

// --- Draft PR'lar: kendi PR'ların arasında aksiyon gerektiriyormuş gibi görünmesin ---
// Canlı ölçüm: 8 açık PR'ın 7'si draft'tı ve 5'i REVIEW_REQUIRED olduğu için BEKLEYEN
// bandını tek başına dolduruyordu — gerçek tek iş aralarında kayboluyordu.

test("summarizePrs: draft PR review beklese bile waiting'e GİRMEZ (asıl vaka)", () => {
  const { waiting } = summarizePrs([
    { title: "DEMO-29638 | mobile-client", ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED",
      isDraft: true, repo: "mobile-client", number: 4384 },
  ]);
  assert.deepEqual(waiting, []);
});

test("summarizePrs: draft PR'ın CI'ı kırıksa bile broken'a GİRMEZ (ses de çalmaz)", () => {
  const { broken } = summarizePrs([
    { title: "DEMO-20 | a", ciState: "FAILURE", failingRequired: ["build"],
      isDraft: true, repo: "shared-lib", number: 1 },
  ]);
  assert.deepEqual(broken, []);
});

test("summarizePrs: draft PR rozette SAYILIR ama durum üretmez (gri kalır)", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-21 | a", ciState: "FAILURE", reviewDecision: "REVIEW_REQUIRED",
      isDraft: true, repo: "shared-lib", number: 1 },
  ]);
  assert.equal(byKey["DEMO-21"].count, 1, "başlamış iş görünmeye devam etmeli");
  assert.equal(byKey["DEMO-21"].state, null, "draft yeşil/sarı/kırmızı hiçbir şey demez");
});

test("summarizePrs: draft + normal PR birlikte — sayı ikisini, durum normali yansıtır", () => {
  const { byKey, waiting } = summarizePrs([
    { title: "DEMO-22 | draft", ciState: "FAILURE", isDraft: true, repo: "shared-lib", number: 1 },
    { title: "DEMO-22 | hazır", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "shared-lib", number: 2 },
  ]);
  assert.equal(byKey["DEMO-22"].count, 2);
  assert.equal(byKey["DEMO-22"].state, "SUCCESS", "draft'ın kırık CI'ı rozeti kırmızıya çekmemeli");
  assert.deepEqual(waiting, []);
});

// Regresyon: durum ataması "ilk PR"ı sayaçla tanıyor. Draft'lar sayacı artırıp
// atamayı atladığı için, listedeki İLK PR draft olduğunda ikinci (gerçek) PR
// durumsuz kalıyordu — rank 0 iken "rank > entry.rank" hiçbir zaman sağlanmıyor.
test("summarizePrs: İLK PR draft'sa sonraki gerçek PR'ın durumu yine de rozete yansır", () => {
  const { byKey } = summarizePrs([
    { title: "DEMO-23 | draft", ciState: "SUCCESS", isDraft: true, repo: "shared-lib", number: 1 },
    { title: "DEMO-23 | hazır", ciState: "SUCCESS", reviewDecision: "APPROVED", repo: "shared-lib", number: 2 },
  ]);
  assert.equal(byKey["DEMO-23"].state, "SUCCESS", "draft öne geçince gerçek PR durumsuz kalmamalı");
});

test("summarizePrs: bekleyen PR waiting listesine düşer, kırık olan broken'a", () => {
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

test("requiredRollup: yeniden çalıştırılan check'te SON run sayılır canlı ölçüm", () => {
  const r = requiredRollup([
    { name: "ESLintChecker", conclusion: "CANCELLED", isRequired: true, completedAt: "2026-08-20T09:00:00Z" },
    { name: "pr-linter", conclusion: "CANCELLED", isRequired: true, completedAt: "2026-08-20T09:00:00Z" },
    { name: "ESLintChecker", conclusion: "SUCCESS", isRequired: true, completedAt: "2026-08-20T11:00:00Z" },
    { name: "pr-linter", conclusion: "SUCCESS", isRequired: true, completedAt: "2026-08-20T11:00:00Z" },
  ]);
  assert.equal(r.state, "SUCCESS", "iptal edilmiş eski run kırık sayılmamalı");
  assert.deepEqual(r.failing, []);
  assert.equal(r.requiredCount, 2, "aynı check iki kez sayılmamalı");
});

test("requiredRollup: zaman yoksa listede sonra gelen güncel kabul edilir", () => {
  const r = requiredRollup([
    { name: "build", conclusion: "CANCELLED", isRequired: true },
    { name: "build", conclusion: "SUCCESS", isRequired: true },
  ]);
  assert.equal(r.state, "SUCCESS");
});

test("requiredRollup: son run GERÇEKTEN kırıksa yakalanır", () => {
  const r = requiredRollup([
    { name: "build", conclusion: "SUCCESS", isRequired: true, completedAt: "2026-08-20T09:00:00Z" },
    { name: "build", conclusion: "FAILURE", isRequired: true, completedAt: "2026-08-20T11:00:00Z" },
  ]);
  assert.equal(r.state, "FAILURE", "sonraki run kırıksa uyarı verilmeli");
  assert.deepEqual(r.failing, ["build"]);
});

test("requiredRollup: CANCELLED required de fail sayılır", () => {
  const r = requiredRollup([{ name: "build", conclusion: "CANCELLED", isRequired: true }]);
  assert.equal(r.state, "FAILURE");
  assert.deepEqual(r.failing, ["build"]);
});

test("requiredRollup: hiç required yoksa durum bilinmiyor (null), uyarı yok", () => {
  assert.deepEqual(requiredRollup([{ name: "x", conclusion: "FAILURE", isRequired: false }]),
    { state: null, failing: [], pending: [], requiredCount: 0 });
  assert.deepEqual(requiredRollup([]), { state: null, failing: [], pending: [], requiredCount: 0 });
  assert.deepEqual(requiredRollup(null), { state: null, failing: [], pending: [], requiredCount: 0 });
});

test("extractIssueKey: PR başlığından anahtarı çıkarır", () => {
  assert.equal(extractIssueKey("DEMO-146311 | Gate app-template Liquid"), "DEMO-146311");
  assert.equal(extractIssueKey("[ DONT MERGE ] -  DEMO-29095 | Point brotherhood"), "DEMO-29095");
  assert.equal(extractIssueKey("chore: bump deps"), null);
  assert.equal(extractIssueKey(null), null);
});

test("summarizePrs: bir PR kırıksa taskın rozeti kırık olur", () => {
  const { byKey, broken } = summarizePrs([
    { title: "DEMO-146311 | a", ciState: "SUCCESS", repo: "def", number: 327 },
    { title: "DEMO-146311 | b", ciState: "FAILURE", repo: "web-frontend", number: 4608 },
    { title: "DEMO-146311 | c", ciState: "SUCCESS", repo: "shared-lib", number: 320 },
  ]);
  assert.equal(byKey["DEMO-146311"].count, 3);
  assert.equal(byKey["DEMO-146311"].state, "FAILURE", "en kötü durum kazanır");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].repo, "web-frontend");
});

test("summarizePrs: PENDING, SUCCESS'i ezer ama FAILURE'ı ezemez", () => {
  const a = summarizePrs([
    { title: "AB-1 | a", ciState: "SUCCESS" }, { title: "AB-1 | b", ciState: "PENDING" },
  ]);
  assert.equal(a.byKey["AB-1"].state, "PENDING");
  const b = summarizePrs([
    { title: "AB-1 | a", ciState: "PENDING" }, { title: "AB-1 | b", ciState: "FAILURE" },
  ]);
  assert.equal(b.byKey["AB-1"].state, "FAILURE");
});

test("summarizePrs: anahtarsız PR atlanır, boş girdi çökmez", () => {
  const r = summarizePrs([{ title: "chore: bump", ciState: "FAILURE" }]);
  assert.deepEqual(r.byKey, {});
  assert.equal(r.broken.length, 0);
  assert.deepEqual(summarizePrs(null), { byKey: {}, broken: [], waiting: [] });
});

test("summarizePrs: bilinmeyen/null CI durumu sayıyı bozmaz", () => {
  const r = summarizePrs([{ title: "AB-1 | a", ciState: null }]);
  assert.equal(r.byKey["AB-1"].count, 1);
  assert.equal(r.byKey["AB-1"].state, null);
  assert.equal(r.broken.length, 0);
});

test("addNote: boş / sadece boşluk olan not eklenmez", () => {
  const t = at("2026-08-20");
  assert.deepEqual(addNote([], "", t), []);
  assert.deepEqual(addNote([], "   ", t), []);
  assert.deepEqual(addNote([], null, t), []);
  const one = addNote([], "deploy sonrası kontrol", t);
  assert.equal(one.length, 1);
  assert.equal(one[0].text, "deploy sonrası kontrol");
});

test("addNote: kenar boşlukları kırpılır", () => {
  const n = addNote([], "   toplantıda sor   ", at("2026-08-20"));
  assert.equal(n[0].text, "toplantıda sor");
});

test("addNote: liste dolunca en ESKİ not düşer", () => {
  let notes = [];
  for (let i = 1; i <= MAX_NOTES + 2; i++) {
    notes = addNote(notes, `not ${i}`, at("2026-08-20"));
  }
  assert.equal(notes.length, MAX_NOTES);
  assert.equal(notes[0].text, "not 3", "ilk iki not düşmeli");
  assert.equal(notes[notes.length - 1].text, `not ${MAX_NOTES + 2}`);
});

test("addNote: çok uzun not kırpılır", () => {
  const n = addNote([], "x".repeat(500), at("2026-08-20"));
  assert.equal(n[0].text.length, 140);
});

test("addNote: her notun benzersiz id'si olur", () => {
  const t = at("2026-08-20");
  const n = addNote(addNote([], "a", t), "b", t);
  assert.notEqual(n[0].id, n[1].id, "aynı anda eklense bile id çakışmamalı");
});

test("removeNote: sadece hedef not silinir, kalanlar korunur", () => {
  const t = at("2026-08-20");
  let n = addNote(addNote(addNote([], "a", t), "b", t), "c", t);
  const target = n[1].id;
  n = removeNote(n, target);
  assert.deepEqual(n.map((x) => x.text), ["a", "c"]);
  assert.deepEqual(removeNote(n, "olmayan-id").map((x) => x.text), ["a", "c"]);
  assert.deepEqual(removeNote(null, "x"), []);
});

test("reviewWaitInfo: PR açılışını değil SANA atandığı anı sayar", () => {
  const pr = {
    createdAt: "2026-08-03T09:00:00Z",
    timelineItems: { nodes: [
      { createdAt: "2026-08-19T09:00:00Z", requestedReviewer: { login: "demo-user" } },
    ] },
  };
  const r = reviewWaitInfo(pr, "demo-user", at("2026-08-20"));
  assert.equal(r.days, 1, "16 gün önce açılmış ama dün atanmış");
});

test("reviewWaitInfo: başkasına yapılan istek sayılmaz", () => {
  const pr = {
    createdAt: "2026-08-19T09:00:00Z",
    timelineItems: { nodes: [
      { createdAt: "2026-08-20T09:00:00Z", requestedReviewer: { login: "baskasi" } },
    ] },
  };
  const r = reviewWaitInfo(pr, "demo-user", at("2026-08-20"));
  assert.equal(r.requestedAt, "2026-08-19T09:00:00Z", "PR açılışına düşer");
});

test("reviewWaitInfo: takım isteği (login yok) sayılır", () => {
  const pr = {
    createdAt: "2026-08-01T09:00:00Z",
    timelineItems: { nodes: [
      { createdAt: "2026-08-18T09:00:00Z", requestedReviewer: { name: "scalability" } },
    ] },
  };
  const r = reviewWaitInfo(pr, "demo-user", at("2026-08-20"));
  assert.equal(r.requestedAt, "2026-08-18T09:00:00Z");
  assert.equal(r.days, 2);
});

test("reviewWaitInfo: birden fazla istekte EN SON olan geçerli", () => {
  const pr = { createdAt: "2026-08-01T09:00:00Z", timelineItems: { nodes: [
    { createdAt: "2026-08-10T09:00:00Z", requestedReviewer: { login: "demo-user" } },
    { createdAt: "2026-08-19T09:00:00Z", requestedReviewer: { login: "demo-user" } },
  ] } };
  assert.equal(reviewWaitInfo(pr, "demo-user", at("2026-08-20")).days, 1);
});

test("reviewWaitInfo: timeline boşsa PR açılışına düşer, veri yoksa çökmez", () => {
  assert.equal(reviewWaitInfo({ createdAt: "2026-08-19T09:00:00Z" }, "x", at("2026-08-20")).days, 1);
  assert.deepEqual(reviewWaitInfo(null, "x", at("2026-08-20")), { requestedAt: null, days: null });
});

test("detectAlerts: ilk çalıştırmada hiç ses çalmaz", () => {
  const now = { bossKey: "DEMO-1", brokenIds: ["a#1"], reviewIds: ["b#2"] };
  assert.deepEqual(detectAlerts(emptyState(), now), [], "açılışta mevcut olanlar ses çıkarmamalı");
  assert.deepEqual(detectAlerts(null, now), []);
});

test("detectAlerts: yeni boss ses çıkarır, aynı boss tekrar çıkarmaz", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: "DEMO-1", brokenIds: [], reviewIds: [] }), ["boss"]);
  const same = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(same, { bossKey: "DEMO-1", brokenIds: [], reviewIds: [] }), []);
});

test("detectAlerts: boss değişirse yeniden ses çıkar", () => {
  const prev = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: "DEMO-2", brokenIds: [], reviewIds: [] }), ["boss"]);
});

test("detectAlerts: boss kaybolunca ses çıkmaz", () => {
  const prev = { initialized: true, bossKey: "DEMO-1", brokenIds: [], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: [], reviewIds: [] }), []);
});

test("detectAlerts: sadece YENİ kırık CI ses çıkarır", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: ["cs#1"], reviewIds: [] };
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: ["cs#1"], reviewIds: [] }), [],
    "zaten bilinen kırık tekrar ötmez");
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: ["cs#1", "shared-lib#2"], reviewIds: [] }), ["ci"]);
});

test("detectAlerts: yeni review isteği ses çıkarır", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: [], reviewIds: ["r#1"] };
  assert.deepEqual(detectAlerts(prev, { bossKey: null, brokenIds: [], reviewIds: ["r#1", "r#2"] }), ["review"]);
});

test("detectAlerts: birden fazla olay birlikte raporlanır", () => {
  const prev = { initialized: true, bossKey: null, brokenIds: [], reviewIds: [] };
  const now = { bossKey: "DEMO-9", brokenIds: ["a#1"], reviewIds: ["b#2"] };
  assert.deepEqual(detectAlerts(prev, now), ["boss", "ci", "review"]);
});

test("firstName: ilk adı alır, uzunu kısaltır, boşu tolere eder", () => {
  assert.equal(firstName("Ada Yılmaz"), "Ada");
  assert.equal(firstName("Kerem Demir"), "Kerem");
  assert.equal(firstName("Mahmut Mustafa Uyan"), "Mahmut");
  assert.equal(firstName("Konstantinopolis Yılmaz"), "Konstant…", "9 karakteri aşan ilk ad kısalır");
  assert.equal(firstName("Tek"), "Tek");
  assert.equal(firstName(null), "");
  assert.equal(firstName("   "), "");
});

test("firstName: config'teki takma ad Jira adının yerine geçer", () => {
  const ov = { "Kerem Demir": "KD" };
  assert.equal(firstName("Kerem Demir", ov), "KD");
  assert.equal(firstName("Ada Yılmaz", ov), "Ada", "eşleşmeyen isim normal davranır");
  assert.equal(firstName("Kerem Demir"), "Kerem", "override verilmezse Jira adı kalır");
});

test("firstName: takma ad tam ada göre eşleşir, kısmi eşleşme olmaz", () => {
  const ov = { "Kerem Demir": "KD" };
  assert.equal(firstName("Kerem Demirci", ov), "Kerem", "farklı kişi etkilenmemeli");
  assert.equal(firstName("Kerem", ov), "Kerem");
});

test("firstName: boş/bozuk takma ad Jira adına düşer", () => {
  assert.equal(firstName("Kerem Demir", { "Kerem Demir": "" }), "Kerem");
  assert.equal(firstName("Kerem Demir", { "Kerem Demir": null }), "Kerem");
  assert.equal(firstName("Kerem Demir", {}), "Kerem");
});

// --- resolveExecutable: GUI uygulaması shell PATH'ini görmüyor ---
// Sabit /opt/homebrew yolu Intel Mac'te ve Homebrew'suz makinede kırılıyordu.

test("resolveExecutable: ilk var olan adayı döndürür", () => {
  const exists = (p) => p === "/usr/local/bin/gh";
  assert.equal(resolveExecutable("gh", exists), "/usr/local/bin/gh");
});

test("resolveExecutable: sıra önemli — Homebrew yolu /usr/bin'e tercih edilir", () => {
  const exists = (p) => p === "/opt/homebrew/bin/node" || p === "/usr/bin/node";
  assert.equal(resolveExecutable("node", exists), "/opt/homebrew/bin/node");
});

test("resolveExecutable: hiçbir aday yoksa null (çağıran yedeğe düşebilsin)", () => {
  assert.equal(resolveExecutable("yok-boyle-bir-sey", () => false), null);
});

test("resolveExecutable: boş isim null döner, dosya sistemi hiç yoklanmaz", () => {
  let calls = 0;
  assert.equal(resolveExecutable("", () => { calls++; return true; }), null);
  assert.equal(calls, 0);
});

test("resolveExecutable: aday dizinleri dışarıdan verilebilir", () => {
  const exists = (p) => p === "/opt/custom/bin/gh";
  assert.equal(resolveExecutable("gh", exists, ["/opt/custom/bin"]), "/opt/custom/bin/gh");
  assert.equal(resolveExecutable("gh", exists, BIN_DIRS), null, "varsayılan dizinlerde yok");
});

// --- validateSetup: indirilen app'in ilk acilis ekrani ---

test("validateSetup: gecerli girdi temiz gecer", () => {
  const r = validateSetup({ host: "example.atlassian.net", email: "a@b.com", githubOrg: "acme" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.values, { host: "example.atlassian.net", email: "a@b.com", githubOrg: "acme" });
});

test("validateSetup: adres çubuğundan yapıştırılan URL temizlenir (asıl vaka)", () => {
  const r = validateSetup({ host: "https://example.atlassian.net/", email: "a@b.com" });
  assert.equal(r.values.host, "example.atlassian.net", "şema ve sondaki / düşmeli");
  assert.equal(r.ok, true);
});

test("validateSetup: boş alanlar tek tek raporlanır", () => {
  const r = validateSetup({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("Jira adresi")));
  assert.ok(r.errors.some((e) => e.includes("E-posta")));
});

test("validateSetup: bozuk host ve e-posta yakalanır", () => {
  assert.equal(validateSetup({ host: "sirket", email: "a@b.com" }).ok, false, "nokta yoksa host değil");
  assert.equal(validateSetup({ host: "a.b", email: "duz-metin" }).ok, false, "@ yoksa e-posta değil");
});

test("validateSetup: boşluklar kırpılır, githubOrg opsiyonel", () => {
  const r = validateSetup({ host: "  a.b  ", email: "  x@y.co  " });
  assert.equal(r.ok, true);
  assert.equal(r.values.host, "a.b");
  assert.equal(r.values.email, "x@y.co");
  assert.equal(r.values.githubOrg, "", "verilmezse boş kalır, fetch tarafı varsayılana düşer");
});

// --- Güncelleme kontrolü ---

test("compareVersions: temel sıralama", () => {
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.1.0", "1.0.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("compareVersions: 'v' öneki ve eksik parça tolere edilir", () => {
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0, "v öneki fark yaratmamalı");
  assert.equal(compareVersions("1.2", "1.2.0"), 0, "eksik parça 0 sayılmalı");
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "sayısal karşılaştırma, metin değil");
});

test("updateInfo: yeni sürüm varsa bilgi döner", () => {
  const r = updateInfo("1.0.0", { tag_name: "v1.1.0", html_url: "https://x/releases/v1.1.0" });
  assert.deepEqual(r, { version: "1.1.0", url: "https://x/releases/v1.1.0" });
});

test("updateInfo: aynı ya da eski sürümde uyarı YOK", () => {
  assert.equal(updateInfo("1.1.0", { tag_name: "v1.1.0" }), null);
  assert.equal(updateInfo("1.2.0", { tag_name: "v1.1.0" }), null, "geri gitmemeli");
});

test("updateInfo: sürüm gömülü değilse (geliştirme derlemesi) hiç uyarmaz", () => {
  assert.equal(updateInfo(null, { tag_name: "v9.9.9" }), null);
  assert.equal(updateInfo("", { tag_name: "v9.9.9" }), null);
});

test("updateInfo: release alınamadıysa sessiz kalır", () => {
  assert.equal(updateInfo("1.0.0", null), null);
  assert.equal(updateInfo("1.0.0", {}), null, "tag_name yoksa uyarma");
});

// --- jiraRequest: OAuth ve API token yolları yan yana ---

test("jiraRequest: OAuth isteği ağ geçidine gider, siteye değil", () => {
  const r = jiraRequest({ mode: "oauth", token: "AT", cloudId: "cid-1" }, "sirket.atlassian.net", "/rest/api/3/myself");
  assert.equal(r.url, "https://api.atlassian.com/ex/jira/cid-1/rest/api/3/myself");
  assert.equal(r.headers.Authorization, "Bearer AT");
});

test("jiraRequest: Basic isteği doğrudan siteye gider", () => {
  const r = jiraRequest({ mode: "basic", token: "B64" }, "sirket.atlassian.net", "/rest/api/3/myself");
  assert.equal(r.url, "https://sirket.atlassian.net/rest/api/3/myself");
  assert.equal(r.headers.Authorization, "Basic B64");
});

test("jiraRequest: OAuth'ta cloudId yoksa SESSİZCE yanlış adrese gitmez, patlar", () => {
  assert.throws(() => jiraRequest({ mode: "oauth", token: "AT" }, "s.atlassian.net", "/x"), /cloudId/);
});

test("jiraRequest: Basic'te host yoksa patlar", () => {
  assert.throws(() => jiraRequest({ mode: "basic", token: "B" }, "", "/x"), /host/);
});

test("jiraRequest: mod verilmezse Basic kabul edilir (eski kurulumlar)", () => {
  const r = jiraRequest({ token: "B64" }, "eski.atlassian.net", "/rest/api/3/field");
  assert.equal(r.url, "https://eski.atlassian.net/rest/api/3/field");
  assert.ok(r.headers.Authorization.startsWith("Basic "));
});
