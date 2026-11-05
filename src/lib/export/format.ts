/**
 * The export format (pure: no database, no files). `assembleExport` turns what was loaded into the list of entries
 * that go in the zip, and checks scope a second time: a graph that wasn't asked for, or a row from another graph,
 * never makes it in, whatever the loader returned. The format is documented in EXPORT_README (shipped in every zip
 * as README.md) and in ./README.md.
 */

export const EXPORT_FORMAT = "my-graph-export";
export const EXPORT_VERSION = 1;

export type Row = Record<string, unknown> & { id: string };

export type GraphDataset = {
  graph: { id: string; name: string; kind: string; role: string; createdAt: string | Date | null };
  /** full: everything the person can see in a graph they own. mine: only what they added (a graph someone else owns). */
  mode: "full" | "mine";
  nodes: Row[];
  edges: Row[];
  provenance: Row[];
  sources: Row[];
  wikiPages: Row[];
  wikiRevisions: Row[];
  history: Row[];
  reminders: Row[];
  conversations: Row[];
  messages: Row[];
  memories: Row[];
  artifacts: Row[];
  /** Nodes their edges point at, which someone else added: id, type and label only. */
  referencedNodes: Row[];
};

export type ExportInput = {
  scope: "graph" | "account";
  createdAt: Date;
  person: { id: string; name: string; email: string };
  /** Only for scope = account. */
  account: Record<string, unknown> | null;
  /** The graphs this export may contain (the scope check). */
  allowedGraphIds: string[];
  graphs: GraphDataset[];
};

export type FileRef = { sourceId: string; storageKey: string; size: number | null; sha256: string | null; mime: string | null };

export type Entry =
  | { path: string; kind: "json"; data: unknown }
  | { path: string; kind: "text"; text: string }
  | { path: string; kind: "file"; file: FileRef };

export type GraphCounts = Record<"nodes" | "edges" | "provenance" | "sources" | "wikiPages" | "wikiRevisions" | "history" | "reminders" | "conversations" | "messages" | "memories" | "artifacts" | "files", number>;

export type Manifest = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  createdAt: string;
  scope: "graph" | "account";
  person: { id: string; name: string };
  graphs: { id: string; name: string; kind: string; role: string; mode: "full" | "mine"; folder: string; counts: GraphCounts }[];
  totals: GraphCounts;
  /** Filled in by the writer: files whose original was missing on the server. */
  missingFiles: string[];
};

/** Columns that are internal (search vectors, embeddings) and never exported. */
const DROP = new Set(["embedding", "search"]);

export function clean(r: Row): Row {
  const out: Row = { id: r.id };
  for (const [k, v] of Object.entries(r)) if (!DROP.has(k)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/** A file or folder name that is safe on every system. */
export function safeName(s: string, max = 80): string {
  const n = s.normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, max);
  return n || "untitled";
}

export function graphFolder(g: { id: string; name: string }): string {
  return `graphs/${safeName(g.name, 48).replace(/ /g, "-").toLowerCase()}-${g.id.slice(0, 8)}`;
}

const EXT: Record<string, string> = {
  "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/webp": ".webp", "image/gif": ".gif",
  "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/webm": ".webm", "video/mp4": ".mp4", "text/plain": ".txt",
  "text/markdown": ".md", "text/html": ".html", "message/rfc822": ".eml", "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

/** The original's file name in the zip: its own name when it had one, else the title plus an extension. */
export function fileNameFor(src: Row): string {
  const meta = (src.meta ?? {}) as Record<string, unknown>;
  const own = [meta.filename, meta.fileName, meta.originalName].find((x): x is string => typeof x === "string" && x.trim().length > 0);
  const base = safeName(own ?? String(src.title ?? "file"), 100);
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base;
  return `${base}${EXT[String(src.mime ?? "").toLowerCase()] ?? ""}`;
}

const STORAGE_KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

function emptyCounts(): GraphCounts {
  return { nodes: 0, edges: 0, provenance: 0, sources: 0, wikiPages: 0, wikiRevisions: 0, history: 0, reminders: 0, conversations: 0, messages: 0, memories: 0, artifacts: 0, files: 0 };
}

/** Rows of this graph only (rows that carry a graphId must carry this one). */
function inGraph(rows: Row[], graphId: string): Row[] {
  return rows.filter((r) => r.graphId === undefined || r.graphId === null ? false : r.graphId === graphId);
}

export function assembleExport(input: ExportInput): { entries: Entry[]; manifest: Manifest } {
  const allowed = new Set(input.allowedGraphIds);
  const entries: Entry[] = [];
  const totals = emptyCounts();
  const graphs: Manifest["graphs"] = [];
  const seen = new Set<string>();

  for (const d of input.graphs) {
    const gid = d.graph.id;
    if (!allowed.has(gid) || seen.has(gid)) continue;
    seen.add(gid);
    const folder = graphFolder(d.graph);

    const nodes = inGraph(d.nodes, gid).map(clean);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const referenced = inGraph(d.referencedNodes, gid).filter((n) => !nodeIds.has(n.id))
      .map((n) => ({ id: n.id, type: n.type, kind: n.kind ?? null, label: n.label }));
    const known = new Set([...nodeIds, ...referenced.map((n) => n.id)]);
    // A fact only travels with both of its ends.
    const edges = inGraph(d.edges, gid).filter((e) => known.has(String(e.fromId)) && known.has(String(e.toId))).map(clean);
    const edgeIds = new Set(edges.map((e) => e.id));
    const sources = inGraph(d.sources, gid).map(clean);
    const sourceIds = new Set(sources.map((s) => s.id));
    const provenance = inGraph(d.provenance, gid)
      .filter((p) => (p.subjectType === "node" && nodeIds.has(String(p.subjectId))) || (p.subjectType === "edge" && edgeIds.has(String(p.subjectId))))
      // A quote's source that isn't in the export is named by id only.
      .map((p) => clean({ ...p, sourceInExport: p.sourceId ? sourceIds.has(String(p.sourceId)) : false }));
    const pages = inGraph(d.wikiPages, gid).map(clean);
    const pageIds = new Set(pages.map((p) => p.id));
    const revisions = d.wikiRevisions.filter((r) => pageIds.has(String(r.pageId))).map(clean);
    const subjectIds = new Set([...nodeIds, ...edgeIds, ...pageIds, ...sourceIds]);
    const history = inGraph(d.history, gid).filter((h) => subjectIds.has(String(h.subjectId))).map(clean);
    const reminders = inGraph(d.reminders, gid).map(clean);
    const conversations = inGraph(d.conversations, gid).map(clean);
    const convIds = new Set(conversations.map((c) => c.id));
    const messages = d.messages.filter((m) => convIds.has(String(m.conversationId))).map(clean);
    const memories = inGraph(d.memories, gid).map(clean);
    const artifacts = inGraph(d.artifacts, gid).map(clean);

    const files: Entry[] = [];
    for (const s of sources) {
      const key = typeof s.storageKey === "string" ? s.storageKey : null;
      if (!key || !STORAGE_KEY.test(key)) continue;
      const p = `${folder}/files/${s.id}/${fileNameFor(s)}`;
      s.exportPath = p;
      files.push({ path: p, kind: "file", file: { sourceId: s.id, storageKey: key, size: (s.size as number | null) ?? null, sha256: (s.sha256 as string | null) ?? null, mime: (s.mime as string | null) ?? null } });
    }

    const counts: GraphCounts = {
      nodes: nodes.length, edges: edges.length, provenance: provenance.length, sources: sources.length, wikiPages: pages.length,
      wikiRevisions: revisions.length, history: history.length, reminders: reminders.length, conversations: conversations.length,
      messages: messages.length, memories: memories.length, artifacts: artifacts.length, files: files.length,
    };
    for (const k of Object.keys(totals) as (keyof GraphCounts)[]) totals[k] += counts[k];

    entries.push(
      { path: `${folder}/graph.json`, kind: "json", data: { ...clean({ ...d.graph, id: gid }), mode: d.mode } },
      { path: `${folder}/nodes.json`, kind: "json", data: nodes },
      { path: `${folder}/edges.json`, kind: "json", data: edges },
      { path: `${folder}/provenance.json`, kind: "json", data: provenance },
      { path: `${folder}/sources.json`, kind: "json", data: sources },
      { path: `${folder}/wiki.json`, kind: "json", data: pages.map((p) => ({ ...p, revisions: revisions.filter((r) => r.pageId === p.id) })) },
      { path: `${folder}/history.json`, kind: "json", data: history },
    );
    if (referenced.length) entries.push({ path: `${folder}/referenced-nodes.json`, kind: "json", data: referenced });
    if (reminders.length) entries.push({ path: `${folder}/reminders.json`, kind: "json", data: reminders });
    if (conversations.length) entries.push({ path: `${folder}/conversations.json`, kind: "json", data: conversations.map((c) => ({ ...c, messages: messages.filter((m) => m.conversationId === c.id) })) });
    if (memories.length) entries.push({ path: `${folder}/memories.json`, kind: "json", data: memories });
    if (artifacts.length) entries.push({ path: `${folder}/artifacts.json`, kind: "json", data: artifacts });
    entries.push(...files);
    graphs.push({ id: gid, name: d.graph.name, kind: d.graph.kind, role: d.graph.role, mode: d.mode, folder, counts });
  }

  const manifest: Manifest = {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, createdAt: input.createdAt.toISOString(), scope: input.scope,
    person: { id: input.person.id, name: input.person.name }, graphs, totals, missingFiles: [],
  };
  const head: Entry[] = [{ path: "README.md", kind: "text", text: EXPORT_README }];
  if (input.scope === "account" && input.account) head.push({ path: "account.json", kind: "json", data: input.account });
  return { entries: [...head, ...entries], manifest };
}

/** Shipped in every export as README.md. Keep in step with ./README.md. */
export const EXPORT_README = `# Your My Graph export

This zip holds a copy of your data from My Graph, in open formats you can read without My Graph.

## What is in it

- \`manifest.json\`: when it was made, for whom, which graphs, and how many of each thing.
- \`account.json\` (whole-account exports only): your profile, your household's name and the graphs you belong to.
- \`graphs/<name>-<id>/\`: one folder per graph.
  - \`graph.json\`: the graph's name, kind and your role in it. \`mode\` is \`full\` for a graph you own (everything
    you can see in it) or \`mine\` for a graph someone else owns (only what you added).
  - \`nodes.json\`: people, places, events, topics and documents. \`props\` holds their details (birthday, address…).
  - \`edges.json\`: the facts that connect them (\`fromId\` → \`relation\` → \`toId\`), with \`status\`
    (confirmed, unconfirmed, inferred, rejected, superseded) and \`confidence\`.
  - \`provenance.json\`: why each fact is believed: \`subjectType\`/\`subjectId\` (the node or edge), the source,
    the exact \`quote\`, where in the source (\`locator\`: page, characters, time), who or what read it
    (\`agentType\`, \`agentId\`) and how sure it was.
  - \`sources.json\`: the documents, photos, recordings, emails and pages the facts came from, with their text.
    \`exportPath\` points to the original file in this zip when there is one.
  - \`files/<source id>/<file name>\`: the original files, unchanged.
  - \`wiki.json\`: wiki pages (TipTap JSON in \`content\`, plain text in \`contentText\`) with every revision.
  - \`history.json\`: every change to the exported items: what moved, from what, to what, when and by whom.
  - \`referenced-nodes.json\` (only in \`mine\` mode): nodes someone else added that your facts point to (id and name).
  - \`reminders.json\`, \`conversations.json\` (with messages), \`memories.json\`, \`artifacts.json\`: yours, when there are any.

All files are UTF-8 JSON. Dates are ISO 8601 in UTC. Ids are UUIDs and match across files.
Items you couldn't see in My Graph (someone else's private items) are not in the export.
`;
