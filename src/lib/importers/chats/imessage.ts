/**
 * Importer `imessage`: conversations from Messages on a Mac, sent as a JSON batch by the Mac helper
 * (POST /api/import/imessage, shape `imessagePayload`). Participants are matched by handle (phone or email), then by
 * a unique name; the ones the graph doesn't know and that have a name are proposed. Pure.
 */
import { imessagePayload, type IMessagePayload } from "../schemas";
import type { Importer, ImportInput, ImportContext, ImportPlan } from "../types";
import { chatPlan, decodeText, looksLikeEmail, type ChatPerson, type ChatThread } from "./common";

const ME = "me";

export function imessageThreads(data: IMessagePayload): ChatThread[] {
  return data.chats.map((c) => {
    const people: Record<string, ChatPerson> = { [ME]: { name: null } };
    for (const p of c.participants) {
      const handle = p.handle.trim();
      const email = looksLikeEmail(handle);
      people[handle] = { name: p.name?.trim() || null, phones: email ? [] : [handle], emails: email ? [handle] : [] };
    }
    const named = c.participants.map((p) => p.name?.trim() || p.handle).join(", ");
    return {
      title: c.name?.trim() || named || "iMessage",
      me: ME,
      group: c.participants.length > 1,
      people,
      messages: c.messages.map((m) => ({
        at: new Date(m.at),
        author: m.from === ME ? ME : m.from.trim(),
        text: m.text,
        media: m.attachments.map((a) => a.filename),
      })),
    };
  });
}

function readIMessage(input: ImportInput, ctx: ImportContext): ImportPlan {
  const parsed = imessagePayload.safeParse((() => { try { return JSON.parse(decodeText(input.bytes)); } catch { return null; } })());
  if (!parsed.success) return { segments: [], changes: [], counts: {}, warnings: ["This batch isn't in the shape the Mac helper sends, so nothing was read from it."] };
  const threads = imessageThreads(parsed.data).filter((t) => t.messages.length);
  const n = threads.reduce((s, t) => s + t.messages.length, 0);
  const title = threads.length === 1
    ? (ctx.locale === "da" ? `iMessage med ${threads[0].title} (${n} beskeder)` : `iMessage with ${threads[0].title} (${n} messages)`)
    : (ctx.locale === "da" ? `iMessage: ${threads.length} samtaler (${n} beskeder)` : `iMessage: ${threads.length} conversations (${n} messages)`);
  return chatPlan({ app: "iMessage", threads, title }, ctx);
}

export const imessageImporter: Importer = {
  id: "imessage",
  label: "iMessage conversations",
  mime: "application/json",
  sensitive: true,
  json: imessagePayload,
  // Only arrives as a batch from the Mac helper, never as an upload.
  detect: () => false,
  read: readIMessage,
};
