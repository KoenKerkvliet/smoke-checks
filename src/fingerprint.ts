import type { BrowserContext } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Fingerprint } from "./types";

export interface VisitResult {
  path: string;
  url: string;
  httpStatus: number | null;
  fingerprint: Fingerprint | null;
  /** Interne links (zelfde host), als genormaliseerde paden. */
  internalPaths: string[];
  screenshotPath?: string;
  error?: string;
}

function slugifyPath(path: string): string {
  const s = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return s || "home";
}

/**
 * Bezoekt één URL en legt status, fingerprint, interne links en (optioneel) screenshot vast.
 */
export async function visitPage(
  ctx: BrowserContext,
  url: string,
  opts: { screenshot?: boolean; resultsDir: string; siteSlug: string } & { path: string },
): Promise<VisitResult> {
  const page = await ctx.newPage();
  // tsx/esbuild injecteert een __name-helper in geserialiseerde evaluate-functies;
  // shim 'm in de browser (string-vorm zodat esbuild 'm niet instrumenteert).
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  const out: VisitResult = { path: opts.path, url, httpStatus: null, fingerprint: null, internalPaths: [] };

  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    out.httpStatus = resp?.status() ?? null;

    out.fingerprint = await page.evaluate(() => {
      const q = (sel: string) => document.querySelectorAll(sel).length;
      const host = location.host;
      const internal = [...document.querySelectorAll("a[href]")]
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => {
          try {
            return new URL(h).host === host;
          } catch {
            return false;
          }
        }).length;
      const text = (document.body?.innerText || "").trim();
      return {
        title: document.title || "",
        lang: document.documentElement.lang || "",
        landmarks: {
          header: !!document.querySelector("header, [role=banner]"),
          nav: !!document.querySelector("nav, [role=navigation]"),
          main: !!document.querySelector("main, [role=main]"),
          footer: !!document.querySelector("footer, [role=contentinfo]"),
        },
        counts: {
          h1: q("h1"),
          h2: q("h2"),
          images: q("img"),
          links: q("a[href]"),
          forms: q("form"),
          buttons: q("button, input[type=submit]"),
          inputs: q("input, textarea, select"),
        },
        internalLinks: internal,
        textLength: text.length,
      };
    });

    // Interne paden voor de crawler.
    const origin = new URL(url).origin;
    const hrefs = await page
      .$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href))
      .catch(() => [] as string[]);
    const paths = new Set<string>();
    for (const h of hrefs) {
      try {
        const u = new URL(h);
        if (u.origin !== origin) continue;
        if (!/^https?:$/.test(u.protocol)) continue;
        let p = u.pathname.replace(/\/+$/, "") || "/";
        // sla bestanden/feeds/admin over
        if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|avif|ico|zip|xml|json|css|js|woff2?|ttf|eot|mp4|webm|mp3)$/i.test(p)) continue;
        if (/\/wp-admin|\/wp-login|\/feed/.test(p)) continue;
        paths.add(p);
      } catch {
        /* skip */
      }
    }
    out.internalPaths = [...paths];

    if (opts.screenshot !== false) {
      const rel = `screenshots/${opts.siteSlug}/${slugifyPath(opts.path)}.png`;
      const abs = join(opts.resultsDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      await page.screenshot({ path: abs, fullPage: true });
      out.screenshotPath = rel;
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  } finally {
    await page.close();
  }

  return out;
}
