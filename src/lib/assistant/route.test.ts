import { describe, expect, it } from "vitest";
import { chooseRoute, decideRoute } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

describe("model routing", () => {
  it("keeps fast for small talk and short lookups from a few items", () => {
    expect(decideRoute("Thanks!")).toEqual({ route: "fast", why: "small_talk" });
    expect(decideRoute("Tak")).toEqual({ route: "fast", why: "small_talk" });
    expect(chooseRoute("When is Emma's swimming?", { contextItems: 3 })).toBe("fast");
    expect(chooseRoute("Hvornår har Noah fri?", { contextItems: 2 })).toBe("fast");
  });
  it("uses smart for reasoning, modelling and planning, in English and Danish", () => {
    for (const q of [
      "Should we move Emma to another school?", "Compare the two offers for the kitchen", "Explain what the letter means for us",
      "Model what happens to our budget if I go part-time", "What if we take the autumn holiday a week later?",
      "Hvad bør vi gøre med Noahs fritidsordning?", "Foreslå en plan for weekenden", "Sammenlign de to tilbud", "Hvorfor flyttede skolen mødet?",
      "Kan du vurdere risikoen ved at sælge bilen nu?",
    ]) expect(chooseRoute(q), q).toBe("smart");
  });
  it("uses smart when the person's own context is large, for follow-ups and multi-part questions", () => {
    expect(decideRoute("Who is coming to the party?", { contextItems: 12 })).toEqual({ route: "smart", why: "context" });
    expect(decideRoute("And the week after that", { followUp: true }).route).toBe("smart");
    expect(chooseRoute("Who is coming? And when do they arrive?")).toBe("smart");
    expect(chooseRoute("The school wrote about the trip. Emma is nervous about it")).toBe("smart");
  });
  it("uses agent when tools were used or anything is sensitive", () => {
    expect(decideRoute("Look up Lindevang Skole", { tools: true })).toEqual({ route: "agent", why: "tools" });
    expect(decideRoute("Help me plan", { sensitive: true })).toEqual({ route: "agent", why: "sensitive" });
    expect(decideRoute("Thanks", { sensitive: true, tools: true }).why).toBe("sensitive");
  });
  it("reads @mentions as their labels", () => {
    expect(chooseRoute(`When is @[Emma Hansen](node:${ID}) home?`)).toBe("fast");
  });
});
