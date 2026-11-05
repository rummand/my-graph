import { describe, expect, it } from "vitest";
import type { Extraction } from "@/lib/meta/domain";
import { keepNamedThings, notAnEntity } from "./entities";

const none = new Set<string>();

describe("notAnEntity", () => {
  it("drops dates, times and amounts (the detectors show them)", () => {
    const t = "Emma starter til svømning den 12. marts kl. 16.30 og det koster 450 kr.";
    expect(notAnEntity(t, { label: "12. marts", surface: "12. marts" }, none)).toBe("detail");
    expect(notAnEntity(t, { label: "16.30", surface: "kl. 16.30" }, none)).toBe("detail");
    expect(notAnEntity(t, { label: "450 kr.", surface: "450 kr." }, none)).toBe("detail");
    expect(notAnEntity("Vi ses på Fredag", { label: "Fredag", surface: "Fredag" }, none)).toBe("detail");
  });
  it("drops common lowercase words", () => {
    expect(notAnEntity("Emma starter til svømning.", { label: "Svømning", surface: "svømning" }, none)).toBe("common");
    expect(notAnEntity("The piano lesson moved.", { label: "piano lesson", surface: "piano lesson" }, none)).toBe("common");
  });
  it("keeps names, named places and clubs", () => {
    const t = "Lars Petersen ringede fra Brønshøj Boldklub om Bellahøj Svømmestadion.";
    expect(notAnEntity(t, { label: "Lars Petersen", surface: "Lars Petersen" }, none)).toBeNull();
    expect(notAnEntity(t, { label: "Brønshøj Boldklub", surface: "Brønshøj Boldklub" }, none)).toBeNull();
    expect(notAnEntity(t, { label: "Bellahøj Svømmestadion" }, none)).toBeNull();
  });
  it("keeps a person called May next to a date in May, and anything the graph already has", () => {
    expect(notAnEntity("May and I go on 4 May.", { label: "May", surface: "May" }, none)).toBeNull();
    expect(notAnEntity("svømning igen", { label: "svømning", surface: "svømning", existingNodeId: "n1" }, new Set(["n1"]))).toBeNull();
  });
});

describe("keepNamedThings", () => {
  it("takes facts and details about dropped entities with them", () => {
    const x: Extraction = {
      entities: [
        { ref: "e1", label: "Emma", surface: "Emma", type: "person", kind: null, existingNodeId: null },
        { ref: "e2", label: "svømning", surface: "svømning", type: "topic", kind: null, existingNodeId: null },
        { ref: "e3", label: "12. marts", surface: "12. marts", type: "event", kind: null, existingNodeId: null },
      ],
      facts: [{ from: "e1", relation: "does", to: "e2" }, { from: "e1", relation: "on", to: "e3" }],
      attributes: [{ ref: "e2", label: "when", value: "12. marts", dataType: "text" }],
      synonyms: [],
    } as unknown as Extraction;
    const { kept, dropped } = keepNamedThings("Emma starter til svømning den 12. marts.", x, none);
    expect(kept.entities.map((e) => e.label)).toEqual(["Emma"]);
    expect(kept.facts).toEqual([]);
    expect(kept.attributes).toEqual([]);
    expect(dropped.map((d) => d.why)).toEqual(["common", "detail"]);
  });
});
