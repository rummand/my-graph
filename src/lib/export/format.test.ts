import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { assembleExport, fileNameFor, graphFolder, safeName, type GraphDataset, type Row } from "./format";
import { writeZip } from "./zip";

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const KEY1 = `ab/${"ab".repeat(32)}`;
const KEY2 = `cd/${"cd".repeat(32)}`;

function dataset(gid: string, name: string, over: Partial<GraphDataset> = {}): GraphDataset {
  const n = (id: string, label: string, graphId = gid): Row => ({ id, graphId, type: "person", label, embedding: [0.1, 0.2], search: "'anna':1", props: {} });
  return {
    graph: { id: gid, name, kind: "family", role: "owner", createdAt: new Date("2026-01-01T00:00:00Z") },
    mode: "full",
    nodes: [n(`${gid}-n1`, `${name} person`), n(`${gid}-n2`, `${name} school`)],
    edges: [{ id: `${gid}-e1`, graphId: gid, fromId: `${gid}-n1`, toId: `${gid}-n2`, relation: "attends", status: "confirmed" }],
    provenance: [
      { id: `${gid}-p1`, graphId: gid, subjectType: "edge", subjectId: `${gid}-e1`, sourceId: `${gid}-s1`, quote: "goes to school", activity: "llm_extraction" },
    ],
    sources: [{ id: `${gid}-s1`, graphId: gid, title: `${name} letter`, mime: "application/pdf", storageKey: gid === G1 ? KEY1 : KEY2, sha256: "x", size: 5, meta: {}, textContent: "goes to school" }],
    wikiPages: [{ id: `${gid}-w1`, graphId: gid, title: `${name} page`, content: { type: "doc" } }],
    wikiRevisions: [{ id: `${gid}-r1`, pageId: `${gid}-w1`, version: 1 }],
    history: [{ id: `${gid}-h1`, graphId: gid, subjectType: "node", subjectId: `${gid}-n1`, kind: "created" }],
    reminders: [], conversations: [], messages: [], memories: [], artifacts: [], referencedNodes: [],
    ...over,
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mg-export-"));
  await mkdir(path.join(dir, "ab"), { recursive: true });
  await mkdir(path.join(dir, "cd"), { recursive: true });
  await writeFile(path.join(dir, KEY1), "PDF-1");
  await writeFile(path.join(dir, KEY2), "PDF-2");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const person = { id: "u1", name: "Anna", email: "anna@example.com" };

describe("export scope", () => {
  it("a graph export contains that graph only, even if the loader handed it more", () => {
    const leaky = dataset(G1, "Family", {
      // Rows from another graph slipped into this graph's lists:
      nodes: [...dataset(G1, "Family").nodes, { id: "foreign", graphId: G2, type: "person", label: "Work secret" }],
      edges: [...dataset(G1, "Family").edges, { id: "foreign-e", graphId: G2, fromId: `${G1}-n1`, toId: "foreign", relation: "knows" }],
      sources: [...dataset(G1, "Family").sources, { id: "foreign-s", graphId: G2, title: "Work contract", storageKey: KEY2 }],
      wikiRevisions: [...dataset(G1, "Family").wikiRevisions, { id: "foreign-r", pageId: `${G2}-w1`, version: 3 }],
      history: [...dataset(G1, "Family").history, { id: "foreign-h", graphId: G1, subjectType: "node", subjectId: "foreign", kind: "created" }],
    });
    const { entries, manifest } = assembleExport({
      scope: "graph", createdAt: new Date(), person, account: null, allowedGraphIds: [G1],
      graphs: [leaky, dataset(G2, "Work")],
    });
    const text = JSON.stringify(entries);
    expect(text).not.toContain("Work secret");
    expect(text).not.toContain("Work contract");
    expect(text).not.toContain("foreign");
    expect(text).not.toContain(G2);
    expect(manifest.graphs.map((g) => g.id)).toEqual([G1]);
    expect(entries.filter((e) => e.kind === "file").map((e) => e.kind === "file" && e.file.storageKey)).toEqual([KEY1]);
    expect(entries.some((e) => e.path === "account.json")).toBe(false);
  });

  it("drops facts whose ends aren't exported and provenance for things that aren't", () => {
    const d = dataset(G1, "Family", {
      nodes: [{ id: "a", graphId: G1, type: "person", label: "A" }],
      edges: [{ id: "e-dangling", graphId: G1, fromId: "a", toId: "hidden", relation: "knows" }],
      provenance: [{ id: "p-hidden", graphId: G1, subjectType: "node", subjectId: "hidden", quote: "private note" }],
    });
    const { manifest, entries } = assembleExport({ scope: "graph", createdAt: new Date(), person, account: null, allowedGraphIds: [G1], graphs: [d] });
    expect(manifest.totals.edges).toBe(0);
    expect(manifest.totals.provenance).toBe(0);
    expect(JSON.stringify(entries)).not.toContain("private note");
  });

  it("an account export holds each allowed graph in its own folder, plus account.json", () => {
    const { entries, manifest } = assembleExport({
      scope: "account", createdAt: new Date(), person, account: { id: "u1", email: "anna@example.com" }, allowedGraphIds: [G1, G2],
      graphs: [dataset(G1, "Family"), { ...dataset(G2, "Work"), mode: "mine" }],
    });
    expect(manifest.graphs.map((g) => [g.id, g.mode])).toEqual([[G1, "full"], [G2, "mine"]]);
    expect(entries.some((e) => e.path === "account.json")).toBe(true);
    expect(entries.some((e) => e.path === `${graphFolder({ id: G2, name: "Work" })}/nodes.json`)).toBe(true);
    expect(manifest.totals.nodes).toBe(4);
  });

  it("never exports search vectors or embeddings", () => {
    const { entries } = assembleExport({ scope: "graph", createdAt: new Date(), person, account: null, allowedGraphIds: [G1], graphs: [dataset(G1, "Family")] });
    const nodes = entries.find((e) => e.path.endsWith("/nodes.json"));
    expect(nodes && nodes.kind === "json" && JSON.stringify(nodes.data)).not.toMatch(/embedding|search/);
  });
});

describe("the zip", () => {
  it("has a README, a manifest, the JSON files and the original files", async () => {
    const { entries, manifest } = assembleExport({ scope: "graph", createdAt: new Date("2026-11-04T10:00:00Z"), person, account: null, allowedGraphIds: [G1], graphs: [dataset(G1, "Family")] });
    const dest = path.join(dir, "out.zip");
    const res = await writeZip(entries, manifest, dest, (k) => path.join(dir, k));
    expect(res.missingFiles).toEqual([]);
    const zip = await JSZip.loadAsync(await readFile(dest));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    const folder = graphFolder({ id: G1, name: "Family" });
    expect(names).toEqual([
      "README.md", `${folder}/edges.json`, `${folder}/files/${G1}-s1/Family letter.pdf`, `${folder}/graph.json`, `${folder}/history.json`,
      `${folder}/nodes.json`, `${folder}/provenance.json`, `${folder}/sources.json`, `${folder}/wiki.json`, "manifest.json",
    ].sort());
    const m = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(m).toMatchObject({ format: "my-graph-export", version: 1, scope: "graph", person: { id: "u1", name: "Anna" } });
    expect(m.person.email).toBeUndefined();
    expect(await zip.file(`${folder}/files/${G1}-s1/Family letter.pdf`)!.async("string")).toBe("PDF-1");
    const wiki = JSON.parse(await zip.file(`${folder}/wiki.json`)!.async("string"));
    expect(wiki[0].revisions).toHaveLength(1);
    const sources = JSON.parse(await zip.file(`${folder}/sources.json`)!.async("string"));
    expect(sources[0].exportPath).toBe(`${folder}/files/${G1}-s1/Family letter.pdf`);
  });

  it("lists originals that are missing on the server instead of failing", async () => {
    const d = dataset(G1, "Family", { sources: [{ id: "s9", graphId: G1, title: "Gone", storageKey: `ef/${"ef".repeat(32)}`, mime: "image/jpeg" }] });
    const { entries, manifest } = assembleExport({ scope: "graph", createdAt: new Date(), person, account: null, allowedGraphIds: [G1], graphs: [d] });
    const res = await writeZip(entries, manifest, path.join(dir, "missing.zip"), (k) => path.join(dir, k));
    expect(res.missingFiles).toEqual([`${graphFolder({ id: G1, name: "Family" })}/files/s9/Gone.jpg`]);
  });
});

describe("names", () => {
  it("makes file and folder names safe", () => {
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeName("  ")).toBe("untitled");
    expect(fileNameFor({ id: "s", title: "Report: Q3?", mime: "application/pdf", meta: {} })).toBe("Report_ Q3_.pdf");
    expect(fileNameFor({ id: "s", title: "x", mime: null, meta: { filename: "scan 01.HEIC" } })).toBe("scan 01.HEIC");
    expect(graphFolder({ id: G1, name: "Anna's Graph" })).toBe("graphs/anna's-graph-11111111");
  });
});
