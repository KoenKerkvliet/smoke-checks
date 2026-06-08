import { chromium, type Browser } from "playwright";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig, CheckResult, RunSummary } from "./types";
import { uploadResults } from "./supabase";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SITES_DIR = join(ROOT, "sites");
const RESULTS_DIR = join(ROOT, "results");

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "page";
}

function loadSites(filter?: string): SiteConfig[] {
  const files = readdirSync(SITES_DIR).filter((f) => f.endsWith(".json"));
  const sites = files.map(
    (f) => JSON.parse(readFileSync(join(SITES_DIR, f), "utf8")) as SiteConfig,
  );
  return filter ? sites.filter((s) => s.slug === filter) : sites;
}

async function runSite(browser: Browser, site: SiteConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const ctx = await browser.newContext();

  for (const check of site.checks) {
    const page = await ctx.newPage();
    const url = new URL(check.path, site.baseUrl).toString();
    const name = check.name ?? check.path;
    const messages: string[] = [];
    let httpStatus: number | null = null;
    let status: "pass" | "fail" = "pass";
    let screenshotPath: string | undefined;
    const start = Date.now();

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      httpStatus = resp?.status() ?? null;
      if (!resp || !resp.ok()) {
        status = "fail";
        messages.push(`HTTP ${httpStatus ?? "geen respons"}`);
      }

      for (const sel of check.requiredSelectors ?? []) {
        const visible = await page
          .locator(sel)
          .first()
          .isVisible()
          .catch(() => false);
        if (!visible) {
          status = "fail";
          messages.push(`Ontbreekt/onzichtbaar: ${sel}`);
        }
      }

      if (check.requiredText?.length) {
        const body = (await page.textContent("body").catch(() => "")) ?? "";
        for (const txt of check.requiredText) {
          if (!body.includes(txt)) {
            status = "fail";
            messages.push(`Tekst ontbreekt: "${txt}"`);
          }
        }
      }

      if (check.screenshot !== false) {
        const rel = `screenshots/${site.slug}/${slugify(name)}.png`;
        const abs = join(RESULTS_DIR, rel);
        mkdirSync(dirname(abs), { recursive: true });
        await page.screenshot({ path: abs, fullPage: true });
        screenshotPath = rel;
      }
    } catch (e) {
      status = "fail";
      messages.push(e instanceof Error ? e.message : String(e));
    }

    results.push({
      siteSlug: site.slug,
      path: check.path,
      name,
      status,
      httpStatus,
      messages,
      durationMs: Date.now() - start,
      screenshotPath,
    });
    await page.close();
  }

  await ctx.close();
  return results;
}

async function main(): Promise<void> {
  const filter = process.env.SITE_FILTER?.trim() || process.argv[2];
  const sites = loadSites(filter);
  if (sites.length === 0) {
    console.error(`Geen sites gevonden${filter ? ` voor filter '${filter}'` : ""}.`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const all: CheckResult[] = [];

  for (const site of sites) {
    console.log(`▶ ${site.name} (${site.slug})`);
    const r = await runSite(browser, site);
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
  console.log(`\n${summary.totals.passed}/${summary.totals.total} checks geslaagd.`);

  await uploadResults(summary, RESULTS_DIR).catch((e) =>
    console.error("Supabase-upload overgeslagen/mislukt:", e instanceof Error ? e.message : e),
  );

  if (summary.totals.failed > 0) process.exitCode = 1;
}

void main();
