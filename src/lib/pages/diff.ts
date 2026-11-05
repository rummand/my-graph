/** Word-level diff of page text for the history view. Pure. Myers' O((N+M)·D) algorithm on word tokens. */

export type DiffOp = "eq" | "add" | "del";
export type DiffSegment = { op: DiffOp; text: string };

/** Words and the whitespace between them, so joining the tokens gives back the original text exactly. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

const isSpace = (t: string) => /^\s+$/.test(t);

/** Shortest edit script between token arrays; null when the texts differ by more than maxD edits. */
function myers(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length, m = b.length, max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
    if (found >= 0) { trace.push(v.slice()); break; }
  }
  if (found < 0) return null;

  // Walk back through the saved frontiers. trace[d] is the frontier *before* step d; trace[d+1] after it.
  const ops: DiffOp[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("eq"); x--; y--; }
    ops.push(x === prevX ? "add" : "del");
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push("eq"); x--; y--; }
  return ops.reverse();
}

function push(out: DiffSegment[], op: DiffOp, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

/**
 * Word diff from `before` to `after`. Unchanged runs are "eq"; removed words "del"; new words "add".
 * Joining eq+del segments gives `before`; joining eq+add gives `after`.
 * Very different texts (more than `maxEdits` word edits) come back as one removal and one addition.
 */
export function wordDiff(before: string, after: string, maxEdits = 4000): DiffSegment[] {
  if (before === after) return before ? [{ op: "eq", text: before }] : [];
  const a = tokenize(before), b = tokenize(after);

  // Trim the common head and tail first — most edits touch a small part of the page.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail), bm = b.slice(head, b.length - tail);

  const out: DiffSegment[] = [];
  push(out, "eq", a.slice(0, head).join(""));
  const ops = myers(am, bm, maxEdits);
  if (!ops) {
    push(out, "del", am.join(""));
    push(out, "add", bm.join(""));
  } else {
    let i = 0, j = 0;
    for (const op of ops) {
      if (op === "eq") { push(out, "eq", am[i]); i++; j++; }
      else if (op === "del") { push(out, "del", am[i]); i++; }
      else { push(out, "add", bm[j]); j++; }
    }
  }
  push(out, "eq", a.slice(a.length - tail).join(""));
  return out;
}

/** Words added and removed (whitespace doesn't count). */
export function diffStats(segments: DiffSegment[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const s of segments) {
    if (s.op === "eq") continue;
    const words = tokenize(s.text).filter((t) => !isSpace(t)).length;
    if (s.op === "add") added += words; else removed += words;
  }
  return { added, removed };
}

/**
 * Collapse long unchanged stretches so the reader sees changes in context: keep `context` words either side of each
 * change and replace the rest with a gap marker. Returns segments plus "gap" entries.
 */
export type DisplaySegment = DiffSegment | { op: "gap"; words: number };

export function collapseUnchanged(segments: DiffSegment[], context = 12): DisplaySegment[] {
  const out: DisplaySegment[] = [];
  segments.forEach((s, idx) => {
    if (s.op !== "eq") { out.push(s); return; }
    const toks = tokenize(s.text);
    const words = toks.filter((t) => !isSpace(t)).length;
    const isFirst = idx === 0, isLast = idx === segments.length - 1;
    const keepBefore = isFirst ? 0 : context; // words after the previous change
    const keepAfter = isLast ? 0 : context; // words before the next change
    if (words <= keepBefore + keepAfter + 4) { out.push(s); return; }
    const takeWords = (list: string[], count: number) => {
      let seen = 0, i = 0;
      for (; i < list.length && seen < count; i++) if (!isSpace(list[i])) seen++;
      return i;
    };
    const headEnd = takeWords(toks, keepBefore);
    const rev = [...toks].reverse();
    const tailLen = takeWords(rev, keepAfter);
    const headText = toks.slice(0, headEnd).join("");
    const tailText = toks.slice(toks.length - tailLen).join("");
    if (headText) out.push({ op: "eq", text: headText });
    out.push({ op: "gap", words: words - keepBefore - keepAfter });
    if (tailText) out.push({ op: "eq", text: tailText });
  });
  return out;
}
