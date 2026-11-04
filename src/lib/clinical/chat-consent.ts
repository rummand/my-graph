/**
 * Consent in the ordinary chat (pure). When an answer would draw on a client's or patient's material — their node,
 * facts about them, their session transcripts or recordings, reminders about them — the client's consent must cover
 * analysis ("analysing sessions"). Without it, that material is left out of the answer and the assistant says so.
 */
export type ConsentItemRef = {
  kind: "passage" | "node" | "fact" | "reminder";
  nodeId?: string | null;
  fromId?: string | null;
  sourceId?: string | null;
};

export type ClinicalLinks = {
  /** Client/patient node ids → their label. */
  clients: Map<string, string>;
  /** Source id → the client it belongs to (session audio and transcripts). */
  sourceClient: Map<string, string>;
  /** Session node id → its client. */
  nodeClient: Map<string, string>;
};

/** The client an item is about, or null when it isn't clinical material. */
export function clientOfItem(it: ConsentItemRef, links: ClinicalLinks): string | null {
  const ids = [it.nodeId, it.fromId].filter((x): x is string => !!x);
  for (const id of ids) {
    if (links.clients.has(id)) return id;
    const c = links.nodeClient.get(id);
    if (c) return c;
  }
  if (it.sourceId) return links.sourceClient.get(it.sourceId) ?? null;
  return null;
}

/**
 * Keep what may be used; return the clients whose material was left out (with their labels) so the answer can say so.
 * `allowed`: the clients whose consent covers analysis now.
 */
export function filterByConsent<T extends ConsentItemRef>(items: T[], links: ClinicalLinks, allowed: Set<string>): { kept: T[]; excluded: { id: string; label: string; count: number }[] } {
  const kept: T[] = [];
  const out = new Map<string, number>();
  for (const it of items) {
    const c = clientOfItem(it, links);
    if (c && !allowed.has(c)) { out.set(c, (out.get(c) ?? 0) + 1); continue; }
    kept.push(it);
  }
  return { kept, excluded: [...out].map(([id, count]) => ({ id, label: links.clients.get(id) ?? "a client", count })) };
}

/** The hint for the model and the step's words when material was left out. */
export function consentHint(excluded: { label: string }[]): string | null {
  if (!excluded.length) return null;
  const names = excluded.map((e) => e.label).join(", ");
  return `Material about ${names} was left out of the context: their consent doesn't cover analysis by the assistant. If the question is about them, say plainly that you can't use their session material without that consent, and that the consent can be updated on their record. Don't guess about them.`;
}

export function consentStepLabel(excluded: { label: string; count: number }[]): string | null {
  if (!excluded.length) return null;
  const n = excluded.reduce((a, e) => a + e.count, 0);
  return `Left out ${n} ${n === 1 ? "item" : "items"} about ${excluded.map((e) => e.label).join(", ")} (no consent for analysis)`;
}
