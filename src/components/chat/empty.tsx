"use client";
import { CornerDownRight } from "lucide-react";
import { Avatar } from "@/components/ui";
import type { Starter } from "./recency";

/** The first screen of a new conversation: what Ask is for, and questions this family would actually ask. */
export function ChatEmpty({ starters, onPick }: { starters: Starter[]; onPick: (q: string) => void }) {
  return (
    <div className="pt-[6vh] lg:pt-[10vh]">
      <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">What do you want to know?</h1>
      <p className="mt-3 max-w-[54ch] text-muted">
        Ask about anything your family has saved: letters from school, appointments, plans, the people in your lives.
        Every answer shows where it came from, and nothing is saved without your say-so.
      </p>
      <ul className="mt-9 -mx-3" aria-label="Questions to start with">
        {starters.map((s) => (
          <li key={s.question}>
            <button type="button" onClick={() => onPick(s.question)}
              className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-surface active:scale-[0.995]">
              {s.person
                ? <Avatar id={s.person.id} name={s.person.name} size={26} />
                : <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"><CornerDownRight aria-hidden className="size-3.5" /></span>}
              <span className="min-w-0 flex-1">{s.question}</span>
              <span aria-hidden className="text-sm text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">Ask</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
