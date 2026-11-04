/**
 * What can be checked, and who may (server-only): each target type loads its text through the library that owns it,
 * with that library's access rules, so a check never reads something the viewer can't. Wiki pages and documents being
 * edited send their own live text; everything else is read here.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, wikiPages } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import type { TargetType } from "@/lib/corpus";
import { artifactText, blockAt, type MappedText } from "./blocks";
import { ComplianceError } from "./index";

export type LoadedTarget = {
  text: string; title: string | null; version: number | null; sensitive: boolean;
  context: { artifactKind?: string | null; wikiSlug?: string | null; nodeKinds?: string[]; tags?: string[] };
  canEdit: boolean;
  /** Documents: which block an offset is in. */
  mapped?: MappedText;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gone = () => new ComplianceError(404, "That isn't here, or you can't open it.");

/** A readable sentence per proposal in an answer (what would change if it were approved). */
function proposalSentences(list: { type: string; [k: string]: unknown }[]): string[] {
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  return list.map((p) => {
    switch (p.type) {
      case "propose_reminder": return `Proposed reminder: ${s(p.title)}${p.dueAt ? ` (due ${s(p.dueAt)})` : ""}${p.detail ? `. ${s(p.detail)}` : ""}`;
      case "propose_fact": return `Proposed fact: ${s(p.from)} ${s(p.relation).replace(/_/g, " ")} ${s(p.to)}`;
      case "propose_wiki_note": return `Proposed wiki note "${s(p.title)}":\n${s(p.text)}`;
      case "propose_memory": return `Proposed rule to remember: ${s(p.text)}`;
      default: return "";
    }
  }).filter(Boolean);
}

export async function loadTarget(v: Viewer, type: TargetType, id: string): Promise<LoadedTarget> {
  if (!UUID.test(id)) throw gone();
  switch (type) {
    case "wiki": {
      const [row] = await db.select({ slug: wikiPages.slug }).from(wikiPages).where(and(eq(wikiPages.id, id), eq(wikiPages.graphId, v.graphId))).limit(1);
      if (!row) throw gone();
      const wiki = await import("@/lib/wiki");
      const page = await wiki.getPage(v, row.slug);
      if (!page) throw gone();
      return { text: page.contentText ?? "", title: page.title, version: page.version, sensitive: false, context: { wikiSlug: row.slug }, canEdit: !!page.can.edit };
    }
    case "artifact": {
      const { getArtifact, ArtifactError } = await import("@/lib/artifacts");
      try {
        const { artifact } = await getArtifact(v, id);
        const mapped = artifactText(artifact.content as never, artifact.title);
        return { text: mapped.text, title: artifact.title, version: artifact.version, sensitive: artifact.sensitive, context: { artifactKind: artifact.kind }, canEdit: artifact.canEdit, mapped };
      } catch (e) {
        if (e instanceof ArtifactError) throw gone();
        throw e;
      }
    }
    case "message": {
      const [row] = await db.select({ content: messages.content, role: messages.role, sensitivity: conversations.sensitivity })
        .from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(messages.id, id), eq(conversations.userId, v.id), eq(conversations.graphId, v.graphId))).limit(1);
      if (!row || row.role !== "assistant") throw gone();
      const { parseProposals } = await import("@/lib/assistant/proposals");
      const parsed = parseProposals(row.content);
      const text = [parsed.text.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, ""), ...proposalSentences(parsed.proposals as never)].join("\n\n");
      return { text, title: null, version: null, sensitive: row.sensitivity !== "normal", context: {}, canEdit: true };
    }
    case "change_set": {
      const { getChangeSet } = await import("@/lib/changes");
      const cs = await getChangeSet(v, id);
      if (!cs) throw gone();
      const kinds = cs.changes.map((c) => (typeof c.payload.kind === "string" ? c.payload.kind : null)).filter((k): k is string => !!k);
      const lines = cs.changes.filter((c) => c.included).map((c) => [c.summary, c.note].filter(Boolean).join(". "));
      return { text: lines.join("\n"), title: cs.title, version: null, sensitive: false, context: { nodeKinds: kinds }, canEdit: false };
    }
    case "node": {
      const n = await gbrain.getNode(v, id);
      if (!n) throw gone();
      const props = Object.entries(n.props ?? {}).filter(([, val]) => typeof val === "string" || typeof val === "number").map(([k, val]) => `${k.replace(/_/g, " ")}: ${val}`);
      return { text: [n.label, n.summary ?? "", ...props].filter(Boolean).join("\n"), title: n.label, version: null, sensitive: n.sensitive, context: { nodeKinds: n.kind ? [n.kind] : [] }, canEdit: false };
    }
  }
}

export function blockOfFor(t: LoadedTarget): ((offset: number) => string | null) | undefined {
  const m = t.mapped;
  return m ? (o: number) => blockAt(m, o)?.id ?? null : undefined;
}
