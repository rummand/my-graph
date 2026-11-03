/** Plain-English wording for audit log entries (pure). */
const LABELS: Record<string, string> = {
  "setup.complete": "Set up the household",
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in attempt",
  "auth.login_refused": "Sign-in refused",
  "auth.rate_limited": "Sign-in blocked after too many attempts",
  "auth.logout": "Signed out",
  "session.create": "Started a session",
  "session.revoke": "Signed out a device",
  "session.revoke_others": "Signed out all other devices",
  "session.revoke_member": "Signed out a family member's device",
  "session.approve": "Approved a new device",
  "session.deny": "Turned away a new device",
  "session.ended_access_expired": "Session ended because guest access expired",
  "device.approve": "Remembered an approved device",
  "device.revoke": "Forgot a device",
  "password.change": "Changed their password",
  "password.set": "Set a password",
  "password.change_failed": "Entered the wrong current password",
  "passkey.register": "Added a passkey",
  "passkey.rename": "Renamed a passkey",
  "passkey.remove": "Removed a passkey",
  "profile.update": "Updated their profile",
  "member.create": "Added a family member",
  "member.update": "Changed a family member's details",
  "member.password_reset": "Set a new password for a family member",
  "member.sign_in_disabled": "Turned off a family member's sign-in",
  "member.remove": "Removed a family member",
  "graph.create": "Made a new graph",
  "graph.update": "Changed a graph's details",
  "graph.archive": "Archived a graph",
  "graph.member_add": "Added someone to a graph",
  "graph.member_role": "Changed what someone may do in a graph",
  "graph.member_remove": "Removed someone from a graph",
  "graph.leave": "Left a graph",
  "graph.invite_create": "Invited someone to a graph",
  "graph.invite_revoke": "Cancelled a graph invite",
  "graph.invite_accept": "Accepted an invite to a graph",
};

export function auditActionLabel(action: string): string {
  if (LABELS[action]) return LABELS[action];
  const [area, verb] = action.split(".");
  const words = `${verb ?? area}`.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${verb ? ` (${area.replace(/_/g, " ")})` : ""}`;
}

/** Entries worth highlighting in the log. */
export function auditIsWarning(action: string): boolean {
  return /failed|refused|rate_limited|deny|remove|disabled|expired/.test(action);
}

const ROLE_LABELS = { owner: "Owner", parent: "Parent", child: "Child", guest: "Guest" } as const;
export function roleLabel(role: string): string {
  return ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role;
}

/** A short, human detail line from an entry's meta (never shows hashes). */
export function auditDetail(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  const s = (k: string) => (typeof meta[k] === "string" && meta[k] ? String(meta[k]) : null);
  if (s("name")) parts.push(String(meta.name));
  if (s("role")) parts.push(roleLabel(String(meta.role)).toLowerCase());
  if (s("fromRole") && s("toRole")) parts.push(`${roleLabel(String(meta.fromRole)).toLowerCase()} → ${roleLabel(String(meta.toRole)).toLowerCase()}`);
  if (s("method")) parts.push(meta.method === "passkey" ? "with a passkey" : meta.method === "password" ? "with a password" : String(meta.method));
  if (Array.isArray(meta.changed) && meta.changed.length) parts.push(`changed ${meta.changed.join(", ")}`);
  if (meta.approved === false) parts.push("waiting for approval");
  if (typeof meta.count === "number") parts.push(`${meta.count} device${meta.count === 1 ? "" : "s"}`);
  if (s("ip") && meta.ip !== "unknown") parts.push(`from ${meta.ip}`);
  return parts.join(" · ");
}

/** Account-level actions (sign-in, devices, members) belong to the household, not to whichever graph was open. */
const ACCOUNT_AREAS = new Set(["setup", "auth", "session", "device", "password", "passkey", "profile", "member"]);

/** True when an action is about content in a graph and should carry that graph's id. */
export function auditIsGraphScoped(action: string): boolean {
  return !ACCOUNT_AREAS.has(action.split(".")[0]);
}

/** The graph an audit entry belongs to: `meta.graphId`, or the graph itself for graph.* entries. Null = household-wide. */
export function auditGraphId(e: { targetType: string | null; targetId: string | null; meta: Record<string, unknown> | null }): string | null {
  const g = e.meta?.graphId;
  if (typeof g === "string" && g) return g;
  return e.targetType === "graph" && e.targetId ? e.targetId : null;
}

/**
 * Whether a household activity-log entry may be shown to `viewerId`: household-wide entries always, an entry from
 * one graph only to members of that graph (or to the person who did it).
 */
export function auditVisibleTo(e: { userId: string | null; targetType: string | null; targetId: string | null; meta: Record<string, unknown> | null },
  viewerId: string, myGraphIds: ReadonlySet<string>): boolean {
  if (e.userId === viewerId) return true;
  const g = auditGraphId(e);
  return g === null || myGraphIds.has(g);
}
