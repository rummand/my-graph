/**
 * Slack importer (pure): reads the batches the Slack connector keeps (src/lib/connectors/slack).
 *
 *   members  the workspace becomes an organization and its members people who are "member of" it, matched first by
 *            email, then by a name that is unique in the graph. A known person is never changed; only the missing
 *            membership is proposed.
 *   channel  one channel's messages on one day become searchable text, one passage per message with its author; the
 *            model reads it for people, dates and plans (extract), as for any document. Nothing is proposed by the
 *            importer itself: what people wrote in a channel is data, never instructions.
 */
import { detectRole, roleRelation } from "@/lib/meta/roles";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { edgeKey, matchByLabel, matchPerson } from "../match";
import type { ImportContext, ImportPlan, Importer } from "../types";
import { slackPayload, type SlackMessage, type SlackPayload } from "./schema";

export const SLACK_GRAPH_KINDS = ["personal", "work", "project", "shared", "other"];
/** A workspace of thousands is read in full, but only this many new people are proposed at once. */
const MAX_PEOPLE = 500;

export const MEMBER_OF = { op: "addRelationType", key: "member_of", label: "member of", inverseLabel: "has member", fromTypes: ["person"], toTypes: ["organization"], category: "work" } as const;

function parse(bytes: Buffer): { data: SlackPayload | null; problem: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return { data: null, problem: "The Slack batch isn't valid JSON." }; }
  const r = slackPayload.safeParse(raw);
  return r.success ? { data: r.data, problem: null } : { data: null, problem: `The Slack batch doesn't have the expected shape (${r.error.issues[0]?.path.join(".") || "root"}).` };
}

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

export function messageLine(m: Pick<SlackMessage, "at" | "author" | "text"> & { files?: string[] }, reply = false): string {
  const files = m.files?.length ? ` [files: ${m.files.join(", ")}]` : "";
  return `${reply ? "  ↳ " : ""}${hhmm(m.at)} ${m.author}: ${m.text.trim()}${files}`;
}

export function memberLine(m: { name: string; displayName?: string; title?: string; email?: string }): string {
  const handle = m.displayName && m.displayName !== m.name ? ` (@${m.displayName})` : "";
  return [`${m.name}${handle}`, m.title, m.email].filter(Boolean).join(", ");
}

function readMembers(d: Extract<SlackPayload, { kind: "members" }>, ctx: ImportContext): ImportPlan {
  const segments: TextSegment[] = [];
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  const head = `Slack workspace: ${d.team.name}${d.team.domain ? ` (${d.team.domain}.slack.com)` : ""}`;
  segments.push({ text: head });
  const known = matchByLabel(ctx.known, "organization", d.team.name);
  const orgId = known?.id ?? ctx.mint();
  if (!known) {
    changes.push({
      op: "addNode", nodeId: orgId, type: "organization", label: d.team.name,
      props: { slackTeamId: d.team.id, ...(d.team.domain ? { website: `https://${d.team.domain}.slack.com` } : {}) },
      visibility: ctx.visibility, receipt: { sourceId: ctx.sourceId, quote: head, locator: { region: "workspace" } },
    });
  }
  let added = 0, matched = 0, linked = 0, left = 0;
  let relationProposed = false;
  const members = [...d.members].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of members) {
    const line = memberLine(m);
    segments.push({ text: line, at: { speaker: m.name } });
    const receipt = { sourceId: ctx.sourceId, quote: line.slice(0, 300), locator: { region: `member:${m.id}` } };
    const hit = matchPerson(ctx.known, { name: m.name, emails: m.email ? [m.email] : [] });
    let personId: string;
    if (hit) {
      matched++;
      personId = hit.id;
      if (known && ctx.existingEdges.has(edgeKey(hit.id, "member_of", orgId))) continue;
    } else {
      if (added >= MAX_PEOPLE) { left++; continue; }
      personId = ctx.mint();
      added++;
      changes.push({
        op: "addNode", nodeId: personId, type: "person", label: m.name,
        aliases: m.displayName && m.displayName !== m.name ? [m.displayName] : [],
        props: { ...(m.email ? { email: m.email } : {}), ...(m.title ? { jobTitle: m.title } : {}), slackUserId: m.id },
        visibility: ctx.visibility, receipt,
      });
    }
    if (!relationProposed) { changes.push({ ...MEMBER_OF, fromTypes: [...MEMBER_OF.fromTypes], toTypes: [...MEMBER_OF.toTypes], receipt: { sourceId: ctx.sourceId, quote: head } }); relationProposed = true; }
    changes.push({ op: "addEdge", fromId: personId, toId: orgId, relation: "member_of", confidence: 1, status: "confirmed", receipt });
    // What they are there is a role: their Slack title when it names one ("Manager"), else a colleague in the workspace.
    const job = detectRole(m.title ?? null);
    const role = roleRelation(job && !job.family ? job.role : "colleague");
    if (!ctx.existingEdges.has(edgeKey(personId, role, orgId))) {
      changes.push({ op: "addEdge", fromId: personId, toId: orgId, relation: role, confidence: job ? 0.9 : 0.7, status: job ? "confirmed" : "unconfirmed", receipt });
    }
    linked++;
  }
  if (left) warnings.push(`${left} more members weren't proposed this time; deliver or drop these first.`);
  return {
    segments, changes, warnings, extract: false,
    counts: { people: added, matched, memberships: linked },
    title: ctx.locale === "da" ? `Slack-medlemmer: ${d.team.name}` : `Slack members: ${d.team.name}`,
  };
}

function readChannel(d: Extract<SlackPayload, { kind: "channel" }>, ctx: ImportContext): ImportPlan {
  const where = d.channel.type === "im" || d.channel.type === "mpim" ? d.channel.name : `#${d.channel.name}`;
  const segments: TextSegment[] = [{ text: `Slack ${where} in ${d.team.name}, ${d.day}` }];
  const msgs = [...d.messages].sort((a, b) => a.ts.localeCompare(b.ts, "en", { numeric: true }));
  let n = 0;
  for (const m of msgs) {
    segments.push({ text: messageLine(m), at: { speaker: m.author } });
    n++;
    for (const r of m.replies) { segments.push({ text: messageLine(r, true), at: { speaker: r.author } }); n++; }
  }
  const last = msgs.flatMap((m) => [m.at, ...m.replies.map((r) => r.at)]).sort().pop();
  const da = ctx.locale === "da";
  return {
    segments, changes: [], extract: n > 0,
    counts: { messages: n },
    title: d.channel.type === "im" || d.channel.type === "mpim"
      ? (da ? `Slack-besked med ${d.channel.name}, ${d.day}` : `Slack messages with ${d.channel.name}, ${d.day}`)
      : `Slack #${d.channel.name}, ${d.day}`,
    occurredAt: last ? new Date(last) : null,
  };
}

export const slackImporter: Importer = {
  id: "slack",
  label: "Slack",
  mime: "application/json",
  // Only the Slack connector makes these sources; an uploaded file is never taken for one.
  detect: () => false,
  graphKinds: SLACK_GRAPH_KINDS,
  read(input, ctx) {
    const { data, problem } = parse(input.bytes);
    if (!data) return { segments: [], changes: [], counts: {}, warnings: [problem!] };
    return data.kind === "members" ? readMembers(data, ctx) : readChannel(data, ctx);
  },
};
