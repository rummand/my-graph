"use client";
import type { Mentionable } from "@/lib/mentions";

/** Search the current graph for the typeahead (GET /api/mentions). */
export async function fetchMentionables(query: string, limit = 7): Promise<Mentionable[]> {
  const res = await fetch(`/api/mentions?q=${encodeURIComponent(query)}&limit=${limit}`).catch(() => null);
  if (!res?.ok) return [];
  const body = await res.json().catch(() => null);
  return (body?.items ?? []) as Mentionable[];
}
