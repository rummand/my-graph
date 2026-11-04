/**
 * Documents and correspondence on the timeline. Pure (no DB): dated library items become "document" marks, and
 * email messages are grouped into conversations ("thread" items) placed on the lanes of their participants.
 */
import { resolveThreads } from "@/lib/ingest/mail";
import { laneIdsFor } from "./pure";
import type { DocKind, ThreadInfo, TimePrecision, TimelineItem } from "./types";

export type DatedSource = {
  id: string;
  title: string;
  mime: string | null;
  kind: string;
  documentDate: Date;
  documentDatePrecision: string | null;
  threadKey: string | null;
  nodeId: string | null;
  sensitive: boolean;
  meta: Record<string, unknown>;
};

export type Addr = { name: string | null; email: string; role?: string };

const PRECISIONS = new Set(["minute", "day", "month", "year"]);
export const toPrecision = (p: string | null): TimePrecision | null => (p && PRECISIONS.has(p) ? (p as TimePrecision) : null);

export function isMail(s: Pick<DatedSource, "mime" | "kind">): boolean {
  return s.mime === "message/rfc822" || s.kind === "email";
}

const DOC_KINDS = new Set<DocKind>(["mail", "letter", "scan", "photo", "recording", "note", "file"]);
export function docKindFor(s: Pick<DatedSource, "mime" | "kind" | "meta">): DocKind {
  const k = s.meta?.docKind;
  if (typeof k === "string" && DOC_KINDS.has(k as DocKind)) return k as DocKind;
  const m = (s.mime ?? "").toLowerCase();
  if (isMail(s)) return "mail";
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("audio/")) return "recording";
  if (m.startsWith("text/")) return "note";
  if (m === "application/pdf" || m.includes("wordprocessingml")) return "letter";
  return "file";
}

/** A dated non-mail document as a timeline mark, on the lanes of the people it names (else the shared lane). */
export function documentItem(s: DatedSource, personIds: string[], laneSet: ReadonlySet<string>): TimelineItem {
  return {
    id: `document:${s.id}`, kind: "document", title: s.title, summary: null,
    start: s.documentDate.toISOString(), end: null, precision: toPrecision(s.documentDatePrecision) ?? "day", status: "confirmed",
    laneIds: laneIdsFor(personIds, laneSet), personIds, nodeId: s.nodeId, sourceId: s.id, sensitive: s.sensitive, docKind: docKindFor(s),
  };
}

type EmailMeta = { messageId?: string | null; inReplyTo?: string | null; references?: string[]; participants?: Addr[]; from?: string | null; subject?: string | null };
const emailOf = (s: DatedSource): EmailMeta => (s.meta?.email ?? {}) as EmailMeta;

/** "Re: Sv: Forældremøde" → "Forældremøde" (keeps the original casing). */
export function cleanSubject(s: string): string {
  let t = s.trim();
  for (;;) {
    const next = t.replace(/^\s*(re|sv|aw|fw|fwd|vs|vedr|wg|tr)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === t) break;
    t = next;
  }
  return t || s;
}

/**
 * Group mail into conversations: the stored thread key first, joined across uploads by Message-ID chains (a reply
 * in one upload and its parent in another end up together). Each conversation becomes one "thread" item spanning
 * first to last message, on the lanes of everyone on it that the graph knows.
 */
export function buildThreadItems(mail: DatedSource[], opts: {
  personFor: (a: Addr) => string | null;
  laneSet: ReadonlySet<string>;
}): TimelineItem[] {
  // Union: stored key ↔ chain-resolved key.
  const resolved = resolveThreads(mail.map((s) => {
    const e = emailOf(s);
    return { messageId: e.messageId ?? undefined, inReplyTo: e.inReplyTo ?? undefined, references: e.references ?? [], subject: e.subject ?? s.title };
  }));
  const parent = new Map<string, string>();
  const find = (k: string): string => { let r = k; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra); };
  const keyOf = new Map<string, string>();
  for (const s of mail) {
    const e = emailOf(s);
    const stored = s.threadKey ?? `source:${s.id}`;
    if (!parent.has(stored)) parent.set(stored, stored);
    const chain = e.messageId ? resolved.get(e.messageId.toLowerCase()) : undefined;
    if (chain) { if (!parent.has(chain)) parent.set(chain, chain); union(stored, chain); }
    keyOf.set(s.id, stored);
  }
  const groups = new Map<string, DatedSource[]>();
  for (const s of mail) {
    const g = find(keyOf.get(s.id)!);
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(s);
  }

  const items: TimelineItem[] = [];
  for (const [, msgs] of groups) {
    msgs.sort((a, b) => a.documentDate.getTime() - b.documentDate.getTime() || a.id.localeCompare(b.id));
    const first = msgs[0], last = msgs[msgs.length - 1];
    const participants = new Map<string, { name: string; email: string; personId: string | null }>();
    const messages: ThreadInfo["messages"] = [];
    for (const m of msgs) {
      const e = emailOf(m);
      const parts = Array.isArray(e.participants) ? e.participants : [];
      let fromName: string | null = null, fromPerson: string | null = null;
      for (const p of parts) {
        if (!p || typeof p.email !== "string") continue;
        const email = p.email.toLowerCase();
        const personId = opts.personFor(p);
        if (!participants.has(email)) participants.set(email, { name: p.name ?? email, email, personId });
        if (p.role === "from" && !fromName) { fromName = p.name ?? email; fromPerson = personId; }
      }
      if (!fromName && e.from) fromName = e.from.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "") || e.from;
      messages.push({ sourceId: m.id, at: m.documentDate.toISOString(), from: fromName, fromPersonId: fromPerson, title: m.title });
    }
    const personIds = [...new Set([...participants.values()].map((p) => p.personId).filter((x): x is string => !!x))];
    const subject = cleanSubject(emailOf(first).subject ?? first.title);
    const names = [...participants.values()].slice(0, 3).map((p) => p.name.split(/\s+/)[0]);
    const summary = msgs.length > 1
      ? `${msgs.length} messages${names.length ? ` between ${names.join(", ")}${participants.size > 3 ? " and others" : ""}` : ""}`
      : messages[0].from ? `From ${messages[0].from}` : null;
    const end = msgs.length > 1 && last.documentDate.getTime() > first.documentDate.getTime() ? last.documentDate.toISOString() : null;
    items.push({
      id: `thread:${first.id}`, kind: "thread", title: subject, summary,
      start: first.documentDate.toISOString(), end, precision: "minute", status: "confirmed",
      laneIds: laneIdsFor(personIds, opts.laneSet), personIds, nodeId: first.nodeId, sourceId: first.id,
      sensitive: msgs.some((m) => m.sensitive), docKind: "mail",
      thread: { key: first.threadKey ?? `source:${first.id}`, subject, messages, participants: [...participants.values()] },
    });
  }
  return items;
}

/** Map an address to a person: their email first (props.email, a member's login), then a unique name match. */
export function personMatcher(people: { id: string; label: string; aliases: string[]; emails: string[] }[]) {
  const byEmail = new Map<string, string>();
  for (const p of people) for (const e of p.emails) byEmail.set(e.toLowerCase(), p.id);
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const byName = new Map<string, string | null>();
  for (const p of people) for (const n of [p.label, ...p.aliases]) {
    const k = norm(n);
    byName.set(k, byName.has(k) && byName.get(k) !== p.id ? null : p.id);
  }
  return (a: Addr): string | null => byEmail.get(a.email.toLowerCase()) ?? (a.name ? byName.get(norm(a.name)) ?? null : null);
}

