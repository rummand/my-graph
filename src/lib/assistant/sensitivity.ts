/**
 * Conversation sensitivity (pure, unit-tested). A chat is marked by the most restricted thing it touched:
 *   normal → parents (parents-only items) → private (sensitive items, or items someone shared only with you).
 * It is raised, never lowered, and shown as a badge. Before a proposal would write chat content somewhere more
 * people can see, the approval card says so.
 */
import type { Voice } from "./voice";
export type Sensitivity = "normal" | "parents" | "private";
export type Visibility = "private" | "parents" | "household";

const RANK: Record<Sensitivity, number> = { normal: 0, parents: 1, private: 2 };
const VIS_RANK: Record<Visibility, number> = { private: 0, parents: 1, household: 2 };

export function isSensitivity(s: unknown): s is Sensitivity {
  return s === "normal" || s === "parents" || s === "private";
}

export function raiseSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * The level one retrieved item brings into a chat.
 * Your own private, non-sensitive items are "normal": almost everything you add starts private, and marking every
 * chat would make the badge meaningless.
 */
export function itemLevel(it: { visibility?: Visibility | null; sensitive?: boolean; ownerId?: string | null }, viewerId: string): Sensitivity {
  if (it.visibility === "private" && (it.sensitive || (it.ownerId && it.ownerId !== viewerId))) return "private";
  if (it.visibility === "parents") return "parents";
  if (it.sensitive) return "parents";
  return "normal";
}

export function maxLevel(levels: Sensitivity[]): Sensitivity {
  return levels.reduce<Sensitivity>((a, b) => raiseSensitivity(a, b), "normal");
}

/** The small header badge, or null for an ordinary chat. */
export function sensitivityBadge(s: Sensitivity): string | null {
  if (s === "parents") return "Includes parents-only items";
  if (s === "private") return "Includes private items";
  return null;
}

/** The narrower of two visibilities. */
export function narrower(a: Visibility, b: Visibility): Visibility {
  return VIS_RANK[a] <= VIS_RANK[b] ? a : b;
}

/**
 * The warning for writing this conversation's content into a place with `target` visibility, or null when the
 * place is no wider than what the chat touched.
 */
export function wideningWarning(conv: Sensitivity, target: Visibility, voice?: Pick<Voice, "t" | "family">): string | null {
  if (conv === "normal") return null;
  if (!voice) {
    const what = conv === "parents" ? "parents-only items" : "private items";
    if (target === "household") return `This conversation includes ${what}. Saving this makes it visible to everyone in the graph, children included.`;
    if (target === "parents" && conv === "private") return `This conversation includes ${what}. Saving this makes it visible to the parents too.`;
    return null;
  }
  // Outside a family graph "parents" are the people who can edit, and nobody is a child.
  const g = voice.family ? "family" : "graph";
  const what = voice.t(`chat.server.widen.${g}.${conv === "parents" ? "parentsItems" : "privateItems"}`);
  if (target === "household") return voice.t(`chat.server.widen.${g}.everyone`, { what });
  if (target === "parents" && conv === "private") return voice.t(`chat.server.widen.${g}.parents`, { what });
  return null;
}

/** Visibility for a memory learned in this conversation: never wider than what the chat touched. */
export function memoryVisibilityFor(conv: Sensitivity): Visibility {
  return conv === "private" ? "private" : conv === "parents" ? "parents" : "household";
}
