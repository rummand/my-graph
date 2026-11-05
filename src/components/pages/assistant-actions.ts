"use client";
/**
 * What the Ask window's assistant may do on a page (artifacts › pages): read the selection, write into the editor
 * (at the cursor, over the selection, as a new section) and run the rule check. Writing goes into the editor like
 * typing does (autosaved as the person's own edit), and only after the person approved the card in the Ask window.
 */
import type { Editor } from "@tiptap/react";
import { z } from "zod";
import { defineAction, usePageActions, type PageAction } from "@/components/assistant/page-actions";
import { wikiDocFromText } from "@/lib/assistant/page-doc";
import { checkTarget } from "@/components/compliance/api";
import { docText } from "@/components/compliance/tiptap";
import { useT } from "@/lib/i18n/client";

type Ctx = {
  pageId: string;
  title: () => string;
  canEdit: boolean;
  editor: () => Editor | null;
  /** Switch to the editor (the read view has none); the editor arrives via onReady. */
  startEditing: () => void;
};

const empty = z.object({});
/** Typed definition, stored in the registry's untyped list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = PageAction<any>;
const def = defineAction;
type Empty = z.infer<typeof empty>;

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Paragraphs from plain text ("## Heading", "- bullets" and blank lines between paragraphs). */
function contentOf(text: string) {
  return (wikiDocFromText(text).content as unknown[]) ?? [];
}

async function waitForEditor(ctx: Ctx): Promise<Editor> {
  let e = ctx.editor();
  if (e && !e.isDestroyed) return e;
  ctx.startEditing();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 75));
    e = ctx.editor();
    if (e && !e.isDestroyed) return e;
  }
  throw new Error("The editor didn't open.");
}

/** The heading the position sits under (the nearest heading before it). */
function headingBefore(editor: Editor, pos: number): string | null {
  let found: string | null = null;
  editor.state.doc.descendants((node, at) => {
    if (at > pos) return false;
    if (node.type.name === "heading") found = node.textContent;
    return node.type.name !== "heading";
  });
  return found;
}

/** Where a section titled `after` ends (before the next heading of the same or a higher level), or the doc's end. */
function endOfSection(editor: Editor, after: string | undefined): number {
  const doc = editor.state.doc;
  if (!after) return doc.content.size;
  const want = after.trim().toLowerCase();
  let level: number | null = null;
  let end: number | null = null;
  doc.forEach((node, offset) => {
    if (end !== null) return;
    if (node.type.name !== "heading") return;
    const l = Number(node.attrs.level) || 1;
    if (level === null) {
      if (node.textContent.trim().toLowerCase().includes(want)) level = l;
    } else if (l <= level) {
      end = offset;
    }
  });
  if (level === null) return doc.content.size;
  return end ?? doc.content.size;
}

export function usePageAssistantActions(ctx: Ctx) {
  const t = useT();
  const read: PageAction<Empty> = {
    id: "page.read_selection",
    title: "Read the selection in the page",
    description: "The text selected in this page's editor (or where the cursor is) and the heading it is under. Use before replacing or when the person says \"this\" while writing.",
    input: empty,
    danger: "read",
    run: () => {
      const e = ctx.editor();
      if (!e || e.isDestroyed) return { summary: "Not editing", data: { editing: false, title: ctx.title() } };
      const { from, to, empty } = e.state.selection;
      return {
        summary: empty ? "Cursor only" : `${to - from} characters selected`,
        data: { editing: true, title: ctx.title(), selected: empty ? "" : e.state.doc.textBetween(from, to, "\n").slice(0, 3000), under: headingBefore(e, from) },
      };
    },
  };
  const check: PageAction<Empty> = {
    id: "page.check_rules",
    title: "Check the page against the rules",
    description: "Run the rule check (the graph's rule sets / corpora) on this page's text now and return what it found: findings with the rule, severity and explanation.",
    input: empty,
    danger: "read",
    run: async () => {
      const e = ctx.editor();
      const text = e && !e.isDestroyed ? docText(e.state.doc).text : undefined;
      const r = await checkTarget({ targetType: "wiki", targetId: ctx.pageId, ...(text !== undefined ? { text } : {}), title: ctx.title() });
      if (!r.ok) throw new Error(r.error || "The rule check isn't available right now.");
      const res = r.data.result;
      const open = res.findings.filter((f) => f.status === "open");
      return {
        summary: `${open.length} ${open.length === 1 ? "finding" : "findings"} (${res.rulesChecked} rules checked)`,
        data: {
          status: res.status, ruleSets: res.corpora.map((c) => c.name), rulesChecked: res.rulesChecked,
          findings: open.slice(0, 20).map((f) => ({ rule: `${f.rule.ref} ${f.rule.title}`.trim(), ruleSet: f.rule.corpusName, severity: f.rule.severity, verdict: f.verdict, explanation: clip(f.explanation, 300), suggestion: f.suggestion ? clip(f.suggestion, 300) : null })),
        },
      };
    },
  };
  const write: Untyped[] = ctx.canEdit ? [
    def({
      id: "page.insert_text",
      title: "Write at the cursor",
      description: "Insert text into the page at the person's cursor (or at the end when there is none). Plain text: blank lines between paragraphs, \"## \" for a heading, \"- \" for bullets. Opens the editor if needed.",
      input: z.object({ text: z.string().trim().min(1).max(8000) }),
      danger: "change",
      confirm: () => t("artifacts.assistantActions.insert"),
      preview: (i: { text: string }) => clip(i.text, 400),
      run: async (i: { text: string }) => {
        const e = await waitForEditor(ctx);
        e.chain().focus().insertContent(contentOf(i.text)).run();
        return "Written into the page";
      },
    }),
    def({
      id: "page.replace_selection",
      title: "Replace the selected text",
      description: "Replace the text selected in the page's editor with new text (same plain-text format as insert). Fails when nothing is selected.",
      input: z.object({ text: z.string().trim().min(1).max(8000) }),
      danger: "change",
      confirm: () => t("artifacts.assistantActions.replace"),
      preview: (i: { text: string }) => clip(i.text, 400),
      run: async (i: { text: string }) => {
        const e = await waitForEditor(ctx);
        if (e.state.selection.empty) throw new Error("Nothing is selected in the page.");
        e.chain().focus().deleteSelection().insertContent(contentOf(i.text)).run();
        return "Replaced the selection";
      },
    }),
    def({
      id: "page.add_section",
      title: "Add a section",
      description: "Add a section (a heading and its text) to the page: at the end, or at the end of the section whose heading contains `after`.",
      input: z.object({ heading: z.string().trim().min(1).max(200), body: z.string().trim().max(8000).default(""), after: z.string().trim().max(200).optional() }),
      danger: "change",
      confirm: (i: { heading: string }) => t("artifacts.assistantActions.addSection", { heading: clip(i.heading, 80) }),
      preview: (i: { body: string }) => (i.body ? clip(i.body, 400) : null),
      run: async (i: { heading: string; body: string; after?: string }) => {
        const e = await waitForEditor(ctx);
        const at = endOfSection(e, i.after);
        e.chain().focus().insertContentAt(at, [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: i.heading }] }, ...(i.body ? contentOf(i.body) : [])]).run();
        return `Added “${clip(i.heading, 60)}”`;
      },
    }),
  ] : [];
  usePageActions([def(read), def(check), ...write], [ctx.pageId, ctx.canEdit, t]);
}
