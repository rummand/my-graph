/**
 * "Go to" and "Do" in the palette: matched on the client, instantly, on the same 0..100 scale as server hits.
 * Pure: the palette supplies the translated labels; keywords hold both languages so "indstillinger" finds Settings
 * for someone reading in English and "settings" works in Danish.
 */
import { findRanges, foldCase } from "./highlight";
import { nameScore } from "./rank";
import type { Range } from "./types";

export type CommandDef = {
  id: string;
  /** Message key of the label (search.cmd.<id>). */
  labelKey: string;
  href?: string;
  /** Kept out for these roles (as the navigation does). */
  hideFor?: string[];
  /** Extra words that find it, in both languages. */
  keywords: string[];
  group: "go" | "do";
};

export const GO_TO: CommandDef[] = [
  { id: "today", labelKey: "search.cmd.today", href: "/", keywords: ["home", "start", "i dag", "forside", "brief"], group: "go" },
  { id: "ask", labelKey: "search.cmd.ask", href: "/chat", keywords: ["assistant", "chat", "spørg", "assistent"], group: "go" },
  { id: "people", labelKey: "search.cmd.people", href: "/people", keywords: ["family", "persons", "personer", "familie", "mennesker"], group: "go" },
  { id: "timeline", labelKey: "search.cmd.timeline", href: "/timeline", keywords: ["calendar", "events", "tidslinje", "kalender", "begivenheder"], group: "go" },
  { id: "library", labelKey: "search.cmd.library", href: "/library", keywords: ["files", "documents", "uploads", "bibliotek", "filer", "dokumenter"], group: "go" },
  { id: "artifacts", labelKey: "search.cmd.artifacts", href: "/artifacts", hideFor: ["guest"], keywords: ["pages", "documents", "decks", "sider", "dokumenter", "artefakter"], group: "go" },
  { id: "rules", labelKey: "search.cmd.rules", href: "/rules", hideFor: ["guest", "child"], keywords: ["laws", "corpora", "compliance", "regler", "love", "lovgivning"], group: "go" },
  { id: "graph", labelKey: "search.cmd.graph", href: "/graph", keywords: ["map", "network", "graf", "kort", "netværk"], group: "go" },
  { id: "connections", labelKey: "search.cmd.connections", href: "/connections", keywords: ["connectors", "aula", "gmail", "calendar", "import", "forbindelser", "integrationer"], group: "go" },
  { id: "changes", labelKey: "search.cmd.changes", href: "/changes", hideFor: ["guest"], keywords: ["proposals", "review", "approve", "forslag", "ændringer", "godkend"], group: "go" },
  { id: "history", labelKey: "search.cmd.history", href: "/history", hideFor: ["guest"], keywords: ["versions", "who said", "historik", "versioner"], group: "go" },
  { id: "memory", labelKey: "search.cmd.memory", href: "/memory", hideFor: ["guest", "child"], keywords: ["brain keeper", "notes", "hukommelse", "huskeliste"], group: "go" },
  { id: "automations", labelKey: "search.cmd.automations", href: "/automations", hideFor: ["guest", "child"], keywords: ["schedule", "recipes", "automatiseringer", "opskrifter"], group: "go" },
  { id: "graphs", labelKey: "search.cmd.graphs", href: "/graphs", keywords: ["share", "members", "grafer", "del", "medlemmer"], group: "go" },
  { id: "settings", labelKey: "search.cmd.settings", href: "/settings", keywords: ["preferences", "account", "language", "password", "indstillinger", "konto", "sprog", "adgangskode"], group: "go" },
  { id: "help", labelKey: "search.cmd.help", href: "/docs", keywords: ["docs", "guide", "hjælp", "vejledning"], group: "go" },
];

export const DO: CommandDef[] = [
  { id: "newPage", labelKey: "search.cmd.newPage", href: "/artifacts/pages/new", hideFor: ["guest"], keywords: ["write", "note", "create page", "ny side", "skriv", "opret"], group: "do" },
  { id: "upload", labelKey: "search.cmd.upload", href: "/library", hideFor: ["guest"], keywords: ["add file", "import", "scan", "upload", "tilføj fil", "upload en fil"], group: "do" },
  { id: "addPerson", labelKey: "search.cmd.addPersonPlain", href: "/people/new", hideFor: ["guest"], keywords: ["new person", "add person", "tilføj person", "ny person"], group: "do" },
  { id: "newRuleSet", labelKey: "search.cmd.newRuleSet", href: "/rules", hideFor: ["guest", "child"], keywords: ["add rules", "law", "regelsæt", "tilføj regler"], group: "do" },
];

export function commandsFor(role: string): CommandDef[] {
  return [...GO_TO, ...DO].filter((c) => !c.hideFor?.includes(role));
}

/** Letters of `query` in order inside `label` (a loose match: "stg" → "Settings"). */
export function subsequence(label: string, query: string): Range[] | null {
  const l = foldCase(label);
  const q = foldCase(query).replace(/\s+/g, "");
  if (!q) return null;
  const out: Range[] = [];
  let at = 0;
  for (const ch of q) {
    const i = l.indexOf(ch, at);
    if (i === -1) return null;
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
    at = i + 1;
  }
  return out;
}

export type CommandMatch = { score: number; ranges: Range[] };

/**
 * How well a command matches: by its label (name tiers), then by a keyword (a step lower), then loosely by letters
 * in order (low, and only for queries of 2+ letters where the letters sit close together).
 */
export function matchCommand(label: string, keywords: readonly string[], query: string): CommandMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, ranges: [] };
  const terms = foldCase(q).split(/\s+/).filter(Boolean);
  const own = nameScore(label, q, terms);
  if (own > 0) return { score: own, ranges: findRanges(label, terms) };
  let kw = 0;
  for (const k of keywords) kw = Math.max(kw, nameScore(k, q, terms));
  if (kw > 0) return { score: Math.max(40, kw - 14), ranges: [] };
  if (q.replace(/\s+/g, "").length < 2) return null;
  const sub = subsequence(label, q);
  if (!sub) return null;
  const span = sub[sub.length - 1][1] - sub[0][0];
  const tight = q.replace(/\s+/g, "").length / Math.max(1, span);
  if (tight < 0.5) return null;
  return { score: Math.round(28 + tight * 12), ranges: sub };
}
