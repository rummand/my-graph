import { describe, expect, it } from "vitest";
import { auditGraphId, auditIsGraphScoped, auditVisibleTo } from "./audit-labels";

const FAMILY = "fam", WORK = "work", FOR_SARA = "for-sara";
const anna = "anna", mikkel = "mikkel";
const mikkelGraphs = new Set([FAMILY]);
const annaGraphs = new Set([FAMILY, WORK, FOR_SARA]);

describe("activity log keeps other graphs out of the family log", () => {
  it("tags content actions with their graph, not account actions", () => {
    expect(auditIsGraphScoped("library.upload")).toBe(true);
    expect(auditIsGraphScoped("wiki.delete")).toBe(true);
    expect(auditIsGraphScoped("graph.create")).toBe(true);
    expect(auditIsGraphScoped("auth.login")).toBe(false);
    expect(auditIsGraphScoped("password.change")).toBe(false);
    expect(auditIsGraphScoped("member.create")).toBe(false);
  });

  it("finds the graph from meta or from a graph target", () => {
    expect(auditGraphId({ targetType: "source", targetId: "s1", meta: { graphId: WORK } })).toBe(WORK);
    expect(auditGraphId({ targetType: "graph", targetId: FOR_SARA, meta: { name: "For Sara" } })).toBe(FOR_SARA);
    expect(auditGraphId({ targetType: "user", targetId: anna, meta: {} })).toBeNull();
  });

  it("hides Anna's Work and For Sara activity from Mikkel", () => {
    const workDelete = { userId: anna, targetType: "source", targetId: "s1", meta: { graphId: WORK, title: "Salary review.pdf" } };
    const madeForSara = { userId: anna, targetType: "graph", targetId: FOR_SARA, meta: { name: "For Sara" } };
    const saraJoined = { userId: "sara", targetType: "graph", targetId: FOR_SARA, meta: { name: "Sara" } };
    for (const e of [workDelete, madeForSara, saraJoined]) expect(auditVisibleTo(e, mikkel, mikkelGraphs)).toBe(false);
    // Anna sees her own, and Sara joining the graph she owns.
    for (const e of [workDelete, madeForSara, saraJoined]) expect(auditVisibleTo(e, anna, annaGraphs)).toBe(true);
  });

  it("still shows family-graph and household-wide entries to every parent", () => {
    const famUpload = { userId: anna, targetType: "source", targetId: "s2", meta: { graphId: FAMILY } };
    const signIn = { userId: anna, targetType: "user", targetId: anna, meta: { method: "password" } };
    const old = { userId: anna, targetType: "source", targetId: "s3", meta: null };
    for (const e of [famUpload, signIn, old]) expect(auditVisibleTo(e, mikkel, mikkelGraphs)).toBe(true);
  });
});
