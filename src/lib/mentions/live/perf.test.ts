import { describe, expect, it } from "vitest";
import { detectDetails, maybeNewNames } from "./detect";
import { buildMatcher, type LexEntry } from "./matcher";
import { mergeLive } from "./merge";
import { splitSentences } from "./sentences";

/** The whole instant tier, as the composer runs it on every keystroke: split, match, detect, merge. */
describe("instant tier budget", () => {
  it("runs a keystroke on 2,000 characters against a 2,000-node lexicon in under 8 ms", () => {
    const first = ["Anna", "Bo", "Carl", "Dorte", "Emil", "Freja", "Gustav", "Hanne", "Ida", "Jens", "Karen", "Lars", "Mads", "Nina", "Ole", "Pia"];
    const last = ["Hansen", "Jensen", "Nielsen", "Pedersen", "Andersen", "Christensen", "Larsen", "Sørensen", "Rasmussen", "Jørgensen"];
    const lex: LexEntry[] = [];
    for (let i = 0; i < 2000; i++) lex.push({ id: `p${i}`, label: i < 160 ? `${first[i % 16]} ${last[(i >> 4) % 10]}` : `Thing ${i}`, type: i % 4 ? "person" : "place", aliases: i % 7 ? undefined : [`alias${i}`] });
    const matcher = buildMatcher(lex);
    const para = "Anna Hansen mødes med Lars Larsen på torsdag kl. 14 ved Thing 1234. Det koster 450 kr. Peter Holm ringer i morgen på 22 33 44 55.\n";
    const base = para.repeat(Math.ceil(2000 / para.length)).slice(0, 2000);
    const keystroke = (text: string) => {
      const sentences = splitSentences(text);
      const links = matcher.match(text);
      const details = detectDetails(text);
      const maybe = maybeNewNames(text, [...links, ...details]);
      return mergeLive({ text, sentences, results: sentences.map(() => null), links, details, maybe });
    };
    for (let i = 0; i < 5; i++) keystroke(base.slice(0, 1900 + i));
    const runs = 30;
    const t0 = performance.now();
    let spans = 0;
    for (let i = 0; i < runs; i++) spans = keystroke(base.slice(0, 1970 + i)).spans.length;
    const ms = (performance.now() - t0) / runs;
    console.info(`instant tier: ${ms.toFixed(2)} ms per keystroke (2,000 chars, 2,000 nodes)`);
    expect(spans).toBeGreaterThan(50);
    expect(ms).toBeLessThan(8);
  });
});
