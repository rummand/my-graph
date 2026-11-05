/**
 * A last check on what the live model marked as things (pure, unit-tested). Live highlights only mark named things:
 * a date, time or amount is shown by the deterministic detectors (./detect), and a common word ("svømning",
 * "piano lesson") is not a thing in the graph. The prompt says so too; this catches the model when it slips.
 */
import type { Extraction } from "@/lib/meta/domain";
import { detectDetails } from "./detect";

const norm = (s: string) => s.toLowerCase().replace(/[\s.,:;!?'’"“”()-]+/gu, " ").trim();

/** Why an entity isn't a thing to mark, or null when it is. `known`: ids of graph nodes it may reuse. */
export function notAnEntity(text: string, e: { surface?: string; label: string; existingNodeId?: string | null }, known: Set<string>): "detail" | "common" | null {
  if (e.existingNodeId && known.has(e.existingNodeId)) return null;
  const surface = (e.surface?.trim() || e.label).trim();
  if (!surface) return "common";
  // A date, time, amount, email, phone or link: the words alone are one, or every place they stand in the sentence is
  // inside one the detectors found ("12. marts" in "den 12. marts"; but "May" the person in "May and I, 4 May" stays).
  const own = detectDetails(surface).filter((d) => d.kind !== "maybeNew");
  if (own.some((d) => norm(d.text) === norm(surface))) return "detail";
  const spans = detectDetails(text).filter((d) => d.kind !== "maybeNew");
  const at: number[] = [];
  const lower = text.toLowerCase(), needle = surface.toLowerCase();
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) at.push(i);
  if (at.length && at.every((i) => spans.some((d) => d.start <= i && i + needle.length <= d.end))) return "detail";
  if (/^[\d\s.,:/-]+$/u.test(surface)) return "detail";
  // No capital letter anywhere (and not a known node): a common word, not a name.
  if (!/\p{Lu}/u.test(surface) && !/\d/.test(surface)) return "common";
  return null;
}

/** The extraction without entities that aren't named things, and without the facts and details about them. */
export function keepNamedThings(text: string, x: Extraction, known: Set<string>): { kept: Extraction; dropped: { label: string; why: "detail" | "common" }[] } {
  const dropped: { label: string; why: "detail" | "common" }[] = [];
  const gone = new Set<string>();
  const entities = x.entities.filter((e) => {
    const why = notAnEntity(text, e, known);
    if (why) { dropped.push({ label: e.label, why }); gone.add(e.ref); }
    return !why;
  });
  if (!gone.size) return { kept: x, dropped };
  return {
    kept: { ...x, entities, facts: x.facts.filter((f) => !gone.has(f.from) && !gone.has(f.to)), attributes: x.attributes.filter((a) => !gone.has(a.ref)) },
    dropped,
  };
}
