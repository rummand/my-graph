/**
 * What a person can choose from in a provider connection's settings (server-only): Gmail labels, Google calendars,
 * Outlook mail folders, OneDrive and Dropbox folders (one level at a time). Read with the connection's own token,
 * only for the person who owns it, in the graph it belongs to. Names come from the provider and are shown as text.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { decryptSecrets } from "../crypto";
import { ConnectorError } from "../errors";
import { ConnectionError } from "../store";
import { bodyOf, type Api } from "./client";
import { apiBase } from "./providers";
import { apiFor } from "./session";
import { listSlackChannels } from "../slack";

export type Option = { id: string; name: string; path?: string; hasChildren?: boolean; hint?: string };
export type OptionKind = "labels" | "calendars" | "mailFolders" | "driveFolders" | "dropboxFolders" | "slackChannels";

const FOR: Record<OptionKind, string> = { labels: "gmail", calendars: "google_calendar", mailFolders: "microsoft", driveFolders: "microsoft", dropboxFolders: "dropbox", slackChannels: "slack" };

/** Gmail's system labels, in plain words (the rest keep the name the person gave them). */
const SYSTEM_LABELS: Record<string, string> = { INBOX: "Inbox", SENT: "Sent", IMPORTANT: "Important", STARRED: "Starred", CATEGORY_PERSONAL: "Primary", CATEGORY_UPDATES: "Updates", CATEGORY_FORUMS: "Forums", CATEGORY_PROMOTIONS: "Promotions", CATEGORY_SOCIAL: "Social" };

export async function listOptions(v: Viewer, id: string, what: OptionKind, parent: string | null): Promise<Option[]> {
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
  if (!row) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
  if (FOR[what] !== row.connector) throw new ConnectionError(400, "This connection doesn't have that kind of choice.");
  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(row.secrets, row.id); } catch { throw new ConnectionError(400, "Sign in again first.", "signInAgain"); }
  const api = apiFor(row, secrets);
  try {
    // Slack: the channels (and, with the opt-in, direct messages) this sign-in can read.
    if (what === "slackChannels") return await listSlackChannels(api, row.config?.directMessages === true);
    return await load(api, what, parent);
  } catch (e) {
    if (e instanceof ConnectorError) throw new ConnectionError(e.kind === "needs_you" ? 400 : 503, e.message, e.code);
    throw e;
  }
}

async function load(api: Api, what: OptionKind, parent: string | null): Promise<Option[]> {
  const base = apiBase();
  const ok = (r: { status: number }, what: string) => { if (r.status !== 200) throw new ConnectionError(502, `The provider didn't list ${what} (HTTP ${r.status}).`); };
  if (what === "labels") {
    const r = await api({ url: `${base.gmail}/labels` });
    ok(r, "the labels");
    const b = bodyOf<{ labels?: { id: string; name: string; type?: string }[] }>(r, "Google");
    return (b.labels ?? [])
      .filter((l) => l.type !== "system" || SYSTEM_LABELS[l.id])
      .map((l) => ({ id: l.id, name: SYSTEM_LABELS[l.id] ?? l.name, hint: l.type === "system" ? "system" : undefined }))
      .sort((a, b) => (a.hint === b.hint ? a.name.localeCompare(b.name) : a.hint ? -1 : 1));
  }
  if (what === "calendars") {
    const r = await api({ url: `${base.calendar}/users/me/calendarList?minAccessRole=reader` });
    ok(r, "the calendars");
    const b = bodyOf<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[] }>(r, "Google");
    return (b.items ?? []).map((c) => ({ id: c.primary ? "primary" : c.id, name: c.summaryOverride ?? c.summary ?? c.id, hint: c.primary ? "primary" : undefined }));
  }
  if (what === "mailFolders") {
    const url = parent ? `${base.graph}/me/mailFolders/${encodeURIComponent(parent)}/childFolders?$top=100` : `${base.graph}/me/mailFolders?$top=100`;
    const r = await api({ url });
    ok(r, "the mail folders");
    const b = bodyOf<{ value?: { id: string; displayName: string; childFolderCount?: number }[] }>(r, "Microsoft");
    return (b.value ?? []).map((f) => ({ id: f.id, name: f.displayName, hasChildren: (f.childFolderCount ?? 0) > 0 }));
  }
  if (what === "driveFolders") {
    const url = parent ? `${base.graph}/me/drive/items/${encodeURIComponent(parent)}/children?$top=200` : `${base.graph}/me/drive/root/children?$top=200`;
    const r = await api({ url });
    ok(r, "the OneDrive folders");
    const b = bodyOf<{ value?: { id: string; name: string; folder?: { childCount?: number }; parentReference?: { path?: string } }[] }>(r, "Microsoft");
    return (b.value ?? []).filter((i) => !!i.folder).map((i) => ({
      id: i.id, name: i.name, hasChildren: (i.folder?.childCount ?? 0) > 0,
      path: `${(i.parentReference?.path ?? "").replace(/^\/drive\/root:?/, "")}/${i.name}`,
    }));
  }
  const r = await api({ url: `${base.dropbox}/files/list_folder`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: parent ?? "", recursive: false, limit: 500 }) });
  ok(r, "the Dropbox folders");
  const b = bodyOf<{ entries?: { ".tag": string; id: string; name: string; path_lower?: string; path_display?: string }[] }>(r, "Dropbox");
  return (b.entries ?? []).filter((e) => e[".tag"] === "folder").map((e) => ({ id: e.id, name: e.name, path: e.path_lower ?? e.path_display ?? `/${e.name}`, hasChildren: true }));
}
