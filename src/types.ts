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

/** Structurele "vingerafdruk" van een pagina (basis voor drift-detectie). */
export interface Fingerprint {
  title: string;
  lang: string;
  landmarks: { header: boolean; nav: boolean; main: boolean; footer: boolean };
  counts: {
    h1: number;
    h2: number;
    images: number;
    links: number;
    forms: number;
    buttons: number;
    inputs: number;
  };
  internalLinks: number;
  textLength: number;
}

/** Eén afwijking t.o.v. de nulmeting. */
export interface Deviation {
  field: string;
  baseline: unknown;
  current: unknown;
  severity: "high" | "medium";
  message: string;
}

/** Baseline-record voor één pagina. */
export interface Baseline {
  path: string;
  url: string;
  httpStatus: number | null;
  fingerprint: Fingerprint;
  screenshotPath?: string;
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
  deviations?: Deviation[];
  fingerprint?: Fingerprint | null;
}

/** Samenvatting van een hele run. */
export interface RunSummary {
  generatedAt: string;
  trigger: string;
  mode: "scan" | "test";
  commit: string | null;
  totals: { total: number; passed: number; failed: number };
  checks: CheckResult[];
}
