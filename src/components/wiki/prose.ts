/**
 * Reading typography for page bodies, shared by the read view and the editor so writing looks exactly like reading.
 * Literata at about 68 characters a line; headings stay in the interface face so the page outline is easy to scan.
 * Arbitrary descendant variants keep it self-contained (no global CSS changes needed).
 */
import { personStyle } from "@/lib/ui/person-color";

export const PROSE = [
  "max-w-[68ch] font-read text-[17px] leading-[1.75] text-fg break-words [font-feature-settings:normal]",
  "[&>*:first-child]:mt-0",
  "[&_p]:my-4",
  "[&_h1]:mt-10 [&_h1]:mb-3 [&_h1]:font-sans [&_h1]:text-[22px] [&_h1]:leading-snug [&_h1]:font-semibold [&_h1]:tracking-[-0.015em]",
  "[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-sans [&_h2]:text-[20px] [&_h2]:leading-snug [&_h2]:font-semibold [&_h2]:tracking-[-0.01em]",
  "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:font-sans [&_h3]:text-[17px] [&_h3]:leading-snug [&_h3]:font-semibold",
  "[&_h4]:mt-6 [&_h4]:mb-1 [&_h4]:font-sans [&_h4]:font-semibold",
  "[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1.5 [&_li]:pl-1 [&_li_p]:my-0",
  "[&_li::marker]:text-muted [&_ol>li::marker]:font-sans [&_ol>li::marker]:text-[15px] [&_ol>li::marker]:tabular-nums",
  "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0",
  "[&_ul[data-type=taskList]>li]:flex [&_ul[data-type=taskList]>li]:items-start [&_ul[data-type=taskList]>li]:gap-3 [&_ul[data-type=taskList]>li]:pl-0",
  "[&_ul[data-type=taskList]>li>label]:mt-[0.3em] [&_ul[data-type=taskList]>li>label]:flex [&_ul[data-type=taskList]>li>div]:min-w-0 [&_ul[data-type=taskList]>li>div]:flex-1",
  "[&_li[data-checked=true]>div]:text-muted [&_li[data-checked=true]>div]:line-through [&_li[data-checked=true]>div]:decoration-muted/60",
  "[&_input[type=checkbox]]:size-[18px] [&_input[type=checkbox]]:cursor-pointer [&_input[type=checkbox]]:accent-[var(--accent)]",
  "[&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-5 [&_blockquote]:italic [&_blockquote]:text-muted",
  "[&_pre]:my-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-2 [&_pre]:px-4 [&_pre]:py-3 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-6",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-surface-2 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
  "[&_hr]:my-10 [&_hr]:border-line",
  "[&_:not([data-type=mention])>a]:text-accent [&_:not([data-type=mention])>a]:underline [&_:not([data-type=mention])>a]:underline-offset-[3px]",
  "[&_strong]:font-semibold",
].join(" ");

/** A [[page link]]: a cobalt link with a dotted underline, so it reads as "another page here", not the open web. */
export const PAGE_LINK_CLASS = "font-medium text-accent underline decoration-dotted decoration-accent/60 underline-offset-[3px] hover:decoration-solid";

/** Base look of an @-mention while editing. Matches PersonChip / NodeChip from the UI kit, which the read view uses. */
const CHIP = "inline-flex items-center gap-1.5 rounded-full py-px pl-2 pr-2.5 align-[0.05em] font-sans text-sm font-medium leading-[1.5] not-italic no-underline before:shrink-0 before:rounded-full before:content-['']";
export const MENTION_CLASS = CHIP;

const TYPE_VAR: Record<string, string> = { person: "--t-person", place: "--t-place", event: "--t-event", topic: "--t-topic", document: "--t-document", source: "--t-source" };

/** Class and inline style for an @-mention inside the editor: a person in their own colour, anything else by type. */
export function mentionChip(id: string, type: string | null | undefined): { class: string; style: string } {
  if (type === "person") {
    const vars = Object.entries(personStyle(id)).map(([k, v]) => `${k}: ${v}`).join("; ");
    return { class: `${CHIP} before:size-2 before:bg-current`, style: `${vars}; background: var(--person-tint); color: var(--person)` };
  }
  return {
    class: `${CHIP} bg-surface-2 text-fg before:size-1.5 before:bg-[var(--c)]`,
    style: `--c: var(${TYPE_VAR[type ?? ""] ?? "--muted"})`,
  };
}
