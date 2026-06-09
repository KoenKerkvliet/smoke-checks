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

function setUI(session) {
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

async function loadData() {
  const { data: run } = await db
    .from("runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) {
    el("meta").textContent = "Nog geen runs.";
    el("sites").innerHTML = "";
    return;
  }

  const { data: checks } = await db
    .from("checks")
    .select("*")
    .eq("run_id", run.id)
    .order("site_slug", { ascending: true });

  const when = new Date(run.created_at).toLocaleString("nl-NL");
  el("meta").innerHTML =
    `Laatste run: <strong>${when}</strong> · trigger: ${run.trigger ?? "?"} · ` +
    `<span class="${run.failed ? "bad" : "good"}">${run.passed}/${run.total} geslaagd</span>`;

  const bySite = {};
  for (const c of checks ?? []) (bySite[c.site_slug] ??= []).push(c);

  const cards = await Promise.all(
    Object.entries(bySite).map(([slug, list]) => siteCard(slug, list)),
  );
  el("sites").innerHTML = cards.join("");
}

async function siteCard(slug, checks) {
  const failed = checks.filter((c) => c.status === "fail").length;
  const ok = failed === 0;
  const rows = await Promise.all(
    checks.map(async (c) => {
      let img = "";
      if (c.screenshot_key) {
        const { data } = await db.storage
          .from("screenshots")
          .createSignedUrl(c.screenshot_key, 600);
        if (data?.signedUrl) img = `<a href="${data.signedUrl}" target="_blank">screenshot</a>`;
      }
      const msg = (c.messages ?? []).join("; ");
      return `<tr class="${c.status}">
        <td>${c.status === "pass" ? "✓" : "✗"}</td>
        <td>${escapeHtml(c.name ?? c.path)}</td>
        <td>${c.http_status ?? "-"}</td>
        <td>${escapeHtml(msg)}</td>
        <td>${img}</td>
      </tr>`;
    }),
  );

  return `<article class="card site ${ok ? "good" : "bad"}">
    <h3>${escapeHtml(slug)} <span class="badge">${ok ? "OK" : failed + " fail"}</span></h3>
    <table><tbody>${rows.join("")}</tbody></table>
  </article>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  );
}
