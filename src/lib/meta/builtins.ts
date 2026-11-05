/**
 * Built-in ontology shipped with My Graph (stored with householdId = null by `ensureBuiltins`).
 * Written for a Danish family: Danish institution names are given in descriptions so people recognise them.
 * Households can override (same key) or hide any of these, and add their own.
 */
import type { AttrType, MetaNodeType } from "./types";

export type BuiltinKind = {
  nodeType: MetaNodeType; key: string; label: string; pluralLabel?: string; description?: string;
  circle?: string; parentKey?: string; icon?: string; color?: string;
};
export type BuiltinRelation = {
  key: string; label: string; inverseLabel: string; category: string; fromTypes: string[]; toTypes: string[]; symmetric?: boolean;
};
export type BuiltinAttribute = {
  nodeType: MetaNodeType; kindKey?: string; key: string; label: string; dataType: AttrType; options?: string[];
  required?: boolean; sensitive?: boolean;
};

const P = "person" as const;

export const BUILTIN_KINDS: BuiltinKind[] = [
  // Family
  { nodeType: P, key: "partner", label: "Partner", pluralLabel: "Partners", circle: "family", icon: "heart", description: "Spouse, partner or co-parent." },
  { nodeType: P, key: "child", label: "Child", pluralLabel: "Children", circle: "family", icon: "baby", description: "Your own child, stepchild or foster child." },
  { nodeType: P, key: "parent", label: "Parent", pluralLabel: "Parents", circle: "family", icon: "users", description: "Mum, dad or step-parent." },
  { nodeType: P, key: "sibling", label: "Sibling", pluralLabel: "Siblings", circle: "family", icon: "users", description: "Brother, sister, half- or step-sibling." },
  { nodeType: P, key: "grandparent", label: "Grandparent", pluralLabel: "Grandparents", circle: "family", icon: "users", description: "Mormor, morfar, farmor, farfar." },
  { nodeType: P, key: "aunt_uncle", label: "Aunt or uncle", pluralLabel: "Aunts and uncles", circle: "family", icon: "users", description: "Moster, faster, morbror, farbror." },
  { nodeType: P, key: "cousin", label: "Cousin", pluralLabel: "Cousins", circle: "family", icon: "users", description: "Fætter or kusine." },
  { nodeType: P, key: "in_law", label: "In-law", pluralLabel: "In-laws", circle: "family", icon: "users", description: "Svigerforældre, svoger, svigerinde." },
  // Close
  { nodeType: P, key: "close_friend", label: "Close friend", pluralLabel: "Close friends", circle: "close", icon: "heart-handshake", description: "The people you would call at 2 am." },
  // Social
  { nodeType: P, key: "friend", label: "Friend", pluralLabel: "Friends", circle: "social", icon: "smile" },
  { nodeType: P, key: "neighbour", label: "Neighbour", pluralLabel: "Neighbours", circle: "social", icon: "home" },
  { nodeType: P, key: "childs_friend", label: "Child's friend", pluralLabel: "Children's friends", circle: "social", icon: "smile", description: "A friend of one of the children — playdates, birthdays, legeaftaler." },
  { nodeType: P, key: "childs_friend_parent", label: "Parent of a child's friend", pluralLabel: "Parents of children's friends", circle: "social", icon: "users", description: "Who to text about pick-ups and birthday invitations." },
  // School & daycare
  { nodeType: P, key: "teacher", label: "Teacher", pluralLabel: "Teachers", circle: "school", icon: "graduation-cap", description: "Lærer — including the class teacher (klasselærer / kontaktlærer)." },
  { nodeType: P, key: "pedagogue", label: "Pedagogue", pluralLabel: "Pedagogues", circle: "school", icon: "graduation-cap", description: "Pædagog in vuggestue, børnehave, SFO or fritidsklub." },
  { nodeType: P, key: "school_leader", label: "School leader", pluralLabel: "School leaders", circle: "school", icon: "graduation-cap", description: "Skoleleder, afdelingsleder or daycare manager." },
  { nodeType: P, key: "classmate", label: "Classmate", pluralLabel: "Classmates", circle: "school", icon: "school", description: "A child in the same class or group." },
  // Care & health
  { nodeType: P, key: "doctor", label: "Doctor", pluralLabel: "Doctors", circle: "care", icon: "stethoscope", description: "Egen læge (GP) or a specialist." },
  { nodeType: P, key: "dentist", label: "Dentist", pluralLabel: "Dentists", circle: "care", icon: "stethoscope", description: "Tandlæge — for children usually the municipal børnetandpleje." },
  { nodeType: P, key: "health_visitor", label: "Health visitor", pluralLabel: "Health visitors", circle: "care", icon: "stethoscope", description: "Sundhedsplejerske — follows babies at home and children at school." },
  { nodeType: P, key: "psychologist", label: "Psychologist", pluralLabel: "Psychologists", circle: "care", icon: "brain", description: "Including PPR (pædagogisk psykologisk rådgivning)." },
  { nodeType: P, key: "babysitter", label: "Babysitter", pluralLabel: "Babysitters", circle: "care", icon: "baby", description: "Barnepige or regular sitter." },
  // Work
  { nodeType: P, key: "colleague", label: "Colleague", pluralLabel: "Colleagues", circle: "work", icon: "briefcase" },
  { nodeType: P, key: "manager", label: "Manager", pluralLabel: "Managers", circle: "work", icon: "briefcase", description: "Your boss (chef / leder)." },
  // Other
  { nodeType: P, key: "other", label: "Other", pluralLabel: "Others", circle: "other", icon: "user" },

  // Places
  { nodeType: "place", key: "home", label: "Home", pluralLabel: "Homes", icon: "home" },
  { nodeType: "place", key: "school", label: "School", pluralLabel: "Schools", icon: "school", description: "Folkeskole, friskole or efterskole." },
  { nodeType: "place", key: "daycare", label: "Daycare or institution", pluralLabel: "Daycares and institutions", icon: "school", description: "Dagpleje, vuggestue, børnehave, SFO or fritidsklub." },
  { nodeType: "place", key: "clinic", label: "Clinic", pluralLabel: "Clinics", icon: "stethoscope", description: "Lægehus, tandklinik, hospital or physiotherapist." },
  { nodeType: "place", key: "sports_club", label: "Sports club", pluralLabel: "Sports clubs", icon: "trophy", description: "Football, swimming, gymnastics, scouts — the forening." },
  { nodeType: "place", key: "family_home", label: "Family home", pluralLabel: "Family homes", icon: "home", description: "Grandparents' or relatives' homes." },
  { nodeType: "place", key: "holiday_place", label: "Holiday place", pluralLabel: "Holiday places", icon: "sun", description: "Sommerhus, campsite or a place you return to." },

  // Events
  { nodeType: "event", key: "appointment", label: "Appointment", pluralLabel: "Appointments", icon: "calendar", description: "Doctor, dentist, health visitor or other booked time." },
  { nodeType: "event", key: "school_event", label: "School event", pluralLabel: "School events", icon: "school", description: "Forældremøde, skole-hjem-samtale, motionsdag, school trip." },
  { nodeType: "event", key: "birthday", label: "Birthday", pluralLabel: "Birthdays", icon: "cake" },
  { nodeType: "event", key: "trip", label: "Trip", pluralLabel: "Trips", icon: "plane" },
  { nodeType: "event", key: "activity", label: "Activity or practice", pluralLabel: "Activities", icon: "trophy", description: "Training, matches, lessons, recurring activities." },
  { nodeType: "event", key: "milestone", label: "Milestone", pluralLabel: "Milestones", icon: "flag", description: "First steps, first school day, learned to swim." },
  { nodeType: "event", key: "decision", label: "Decision", pluralLabel: "Decisions", icon: "check" },
  { nodeType: "event", key: "purchase", label: "Purchase", pluralLabel: "Purchases", icon: "shopping-bag" },

  // Topics
  { nodeType: "topic", key: "health", label: "Health", icon: "heart-pulse" },
  { nodeType: "topic", key: "school", label: "School", icon: "school" },
  { nodeType: "topic", key: "activities", label: "Activities", icon: "trophy" },
  { nodeType: "topic", key: "finances", label: "Finances", icon: "wallet" },
  { nodeType: "topic", key: "household", label: "Household", icon: "home" },
  { nodeType: "topic", key: "legal", label: "Legal", icon: "scale" },

  // Documents. A rule set is a body of rules the graph follows: a law, an agreement, house rules, a school's rules,
  // guidelines, our own rules (src/lib/corpus). It is a document, not a topic: it is written, issued by someone,
  // versioned and in force from a date, its rules are cited from its text, and document kinds stay in every graph
  // template. Each approved rule is a node of its own (part of the rule set), and so is each term the text defines.
  { nodeType: "document", key: "rule_set", label: "Rule set", pluralLabel: "Rule sets", icon: "scale", description: "A body of rules to follow: a law, an agreement, house rules, guidelines or our own rules." },
  { nodeType: "document", key: "rule", label: "Rule", pluralLabel: "Rules", icon: "scale", description: "One rule of a rule set, in plain words, with the exact words it comes from." },
  { nodeType: "document", key: "definition", label: "Definition", pluralLabel: "Definitions", icon: "book-open", description: "A term a rule set defines (\"I denne lov forstås ved …\")." },

  // Commitments (src/lib/commitments): what the household owes, is owed or was promised. nodes.kind = props.kind.
  { nodeType: "commitment", key: "reply", label: "Reply", pluralLabel: "Replies", icon: "reply", description: "Answer a letter, a form or a request (svarfrist, partshøring)." },
  { nodeType: "commitment", key: "payment", label: "Payment", pluralLabel: "Payments", icon: "wallet", description: "Pay a bill, a fee or a fine, or be paid back." },
  { nodeType: "commitment", key: "renewal", label: "Renewal or expiry", pluralLabel: "Renewals and expiries", icon: "refresh-cw", description: "Insurance, passport, lease or a subscription that renews or runs out." },
  { nodeType: "commitment", key: "notice", label: "Notice or appeal deadline", pluralLabel: "Notice and appeal deadlines", icon: "flag", description: "The last day to give notice, cancel or object (opsigelse, klagefrist)." },
  { nodeType: "commitment", key: "appointment", label: "Appointment", pluralLabel: "Appointments", icon: "calendar", description: "Be somewhere at a time (indkaldelse, doctor, parent meeting)." },
  { nodeType: "commitment", key: "form", label: "Form to sign", pluralLabel: "Forms to sign", icon: "pen-line", description: "Sign, fill in, submit or register." },
  { nodeType: "commitment", key: "deliver", label: "Hand in or bring", pluralLabel: "Things to hand in or bring", icon: "package", description: "Homework, documents, a packed lunch." },
  { nodeType: "commitment", key: "return", label: "Give back", pluralLabel: "Things to give back", icon: "undo-2", description: "A borrowed thing or a deposit." },
  { nodeType: "commitment", key: "other", label: "Other", pluralLabel: "Others", icon: "circle-dot" },
];

const PP = ["person"];
const ANY: string[] = [];

export const BUILTIN_RELATIONS: BuiltinRelation[] = [
  { key: "parent_of", label: "parent of", inverseLabel: "child of", category: "family", fromTypes: PP, toTypes: PP },
  { key: "partner_of", label: "partner of", inverseLabel: "partner of", category: "family", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "sibling_of", label: "sibling of", inverseLabel: "sibling of", category: "family", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "grandparent_of", label: "grandparent of", inverseLabel: "grandchild of", category: "family", fromTypes: PP, toTypes: PP },
  { key: "relative_of", label: "relative of", inverseLabel: "relative of", category: "family", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "friend_of", label: "friend of", inverseLabel: "friend of", category: "social", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "neighbour_of", label: "neighbour of", inverseLabel: "neighbour of", category: "social", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "knows", label: "knows", inverseLabel: "knows", category: "social", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "teacher_of", label: "teacher of", inverseLabel: "taught by", category: "school", fromTypes: PP, toTypes: PP },
  { key: "attends", label: "attends", inverseLabel: "attended by", category: "school", fromTypes: PP, toTypes: ["place", "event"] },
  { key: "treated_by", label: "treated by", inverseLabel: "treats", category: "care", fromTypes: PP, toTypes: ["person", "place"] },
  { key: "coaches", label: "coaches", inverseLabel: "coached by", category: "social", fromTypes: PP, toTypes: PP },
  { key: "works_with", label: "works with", inverseLabel: "works with", category: "work", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "colleague_of", label: "colleague of", inverseLabel: "colleague of", category: "work", fromTypes: PP, toTypes: PP, symmetric: true },
  { key: "manager_of", label: "manager of", inverseLabel: "reports to", category: "work", fromTypes: PP, toTypes: PP },
  { key: "mentor_of", label: "mentor of", inverseLabel: "mentored by", category: "work", fromTypes: PP, toTypes: PP },
  { key: "client_of", label: "client of", inverseLabel: "works for", category: "work", fromTypes: PP, toTypes: PP },
  { key: "located_at", label: "located at", inverseLabel: "location of", category: "place", fromTypes: ANY, toTypes: ["place"] },
  { key: "happened_at", label: "happened at", inverseLabel: "place of", category: "place", fromTypes: ["event"], toTypes: ["place"] },
  { key: "involves", label: "involves", inverseLabel: "involved in", category: "time", fromTypes: ["event"], toTypes: ["person", "place", "topic"] },
  { key: "follows", label: "follows", inverseLabel: "followed by", category: "time", fromTypes: ["event"], toTypes: ["event"] },
  { key: "caused_by", label: "caused by", inverseLabel: "led to", category: "time", fromTypes: ANY, toTypes: ANY },
  { key: "about", label: "about", inverseLabel: "subject of", category: "document", fromTypes: ["document", "event", "source", "commitment"], toTypes: ANY },
  { key: "tagged_with", label: "tagged with", inverseLabel: "tag on", category: "document", fromTypes: ANY, toTypes: ["topic"] },
  { key: "mentions", label: "mentions", inverseLabel: "mentioned in", category: "document", fromTypes: ["document", "source"], toTypes: ANY },
  { key: "derived_from", label: "derived from", inverseLabel: "source of", category: "document", fromTypes: ANY, toTypes: ["document", "source"] },
  { key: "version_of", label: "version of", inverseLabel: "has version", category: "document", fromTypes: ["document"], toTypes: ["document"] },
  { key: "supports", label: "supports", inverseLabel: "supported by", category: "document", fromTypes: ["document", "source"], toTypes: ANY },
  { key: "governs", label: "governs", inverseLabel: "governed by", category: "document", fromTypes: ["document"], toTypes: ANY },
  // Rule sets (src/lib/corpus): a rule is a rule in its rule set (rule_in), refers to other rules, and guidance interprets it.
  { key: "rule_in", label: "is a rule in", inverseLabel: "has as a rule", category: "document", fromTypes: ["document"], toTypes: ["document"] },
  { key: "refers_to", label: "refers to", inverseLabel: "referred to by", category: "document", fromTypes: ["document"], toTypes: ["document"] },
  { key: "interprets", label: "interprets", inverseLabel: "interpreted by", category: "document", fromTypes: ["document", "source"], toTypes: ["document"] },
  // Commitments (src/lib/commitments/types.ts COMMITMENT_RELATIONS): who has to do it, with whom, where it comes from.
  { key: "responsible_for", label: "responsible for", inverseLabel: "responsibility of", category: "time", fromTypes: PP, toTypes: ["commitment"] },
  { key: "with", label: "with", inverseLabel: "has a commitment", category: "time", fromTypes: ["commitment"], toTypes: ["person", "organization", "place"] },
  { key: "arises_from", label: "arises from", inverseLabel: "gives rise to", category: "document", fromTypes: ["commitment"], toTypes: ANY },
  { key: "clashes_with", label: "clashes with", inverseLabel: "clashes with", category: "time", fromTypes: ["commitment", "event"], toTypes: ["commitment", "event"], symmetric: true },
];

export const BUILTIN_ATTRIBUTES: BuiltinAttribute[] = [
  // Every person
  { nodeType: P, key: "birthday", label: "Birthday", dataType: "date" },
  { nodeType: P, key: "phone", label: "Phone", dataType: "phone" },
  { nodeType: P, key: "email", label: "Email", dataType: "email" },
  { nodeType: P, key: "address", label: "Address", dataType: "longtext" },
  { nodeType: P, key: "how_we_know", label: "How we know them", dataType: "text" },
  { nodeType: P, key: "allergies", label: "Allergies", dataType: "longtext", sensitive: true },
  { nodeType: P, key: "notes", label: "Notes", dataType: "longtext" },
  // Child
  { nodeType: P, kindKey: "child", key: "school", label: "School", dataType: "text" },
  { nodeType: P, kindKey: "child", key: "class", label: "Class", dataType: "text" },
  { nodeType: P, kindKey: "child", key: "institution", label: "Daycare / SFO", dataType: "text" },
  { nodeType: P, kindKey: "child", key: "shoe_size", label: "Shoe size", dataType: "text" },
  { nodeType: P, kindKey: "child", key: "clothing_size", label: "Clothing size", dataType: "text" },
  { nodeType: P, kindKey: "child", key: "interests", label: "Interests", dataType: "longtext" },
  // Doctor and dentist
  ...(["doctor", "dentist"] as const).flatMap((k) => [
    { nodeType: P, kindKey: k, key: "clinic", label: "Clinic", dataType: "text" as const },
    { nodeType: P, kindKey: k, key: "clinic_phone", label: "Clinic phone", dataType: "phone" as const },
    { nodeType: P, kindKey: k, key: "practice_number", label: "Practice number (ydernummer)", dataType: "text" as const },
  ]),
  // Teacher
  { nodeType: P, kindKey: "teacher", key: "subject", label: "Subject", dataType: "text" },
  { nodeType: P, kindKey: "teacher", key: "class", label: "Class", dataType: "text" },
  // Rule set (a body of rules) and its rules
  { nodeType: "document", kindKey: "rule_set", key: "authority", label: "Issued by", dataType: "text" },
  { nodeType: "document", kindKey: "rule_set", key: "binding", label: "Binding", dataType: "enum", options: ["mandatory", "advisory"] },
  { nodeType: "document", kindKey: "rule_set", key: "version", label: "Version", dataType: "text" },
  { nodeType: "document", kindKey: "rule_set", key: "effective_from", label: "In force from", dataType: "date" },
  { nodeType: "document", kindKey: "rule_set", key: "url", label: "Official text", dataType: "url" },
  { nodeType: "document", kindKey: "rule", key: "ref", label: "Reference", dataType: "text" },
  { nodeType: "document", kindKey: "rule", key: "says", label: "It says", dataType: "enum", options: ["must", "must_not", "should", "should_not", "may"] },
  { nodeType: "document", kindKey: "rule", key: "quote", label: "The exact words", dataType: "longtext" },
  { nodeType: "document", kindKey: "definition", key: "term", label: "Term", dataType: "text" },
  { nodeType: "document", kindKey: "definition", key: "ref", label: "Reference", dataType: "text" },
  // Babysitter
  { nodeType: P, kindKey: "babysitter", key: "rate", label: "Rate per hour (kr.)", dataType: "number" },
  { nodeType: P, kindKey: "babysitter", key: "availability", label: "Availability", dataType: "text" },
];

/* ── Roles ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Built-in roles: positions and functions people hold, apart from who they are. Keys match the person kinds they
 * replace (a "doctor" kind becomes the doctor role), so details a kind carried (clinic, subject …) stay with the role.
 * `impliedBy` names a relation that already says the role (parent ← parent_of): those are shown as roles but stay
 * relations. `contexts`: what the role can be held in (empty = anything).
 */
export type BuiltinRole = {
  key: string; label: string; pluralLabel: string; preposition: string; inverseLabel?: string;
  da: { label: string; plural: string; preposition: string; inverse?: string };
  circle: string; contexts?: string[]; impliedBy?: string; parentKey?: string; icon?: string; description?: string;
};

const ORGS_PLACES = ["organization", "place", "project", "person"];

export const BUILTIN_ROLES: BuiltinRole[] = [
  // Family (the relations stay the facts; the role is how they read)
  { key: "parent", label: "Parent", pluralLabel: "Parents", preposition: "of", inverseLabel: "child", da: { label: "Forælder", plural: "Forældre", preposition: "til", inverse: "barn" }, circle: "family", contexts: PP, impliedBy: "parent_of:out", icon: "users" },
  { key: "child", label: "Child", pluralLabel: "Children", preposition: "of", inverseLabel: "parent", da: { label: "Barn", plural: "Børn", preposition: "af", inverse: "forælder" }, circle: "family", contexts: PP, impliedBy: "parent_of:in", icon: "baby" },
  { key: "partner", label: "Partner", pluralLabel: "Partners", preposition: "of", inverseLabel: "partner", da: { label: "Partner", plural: "Partnere", preposition: "til", inverse: "partner" }, circle: "family", contexts: PP, impliedBy: "partner_of:any", icon: "heart", description: "Spouse, partner or co-parent." },
  { key: "sibling", label: "Sibling", pluralLabel: "Siblings", preposition: "of", da: { label: "Søskende", plural: "Søskende", preposition: "til" }, circle: "family", contexts: PP, impliedBy: "sibling_of:any", icon: "users" },
  { key: "grandparent", label: "Grandparent", pluralLabel: "Grandparents", preposition: "of", inverseLabel: "grandchild", da: { label: "Bedsteforælder", plural: "Bedsteforældre", preposition: "til", inverse: "barnebarn" }, circle: "family", contexts: PP, impliedBy: "grandparent_of:out", icon: "users", description: "Mormor, morfar, farmor, farfar." },
  { key: "aunt_uncle", label: "Aunt or uncle", pluralLabel: "Aunts and uncles", preposition: "of", da: { label: "Moster, faster eller onkel", plural: "Mostre, fastre og onkler", preposition: "til" }, circle: "family", contexts: PP },
  { key: "cousin", label: "Cousin", pluralLabel: "Cousins", preposition: "of", da: { label: "Fætter eller kusine", plural: "Fætre og kusiner", preposition: "til" }, circle: "family", contexts: PP },
  { key: "in_law", label: "In-law", pluralLabel: "In-laws", preposition: "of", da: { label: "Svigerfamilie", plural: "Svigerfamilie", preposition: "til" }, circle: "family", contexts: PP, description: "Svigerforældre, svoger, svigerinde." },
  // Close and social
  { key: "close_friend", label: "Close friend", pluralLabel: "Close friends", preposition: "of", da: { label: "Nær ven", plural: "Nære venner", preposition: "af" }, circle: "close", contexts: PP, icon: "heart-handshake" },
  { key: "friend", label: "Friend", pluralLabel: "Friends", preposition: "of", da: { label: "Ven", plural: "Venner", preposition: "af" }, circle: "social", contexts: PP, impliedBy: "friend_of:any", icon: "smile" },
  { key: "neighbour", label: "Neighbour", pluralLabel: "Neighbours", preposition: "of", da: { label: "Nabo", plural: "Naboer", preposition: "til" }, circle: "social", contexts: ["person", "place"], impliedBy: "neighbour_of:any", icon: "home" },
  { key: "childs_friend", label: "Child's friend", pluralLabel: "Children's friends", preposition: "of", da: { label: "Barns ven", plural: "Børns venner", preposition: "af" }, circle: "social", contexts: PP, icon: "smile", description: "Playdates, birthdays, legeaftaler." },
  { key: "childs_friend_parent", label: "Parent of a child's friend", pluralLabel: "Parents of children's friends", preposition: "of", da: { label: "Forælder til et barns ven", plural: "Forældre til børns venner", preposition: "til" }, circle: "social", contexts: PP },
  { key: "coach", label: "Coach", pluralLabel: "Coaches", preposition: "at", inverseLabel: "coach", da: { label: "Træner", plural: "Trænere", preposition: "i", inverse: "træner" }, circle: "social", contexts: ORGS_PLACES, icon: "trophy", description: "Træner or instructor in a club or forening." },
  { key: "landlord", label: "Landlord", pluralLabel: "Landlords", preposition: "of", inverseLabel: "landlord", da: { label: "Udlejer", plural: "Udlejere", preposition: "af", inverse: "udlejer" }, circle: "other", contexts: ["place", "thing", "person", "organization"], icon: "home" },
  { key: "tenant", label: "Tenant", pluralLabel: "Tenants", preposition: "of", inverseLabel: "tenant", da: { label: "Lejer", plural: "Lejere", preposition: "i", inverse: "lejer" }, circle: "other", contexts: ["place", "thing", "person"], icon: "home" },
  // School and daycare
  { key: "teacher", label: "Teacher", pluralLabel: "Teachers", preposition: "at", inverseLabel: "teacher", da: { label: "Lærer", plural: "Lærere", preposition: "på", inverse: "lærer" }, circle: "school", contexts: ORGS_PLACES, icon: "graduation-cap" },
  { key: "class_teacher", label: "Class teacher", pluralLabel: "Class teachers", preposition: "of", inverseLabel: "class teacher", da: { label: "Klasselærer", plural: "Klasselærere", preposition: "for", inverse: "klasselærer" }, circle: "school", contexts: ORGS_PLACES, parentKey: "teacher", icon: "graduation-cap", description: "Klasselærer or kontaktlærer." },
  { key: "pedagogue", label: "Pedagogue", pluralLabel: "Pedagogues", preposition: "at", inverseLabel: "pedagogue", da: { label: "Pædagog", plural: "Pædagoger", preposition: "i", inverse: "pædagog" }, circle: "school", contexts: ORGS_PLACES, icon: "graduation-cap", description: "Pædagog in vuggestue, børnehave, SFO or fritidsklub." },
  { key: "school_leader", label: "Principal", pluralLabel: "Principals", preposition: "of", inverseLabel: "principal", da: { label: "Skoleleder", plural: "Skoleledere", preposition: "på", inverse: "skoleleder" }, circle: "school", contexts: ORGS_PLACES, icon: "graduation-cap", description: "Skoleleder, afdelingsleder or daycare manager." },
  { key: "classmate", label: "Classmate", pluralLabel: "Classmates", preposition: "of", da: { label: "Klassekammerat", plural: "Klassekammerater", preposition: "til" }, circle: "school", contexts: ORGS_PLACES, icon: "school" },
  // Care and health
  { key: "doctor", label: "Doctor", pluralLabel: "Doctors", preposition: "at", inverseLabel: "doctor", da: { label: "Læge", plural: "Læger", preposition: "på", inverse: "læge" }, circle: "care", contexts: ORGS_PLACES, icon: "stethoscope", description: "Egen læge (GP) or a specialist." },
  { key: "dentist", label: "Dentist", pluralLabel: "Dentists", preposition: "at", inverseLabel: "dentist", da: { label: "Tandlæge", plural: "Tandlæger", preposition: "på", inverse: "tandlæge" }, circle: "care", contexts: ORGS_PLACES, icon: "stethoscope" },
  { key: "nurse", label: "Nurse", pluralLabel: "Nurses", preposition: "at", inverseLabel: "nurse", da: { label: "Sygeplejerske", plural: "Sygeplejersker", preposition: "på", inverse: "sygeplejerske" }, circle: "care", contexts: ORGS_PLACES, icon: "stethoscope" },
  { key: "health_visitor", label: "Health visitor", pluralLabel: "Health visitors", preposition: "for", inverseLabel: "health visitor", da: { label: "Sundhedsplejerske", plural: "Sundhedsplejersker", preposition: "for", inverse: "sundhedsplejerske" }, circle: "care", contexts: ORGS_PLACES, icon: "stethoscope" },
  { key: "psychologist", label: "Psychologist or therapist", pluralLabel: "Psychologists and therapists", preposition: "at", inverseLabel: "therapist", da: { label: "Psykolog eller terapeut", plural: "Psykologer og terapeuter", preposition: "hos", inverse: "psykolog" }, circle: "care", contexts: ORGS_PLACES, icon: "brain", description: "Including PPR (pædagogisk psykologisk rådgivning)." },
  { key: "babysitter", label: "Babysitter", pluralLabel: "Babysitters", preposition: "for", da: { label: "Babysitter", plural: "Babysittere", preposition: "for" }, circle: "care", contexts: ORGS_PLACES, icon: "baby" },
  { key: "clinician", label: "Clinician", pluralLabel: "Clinicians", preposition: "at", da: { label: "Behandler", plural: "Behandlere", preposition: "i" }, circle: "care", contexts: ORGS_PLACES, icon: "stethoscope", description: "A psychologist, therapist, doctor or nurse in a practice." },
  { key: "client", label: "Client", pluralLabel: "Clients", preposition: "of", inverseLabel: "client", da: { label: "Klient", plural: "Klienter", preposition: "hos", inverse: "klient" }, circle: "clients", contexts: ["person", "organization"], icon: "user" },
  { key: "patient", label: "Patient", pluralLabel: "Patients", preposition: "of", inverseLabel: "patient", da: { label: "Patient", plural: "Patienter", preposition: "hos", inverse: "patient" }, circle: "patients", contexts: ["person", "organization", "place"], icon: "user" },
  // Work
  { key: "colleague", label: "Colleague", pluralLabel: "Colleagues", preposition: "at", da: { label: "Kollega", plural: "Kolleger", preposition: "i" }, circle: "work", contexts: ORGS_PLACES, impliedBy: "colleague_of:any", icon: "briefcase" },
  { key: "manager", label: "Manager", pluralLabel: "Managers", preposition: "at", inverseLabel: "manager", da: { label: "Leder", plural: "Ledere", preposition: "i", inverse: "leder" }, circle: "work", contexts: ORGS_PLACES, impliedBy: "manager_of:out", icon: "briefcase", description: "Chef or leder." },
  { key: "employee", label: "Employee", pluralLabel: "Employees", preposition: "at", inverseLabel: "employee", da: { label: "Ansat", plural: "Ansatte", preposition: "i", inverse: "ansat" }, circle: "work", contexts: ["organization", "place", "project"], icon: "briefcase" },
];
