import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Auto-enrollment endpoint. WordPress (DP Toolbox) roept dit aan bij activatie.
// Auth = eigen 'x-enroll-secret' (in app_config), daarom verify_jwt=false bij deploy.
// Nieuwe sites landen op status 'pending' en moeten in het dashboard goedgekeurd worden.

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

function makeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const incoming = req.headers.get("x-enroll-secret") ?? "";
  const { data: cfg } = await supa
    .from("app_config")
    .select("value")
    .eq("key", "enroll_secret")
    .single();
  if (!cfg || !incoming || incoming !== cfg.value) {
    return json({ error: "Ongeldig of ontbrekend enroll-secret" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const url = (body.url ?? "").toString().trim();
  const name = (body.name ?? "").toString().trim();
  if (!url) return json({ error: "url is verplicht" }, 400);

  let host = url;
  try {
    host = new URL(url).host;
  } catch { /* laat url staan */ }
  const slug = (body.slug ? makeSlug(body.slug.toString()) : makeSlug(host)) || "site";

  const { data: existing } = await supa
    .from("sites")
    .select("id, status")
    .eq("slug", slug)
    .maybeSingle();

  if (existing) {
    await supa
      .from("sites")
      .update({ name: name || undefined, base_url: url })
      .eq("id", existing.id);
    return json({ ok: true, slug, status: existing.status, message: "al bekend" });
  }

  const { data: site, error } = await supa
    .from("sites")
    .insert({ slug, name: name || host, base_url: url, status: "pending" })
    .select("id")
    .single();
  if (error) return json({ error: error.message }, 500);

  await supa.from("site_checks").insert({
    site_id: site.id,
    name: "Home",
    path: "/",
    required_selectors: ["header", "footer"],
    screenshot: true,
    sort: 0,
  });

  return json({ ok: true, slug, status: "pending", message: "aangemeld" });
});
