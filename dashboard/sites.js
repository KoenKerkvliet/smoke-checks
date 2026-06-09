/* global supabase */
const cfg = window.SMOKE_CONFIG;
const el = (id) => document.getElementById(id);

if (!window.supabase || !cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
  el("loading").textContent = "Geen config of Supabase-library geladen (controleer config.js).";
  throw new Error("Missing config/library");
}

const db = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
const show = (id, on = true) => el(id).toggleAttribute("hidden", !on);

let sites = [];
let selectedId = null;

/* ---------- auth ---------- */
async function render(session) {
  show("login", !session);
  show("mgr", !!session);
  show("logout", !!session);
  show("loading", false);
  if (session) await loadSites();
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
db.auth.onAuthStateChange((_e, session) => render(session));
db.auth.getSession().then(({ data }) => render(data.session));

/* ---------- data ---------- */
async function loadSites() {
  const { data, error } = await db
    .from("sites")
    .select("id,slug,name,base_url,status,site_checks(id,name,path,required_selectors,required_text,screenshot,sort)")
    .order("created_at", { ascending: true });
  if (error) {
    el("editor").innerHTML = `<p class="error">Laden mislukt: ${esc(error.message)}</p>`;
    return;
  }
  sites = (data ?? []).map((s) => ({
    ...s,
    site_checks: (s.site_checks ?? []).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
  }));
  renderPending();
  renderList();
  if (selectedId && sites.some((s) => s.id === selectedId)) renderEditor(selectedId);
}

/* ---------- pending ---------- */
function renderPending() {
  const pending = sites.filter((s) => s.status === "pending");
  show("pending-wrap", pending.length > 0);
  el("pending").innerHTML = pending
    .map(
      (s) => `<div class="pending-item" data-id="${s.id}">
        <div><strong>${esc(s.name)}</strong><small>${esc(s.base_url)} · slug: ${esc(s.slug)}</small></div>
        <div class="row">
          <button class="btn" data-approve="${s.id}">Goedkeuren</button>
          <button class="btn ghost" data-reject="${s.id}">Weigeren</button>
        </div>
      </div>`,
    )
    .join("");
}

el("pending").addEventListener("click", async (e) => {
  const ok = e.target.getAttribute("data-approve");
  const no = e.target.getAttribute("data-reject");
  if (ok) {
    await db.from("sites").update({ status: "active" }).eq("id", ok);
    await loadSites();
  } else if (no) {
    if (confirm("Deze aanmelding weigeren en verwijderen?")) {
      await db.from("sites").delete().eq("id", no);
      await loadSites();
    }
  }
});

/* ---------- site list ---------- */
function renderList() {
  const list = sites.filter((s) => s.status !== "pending");
  el("site-list").innerHTML =
    list
      .map((s) => {
        const dot = s.status === "active" ? "good" : "muted-dot";
        const host = hostOf(s.base_url);
        const n = s.site_checks.length;
        return `<div class="site-item ${s.id === selectedId ? "active" : ""}" data-id="${s.id}">
          <div><strong>${esc(s.name)}</strong><small>${esc(host)} · ${n} pagina${n === 1 ? "" : "'s"}</small></div>
          <span><span class="dot ${dot}"></span>${s.status === "active" ? "actief" : "uit"}</span>
        </div>`;
      })
      .join("") || `<p class="muted">Nog geen sites.</p>`;
}

el("site-list").addEventListener("click", (e) => {
  const item = e.target.closest(".site-item");
  if (item) {
    selectedId = item.getAttribute("data-id");
    renderList();
    renderEditor(selectedId);
  }
});

el("add-site").addEventListener("click", async () => {
  const suffix = Math.floor(Date.now() / 1000) % 100000;
  const { data, error } = await db
    .from("sites")
    .insert({ name: "Nieuwe site", slug: `nieuwe-site-${suffix}`, base_url: "https://", status: "active" })
    .select("id")
    .single();
  if (error) return alert(error.message);
  selectedId = data.id;
  await loadSites();
});

/* ---------- editor ---------- */
function renderEditor(id) {
  const s = sites.find((x) => x.id === id);
  if (!s) return;
  const rows = s.site_checks
    .map((c, i) => checkRow(c, i))
    .join("");
  el("editor").innerHTML = `
    <div class="head">
      <h2>${esc(s.name)}</h2>
      <div class="row">
        <button class="btn ghost" id="del-site">Verwijderen</button>
        <button class="btn" id="save-site">Opslaan</button>
      </div>
    </div>
    <div class="row wrap fields">
      <div class="f"><label>Naam</label><input type="text" id="f-name" value="${esc(s.name)}"></div>
      <div class="f"><label>Slug (DP Toolbox-signaal)</label><input type="text" id="f-slug" value="${esc(s.slug)}"></div>
      <div class="f grow"><label>Basis-URL</label><input type="url" id="f-url" value="${esc(s.base_url)}"></div>
      <div class="f"><label>Status</label>
        <select id="f-status">
          <option value="active" ${s.status === "active" ? "selected" : ""}>Actief</option>
          <option value="disabled" ${s.status === "disabled" ? "selected" : ""}>Uit</option>
        </select>
      </div>
    </div>

    <label class="section-label">Te controleren pagina's</label>
    <table class="checks">
      <thead><tr><th>Naam</th><th>Pad</th><th>Verplichte selectors (komma)</th><th>Screenshot</th><th></th></tr></thead>
      <tbody id="check-rows">${rows}</tbody>
      <tfoot><tr class="addrow"><td colspan="5" id="add-row">+ Pagina toevoegen</td></tr></tfoot>
    </table>
    <p class="muted">Per pagina: laadt ze (HTTP 200) en checkt of de selectors zichtbaar zijn. Selectors leeg = alleen "pagina laadt".</p>
    <p id="save-msg" class="muted"></p>`;

  el("add-row").addEventListener("click", () => {
    el("check-rows").insertAdjacentHTML("beforeend", checkRow({ screenshot: true }, Date.now()));
  });
  el("check-rows").addEventListener("click", (e) => {
    if (e.target.classList.contains("del")) e.target.closest("tr").remove();
  });
  el("save-site").addEventListener("click", () => saveSite(id));
  el("del-site").addEventListener("click", () => deleteSite(id, s.name));
}

function checkRow(c, key) {
  const sel = (c.required_selectors ?? []).join(", ");
  return `<tr data-key="${key}">
    <td><input type="text" class="c-name" value="${esc(c.name ?? "")}" placeholder="Home"></td>
    <td><input type="text" class="c-path" value="${esc(c.path ?? "/")}" placeholder="/"></td>
    <td><input type="text" class="c-sel" value="${esc(sel)}" placeholder="header, footer"></td>
    <td style="text-align:center"><input type="checkbox" class="c-shot" ${c.screenshot !== false ? "checked" : ""}></td>
    <td><button class="del" title="Verwijderen">×</button></td>
  </tr>`;
}

async function saveSite(id) {
  const msg = el("save-msg");
  msg.textContent = "Opslaan…";

  const { error: upErr } = await db
    .from("sites")
    .update({
      name: el("f-name").value.trim(),
      slug: el("f-slug").value.trim(),
      base_url: el("f-url").value.trim(),
      status: el("f-status").value,
    })
    .eq("id", id);
  if (upErr) return void (msg.innerHTML = `<span class="bad">${esc(upErr.message)}</span>`);

  // Checks: simpel en betrouwbaar — verwijder bestaande en herschrijf vanuit het formulier.
  await db.from("site_checks").delete().eq("site_id", id);
  const rows = [...document.querySelectorAll("#check-rows tr")];
  const payload = rows.map((tr, i) => ({
    site_id: id,
    name: tr.querySelector(".c-name").value.trim() || null,
    path: tr.querySelector(".c-path").value.trim() || "/",
    required_selectors: tr
      .querySelector(".c-sel")
      .value.split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    screenshot: tr.querySelector(".c-shot").checked,
    sort: i,
  }));
  if (payload.length) {
    const { error: cErr } = await db.from("site_checks").insert(payload);
    if (cErr) return void (msg.innerHTML = `<span class="bad">${esc(cErr.message)}</span>`);
  }

  msg.innerHTML = `<span class="good">Opgeslagen ✓</span>`;
  await loadSites();
}

async function deleteSite(id, name) {
  if (!confirm(`Site "${name}" verwijderen?`)) return;
  await db.from("sites").delete().eq("id", id);
  selectedId = null;
  el("editor").innerHTML = `<p class="muted">Kies links een site om te bewerken, of voeg er een toe.</p>`;
  await loadSites();
}

/* ---------- utils ---------- */
function hostOf(u) {
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  );
}
