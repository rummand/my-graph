import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseType, checkAudio, joinDictation, MAX_DICTATION_BYTES, otherLang, speechLang } from "./transcribe";

const transcribe = vi.fn();
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u1", graphId: "g1", email: "anna@example.com" }) }));
vi.mock("@/lib/mux", async () => {
  const errors = await import("@/lib/mux/errors");
  return { ...errors, transcribe: (...a: unknown[]) => transcribe(...a) };
});

describe("dictation limits", () => {
  it("accepts what browsers record", () => {
    expect(checkAudio({ size: 40_000, type: "audio/webm;codecs=opus" })).toEqual({ ok: true, type: "audio/webm", ext: "webm" });
    expect(checkAudio({ size: 40_000, type: "audio/mp4" })).toMatchObject({ ok: true, ext: "m4a" });
    expect(checkAudio({ size: 40_000, type: "audio/ogg; codecs=opus" })).toMatchObject({ ok: true, ext: "ogg" });
    expect(baseType("Audio/WebM; codecs=opus")).toBe("audio/webm");
  });

  it("refuses other types, too big and too small", () => {
    expect(checkAudio(null)).toMatchObject({ ok: false, status: 400 });
    expect(checkAudio({ size: 40_000, type: "image/png" })).toMatchObject({ ok: false, status: 415 });
    expect(checkAudio({ size: 40_000, type: "" })).toMatchObject({ ok: false, status: 415 });
    expect(checkAudio({ size: MAX_DICTATION_BYTES + 1, type: "audio/webm" })).toMatchObject({ ok: false, status: 413 });
    expect(checkAudio({ size: 10, type: "audio/webm" })).toMatchObject({ ok: false, status: 400 });
  });

  it("joins dictated words after what was typed", () => {
    expect(joinDictation("", "hvad skal bo til i morgen")).toBe("Hvad skal bo til i morgen");
    expect(joinDictation("Ask about", "the dog")).toBe("Ask about the dog");
    expect(joinDictation("Ask about ", "  the dog")).toBe("Ask about the dog");
    expect(joinDictation("Typed", "   ")).toBe("Typed");
    expect(speechLang("da")).toBe("da-DK");
    expect(speechLang("en")).toBe("en-GB");
    expect(otherLang("da")).toBe("en");
  });
});

describe("POST /api/transcribe", () => {
  beforeEach(() => { transcribe.mockReset(); });

  async function post(form: FormData, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/transcribe/route");
    return POST(new Request("http://localhost/api/transcribe", { method: "POST", body: form, headers }));
  }
  const audio = (size: number, type: string) => new Blob([new Uint8Array(size)], { type });

  it("transcribes a recording through mux with no fallback", async () => {
    transcribe.mockResolvedValue({ text: " Hej Bo ", segments: [] });
    const f = new FormData();
    f.append("audio", audio(4000, "audio/webm"), "dictation");
    f.append("language", "da");
    const res = await post(f);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Hej Bo", language: "da" });
    expect(transcribe.mock.calls[0][1]).toBe("dictation.webm");
    expect(transcribe.mock.calls[0][2]).toMatchObject({ userId: "u1", sensitive: true, graphId: "g1" });
  });

  it("refuses a wrong type, a missing file and an unknown language before calling mux", async () => {
    const wrong = new FormData();
    wrong.append("audio", audio(4000, "text/plain"), "x.txt");
    expect((await post(wrong)).status).toBe(415);
    expect((await post(new FormData())).status).toBe(400);
    const lang = new FormData();
    lang.append("audio", audio(4000, "audio/webm"), "d");
    lang.append("language", "fr");
    expect((await post(lang)).status).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("refuses a recording that's too big", async () => {
    const f = new FormData();
    f.append("audio", audio(MAX_DICTATION_BYTES + 10, "audio/webm"), "d");
    expect((await post(f)).status).toBe(413);
    expect((await post(new FormData(), { "content-length": String(MAX_DICTATION_BYTES * 2) })).status).toBe(413);
  });

  it("says plainly when the model gateway is down", async () => {
    const { MuxUnavailableError } = await import("@/lib/mux/errors");
    transcribe.mockRejectedValue(new MuxUnavailableError("down"));
    const f = new FormData();
    f.append("audio", audio(4000, "audio/mp4"), "d");
    const res = await post(f);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/model gateway/);
  });
});
