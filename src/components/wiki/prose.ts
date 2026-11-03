/**
 * Reading typography for page bodies, shared by the read view and the editor so editing looks like reading.
 * Arbitrary descendant variants keep it self-contained (no global CSS changes needed).
 */
export const PROSE = [
  "max-w-[70ch] text-[1rem] leading-7 text-fg break-words",
  "[&_p]:my-3",
  "[&_h1]:mt-8 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:mt-7 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_h4]:mt-5 [&_h4]:mb-1 [&_h4]:font-semibold",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li>p]:my-0",
  "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0",
  "[&_ul[data-type=taskList]>li]:flex [&_ul[data-type=taskList]>li]:items-start [&_ul[data-type=taskList]>li]:gap-2",
  "[&_ul[data-type=taskList]>li>label]:mt-1 [&_ul[data-type=taskList]>li>div]:min-w-0 [&_ul[data-type=taskList]>li>div]:flex-1",
  "[&_li[data-checked=true]>div]:text-muted [&_li[data-checked=true]>div]:line-through",
  "[&_input[type=checkbox]]:size-4 [&_input[type=checkbox]]:accent-[var(--accent)]",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-muted",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-2 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-6",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-surface-2 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.875em]",
  "[&_hr]:my-6 [&_hr]:border-line",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&_a[data-type=mention]]:no-underline [&_a[data-type=pageLink]]:decoration-dotted",
].join(" ");

/** Inline atoms: an @-mention looks like a soft chip; a [[page link]] looks like a link with a dotted underline. */
export const MENTION_CLASS = "rounded bg-accent-tint px-1 py-0.5 font-medium text-accent no-underline";
export const PAGE_LINK_CLASS = "font-medium text-accent underline decoration-dotted underline-offset-2";
