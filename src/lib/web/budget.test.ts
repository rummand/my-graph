import { describe, expect, it } from "vitest";
import { budgetForRun, newWebBudget, readsLeft, searchesLeft, spendWeb, webAllowance } from "./budget";

describe("web budget of an unattended run", () => {
  it("allows 3 searches and 5 page reads in all", () => {
    const b = newWebBudget();
    expect(webAllowance(b, { search: true, max: 3 })).toEqual({ search: true, reads: 3 });
    spendWeb(b, { searches: 1, reads: 3 });
    expect(webAllowance(b, { search: true, max: 3 })).toEqual({ search: true, reads: 2 });
    spendWeb(b, { searches: 1, reads: 2 });
    expect(readsLeft(b)).toBe(0);
    expect(webAllowance(b, { search: true, max: 3 })).toBeNull();
    expect(webAllowance(b, { search: false, max: 1 })).toBeNull();
  });

  it("stops searching after the third search even with reads left", () => {
    const b = newWebBudget();
    for (let i = 0; i < 3; i++) spendWeb(b, { searches: 1, reads: 0 });
    expect(searchesLeft(b)).toBe(0);
    expect(webAllowance(b, { search: true, max: 3 })).toBeNull();
    expect(webAllowance(b, { search: false, max: 2 })).toEqual({ search: false, reads: 2 });
  });

  it("shares one budget between the calls of one run, and expires it", () => {
    const t = 1_000_000;
    const a = budgetForRun("run-1", t);
    spendWeb(a, { searches: 1, reads: 2 });
    expect(budgetForRun("run-1", t + 1000)).toBe(a);
    expect(budgetForRun("run-2", t + 1000)).not.toBe(a);
    expect(budgetForRun(null)).not.toBe(budgetForRun(null));
    expect(readsLeft(budgetForRun("run-1", t + 2 * 3600_000))).toBe(5);
  });
});
