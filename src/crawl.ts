import type { BrowserContext } from "playwright";
import { visitPage, type VisitResult } from "./fingerprint";

/**
 * Verkent een site vanaf de homepage en ontdekt pagina's via interne links (BFS),
 * tot `limit` pagina's. Legt per pagina de fingerprint + screenshot vast.
 */
export async function crawlSite(
  ctx: BrowserContext,
  baseUrl: string,
  siteSlug: string,
  resultsDir: string,
  limit = 15,
): Promise<VisitResult[]> {
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const queue: string[] = ["/"];
  const results: VisitResult[] = [];

  while (queue.length > 0 && results.length < limit) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);

    const url = new URL(path, origin).toString();
    const res = await visitPage(ctx, url, {
      screenshot: true,
      resultsDir,
      siteSlug,
      path,
    });
    results.push(res);

    // Nieuw ontdekte interne paden in de wachtrij (homepage eerst, dan breadth-first).
    for (const p of res.internalPaths) {
      if (!seen.has(p) && !queue.includes(p) && results.length + queue.length < limit) {
        queue.push(p);
      }
    }
  }

  return results;
}
