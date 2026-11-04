"use client";
import { useLayoutEffect, type KeyboardEvent, type RefObject } from "react";
import { clsx } from "clsx";
import { ArrowUp, Lock, Square } from "lucide-react";
import { Kbd } from "@/components/ui";

/** The question box, pinned under the thread. Grows with what you type, up to about ten lines. */
export function Composer({ value, onChange, onSend, onStop, streaming, stopping = false, sensitive, empty, inputRef }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  stopping?: boolean;
  sensitive: boolean;
  empty: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value, inputRef]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSend(); }}
      className="rounded-lg bg-surface shadow-float ring-1 ring-transparent transition-shadow focus-within:ring-accent/50">
      <label htmlFor="chat-input" className="sr-only">Your question</label>
      <textarea
        id="chat-input"
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        maxLength={4000}
        placeholder={streaming ? "Type a follow-up. It's sent when this answer is done" : empty ? "Ask about school, health, plans or anything you've saved" : "Ask a follow-up"}
        className="block max-h-[260px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15.5px] leading-relaxed outline-none placeholder:text-muted/80 focus-visible:outline-none"
      />
      <div className="flex items-center gap-3 px-2 pb-2 pl-4">
        <p className="min-w-0 flex-1 truncate text-xs text-muted">
          {sensitive ? (
            <span className="inline-flex items-center gap-1.5"><Lock aria-hidden className="size-3.5" />Private topic: this conversation stays on local models</span>
          ) : (
            <span className="hidden sm:inline">Answers use only what your family has saved. <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> for a new line</span>
          )}
        </p>
        {streaming ? (
          <span className="flex items-center gap-1.5">
            {value.trim() && (
              <button type="submit" aria-label="Send after this answer"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-sm font-medium text-bg transition-transform active:scale-[0.97]">
                <ArrowUp aria-hidden className="size-4" strokeWidth={2.2} /> Queue
              </button>
            )}
            <button type="button" onClick={onStop} disabled={stopping} aria-label="Stop the answer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-2 px-3 text-sm font-medium text-fg transition-[background-color,transform] hover:bg-line active:scale-[0.97] disabled:opacity-60">
              <Square aria-hidden className="size-3 fill-current" /> {stopping ? "Stopping…" : "Stop"}
            </button>
          </span>
        ) : (
          <button type="submit" disabled={!value.trim()} aria-label="Send question"
            className={clsx("inline-flex size-8 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-[0.94]",
              value.trim() ? "bg-fg text-bg hover:bg-fg/85" : "bg-surface-2 text-muted")}>
            <ArrowUp aria-hidden className="size-4" strokeWidth={2.2} />
          </button>
        )}
      </div>
    </form>
  );
}
