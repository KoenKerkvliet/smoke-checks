import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RunSummary, Baseline } from "./types";

function getClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/* ---------------- Baselines (nulmeting) ---------------- */

function localBaselinePath(resultsDir: string, slug: string): string {
  return join(resultsDir, "baselines", `${slug}.json`);
}

export async function loadBaselines(slug: string, resultsDir: string): Promise<Baseline[]> {
  const db = getClient();
  if (!db) {
    const p = localBaselinePath(resultsDir, slug);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Baseline[]) : [];
  }

  const { data, error } = await db
    .from("sites")
    .select("id, baselines(path,url,http_status,fingerprint,screenshot_key)")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;

  const rows = (data?.baselines ?? []) as Record<string, unknown>[];
  return rows.map((b) => ({
    path: b.path as string,
    url: (b.url as string) ?? "",
    httpStatus: (b.http_status as number) ?? null,
    fingerprint: b.fingerprint as Baseline["fingerprint"],
    screenshotPath: (b.screenshot_key as string) ?? undefined,
  }));
}

export async function saveBaselines(
  slug: string,
  baselines: Baseline[],
  resultsDir: string,
): Promise<void> {
  const db = getClient();
  if (!db) {
    const p = localBaselinePath(resultsDir, slug);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(baselines, null, 2));
    console.log(`ℹ Nulmeting lokaal opgeslagen (${baselines.length} pagina's): ${p}`);
    return;
  }

  const { data: site, error: sErr } = await db
    .from("sites")
    .select("id")
    .eq("slug", slug)
    .single();
  if (sErr) throw sErr;
  const siteId = site.id as string;

  // Verwijder oude nulmeting en herschrijf.
  await db.from("baselines").delete().eq("site_id", siteId);

  for (const b of baselines) {
    let screenshotKey: string | null = null;
    if (b.screenshotPath) {
      const bytes = readFileSync(join(resultsDir, b.screenshotPath));
      screenshotKey = `baselines/${slug}/${b.screenshotPath.split("/").pop()}`;
      const { error: upErr } = await db.storage
        .from("screenshots")
        .upload(screenshotKey, bytes, { contentType: "image/png", upsert: true });
      if (upErr) console.error(`Baseline-screenshot upload mislukt (${b.path}):`, upErr.message);
    }
    const { error: insErr } = await db.from("baselines").insert({
      site_id: siteId,
      path: b.path,
      url: b.url,
      http_status: b.httpStatus,
      fingerprint: b.fingerprint,
      screenshot_key: screenshotKey,
    });
    if (insErr) console.error(`Baseline-insert mislukt (${b.path}):`, insErr.message);
  }
  console.log(`✓ Nulmeting opgeslagen in Supabase (${baselines.length} pagina's).`);
}

/* ---------------- Run-resultaten ---------------- */

export async function uploadResults(summary: RunSummary, resultsDir: string): Promise<string | null> {
  const db = getClient();
  if (!db) {
    console.log("ℹ Geen Supabase-credentials — alleen lokale results/latest.json geschreven.");
    return null;
  }

  const { data: run, error: runErr } = await db
    .from("runs")
    .insert({
      trigger: summary.trigger,
      mode: summary.mode,
      commit_sha: summary.commit,
      total: summary.totals.total,
      passed: summary.totals.passed,
      failed: summary.totals.failed,
    })
    .select("id")
    .single();
  if (runErr) throw runErr;
  const runId = run.id as string;

  for (const c of summary.checks) {
    let screenshotKey: string | null = null;
    if (c.screenshotPath) {
      const bytes = readFileSync(join(resultsDir, c.screenshotPath));
      screenshotKey = `${runId}/${c.screenshotPath.replace(/^screenshots\//, "")}`;
      const { error: upErr } = await db.storage
        .from("screenshots")
        .upload(screenshotKey, bytes, { contentType: "image/png", upsert: true });
      if (upErr) console.error(`Screenshot-upload mislukt (${c.name}):`, upErr.message);
    }

    const { error: cErr } = await db.from("checks").insert({
      run_id: runId,
      site_slug: c.siteSlug,
      name: c.name,
      path: c.path,
      status: c.status,
      http_status: c.httpStatus,
      messages: c.messages,
      duration_ms: c.durationMs,
      screenshot_key: screenshotKey,
      deviations: c.deviations ?? [],
      fingerprint: c.fingerprint ?? null,
    });
    if (cErr) console.error(`Check-insert mislukt (${c.name}):`, cErr.message);
  }

  console.log(`✓ Geüpload naar Supabase (run ${runId}, mode ${summary.mode}).`);
  return runId;
}

/**
 * Vraagt de send-report edge function om een e-mailrapport te sturen (alleen bij problemen).
 * Authenticeert met de service-role-key als bearer (de functie draait verify_jwt=true).
 */
export async function maybeSendReport(runId: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !runId) return;

  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/functions/v1/send-report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.sent) console.log(`✉ E-mailrapport verstuurd (${data.problems} probleem/problemen).`);
    else if (data.skipped) console.log(`ℹ E-mail overgeslagen: ${data.skipped}`);
    else if (data.no_problems) console.log("ℹ Geen e-mail nodig (geen problemen).");
    else if (!resp.ok) console.error(`E-mailrapport faalde: ${resp.status}`, data);
  } catch (e) {
    console.error("E-mailrapport mislukt:", e instanceof Error ? e.message : e);
  }
}
