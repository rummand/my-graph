/**
 * Library folders in the browser: the shapes the folder API returns, a fetch helper that turns a folder error into
 * the reader's language, and small tree helpers. Pure apart from `folderApi`.
 */
import type { FolderTree, FolderView, SuggestionGroup, TemplateView } from "@/lib/ingest/folders";
import type { Lx } from "./i18n";

export type { FolderTree, FolderView, SuggestionGroup, TemplateView };

/** "" = all files, "root" = not in a folder, else a folder id. */
export type FolderKey = string;

/** The custom drag type for files dragged onto a folder. */
export const DRAG_TYPE = "application/x-mygraph-files";

const CODES = new Set(["nameTaken", "nameNeeded", "cycle", "depth", "notYours", "readOnly", "notFound", "noFolders"]);

export class FolderApiError extends Error {}

/** JSON in, JSON out; an error answer becomes a FolderApiError in the reader's language when it has a known code. */
export async function folderApi<T>(L: Pick<Lx, "t">, url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method, cache: "no-store",
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new FolderApiError(L.t("library.settings.dropped"));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data.code === "string" && CODES.has(data.code) ? data.code : null;
    throw new FolderApiError(code ? L.t(`library.folders.error.${code}`) : typeof data.error === "string" ? data.error : L.t("library.folders.error.generic"));
  }
  return data as T;
}

export function flattenViews(fs: FolderView[]): FolderView[] {
  return fs.flatMap((f) => [f, ...flattenViews(f.children)]);
}

export function findFolder(fs: FolderView[], id: string): FolderView | null {
  for (const f of fs) {
    if (f.id === id) return f;
    const hit = findFolder(f.children, id);
    if (hit) return hit;
  }
  return null;
}

/** The folder and its ancestors, top down. */
export function trail(fs: FolderView[], id: string): FolderView[] {
  const flat = flattenViews(fs);
  const byId = new Map(flat.map((f) => [f.id, f]));
  const out: FolderView[] = [];
  for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    if (out.includes(cur)) break;
    out.unshift(cur);
  }
  return out;
}

/** The ids of a folder and everything inside it (a folder can't move into these). */
export function subtreeIds(f: FolderView): Set<string> {
  return new Set(flattenViews([f]).map((x) => x.id));
}

/** “word” / „word“. */
export const quoted = (L: Pick<Lx, "locale">, s: string) => (L.locale === "da" ? `„${s}“` : `“${s}”`);

/** Why a folder was suggested, in the reader's language. */
export function reasonText(L: Pick<Lx, "t" | "locale">, f: { reason: string | null; reasonKey: string | null; reasonParams: Record<string, string | number> }): string {
  if (f.reason) return f.reason;
  const p = f.reasonParams ?? {};
  if (typeof p.name === "string") return L.t("library.folders.reason.from", { name: p.name });
  if (typeof p.word === "string") return L.t("library.folders.reason.word", { word: quoted(L, p.word) });
  if (f.reasonKey === "series" || f.reasonKey === "sameSeries") {
    return L.t(`library.folders.reason.${f.reasonKey}`, { series: quoted(L, String(p.series ?? "")), count: Number(p.count ?? 0) });
  }
  if (f.reasonKey === "healthRecord" || f.reasonKey === "photo") return L.t(`library.folders.reason.${f.reasonKey}`);
  return L.t("library.folders.reason.other");
}

/** "Money › Tax". */
export const pathLabel = (path: string[]) => path.join(" › ");
