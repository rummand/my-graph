/**
 * Clarifying questions (pure, unit-tested). When a question is ambiguous ("which Emma?", an unclear date) the model
 * may end its answer with
 *   <clarify>{"question":"Which Emma do you mean?","choices":["Emma (your daughter)","Emma Holm (teacher)"]}</clarify>
 * The block is parsed out and shown as choice chips, a free-text answer and "Skip".
 */
import { z } from "zod";

export type Clarify = { question: string; choices: string[] };

const OPEN = "<clarify>";
const CLOSE = "</clarify>";

const clarifySchema = z.object({
  question: z.string().trim().min(3).max(200),
  choices: z.array(z.string().trim().min(1).max(80)).max(8).catch([]),
});

/** What the user sends when they press Skip. */
export const SKIP_TEXT = "Skip that. Continue with what you know.";

/** Split an answer into the visible text and its clarifying question (if any; invalid blocks are dropped). */
export function parseClarify(raw: string): { text: string; clarify: Clarify | null } {
  const start = raw.indexOf(OPEN);
  if (start < 0) return { text: raw, clarify: null };
  const end = raw.indexOf(CLOSE, start);
  const inner = raw.slice(start + OPEN.length, end < 0 ? undefined : end);
  const text = (raw.slice(0, start) + (end < 0 ? "" : raw.slice(end + CLOSE.length))).trim();
  try {
    const r = clarifySchema.safeParse(JSON.parse(inner.replace(/```(?:json)?/gi, "").trim()));
    if (!r.success) return { text, clarify: null };
    const choices = [...new Set(r.data.choices)].slice(0, 5);
    return { text, clarify: { question: r.data.question, choices } };
  } catch {
    return { text, clarify: null };
  }
}

export type PersonRef = { id: string; label: string; kind?: string | null };

const firstName = (label: string) => label.trim().split(/\s+/)[0] ?? "";

/**
 * Names in the question that match more than one person the viewer can see ("Emma" → Emma Larsen, Emma Holm), and
 * the question doesn't already say which. Used as a hint to the model and, when mux is down, as the clarify block.
 */
export function ambiguousNames(question: string, people: PersonRef[]): { name: string; options: PersonRef[] }[] {
  const q = question.toLowerCase();
  const byFirst = new Map<string, PersonRef[]>();
  for (const p of people) {
    const f = firstName(p.label).toLowerCase();
    if (f.length < 2) continue;
    const list = byFirst.get(f) ?? [];
    if (!list.some((x) => x.id === p.id || x.label.toLowerCase() === p.label.toLowerCase())) list.push(p);
    byFirst.set(f, list);
  }
  const out: { name: string; options: PersonRef[] }[] = [];
  for (const [f, list] of byFirst) {
    if (list.length < 2) continue;
    const re = new RegExp(`(^|[^\\p{L}])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|'s|’s)?($|[^\\p{L}])`, "u");
    if (!re.test(q)) continue;
    // Already specific: the question names one of them in full.
    if (list.some((p) => p.label.includes(" ") && q.includes(p.label.toLowerCase()))) continue;
    out.push({ name: firstName(list[0].label), options: list.slice(0, 5) });
  }
  return out;
}

/** The choice label for a person: "Emma Larsen (child)". */
export function personChoice(p: PersonRef): string {
  return p.kind ? `${p.label} (${p.kind})` : p.label;
}

/** A deterministic clarify block for the first ambiguous name (used when no model can ask). */
export function clarifyFromAmbiguity(amb: { name: string; options: PersonRef[] }[]): Clarify | null {
  const a = amb[0];
  if (!a) return null;
  return { question: `Which ${a.name} do you mean?`, choices: a.options.map(personChoice) };
}
