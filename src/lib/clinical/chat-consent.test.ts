import { describe, expect, it } from "vitest";
import { clientOfItem, consentHint, consentStepLabel, filterByConsent, type ClinicalLinks } from "./chat-consent";

const links: ClinicalLinks = {
  clients: new Map([["c-anna", "Anna K."], ["c-bo", "Bo L."]]),
  sourceClient: new Map([["s-transcript-anna", "c-anna"], ["s-audio-bo", "c-bo"]]),
  nodeClient: new Map([["n-session-anna", "c-anna"]]),
};

const items = [
  { kind: "node" as const, nodeId: "c-anna", title: "Anna K." },
  { kind: "passage" as const, sourceId: "s-transcript-anna", title: "Transcript" },
  { kind: "node" as const, nodeId: "n-session-anna", title: "Session 3" },
  { kind: "fact" as const, fromId: "c-anna", sourceId: null, title: "Anna — works at — X" },
  { kind: "passage" as const, sourceId: "s-audio-bo", title: "Recording" },
  { kind: "reminder" as const, nodeId: null, sourceId: null, title: "Buy milk" },
  { kind: "node" as const, nodeId: "n-family", title: "Grandma" },
];

describe("consent in the ordinary chat", () => {
  it("finds the client an item is about", () => {
    expect(clientOfItem(items[0], links)).toBe("c-anna");
    expect(clientOfItem(items[1], links)).toBe("c-anna");
    expect(clientOfItem(items[2], links)).toBe("c-anna");
    expect(clientOfItem(items[3], links)).toBe("c-anna");
    expect(clientOfItem(items[4], links)).toBe("c-bo");
    expect(clientOfItem(items[5], links)).toBeNull();
    expect(clientOfItem(items[6], links)).toBeNull();
  });

  it("leaves out the material of clients without consent for analysis, and only theirs", () => {
    const r = filterByConsent(items, links, new Set(["c-bo"]));
    expect(r.kept.map((i) => i.title)).toEqual(["Recording", "Buy milk", "Grandma"]);
    expect(r.excluded).toEqual([{ id: "c-anna", label: "Anna K.", count: 4 }]);
  });

  it("keeps everything when every consent covers it", () => {
    const r = filterByConsent(items, links, new Set(["c-anna", "c-bo"]));
    expect(r.kept).toHaveLength(items.length);
    expect(r.excluded).toEqual([]);
  });

  it("says so, in the answer and in the steps", () => {
    expect(consentHint([])).toBeNull();
    expect(consentHint([{ label: "Anna K." }])).toMatch(/Anna K\..*consent doesn't cover analysis/);
    expect(consentStepLabel([{ label: "Anna K.", count: 4 }])).toBe("Left out 4 items about Anna K. (no consent for analysis)");
    expect(consentStepLabel([{ label: "Bo L.", count: 1 }])).toBe("Left out 1 item about Bo L. (no consent for analysis)");
  });
});
