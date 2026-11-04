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
  { key: "about", label: "about", inverseLabel: "subject of", category: "document", fromTypes: ["document", "event", "source"], toTypes: ANY },
  { key: "tagged_with", label: "tagged with", inverseLabel: "tag on", category: "document", fromTypes: ANY, toTypes: ["topic"] },
  { key: "mentions", label: "mentions", inverseLabel: "mentioned in", category: "document", fromTypes: ["document", "source"], toTypes: ANY },
  { key: "derived_from", label: "derived from", inverseLabel: "source of", category: "document", fromTypes: ANY, toTypes: ["document", "source"] },
  { key: "version_of", label: "version of", inverseLabel: "has version", category: "document", fromTypes: ["document"], toTypes: ["document"] },
  { key: "supports", label: "supports", inverseLabel: "supported by", category: "document", fromTypes: ["document", "source"], toTypes: ANY },
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
  // Babysitter
  { nodeType: P, kindKey: "babysitter", key: "rate", label: "Rate per hour (kr.)", dataType: "number" },
  { nodeType: P, kindKey: "babysitter", key: "availability", label: "Availability", dataType: "text" },
];
