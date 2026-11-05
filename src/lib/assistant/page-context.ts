/**
 * Page context (pure, unit-tested): what is open when a question is asked from the Ask panel, so "What's new with
 * him?" on Bo's page is about Bo. The browser sends {path, kind, id, title}; the server re-reads the item as the
 * viewer (titles it can't read are dropped) and turns it into a hint and a retrieval lead.
 */
import { z } from "zod";

export const PAGE_KINDS = ["person", "node", "document", "change_set", "wiki", "library", "corpus", "client", "clinical_session", "connection"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export type PageContext = { path: string; kind: PageKind; id: string; title?: string | null };

/** What the server knows after reading the item as the viewer. */
export type ResolvedPage = { kind: PageKind; id: string; title: string; nodeId: string | null; path: string };

const ROUTES: { re: RegExp; kind: PageKind }[] = [
  { re: /^\/people\/([^/?#]+)/, kind: "person" },
  { re: /^\/node\/([^/?#]+)/, kind: "node" },
  { re: /^\/artifacts\/pages\/([^/?#]+)/, kind: "wiki" },
  { re: /^\/artifacts\/(?!(?:pages|styles|documents|decks)(?:\/|$))([^/?#]+)/, kind: "document" },
  { re: /^\/changes\/([^/?#]+)/, kind: "change_set" },
  { re: /^\/wiki\/([^/?#]+)/, kind: "wiki" }, // old address of a page (redirects to /artifacts/pages/…)
  { re: /^\/library\/([^/?#]+)/, kind: "library" },
  { re: /^\/corpora\/([^/?#]+)/, kind: "corpus" },
  { re: /^\/rules\/([^/?#]+)/, kind: "corpus" }, // the Rules area (rule sets are corpora)
  { re: /^\/connections\/(?!(?:aula|mac)(?:\/|$))([^/?#]+)/, kind: "connection" },
  { re: /^\/clinical\/clients\/([^/?#]+)/, kind: "client" },
  { re: /^\/clinical\/sessions\/([^/?#]+)/, kind: "clinical_session" },
];

/** Index pages under these prefixes are lists, not one item ("/artifacts/pages/new" is the editor for a new page). */
const NOT_ITEMS = new Set(["new", "search", "all"]);

/** Strip " · My Graph" and similar suffixes from a document title. */
export function cleanPageTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/(?:\s*[·|–—-]\s*My Graph)+\s*$/i, "").replace(/\s+/g, " ").trim();
  if (!t || /^my graph$/i.test(t)) return null;
  return t.length > 120 ? `${t.slice(0, 119).trimEnd()}…` : t;
}

/** The item a path shows, or null for lists, settings and other pages that aren't one thing. */
export function pageContextFrom(pathname: string, title?: string | null): PageContext | null {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    let id: string;
    try { id = decodeURIComponent(m[1]); } catch { return null; }
    if (!id || NOT_ITEMS.has(id) || id.length > 200) return null;
    return { path, kind: r.kind, id, title: cleanPageTitle(title) };
  }
  return null;
}

/** Validation at the /api/chat boundary. */
export const pageContextSchema = z.object({
  path: z.string().trim().max(300).regex(/^\/[^\s]*$/, "The page must be a path in this app."),
  kind: z.enum(PAGE_KINDS),
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).nullish(),
}).strict();

const KIND_WORDS: Record<PageKind, string> = {
  person: "the person", node: "the item", document: "the document", change_set: "the change set",
  wiki: "the page", library: "the file", corpus: "the rule set", client: "the client record", clinical_session: "the session",
  connection: "the connection",
};

/** The hint the model gets. Titles are data (quoted), never instructions. */
export function pageHint(p: ResolvedPage): string {
  const title = JSON.stringify(p.title.replace(/[\r\n]+/g, " ").slice(0, 120));
  return `The person is looking at ${KIND_WORDS[p.kind]} ${title} in the app (${p.path}) while asking. `
    + `Words like "him", "her", "it", "this" or "here" refer to ${title} unless the question names something else. `
    + `If the question is clearly about something else, ignore this.`;
}

/** The composer chip: "About: Bo Madsen". */
export function chipLabel(p: Pick<PageContext, "title" | "kind">): string | null {
  return p.title?.trim() || null;
}
