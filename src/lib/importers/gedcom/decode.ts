/**
 * Turning a GEDCOM file's bytes into text (pure). GEDCOM 7 is always UTF-8; 5.5 / 5.5.1 files say what they are in
 * `1 CHAR` (UTF-8, UNICODE = UTF-16, ANSEL, ANSI, ASCII, IBM WINDOWS) but often lie, so the bytes decide first: a BOM,
 * then UTF-16 by its zero bytes, then valid UTF-8, then ANSEL when the header says so, else Windows-1252 (what old
 * Danish programs wrote). Danish æ ø å survive every path.
 */

export type Decoded = { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" | "ansel" | "windows-1252"; bom: boolean };

/** ANSEL (ANSI Z39.47) spacing characters 0xA1–0xCF. */
const ANSEL_SPACING: Record<number, string> = {
  0xa1: "Ł", 0xa2: "Ø", 0xa3: "Đ", 0xa4: "Þ", 0xa5: "Æ", 0xa6: "Œ", 0xa7: "ʹ", 0xa8: "·", 0xa9: "♭", 0xaa: "®",
  0xab: "±", 0xac: "Ơ", 0xad: "Ư", 0xae: "ʼ", 0xb0: "ʻ", 0xb1: "ł", 0xb2: "ø", 0xb3: "đ", 0xb4: "þ", 0xb5: "æ",
  0xb6: "œ", 0xb7: "ʺ", 0xb8: "ı", 0xb9: "£", 0xba: "ð", 0xbc: "ơ", 0xbd: "ư", 0xbe: "□", 0xbf: "■", 0xc0: "°",
  0xc1: "ℓ", 0xc2: "℗", 0xc3: "©", 0xc4: "♯", 0xc5: "¿", 0xc6: "¡", 0xc7: "ß", 0xc8: "€", 0xcd: "e", 0xce: "o", 0xcf: "ß",
};

/** ANSEL combining marks 0xE0–0xFE: written BEFORE the letter they sit on. */
const ANSEL_COMBINING: Record<number, string> = {
  0xe0: "̉", 0xe1: "̀", 0xe2: "́", 0xe3: "̂", 0xe4: "̃", 0xe5: "̄", 0xe6: "̆",
  0xe7: "̇", 0xe8: "̈", 0xe9: "̌", 0xea: "̊", 0xeb: "︠", 0xec: "︡", 0xed: "̕",
  0xee: "̋", 0xef: "̐", 0xf0: "̧", 0xf1: "̨", 0xf2: "̣", 0xf3: "̤", 0xf4: "̥",
  0xf5: "̳", 0xf6: "̲", 0xf7: "̦", 0xf8: "̜", 0xf9: "̮", 0xfa: "︢", 0xfb: "︣",
  0xfe: "̓",
};

export function decodeAnsel(bytes: Uint8Array): string {
  let out = "";
  let pending = "";
  for (const b of bytes) {
    if (b < 0x80) {
      out += String.fromCharCode(b) + pending;
      pending = "";
    } else if (ANSEL_COMBINING[b]) {
      pending += ANSEL_COMBINING[b];
    } else {
      out += (ANSEL_SPACING[b] ?? "�") + pending;
      pending = "";
    }
  }
  return (out + pending).normalize("NFC");
}

function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

/** What the header claims (`1 CHAR …`), read from the ASCII bytes of the first lines. */
function declaredCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const m = /^\s*1\s+CHAR\s+(.+?)\s*$/m.exec(head);
  return m ? m[1].toUpperCase() : null;
}

/** UTF-16 without a BOM: GEDCOM starts with "0", so one of the first two bytes is zero. */
function utf16Guess(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x30 && bytes[1] === 0x00 && bytes[3] === 0x00) return "utf-16le";
  if (bytes[0] === 0x00 && bytes[1] === 0x30 && bytes[2] === 0x00) return "utf-16be";
  return null;
}

export function decodeGedcom(bytes: Uint8Array): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", bom: true };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le", bom: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be", bom: true };
  const u16 = utf16Guess(bytes);
  if (u16) return { text: new TextDecoder(u16).decode(bytes), encoding: u16, bom: false };
  const asUtf8 = utf8(bytes);
  if (asUtf8 !== null) return { text: asUtf8, encoding: "utf-8", bom: false };
  const declared = declaredCharset(bytes);
  if (declared === "ANSEL") return { text: decodeAnsel(bytes), encoding: "ansel", bom: false };
  return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252", bom: false };
}

/** The start of a file as text, for detection (cheap; tolerant of a cut-off last character). */
export function decodeHead(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(head.subarray(2));
  const u16 = utf16Guess(head);
  if (u16) return new TextDecoder(u16).decode(head);
  const start = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  return Buffer.from(head.subarray(start)).toString("latin1");
}
