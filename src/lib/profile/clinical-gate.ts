/**
 * Profiles of clinical clients and patients (kinds "client" / "patient" in a practice graph): analysis of what is
 * known about them, such as insights, runs only while the client's written consent covers analysis, and only for
 * someone with clinical access to the record.
 */
import type { Viewer } from "@/lib/auth";
import { allowed, loadClient } from "@/lib/clinical";

export const isClinicalKind = (kind: string | null | undefined): boolean => kind === "client" || kind === "patient";

export async function analysisAllowed(v: Viewer, node: { id: string; kind?: string | null }): Promise<boolean> {
  if (!isClinicalKind(node.kind)) return true;
  try {
    return allowed(await loadClient(v, node.id), "summary");
  } catch {
    return false;
  }
}
