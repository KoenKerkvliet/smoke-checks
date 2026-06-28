import { chromium, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig, CheckResult, RunSummary, Baseline } from "./types";
import { loadSites } from "./config";
import { crawlSite } from "./crawl";
import { visitPage } from "./fingerprint";
import { compareFingerprints, looksBlocked, looksMaintenance, looksUnreachable } from "./diff";
import {
  uploadResults,
  loadBaselines,
  saveBaselines,
  maybeSendReport,
  recentUnreachableStreak,
} from "./supabase";
import type { VisitResult } from "./fingerprint";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RESULTS_DIR = join(ROOT, "results");
const CRAWL_LIMIT = Number(process.env.CRAWL_LIMIT) || 15;
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS) || 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Realistische browser-UA i.p.v. Playwright's "HeadlessChrome" (triggert minder bot-protectie).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function newCtx(browser: Browser) {
  return browser.newContext({ userAgent: USER_AGENT, locale: "nl-NL" });
}

function blockedResult(slug: string, path: string, v: VisitResult, suffix: string): CheckResult {
  return {
    siteSlug: slug,
    path,
    name: path,
    status: "pass",
    httpStatus: v.httpStatus,
    messages: [`Geblokkeerd door bot-bescherming (HTTP ${v.httpStatus ?? "?"}) — ${suffix}`],
    durationMs: 0,
    screenshotPath: v.screenshotPath,
    deviations: [
      {
        field: "blocked",
        baseline: null,
        current: v.httpStatus,
        severity: "medium",
        message: "Geblokkeerd door bot-bescherming (challenge-pagina)",
      },
    ],
    fingerprint: v.fingerprint,
  };
}

function maintenanceResult(slug: string, path: string, v: VisitResult): CheckResult {
  return {
    siteSlug: slug,
    path,
    name: path,
    status: "pass",
    httpStatus: v.httpStatus,
    messages: ["Onderhoudsmodus gedetecteerd — overgeslagen (geen alarm)"],
    durationMs: 0,
    screenshotPath: v.screenshotPath,
    deviations: [
      {
        field: "maintenance",
        baseline: null,
        current: v.fingerprint?.title ?? null,
        severity: "medium",
        message: "Site staat in onderhoudsmodus",
      },
    ],
    fingerprint: v.fingerprint,
  };
}

/**
 * Bouwt het resultaat voor een onbereikbare pagina (timeout/connection-fout).
 * Normaal 'inconclusief' (pass, medium → geen mail). Pas bij de 3e keer op rij
 * onbereikbaar escaleren naar een echt alarm (fail, high → mail één keer).
 */
function unreachableResult(slug: string, path: string, v: VisitResult, priorStreak: number): CheckResult {
  const total = priorStreak + 1;
  const escalate = total >= 3;
  return {
    siteSlug: slug,
    path,
    name: path,
    status: escalate ? "fail" : "pass",
    httpStatus: v.httpStatus,
    messages: [
      escalate
        ? `Site al ${total} runs op rij onbereikbaar (timeout/connection) — mogelijk down`
        : "Site onbereikbaar (timeout/connection) — niet als fout gerekend (inconclusief)",
    ],
    durationMs: 0,
    deviations: [
      {
        field: "unreachable",
        baseline: null,
        current: v.error ?? "onbereikbaar",
        severity: escalate ? "high" : "medium",
        message: escalate
          ? `Onbereikbaar (${total}e keer op rij)`
          : "Onbereikbaar (timeout/connection)",
      },
    ],
    fingerprint: null,
  };
}

/* ---------------- Scan: nulmeting vastleggen ---------------- */
async function scanSite(browser: Browser, site: SiteConfig): Promise<CheckResult[]> {
  const ctx = await newCtx(browser);
  const visits = await crawlSite(ctx, site.baseUrl, site.slug, RESULTS_DIR, CRAWL_LIMIT, REQUEST_DELAY_MS);
  await ctx.close();

  const baselines: Baseline[] = visits
    .filter(
      (v) =>
        v.fingerprint &&
        !looksBlocked(v.httpStatus, v.fingerprint) &&
        !looksMaintenance(v.fingerprint),
    )
    .map((v) => ({
      path: v.path,
      url: v.url,
      httpStatus: v.httpStatus,
      fingerprint: v.fingerprint!,
      screenshotPath: v.screenshotPath,
    }));

  await saveBaselines(site.slug, baselines, RESULTS_DIR);

  return visits.map((v) => {
    if (looksBlocked(v.httpStatus, v.fingerprint))
      return blockedResult(site.slug, v.path, v, "niet als nulmeting vastgelegd");
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
  const ctx = await newCtx(browser);
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

  let firstPage = true;
  for (const base of baselines) {
    if (!firstPage) await sleep(REQUEST_DELAY_MS);
    firstPage = false;
    const start = Date.now();
    const url = new URL(base.path, site.baseUrl).toString();
    let v = await visitPage(ctx, url, {
      screenshot: true,
      resultsDir: RESULTS_DIR,
      siteSlug: site.slug,
      path: base.path,
    });

    // Onbereikbaar (timeout/connection): inconclusief, pas alarm na 3x op rij.
    if (v.error && looksUnreachable(v.error)) {
      const streak = await recentUnreachableStreak(site.slug, base.path);
      results.push(unreachableResult(site.slug, base.path, v, streak));
      continue;
    }

    if (looksBlocked(v.httpStatus, v.fingerprint)) {
      results.push(blockedResult(site.slug, base.path, v, "drift niet vergeleken"));
      continue;
    }

    // Onderhoudsmodus: geen echte fout, overslaan.
    if (looksMaintenance(v.fingerprint)) {
      results.push(maintenanceResult(site.slug, base.path, v));
      continue;
    }

    const messages: string[] = [];
    let status: "pass" | "fail" = "pass";

    if (v.error || !v.fingerprint) {
      status = "fail";
      messages.push(v.error ?? "Geen fingerprint kunnen maken");
    }

    let deviations = v.fingerprint
      ? compareFingerprints(base.fingerprint, v.fingerprint, base.httpStatus, v.httpStatus)
      : [];

    // Hermeten bij drift: zien we afwijkingen, laad de pagina dan nog één keer en
    // houd alleen de afwijkingen die in BEIDE metingen voorkomen. Toevallige
    // laad-hikjes (lazy content die net niet klaar was) komen één keer voor en
    // worden zo weggefilterd; echte regressies blijven staan.
    if (deviations.length > 0 && v.fingerprint && !v.error) {
      await sleep(REQUEST_DELAY_MS);
      const v2 = await visitPage(ctx, url, {
        screenshot: true,
        resultsDir: RESULTS_DIR,
        siteSlug: site.slug,
        path: base.path,
      });
      if (!looksBlocked(v2.httpStatus, v2.fingerprint) && v2.fingerprint && !v2.error) {
        const dev2 = compareFingerprints(base.fingerprint, v2.fingerprint, base.httpStatus, v2.httpStatus);
        const firstFields = new Set(deviations.map((d) => d.field));
        const persisted = dev2.filter((d) => firstFields.has(d.field));
        const dropped = deviations.length - persisted.length;
        if (dropped > 0) {
          messages.push(
            `${dropped} afwijking(en) vielen weg bij hermeten (waarschijnlijk laadtiming) — genegeerd`,
          );
        }
        deviations = persisted;
        v = v2; // toon de waarden en screenshot van de tweede, stabielere meting
      }
    }

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

  const runId = await uploadResults(summary, RESULTS_DIR).catch((e) => {
    console.error("Supabase-upload overgeslagen/mislukt:", e instanceof Error ? e.message : e);
    return null;
  });

  // E-mailrapport ALLEEN bij echte problemen: een fail, of een afwijking met
  // severity 'high' (landmark verdwenen, telling → 0, HTTP-fout, tekst weg).
  // 'medium'-drift ("sterk veranderd", titelwijziging e.d.) is op levende sites
  // meestal ruis en blijft alleen zichtbaar in het dashboard — geen mail.
  const notable = all.some(
    (c) =>
      c.status === "fail" ||
      (c.deviations ?? []).some((d) => d.severity === "high" && d.field !== "blocked"),
  );
  if (runId && notable) await maybeSendReport(runId);

  // Alleen test-runs falen de CI bij afwijkingen; een scan legt enkel vast.
  if (mode === "test" && summary.totals.failed > 0) process.exitCode = 1;
}

void main();
