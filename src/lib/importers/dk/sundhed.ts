/**
 * sundhed.dk printouts (pure). sundhed.dk has no API for citizens, but people save or print "Min sundhedsjournal",
 * "Medicinkortet" (Det Fælles Medicinkort), "Vaccinationer" and "Laboratoriesvar" as PDFs. This recognises such a
 * document (the pipeline then keeps it sensitive and private before anything is sent to mux) and reads the entries it
 * can be sure of, line by line, as health records for the shared health proposals (importers/health/ops.ts).
 * Layouts differ between printouts; what isn't certain is left to the reader (and the model, without fallback).
 */
import type { HealthRecord } from "../health/ops";
import { dkRe } from "./authorities";
import { DATE_SOURCE, findDates, isoDay, type DkDate } from "./dates";

export type SundhedSection = "journal" | "medication" | "vaccination" | "lab";

export type SundhedDocument = {
  sections: SundhedSection[];
  records: HealthRecord[];
  /** Where each record was read: its line and page. */
  where: Map<string, { quote: string; page?: number }>;
};

const SECTION_HEADS: { re: RegExp; section: SundhedSection }[] = [
  { re: dkRe(String.raw`\b(?:min\s+sundhedsjournal|e-?journal|journal\s+fra\s+hospital|forløbsoversigt|diagnoser)\b`, "i"), section: "journal" },
  { re: dkRe(String.raw`\b(?:medicinkortet|det\s+fælles\s+medicinkort|fmk|mit\s+medicinkort|medicinoversigt)\b`, "i"), section: "medication" },
  { re: dkRe(String.raw`\b(?:vaccinationer|mine\s+vaccinationer|vaccinationsoversigt|det\s+danske\s+vaccinationsregister)\b`, "i"), section: "vaccination" },
  { re: dkRe(String.raw`\b(?:laboratoriesvar|prøvesvar|mine\s+prøvesvar|laboratorieportalen)\b`, "i"), section: "lab" },
];

/** The site's own name, which every printout carries in its header or footer. */
const SUNDHED_DK = dkRe(String.raw`\bsundhed\.dk\b|\bwww\.sundhed\.dk\b|\bsundhedsjournalen\b`, "i");

/** Is this a sundhed.dk health document, and which sections does it have? Certain: the site must be named. */
export function sundhedSections(text: string, filename = ""): SundhedSection[] {
  const sample = `${filename}\n${text.slice(0, 30_000)}`;
  if (!SUNDHED_DK.test(sample)) return [];
  return SECTION_HEADS.filter((h) => h.re.test(sample)).map((h) => h.section);
}

const DOSE = String.raw`\d+(?:[.,]\d+)?\s*(?:mg|mikrog|µg|mcg|g|ml|mg\/ml|IE|E\/ml|%|enheder|doser)`;
const MED_LINE = dkRe(String.raw`^\s*(\p{Lu}[\p{L}\d®\-/ ]{1,60}?)\s+(${DOSE})\b(.*)$`, "i");
const VACCINE_WORDS = dkRe(String.raw`\b(?:vaccin\w*|mfr|di-?te-?ki-?pol\w*|ditekipol\w*|hpv|gardasil|cervarix|comirnaty|spikevax|covid\w*|influenza\w*|hepatitis|havrix|twinrix|engerix|rota\w*|pneumokok\w*|prevenar|stivkrampe|tetanus|bcg|gul\s+feber|stamaril|tbe|encepur|ticovac|dukoral|vivotif|typhim|mæslinger|polio|kighoste|boostrix|priorix|m-m-rvaxpro|infanrix\w*|hexyon|vaxelis|bexsero|nimenrix|menveo|shingrix|zostavax)\b`, "i");
const LAB_LINE = dkRe(String.raw`^\s*((?:[A-Z][a-z]{0,3}|[A-Z]{1,4})(?:\([^)]*\))?-[\p{L}\d ,()\-+]{2,60}?|[\p{L}][\p{L}\d ,()\-+]{2,40}?)\s*[:;]?\s+([<>]?\s?\d+(?:[.,]\d+)?)\s*([\p{L}µ%/\d^×*.]{1,15})?(?:\s+(?:\[|\()?\s*(\d+(?:[.,]\d+)?\s*[-–]\s*\d+(?:[.,]\d+)?)\s*(?:\]|\))?)?`, "i");
const DIAGNOSIS_LINE = dkRe(String.raw`^\s*(?:diagnose\s*:\s*)?(D[A-Z]\d{2}(?:\.?\d{1,2})?)\s+[-–:]?\s*(.{3,120})$`);
const DIAGNOSIS_LABEL = dkRe(String.raw`^\s*(?:diagnose|aktionsdiagnose|bidiagnose)\s*:\s*(.{3,120})$`, "i");
const VISIT_LINE = dkRe(String.raw`\b(ambulant(?:\s+besøg)?|indlæggelse|indlagt|skadestue|akutmodtagelse|kontakt|konsultation|operation)\b`, "i");

const toNumber = (s: string) => Number(s.replace(/[<>\s]/g, "").replace(",", "."));
const iso = (d: DkDate) => `${isoDay(d)}T${String(d.hour ?? 12).padStart(2, "0")}:${String(d.minute ?? 0).padStart(2, "0")}:00+00:00`;
const tidy = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[\s,.;:–-]+$/, "");

/** Lines that are a page's furniture, not entries. */
const FURNITURE = dkRe(String.raw`^(?:side\s+\d+|udskrevet|printet|cpr|personnummer|navn\s*:|sundhed\.dk|www\.|dato\s+|præparat\s+|analyse\s+|vaccine\s+)`, "i");

/** The entries of a sundhed.dk printout, as health records. `segments` keep their page for the receipts. */
export function readSundhed(segments: { text: string; page?: number }[], sections: SundhedSection[]): SundhedDocument {
  const records: HealthRecord[] = [];
  const where = new Map<string, { quote: string; page?: number }>();
  const add = (r: Omit<HealthRecord, "id">, quote: string, page?: number) => {
    const id = `sundhed:${records.length + 1}`;
    records.push({ id, ...r });
    where.set(id, { quote: quote.slice(0, 300), ...(page ? { page } : {}) });
  };
  let section: SundhedSection | null = sections.length === 1 ? sections[0] : null;
  const seen = new Set<string>();
  const once = (k: string) => (seen.has(k) ? false : (seen.add(k), true));

  for (const seg of segments) {
    for (const raw of seg.text.split("\n")) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (line.length < 3 || line.length > 300) continue;
      const head = SECTION_HEADS.find((h) => h.re.test(line) && line.length < 60);
      if (head && sections.includes(head.section)) { section = head.section; continue; }
      if (FURNITURE.test(line)) continue;
      const dates = findDates(line);
      const at = dates[0] ? iso(dates[0]) : undefined;
      const noDates = tidy(line.replace(new RegExp(DATE_SOURCE, "giu"), " "));

      // Diagnoses (SKS codes "DJ45.9 Astma") anywhere in a journal.
      const dx = DIAGNOSIS_LINE.exec(noDates) ?? null;
      const dxl = !dx ? DIAGNOSIS_LABEL.exec(noDates) : null;
      if ((dx || dxl) && (section === "journal" || dx)) {
        const name = tidy(dx ? dx[2] : dxl![1]);
        if (name.length >= 3 && once(`c|${name.toLowerCase()}`)) add({ type: "condition", name, at, ...(dx ? { note: `SKS ${dx[1]}` } : {}) }, line, seg.page);
        continue;
      }
      if (section === "medication") {
        const m = MED_LINE.exec(noDates);
        if (m && once(`m|${tidy(m[1]).toLowerCase()}`)) {
          const rest = tidy(m[3] ?? "");
          add({ type: "medication", name: tidy(m[1]), at, note: tidy(`${m[2]} ${rest}`).slice(0, 300) }, line, seg.page);
        }
        continue;
      }
      if (section === "vaccination") {
        if (at && VACCINE_WORDS.test(noDates)) {
          const name = noDates.slice(0, 120);
          if (once(`v|${name.toLowerCase()}|${at.slice(0, 10)}`)) add({ type: "vaccination", name, at }, line, seg.page);
        }
        continue;
      }
      if (section === "lab") {
        const m = LAB_LINE.exec(noDates);
        if (m && at) {
          const name = tidy(m[1]);
          const value = toNumber(m[2]);
          if (name.length >= 2 && Number.isFinite(value) && !/^\d/.test(name) && once(`l|${name.toLowerCase()}|${at.slice(0, 10)}`)) {
            add({ type: "lab", name, at, value, ...(m[3] ? { unit: m[3] } : {}), ...(m[4] ? { note: `Reference ${m[4].replace(/\s+/g, "")}` } : {}) }, line, seg.page);
          }
        }
        continue;
      }
      if (section === "journal" && at && VISIT_LINE.test(noDates) && noDates.length >= 8) {
        const name = noDates.slice(0, 120);
        if (once(`visit|${name.toLowerCase()}|${at.slice(0, 10)}`)) add({ type: "visit", name, at }, line, seg.page);
      }
    }
  }
  return { sections, records: records.slice(0, 400), where };
}
