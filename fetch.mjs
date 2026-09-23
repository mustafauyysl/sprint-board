#!/usr/bin/env node
// I/O katmanı: Jira + keychain + state dosyası. Tüm karar mantığı lib.mjs'te.
// Çıktı: tek satır JSON (Übersicht bunu parse eder). Hata olsa bile GEÇERLİ JSON basar.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  businessDaysBetween, evaluate, pickBoss, bolts,
  releaseState, pendingReleaseStatuses, emptyState, sprintHistory, firstName,
  summarizePrs, requiredRollup, reviewWaitInfo, detectAlerts, resolveExecutable,
  validateSetup, updateInfo, jiraRequest,
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
    // stderr yutuluyor: Übersicht stdout+stderr'i birleştirirse JSON parse patlar.
    return execFileSync("/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Token'lar Swift tarafindan stdin ile veriliyor.
 *
 * NEDEN: keychain kaydini YAZAN uygulama OKUYAN da olmali. Kaydi uygulama
 * yazip `security` (ayri bir binary) okumaya kalkinca macOS izin penceresi
 * aciyor — olculdu, komut diyalog bekleyip asili kaldi. Uygulama kendi
 * yazdigini SecItemCopyMatching ile sessizce okuyor ve buraya aktariyor.
 *
 * Terminalden elle calistirildiginda stdin bir tty'dir; o zaman asagidaki
 * `security` yoluna dusuluyor (eski, elle kurulmus kayitlar da boyle calisiyor).
 */
async function pipedTokens() {
  if (process.stdin.isTTY) return {};
  // readFileSync(0) KULLANILMAZ: boru henuz bossa EAGAIN atiyor ve token
  // yokmus gibi devam ediliyordu (olculdu — OAuth modunda uygulama tarafi
  // payload'u hazirlarken ag istegi yaptigi icin boru bir an bos kaliyor).
  // Burada EOF'a kadar okuyoruz; yazan taraf yazip kapatiyor.
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
 * Custom field id'leri kuruluma göre değişir — runtime'da keşfedip config'e yazıyoruz.
 * (Alan id'leri kuruluma göre değişir; bu yüzden hiçbir yerde hard-code edilmiyor.)
 */
async function discoverFields(cfg, auth, names) {
  const r = await api(cfg, auth, "/rest/api/3/field");
  if (!r.ok) throw new Error(`field listesi alınamadı (HTTP ${r.status})`);
  const out = {};
  for (const name of names) {
    const f = r.body.find((x) => x.name === name && String(x.id).startsWith("customfield_"));
    out[name] = f ? f.id : null;
  }
  return out;
}

/** Yeni /search/jql önce; emekliye ayrılmış /search'e yalnızca 404/410'da düşülür. */
async function searchIssues(cfg, auth, jql, fields) {
  const qs = (base) =>
    `${base}?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}` +
    `&expand=changelog&maxResults=100`;

  let r = await api(cfg, auth, qs("/rest/api/3/search/jql"));
  if (!r.ok && (r.status === 404 || r.status === 410)) {
    r = await api(cfg, auth, qs("/rest/api/3/search"));
  }
  if (!r.ok) {
    const hint = r.status === 401 ? " — token geçersiz mi?" : "";
    throw new Error(`Jira araması başarısız (HTTP ${r.status})${hint}`);
  }
  return r.body.issues ?? [];
}

/**
 * Geçmiş sprintlerde kalmış ama hâlâ canlıya çıkmamış işler.
 *
 * Ana sorgu `sprint in openSprints()` dediği için bunlar widget'ta HİÇ
 * görünmüyordu: sprint kapanınca iş gözden kayboluyor, prod'a çıkmamış olsa bile.
 * Bitmiş (Released on Prod / Done) ve iptal edilenler elenir — geriye yalnızca
 * gerçekten beklemede olanlar kalır.
 */
async function fetchPendingRelease(cfg, auth, sprintField, now) {
  const wanted = pendingReleaseStatuses(cfg);
  if (wanted.length === 0) return [];
  try {
    // Statü süzgeci JQL'e taşındı. Önce "statusCategory = Done" çekip istemcide
    // eliyorduk; searchIssues maxResults=100'de kesiyor ve sayfalamıyor, üstelik
    // sıralama `updated DESC` idi — yani EN UZUN bekleyen, yani bu bandın var
    // olma sebebi olan kayıtlar pencerenin dışında kalıp sessizce düşüyordu.
    // Süzgeç sunucuda olunca sonuç kümesi zaten küçük; `updated ASC` de en
    // bayatları başa alarak kesilme ihtimalini büsbütün ortadan kaldırıyor.
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
    // Opsiyonel katman: widget'ın geri kalanı çökmemeli. Ama SESSİZ de kalmamalı —
    // yoksa "sorgu bozuldu" ile "bekleyen iş yok" ayırt edilemez, bant sessizce yok olur.
    pendingReleaseError = String(err && err.message ? err.message : err).slice(0, 200);
    return null;
  }
}

function latestStatusChange(issue) {
  let latest = null;
  for (const h of issue.changelog?.histories ?? []) {
    if (!(h.items ?? []).some((i) => i.field === "status" || i.fieldId === "status")) continue;
    const t = new Date(h.created);
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

/**
 * Statüye giriş anı. changelog eksik ya da kırpılmışsa (search 100 kayıtta kesiyor)
 * o issue için tekil changelog çekilir — yoksa süre sessizce yanlış çıkar.
 */
async function statusEnteredAt(cfg, auth, issue) {
  const cl = issue.changelog;
  const truncated = cl && typeof cl.total === "number" && cl.total > (cl.histories?.length ?? 0);
  if (cl && !truncated) return latestStatusChange(issue) ?? new Date(issue.fields.created);

  const r = await api(cfg, auth,
    `/rest/api/3/issue/${issue.key}?expand=changelog&fields=created`);
  if (!r.ok) return latestStatusChange(issue) ?? new Date(issue.fields.created);
  return latestStatusChange(r.body) ?? new Date(r.body.fields?.created ?? issue.fields.created);
}

const GH_KEYCHAIN = "sprint-board-github";
// Servis adı config'den geliyor; yazmıyorsa bu varsayılan kullanılıyor.
// Eski kurulumlar kendi adını config'de zaten taşıdığı için kırılmıyor.
const JIRA_KEYCHAIN = "sprint-board-jira";

/**
 * GitHub token'ı. Önce keychain — uygulamanın `gh` KURULU OLMADAN da çalışması
 * için. gh varsa ve keychain boşsa oradan devralıyoruz, böylece mevcut
 * kurulumlar tek satır bile değiştirmeden çalışmaya devam ediyor.
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

// org verilmezse filtre HİÇ eklenmiyor: kullanıcının tüm açık PR'ları gelir.
// Eskiden org sabit gömülüydü ve başka bir kurulumda hiç sonuç dönmezdi.
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

/** GitHub GraphQL — `gh` alt süreci değil, doğrudan HTTP (Jira ile aynı yol). */
async function ghGraphql(query, token) {
  apiCalls++;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      // GitHub API User-Agent'sız isteği reddeder.
      "User-Agent": "sprint-board",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

/**
 * Açık PR'lar, TEK arama sorgusuyla (~6 sn).
 * Token yoksa / istek düşerse null döner — PR bilgisi opsiyonel,
 * widget'ın geri kalanı bu yüzden çökmemeli.
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
      // Sahip PR'ın KENDİSİNDEN geliyor; tek bir org varsayamayız.
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
 * Her PR için SADECE required check'lerin durumu.
 *
 * Ayrı bir sorgu gerekiyor çünkü `isRequired` alanı argüman olarak PR numarasını
 * istiyor ve arama sorgusunda bu değer dinamik olamıyor — bu yüzden PR başına
 * alias üretip tek çağrıda topluyoruz.
 *
 * Bu filtre olmadan opsiyonel bir Jest/lint hatası "CI kırık" sanılıyordu:
 * Canlı ölçümde üç PR da "FAILURE" göründü ama required'ları geçmişti.
 *
 * Sorgu başarısız olursa durum "bilinmiyor" (null) kalır — yanlış alarm vermektense
 * sessiz kalmak yeğdir.
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
      // İkinci sorgu = oturmuş değer. İlk aramada UNKNOWN dönmüş olabilir;
      // burada MERGEABLE/CONFLICTING'e dönüşmüş oluyor. UNKNOWN kalırsa dokunma.
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
 * En son yayınlanan release. Taslakları ve ön sürümleri GitHub'ın kendisi eliyor.
 * Başarısız olursa null — güncelleme kontrolü opsiyonel, panoyu düşürmemeli.
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

/** Senden review bekleyen PR'lar (github.com/pulls/reviews'un widget karşılığı). */
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
 * Kritik olayda tek bir sistem sesi çalar (boss > CI > review önceliği).
 * spawn+unref: ses widget'ın yenilemesini bloklamasın; hata olursa sessizce geçilir.
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
 * --demo: Jira'ya hiç gitmeden görsel durumların hepsini tek karede gösterir.
 * Girdi sahte ama mantık GERÇEK — evaluate/pickBoss/summarizePrs aynen çalışır,
 * yani burada gördüğün render gerçek veriyle de aynı çıkar.
 */
function demoPayload(cfg) {
  const now = new Date();
  // TAMAMEN UYDURMA. Gerçek Jira kaydı, gerçek müşteri adı ve gerçek kişi adı
  // buraya GİRMEMELİ — repo paylaşıldığında demo verisi de paylaşılmış olur.
  const seed = [
    { key: "DEMO-101", summary: "Şablon motoru: dinamik etiket desteği", status: "Ready To Test", daysInStatus: 11, ageDays: 25, priority: "3 Medium", carriedOver: true, sprintCount: 3, qa: "Ada Yılmaz" },
    { key: "DEMO-102", summary: "Yinelenen kayıt kimlikleri temizlensin", status: "In Code Review", daysInStatus: 5, ageDays: 12, priority: "2 High", carriedOver: false, sprintCount: 1, qa: "Konstantin Petrov" },
    { key: "DEMO-103", summary: "Editörde sohbetle içerik üretimi", status: "UAT", daysInStatus: 4, ageDays: 15, priority: "4 Low", carriedOver: true, sprintCount: 2, qa: "Kerem Demir" },
    { key: "DEMO-104", summary: "Hız sınırı alarmı yeniden bozuldu", status: "IN AUTO TESTING", daysInStatus: 2, ageDays: 6, priority: "2 High", carriedOver: false, sprintCount: 1, qa: "Kerem Demir" },
    { key: "DEMO-105", summary: "Editör uç noktası 404 dönüyor", status: "To Do", daysInStatus: 0, ageDays: 3, priority: "2 High", carriedOver: false, sprintCount: 1 },
    { key: "DEMO-106", summary: "Güvenlik açığı olan bağımlılıklar yükseltilsin", status: "Ready For Release", daysInStatus: 1, ageDays: 17, priority: "3 Medium", carriedOver: false, sprintCount: 1, qa: "Zeynep Aksu", done: true },
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
    { title: "DEMO-101 | Şablon kapısı", ciState: "FAILURE", failingRequired: ["LintChecker"], repo: "web-frontend", number: 4608, url: "#" },
    { title: "DEMO-101 | Şablon arayüzü", ciState: "SUCCESS", repo: "editor-frontend", number: 327, url: "#" },
    { title: "DEMO-101 | Şablon üreteci", ciState: "SUCCESS", repo: "template-generator", number: 243, url: "#" },
    { title: "DEMO-102 | Paylaşılan kütüphane yükseltmesi", ciState: "PENDING", pendingRequired: ["AI Code Review"], repo: "backend-api", number: 1166, url: "#" },
    { title: "DEMO-102 | Gönderim koruması", ciState: "SUCCESS", repo: "shared-lib", number: 97, url: "#" },
    { title: "DEMO-106 | Bağımlılık yükseltmesi", ciState: "FAILURE", failingRequired: ["qa/smoke"], repo: "worker-jobs", number: 288, url: "#" },
    { title: "DEMO-103 | Katalog servisi", ciState: "SUCCESS", reviewDecision: "REVIEW_REQUIRED", repo: "catalog-service", number: 33957, url: "#" },
  ];
  const { byKey: demoByKey, broken: demoBroken, waiting: demoWaiting } = summarizePrs(demoPrs);
  for (const t of tasks) {
    const p = demoByKey[t.key];
    t.pr = p ? { count: p.count, state: p.state } : null;
  }

  const boss = pickBoss(tasks);

  return {
    ok: true, demo: true, generatedAt: now.toISOString(), apiCalls: 0,
    sprint: { name: "Demo Takım - Sprint#4", endDate: null, daysLeft: 2 },
    cleared: 1, total: tasks.length,
    boss: boss && {
      key: boss.key, summary: boss.summary, status: boss.status,
      daysInStatus: boss.daysInStatus, threshold: boss.threshold,
      ratio: Number(boss.ratio.toFixed(2)), bolts: bolts(boss.ratio), url: boss.url,
      carriedOver: boss.carriedOver, sprintCount: boss.sprintCount,
    },
    prsAvailable: true,
    pendingRelease: [
      { key: "DEMO-107", summary: "Yazı tipi görüntüleme ayarı eksik", status: "Ready For Release",
        url: "https://example.invalid/browse/DEMO-107", sprint: "Demo Takım - Sprint#2", days: 17 },
    ],
    position: cfg.position || { top: 40, right: 40 },
    reviewRequests: [
      { repo: "catalog-service", number: 34101, author: "demo-reviewer", days: 3,
        title: "DEMO-108 | hata düzeltmesi", url: "#" },
      { repo: "backend-api", number: 331, author: "demo-author", days: 1,
        title: "DEMO-109 | yeni özellik", url: "#" },
    ],
    brokenPrs: demoBroken,
    waitingPrs: demoWaiting,
    tasks: [...tasks].sort((a, b) =>
      a.done !== b.done ? (a.done ? 1 : -1) : b.ratio - a.ratio || b.daysInStatus - a.daysInStatus),
  };
}

/**
 * İlk açılış kurulumu: stdin'den JSON alır, doğrular, config'i yazar.
 *
 * TOKEN BURAYA GİRMEZ. Swift tarafı onları Security framework ile doğrudan
 * keychain'e yazıyor; böylece hiçbir sır alt sürecin argv'sine ya da
 * stdin'ine düşmüyor.
 */
function runSetup() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return { ok: false, errors: ["kurulum girdisi okunamadı"] };
  }

  const v = validateSetup(input);
  if (!v.ok) return { ok: false, errors: v.errors };

  // Eşikler, sesler, pendingReleaseStatuses gibi varsayılanlar örnekten geliyor —
  // kullanıcıya bunları ilk açılışta sormanın anlamı yok, sonradan düzenlenebilir.
  const example = readJson(join(APP_ROOT, "config.example.json"), {});
  const cfg = {
    ...example,
    host: v.values.host,
    email: v.values.email,
    githubOrg: v.values.githubOrg || example.githubOrg || "",
    nameOverrides: {},          // örnekteki yer tutucu satır taşınmasın
    // Kurulum ekranından geçen kayıtları UYGULAMA yazdı, dolayısıyla onları
    // izin penceresi çıkmadan kendisi okuyabilir. Elle `security` ile
    // kurulmuş eski kayıtlarda bu bayrak YOK ve uygulama keychain'e hiç
    // dokunmuyor — aksi halde her okumada macOS izin sorardı.
    tokensOwnedByApp: true,
  };
  writeJson(CONFIG_PATH, cfg);
  return { ok: true, errors: [], configPath: CONFIG_PATH };
}

async function main() {
  if (process.argv.includes("--setup")) return runSetup();

  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg) throw new Error(`config okunamadı: ${CONFIG_PATH}`);
  if (process.argv.includes("--demo")) return demoPayload(cfg);

  const piped = await pipedTokens();

  // İki kimlik yolu. OAuth'ta access token'ı Swift tarafı veriyor (süresi
  // dolmuşsa Worker üzerinden yenileyip öyle veriyor), site `cloudId` ile
  // seçiliyor. Yoksa eski API token yoluna düşülüyor — mevcut kurulumlar
  // tek satır değişmeden çalışmaya devam etsin diye.
  const auth = piped.jiraAccessToken && cfg.cloudId
    ? { mode: "oauth", token: piped.jiraAccessToken, cloudId: cfg.cloudId }
    : null;

  const token = auth ? null : (piped.jiraToken || getToken(cfg.keychainService || JIRA_KEYCHAIN, cfg.email));
  if (!auth && !token) {
    throw new Error(
      `keychain'de token yok — 'security add-generic-password -s ${cfg.keychainService} -a ${cfg.email} -w <TOKEN>' çalıştır`
    );
  }
  const jiraAuth = auth || { mode: "basic", token: Buffer.from(`${cfg.email}:${token}`).toString("base64") };

  let sprintField = cfg.sprintFieldId;
  let qaField = cfg.qaFieldId;
  if (!sprintField || qaField === undefined) {
    const found = await discoverFields(cfg, jiraAuth, ["Sprint", "QA Tester"]);
    sprintField = sprintField || found["Sprint"];
    if (!sprintField) throw new Error("Jira'da 'Sprint' alanı bulunamadı");
    qaField = qaField === undefined ? found["QA Tester"] : qaField;
    writeJson(CONFIG_PATH, { ...cfg, sprintFieldId: sprintField, qaFieldId: qaField });
  }

  const issues = await searchIssues(
    cfg, jiraAuth,
    "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC",
    `summary,status,priority,issuetype,created,${sprintField}${qaField ? "," + qaField : ""}`
  );

  // Bos pano iki sebepten olabilir: gercekten is yok, YA DA token gecersiz.
  // Jira gecersiz kimligi ANONIM sayip aramaya HTTP 200 + bos liste donuyor
  // (olculdu: arama 200 {"issues":[]}, /myself ayni token'la 401). Bu yuzden
  // yanlis token giren kullanici hata degil bombos bir widget goruyordu.
  // Kimligi SADECE sonuc bosken dogruluyoruz — dolu panoda ek istek yok.
  if (issues.length === 0) {
    const me = await api(cfg, jiraAuth, "/rest/api/3/myself");
    if (!me.ok) {
      throw new Error(
        me.status === 401
          ? "Jira token gecersiz — menu cubugundaki ⚔ > Ayarlar'dan yenile"
          : `Jira kimlik dogrulamasi basarisiz (HTTP ${me.status})`
      );
    }
  }

  const now = new Date();
  // Opsiyonel katman, ana yükü BEKLETMEMELİ: burada sadece başlatılıyor, sonucu
  // task döngüsünden sonra toplanıyor.
  const pendingReleaseP = fetchPendingRelease(cfg, jiraAuth, sprintField, now);
  const tasks = [];
  for (const issue of issues) {
    const f = issue.fields;
    const status = f.status?.name ?? "Unknown";
    const done = f.status?.statusCategory?.key === "done";
    const enteredAt = await statusEnteredAt(cfg, jiraAuth, issue);
    const daysInStatus = businessDaysBetween(enteredAt, now);
    // Statüde geçen süre darboğazı, yaş ise toplam gecikmeyi gösterir — ikisi farklı sinyal.
    const ageDays = businessDaysBetween(new Date(f.created), now);
    const { threshold, alert, ratio, tier } = evaluate(status, daysInStatus, cfg);
    // Sprint dizisinde kapalı sprint varsa iş devretmiş demektir (ayrı sorgu gerekmiyor).
    const { carriedOver, sprintCount } = sprintHistory(f[sprintField]);

    tasks.push({
      key: issue.key,
      summary: f.summary ?? "",
      status,
      statusCategory: f.status?.statusCategory?.key ?? "new",
      done,
      // done kategorisi tek başına yetmiyor: "bitti" ile "çıkmayı bekliyor" ayrı.
      // NOT: bu ayrım SADECE görsel. `cleared` sayacı hâlâ `done`'a bakıyor —
      // geliştirme işi bittiğinde sprint açısından kapanmış sayılıyor, release'i
      // beklemek sayacı geciktirmemeli. Uyumsuzluk değil, kasıtlı.
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

  // Org opsiyonel: verilmezse PR araması org filtresi olmadan çalışır.
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

  // Kritik olay tespiti: bir öncekiyle karşılaştır, sadece YENİ olanlar ses çıkarsın.
  const bossNow = pickBoss(tasks);
  const signals = {
    bossKey: bossNow ? bossNow.key : null,
    brokenIds: brokenPrs.map((p) => `${p.repo}#${p.number}`),
    reviewIds: (reviewRequests || []).map((r) => `${r.repo}#${r.number}`),
  };
  const alerts = detectAlerts(prevState, signals);
  const played = playAlert(cfg, alerts);
  // `initialized` ŞART: detectAlerts ilk çalıştırmayı buradan tanıyor. Yazılmazsa
  // her açılış "ilk açılış" sayılır ve mevcut her boss/kırık CI yeniden ses çalar.
  writeJson(STATE_PATH, { initialized: true, ...signals });

  // Kapanmışlar listeden DÜŞMEZ, sadece sona iner: "Awaiting Release" gibi statüler
  // Jira'da done kategorisinde ama iş henüz prod'a çıkmamış olabilir — gözden kaybolmamalı.
  const visible = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.ratio - a.ratio || b.daysInStatus - a.daysInStatus;
  });

  // Sürüm yalnızca dağıtım derlemesinde gömülü; yoksa release sorgusunu HİÇ
  // yapmıyoruz — geliştirirken ne gereksiz istek ne de gürültülü uyarı olsun.
  const update = piped.appVersion
    ? updateInfo(piped.appVersion,
        await fetchLatestRelease(cfg.updateRepo || "mustafauyysl/sprint-board", ghToken))
    : null;

  const boss = pickBoss(tasks);
  const sprint = activeSprint(issues, sprintField);
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
    // Sessizce boş widget en kötü senaryo — hata da geçerli JSON olarak çıkar.
    process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  });
