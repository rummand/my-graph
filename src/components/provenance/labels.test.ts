import { describe, expect, it } from "vitest";
import { activityLabel, agentLabel, confidenceLabel, formatWhen, locatorLabel } from "./labels";

describe("provenance labels", () => {
  it("activity", () => {
    expect(activityLabel("ocr")).toBe("Read from a scan (OCR)");
    expect(activityLabel("something_new")).toBe("something new");
  });
  it("agent", () => {
    expect(agentLabel("user", "u1", { u1: "Anna" })).toBe("Anna");
    expect(agentLabel("user", "gone")).toBe("A former member");
    expect(agentLabel("model", "mux:qwen3-local")).toBe("Assistant (qwen3-local)");
    expect(agentLabel("rule", "birthday_rule")).toBe("Rule: birthday rule");
  });
  it("locator", () => {
    expect(locatorLabel({ page: 2 })).toBe("page 2");
    expect(locatorLabel({ timeStartSec: 42, timeEndSec: 65 })).toBe("0:42–1:05");
    expect(locatorLabel({ charStart: 1 })).toBe("");
    expect(locatorLabel(undefined)).toBe("");
  });
  it("confidence", () => {
    expect(confidenceLabel(0.95)).toBe("High confidence");
    expect(confidenceLabel(0.59)).toBe("Low confidence");
  });
  it("when, at the known precision", () => {
    expect(formatWhen("2026-08-10T12:00:00Z", null, "year")).toBe("2026");
    expect(formatWhen("2026-08-10T12:00:00Z", null, "month")).toBe("August 2026");
    expect(formatWhen("2026-08-10T12:00:00Z", "2026-08-12T12:00:00Z", "day")).toBe("10 August 2026 – 12 August 2026");
    expect(formatWhen(null, null, null)).toBe("");
  });
});
