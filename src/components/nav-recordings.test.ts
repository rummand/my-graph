import { describe, expect, it } from "vitest";
import { recordingsAvailable } from "./nav-recordings";

describe("Recordings in the navigation", () => {
  it("shows when the graph has a recording or Record is connected", () => {
    expect(recordingsAvailable({ recordings: [{ id: "r1" }] }, { connections: [] })).toBe(true);
    expect(recordingsAvailable({ recordings: [] }, { connections: [{ connector: "record" }] })).toBe(true);
  });

  it("stays hidden otherwise, or when the answers couldn't be read", () => {
    expect(recordingsAvailable({ recordings: [] }, { connections: [{ connector: "ics" }, { connector: "mcp" }] })).toBe(false);
    expect(recordingsAvailable(null, null)).toBe(false);
    expect(recordingsAvailable({ error: "x" }, { error: "y" })).toBe(false);
  });
});
