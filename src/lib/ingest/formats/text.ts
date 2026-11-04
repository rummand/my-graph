/** Decoding text files. Pure. */

export function decodeText(bytes: Buffer): string {
  // Strip a UTF-8 BOM; fall back to windows-1252 for old Windows exports that aren't valid UTF-8.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
