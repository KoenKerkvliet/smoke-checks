import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Door WordPress (DP Toolbox) aangeroepen na een plugin-/thema-/core-update.
// Auth = het publieke enroll-token (app_config.enroll_secret). verify_jwt=false.
// Trapt een 'test'-run (drift) af voor de site via de server-side gh_token.
// Debounce: max 1 trigger per 2 min per site; alleen actieve sites.

const DEBOUNCE_MS = 120000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-enroll-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const incoming = req.headers.get("x-enroll-secret") ?? "";
  const { data: secretCfg } = await supa
    .from("app_config").select("value").eq("key", "enroll_secret").single();
  if (!secretCfg || !incoming || incoming !== secretCfg.value) {
    return json({ error: "Ongeldig of ontbrekend secret" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const site = (body.site ?? "").toString().trim();
  if (!site) return json({ error: "site is verplicht" }, 400);

  const { data: row } = await supa
    .from("sites").select("id, status, last_triggered_at").eq("slug", site).maybeSingle();
  if (!row || row.status !== "active") {
    return json({ ok: true, skipped: "site onbekend of niet actief" });
  }

  if (row.last_triggered_at) {
    const age = Date.now() - new Date(row.last_triggered_at as string).getTime();
    if (age < DEBOUNCE_MS) return json({ ok: true, debounced: true });
  }

  const { data: ghCfg } = await supa
    .from("app_config").select("value").eq("key", "gh_token").single();
  if (!ghCfg?.value) return json({ error: "Geen GitHub-token geconfigureerd." }, 500);

  const repo = (body.repo ?? "KoenKerkvliet/smoke-checks").toString();
  const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ghCfg.value}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "smoke-checks-notify",
    },
    body: JSON.stringify({ event_type: "run-requested", client_payload: { site, mode: "test" } }),
  });
  if (!resp.ok) {
    return json({ error: `GitHub dispatch faalde: ${resp.status} ${await resp.text()}` }, 502);
  }

  await supa.from("sites").update({ last_triggered_at: new Date().toISOString() }).eq("id", row.id);
  return json({ ok: true, site, triggered: true });
});
