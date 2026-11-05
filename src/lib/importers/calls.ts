/**
 * Importer `calls`: the Mac's call history (phone calls through the iPhone, FaceTime audio and video), sent by the My
 * Graph for Mac app as callsPayload. Pure. Always sensitive and private to the person who sent it.
 *
 *   - The import's text is a log per day ("09:12 Outgoing phone call with Ida Hansen, 4 min"), so search and the
 *     assistant can answer "when did I last talk to Ida?". Days are the caller's own (the date in the timestamp).
 *   - Handles are matched to people in the graph by phone number or email (else a name the Mac's Contacts gave, when
 *     unique in the graph).
 *   - A person is proposed only for a frequent contact the Mac knows by name: at least 3 calls on at least 2
 *     different days, not already in the graph. A one-off or unnamed number is never proposed.
 */
import { roleMention } from "@/lib/meta/roles";
import type { ChangeInput } from "@/lib/changes";
import { matchPerson, normEmail, normPhone } from "./match";
import { callsPayload, type CallsPayload } from "./schemas";
import type { ImportContext, ImportPlan, Importer } from "./types";
import type { TextSegment } from "@/lib/ingest/chunk";

export const CALL_RULES = { minCalls: 3, minDays: 2, maxPeople: 20 } as const;

type Call = CallsPayload["calls"][number];

const clean = (s: string | undefined | null) => (s ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

const T = {
  en: {
    title: (n: number, days: number) => `Calls from your Mac: ${n} ${n === 1 ? "call" : "calls"} on ${days} ${days === 1 ? "day" : "days"}`,
    day: (d: string) => `Calls on ${d}`,
    dir: { in: "Incoming", out: "Outgoing", missed: "Missed" },
    service: { phone: "phone call", facetime_audio: "FaceTime audio call", facetime_video: "FaceTime video call" },
    with: (d: Call["direction"]) => (d === "out" ? "to" : d === "missed" ? "from" : "from"),
    mins: (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`),
    why: (n: number, days: number) => `You called each other ${n} times on ${days} different days.`,
  },
  da: {
    title: (n: number, days: number) => `Opkald fra din Mac: ${n} ${n === 1 ? "opkald" : "opkald"} på ${days} ${days === 1 ? "dag" : "dage"}`,
    day: (d: string) => `Opkald ${d}`,
    dir: { in: "Indgående", out: "Udgående", missed: "Ubesvaret" },
    service: { phone: "opkald", facetime_audio: "FaceTime-lydopkald", facetime_video: "FaceTime-videoopkald" },
    with: (d: Call["direction"]) => (d === "out" ? "til" : "fra"),
    mins: (s: number) => (s < 60 ? `${s} sek.` : `${Math.round(s / 60)} min.`),
    why: (n: number, days: number) => `I har ringet sammen ${n} gange på ${days} forskellige dage.`,
  },
};

const isEmail = (h: string) => h.includes("@");

/** One key per handle: an email, or the phone number's last 8 digits (so +45 / 0045 / none are one). */
export function handleKey(handle: string): string | null {
  const h = clean(handle);
  if (!h) return null;
  if (isEmail(h)) return `e:${normEmail(h)}`;
  const p = normPhone(h);
  return p.length >= 6 ? `p:${p}` : null;
}

export function callLine(c: Call, who: string, locale: "en" | "da"): string {
  const L = T[locale];
  const time = c.at.slice(11, 16);
  const dur = c.direction === "missed" ? "" : `, ${L.mins(c.durationSec)}`;
  return `${time} ${L.dir[c.direction]} ${L.service[c.service]} ${L.with(c.direction)} ${who}${dur}`;
}

export function readCalls(data: CallsPayload, ctx: ImportContext): ImportPlan {
  const L = T[ctx.locale];
  const seen = new Set<string>();
  const calls = data.calls.filter((c) => !Number.isNaN(Date.parse(c.at)) && !seen.has(c.id) && seen.add(c.id)).sort((a, b) => a.at.localeCompare(b.at));

  type Contact = { key: string; handle: string; name: string | null; calls: Call[]; days: Set<string>; known: string | null };
  const contacts = new Map<string, Contact>();
  for (const c of calls) {
    const key = handleKey(c.handle) ?? `raw:${clean(c.handle)}`;
    const ct = contacts.get(key) ?? contacts.set(key, { key, handle: clean(c.handle), name: null, calls: [], days: new Set(), known: null }).get(key)!;
    ct.calls.push(c);
    ct.days.add(c.at.slice(0, 10));
    if (!ct.name && clean(c.name)) ct.name = clean(c.name).slice(0, 200);
  }
  for (const ct of contacts.values()) {
    const email = isEmail(ct.handle) ? [normEmail(ct.handle)] : [];
    const phone = !isEmail(ct.handle) && normPhone(ct.handle).length >= 8 ? [ct.handle] : [];
    ct.known = matchPerson(ctx.known, { name: ct.name, emails: email, phones: phone })?.id ?? null;
  }
  const whoOf = (c: Call) => {
    const ct = contacts.get(handleKey(c.handle) ?? `raw:${clean(c.handle)}`)!;
    const knownLabel = ct.known ? ctx.known.find((k) => k.id === ct.known)?.label : null;
    const name = knownLabel ?? ct.name;
    return name ? `${name} (${ct.handle})` : ct.handle;
  };

  // The log: one segment per day.
  const byDay = new Map<string, Call[]>();
  for (const c of calls) (byDay.get(c.at.slice(0, 10)) ?? byDay.set(c.at.slice(0, 10), []).get(c.at.slice(0, 10))!).push(c);
  const segments: TextSegment[] = [...byDay.entries()].map(([d, list]) => ({
    text: [L.day(d), ...list.map((c) => callLine(c, whoOf(c), ctx.locale))].join("\n"),
    at: { region: d },
  }));

  // People: frequent, named, not in the graph.
  const changes: ChangeInput[] = [];
  const frequent = [...contacts.values()]
    // A contact saved as a role ("Lægen", "the dentist") names nobody: no person for it.
    .filter((ct) => !ct.known && ct.name && !roleMention(ct.name) && !ct.key.startsWith("raw:") && ct.calls.length >= CALL_RULES.minCalls && ct.days.size >= CALL_RULES.minDays)
    .sort((a, b) => b.calls.length - a.calls.length);
  for (const ct of frequent.slice(0, CALL_RULES.maxPeople)) {
    const last = ct.calls[ct.calls.length - 1];
    const props: Record<string, unknown> = isEmail(ct.handle) ? { emails: [normEmail(ct.handle)] } : { phones: [ct.handle] };
    changes.push({
      op: "addNode", nodeId: ctx.mint(), type: "person", label: ct.name!, props, visibility: "private", sensitive: true,
      note: L.why(ct.calls.length, ct.days.size),
      receipt: {
        sourceId: ctx.sourceId, quote: callLine(last, whoOf(last), ctx.locale).slice(0, 300),
        locator: { region: last.at.slice(0, 10), range: `call:${last.id}` }, confidence: 0.8,
      },
    });
  }

  return {
    segments, changes, title: L.title(calls.length, byDay.size), extract: false,
    occurredAt: calls.length ? new Date(calls[calls.length - 1].at) : null,
    counts: { calls: calls.length, days: byDay.size, people: changes.length, known: [...contacts.values()].filter((c) => c.known).length },
    warnings: frequent.length > CALL_RULES.maxPeople ? [`Only the ${CALL_RULES.maxPeople} most frequent contacts are proposed as people.`] : [],
  };
}

export const callsImporter: Importer = {
  id: "calls",
  label: "Call history (Mac)",
  mime: "application/vnd.mygraph.calls+json",
  detect: () => false,
  json: callsPayload,
  sensitive: true,
  privateOnly: true,
  read(input, ctx) {
    let data: CallsPayload;
    try {
      data = callsPayload.parse(JSON.parse(input.bytes.toString("utf8")));
    } catch {
      return { segments: [], changes: [], counts: {}, warnings: ["This call history isn't in the expected shape."], extract: false };
    }
    return readCalls(data, ctx);
  },
};
