/**
 * Every importer My Graph knows (pure: imported by the upload's type check). Order matters only when two could claim
 * the same file; the more specific one goes first. Add yours with one import and one line.
 */
import type { Importer } from "./types";

export const IMPORTERS: Importer[] = [
];

export function importerById(id: string | null | undefined): Importer | null {
  return (id && IMPORTERS.find((i) => i.id === id)) || null;
}

/** The importer that recognises this uploaded file (not a zip), if any. */
export function importerForFile(filename: string, head: Uint8Array): Importer | null {
  for (const i of IMPORTERS) {
    try { if (i.detect({ filename, head })) return i; } catch { /* a broken detector never blocks an upload */ }
  }
  return null;
}

/** The importer that recognises this zip from its file names, if any. */
export function importerForArchive(filename: string, names: string[]): Importer | null {
  for (const i of IMPORTERS) {
    try { if (i.detectArchive?.({ filename, names })) return i; } catch { /* ignore */ }
  }
  return null;
}
