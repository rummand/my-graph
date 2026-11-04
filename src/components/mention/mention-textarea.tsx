"use client";
import { forwardRef, useCallback, useId, useImperativeHandle, useRef, type TextareaHTMLAttributes } from "react";
import { toMarkup } from "@/lib/mentions/markup";
import { MentionMenu } from "./mention-menu";
import { useMentionTypeahead, type PickedMention } from "./use-mention-typeahead";

export type MentionTextareaHandle = { textarea: HTMLTextAreaElement | null; markup: () => string };

/**
 * A plain textarea with @mentions: typing @ opens a typeahead over the current graph; picked mentions show as
 * "@Label" and are kept beside the text. `markup()` (or toMarkup(value, mentions)) gives the stored form
 * `@[Label](node:id)`. Use anywhere a plain textarea takes text that may name things in the graph.
 */
export const MentionTextarea = forwardRef<MentionTextareaHandle, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  mentions: PickedMention[];
  onValueChange: (value: string, mentions: PickedMention[]) => void;
  onCreate?: (label: string) => void;
}>(function MentionTextarea({ value, mentions, onValueChange, onCreate, onKeyDown, className, ...rest }, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const prune = useCallback((v: string, list: PickedMention[]) => list.filter((m) => v.includes(`@${m.label}`)), []);
  const ta = useMentionTypeahead({
    value, inputRef,
    onChange: (v) => onValueChange(v, prune(v, mentions)),
    onPick: (m) => onValueChange(inputRef.current?.value ?? value, [...mentions.filter((x) => x.nodeId !== m.nodeId), m]),
    onCreate,
  });
  useImperativeHandle(ref, () => ({ textarea: inputRef.current, markup: () => toMarkup(value, mentions) }), [value, mentions]);
  return (
    <span className="relative block">
      <textarea ref={inputRef} value={value} className={className} {...rest}
        role="combobox" aria-expanded={ta.open} aria-controls={menuId} aria-autocomplete="list" aria-activedescendant={ta.open ? `${menuId}-${ta.active}` : undefined}
        onChange={(e) => onValueChange(e.target.value, prune(e.target.value, mentions))}
        onKeyDown={(e) => { if (!ta.onKeyDown(e)) onKeyDown?.(e); }}
        onSelect={ta.refresh} onBlur={() => window.setTimeout(ta.close, 100)} />
      {ta.open && (
        <MentionMenu id={menuId} items={ta.items} active={ta.active} onPick={ta.pick} onHover={ta.setActive} loading={ta.loading} query={ta.query} className="absolute left-0 top-full mt-1" />
      )}
    </span>
  );
});
