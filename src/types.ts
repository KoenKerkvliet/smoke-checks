/** Eén te controleren pagina binnen een site. */
export interface PageCheck {
  /** Pad t.o.v. baseUrl, bv. "/" of "/contact/". */
  path: string;
  /** Leesbare naam (default = path). */
  name?: string;
  /** CSS-selectors die zichtbaar MOETEN zijn (anders fail). */
  requiredSelectors?: string[];
  /** Tekst die op de pagina aanwezig moet zijn (optioneel). */
  requiredText?: string[];
  /** Screenshot maken? Default true. */
  screenshot?: boolean;
}

/** Configuratie van één site (sites/<slug>.json). */
export interface SiteConfig {
  slug: string;
  name: string;
  baseUrl: string;
  checks: PageCheck[];
}

/** Resultaat van één uitgevoerde check. */
export interface CheckResult {
  siteSlug: string;
  path: string;
  name: string;
  status: "pass" | "fail";
  httpStatus: number | null;
  messages: string[];
  durationMs: number;
  /** Lokaal pad t.o.v. results/ (bv. "screenshots/tvrapid/home.png"). */
  screenshotPath?: string;
}

/** Samenvatting van een hele run. */
export interface RunSummary {
  generatedAt: string;
  trigger: string;
  commit: string | null;
  totals: { total: number; passed: number; failed: number };
  checks: CheckResult[];
}
