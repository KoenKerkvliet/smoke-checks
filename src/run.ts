import { chromium, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig, CheckResult, RunSummary, Baseline } from "./types";
import { loadSites } from "./config";
import { crawlSite } from "./crawl";
import { visitPage } from "./fingerprint";
import { compareFingerprints } from "./diff";
import { uploadResults, loadBaselines, saveBaselines } from "./supabase";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RESULTS_DIR = join(ROOT, "results");
const CRAWL_LIMIT = Number(process.env.CRAWL_LIMIT) || 15;

/* ---------------- Scan: nulmeting vastleggen ---------------- */
async function scanSite(browser: Browser, site: SiteConfig): Promise<CheckResult[]> {
  const ctx = await browser.newContext();
  const visits = await crawlSite(ctx, site.baseUrl, site.slug, RESULTS_DIR, CRAWL_LIMIT);
  await ctx.close();

  const baselines: Baseline[] = visits
    .filter((v) => v.fingerprint)
    .map((v) => ({
      path: v.path,
      url: v.url,
      httpStatus: v.httpStatus,
      fingerprint: v.fingerprint!,
      screenshotPath: v.screenshotPath,
    }));

  await saveBaselines(site.slug, baselines, RESULTS_DIR);

  return visits.map((v) => {
    const ok = !v.error && (v.httpStatus ?? 0) < 400;
    return {
      siteSlug: site.slug,
      path: v.path,
      name: v.path,
      status: ok ? "pass" : "fail",
      httpStatus: v.httpStatus,
      messages: v.error ? [v.error] : ["nulmeting vastgelegd"],
      durationMs: 0,
      screenshotPath: v.screenshotPath,
      fingerprint: v.fingerprint,
    };
  });
}

/* ---------------- Test: drift t.o.v. nulmeting ---------------- */
async function testSite(browser: Browser, site: SiteConfig): Promise<CheckResult[]> {
  const baselines = await loadBaselines(site.slug, RESULTS_DIR);
  const ctx = await browser.newContext();
  const results: CheckResult[] = [];

  if (baselines.length === 0) {
    // Geen nulmeting: val terug op een simpele homepage-laadcheck.
    const v = await visitPage(ctx, new URL("/", site.baseUrl).toString(), {
      screenshot: true,
      resultsDir: RESULTS_DIR,
      siteSlug: site.slug,
      path: "/",
    });
    await ctx.close();
    const ok = !v.error && (v.httpStatus ?? 0) < 400;
    return [
      {
        siteSlug: site.slug,
        path: "/",
        name: "Home",
        status: ok ? "pass" : "fail",
        httpStatus: v.httpStatus,
        messages: v.error ? [v.error] : ["Geen nulmeting — alleen homepage geladen. Doe een scan."],
        durationMs: 0,
        screenshotPath: v.screenshotPath,
        fingerprint: v.fingerprint,
      },
    ];
  }

  for (const base of baselines) {
    const start = Date.now();
    const v = await visitPage(ctx, new URL(base.path, site.baseUrl).toString(), {
      screenshot: true,
      resultsDir: RESULTS_DIR,
      siteSlug: site.slug,
      path: base.path,
    });

    const messages: string[] = [];
    let status: "pass" | "fail" = "pass";

    if (v.error || !v.fingerprint) {
      status = "fail";
      messages.push(v.error ?? "Geen fingerprint kunnen maken");
    }

    const deviations = v.fingerprint
      ? compareFingerprints(base.fingerprint, v.fingerprint, base.httpStatus, v.httpStatus)
      : [];

    if (deviations.some((d) => d.severity === "high")) status = "fail";
    if (deviations.length === 0 && status === "pass") {
      messages.push("Geen afwijkingen t.o.v. nulmeting");
    } else {
      for (const d of deviations) messages.push(`${d.severity === "high" ? "⚠" : "•"} ${d.message}`);
    }

    results.push({
      siteSlug: site.slug,
      path: base.path,
      name: base.path,
      status,
      httpStatus: v.httpStatus,
      messages,
      durationMs: Date.now() - start,
      screenshotPath: v.screenshotPath,
      deviations,
      fingerprint: v.fingerprint,
    });
  }

  await ctx.close();
  return results;
}

/* ---------------- Orchestratie ---------------- */
async function main(): Promise<void> {
  const mode: "scan" | "test" = process.env.RUN_MODE === "scan" ? "scan" : "test";
  const filter = process.env.SITE_FILTER?.trim() || process.argv[2];
  const sites = await loadSites(filter);

  if (sites.length === 0) {
    console.log(`Geen actieve sites${filter ? ` voor filter '${filter}'` : ""} — niets te doen.`);
    return; // geen harde fout (lege run)
  }

  const browser = await chromium.launch();
  const all: CheckResult[] = [];

  for (const site of sites) {
    console.log(`▶ ${mode === "scan" ? "Scan" : "Test"}: ${site.name} (${site.slug})`);
    const r = mode === "scan" ? await scanSite(browser, site) : await testSite(browser, site);
    for (const c of r) {
      const icon = c.status === "pass" ? "✓" : "✗";
      console.log(`   ${icon} ${c.name}${c.messages.length ? " — " + c.messages.join("; ") : ""}`);
    }
    all.push(...r);
  }
  await browser.close();

  const summary: RunSummary = {
    generatedAt: new Date().toISOString(),
    trigger: process.env.RUN_TRIGGER ?? "manual",
    mode,
    commit: process.env.GITHUB_SHA ?? null,
    totals: {
      total: all.length,
      passed: all.filter((c) => c.status === "pass").length,
      failed: all.filter((c) => c.status === "fail").length,
    },
    checks: all,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, "latest.json"), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.totals.passed}/${summary.totals.total} geslaagd (mode: ${mode}).`);

  await uploadResults(summary, RESULTS_DIR).catch((e) =>
    console.error("Supabase-upload overgeslagen/mislukt:", e instanceof Error ? e.message : e),
  );

  // Alleen test-runs falen de CI bij afwijkingen; een scan legt enkel vast.
  if (mode === "test" && summary.totals.failed > 0) process.exitCode = 1;
}

void main();
