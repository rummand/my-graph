"use client";
/**
 * What the Ask window's assistant may do in Changes: list proposals, open one, read the open one, and deliver what is
 * ticked on it. Delivering goes through the same route as the Deliver button, and only after the person approved the
 * card in the Ask window (that approval is the person pressing Deliver).
 */
import { useRouter } from "next/navigation";
import { z } from "zod";
import { defineAction, callApi, usePageActions, type PageAction } from "@/components/assistant/page-actions";
import { useT } from "@/lib/i18n/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = PageAction<any>;
const def = defineAction;

type SetLite = { id: string; title: string; status: string; origin: string; createdAt: string; summary?: { deliverable?: boolean; ready?: number } | null; changes?: unknown[] };

/** Everywhere in Changes (the list and one change set): list and open. */
export function useChangesListActions() {
  const router = useRouter();
  usePageActions([
    def({
      id: "changes.list",
      title: "List the proposals",
      description: "Change sets (proposals) in this graph: id, title, where they came from, and whether they are ready to deliver. status: draft (waiting, default), delivered, abandoned or all.",
      input: z.object({ status: z.enum(["draft", "delivered", "abandoned", "all"]).default("draft") }),
      danger: "read",
      run: async (i: { status: string }) => {
        const { changeSets } = await callApi<{ changeSets: SetLite[] }>(`/api/changes?status=${i.status}&limit=50`);
        return {
          summary: `${changeSets.length} ${i.status === "draft" ? "waiting" : i.status}`,
          data: changeSets.map((c) => ({ id: c.id, title: c.title, status: c.status, origin: c.origin, createdAt: c.createdAt, ready: !!c.summary?.deliverable })),
        };
      },
    }),
    def({
      id: "changes.open",
      title: "Open a proposal",
      description: "Open one change set's review page by its id.",
      input: z.object({ id: z.uuid() }),
      danger: "read",
      run: (i: { id: string }) => { router.push(`/changes/${i.id}`); return "Opened"; },
    }),
  ], [router]);
}

/** Mounted by the server-rendered /changes list. */
export function ChangesAssistantActions() {
  useChangesListActions();
  return null;
}

/** The open change set: read it, and deliver what is ticked (approval card first). */
export function useChangeSetAssistantActions(cs: {
  id: string; title: string; status: string; draft: boolean; canDeliver: boolean;
  changes: { id: string; sentence: string; included: boolean; verdict: string | null }[];
  deliverCount: number; total: number;
  deliver: () => Promise<{ ok: boolean; text: string }>;
}) {
  const t = useT();
  useChangesListActions();
  const actions: Untyped[] = [
    def({
      id: "changes.read_open",
      title: "Read this proposal",
      description: "The open change set: its title, status, and each change in plain words with whether it is ticked (will be delivered) and what the check found (verdict).",
      input: z.object({}),
      danger: "read",
      run: () => ({
        summary: `${cs.total} changes, ${cs.deliverCount} ticked`,
        data: { id: cs.id, title: cs.title, status: cs.status, canDeliver: cs.canDeliver && cs.draft, changes: cs.changes.slice(0, 60) },
      }),
    }),
  ];
  if (cs.draft && cs.canDeliver) {
    actions.push(def({
      id: "changes.deliver_selected",
      title: "Deliver the ticked changes",
      description: "Deliver (apply to the graph) the changes ticked in this change set, exactly as pressing Deliver does. Always shown to the person for approval first. Only when the person asked to deliver.",
      input: z.object({}),
      danger: "change",
      confirm: () => t("changes.assistantActions.deliver", { count: cs.deliverCount, title: cs.title }),
      preview: () => cs.changes.filter((c) => c.included && c.verdict !== "conflicted").slice(0, 8).map((c) => `• ${c.sentence}`).join("\n") || null,
      run: async () => {
        const r = await cs.deliver();
        if (!r.ok) throw new Error(r.text);
        return r.text;
      },
    }));
  }
  usePageActions(actions, [cs.id, cs.draft, cs.canDeliver, t]);
}
