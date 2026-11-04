/**
 * CONTRACT: run the assistant without a chat window (automations, heartbeat, recipes on Today).
 * Owned by the assistant workstream; signature fixed, body is a stub until it lands.
 *
 * mode "unattended" is Scout's stricter policy: it may only read and *propose* (via addSuggestion); it never writes
 * facts, shares, changes visibility or messages anyone. Steps that would need approval are listed in `skipped`.
 */
import type { Viewer } from "@/lib/auth";
import type { AssistantStep, Citation } from "@/db/schema";

export type TaskResult = {
  text: string; summary: string; citations: Citation[]; steps: AssistantStep[]; skipped: string[];
  suggestionIds: string[]; degraded: boolean;
};

export async function runTask(_v: Viewer, _input: { prompt: string; mode: "unattended" | "interactive"; runId?: string; origin: "automation" | "heartbeat" | "recipe" }): Promise<TaskResult> {
  return { text: "", summary: "The assistant could not run yet.", citations: [], steps: [], skipped: [], suggestionIds: [], degraded: true };
}
