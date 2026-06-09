/* global supabase */
const cfg = window.SMOKE_CONFIG;
const loadingEl = document.getElementById("loading");

if (!window.supabase || !cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
  loadingEl.textContent =
    "Geen config of Supabase-library geladen. Controleer config.js (URL + anon key).";
  throw new Error("Missing config/library");
}

const db = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

const el = (id) => document.getElementById(id);
const show = (id, on = true) => el(id).toggleAttribute("hidden", !on);

let currentSession = null;
let runsCache = [];
let checksByRun = {};
let selectedRunId = null;

function setUI(session) {
  currentSession = session;
  show("login", !session);
  show("dashboard", !!session);
  show("logout", !!session);
  show("loading", false);
}

el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("login-error").textContent = "";
  const { error } = await db.auth.signInWithPassword({
    email: el("email").value,
    password: el("password").value,
  });
  if (error) el("login-error").textContent = error.message;
});

el("logout").addEventListener("click", () => db.auth.signOut());

// Geen awaited Supabase-calls binnen onAuthStateChange (lock-deadlock); load buiten de callback.
db.auth.onAuthStateChange((_event, session) => {
  setUI(session);
  if (session) setTimeout(() => loadData(), 0);
});
db.auth.getSession().then(({ data }) => {
  setUI(data.session);
  if (data.session) loadData();
});

// Auto-verversen elke 20s zolang ingelogd.
setInterval(() => {
  if (currentSession) loadData();
}, 20000);

el("recent").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-run]");
  if (!tr) return;
  selectedRunId = tr.getAttribute("data-run");
  renderRecent();
  renderDetails();
});

async function loadData() {
  const { data: runs } = await db
    .from("runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(25);
  runsCache = runs ?? [];

  if (runsCache.length === 0) {
    el("meta").textContent = "";
    el("recent").innerHTML = `<p class="muted">Nog geen runs.</p>`;
    el("sites").innerHTML = "";
    return;
  }

  const { data: checks } = await db
    .from("checks")
    .select("*")
    .in(
      "run_id",
      runsCache.map((r) => r.id),
    );
  checksByRun = {};
  for (const c of checks ?? []) (checksByRun[c.run_id] ??= []).push(c);

  if (!selectedRunId || !runsCache.some((r) => r.id === selectedRunId)) {
    selectedRunId = runsCache[0].id;
  }

  el("meta").innerHTML = `Laatste update: <strong>${new Date().toLocaleTimeString("nl-NL")}</strong> · ververst automatisch`;
  renderRecent();
  await renderDetails();
}

function runSummary(checks) {
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => rowLevel(c) === "warn").length;
  const level = failed > 0 ? "bad" : warned > 0 ? "warn" : "good";
  const label = failed > 0 ? `${failed} fail` : warned > 0 ? `${warned} let op` : "OK";
  return { level, label };
}

function renderRecent() {
  const rows = runsCache
    .map((r) => {
      const checks = checksByRun[r.id] ?? [];
      const sites = [...new Set(checks.map((c) => c.site_slug))].join(", ") || "—";
      const s = runSummary(checks);
      const when = new Date(r.created_at).toLocaleString("nl-NL");
      return `<tr data-run="${r.id}" class="recent-row ${r.id === selectedRunId ? "sel" : ""}">
        <td>${when}</td>
        <td>${escapeHtml(sites)}</td>
        <td><span class="mode">${escapeHtml(r.mode ?? "test")}</span></td>
        <td><span class="pill ${s.level}">${s.label}</span></td>
      </tr>`;
    })
    .join("");
  el("recent").innerHTML =
    `<table class="recent"><thead><tr><th>Tijd</th><th>Site</th><th>Type</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function renderDetails() {
  const checks = checksByRun[selectedRunId] ?? [];
  const bySite = {};
  for (const c of checks) (bySite[c.site_slug] ??= []).push(c);
  const cards = await Promise.all(
    Object.entries(bySite).map(([slug, list]) => siteCard(slug, list)),
  );
  el("sites").innerHTML = cards.join("") || `<p class="muted">Geen details.</p>`;
}

function rowLevel(c) {
  if (c.status === "fail") return "fail";
  if ((c.deviations ?? []).length > 0) return "warn";
  return "pass";
}

async function siteCard(slug, checks) {
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => rowLevel(c) === "warn").length;
  const level = failed > 0 ? "bad" : warned > 0 ? "warn" : "good";
  const badge = failed > 0 ? `${failed} fail` : warned > 0 ? `${warned} let op` : "OK";

  const rows = await Promise.all(
    checks.map(async (c) => {
      let img = "";
      if (c.screenshot_key) {
        const { data } = await db.storage
          .from("screenshots")
          .createSignedUrl(c.screenshot_key, 600);
        if (data?.signedUrl) img = `<a href="${data.signedUrl}" target="_blank">screenshot</a>`;
      }
      const lvl = rowLevel(c);
      const icon = lvl === "fail" ? "✗" : lvl === "warn" ? "!" : "✓";
      const msg = (c.messages ?? []).join("; ");
      return `<tr class="${lvl}">
        <td>${icon}</td>
        <td>${escapeHtml(c.name ?? c.path)}</td>
        <td>${c.http_status ?? "-"}</td>
        <td>${escapeHtml(msg)}</td>
        <td>${img}</td>
      </tr>`;
    }),
  );

  return `<article class="card site ${level}">
    <h3>${escapeHtml(slug)} <span class="badge">${badge}</span></h3>
    <table><tbody>${rows.join("")}</tbody></table>
  </article>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  );
}
