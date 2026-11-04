/**
 * A small, forgiving XML reader for Office files (pptx parts). Pure. Not a validating parser: it builds a tree of
 * elements with attributes and text, ignores the prolog, comments, CDATA markers and processing instructions, and
 * decodes the five named entities plus numeric ones.
 */

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parse an XML document into its root element (a synthetic "#document" node holding the top-level elements). */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      // Close the nearest open element with this name (tolerates a stray close tag).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) { stack.length = i; break; }
      }
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(ATTR_RE)) attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? "");
      const node: XmlNode = { name: m[3], attrs, children: [], text: "" };
      top.children.push(node);
      if (m[5] !== "/") stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root;
}

/** Local name without the namespace prefix ("a:t" → "t"). */
export const local = (name: string) => name.slice(name.indexOf(":") + 1);

/** Direct children with this local name. */
export const kids = (n: XmlNode, name: string) => n.children.filter((c) => local(c.name) === name);

export const kid = (n: XmlNode, name: string) => n.children.find((c) => local(c.name) === name);

/** All descendants with this local name, in document order. */
export function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (local(c.name) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function find(n: XmlNode, name: string): XmlNode | undefined {
  for (const c of n.children) {
    if (local(c.name) === name) return c;
    const d = find(c, name);
    if (d) return d;
  }
  return undefined;
}

/** An attribute by local name ("r:embed" matches "embed"). */
export function attr(n: XmlNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  if (name in n.attrs) return n.attrs[name];
  for (const [k, v] of Object.entries(n.attrs)) if (local(k) === name) return v;
  return undefined;
}
