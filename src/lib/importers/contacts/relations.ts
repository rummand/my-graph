/**
 * What a related-name label on a contact card means as a relation in the graph (pure). Labels come from Apple
 * (X-ABLabel "_$!<Mother>!$_"), vCard 4 RELATED types, Google's relation types and Android's codes, in English or
 * Danish, or typed by hand. Keys are the built-in relations of the meta model (src/lib/meta/builtins.ts).
 *
 *   dir "in":  the RELATED person is the subject ("mother: Ida" → Ida parent_of the contact)
 *   dir "out": the CONTACT is the subject ("child: Bo" → the contact parent_of Bo)
 *   dir "sym": symmetric relations (partner, sibling, friend …)
 *
 * Anything unclear (contact, acquaintance, emergency, referred by, a label nobody can read) is null: the name is
 * mentioned on the proposal, never turned into a fact.
 */
import { normName } from "../match";
import { cleanLabel } from "./vcard";

export type RelationGuess = { key: string; dir: "in" | "out" | "sym" };

const TABLE: [RelationGuess, string[]][] = [
  [{ key: "parent_of", dir: "in" }, [
    "mother", "father", "parent", "mom", "mum", "mommy", "mummy", "dad", "daddy", "stepmother", "stepfather", "step mother", "step father",
    "mor", "far", "forælder", "foraelder", "mamma", "mama", "pappa", "papa", "far og mor", "stedmor", "stedfar", "bonusmor", "bonusfar", "plejemor", "plejefar",
  ]],
  [{ key: "parent_of", dir: "out" }, [
    "child", "son", "daughter", "kid", "stepchild", "stepson", "stepdaughter", "step son", "step daughter",
    "barn", "søn", "datter", "bonusbarn", "bonussøn", "bonusdatter", "stedbarn", "stedsøn", "steddatter", "plejebarn",
  ]],
  [{ key: "partner_of", dir: "sym" }, [
    "spouse", "partner", "husband", "wife", "domestic partner", "domesticpartner", "girlfriend", "boyfriend", "fiance", "fiancé", "fiancée", "sweetheart",
    "ægtefælle", "aegtefaelle", "hustru", "kone", "mand", "ægtemand", "kæreste", "kaereste", "samlever", "forlovede",
  ]],
  [{ key: "sibling_of", dir: "sym" }, [
    "sibling", "brother", "sister", "half brother", "half sister", "stepbrother", "stepsister",
    "søskende", "bror", "broder", "søster", "lillebror", "storebror", "lillesøster", "storesøster", "halvbror", "halvsøster", "bonusbror", "bonussøster",
  ]],
  [{ key: "grandparent_of", dir: "in" }, [
    "grandmother", "grandfather", "grandparent", "grandma", "grandpa", "granny", "nana",
    "mormor", "morfar", "farmor", "farfar", "bedstemor", "bedstefar", "bedsteforælder", "oldemor", "oldefar",
  ]],
  [{ key: "grandparent_of", dir: "out" }, ["grandchild", "grandson", "granddaughter", "barnebarn", "oldebarn"]],
  [{ key: "relative_of", dir: "sym" }, [
    "relative", "kin", "family", "aunt", "uncle", "cousin", "niece", "nephew", "mother in law", "father in law", "sister in law", "brother in law",
    "son in law", "daughter in law", "in law", "co resident",
    "slægtning", "familie", "tante", "moster", "faster", "onkel", "morbror", "farbror", "fætter", "kusine", "nevø", "svigermor", "svigerfar",
    "svigerinde", "svoger", "svigersøn", "svigerdatter", "svigerforældre",
  ]],
  [{ key: "friend_of", dir: "sym" }, ["friend", "best friend", "ven", "veninde", "bedste ven", "bedste veninde"]],
  [{ key: "colleague_of", dir: "sym" }, ["colleague", "co worker", "coworker", "kollega", "kollegaer"]],
  [{ key: "manager_of", dir: "in" }, ["manager", "boss", "supervisor", "chef", "leder", "nærmeste leder"]],
  [{ key: "manager_of", dir: "out" }, ["assistant", "assistent"]],
  [{ key: "neighbour_of", dir: "sym" }, ["neighbor", "neighbour", "nabo", "genbo"]],
];

const LOOKUP = new Map<string, RelationGuess>();
for (const [guess, labels] of TABLE) for (const l of labels) LOOKUP.set(normLabel(l), guess);

function normLabel(s: string): string {
  // Keep æ, ø, å (normName folds accents but those are letters of their own); "co-worker" → "co worker".
  return cleanLabel(s).toLowerCase().replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

/** The relation a related-name label describes, or null when it isn't clear. */
export function relationFor(label: string): RelationGuess | null {
  const raw = cleanLabel(label);
  // Google's camelCase types ("domesticPartner") before lower-casing.
  const spaced = raw.replace(/([a-z])([A-Z])/g, "$1 $2");
  return LOOKUP.get(normLabel(spaced)) ?? LOOKUP.get(normName(spaced)) ?? null;
}
