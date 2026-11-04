/** Server-only helpers for the Documentation pages: which media files this server has, and their URLs. */
import { stat } from "node:fs/promises";
import { mediaPath } from "./media";

/** The URL the media route serves a documentation file at. */
export const mediaUrl = (name: string) => `/api/docs/media/${encodeURIComponent(name)}`;

/** Which of these files have been published to this server (missing ones are left out of the pages). */
export async function publishedFiles(names: readonly string[]): Promise<Set<string>> {
  const have = await Promise.all(names.map(async (n) => {
    const p = mediaPath(n);
    const s = p ? await stat(p).catch(() => null) : null;
    return s?.isFile() && s.size > 0 ? n : null;
  }));
  return new Set(have.filter((n): n is string => !!n));
}

export { clock } from "@/components/docs/clock";
