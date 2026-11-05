/**
 * Who may see "You" (pure). Only the person themself, ever: there is no way to ask for someone else's — every read
 * and write is keyed by the signed-in user's own id — and these checks decide whether it appears at all.
 *   - the plan's "insights" feature (Ultimate add-on; on for everyone in development),
 *   - never for guests,
 *   - children start with it off (they may turn it on themselves; their parents never see it).
 */
export type YouGateInput = { featureOn: boolean; role: string };

export function youAllowed(g: YouGateInput): boolean {
  return g.featureOn && g.role !== "guest";
}

/** Whether "You" starts on for a person who hasn't chosen yet. */
export function youOnByDefault(role: string): boolean {
  return role === "owner" || role === "parent";
}

/** The one rule every stored row is read under: it is the viewer's own. */
export function isOwn(viewerId: string, row: { userId: string }): boolean {
  return row.userId === viewerId;
}

/**
 * Combining graphs: from the person's other graphs only rows they own count (never a partner's or a colleague's,
 * even when the person may read them there).
 */
export function ownRowsOnly<T extends { ownerId: string; graphId: string }>(rows: readonly T[], viewerId: string, currentGraphId: string): T[] {
  return rows.filter((r) => r.graphId === currentGraphId || r.ownerId === viewerId);
}

/** Signals whose material is the person's own words or health: model calls on them are sensitive (local, no fallback). */
export const SENSITIVE_SIGNALS = new Set(["mood"]);

/** Whether a question to the assistant is the person asking about themself (then their own You-insights may help). */
export function asksAboutSelf(question: string): boolean {
  const q = question.toLowerCase();
  const self = /(?<![\p{L}])(i|i'm|im|me|my|myself|jeg|mig|min|mit|mine|mig selv)(?![\p{L}])/u.test(q);
  const reflect = /(tired|exhausted|happy|happiest|mood|energy|stress|stressed|busy|lately|why am i|how am i|pattern|habit|overwhelmed|lonely|sleep|outdoors|outside|træt|glad|gladest|humør|energi|travl|stresset|for nylig|på det seneste|hvorfor er jeg|hvordan har jeg|mønster|vane|ensom|søvn|udenfor)/u.test(q);
  return self && reflect;
}
