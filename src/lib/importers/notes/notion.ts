/**
 * Importer `notion_export`: Notion's "Export → Markdown & CSV" zip. Every file and folder carries a 32-hex id
 * ("Ferie 2024 1a2b….md"), which is how it is recognised and how titles are cleaned. Pure.
 *
 *  - pages are searchable segments, titled without their ids;
 *  - databases (CSV; the `_all.csv` version when both are there) become searchable rows; a people-like database
 *    ("People", "Kontakter", "Familie", or with email/phone/birthday columns) gives people: matched against the graph,
 *    proposed when new, known ones gain only what they lack;
 *  - pages that link to a person's page, or name a person the graph knows unambiguously, are proposed as documents
 *    linked to them. The model also reads the pages (`extract: true`).
 * Notion sometimes wraps the export in a second zip ("Export-…-Part-1.zip"); that one has to be unpacked first.
 */
import type { TextSegment } from "@/lib/ingest/chunk";
import type { Importer, ImportInput, ImportContext, ImportPlan } from "../types";
import { decodeText } from "../chats/common";
import { linkNotesToPeople, noteSegment, personPropKey, personPropValue, proposeFoundPeople, type Note, type PersonFound } from "./common";

const ID = / ([0-9a-f]{32})(?=(?:_all)?\.\w+$|\/|$)/;
const ID_G = / [0-9a-f]{32}(?=(?:_all)?\.\w+$|\/|$)/g;
const SKIP = /(^|\/)(__MACOSX)\/|(^|\/)\._/;
const PAGE = /\.md$/i;
const TABLE = /\.csv$/i;
const PEOPLE_DB = /^(people|persons|person|contacts|contact list|kontakter|kontaktliste|personer|familie|family|family members|familiemedlemmer|members|medlemmer|venner|friends|crm|address book|adressebog)$/i;

/** "Familie 0123…ef/Ferie 2024 4567…89.md" → "Familie/Ferie 2024". */
export const cleanPath = (p: string) => p.replace(ID_G, "").replace(/(_all)?\.(md|csv)$/i, "");
const idOf = (p: string) => ID.exec(p.split("/").pop() ?? "")?.[1] ?? null;
const titleOf = (p: string) => cleanPath(p).split("/").pop() ?? p;

export function isNotionExport(names: string[]): boolean {
  const files = names.filter((n) => !n.endsWith("/") && !SKIP.test(n) && (PAGE.test(n) || TABLE.test(n)));
  if (!files.length) return false;
  const withId = files.filter((n) => ID.test(n.split("/").pop() ?? ""));
  return withId.length >= 1 && withId.length >= files.length * 0.8;
}

/** RFC 4180 CSV (quotes, doubled quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Markdown links to other pages of the export: their titles. */
function pageLinks(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/\[([^\]\n]+)\]\(([^)\n]+\.md)\)/g)) {
    let target = m[2];
    try { target = decodeURIComponent(target); } catch { /* keep */ }
    out.add(titleOf(target));
    out.add(m[1].trim());
  }
  return [...out];
}

type Table = { path: string; name: string; header: string[]; rows: string[][]; lines: string[] };

function readTables(entries: { name: string; bytes: Uint8Array }[]): Table[] {
  // Prefer "X_all.csv" (every row) over "X.csv" (the current view) for the same database.
  const byBase = new Map<string, { name: string; bytes: Uint8Array }>();
  for (const e of entries) {
    const base = e.name.replace(/_all\.csv$/i, ".csv");
    if (!byBase.has(base) || /_all\.csv$/i.test(e.name)) byBase.set(base, e);
  }
  const out: Table[] = [];
  for (const e of byBase.values()) {
    const text = decodeText(e.bytes);
    const rows = parseCsv(text);
    if (rows.length < 2) continue;
    out.push({ path: e.name, name: titleOf(e.name), header: rows[0].map((h) => h.trim()), rows: rows.slice(1), lines: text.split(/\r?\n/) });
  }
  return out;
}

const isPeopleTable = (t: Table) => PEOPLE_DB.test(t.name.trim()) || t.header.slice(1).filter((h) => personPropKey(h)).length >= 2;

function peopleFromTable(t: Table): PersonFound[] {
  const out: PersonFound[] = [];
  for (const r of t.rows) {
    const name = r[0]?.trim();
    if (!name) continue;
    const props: Record<string, string> = {};
    t.header.forEach((h, i) => {
      if (i === 0) return;
      const key = personPropKey(h);
      const v = key ? personPropValue(key, r[i] ?? "") : null;
      if (key && v && !props[key]) props[key] = v;
    });
    const quote = t.lines.find((l) => l.includes(name)) ?? `${name}, ${Object.values(props).join(", ")}`;
    out.push({ name, props, quote, region: `${t.name} / ${name}`, certain: true });
  }
  return out;
}

const ROWS_PER_SEGMENT = 50;

function tableSegments(t: Table): TextSegment[] {
  const out: TextSegment[] = [];
  for (let i = 0; i < t.rows.length; i += ROWS_PER_SEGMENT) {
    const lines = t.rows.slice(i, i + ROWS_PER_SEGMENT).map((r) => {
      const [first, ...rest] = r;
      const fields = rest.map((v, j) => (v?.trim() ? `${t.header[j + 1] || `#${j + 2}`}: ${v.trim()}` : "")).filter(Boolean);
      return `- ${first?.trim() || "—"}${fields.length ? ` — ${fields.join("; ")}` : ""}`;
    });
    const part = t.rows.length > ROWS_PER_SEGMENT ? ` (${i + 1}–${Math.min(i + ROWS_PER_SEGMENT, t.rows.length)})` : "";
    out.push({ text: `Database: ${t.name}${part}\n${lines.join("\n")}`, at: { region: `${cleanPath(t.path)}${part}` } });
  }
  return out;
}

function readNotion(input: ImportInput, ctx: ImportContext): ImportPlan {
  const files = (input.entries ?? []).filter((e) => !SKIP.test(e.name));
  const pages = files.filter((e) => PAGE.test(e.name));
  const tables = readTables(files.filter((e) => TABLE.test(e.name)));
  if (!pages.length && !tables.length) return { segments: [], changes: [], counts: {}, warnings: ["No Notion pages were found in this export."] };
  const da = ctx.locale === "da";

  const notes: Note[] = pages.map((e) => {
    const md = decodeText(e.bytes);
    const path = cleanPath(e.name);
    const heading = /^#\s+(.+)$/m.exec(md)?.[1]?.trim();
    return {
      key: idOf(e.name) ?? path, title: heading || titleOf(e.name), where: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
      text: md.replace(/\]\(([^)\n]+)\)/g, (m, target: string) => { try { return `](${cleanPath(decodeURIComponent(target))})`; } catch { return m; } }),
      links: pageLinks(md),
    };
  });

  const peopleTables = tables.filter(isPeopleTable);
  const found = peopleTables.flatMap(peopleFromTable);
  const people = proposeFoundPeople(found, ctx, "Notion");
  const linked = linkNotesToPeople(notes, ctx, { app: "Notion", people: people.index, propKey: "notionId" });

  const segments = [...notes.map((n) => noteSegment(n)), ...tables.flatMap((t) => tableSegments(t))];
  const rows = tables.reduce((s, t) => s + t.rows.length, 0);
  const top = new Set(pages.map((p) => cleanPath(p.name).split("/")[0]));
  const name = top.size === 1 ? [...top][0] : null;
  return {
    segments,
    changes: [...people.changes, ...linked.changes],
    counts: {
      pages: notes.length, databases: tables.length, "database rows": rows,
      "new people": people.proposed, "people already known": people.matched, "people updated": people.updates,
      "pages naming people": linked.notesLinked, "links to people": linked.links,
    },
    warnings: linked.warnings,
    title: da ? `Notion${name ? ` “${name}”` : ""}: ${notes.length} sider` : `Notion${name ? ` “${name}”` : ""}: ${notes.length} pages`,
    extract: true,
  };
}

export const notionImporter: Importer = {
  id: "notion_export",
  label: "Notion export",
  mime: "text/markdown",
  detect: () => false,
  detectArchive: ({ names }) => isNotionExport(names),
  acceptEntry: (name) => (PAGE.test(name) || TABLE.test(name)) && !SKIP.test(name),
  read: readNotion,
};
