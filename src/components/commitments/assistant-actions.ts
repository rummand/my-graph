"use client";
/**
 * What the Ask window may do on /commitments (page actions, see src/components/assistant/page-actions.ts). Listing and
 * filtering run at once; marking done, snoozing and reassigning show an approval card first and then go through
 * /api/commitments as the person (which re-checks access).
 */
import { z } from "zod";
import { usePageActions, usePageView, type PageAction } from "@/components/assistant/page-actions";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate } from "@/lib/i18n/dates";
import { daysUntil, urgencyOf, type CommitmentView, type LedgerTab, type Party } from "@/lib/commitments/pure";
import type { Action } from "./client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Act = PageAction<any>;

export function useCommitmentActions(o: {
  items: CommitmentView[]; shown: CommitmentView[]; everyone: Party[]; canWrite: boolean; now: Date; tz: string;
  tab: LedgerTab; setTab: (t: LedgerTab) => void; person: string | null; setPerson: (p: string | null) => void;
  onAct: (c: CommitmentView, a: Action) => Promise<boolean>;
}) {
  const t = useT();
  const locale = useLocale();
  const byId = new Map(o.items.map((c) => [c.id, c]));
  const need = (id: string) => {
    const c = byId.get(id);
    if (!c) throw new Error(t("commitments.assistant.unknown"));
    return c;
  };
  const label = (id: string) => byId.get(id)?.label ?? id;
  const when = (iso: string) => formatDate(iso, "weekday", { locale, timeZone: o.tz, now: o.now });
  const personName = o.person ? o.items.flatMap((c) => c.responsible).find((p) => p.id === o.person)?.label : null;
  usePageView({ section: t("commitments.title"), detail: [t(`commitments.tabs.${o.tab}`), personName ? t("commitments.people.only", { name: personName }) : null].filter(Boolean).join(", ") });

  const actions: Act[] = [
    {
      id: "commitments.list",
      title: t("commitments.assistant.list"),
      description: "The commitments (things the household must do, pay, reply to, renew, give notice on, or is owed) the page shows now: id, sentence, kind, which way (owe / owed / promise), status, due date and days left, urgency (overdue / at_risk / this_week / later / undated), who is responsible, the other party, amount, what happens if missed. Use `all: true` for every open one, not just the current filter.",
      input: z.object({ all: z.boolean().optional(), dueWithinDays: z.number().int().min(0).max(366).optional() }),
      danger: "read",
      run: (i: { all?: boolean; dueWithinDays?: number }) => {
        const src = i.all ? o.items.filter((c) => c.props.status === "open") : o.shown;
        const list = src.filter((c) => i.dueWithinDays === undefined || (c.props.dueAt && daysUntil(c.props.dueAt, o.now, o.tz) <= i.dueWithinDays));
        return {
          summary: `${list.length}`,
          data: list.slice(0, 60).map((c) => ({
            id: c.id, sentence: c.label, kind: c.props.kind, direction: c.props.direction, status: c.props.status,
            due: c.props.dueAt, daysLeft: c.props.dueAt ? daysUntil(c.props.dueAt, o.now, o.tz) : null, urgency: urgencyOf(c.props, o.now, o.tz),
            responsible: c.responsible.map((p) => ({ id: p.id, name: p.label })), with: c.counterparty.map((p) => p.label),
            amount: c.props.amount ?? null, ifMissed: c.props.consequence ?? null, snoozedUntil: c.props.snoozedUntil ?? null,
          })),
        };
      },
    },
    {
      id: "commitments.filter",
      title: t("commitments.assistant.filter"),
      description: "Change what the list shows, like the person would: a tab (all = every open one, owe = we owe, owed = owed to us, promise, done) and/or one person's (a person id from commitments.list, \"\" for everyone).",
      input: z.object({ tab: z.enum(["all", "owe", "owed", "promise", "done"]).optional(), personId: z.string().max(60).optional() }),
      danger: "read",
      run: (i: { tab?: LedgerTab; personId?: string }) => {
        if (i.tab) o.setTab(i.tab);
        if (i.personId !== undefined) o.setPerson(i.personId || null);
        return "ok";
      },
    },
  ];
  if (o.canWrite) {
    actions.push(
      {
        id: "commitments.mark_done",
        title: t("commitments.assistant.done"),
        description: "Mark one commitment done (it was paid, replied to, handed in …), with an optional short note. Only when the person says it is done.",
        input: z.object({ id: z.string(), note: z.string().max(500).optional() }),
        danger: "change",
        confirm: (i: { id: string }) => t("commitments.assistant.confirmDone", { label: label(i.id) }),
        preview: (i: { note?: string }) => i.note ?? null,
        run: async (i: { id: string; note?: string }) => {
          const ok = await o.onAct(need(i.id), { action: "done", ...(i.note ? { note: i.note } : {}) });
          if (!ok) throw new Error(t("commitments.result.failed"));
          return t("commitments.result.done");
        },
      },
      {
        id: "commitments.snooze",
        title: t("commitments.assistant.snooze"),
        description: "Move a commitment's reminder to a later moment (ISO 8601). The due date does not move; the moment must be before it is due.",
        input: z.object({ id: z.string(), until: z.string().max(40) }),
        danger: "change",
        confirm: (i: { id: string; until: string }) => t("commitments.assistant.confirmSnooze", { label: label(i.id), date: when(i.until) }),
        run: async (i: { id: string; until: string }) => {
          if (Number.isNaN(Date.parse(i.until))) throw new Error("until must be a date and time in ISO 8601.");
          const ok = await o.onAct(need(i.id), { action: "snooze", until: new Date(i.until).toISOString() });
          if (!ok) throw new Error(t("commitments.result.failed"));
          return t("commitments.result.snooze");
        },
      },
      {
        id: "commitments.reassign",
        title: t("commitments.assistant.reassign"),
        description: "Make another person responsible for a commitment (instead of whoever is now). personId: a person id from the list of people (commitments.list responsible ids, or the people the page offers).",
        input: z.object({ id: z.string(), personId: z.string() }),
        danger: "change",
        confirm: (i: { id: string; personId: string }) => t("commitments.assistant.confirmReassign", { label: label(i.id), name: o.everyone.find((p) => p.id === i.personId)?.label ?? i.personId }),
        run: async (i: { id: string; personId: string }) => {
          if (!o.everyone.some((p) => p.id === i.personId)) throw new Error(t("commitments.assistant.unknownPerson"));
          const ok = await o.onAct(need(i.id), { action: "reassign", personId: i.personId });
          if (!ok) throw new Error(t("commitments.result.failed"));
          return t("commitments.result.reassign");
        },
      },
      {
        id: "commitments.people",
        title: t("commitments.people.label"),
        description: "The people in this graph a commitment can be given to (id and name), for commitments.reassign.",
        input: z.object({}),
        danger: "read",
        run: () => ({ data: o.everyone.map((p) => ({ id: p.id, name: p.label })) }),
      },
    );
  }
  usePageActions(actions, [o.items, o.shown, o.everyone, o.canWrite, o.tab, o.person, locale]);
}
