/**
 * Built-in folder templates, per graph kind, in English and Danish (pure). A template's folders are created in the
 * reader's language; applying one only adds the folders that are missing (folders-rules.ts planTemplate).
 *
 * Folders carry a `slot` where the suggestion rules (folders-suggest.ts) may put things: "Money → Tax" is where a
 * letter from Skattestyrelsen goes, whatever the person later calls it in their own language.
 */
import type { GraphKind } from "@/lib/graphs/pure";
import type { TreeSpec } from "./folders-rules";

export type Lang = "en" | "da";
export type Slot =
  | "home" | "housing" | "insurance" | "utilities" | "contracts" | "school" | "health" | "money" | "tax" | "bills" | "bank"
  | "authorities" | "travel" | "photos" | "work" | "learning" | "projects" | "decisions" | "meetings" | "reports" | "people"
  | "clients" | "consents" | "forms" | "admin" | "documents" | "homeContracts";

type Named = { en: string; da: string };
export type BuiltInFolder = { name: Named; slot?: Slot; children?: BuiltInFolder[] };
export type BuiltInTemplate = { id: string; name: Named; kinds: GraphKind[]; folders: BuiltInFolder[] };

const F = (en: string, da: string, slot?: Slot, children?: BuiltInFolder[]): BuiltInFolder => ({ name: { en, da }, slot, children });

/** Where each slot lives, in both languages (used by the suggestion rules for every graph kind). */
export const SLOT_PATHS: Record<Slot, Named[]> = {
  home: [{ en: "Home", da: "Hjem" }],
  housing: [{ en: "Home", da: "Hjem" }, { en: "Housing", da: "Bolig" }],
  insurance: [{ en: "Home", da: "Hjem" }, { en: "Insurance", da: "Forsikring" }],
  utilities: [{ en: "Home", da: "Hjem" }, { en: "Utilities", da: "Forbrug" }],
  contracts: [{ en: "Contracts", da: "Kontrakter" }],
  school: [{ en: "School & daycare", da: "Skole og institution" }],
  health: [{ en: "Health", da: "Sundhed" }],
  money: [{ en: "Money", da: "Økonomi" }],
  tax: [{ en: "Money", da: "Økonomi" }, { en: "Tax", da: "Skat" }],
  bills: [{ en: "Money", da: "Økonomi" }, { en: "Bills", da: "Regninger" }],
  bank: [{ en: "Money", da: "Økonomi" }, { en: "Bank", da: "Bank" }],
  authorities: [{ en: "Letters from authorities", da: "Breve fra myndigheder" }],
  travel: [{ en: "Travel", da: "Rejser" }],
  photos: [{ en: "Memories & photos", da: "Minder og billeder" }],
  work: [{ en: "Work", da: "Arbejde" }],
  learning: [{ en: "Learning", da: "Læring" }],
  projects: [{ en: "Projects", da: "Projekter" }],
  decisions: [{ en: "Decisions (ADRs)", da: "Beslutninger (ADR'er)" }],
  meetings: [{ en: "Meetings", da: "Møder" }],
  reports: [{ en: "Reports", da: "Rapporter" }],
  people: [{ en: "People & HR", da: "Personale og HR" }],
  clients: [{ en: "Clients' documents", da: "Klienters dokumenter" }],
  consents: [{ en: "Consents", da: "Samtykker" }],
  forms: [{ en: "Templates & forms", da: "Skabeloner og formularer" }],
  admin: [{ en: "Practice admin", da: "Praksisadministration" }],
  documents: [{ en: "Documents", da: "Dokumenter" }],
  homeContracts: [{ en: "Home", da: "Hjem" }, { en: "Contracts", da: "Kontrakter" }],
};

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    id: "family", name: { en: "Family home", da: "Familiens hjem" }, kinds: ["family", "partner"],
    folders: [
      F("Home", "Hjem", "home", [F("Housing", "Bolig", "housing"), F("Insurance", "Forsikring", "insurance"), F("Utilities", "Forbrug", "utilities")]),
      F("School & daycare", "Skole og institution", "school"),
      F("Health", "Sundhed", "health"),
      F("Money", "Økonomi", "money", [F("Tax", "Skat", "tax"), F("Bills", "Regninger", "bills"), F("Bank", "Bank", "bank")]),
      F("Letters from authorities", "Breve fra myndigheder", "authorities"),
      F("Travel", "Rejser", "travel"),
      F("Memories & photos", "Minder og billeder", "photos"),
      F("Work", "Arbejde", "work"),
    ],
  },
  {
    id: "work", name: { en: "Work and projects", da: "Arbejde og projekter" }, kinds: ["work", "project"],
    folders: [
      F("Projects", "Projekter", "projects"),
      F("Decisions (ADRs)", "Beslutninger (ADR'er)", "decisions"),
      F("Meetings", "Møder", "meetings"),
      F("Contracts", "Kontrakter", "contracts"),
      F("Reports", "Rapporter", "reports"),
      F("People & HR", "Personale og HR", "people"),
    ],
  },
  {
    id: "personal", name: { en: "Personal life", da: "Eget liv" }, kinds: ["personal"],
    folders: [
      F("Home", "Hjem", "home"), F("Health", "Sundhed", "health"), F("Money", "Økonomi", "money"),
      F("Work", "Arbejde", "work"), F("Learning", "Læring", "learning"), F("Travel", "Rejser", "travel"),
    ],
  },
  {
    id: "practice", name: { en: "Clinical practice", da: "Klinisk praksis" }, kinds: ["practice"],
    folders: [
      F("Clients' documents", "Klienters dokumenter", "clients"), F("Consents", "Samtykker", "consents"),
      F("Templates & forms", "Skabeloner og formularer", "forms"), F("Practice admin", "Praksisadministration", "admin"),
    ],
  },
  {
    id: "general", name: { en: "A simple start", da: "En enkel start" }, kinds: ["shared", "other"],
    folders: [
      F("Documents", "Dokumenter", "documents"), F("Meetings", "Møder", "meetings"), F("Contracts", "Kontrakter", "contracts"),
      F("Money", "Økonomi", "money"), F("Memories & photos", "Minder og billeder", "photos"),
    ],
  },
];

/** The template made for this kind of graph first, then the others. */
export function templatesFor(kind: GraphKind): BuiltInTemplate[] {
  const mine = BUILT_IN_TEMPLATES.filter((t) => t.kinds.includes(kind));
  return [...mine, ...BUILT_IN_TEMPLATES.filter((t) => !t.kinds.includes(kind))];
}

export const builtInTemplate = (id: string) => BUILT_IN_TEMPLATES.find((t) => t.id === id) ?? null;

/** A built-in template as folder names in one language. */
export function specOf(t: BuiltInTemplate, lang: Lang): TreeSpec[] {
  const walk = (fs: BuiltInFolder[]): TreeSpec[] => fs.map((f) => (f.children?.length ? { name: f.name[lang], children: walk(f.children) } : { name: f.name[lang] }));
  return walk(t.folders);
}

/** The slots the template for this kind of graph has (the rules only suggest these, or folders that already exist). */
export function slotsFor(kind: GraphKind): Set<Slot> {
  const out = new Set<Slot>();
  const walk = (fs: BuiltInFolder[]) => { for (const f of fs) { if (f.slot) out.add(f.slot); walk(f.children ?? []); } };
  for (const t of BUILT_IN_TEMPLATES) if (t.kinds.includes(kind)) walk(t.folders);
  return out;
}

/** A slot's path in one language. */
export const slotPath = (slot: Slot, lang: Lang) => SLOT_PATHS[slot].map((n) => n[lang]);

/** Default sharing for folders made from a template or a suggestion: shared in graphs people share, private alone. */
export function defaultFolderVisibility(kind: GraphKind): "private" | "household" {
  return kind === "personal" || kind === "practice" ? "private" : "household";
}

/** Every built-in folder name with its other-language twin ("Money" ↔ "Økonomi"), keyed lower-case. */
const TWINS: Map<string, string[]> = (() => {
  const m = new Map<string, Set<string>>();
  const add = (n: Named) => {
    for (const x of [n.en, n.da]) {
      const k = x.toLowerCase();
      m.set(k, new Set([...(m.get(k) ?? []), n.en, n.da]));
    }
  };
  const walk = (fs: BuiltInFolder[]) => { for (const f of fs) { add(f.name); walk(f.children ?? []); } };
  for (const t of BUILT_IN_TEMPLATES) walk(t.folders);
  for (const p of Object.values(SLOT_PATHS)) p.forEach(add);
  return new Map([...m].map(([k, v]) => [k, [...v]]));
})();

/** A folder name and what the same built-in folder is called in the other language. */
export const nameVariants = (name: string): string[] => TWINS.get(name.toLowerCase()) ?? [name];

const PAIRS: Map<string, Named> = (() => {
  const m = new Map<string, Named>();
  const add = (n: Named) => { m.set(n.en.toLowerCase(), n); m.set(n.da.toLowerCase(), n); };
  const walk = (fs: BuiltInFolder[]) => { for (const f of fs) { add(f.name); walk(f.children ?? []); } };
  for (const t of BUILT_IN_TEMPLATES) walk(t.folders);
  for (const p of Object.values(SLOT_PATHS)) p.forEach(add);
  return m;
})();

/** A built-in folder name in the reader's language ("Decisions (ADRs)" → "Beslutninger (ADR'er)"); other names as they are. */
export const nameIn = (name: string, lang: Lang): string => PAIRS.get(name.toLowerCase())?.[lang] ?? name;
