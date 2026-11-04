/**
 * Pasted into the library (server-only): text becomes a note, a URL becomes a saved web page. Both then go through
 * the same reading as an upload (chunks, search, extraction, a change set to review).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { getAssistantSettings, webAllowed } from "@/lib/automations";
import { scopeOf } from "@/lib/graphs/pure";
import { sha256Hex } from "@/lib/storage";
import { readUrl, WebError } from "@/lib/web";
import { checkPublicUrl } from "@/lib/web/guard";
import { checkUrl, webSourceValues } from "@/lib/web/pure";
import { IngestError } from "./errors";
import { ingestText } from "./index";

type Sharing = { visibility: "private" | "parents" | "household"; sensitive: boolean };
/** read: false when only the link was saved; webOff: because reading web pages is off for this person. */
export type PasteResult = { sourceId: string; duplicate: boolean; title: string; read: boolean; webOff?: boolean };

/** Marks a page saved without its text (the site refused us, or reading the web is off for this person). */
export const UNREAD_PAGE = "skipped: page could not be read";
export const WEB_OFF = "skipped: reading web pages is off";

function assertCanAdd(v: Viewer) {
  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not add to it.");
}

/** Read the source in the background; a web page keeps being called a web page afterwards. */
function readInBackground(v: Viewer, sourceId: string, web: boolean) {
  void ingestText(v, sourceId)
    .then(async () => {
      if (!web) return;
      const [row] = await db.select({ meta: sources.meta }).from(sources).where(eq(sources.id, sourceId)).limit(1);
      if (row) await db.update(sources).set({ meta: { ...row.meta, docKind: "web_page" } }).where(eq(sources.id, sourceId));
    })
    .catch((e) => console.error("[library paste] reading failed", e));
}

/** Pasted text → a note (kind "manual", text/plain), with the page it came from when the clipboard said. */
export async function addPastedText(v: Viewer, input: { title: string; text: string; sourceUrl?: string | null } & Sharing): Promise<PasteResult> {
  assertCanAdd(v);
  const text = input.text.replace(/\r\n/g, "\n").trim();
  if (!text) throw new IngestError(400, "There is no text to save.");
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Pasted text";
  const bytes = new TextEncoder().encode(text);
  const sha256 = sha256Hex(bytes);
  const [dup] = await db.select({ id: sources.id, title: sources.title }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), eq(sources.sha256, sha256))).limit(1);
  if (dup) return { sourceId: dup.id, duplicate: true, title: dup.title, read: true };

  // Where the text came from is only a link (never fetched): kept when it is a public-looking web address.
  const from = input.sourceUrl ? checkUrl(input.sourceUrl) : null;
  const url = from?.ok ? from.url : null;
  const [row] = await db.insert(sources).values({
    householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id,
    kind: "manual", title, mime: "text/plain", sha256, size: bytes.length, textContent: text, url,
    meta: { pasted: true, docKind: "note", url, host: url ? new URL(url).hostname.replace(/^www\./, "") : null },
    status: "pending", visibility: input.visibility, sensitive: input.sensitive,
  }).returning({ id: sources.id });
  void audit(v, "library.paste", { type: "source", id: row.id }, { kind: "text", chars: text.length }).catch(() => {});
  readInBackground(v, row.id, false);
  return { sourceId: row.id, duplicate: false, title, read: true };
}

/**
 * A pasted URL → a web source (kind "web": url, title, fetchedAt, the text), read the way the assistant's web research
 * reads pages. Private and internal addresses are refused. A page that refuses to be read is still saved as a link.
 */
export async function addPastedUrl(v: Viewer, input: { url: string; title?: string | null; signal?: AbortSignal } & Sharing): Promise<PasteResult> {
  assertCanAdd(v);
  const guard = await checkPublicUrl(input.url);
  if (!guard.ok) {
    throw new IngestError(400, guard.reason === "unresolved" ? "That address could not be found." : "Only pages on the public web can be saved.");
  }
  const settings = await getAssistantSettings(v);
  const mayRead = webAllowed(v, settings.capabilities);

  let unread: string | null = mayRead ? null : WEB_OFF;
  if (mayRead) {
    try {
      const page = await readUrl(v, guard.url, { signal: input.signal });
      if (page.reused) {
        const [row] = await db.select({ meta: sources.meta, title: sources.title }).from(sources).where(eq(sources.id, page.sourceId)).limit(1);
        const read = typeof row?.meta?.extraction === "string" && !row.meta.extraction.startsWith("skipped: web pages are read on request");
        if (row && !read) {
          await db.update(sources).set({ status: "pending", meta: { ...row.meta, pasted: true, url: page.url } }).where(eq(sources.id, page.sourceId));
          readInBackground(v, page.sourceId, true);
        }
        return { sourceId: page.sourceId, duplicate: true, title: row?.title ?? page.title, read: true };
      }
      const [row] = await db.select({ meta: sources.meta, title: sources.title }).from(sources).where(eq(sources.id, page.sourceId)).limit(1);
      await db.update(sources).set({
        status: "pending", visibility: input.visibility, sensitive: input.sensitive,
        meta: { ...(row?.meta ?? {}), pasted: true, url: page.url },
      }).where(eq(sources.id, page.sourceId));
      void audit(v, "library.paste", { type: "source", id: page.sourceId }, { kind: "url", host: guard.host }).catch(() => {});
      readInBackground(v, page.sourceId, true);
      return { sourceId: page.sourceId, duplicate: false, title: row?.title ?? page.title, read: true };
    } catch (e) {
      if (input.signal?.aborted) throw e;
      if (e instanceof WebError && e.status === 400) throw new IngestError(400, e.message);
      if (!(e instanceof WebError)) console.warn("[library paste] reading the page failed:", e instanceof Error ? e.message : e);
      unread = UNREAD_PAGE;
    }
  }

  // Saved as a link: its title (from the clipboard, else the site's name) and a note that the page wasn't read.
  const [prior] = await db.select({ id: sources.id, title: sources.title }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), eq(sources.kind, "web"), eq(sources.url, guard.url))).limit(1);
  if (prior) return { sourceId: prior.id, duplicate: true, title: prior.title, read: false, webOff: unread === WEB_OFF };
  const values = webSourceValues(v, { url: guard.url, title: input.title?.trim() ?? "", text: "", via: "read" }, { query: null, fetchedAt: new Date() });
  const [row] = await db.insert(sources).values({
    ...values, textContent: null, visibility: input.visibility, sensitive: input.sensitive,
    meta: { ...values.meta, pasted: true, url: guard.url, unread: true, extraction: unread },
  }).returning({ id: sources.id });
  void audit(v, "library.paste", { type: "source", id: row.id }, { kind: "url", host: guard.host, read: false }).catch(() => {});
  return { sourceId: row.id, duplicate: false, title: values.title, read: false, webOff: unread === WEB_OFF };
}
