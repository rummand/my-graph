"use client";
/**
 * Page actions that hang on the address rather than on a component: going to a page (everywhere) and the Rules
 * area (rule sets are corpora: /corpora, /corpora/[id], and /rules… once the Rules pages exist). Rendered by the Ask
 * window, so pages owned by other workstreams get actions without touching their files.
 *
 * For the Rules pages: call `useRulesActions(corpusId)` in a rule set's page (or `usePageActions` with your own) —
 * later registrations with the same id replace these.
 */
import { useRouter } from "next/navigation";
import { z } from "zod";
import { callApi, usePageActions, type PageAction } from "./page-actions";

const inAppPath = z.string().trim().min(1).max(300)
  .regex(/^\/(?!\/)[^\s]*$/, "Use a path inside the app, like /library or /people/<id>.");

/** Everywhere: open a page in the app (navigation only). */
function useGlobalActions() {
  const router = useRouter();
  usePageActions([
    {
      id: "app.open_page",
      title: "Open a page",
      description: "Navigate the person to a page in My Graph: /library, /library/<file id>, /people/<node id>, /node/<id>, /artifacts, /artifacts/pages/<slug>, /changes/<id>, /timeline, /corpora/<id>, /connections. Only paths inside the app.",
      input: z.object({ path: inAppPath }),
      danger: "read",
      run: ({ path }: { path: string }) => { router.push(path); return `Opened ${path}`; },
    } satisfies PageAction<{ path: string }>,
  ], [router]);
}

type RuleLite = { id: string; ref: string; section: string; title: string; status: string };
type CorpusLite = { id: string; name: string; rules: RuleLite[]; canManage: boolean };

function hostName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, 60); }
}

/** The Rules area: add a rule set from a link (anywhere under /corpora or /rules). */
function useRulesListActions(enabled: boolean) {
  const router = useRouter();
  usePageActions(enabled ? [
    {
      id: "rules.add_from_link",
      title: "Add a rule set from a link",
      description: "Create a new rule set (corpus) from a web page with rules (a law, a policy, guidelines): reads the page into the library, adds it to the new rule set and starts reading the rules out of it. The rules it finds are proposals the person approves later.",
      input: z.object({ url: z.string().trim().url().max(1000), name: z.string().trim().min(1).max(160).optional() }),
      danger: "change",
      confirm: (i: { url: string; name?: string }) => `Add a rule set “${i.name || hostName(i.url)}” from ${hostName(i.url)} and read its rules?`,
      preview: (i: { url: string }) => i.url,
      run: async (i: { url: string; name?: string }) => {
        const { corpus } = await callApi<{ corpus: { id: string; name: string } }>("/api/corpora", { method: "POST", json: { name: i.name || hostName(i.url) } });
        await callApi(`/api/corpora/${corpus.id}/sources`, { method: "POST", json: { url: i.url } });
        await callApi(`/api/corpora/${corpus.id}/read`, { method: "POST", json: { mode: "read" } }).catch(() => null);
        router.push(`/corpora/${corpus.id}`);
        return { summary: `Added “${corpus.name}”; reading its rules now`, data: { corpusId: corpus.id } };
      },
    },
  ] : [], [enabled, router]);
}

/**
 * One rule set's page: list the proposed rules by chapter, approve some, check the sources for changes. Exported for
 * the Rules pages to call with their own id.
 */
export function useRulesActions(corpusId: string | null) {
  const router = useRouter();
  const base = corpusId ? `/api/corpora/${corpusId}` : null;
  usePageActions(base ? [
    {
      id: "rules.list_proposed",
      title: "List the rules waiting for approval",
      description: "The rules in this rule set that wait for a person's approval, grouped by chapter/section, with their ids. Use before approving a chapter.",
      input: z.object({ section: z.string().trim().max(160).optional() }),
      danger: "read",
      run: async ({ section }: { section?: string }) => {
        const { corpus } = await callApi<{ corpus: CorpusLite }>(base);
        const want = section?.toLowerCase();
        const rules = corpus.rules.filter((r) => r.status === "proposed" && (!want || r.section.toLowerCase().includes(want) || r.ref.toLowerCase().startsWith(want)));
        const bySection: Record<string, { id: string; ref: string; title: string }[]> = {};
        for (const r of rules.slice(0, 200)) (bySection[r.section || "(no chapter)"] ??= []).push({ id: r.id, ref: r.ref, title: r.title });
        return { summary: `${rules.length} waiting`, data: { ruleSet: corpus.name, canApprove: corpus.canManage, sections: bySection } };
      },
    },
    {
      id: "rules.approve",
      title: "Approve rules",
      description: "Approve proposed rules in this rule set so they are checked from now on. Give the rule ids (from the list action) and the chapter they are in.",
      input: z.object({ ruleIds: z.array(z.uuid()).min(1).max(200), chapter: z.string().trim().max(160).optional() }),
      danger: "change",
      confirm: (i: { ruleIds: string[]; chapter?: string }) => `Approve ${i.ruleIds.length} ${i.ruleIds.length === 1 ? "rule" : "rules"}${i.chapter ? ` in ${i.chapter}` : ""}?`,
      run: async (i: { ruleIds: string[] }) => {
        const r = await callApi<{ decided: number }>(`${base}/rules`, { method: "POST", json: { ids: i.ruleIds, action: "approve" } });
        router.refresh();
        return `Approved ${r.decided}`;
      },
    },
    {
      id: "rules.check_for_changes",
      title: "Check the sources for changes",
      description: "Read this rule set's documents again and propose what changed compared with the rules in force (added, changed, removed), as a new version. Nothing changes until a person approves the proposals.",
      input: z.object({ version: z.string().trim().max(80).optional() }),
      danger: "change",
      confirm: (i: { version?: string }) => (i.version ? `Check the sources for changes (new version ${i.version})?` : "Check the sources for changes?"),
      run: async (i: { version?: string }) => {
        await callApi(`${base}/read`, { method: "POST", json: { mode: "version", version: i.version ?? null } });
        router.refresh();
        return "Started reading the sources again";
      },
    },
  ] : [], [base, router]);
}

const RULE_SET = /^\/(?:corpora|rules)\/([0-9a-f-]{36})(?:\/|$)/i;

export function RouteActions({ pathname }: { pathname: string }) {
  useGlobalActions();
  useRulesListActions(/^\/(?:corpora|rules)(?:\/|$)/.test(pathname));
  useRulesActions(RULE_SET.exec(pathname)?.[1] ?? null);
  return null;
}
