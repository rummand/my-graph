/**
 * Family tree (GEDCOM): a .ged file (or a .zip holding one) exported from MyHeritage, Geni, Ancestry, Legacy,
 * Gramps, Family Tree Maker, Danish programs (Brothers Keeper, Legacy DK) … Pure: see ../types.ts.
 */
import type { Importer } from "../types";
import { decodeGedcom, decodeHead } from "./decode";
import { parseGedcom } from "./parse";
import { buildPlan } from "./plan";

const isGed = (name: string) => /\.ged(com)?$/i.test(name);

/** "0 HEAD" first, and the GEDC structure (or a .ged name) — nothing else starts like that. */
export function looksLikeGedcom(filename: string, head: Uint8Array): boolean {
  const text = decodeHead(head).replace(/^﻿/, "");
  if (!/^\s*0\s+HEAD\s*$/m.test(text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? "")) return false;
  return isGed(filename) || /^\s*1\s+GEDC\b/m.test(text);
}

export const gedcomImporter: Importer = {
  id: "gedcom",
  label: "Family tree (GEDCOM)",
  mime: "text/vnd.familysearch.gedcom",
  detect: ({ filename, head }) => looksLikeGedcom(filename, head),
  detectArchive: ({ names }) => {
    const geds = names.filter((n) => isGed(n) && !/(^|\/)(__MACOSX|\.)/.test(n));
    // A zip of a family tree: its .ged next to media at most (not a folder of documents that happens to hold one).
    return geds.length >= 1 && geds.length <= 3 && names.every((n) => isGed(n) || /\/$/.test(n) || /\.(jpe?g|png|gif|tiff?|bmp|webp|heic|pdf|txt|html?|xml|json|csv)$/i.test(n));
  },
  acceptEntry: (name) => isGed(name) && !/(^|\/)(__MACOSX|\.)/.test(name),
  read(input, ctx) {
    const warnings: string[] = [];
    let bytes: Uint8Array = input.bytes;
    if (input.entries) {
      const geds = input.entries.filter((e) => isGed(e.name)).sort((a, b) => b.bytes.length - a.bytes.length);
      if (!geds.length) {
        return { segments: [], changes: [], counts: {}, warnings: ["The zip holds no .ged file."], extract: false };
      }
      bytes = geds[0].bytes;
      if (geds.length > 1) warnings.push(`The zip holds ${geds.length} .ged files; read the largest, ${geds[0].name}.`);
    }
    const decoded = decodeGedcom(bytes);
    const file = parseGedcom(decoded.text);
    if (decoded.encoding === "windows-1252") warnings.push("The file is not UTF-8; it was read as Windows-1252. Check that names with æ, ø and å look right.");
    if (file.badLines) warnings.push(`${file.badLines} lines of the file could not be read and were skipped.`);
    if (!file.indis.length) warnings.push("The file holds no people.");
    return buildPlan(file, ctx, warnings);
  },
};

export default gedcomImporter;
