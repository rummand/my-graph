"use client";
/**
 * What the Ask window's assistant may do on a document (/artifacts/[id]): read its sections, draft a section's text
 * into the editor (unsaved, like typing; the person saves) and switch its style. Changes wait for the person's
 * approval in the Ask window.
 */
import { z } from "zod";
import { defineAction, usePageActions, type PageAction } from "@/components/assistant/page-actions";
import { newId, type ArtifactContent, type Block } from "@/lib/artifacts/content";
import { useT } from "@/lib/i18n/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = PageAction<any>;
const def = defineAction;
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function blockText(b: Block): string {
  switch (b.type) {
    case "heading": case "text": return b.text;
    case "quote": return b.text;
    case "facts": return b.items.map((i) => `${i.label}: ${i.value}`).join("; ");
    case "timeline": return b.items.map((i) => `${i.when} ${i.label}`).join("; ");
    case "people": return b.items.map((i) => i.name).join(", ");
    case "table": return b.rows.map((r) => r.cells.join(" | ")).join("; ");
    case "image": return b.caption;
  }
}

/** Plain text → text blocks (one per paragraph; a "## " line becomes a heading block). */
function blocksOf(text: string): Block[] {
  return text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const h = /^#{1,3}\s+(.*)$/.exec(p);
    return h && !p.includes("\n") ? { id: newId(), type: "heading" as const, text: h[1].slice(0, 200) } : { id: newId(), type: "text" as const, text: p.slice(0, 6000) };
  });
}

export function useDocumentAssistantActions(ctx: {
  artifactId: string;
  canEdit: boolean;
  content: ArtifactContent;
  change: (c: ArtifactContent) => void;
  sets: { id: string; name: string }[];
  currentSetId: string;
  changeSet: (id: string) => Promise<void>;
}) {
  const t = useT();
  const find = (title: string) => {
    const want = title.trim().toLowerCase();
    return ctx.content.sections.find((s) => s.title.trim().toLowerCase() === want)
      ?? ctx.content.sections.find((s) => s.title.toLowerCase().includes(want)) ?? null;
  };
  const setName = (id: string) => ctx.sets.find((s) => s.id === id)?.name ?? id;
  const actions: Untyped[] = [
    def({
      id: "document.list_sections",
      title: "Read the document's sections",
      description: "The document's sections in order, with their titles and the start of their text (as it is in the editor now, saved or not).",
      input: z.object({}),
      danger: "read",
      run: () => ({
        summary: `${ctx.content.sections.length} sections`,
        data: { subtitle: ctx.content.subtitle, sections: ctx.content.sections.map((s) => ({ title: s.title, text: clip(s.blocks.map(blockText).filter(Boolean).join("\n"), 600) })) },
      }),
    }),
    def({
      id: "document.list_styles",
      title: "List the styles",
      description: "The design sets (styles) this document can use, and which one it uses now.",
      input: z.object({}),
      danger: "read",
      run: () => ({ summary: `${ctx.sets.length} styles`, data: { current: setName(ctx.currentSetId), styles: ctx.sets.map((s) => ({ id: s.id, name: s.name })) } }),
    }),
  ];
  if (ctx.canEdit) {
    actions.push(
      def({
        id: "document.draft_section",
        title: "Draft a section",
        description: "Write a section's text into the document editor (unsaved until the person saves). mode: replace = the section's text becomes this; append = added at its end; new = a new section with this title at the end (also used when no section has that title). Plain text, blank lines between paragraphs. Don't invent facts: only what the graph or the person said.",
        input: z.object({ section: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(12000), mode: z.enum(["replace", "append", "new"]).default("replace") }),
        danger: "change",
        confirm: (i: { section: string; mode: string }) => {
          const s = i.mode === "new" ? null : find(i.section);
          return s
            ? t(i.mode === "append" ? "artifacts.assistantActions.appendSection" : "artifacts.assistantActions.replaceSection", { section: clip(s.title || i.section, 80) })
            : t("artifacts.assistantActions.newSection", { section: clip(i.section, 80) });
        },
        preview: (i: { text: string }) => clip(i.text, 400),
        run: (i: { section: string; text: string; mode: "replace" | "append" | "new" }) => {
          const blocks = blocksOf(i.text);
          const s = i.mode === "new" ? null : find(i.section);
          const sections = s
            ? ctx.content.sections.map((x) => (x.id !== s.id ? x : { ...x, blocks: i.mode === "append" ? [...x.blocks, ...blocks] : blocks }))
            : [...ctx.content.sections, { id: newId("s"), title: i.section.slice(0, 200), blocks }];
          ctx.change({ ...ctx.content, sections });
          return s ? `Drafted “${clip(s.title, 60)}” (not saved yet)` : `Added “${clip(i.section, 60)}” (not saved yet)`;
        },
      }),
      def({
        id: "document.change_style",
        title: "Change the style",
        description: "Switch the document to another design set (style). Use an id from the list of styles. Saves the document.",
        input: z.object({ styleId: z.string().trim().min(1).max(80) }),
        danger: "change",
        confirm: (i: { styleId: string }) => t("artifacts.assistantActions.changeStyle", { style: setName(i.styleId) }),
        run: async (i: { styleId: string }) => {
          if (!ctx.sets.some((s) => s.id === i.styleId)) throw new Error("There is no style with that id.");
          await ctx.changeSet(i.styleId);
          return `Now styled “${setName(i.styleId)}”`;
        },
      }),
    );
  }
  usePageActions(actions, [ctx.artifactId, ctx.canEdit, ctx.sets.length, t]);
}
