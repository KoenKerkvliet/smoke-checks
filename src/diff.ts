import type { Fingerprint, Deviation } from "./types";

const CHALLENGE_RE =
  /just a moment|checking your browser|attention required|verify you are human|verifying you are human|cloudflare|access denied|ddos protection|please wait while|enable javascript and cookies/i;

/**
 * Herkent een bot-/WAF-challenge (Cloudflare e.d.) i.p.v. de echte pagina.
 * Zulke pagina's geven een 401/403/429/503 + een typische challenge-titel.
 */
export function looksBlocked(httpStatus: number | null, fp: Fingerprint | null): boolean {
  // 401/403/429/503 = niet kunnen verifiëren (forbidden / rate-limit / WAF-block).
  if (httpStatus !== null && [401, 403, 429, 503].includes(httpStatus)) return true;
  // Cloudflare e.d. kan ook een 200 met een challenge-pagina geven.
  return !!fp && CHALLENGE_RE.test(fp.title);
}

const MAINTENANCE_RE =
  /onderhoud|maintenance|tijdelijk niet beschikbaar|temporarily unavailable|be right back|coming soon|site will be available soon/i;

/**
 * Herkent een onderhoudspagina ("Site is undergoing maintenance" e.d.). Die geeft
 * een 200 met een onderhoudsmelding — geen echte fout, dus niet alarmeren.
 */
export function looksMaintenance(fp: Fingerprint | null): boolean {
  return !!fp && MAINTENANCE_RE.test(fp.title);
}

const UNREACHABLE_RE =
  /timeout|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK|ERR_EMPTY_RESPONSE|net::|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i;

/**
 * Herkent een netwerk-/laadfout (timeout, connection refused, DNS): de site was
 * niet te bereiken. Dat betekent niet automatisch dat de site kapot is — vaak
 * blokkeert de host alleen het datacenter-IP van de runner. Behandel als
 * 'inconclusief', niet als harde fout (pas escaleren na meerdere keren).
 */
export function looksUnreachable(error: string | null | undefined): boolean {
  return !!error && UNREACHABLE_RE.test(error);
}

/** Relatieve drempel waarboven een aantal-verandering opvalt. */
const COUNT_REL_THRESHOLD = 0.6; // 60%
const TEXT_REL_THRESHOLD = 0.4; // 40%

/**
 * Normaliseert een paginatitel voor vergelijking: witruimte opschonen en een
 * SEO-/site-naam-suffix achter een scheidingsteken (" | ", " – ", " — ", " - ")
 * weghalen. Zo telt "T.V. Rapid" en "T.V. Rapid – website | Design Pixels" als
 * dezelfde titel — een SEO-plugin die een suffix toevoegt is geen echte wijziging.
 */
function titleCore(title: string): string {
  const norm = (title || "").replace(/\s+/g, " ").trim();
  // Pak het deel vóór het eerste " | ", " – ", " — " of " - ".
  const core = norm.split(/\s+[|–—-]\s+/)[0]?.trim() ?? norm;
  return core || norm;
}

const LANDMARK_LABEL: Record<string, string> = {
  header: "header",
  nav: "navigatie",
  main: "hoofdinhoud",
  footer: "footer",
};

const COUNT_LABEL: Record<string, string> = {
  h1: "h1-koppen",
  h2: "h2-koppen",
  images: "afbeeldingen",
  links: "links",
  forms: "formulieren",
  buttons: "knoppen",
  inputs: "invoervelden",
};

/**
 * Vergelijkt een huidige fingerprint met de nulmeting en geeft de afwijkingen terug.
 * `high` = waarschijnlijk kapot/verdwenen, `medium` = sterk veranderd (let op).
 */
export function compareFingerprints(
  base: Fingerprint,
  cur: Fingerprint,
  baseStatus: number | null,
  curStatus: number | null,
): Deviation[] {
  const dev: Deviation[] = [];

  // HTTP-status
  if (curStatus !== baseStatus) {
    dev.push({
      field: "status",
      baseline: baseStatus,
      current: curStatus,
      severity: curStatus === null || curStatus >= 400 ? "high" : "medium",
      message: `HTTP-status ${baseStatus} → ${curStatus ?? "geen respons"}`,
    });
  }

  // Titel — vergelijk de genormaliseerde kern (zonder SEO-/site-naam-suffix),
  // zodat een toegevoegde of gewijzigde suffix geen vals alarm geeft.
  if (titleCore(base.title) !== titleCore(cur.title)) {
    dev.push({
      field: "title",
      baseline: base.title,
      current: cur.title,
      severity: "medium",
      message: `Titel gewijzigd: "${base.title}" → "${cur.title}"`,
    });
  }

  // Landmarks: aanwezig → verdwenen
  for (const key of ["header", "nav", "main", "footer"] as const) {
    if (base.landmarks[key] && !cur.landmarks[key]) {
      dev.push({
        field: `landmark.${key}`,
        baseline: true,
        current: false,
        severity: "high",
        message: `${LANDMARK_LABEL[key]} is verdwenen`,
      });
    }
  }

  // Aantallen
  for (const key of Object.keys(base.counts) as (keyof Fingerprint["counts"])[]) {
    const b = base.counts[key];
    const c = cur.counts[key];
    if (b > 0 && c === 0) {
      dev.push({
        field: `count.${key}`,
        baseline: b,
        current: c,
        severity: "high",
        message: `Alle ${COUNT_LABEL[key]} verdwenen (${b} → 0)`,
      });
    } else if (b > 0 && Math.abs(c - b) / b > COUNT_REL_THRESHOLD) {
      dev.push({
        field: `count.${key}`,
        baseline: b,
        current: c,
        severity: "medium",
        message: `${COUNT_LABEL[key]} sterk veranderd (${b} → ${c})`,
      });
    }
  }

  // Tekstlengte (content weggevallen)
  if (base.textLength > 0) {
    const drop = (base.textLength - cur.textLength) / base.textLength;
    if (cur.textLength === 0) {
      dev.push({
        field: "textLength",
        baseline: base.textLength,
        current: 0,
        severity: "high",
        message: "Pagina-tekst is volledig verdwenen",
      });
    } else if (drop > TEXT_REL_THRESHOLD) {
      dev.push({
        field: "textLength",
        baseline: base.textLength,
        current: cur.textLength,
        severity: "medium",
        message: `Veel minder tekst (${base.textLength} → ${cur.textLength} tekens)`,
      });
    }
  }

  return dev;
}
