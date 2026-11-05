/** Opening the ⌘K search from anywhere (the sidebar field, the phone header, other screens). */
export const SEARCH_EVENT = "mg:search";

export type SearchDetail = { q?: string };

export function openSearch(q?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SearchDetail>(SEARCH_EVENT, { detail: { q } }));
}

/** Whether a key press happened while typing somewhere (then "/" types a slash instead of opening search). */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable=true], [role=textbox]");
}
