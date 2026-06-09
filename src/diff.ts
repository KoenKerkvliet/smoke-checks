import type { Fingerprint, Deviation } from "./types";

/** Relatieve drempel waarboven een aantal-verandering opvalt. */
const COUNT_REL_THRESHOLD = 0.6; // 60%
const TEXT_REL_THRESHOLD = 0.4; // 40%

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

  // Titel
  if ((base.title || "") !== (cur.title || "")) {
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
