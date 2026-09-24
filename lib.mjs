// Saf karar mantığı. Burada I/O yok, Date.now() yok — "now" her zaman parametre.
// Böylece tamamı deterministik test edilebiliyor.

const MS_PER_DAY = 86400000;

/** Yerel takvim gününü tam sayıya çevirir (DST'den etkilenmez). */
export function dayIndex(date) {
  const d = new Date(date);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY);
}

/** dayIndex -> haftanın günü (0=Pazar ... 6=Cumartesi). 1970-01-01 Perşembeydi. */
export function dowOf(dayIdx) {
  return (((dayIdx % 7) + 7) % 7 + 4) % 7;
}

const isWeekend = (dayIdx) => {
  const d = dowOf(dayIdx);
  return d === 0 || d === 6;
};

/**
 * from'dan to'ya geçen tam iş günü sayısı (from hariç, to dahil).
 * Cuma akşam review'a giren iş Pazartesi sabahı 1 gündür bekliyor sayılır —
 * hafta sonu "takıldı" alarmını tetiklememeli.
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
 * Statüde geçen süreyi eşiğe vurur.
 * Tam sınırda (days === threshold) HENÜZ yanmaz — eşik "bunu aşarsa sorun" demek.
 */
export function evaluate(status, daysInStatus, config) {
  const threshold = config.thresholds?.[status] ?? config.defaultThresholdDays;
  const alert = daysInStatus > threshold;
  // Eşik 0 ("sıfır tolerans") geçerli bir ayar; paydayı 1'e sabitlemezsek
  // oran 0 çıkar ve boss sıralaması ile critical kademesi sessizce çöker.
  const ratio = daysInStatus / Math.max(threshold, 1);
  const tier = !alert ? "ok" : ratio >= 2 ? "critical" : "warn";
  return { threshold, alert, ratio, tier };
}

/**
 * Boss = eşiğini EN ÇOK ORANLA aşan task. Gün sayısı değil oran, çünkü
 * 4 gündür code review'da (eşik 2, oran 2.0) bekleyen bir iş,
 * 8 gündür To Do'da (eşik 7, oran 1.14) duran bir işten daha acil.
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
 * Issue'nun sprint geçmişi. Jira'nın sprint alanı DİZİ döner ve kapalı sprintler
 * listede kalır — devretmiş işi buradan anlıyoruz, ayrı bir sorguya gerek yok.
 *
 * "future" sprintler sayılmaz: henüz başlamamış bir plana konmuş olmak devretme değil.
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

/** Aşım katına göre şimşek sayısı (1–5). */
export function bolts(ratio) {
  return Math.max(1, Math.min(5, Math.floor(ratio)));
}

/** PR başlığından Jira anahtarını çıkarır ("DEMO-101 | Şablon kapısı" -> "DEMO-101"). */
export function extractIssueKey(title) {
  const m = String(title || "").match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

// Kötü olan kazanır: bir taskın PR'larından biri kırıksa rozet kırık görünmeli.
const CI_RANK = { FAILURE: 3, ERROR: 3, PENDING: 2, EXPECTED: 2, SUCCESS: 1 };

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const WAITING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"]);

/**
 * Bir PR'ın SADECE required check'lerine bakarak durum özeti çıkarır.
 *
 * GitHub'ın statusCheckRollup.state alanı opsiyonel check'leri de sayıyor; bu yüzden
 * merge'i hiç engellemeyen bir Jest/lint hatası "FAILURE" görünüyordu (3 PR'da doğrulandı).
 * Merge'i gerçekten bloke eden şey required check'ler, o yüzden filtre burada.
 */
export function requiredRollup(contexts) {
  const required = (contexts || []).filter((c) => c && c.isRequired);

  // Yeniden çalıştırılan check'lerde GitHub hem eski hem yeni run'ı listede tutuyor
  // (Canlı ölçüm: aynı check bir kez CANCELLED, bir kez SUCCESS görünüyordu.)
  // Sadece en son çalışan sayılmalı — yoksa iptal edilmiş eski run "kırık" sanılır.
  const latest = new Map();
  for (const c of required) {
    const name = c.name || c.context || "?";
    const at = c.completedAt || c.startedAt || c.createdAt || null;
    const prev = latest.get(name);
    if (!prev) { latest.set(name, { c, at }); continue; }
    // Zaman bilgisi varsa ona göre, yoksa listede sonra geleni güncel kabul et.
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

  // Hiç required check yoksa durum bilinmiyor sayılır — uyarı üretmez.
  const state = rank === 3 ? "FAILURE" : rank === 2 ? "PENDING" : rank === 1 ? "SUCCESS" : null;
  return { state, failing, pending, requiredCount: latest.size };
}

/**
 * Done kategorisinde OLUP hâlâ canlıya çıkmamış statüler — izin listesi.
 *
 * Neden izin listesi: tersi ("bitmişler" listesi) tanınmayan her statüyü sonsuza
 * dek "bekliyor" gösteriyordu. Bu Jira'nın done kategorisinde 15 statü var ve
 * altısı (Closed, Resolved, Problem Solved, Epic is Done, Question, Unresolved)
 * bu yüzden yanlış sınıflanıyordu. Tanınmayan statü artık "bitmiş"e düşer —
 * kalıcı gürültü üretmek yerine sessiz kalır.
 */
export const DEFAULT_PENDING_RELEASE_STATUSES = [
  "Ready For Release", "Awaiting Release", "Pending for Release",
  "Waiting for Release", "Waiting for SDK Release",
];

/** config'teki liste bozuksa (dizi değilse) varsayılana döner — payload düşmesin. */
export function pendingReleaseStatuses(config) {
  const c = config && config.pendingReleaseStatuses;
  return Array.isArray(c) ? c : DEFAULT_PENDING_RELEASE_STATUSES;
}

/**
 * Done kategorisindeki bir statüyü üçe ayırır: bitmiş / iptal / canlıya çıkmayı bekliyor.
 *
 * Bilinmeyen statü "bitmiş" sayılır (fail-closed) — bkz. üstteki izin listesi.
 */
export function releaseState(status, config) {
  const raw = typeof status === "string" ? status.trim() : "";
  if (/reject|cancel/i.test(raw)) return "cancelled";

  const norm = raw.toLowerCase();
  return pendingReleaseStatuses(config)
    .some((s) => String(s).trim().toLowerCase() === norm) ? "pending" : "finished";
}

/**
 * Bir PR'ı merge'den alıkoyan her şey — CI *ve* code review birlikte.
 *
 * Yalnız CI'ya bakmak yanıltıcıydı: required check'lerin hepsi geçse bile
 * review onayı beklenirken PR merge edilemiyor. rank 3 = aksiyon gerekiyor,
 * 2 = bekleniyor, 0 = engel yok.
 */
export function prBlockers(pr) {
  const reasons = [];
  let rank = 0;

  // Conflict merge'i kesin engeller — CI yeşil ve review onaylı olsa bile.
  // SADECE "CONFLICTING" sayılır: GitHub mergeable'ı tembel hesaplıyor, ilk
  // sorguda "UNKNOWN" dönüp ikincisinde "MERGEABLE" olabiliyor (canlı ölçüldü:
  // 15 PR'ın 3'ü böyleydi). UNKNOWN'ı conflict saymak yanlış alarm olurdu.
  if (pr.mergeable === "CONFLICTING") {
    reasons.push("conflict — rebase gerekiyor");
    rank = 3;
  }

  if (pr.ciState === "FAILURE" || pr.ciState === "ERROR") {
    reasons.push(`CI: ${(pr.failingRequired || []).join(", ") || "?"}`);
    rank = 3;
  } else if (pr.ciState === "PENDING" || pr.ciState === "EXPECTED") {
    reasons.push(`CI: ${(pr.pendingRequired || []).join(", ") || "?"}`);
    rank = Math.max(rank, 2);
  }

  // reviewDecision yalnızca review ZORUNLUYSA dolu gelir; null "gerekmiyor" demek.
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    reasons.push("değişiklik istendi");
    rank = 3;
  } else if (pr.reviewDecision === "REVIEW_REQUIRED") {
    reasons.push("review bekliyor");
    rank = Math.max(rank, 2);
  }

  return { rank, reasons };
}

/**
 * Senden review istenen bir PR'ın ne zamandır beklediği.
 *
 * PR'ın açılış tarihi değil, SANA review atandığı an sayılır — bir PR haftalarca
 * açık durup review'a dün atanmış olabilir. Takım üzerinden gelen istekte
 * requestedReviewer bir Team olur (login yok), o da sayılır.
 */
export function reviewWaitInfo(pr, login, now) {
  const events = (pr && pr.timelineItems && pr.timelineItems.nodes) || [];
  let latest = null;
  for (const e of events) {
    if (!e || !e.createdAt) continue;
    const who = e.requestedReviewer ? e.requestedReviewer.login || null : null;
    if (login && who && who !== login) continue; // başkasına yapılan istek
    if (!latest || e.createdAt > latest) latest = e.createdAt;
  }
  const at = latest || (pr && pr.createdAt) || null;
  return { requestedAt: at, days: at ? businessDaysBetween(at, now) : null };
}

/**
 * PR listesini task anahtarına göre özetler.
 * Jira dev-status boş döndüğü için PR'lar GitHub'dan geliyor ve başlıktaki
 * anahtarla eşleşiyor — başlığında anahtar olmayan PR sessizce atlanır.
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

    // Draft PR henüz hazır değil: rozette SAYILIR (işe başlanmış), ama engel
    // üretmez — ne banda girer ne CI sesi çalar. Canlı ölçümde açık PR'ların
    // 7/8'i draft'tı ve 5'i REVIEW_REQUIRED olduğu için BEKLEYEN bandını tek
    // başına dolduruyor, gerçek tek iş aralarında kayboluyordu.
    if (pr?.isDraft) continue;

    const { rank, reasons } = prBlockers(pr);
    entry.rated++;
    // İLK PR'da mutlaka set et: rank 0 iken "rank > entry.rank" hiç sağlanmaz ve
    // engelsiz PR'lar durumsuz (null) kalırdı. Sayaç count DEĞİL rated olmalı —
    // aksi halde listedeki ilk PR draft olduğunda sonraki gerçek PR durumsuz kalır.
    if (entry.rated === 1 || rank > entry.rank) {
      entry.rank = rank;
      // Engel yoksa CI'ın kendi durumunu yansıt: bilinmiyorsa (null) yeşil gösterme.
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
 * "Ada Yılmaz" -> "Ada". Dar sütuna sığması için; tam ad tooltip'te kalır.
 *
 * overrides: Jira'daki tam ad -> ekranda görünecek ad. Kişinin takımda kullandığı
 * isim Jira kaydıyla uyuşmadığında (ör. "Kerem Demir" ama herkes "KD" diyor)
 * config'ten eşlenir; kod içine gömülmez.
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

// --- Hızlı notlar (tarayıcı tarafında localStorage'da yaşar; Jira'ya hiç gitmez) ---
export const MAX_NOTES = 6;
const NOTE_LIMIT = 140;

/** Boş/whitespace not eklenmez; liste dolduğunda EN ESKİ düşer. */
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
 * Bir önceki çalıştırmaya göre YENİ ortaya çıkan kritik olaylar.
 *
 * İlk çalıştırmada (prev.initialized !== true) hiçbir şey üretmez — yoksa widget
 * ilk açılışta mevcut her boss/kırık CI/review isteği için ses çalardı.
 * Zaten bilinen bir olay tekrar ses çıkarmaz; sadece yeni gelenler sayılır.
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
 * Kalici durum artik TEK bir soruya hizmet ediyor: "bu olayi bir onceki
 * calistirmada gormus muyduk?" — yani ses tekrarini onlemek.
 *
 * `initialized` KRITIK: detectAlerts ilk calistirmada susmak icin buna bakiyor.
 * Yazilmazsa widget her acilista mevcut her boss/kirik CI icin ses calardi.
 */
export function emptyState() {
  return {
    initialized: false,
    bossKey: null,
    brokenIds: [],
    reviewIds: [],
  };
}

// --- Çalıştırılabilir dosya arama ---------------------------------------
// Finder'dan açılan bir GUI uygulaması shell PATH'ini GÖRMEZ (/usr/bin:/bin ile
// sınırlı kalır), o yüzden node/gh'yi "PATH'te bulunur" varsayamayız. Homebrew
// Apple Silicon'da /opt/homebrew, Intel Mac'te /usr/local altında kurulu.

export const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/**
 * Adayları sırayla deneyip ilk var olanın mutlak yolunu döndürür; hiçbiri yoksa null.
 * `exists` dışarıdan veriliyor — bu yüzden saf ve test edilebilir.
 */
export function resolveExecutable(name, exists, dirs = BIN_DIRS) {
  if (!name) return null;
  for (const dir of dirs) {
    const path = `${dir}/${name}`;
    if (exists(path)) return path;
  }
  return null;
}

// --- Güncelleme kontrolü ------------------------------------------------
// İmzalanmış bir bundle'ın içi DEĞİŞTİRİLEMEZ (tek dosya bile imzayı bozar ve
// macOS uygulamayı SIGKILL'ler). Yani uygulama kendini güncelleyemez; yapacağı
// şey "yeni sürüm var" deyip release sayfasını açmak.

/** Sürümleri sayısal parçalara göre karşılaştırır. -1 / 0 / 1. "v" öneki tolere edilir. */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? "").trim().replace(/^v/i, "").split(/[.\-+]/)
      .map((n) => parseInt(n, 10)).filter(Number.isFinite);
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;      // "1.2" ile "1.2.0" eşit sayılmalı
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Release GitHub'dakinden yeniyse gösterilecek bilgi, değilse null.
 * `current` yoksa (geliştirme derlemesi, sürüm gömülü değil) hiç uyarmıyoruz —
 * her yenilemede "güncelle" demesi geliştirirken sadece gürültü olurdu.
 */
export function updateInfo(current, release) {
  if (!current || !release || !release.tag_name) return null;
  if (compareVersions(release.tag_name, current) <= 0) return null;
  return {
    version: String(release.tag_name).replace(/^v/i, ""),
    url: release.html_url || null,
  };
}

// --- Jira istek hedefi --------------------------------------------------
// İki kimlik yolu bir arada: OAuth (yeni) ve API token (mevcut kurulumlar).
// OAuth'ta istek siteye DEĞİL Atlassian'ın ağ geçidine gidiyor ve site
// `cloudId` ile seçiliyor; Basic'te doğrudan siteye gidiyor. Bu fark tek bir
// yerde toplanmazsa her çağrı yerinde tekrar etmek zorunda kalırdı.

/**
 * Bir Jira REST yolu için gidilecek URL ve gönderilecek başlıklar.
 * `auth`: { mode: "oauth", token, cloudId } | { mode: "basic", token }
 */
export function jiraRequest(auth, host, path) {
  if (auth?.mode === "oauth") {
    if (!auth.cloudId) throw new Error("OAuth modunda cloudId gerekli");
    return {
      url: `https://api.atlassian.com/ex/jira/${auth.cloudId}${path}`,
      headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
    };
  }
  if (!host) throw new Error("Basic modunda host gerekli");
  return {
    url: `https://${host}${path}`,
    headers: { Authorization: `Basic ${auth?.token ?? ""}`, Accept: "application/json" },
  };
}
