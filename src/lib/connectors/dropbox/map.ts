/** Dropbox answers to My Graph's shapes (pure). */
export type DropboxEntry = {
  ".tag": "file" | "folder" | "deleted";
  id?: string; name: string; path_lower?: string; path_display?: string; rev?: string; content_hash?: string; size?: number;
  server_modified?: string; client_modified?: string;
};
export type DropboxPage = { entries?: DropboxEntry[]; cursor?: string; has_more?: boolean };

/** Dropbox's 409 answers: "reset" (the saved cursor is no good: read again) or "not found" (the folder is gone). */
export function dropboxConflict(status: number, body: string): "reset" | "notFound" | "other" | null {
  if (status !== 409) return null;
  try {
    const b = JSON.parse(body) as { error_summary?: string; error?: { ".tag"?: string; path?: { ".tag"?: string } } };
    const s = b.error_summary ?? "";
    if (s.startsWith("reset/") || b.error?.[".tag"] === "reset") return "reset";
    if (s.startsWith("path/not_found") || b.error?.path?.[".tag"] === "not_found") return "notFound";
    return "other";
  } catch {
    return "other";
  }
}

export function dropboxFiles(entries: DropboxEntry[]): DropboxEntry[] {
  return entries.filter((e) => e[".tag"] === "file" && !!e.id);
}

export function dropboxVersion(e: DropboxEntry): string {
  return e.content_hash ?? e.rev ?? e.server_modified ?? "0";
}

/** The Dropbox-API-Arg header must be plain ASCII: anything else is written as \uXXXX. */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export type DropboxCursor = { folders?: Record<string, { cursor?: string | null }> };
