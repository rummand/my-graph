"use client";
import { createContext, useContext } from "react";

/** The kind of graph the Ask screen is in ("family", "work" …): family-only wording shows only in family graphs. */
export const GraphKindContext = createContext<string>("other");

export function useGraphKind(): string {
  return useContext(GraphKindContext);
}

export function useIsFamily(): boolean {
  return useContext(GraphKindContext) === "family";
}
