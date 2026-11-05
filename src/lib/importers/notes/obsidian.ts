/**
 * Importer `obsidian`: a zip of an Obsidian vault (Markdown notes, usually with a .obsidian/ settings folder). Pure.
 *
 *  - every note is a searchable segment (frontmatter tags, aliases and dates in its header, [[links]] kept);
 *  - daily notes (2024-03-12.md) are dated by their name;
 *  - a note about a person (frontmatter `type: person`, a #person tag, a People/Personer folder, or named like a
 *    person the graph knows) is matched, or proposed when it says it is a person; known people gain only what they
 *    lack (aliases, an empty birthday/email/phone);
 *  - notes that [[link]] to a person, or name one the graph knows unambiguously, are proposed as documents linked to
 *    them. The model also reads the notes (`extract: true`).
 * It claims a zip only with a .obsidian/ folder, or one made only of Markdown (and pictures) with daily notes; a zip
 * of documents, of emails or a Notion export is left alone.
 */
import { matchPerson } from "../match";
import type { Importer, ImportInput, ImportContext, ImportPlan } from "../types";
import { decodeText } from "../chats/common";
import {
  fmList, fmText, linkNotesToPeople, noteSegment, parseDay, personPropKey, personPropValue, proposeFoundPeople, splitFrontmatter,
  type Note, type PersonFound,
} from "./common";

const MD = /\.md$/i;
const SKIP = /(^|\/)(__MACOSX|\.trash|\.git|node_modules)\/|(^|\/)\._/;
const CONFIG = /(^|\/)\.obsidian\//;
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|heic|pdf|canvas|excalidraw|mp3|m4a|webm|base)$/i;
const DAILY = /^(\d{4}-\d{2}-\d{2})$/;
/** Notion puts a 32-hex id in every file name. */
export const NOTION_ID = / [0-9a-f]{32}(?=\.\w+$|\/|$)/;
const PERSON_TYPES = /^(person|people|contact|kontakt|personer|menneske)$/i;
const PEOPLE_FOLDER = /(^|\/)(people|persons|personer|contacts|kontakter|folk|familie|family)\//i;

export function isObsidianVault(names: string[]): boolean {
  const files = names.filter((n) => !n.endsWith("/") && !SKIP.test(n));
  const md = files.filter((n) => MD.test(n) && !CONFIG.test(n));
  if (!md.length) return false;
  if (files.some((n) => CONFIG.test(n))) return true;
  if (md.length < 3 || md.some((n) => NOTION_ID.test(n))) return false;
  if (!files.every((n) => MD.test(n) || ATTACHMENT.test(n))) return false;
  return md.some((n) => DAILY.test(stem(n)));
}

const stem = (path: string) => (path.split("/").pop() ?? path).replace(MD, "");

/** [[Target]], [[Target|shown]], [[Target#Heading]]; not ![[embeds]] of pictures. */
export function wikilinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(!?)\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const target = m[2].trim();
    if (m[1] && /\.\w{2,5}$/.test(target) && !MD.test(target)) continue;
    out.add((target.split("/").pop() ?? target).replace(MD, ""));
  }
  return [...out];
}

/** #tags in the text (not headings, not inside code, not colours like #fff). */
export function inlineTags(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out = new Set<string>();
  for (const m of plain.matchAll(/(?:^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) {
    if (/^[0-9a-f]{3,8}$/i.test(m[1])) continue;
    out.add(m[1]);
  }
  return [...out];
}

type VaultNote = Note & { path: string; tags: string[]; aliases: string[]; fmType: string | null; fm: Record<string, string | string[]>; fmRaw: string };

function readNote(path: string, md: string): VaultNote {
  const { fm, body, raw } = splitFrontmatter(md);
  const name = stem(path);
  const daily = DAILY.exec(name)?.[1] ?? null;
  const day = daily ?? parseDay(fmText(fm.date) ?? fmText(fm.dato) ?? fmText(fm.created) ?? null);
  const tags = [...new Set([...fmList(fm.tags ?? fm.tag).map((t) => t.replace(/^#/, "")), ...inlineTags(body)])];
  const where = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
  return {
    key: path, path, title: fmText(fm.title) ?? name, where, text: body, day,
    links: wikilinks(body), tags, aliases: fmList(fm.aliases ?? fm.alias), fmType: fmText(fm.type ?? fm.category ?? fm.kind), fm, fmRaw: raw,
  };
}

function isPersonNote(n: VaultNote): boolean {
  return (!!n.fmType && PERSON_TYPES.test(n.fmType.replace(/^\[\[|\]\]$/g, "")))
    || n.tags.some((t) => PERSON_TYPES.test(t.split("/").pop() ?? t))
    || PEOPLE_FOLDER.test(`${n.path}`);
}

function personFrom(n: VaultNote, certain: boolean): PersonFound {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(n.fm)) {
    const key = personPropKey(k);
    const val = key ? personPropValue(key, fmText(v) ?? "") : null;
    if (key && val && !props[key]) props[key] = val;
  }
  const quote = n.fmRaw.trim() ? n.fmRaw.replace(/^---\s*|\s*---\s*$/g, "").trim().split("\n").slice(0, 4).join("\n") : n.title;
  return { name: stem(n.path), aliases: n.aliases, props, quote, region: n.path, certain };
}

/** The vault's own folder ("My Vault/…") is dropped from every path. */
function commonRoot(paths: string[]): string {
  const firsts = new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/") + 1) : "")));
  return firsts.size === 1 ? [...firsts][0] : "";
}

function readObsidian(input: ImportInput, ctx: ImportContext): ImportPlan {
  const entries = (input.entries ?? []).filter((e) => MD.test(e.name) && !CONFIG.test(e.name) && !SKIP.test(e.name));
  if (!entries.length) return { segments: [], changes: [], counts: {}, warnings: ["No notes were found in this vault."] };
  const root = commonRoot(entries.map((e) => e.name));
  const notes = entries.map((e) => readNote(e.name.slice(root.length), decodeText(e.bytes)));
  const da = ctx.locale === "da";

  const found: PersonFound[] = [];
  for (const n of notes) {
    if (DAILY.test(stem(n.path))) continue;
    if (isPersonNote(n)) found.push(personFrom(n, true));
    else if (matchPerson(ctx.known, { name: stem(n.path) })) found.push(personFrom(n, false));
  }
  const people = proposeFoundPeople(found, ctx, "the Obsidian vault");
  const linked = linkNotesToPeople(notes, ctx, { app: "the Obsidian vault", people: people.index, propKey: "obsidianPath" });

  const segments = notes.map((n) => noteSegment(n, [
    n.day ? `${da ? "Dag" : "Day"}: ${n.day}` : "",
    n.aliases.length ? `${da ? "Også kaldt" : "Also called"}: ${n.aliases.join(", ")}` : "",
    n.tags.length ? `Tags: ${n.tags.map((t) => `#${t}`).join(" ")}` : "",
  ]));
  const daily = notes.filter((n) => DAILY.test(stem(n.path))).length;
  const vault = root.replace(/\/$/, "");
  return {
    segments,
    changes: [...people.changes, ...linked.changes],
    counts: {
      notes: notes.length, "daily notes": daily, tags: new Set(notes.flatMap((n) => n.tags)).size,
      "new people": people.proposed, "people already known": people.matched, "people updated": people.updates,
      "notes naming people": linked.notesLinked, "links to people": linked.links,
    },
    warnings: linked.warnings,
    title: da ? `Obsidian-vault${vault ? ` “${vault}”` : ""}: ${notes.length} noter` : `Obsidian vault${vault ? ` “${vault}”` : ""}: ${notes.length} notes`,
    extract: true,
  };
}

export const obsidianImporter: Importer = {
  id: "obsidian",
  label: "Obsidian vault",
  mime: "text/markdown",
  detect: () => false,
  detectArchive: ({ names }) => isObsidianVault(names),
  acceptEntry: (name) => MD.test(name) && !CONFIG.test(name) && !SKIP.test(name),
  read: readObsidian,
};
