/**
 * Calling Notion's API with the integration's token for one workspace (pure: takes the authorised `Api`). Every call
 * carries Notion-Version. A page or database the person has since taken away from the integration answers 403/404;
 * that is handed back (null) so the caller skips it. 401 (refresh, then sign in again), 429 and 5xx are handled by
 * the shared client.
 */
import { bodyOf, unexpected, type Api } from "../oauth/client";

/** The API version these shapes are written against (databases are queried directly in it). */
export const NOTION_VERSION = "2022-06-28";

export async function notionCall<T>(api: Api, base: string, path: string, body?: unknown): Promise<T | null> {
  const r = await api({
    url: `${base}${path}`,
    method: body === undefined ? "GET" : "POST",
    headers: { "notion-version": NOTION_VERSION, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.status === 403 || r.status === 404) return null;
  if (r.status !== 200) throw unexpected(r, "Notion", path.split("?")[0].split("/").slice(0, 2).join("/") || "a page");
  return bodyOf<T>(r, "Notion");
}

export type NotionList<T> = { results?: T[]; has_more?: boolean; next_cursor?: string | null };
