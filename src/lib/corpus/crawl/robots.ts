/**
 * robots.txt (pure, unit-tested): the group for our user agent (or "*"), Allow/Disallow with the longest match
 * winning (Allow wins a tie), `*` and `$` in paths, and Crawl-delay (capped at 10 s).
 */

export const USER_AGENT = "MyGraph-RuleReader/1.0 (+reads public rule texts for a private knowledge graph; 1 request per second)";
const UA_TOKEN = "mygraph-rulereader";

export type Robots = { allows: (pathAndQuery: string) => boolean; delayMs: number | null };

type Rule = { allow: boolean; path: string };

export function parseRobots(text: string): Robots {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") { if (val || key === "allow") cur.rules.push({ allow: key === "allow", path: val }); }
    else if (key === "crawl-delay") { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.delay = n; }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && UA_TOKEN.includes(a.replace(/\/.*$/, ""))))
    ?? groups.find((g) => g.agents.includes("*"));
  const rules = mine?.rules ?? [];
  return {
    allows: (p) => {
      let best: Rule | null = null;
      let bestLen = -1;
      for (const r of rules) {
        if (!r.path) continue;
        if (!matches(r.path, p)) continue;
        const len = r.path.replace(/\*/g, "").length;
        if (len > bestLen || (len === bestLen && r.allow)) { best = r; bestLen = len; }
      }
      return !best || best.allow;
    },
    delayMs: mine?.delay != null ? Math.min(10, mine.delay) * 1000 : null,
  };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** No robots.txt (404) means everything is allowed; one we couldn't read (5xx) means nothing is, for now. */
export const ALLOW_ALL: Robots = { allows: () => true, delayMs: null };
export const DENY_ALL: Robots = { allows: () => false, delayMs: null };
