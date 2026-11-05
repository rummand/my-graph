/**
 * Work batches (pure): what the GitHub, Linear and Jira connectors bring in, in one shape, and how a batch becomes a
 * library source and one proposed change set. Shared by the `github`, `linear` and `jira` importers.
 *
 * A batch is one repository (GitHub), one team (Linear) or one project (Jira) for one sync window. Every issue and pull
 * request read goes into the source's text (searchable, cited), but only what matters is proposed:
 *   - the repository / project as a project node (a Linear team as an organization, its projects as projects),
 *   - the people on the person's own open work (assigned to or opened by them), matched against the graph first,
 *     and that they work on the project,
 *   - releases (event, kind "release") and dated milestones (event, kind "milestone"),
 *   - decisions: closed items labelled decision / ADR / RFC (event, kind "decision"),
 *   - reminders for the due dates of the person's own open issues.
 * Everything else (other people's issues, closed work, comments) stays in the source and the batch says so.
 * Nothing is written: every op carries a receipt pointing at its passage. Outside text is data, never instructions.
 */
import { roleRelation } from "@/lib/meta/roles";
import { z } from "zod";
import type { ChangeInput, Receipt } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { edgeKey, matchByLabel, matchPerson, normEmail, normName } from "../match";
import type { ImportContext, ImportKnown, ImportPlan } from "../types";

export const WORK_FORMAT = "mygraph.work/1";
export const WORK_PROVIDERS = ["github", "linear", "jira"] as const;
export type WorkProvider = (typeof WORK_PROVIDERS)[number];

const s = (max: number) => z.string().max(max);
const iso = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const workPerson = z.object({
  /** The id at the source (GitHub login, Linear user id, Jira accountId). */
  id: s(200),
  login: s(200).optional(),
  name: s(200).optional(),
  email: s(320).optional(),
  url: s(500).optional(),
  bot: z.boolean().optional(),
});
export type WorkPerson = z.infer<typeof workPerson>;

export const workItem = z.object({
  id: s(200),
  /** "#123", "ENG-42", "PROJ-7". */
  key: s(60),
  kind: z.enum(["issue", "pull_request"]),
  title: s(500),
  url: s(1000).optional(),
  /** As the source says it ("open", "In Progress", "merged"). */
  state: s(80),
  status: z.enum(["open", "done", "cancelled"]),
  /** Issue type at the source ("Bug", "Story", "Decision"), when it has one. */
  type: s(80).optional(),
  authorId: s(200).optional(),
  assigneeIds: z.array(s(200)).max(20).default([]),
  labels: z.array(s(120)).max(30).default([]),
  milestone: z.object({ name: s(200), dueOn: day.optional() }).optional(),
  cycle: s(200).optional(),
  /** A Linear project inside the team. */
  projectId: s(200).optional(),
  priority: s(60).optional(),
  createdAt: iso.optional(),
  updatedAt: iso,
  closedAt: iso.optional(),
  mergedAt: iso.optional(),
  dueOn: day.optional(),
  /** The description as plain text, shortened. */
  body: s(4000).optional(),
});
export type WorkItem = z.infer<typeof workItem>;

export const workBatch = z.object({
  format: z.literal(WORK_FORMAT),
  provider: z.enum(WORK_PROVIDERS),
  /** What the batch is about: a GitHub repository, a Jira project (both projects) or a Linear team (an organization). */
  scope: z.object({
    id: s(200), name: s(200), fullName: s(300).optional(), url: s(1000).optional(), description: s(2000).optional(),
    kind: z.enum(["repository", "project", "team"]),
  }),
  /** Projects inside the scope (Linear). */
  projects: z.array(z.object({ id: s(200), name: s(200), url: s(1000).optional(), description: s(2000).optional(), leadId: s(200).optional() })).max(100).default([]),
  /** The person who connected, as the source knows them. */
  me: workPerson.nullable(),
  people: z.array(workPerson).max(2000).default([]),
  items: z.array(workItem).max(1000).default([]),
  milestones: z.array(z.object({ id: s(200), name: s(300), dueOn: day.optional(), status: z.enum(["open", "done"]), url: s(1000).optional(), description: s(2000).optional() })).max(200).default([]),
  releases: z.array(z.object({ id: s(200), name: s(300), tag: s(200).optional(), at: iso, url: s(1000).optional(), body: s(4000).optional() })).max(100).default([]),
  window: z.object({ since: iso.nullable(), until: iso }),
  /** What the connector didn't read this time, by reason (more pages than a run reads, archived repositories …). */
  leftOut: z.record(z.string().max(40), z.number().int().min(0)).default({}),
});
export type WorkBatch = z.infer<typeof workBatch>;
export type WorkBatchInput = z.input<typeof workBatch>;

export const PROVIDER_LABEL: Record<WorkProvider, string> = { github: "GitHub", linear: "Linear", jira: "Jira" };

/** Caps, so one batch never turns into a proposal nobody can review. */
export const CAPS = { people: 25, releases: 10, milestones: 10, decisions: 10, reminders: 15, projects: 15 } as const;

const RELATIONS = {
  works_on: { key: "works_on", label: "works on", inverseLabel: "worked on by", fromTypes: ["person"], toTypes: ["project"], category: "work" },
  member_of: { key: "member_of", label: "member of", inverseLabel: "has member", fromTypes: ["person"], toTypes: ["organization"], category: "work" },
  belongs_to: { key: "belongs_to", label: "belongs to", inverseLabel: "has", fromTypes: ["project"], toTypes: ["organization"], category: "work" },
} as const;

/** True for a JSON upload that is one of these batches (cheap, certain: the format marker and the provider). */
export function detectWork(provider: WorkProvider, f: { filename: string; head: Uint8Array }): boolean {
  if (!/\.json$/i.test(f.filename)) return false;
  const head = Buffer.from(f.head).toString("utf8");
  return head.includes(`"format":"${WORK_FORMAT}"`) && head.includes(`"provider":"${provider}"`);
}

/** The bytes a connector hands to importPayload (format first, so `detectWork` sees it in the head). */
export function encodeWork(batch: WorkBatchInput): Uint8Array {
  const { format, provider, ...rest } = batch;
  return new TextEncoder().encode(JSON.stringify({ format, provider, ...rest }));
}

const dateOf = (isoish: string | undefined | null) => (isoish ? isoish.slice(0, 10) : null);
const DECISION = /^(decision|decided|adr|rfc|architecture decision)\b/i;

export function isDecision(i: WorkItem): boolean {
  if (i.status !== "done") return false;
  return i.labels.some((l) => DECISION.test(l.trim())) || DECISION.test(i.type ?? "") || /^(ADR|RFC|Decision)[\s:#-]/i.test(i.title);
}

/** The person's own open work: assigned to them, or opened by them and assigned to nobody else. */
export function isMine(i: WorkItem, meId: string | null): boolean {
  if (!meId || i.status !== "open") return false;
  return i.assigneeIds.includes(meId) || (i.authorId === meId && i.assigneeIds.length === 0);
}

function personLine(p: WorkPerson | undefined, fallback: string | undefined): string {
  if (!p) return fallback ?? "someone";
  if (p.name && p.login && normName(p.name) !== normName(p.login)) return `${p.name} (@${p.login})`;
  return p.name ?? (p.login ? `@${p.login}` : p.email ?? p.id);
}

function itemText(i: WorkItem, people: Map<string, WorkPerson>, projects: Map<string, string>): string {
  const what = i.kind === "pull_request" ? "pull request" : (i.type?.toLowerCase() ?? "issue");
  const parts = [`${i.key} ${i.title} (${what}, ${i.state})`];
  const facts: string[] = [];
  if (i.authorId) facts.push(`opened by ${personLine(people.get(i.authorId), i.authorId)}${i.createdAt ? ` on ${dateOf(i.createdAt)}` : ""}`);
  if (i.assigneeIds.length) facts.push(`assigned to ${i.assigneeIds.map((a) => personLine(people.get(a), a)).join(", ")}`);
  if (i.projectId && projects.get(i.projectId)) facts.push(`project ${projects.get(i.projectId)}`);
  if (i.cycle) facts.push(`cycle ${i.cycle}`);
  if (i.milestone) facts.push(`milestone ${i.milestone.name}${i.milestone.dueOn ? ` (due ${i.milestone.dueOn})` : ""}`);
  if (i.dueOn) facts.push(`due ${i.dueOn}`);
  if (i.priority) facts.push(`priority ${i.priority}`);
  if (i.labels.length) facts.push(`labels: ${i.labels.join(", ")}`);
  if (i.mergedAt) facts.push(`merged ${dateOf(i.mergedAt)}`);
  else if (i.closedAt) facts.push(`closed ${dateOf(i.closedAt)}`);
  facts.push(`updated ${dateOf(i.updatedAt)}`);
  parts.push(`${facts.join("; ")}.`);
  if (i.url) parts.push(i.url);
  const head = parts.join(" — ");
  return i.body?.trim() ? `${head}\n${i.body.trim()}` : head;
}

type Built = { text: string; start: number };

/** Segments joined the way the pipeline joins them ("\n\n"), with each one's place for the receipts. */
class Text {
  segments: TextSegment[] = [];
  private at = 0;
  add(text: string): Built {
    const start = this.at;
    this.segments.push({ text });
    this.at += text.length + 2;
    return { text, start };
  }
}

function receipt(ctx: ImportContext, b: Built, confidence = 1): Receipt {
  const firstLine = b.text.split("\n")[0];
  return { sourceId: ctx.sourceId, quote: firstLine.slice(0, 300), locator: { charStart: b.start, charEnd: b.start + firstLine.length }, confidence };
}

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A known person this source account is: by the account kept on the node, then email, then a unique name. */
export function matchWorkPerson(known: ImportKnown[], provider: WorkProvider, p: WorkPerson): ImportKnown | null {
  const handle = (p.login ?? p.id).toLowerCase();
  const byAccount = known.find((k) => k.type === "person" && strings(k.props[`${provider}Account`]).some((x) => x.toLowerCase() === handle));
  if (byAccount) return byAccount;
  // A login alone is not a name: only a real name may match by name.
  return matchPerson(known, { name: p.name ?? null, emails: p.email ? [p.email] : [] });
}

/** The known node for a scope or project: by the url kept on it, then by its name or full name (once). */
function matchProjectLike(known: ImportKnown[], type: "project" | "organization", name: string, url: string | undefined, fullName?: string): ImportKnown | null {
  if (url) {
    const u = url.replace(/\/+$/, "").toLowerCase();
    const byUrl = known.find((k) => k.type === type && strings(k.props.url).some((x) => x.replace(/\/+$/, "").toLowerCase() === u));
    if (byUrl) return byUrl;
  }
  return (fullName ? matchByLabel(known, type, fullName) : null) ?? matchByLabel(known, type, name);
}

/** Read a batch into text and one proposal. */
export function planWork(batch: WorkBatch, ctx: ImportContext): ImportPlan {
  const provider = batch.provider;
  const P = PROVIDER_LABEL[provider];
  const people = new Map(batch.people.map((p) => [p.id, p]));
  if (batch.me) people.set(batch.me.id, { ...people.get(batch.me.id), ...batch.me });
  const projectNames = new Map(batch.projects.map((p) => [p.id, p.name]));
  const meId = batch.me?.id ?? null;
  const text = new Text();
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  const vis = ctx.visibility;
  const scopeName = batch.scope.fullName ?? batch.scope.name;

  // ── The text: a header, then every item, release and milestone. ──
  const span = batch.window.since ? `updated ${dateOf(batch.window.since)} to ${dateOf(batch.window.until)}` : `up to ${dateOf(batch.window.until)}`;
  const scopeWord = batch.scope.kind === "repository" ? "repository" : batch.scope.kind === "team" ? "team" : "project";
  const n = batch.items.length;
  const what = provider === "github" ? `${n} issue${n === 1 ? "" : "s"} and pull requests` : `${n} issue${n === 1 ? "" : "s"}`;
  const header = text.add([
    `${P} ${scopeWord} ${scopeName}: ${what} ${span}.`,
    batch.scope.url ?? "",
    batch.scope.description ?? "",
  ].filter(Boolean).join("\n"));
  const projectBuilt = new Map<string, Built>();
  for (const p of batch.projects) projectBuilt.set(p.id, text.add([`Project ${p.name} in ${scopeName}.`, p.url ?? "", p.description ?? ""].filter(Boolean).join("\n")));
  const itemBuilt = new Map<string, Built>();
  const sorted = [...batch.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const i of sorted) itemBuilt.set(i.id, text.add(itemText(i, people, projectNames)));
  const releaseBuilt = new Map<string, Built>();
  for (const r of batch.releases) {
    releaseBuilt.set(r.id, text.add([`Release ${r.name}${r.tag && r.tag !== r.name ? ` (tag ${r.tag})` : ""} of ${scopeName}, published ${dateOf(r.at)}.${r.url ? ` ${r.url}` : ""}`, r.body?.trim() ?? ""].filter(Boolean).join("\n")));
  }
  const milestoneBuilt = new Map<string, Built>();
  for (const m of batch.milestones) {
    milestoneBuilt.set(m.id, text.add([`Milestone ${m.name} of ${scopeName}${m.dueOn ? `, due ${m.dueOn}` : ""} (${m.status === "done" ? "done" : "open"}).${m.url ? ` ${m.url}` : ""}`, m.description?.trim() ?? ""].filter(Boolean).join("\n")));
  }

  // ── What is proposed. ──
  const usedRelations = new Set<keyof typeof RELATIONS>();
  const usedKinds = new Set<"release">();
  const edgeOps: ChangeInput[] = [];
  const nodeOps: ChangeInput[] = [];
  const otherOps: ChangeInput[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (fromId: string, relation: keyof typeof RELATIONS, toId: string, r: Receipt) => {
    const k = edgeKey(fromId, relation, toId);
    if (ctx.existingEdges.has(k) || seenEdges.has(k)) return;
    seenEdges.add(k);
    usedRelations.add(relation);
    edgeOps.push({ op: "addEdge", fromId, toId, relation, status: "unconfirmed", receipt: r });
  };

  // The scope: a repository or project is a project; a team is an organization.
  const scopeType = batch.scope.kind === "team" ? "organization" : "project";
  const scopeKnown = matchProjectLike(ctx.known, scopeType, batch.scope.name, batch.scope.url, batch.scope.fullName);
  let scopeId: string;
  if (scopeKnown) scopeId = scopeKnown.id;
  else {
    scopeId = ctx.mint();
    nodeOps.push({
      op: "addNode", nodeId: scopeId, type: scopeType, label: batch.scope.name,
      aliases: batch.scope.fullName && batch.scope.fullName !== batch.scope.name ? [batch.scope.fullName] : undefined,
      summary: batch.scope.description?.slice(0, 300) || undefined,
      props: { ...(batch.scope.url ? { url: batch.scope.url } : {}), source: provider }, visibility: vis,
      note: `The ${P} ${scopeWord} this was read from.`, receipt: receipt(ctx, header),
    });
  }

  // Linear projects inside the team: the ones the batch's own work is in (or the person leads), at most a few.
  const projectIds = new Map<string, string>();
  const wantedProjects = new Set(batch.items.filter((i) => isMine(i, meId) && i.projectId).map((i) => i.projectId!));
  for (const p of batch.projects) if (meId && p.leadId === meId) wantedProjects.add(p.id);
  let projectsLeft = 0;
  for (const p of batch.projects) {
    if (!wantedProjects.has(p.id)) continue;
    if (projectIds.size >= CAPS.projects) { projectsLeft++; continue; }
    const b = projectBuilt.get(p.id)!;
    const k = matchProjectLike(ctx.known, "project", p.name, p.url);
    const id = k?.id ?? ctx.mint();
    projectIds.set(p.id, id);
    if (!k) nodeOps.push({ op: "addNode", nodeId: id, type: "project", label: p.name, summary: p.description?.slice(0, 300) || undefined, props: { ...(p.url ? { url: p.url } : {}), source: provider }, visibility: vis, receipt: receipt(ctx, b) });
    if (scopeType === "organization") addEdge(id, "belongs_to", scopeId, receipt(ctx, b));
  }

  // People: whoever is on the person's own open work (and the person), matched before anything new is proposed.
  const mine = sorted.filter((i) => isMine(i, meId));
  const involved = new Map<string, Built>();
  if (meId && mine.length) involved.set(meId, itemBuilt.get(mine[0].id)!);
  for (const i of mine) for (const id of [i.authorId, ...i.assigneeIds]) if (id && !involved.has(id)) involved.set(id, itemBuilt.get(i.id)!);
  const personIds = new Map<string, string>();
  let peopleLeft = 0;
  for (const [id, b] of involved) {
    const p = people.get(id);
    if (!p || p.bot) continue;
    if (personIds.size >= CAPS.people) { peopleLeft++; continue; }
    const k = matchWorkPerson(ctx.known, provider, p);
    if (k) { personIds.set(id, k.id); continue; }
    const label = p.name?.trim() || p.login || p.email;
    if (!label) continue;
    const nodeId = ctx.mint();
    personIds.set(id, nodeId);
    const props: Record<string, unknown> = { [`${provider}Account`]: p.login ?? p.id };
    if (p.email) props.email = normEmail(p.email);
    if (p.url) props.url = p.url;
    nodeOps.push({
      op: "addNode", nodeId, type: "person", label, aliases: p.login && p.login !== label ? [p.login] : undefined, props, visibility: vis,
      note: id === meId ? `You, as ${P} knows you.` : `On your ${P} work in ${scopeName}.`, receipt: receipt(ctx, b, p.name || p.email ? 0.9 : 0.7),
    });
  }
  for (const i of mine) {
    const b = itemBuilt.get(i.id)!;
    for (const id of [i.authorId, ...i.assigneeIds]) {
      const node = id ? personIds.get(id) : undefined;
      if (!node) continue;
      if (i.projectId && projectIds.has(i.projectId)) addEdge(node, "works_on", projectIds.get(i.projectId)!, receipt(ctx, b));
      if (scopeType === "project") addEdge(node, "works_on", scopeId, receipt(ctx, b));
      else addEdge(node, "member_of", scopeId, receipt(ctx, b));
      // Working together on it is a role they hold there (a colleague on the team or project), never a kind of person.
      if (id !== meId) {
        const rk = edgeKey(node, roleRelation("colleague"), scopeId);
        if (!ctx.existingEdges.has(rk) && !seenEdges.has(rk)) {
          seenEdges.add(rk);
          edgeOps.push({ op: "addEdge", fromId: node, toId: scopeId, relation: roleRelation("colleague"), status: "unconfirmed", confidence: 0.6, receipt: receipt(ctx, b) });
        }
      }
    }
  }

  // Releases and dated milestones become events about the project.
  const event = (label: string, kind: string, at: string, props: Record<string, unknown>, b: Built, summary?: string) => {
    if (matchByLabel(ctx.known, "event", label)) return false;
    const nodeId = ctx.mint();
    nodeOps.push({ op: "addNode", nodeId, type: "event", kind, label, startAt: at, summary: summary?.slice(0, 300) || undefined, props: { ...props, source: provider }, visibility: vis, receipt: receipt(ctx, b) });
    addEdgeAbout(nodeId, b);
    return true;
  };
  const aboutOps: ChangeInput[] = [];
  const addEdgeAbout = (eventId: string, b: Built) => aboutOps.push({ op: "addEdge", fromId: eventId, toId: scopeId, relation: "about", status: "unconfirmed", receipt: receipt(ctx, b) });

  let releases = 0, releasesLeft = 0;
  for (const r of [...batch.releases].sort((a, b) => b.at.localeCompare(a.at))) {
    if (releases >= CAPS.releases) { releasesLeft++; continue; }
    if (event(`${batch.scope.name} ${r.name}`.slice(0, 200), "release", r.at, { ...(r.url ? { url: r.url } : {}), ...(r.tag ? { tag: r.tag } : {}) }, releaseBuilt.get(r.id)!, r.body)) {
      releases++;
      usedKinds.add("release");
    }
  }
  let milestones = 0, milestonesLeft = 0;
  for (const m of batch.milestones) {
    if (!m.dueOn) continue;
    if (milestones >= CAPS.milestones) { milestonesLeft++; continue; }
    if (event(`${batch.scope.name}: ${m.name}`.slice(0, 200), "milestone", `${m.dueOn}T00:00:00.000Z`, { ...(m.url ? { url: m.url } : {}), allDay: true }, milestoneBuilt.get(m.id)!, m.description)) milestones++;
  }
  let decisions = 0, decisionsLeft = 0;
  for (const i of sorted.filter(isDecision)) {
    if (decisions >= CAPS.decisions) { decisionsLeft++; continue; }
    const at = i.closedAt ?? i.mergedAt ?? i.updatedAt;
    if (event(i.title.slice(0, 200), "decision", at, { ...(i.url ? { url: i.url } : {}), key: i.key }, itemBuilt.get(i.id)!, i.body)) decisions++;
  }

  // Reminders for the person's own open work with a due date that hasn't passed.
  const today = ctx.now.toISOString().slice(0, 10);
  let reminders = 0, remindersLeft = 0;
  for (const i of [...mine].sort((a, b) => (a.dueOn ?? a.milestone?.dueOn ?? "9").localeCompare(b.dueOn ?? b.milestone?.dueOn ?? "9"))) {
    if (!meId || !i.assigneeIds.includes(meId)) continue;
    const due = i.dueOn ?? i.milestone?.dueOn;
    if (!due || due < today) continue;
    if (reminders >= CAPS.reminders) { remindersLeft++; continue; }
    const about = (i.projectId && projectIds.get(i.projectId)) || scopeId;
    otherOps.push({
      op: "addReminder", title: `${i.key} ${i.title}`.slice(0, 200), dueAt: `${due}T09:00:00.000Z`, aboutNodeId: about,
      detail: [i.dueOn ? `Due in ${P}` : `The milestone ${i.milestone?.name ?? ""} is due`, i.url].filter(Boolean).join(": ").slice(0, 500),
      receipt: receipt(ctx, itemBuilt.get(i.id)!),
    });
    reminders++;
  }

  // ── The model: only what this proposal uses, so the reviewer sees why. Already there = "already true". ──
  const modelOps: ChangeInput[] = [];
  if (usedKinds.has("release")) modelOps.push({ op: "addKind", nodeType: "event", key: "release", label: "Release", pluralLabel: "Releases", description: "A version of a product or project that was published.", receipt: receipt(ctx, header) });
  for (const r of usedRelations) modelOps.push({ op: "addRelationType", ...RELATIONS[r], fromTypes: [...RELATIONS[r].fromTypes], toTypes: [...RELATIONS[r].toTypes], receipt: receipt(ctx, header) });

  changes.push(...modelOps, ...nodeOps, ...edgeOps, ...aboutOps, ...otherOps);

  // ── Say what was left out. ──
  const notProposed = batch.items.length - mine.length;
  if (!meId) warnings.push(`${P} didn't say who you are, so no issues were counted as yours: people and reminders were left out.`);
  else if (notProposed > 0) warnings.push(`${notProposed} of ${batch.items.length} items are in the text only: people and reminders come from your own open work (assigned to or opened by you).`);
  if (peopleLeft) warnings.push(`${peopleLeft} more people on your work were left out of this proposal.`);
  if (releasesLeft) warnings.push(`${releasesLeft} older releases were left out of this proposal.`);
  if (milestonesLeft) warnings.push(`${milestonesLeft} more milestones were left out of this proposal.`);
  if (decisionsLeft) warnings.push(`${decisionsLeft} more decisions were left out of this proposal.`);
  if (remindersLeft) warnings.push(`${remindersLeft} more due dates were left out of this proposal.`);
  if (projectsLeft) warnings.push(`${projectsLeft} more projects were left out of this proposal.`);
  for (const [why, n] of Object.entries(batch.leftOut)) if (n > 0) warnings.push(leftOutLine(why, n, P));

  const count = (type: string) => nodeOps.filter((c) => c.op === "addNode" && c.type === type).length;
  const occurred = sorted[0]?.updatedAt ?? batch.releases[0]?.at ?? null;
  return {
    segments: text.segments,
    changes,
    counts: {
      items: batch.items.length, yours: mine.length, projects: count("project") + count("organization"), people: count("person"),
      releases, milestones, decisions, reminders, connections: edgeOps.length,
    },
    warnings,
    title: `${P}: ${scopeName}, ${batch.items.length} item${batch.items.length === 1 ? "" : "s"} to ${dateOf(batch.window.until)}`,
    occurredAt: occurred ? new Date(occurred) : null,
    extract: false,
  };
}

function leftOutLine(why: string, n: number, P: string): string {
  switch (why) {
    case "olderItems": return `${n} more items updated in this window weren't read (a run reads the newest first). They are left out; open the ${P} search for them.`;
    case "moreItems": return `There were more items than one run reads; the oldest were left out.`;
    case "repos": return `${n} more repositories weren't read. Name the ones you want in the connection's settings.`;
    case "teams": return `${n} more teams weren't read. Name the ones you want in the connection's settings.`;
    case "archived": return `${n} archived repositories were skipped.`;
    case "people": return `${n} people's names couldn't be looked up this time.`;
    default: return `${n} left out (${why}).`;
  }
}

/** Parse and plan (what an importer's `read` does). */
export function readWork(provider: WorkProvider, bytes: Buffer, ctx: ImportContext): ImportPlan {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`This isn't a ${PROVIDER_LABEL[provider]} batch My Graph can read (not JSON).`); }
  const r = workBatch.safeParse(raw);
  if (!r.success) throw new Error(`This ${PROVIDER_LABEL[provider]} batch doesn't have the expected shape: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message ?? ""}`.trim());
  if (r.data.provider !== provider) throw new Error(`This batch is from ${PROVIDER_LABEL[r.data.provider]}, not ${PROVIDER_LABEL[provider]}.`);
  return planWork(r.data, ctx);
}
