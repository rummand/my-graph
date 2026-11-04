"use client";
import { forwardRef, useRef } from "react";
import { clsx } from "clsx";
import { MentionTextarea, type MentionTextareaHandle } from "@/components/mention";
import type { PickedMention } from "@/components/mention";
import { fromMarkup, toMarkup } from "@/lib/mentions/markup";

/** The same look as the shared `Textarea`, with @mentions over the current graph. */
const FIELD = "w-full rounded-md bg-surface px-3 py-2 text-[15px] leading-relaxed text-fg ring-1 ring-inset ring-line transition-shadow placeholder:text-muted/80 hover:ring-muted/40 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60";

export type MentionDraft = { text: string; mentions: PickedMention[] };

/** Stored text (may carry `@[Label](node:id)`) → what the field edits. */
export function draftFrom(stored: string): MentionDraft {
  const { text, mentions } = fromMarkup(stored ?? "");
  return { text, mentions };
}

/** What the field holds → stored text with mention markup. */
export function storedFrom(d: MentionDraft): string {
  return toMarkup(d.text, d.mentions);
}

type Props = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  draft: MentionDraft;
  onDraft: (d: MentionDraft) => void;
};

export const MentionField = forwardRef<MentionTextareaHandle, Props>(function MentionField({ draft, onDraft, className, ...rest }, ref) {
  // Picking from the typeahead reports the new text, then (in the same tick) the picked mention with the textarea's
  // not-yet-updated text. Keep the newest text of this tick so the second call doesn't undo the first.
  const pending = useRef<string | null>(null);
  return (
    <MentionTextarea ref={ref} {...rest} value={draft.text} mentions={draft.mentions}
      onValueChange={(text, mentions) => {
        const latest = pending.current ?? text;
        if (pending.current === null) queueMicrotask(() => { pending.current = null; });
        pending.current = pending.current === null ? text : latest;
        onDraft({ text: latest, mentions: mentions.filter((m) => latest.includes(`@${m.label}`)) });
      }} className={clsx(FIELD, className)} />
  );
});
