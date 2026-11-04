/**
 * Who may see "How they've been doing" (pure): the feature is on for the viewer, the viewer is a member who may read
 * the person, and the person is a person. Guests never get it. Evidence is filtered on the server by the viewer's own
 * read rules; this gate decides whether the section appears at all.
 */
export type InsightGateInput = { featureOn: boolean; role: string; nodeType: string; canRead: boolean };

export function insightsAllowed(g: InsightGateInput): boolean {
  return g.featureOn && g.canRead && g.nodeType === "person" && g.role !== "guest";
}

/** A conversation is evidence only when it is the viewer's own (never another member's private chat). */
export function ownConversation(viewerId: string, conversationUserId: string): boolean {
  return viewerId === conversationUserId;
}
