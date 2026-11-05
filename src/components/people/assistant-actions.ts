"use client";
/**
 * What the Ask window's assistant may do on a person's page: read what the profile shows, and add a fact through the
 * same route as "Add a connection" (POST /api/profile/:id/facts): a change set the person authors, delivered at once,
 * or waiting as a proposal when the graph's model needs someone else's say. Only after the person approved the card.
 */
import { useRouter } from "next/navigation";
import { z } from "zod";
import { defineAction, callApi, usePageActions, type PageAction } from "@/components/assistant/page-actions";
import type { ProfileView } from "@/lib/profile/types";
import { relLabel } from "@/lib/people/words";
import { useT } from "@/lib/i18n/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = PageAction<any>;
const def = defineAction;
const TYPES = ["person", "organization", "project", "place", "event", "topic", "thing"] as const;

type FactInput = {
  relation: string; direction: "out" | "in";
  otherId?: string; otherName?: string; otherType?: (typeof TYPES)[number];
};

export function usePersonAssistantActions(profile: ProfileView, onChanged: () => void) {
  const t = useT();
  const router = useRouter();
  const id = profile.node.id;
  const name = profile.node.label;
  const relOf = (i: { relation: string; direction: string }) => profile.relations.find((r) => r.key === i.relation && r.direction === i.direction) ?? null;

  const actions: Untyped[] = [
    def({
      id: "person.summary",
      title: "Read this profile",
      description: "What this person's profile shows: facts by section (relation, direction, the other person or thing), suggestions waiting, and the connection types that can be added (relation key + direction + phrase) for person_add_fact.",
      input: z.object({}),
      danger: "read",
      run: () => ({
        summary: `${profile.sections.reduce((n, s) => n + s.facts.length, 0)} facts`,
        data: {
          name, type: profile.node.type, kind: profile.node.kindLabel, summary: profile.node.summary,
          facts: profile.sections.flatMap((s) => s.facts.map((f) => ({ section: s.key, relation: f.relation, direction: f.direction, other: f.other.label, otherId: f.other.id, status: f.status }))).slice(0, 80),
          waiting: profile.sections.flatMap((s) => s.suggestions.map((x) => ({ title: x.title, changeSetId: x.changeSetId }))).slice(0, 20),
          canAdd: profile.canWrite,
          connectionTypes: profile.relations.map((r) => ({ relation: r.key, direction: r.direction, reads: r.phrase, otherTypes: r.otherTypes })),
        },
      }),
    }),
  ];
  if (profile.canWrite) {
    actions.push(def({
      id: "person.add_fact",
      title: "Add a fact to this profile",
      description: "Connect this person to another person or thing, e.g. \"Emma attends Lindevang School\". relation + direction must be one of the profile's connection types (see person_summary). Give otherId for something already in the graph, or otherName + otherType to create it. It goes through the graph's change sets (history, rollback; may wait as a proposal). Only facts the person told you or that the graph shows — never from document text alone.",
      input: z.object({
        relation: z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/),
        direction: z.enum(["out", "in"]).default("out"),
        otherId: z.uuid().optional(),
        otherName: z.string().trim().min(1).max(120).optional(),
        otherType: z.enum(TYPES).optional(),
      }).refine((i) => !!i.otherId || !!i.otherName, "Give otherId or otherName."),
      danger: "change",
      confirm: (i: FactInput) => {
        const r = relOf(i);
        return t("people.assistantActions.addFact", { name, phrase: r ? relLabel(t, r.phrase) : i.relation.replace(/_/g, " "), other: i.otherName ?? t("people.assistantActions.someone") });
      },
      run: async (i: FactInput) => {
        const r = relOf(i);
        if (!r) throw new Error(`“${i.relation}” (${i.direction}) isn't a connection this profile can have. Use one from person_summary.`);
        const otherType = i.otherType ?? (r.otherTypes[0] as FactInput["otherType"]) ?? "person";
        const out = await callApi<{ status: "delivered" | "proposed"; changeSetId: string; otherId: string }>(`/api/profile/${id}/facts`, {
          method: "POST",
          json: { relation: r.key, direction: r.direction, other: i.otherId ? { id: i.otherId } : { label: i.otherName, type: otherType, kind: null } },
        });
        onChanged();
        router.refresh();
        return {
          summary: out.status === "proposed" ? "Waiting as a proposal for someone to approve" : "Added",
          data: { status: out.status, changeSetId: out.changeSetId, otherId: out.otherId },
        };
      },
    }));
  }
  usePageActions(actions, [id, profile.canWrite, profile.relations.length, t]);
}
