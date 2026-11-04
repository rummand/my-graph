/** Recipes (saved prompts): visibility, placeholders and the starter set (pure, tested). */
import { scopeOf, type ScopeInput } from "@/lib/graphs/pure";

export type RecipeVisibility = "private" | "parents" | "household";

/** Owner always; household recipes for everyone but guests; parents-only for parents (editors outside the family graph). */
export function canSeeRecipe(v: ScopeInput, r: { ownerId: string; visibility: RecipeVisibility; graphId?: string }): boolean {
  const s = scopeOf(v);
  if (r.graphId && s.graphId && r.graphId !== s.graphId) return false;
  if (r.ownerId === s.id) return true;
  if (s.role === "guest") return false;
  if (r.visibility === "household") return true;
  return r.visibility === "parents" && (s.role === "owner" || s.role === "parent");
}

export function canEditRecipe(v: ScopeInput, r: { ownerId: string; graphId?: string }): boolean {
  const s = scopeOf(v);
  if (r.graphId && s.graphId && r.graphId !== s.graphId) return false;
  return s.canWrite && r.ownerId === s.id;
}

const PLACEHOLDER = /<([^<>\n]{1,40})>/g;

/** Fill-ins a recipe asks for when it runs, e.g. "What do we need to pack for <trip>?" → ["trip"]. */
export function recipePlaceholders(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Put the fill-ins into the prompt. Missing ones become "(not given)" so the assistant can ask or work around it. */
export function fillRecipe(prompt: string, values: Record<string, string>): string {
  return prompt.replace(PLACEHOLDER, (_all, raw: string) => {
    const v = values[raw.trim()]?.trim();
    return v ? v.slice(0, 200) : "(not given)";
  });
}

export type StarterRecipe = { name: string; description: string; prompt: string };

/** Created the first time someone opens Recipes in a graph. Written for a family, in plain words. */
export const STARTER_RECIPES: StarterRecipe[] = [
  {
    name: "Weekly family summary",
    description: "What happened this week and what is coming next week, per person.",
    prompt: "Write a short weekly summary for our family. For each person: what happened this past week (letters, events, notes) and what is coming up in the next 7 days (appointments, deadlines, birthdays, school things). End with anything that needs a decision from us. Cite where each item came from.",
  },
  {
    name: "What do we need to pack for <trip>",
    description: "A packing list from past trips, the people going and what is planned.",
    prompt: "We're going on <trip>. Make a packing list for the people going. Use what we packed or forgot on earlier trips, anything planned for the trip (activities, weather notes, tickets), and each person's needs (medicine, the kids' things). Group it per person, and list anything we still need to buy or book.",
  },
  {
    name: "Prepare for the next parent-teacher meeting",
    description: "Notes from school letters, Aula messages and how the child is doing.",
    prompt: "Help me prepare for the next parent-teacher meeting. Find when it is and for which child. Summarise what school has written recently (letters, Aula messages), how the child has been doing (our notes and check-ins), and anything we said we wanted to bring up. Finish with 3–5 questions to ask the teacher.",
  },
  {
    name: "Who haven't we seen in a while",
    description: "Family and friends we've been out of touch with longer than usual.",
    prompt: "Who in our family and close circle haven't we seen or talked to for longer than usual? List them with when we were last in touch, and suggest a simple way to reconnect with each (a call, a visit, inviting them for dinner), keeping our family rules and plans in mind.",
  },
];

/** Starters for work-like graphs (work, project, partner): no family, school or packing recipes. */
export const WORK_STARTER_RECIPES: StarterRecipe[] = [
  {
    name: "Weekly status",
    description: "What moved this week, what is due next week, and what is stuck.",
    prompt: "Write a short weekly status for this graph. Per project or team: what happened this past week (decisions, meetings, documents), what is due in the next 7 days, and what is blocked or waiting on someone. End with the decisions that need someone's call. Cite where each item came from.",
  },
  {
    name: "Prepare for a meeting with <who>",
    description: "Background, open points and questions before you meet someone.",
    prompt: "Help me prepare for my next meeting with <who>. Summarise who they are and how we work together, what we last discussed or agreed, open points and anything they are waiting on from us. Finish with 3–5 things to raise. Cite where each item came from.",
  },
  {
    name: "Open decisions and risks",
    description: "Decisions not yet made and risks worth watching, with who owns them.",
    prompt: "List the decisions that are still open and the risks worth watching in this graph. For each: what it is about, who owns it, since when, and what it depends on. Put the most urgent first. Cite where each item came from.",
  },
  {
    name: "Who haven't I been in touch with",
    description: "Colleagues, clients and partners you haven't spoken to for a while.",
    prompt: "Which colleagues, clients and partners in this graph haven't I been in touch with for longer than usual? List them with when we were last in touch and what we last talked about, and suggest a simple reason to reach out to each.",
  },
];

/** Starters for personal, shared and other graphs: nothing assumes a family or a job. */
export const GENERAL_STARTER_RECIPES: StarterRecipe[] = [
  {
    name: "Weekly summary",
    description: "What happened this week and what is coming next week.",
    prompt: "Write a short summary of this past week in this graph: what happened (notes, documents, events) and what is coming up in the next 7 days. End with anything that needs a decision. Cite where each item came from.",
  },
  {
    name: "Everything about <topic>",
    description: "One page on a person, place or topic from what this graph knows.",
    prompt: "Tell me everything this graph knows about <topic>: the key facts, the people and places connected to it, what happened when, and what is still open. Cite where each item came from.",
  },
  {
    name: "Who haven't I seen in a while",
    description: "People you've been out of touch with longer than usual.",
    prompt: "Who in this graph haven't I seen or talked to for longer than usual? List them with when we were last in touch, and suggest a simple way to reconnect with each.",
  },
];

/** The starter recipes for a graph, following its template: a Work graph never gets family recipes. */
export function starterRecipesFor(graphKind: string | null | undefined): StarterRecipe[] {
  if (graphKind === "family") return STARTER_RECIPES;
  if (graphKind === "work" || graphKind === "project" || graphKind === "partner") return WORK_STARTER_RECIPES;
  return GENERAL_STARTER_RECIPES;
}
