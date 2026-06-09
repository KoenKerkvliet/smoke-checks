import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Trapt een GitHub Actions-run af (scan of test) voor één site.
// verify_jwt=true: alleen ingelogde dashboard-gebruikers kunnen dit aanroepen.
// De GitHub-PAT staat server-side in app_config (key 'gh_token').

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

  const { data: cfg } = await supa
    .from("app_config")
    .select("value")
    .eq("key", "gh_token")
    .single();
  if (!cfg?.value) {
    return json({ error: "Geen GitHub-token geconfigureerd (app_config.gh_token)." }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const site = (body.site ?? "").toString().trim();
  const mode = body.mode === "scan" ? "scan" : "test";
  if (!site) return json({ error: "site is verplicht" }, 400);

  const repo = (body.repo ?? "KoenKerkvliet/smoke-checks").toString();
  const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.value}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "smoke-checks-dashboard",
    },
    body: JSON.stringify({ event_type: "run-requested", client_payload: { site, mode } }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return json({ error: `GitHub dispatch faalde: ${resp.status} ${text}` }, 502);
  }

  return json({ ok: true, site, mode });
});
