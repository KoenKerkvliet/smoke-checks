import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Stuurt een e-mailrapport via emailit wanneer een run problemen heeft.
// verify_jwt=true: de runner roept dit aan met de service-role-key als bearer.
// Vereiste secrets (Edge Functions → Secrets): EMAILIT_API_KEY, EMAILIT_FROM, REPORT_EMAIL.
// Optioneel: EMAILIT_REPLY_TO.

const EMAILIT_API_KEY = Deno.env.get("EMAILIT_API_KEY") ?? "";
const EMAILIT_FROM = Deno.env.get("EMAILIT_FROM") ?? "Smoke-checks <noreply@example.com>";
const EMAILIT_REPLY_TO = Deno.env.get("EMAILIT_REPLY_TO") ?? "";
const REPORT_EMAIL = Deno.env.get("REPORT_EMAIL") ?? "";
const DASHBOARD_URL = "https://koenkerkvliet.github.io/smoke-checks/";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const body: Record<string, unknown> = {
    from: EMAILIT_FROM,
    to,
    subject,
    html,
    text,
    headers: {
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
      "X-Entity-Ref-ID": crypto.randomUUID(),
    },
  };
  if (EMAILIT_REPLY_TO) body.reply_to = EMAILIT_REPLY_TO;
  const resp = await fetch("https://api.emailit.com/v2/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${EMAILIT_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`emailit ${resp.status}: ${await resp.text()}`);
}

function problemLevel(c: any): "fail" | "warn" {
  return c.status === "fail" ? "fail" : "warn";
}

/** Een check is alarmwaardig bij een fail of een 'high'-afwijking (geen 'blocked'). */
function isAlarm(c: any): boolean {
  return (
    c.status === "fail" ||
    (c.deviations ?? []).some((d: any) => d.severity === "high" && d.field !== "blocked")
  );
}

/** Handtekening van de probleemtoestand van een pagina, om 'nieuw' van 'loopt al' te onderscheiden. */
function alarmSignature(c: any): string {
  const high = (c.deviations ?? [])
    .filter((d: any) => d.severity === "high" && d.field !== "blocked")
    .map((d: any) => d.field)
    .sort()
    .join(",");
  return `${c.status}|${high}`;
}

function buildEmail(site: string, when: string, problems: any[]): { html: string; text: string } {
  const rows = problems
    .map((c) => {
      const lvl = problemLevel(c);
      const color = lvl === "fail" ? "#cf222e" : "#bf8700";
      const label = lvl === "fail" ? "FOUT" : "LET OP";
      const msg = (c.messages ?? []).join(" · ");
      return `<tr>
        <td style="padding:8px 10px;border-top:1px solid #e3e6ea;font-size:13px;color:#1f2328;">${esc(c.path)}</td>
        <td style="padding:8px 10px;border-top:1px solid #e3e6ea;"><span style="background:${color};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;">${label}</span></td>
        <td style="padding:8px 10px;border-top:1px solid #e3e6ea;font-size:13px;color:#57606a;">${esc(msg)}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="nl"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>Smoke-checks rapport</title></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f5f6f8;opacity:0;">Smoke-checks vond ${problems.length} afwijking(en) op ${esc(site)}.</div>
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f6f8"><tr><td align="center" style="padding:24px 12px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e3e6ea;">
<tr><td bgcolor="#1c2128" style="background:#1c2128;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Smoke-checks</td></tr>
<tr><td style="padding:24px;">
<h2 style="margin:0 0 6px;font-size:18px;color:#1f2328;">Afwijkingen gevonden op ${esc(site)}</h2>
<p style="margin:0 0 18px;font-size:14px;color:#57606a;">Bij de controle van <strong>${esc(when)}</strong> zijn ${problems.length} pagina('s) met problemen aangetroffen:</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#57606a;">Pagina</th><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#57606a;">Status</th><th align="left" style="padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#57606a;">Wat</th></tr>
${rows}
</table>
<p style="text-align:center;margin:26px 0 8px;"><a href="${DASHBOARD_URL}" style="background:#1f6feb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:7px;display:inline-block;">Bekijk in dashboard</a></p>
</td></tr>
<tr><td bgcolor="#f9fafb" style="background:#f9fafb;padding:14px 24px;color:#8b949e;font-size:12px;">Automatisch bericht van Smoke-checks. Je ontvangt dit omdat een controle problemen vond.</td></tr>
</table></td></tr></table></body></html>`;

  const textRows = problems.map((c) => `- ${c.path} [${problemLevel(c) === "fail" ? "FOUT" : "LET OP"}]: ${(c.messages ?? []).join(" / ")}`).join("\n");
  const text = `Smoke-checks rapport\n\nAfwijkingen gevonden op ${site} (controle ${when}).\n\n${textRows}\n\nBekijk in dashboard:\n${DASHBOARD_URL}\n\n--\nAutomatisch bericht van Smoke-checks.`;

  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!EMAILIT_API_KEY || !REPORT_EMAIL) {
    return json({ ok: true, skipped: "e-mail niet geconfigureerd (EMAILIT_API_KEY / REPORT_EMAIL)" });
  }

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { run_id } = await req.json().catch(() => ({}));
  if (!run_id) return json({ error: "run_id is verplicht" }, 400);

  const { data: run } = await supa.from("runs").select("created_at").eq("id", run_id).single();
  const runAt = run?.created_at ?? new Date().toISOString();
  const { data: checks } = await supa.from("checks").select("*").eq("run_id", run_id);

  // Stap 1: alleen echte problemen (fail of 'high'-afwijking). 'medium'-drift = geen mail.
  const candidates = (checks ?? []).filter(isAlarm);
  if (candidates.length === 0) return json({ ok: true, no_problems: true });

  // Stap 2: alleen NIEUWE/gewijzigde problemen mailen. Een probleem dat in de vorige
  // run voor dezelfde pagina al exact zo bestond, loopt nog en wordt niet opnieuw
  // gemaild (voorkomt elke run dezelfde mail). Een nieuw of gewijzigd probleem wel.
  const problems: any[] = [];
  for (const c of candidates) {
    const { data: prev } = await supa
      .from("checks")
      .select("status,deviations,created_at")
      .eq("site_slug", c.site_slug)
      .eq("path", c.path)
      .lt("created_at", runAt)
      .order("created_at", { ascending: false })
      .limit(1);
    const prevCheck = prev?.[0];
    const wasAlarm = prevCheck ? isAlarm(prevCheck) : false;
    const unchanged = wasAlarm && alarmSignature(prevCheck) === alarmSignature(c);
    if (!unchanged) problems.push(c);
  }
  if (problems.length === 0) return json({ ok: true, no_new: true });

  const site = [...new Set(problems.map((c: any) => c.site_slug))].join(", ");
  const when = run?.created_at ? new Date(run.created_at).toLocaleString("nl-NL") : "recent";
  const subject = `Smoke-checks: ${problems.length} afwijking${problems.length === 1 ? "" : "en"} op ${site}`;
  const { html, text } = buildEmail(site, when, problems);

  await sendEmail(REPORT_EMAIL, subject, html, text);
  return json({ ok: true, sent: true, problems: problems.length });
});
