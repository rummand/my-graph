import { expect, it } from "vitest";
import { looksLikeText } from "@/lib/ingest/mime";
it("small UTF-8 text ending in a Danish letter is text", () => {
  expect(looksLikeText(new TextEncoder().encode("Søn"))).toBe(true);
  expect(looksLikeText(new TextEncoder().encode("Hej Søren, vi ses på søndag ø"))).toBe(true);
  const cutMid = new TextEncoder().encode("abcø").slice(0, 4); // last char cut in half
  expect(looksLikeText(cutMid)).toBe(true);
  expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x00, 0x41]))).toBe(false);
});
