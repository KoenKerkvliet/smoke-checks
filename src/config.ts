import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, "..", "sites");

/**
 * Laadt de te testen sites. Met Supabase-credentials uit de database
 * (alleen status='active'); anders uit de lokale sites/*.json (dev-fallback).
 */
export async function loadSites(filter?: string): Promise<SiteConfig[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (url && key) {
    return loadFromSupabase(url, key, filter);
  }
  console.log("ℹ Geen Supabase-credentials — sites uit lokale sites/*.json.");
  return loadFromJson(filter);
}

async function loadFromSupabase(
  url: string,
  key: string,
  filter?: string,
): Promise<SiteConfig[]> {
  const db = createClient(url, key, { auth: { persistSession: false } });

  let query = db
    .from("sites")
    .select(
      "slug,name,base_url,status,site_checks(name,path,required_selectors,required_text,screenshot,sort)",
    )
    .eq("status", "active");
  if (filter) query = query.eq("slug", filter);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((s) => ({
    slug: s.slug as string,
    name: s.name as string,
    baseUrl: s.base_url as string,
    checks: ((s.site_checks ?? []) as Record<string, unknown>[])
      .sort((a, b) => ((a.sort as number) ?? 0) - ((b.sort as number) ?? 0))
      .map((c) => ({
        name: (c.name as string) ?? undefined,
        path: (c.path as string) ?? "/",
        requiredSelectors: (c.required_selectors as string[]) ?? undefined,
        requiredText: (c.required_text as string[]) ?? undefined,
        screenshot: (c.screenshot as boolean) ?? undefined,
      })),
  }));
}

function loadFromJson(filter?: string): SiteConfig[] {
  const files = readdirSync(SITES_DIR).filter((f) => f.endsWith(".json"));
  const sites = files.map(
    (f) => JSON.parse(readFileSync(join(SITES_DIR, f), "utf8")) as SiteConfig,
  );
  return filter ? sites.filter((s) => s.slug === filter) : sites;
}
