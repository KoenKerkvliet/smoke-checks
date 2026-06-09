import type { BrowserContext, Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Fingerprint } from "./types";

/**
 * Triggert lazy-loading (galleries, banners) door de pagina te scrollen en te wachten
 * tot het netwerk + de <img>-elementen klaar zijn. Anders ontbreken lazy-foto's op de screenshot.
 */
async function settlePage(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
        const tick = () => {
          window.scrollTo(0, y);
          y += step;
          if (y < document.body.scrollHeight) setTimeout(tick, 80);
          else {
            window.scrollTo(0, 0);
            resolve();
          }
        };
        tick();
      });
    })
    .catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  await page
    .evaluate(async () => {
      const pending = Array.from(document.images).filter((i) => !i.complete);
      await Promise.race([
        Promise.all(
          pending.map(
            (i) =>
              new Promise((res) => {
                i.addEventListener("load", res, { once: true });
                i.addEventListener("error", res, { once: true });
              }),
          ),
        ),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
    })
    .catch(() => {});
}

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

    // Lazy-loaded content (galleries/banners) laten laden vóór fingerprint + screenshot.
    if ((out.httpStatus ?? 0) < 400) {
      await settlePage(page);
    }

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
