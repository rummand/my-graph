/**
 * The bundled code lists (server-only), read once from assets/codes. When a file is missing the table is empty and
 * every code suggestion is dropped (better no code than an unchecked one).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeTable, CodeTables } from "./codes";

const FILES = { "ICD-10": "icd10.json", "ICPC-2": "icpc2.json" } as const;

const g = globalThis as unknown as { __mgCodeTables?: Promise<CodeTables> };

async function load(file: string): Promise<CodeTable> {
  try {
    const raw = JSON.parse(await readFile(path.join(process.cwd(), "assets", "codes", file), "utf8")) as { codes?: CodeTable };
    return raw.codes ?? {};
  } catch (e) {
    console.error(`[clinical] code list ${file} could not be read:`, e instanceof Error ? e.message : e);
    return {};
  }
}

export function codeTables(): Promise<CodeTables> {
  return (g.__mgCodeTables ??= Promise.all([load(FILES["ICD-10"]), load(FILES["ICPC-2"])]).then(([icd, icpc]) => ({ "ICD-10": icd, "ICPC-2": icpc })));
}
