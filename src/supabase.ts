import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { RunSummary } from "./types";

/**
 * Schrijft een run-samenvatting naar Supabase: 1 rij in `runs`, N rijen in `checks`,
 * en upload de screenshots naar de (privé) Storage-bucket `screenshots`.
 * Zonder SUPABASE_URL / SUPABASE_SERVICE_KEY gebeurt er niets (alleen lokale results).
 */
export async function uploadResults(summary: RunSummary, resultsDir: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.log("ℹ Geen Supabase-credentials — alleen lokale results/latest.json geschreven.");
    return;
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: run, error: runErr } = await supabase
    .from("runs")
    .insert({
      trigger: summary.trigger,
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
      const { error: upErr } = await supabase.storage
        .from("screenshots")
        .upload(screenshotKey, bytes, { contentType: "image/png", upsert: true });
      if (upErr) console.error(`Screenshot-upload mislukt (${c.name}):`, upErr.message);
    }

    const { error: cErr } = await supabase.from("checks").insert({
      run_id: runId,
      site_slug: c.siteSlug,
      name: c.name,
      path: c.path,
      status: c.status,
      http_status: c.httpStatus,
      messages: c.messages,
      duration_ms: c.durationMs,
      screenshot_key: screenshotKey,
    });
    if (cErr) console.error(`Check-insert mislukt (${c.name}):`, cErr.message);
  }

  console.log(`✓ Geüpload naar Supabase (run ${runId}).`);
}
