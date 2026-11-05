/**
 * Notion's blocks, rich text and properties turned into the importer's batches (pure). Headings keep their level,
 * lists and to-dos their depth, and mentions of people and dates are collected as well as written out in the text.
 */
import type { NotionBlock, NotionDatabasePayload, NotionPagePayload, NotionPerson } from "@/lib/importers/notion/schema";

export type RichText = {
  type?: string; plain_text?: string; href?: string | null;
  mention?: { type?: string; user?: RawUser; date?: { start?: string; end?: string | null } };
};

export type RawUser = { id: string; object?: string; type?: string; name?: string | null; person?: { email?: string } };

export type RawBlock = { id: string; type: string; has_children?: boolean; [k: string]: unknown };

export type RawProperty = { id?: string; type: string; [k: string]: unknown };

export type RawPage = {
  id: string; object: "page"; url?: string; created_time?: string; last_edited_time?: string; archived?: boolean; in_trash?: boolean;
  created_by?: RawUser; parent?: { type?: string; database_id?: string; page_id?: string };
  properties?: Record<string, RawProperty>;
};

export type RawDatabase = {
  id: string; object: "database"; url?: string; last_edited_time?: string; archived?: boolean; in_trash?: boolean;
  title?: RichText[]; properties?: Record<string, { type: string; name?: string }>;
};

export type Mentions = { people: Map<string, NotionPerson>; dates: Map<string, { start: string; end?: string | null }> };

export const newMentions = (): Mentions => ({ people: new Map(), dates: new Map() });

export function person(u: RawUser | undefined): NotionPerson | null {
  if (!u?.id || u.type === "bot" || !u.name) return null;
  return { id: u.id, name: u.name.slice(0, 200), ...(u.person?.email ? { email: u.person.email.slice(0, 320) } : {}) };
}

/** Rich text → plain text; people and dates it mentions are collected into `m`. */
export function plain(rt: RichText[] | undefined, m?: Mentions): string {
  return (rt ?? []).map((t) => {
    if (m && t.type === "mention") {
      const p = person(t.mention?.user);
      if (p) m.people.set(p.id, p);
      const d = t.mention?.date;
      if (d?.start) m.dates.set(`${d.start}|${d.end ?? ""}`, { start: d.start, end: d.end ?? null });
    }
    const s = t.plain_text ?? "";
    return t.href && t.type === "text" && !s.includes(t.href) ? `${s} (${t.href})` : s;
  }).join("");
}

type BlockBody = { rich_text?: RichText[]; checked?: boolean; title?: string; url?: string; caption?: RichText[]; cells?: RichText[][]; language?: string; expression?: string };

/** One Notion block as zero or one text block (children are read by the caller with depth + 1). */
export function renderBlock(b: RawBlock, depth: number, m: Mentions): NotionBlock | null {
  const body = (b[b.type] ?? {}) as BlockBody;
  const rt = () => plain(body.rich_text, m);
  const base = { id: b.id, depth };
  switch (b.type) {
    case "heading_1": case "heading_2": case "heading_3":
      return { ...base, type: "heading", level: Number(b.type.slice(-1)), text: rt() };
    case "paragraph": case "callout": case "toggle": {
      const s = rt();
      return s.trim() ? { ...base, type: "text", text: s } : null;
    }
    case "bulleted_list_item": case "numbered_list_item":
      return { ...base, type: "list", text: rt() };
    case "to_do":
      return { ...base, type: "todo", text: rt(), checked: !!body.checked };
    case "quote":
      return { ...base, type: "quote", text: rt() };
    case "code":
      return { ...base, type: "code", text: rt() };
    case "equation":
      return body.expression ? { ...base, type: "code", text: body.expression } : null;
    case "table_row":
      return { ...base, type: "table", text: (body.cells ?? []).map((c) => plain(c, m)).join(" | ") };
    case "child_page": case "child_database":
      return body.title ? { ...base, type: "child", text: body.title } : null;
    case "bookmark": case "link_preview": case "embed": {
      const cap = plain(body.caption, m);
      return body.url ? { ...base, type: "text", text: cap ? `${cap} (${body.url})` : body.url } : null;
    }
    case "divider":
      return { ...base, type: "divider", text: "" };
    default:
      return null;
  }
}

/** Children worth reading: not a child page or database (those are their own pages), not a synced copy's original. */
export function readChildren(b: RawBlock): boolean {
  return !!b.has_children && b.type !== "child_page" && b.type !== "child_database";
}

/** A property's value as words ("" when empty). People it names are collected into `m`. */
export function propertyText(p: RawProperty, m?: Mentions): string {
  const v = p[p.type] as unknown;
  const names = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => {
    const u = x as RawUser;
    const pp = person(u);
    if (pp && m) m.people.set(pp.id, pp);
    return u?.name ?? "";
  }).filter(Boolean).join(", ");
  switch (p.type) {
    case "title": case "rich_text": return plain(v as RichText[], m);
    case "number": return typeof v === "number" ? String(v) : "";
    case "select": case "status": return (v as { name?: string } | null)?.name ?? "";
    case "multi_select": return ((v as { name?: string }[] | null) ?? []).map((x) => x.name ?? "").filter(Boolean).join(", ");
    case "date": {
      const d = v as { start?: string; end?: string | null } | null;
      if (d?.start && m) m.dates.set(`${d.start}|${d.end ?? ""}`, { start: d.start, end: d.end ?? null });
      return d?.start ? (d.end ? `${d.start} – ${d.end}` : d.start) : "";
    }
    case "people": return names(v);
    case "created_by": case "last_edited_by": return names([v]);
    case "email": case "phone_number": case "url": return typeof v === "string" ? v : "";
    case "checkbox": return v === true ? "Yes" : "No";
    case "created_time": case "last_edited_time": return typeof v === "string" ? v : "";
    case "files": return ((v as { name?: string }[] | null) ?? []).map((f) => f.name ?? "").filter(Boolean).join(", ");
    case "relation": { const n = Array.isArray(v) ? v.length : 0; return n ? `${n} linked` : ""; }
    case "unique_id": { const u = v as { prefix?: string | null; number?: number } | null; return u?.number != null ? `${u.prefix ? `${u.prefix}-` : ""}${u.number}` : ""; }
    case "formula": {
      const f = v as { type?: string; string?: string | null; number?: number | null; boolean?: boolean | null; date?: { start?: string } | null } | null;
      if (!f?.type) return "";
      if (f.type === "date") return f.date?.start ?? "";
      const x = f[f.type as "string" | "number" | "boolean"];
      return x == null ? "" : String(x);
    }
    default: return "";
  }
}

export function titleOf(props: Record<string, RawProperty> | undefined): string {
  for (const p of Object.values(props ?? {})) if (p.type === "title") return plain(p.title as RichText[]).trim();
  return "";
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A page (with its blocks already rendered) as the importer's batch. */
export function pagePayload(p: RawPage, blocks: NotionBlock[], m: Mentions): NotionPagePayload {
  const values = Object.entries(p.properties ?? {}).filter(([, v]) => v.type !== "title")
    .map(([name, v]) => ({ name: cut(name, 200), type: v.type.slice(0, 40), value: cut(propertyText(v, m), 4000) }))
    .filter((x) => x.value);
  const by = person(p.created_by);
  return {
    kind: "page",
    page: {
      id: p.id, title: cut(titleOf(p.properties) || "Untitled", 2000),
      ...(p.url ? { url: p.url } : {}), ...(p.created_time ? { createdAt: p.created_time } : {}), ...(p.last_edited_time ? { lastEdited: p.last_edited_time } : {}),
      ...(by ? { createdBy: by } : {}),
    },
    values,
    blocks: blocks.map((b) => ({ ...b, text: cut(b.text, 20_000) })),
    mentions: { people: [...m.people.values()], dates: [...m.dates.values()] },
  };
}

/** A database and its rows as the importer's batch (rows sorted by id, so the same rows give the same bytes). */
export function databasePayload(db: RawDatabase, rows: RawPage[]): NotionDatabasePayload {
  const properties = Object.entries(db.properties ?? {}).map(([name, p]) => ({ name: cut(name, 200), type: p.type.slice(0, 40) }));
  return {
    kind: "database",
    database: { id: db.id, title: cut(plain(db.title).trim() || "Untitled database", 2000), ...(db.url ? { url: db.url } : {}), ...(db.last_edited_time ? { lastEdited: db.last_edited_time } : {}) },
    properties,
    rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)).map((r) => {
      const entries = Object.entries(r.properties ?? {});
      return {
        id: r.id, title: cut(titleOf(r.properties) || "Untitled", 2000), ...(r.url ? { url: r.url } : {}), ...(r.last_edited_time ? { lastEdited: r.last_edited_time } : {}),
        values: entries.filter(([, v]) => v.type !== "title").map(([name, v]) => ({ name: cut(name, 200), type: v.type.slice(0, 40), value: cut(propertyText(v), 4000) })).filter((x) => x.value),
        emails: entries.filter(([, v]) => v.type === "email").map(([, v]) => propertyText(v)).filter(Boolean).slice(0, 20),
        phones: entries.filter(([, v]) => v.type === "phone_number").map(([, v]) => propertyText(v)).filter(Boolean).slice(0, 20),
      };
    }),
  };
}
