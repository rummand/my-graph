/**
 * Graph templates (pure, safe for client components). A graph's kind (family, work, partner …) decides what it starts
 * with: the node kinds, relation types and attributes seeded into its meta model, the people circles, which Today
 * modules show, example prompts, onboarding copy and the sentence the assistant uses to frame itself.
 *
 * Built-ins (src/lib/meta/builtins.ts) are shared by every graph of the household; a template says which of them it
 * uses (`builtins`) and adds its own (`kinds`, `relations`, `attributes`), which are seeded per graph with
 * origin "template". Everything else the graph needs it learns over time (the emergent meta model).
 */
import type { AttrType, MetaNodeType } from "@/lib/meta/types";

export type GraphTemplateKind = "family" | "personal" | "work" | "partner" | "project" | "shared" | "other" | "practice";
export const GRAPH_TEMPLATE_KINDS: GraphTemplateKind[] = ["family", "personal", "work", "partner", "project", "shared", "other", "practice"];

export type TodayModule = "quick_actions" | "week" | "brief" | "reminders" | "waiting" | "attention" | "activity" | "recent" | "ready";

export type TemplateKind = {
  nodeType: MetaNodeType; key: string; label: string; pluralLabel?: string; description?: string; circle?: string; parentKey?: string; icon?: string;
};
export type TemplateRelation = {
  key: string; label: string; inverseLabel: string; category: string; fromTypes: string[]; toTypes: string[]; symmetric?: boolean;
};
export type TemplateAttribute = { nodeType: MetaNodeType; kindKey?: string; key: string; label: string; dataType: AttrType; options?: string[]; sensitive?: boolean };
export type TemplateCircleDef = { key: string; label: string; hint: string };

/** Which built-ins a graph uses: "all", or by node type → kind keys ("*" = every kind of that type), and relation categories. */
export type BuiltinSelection = "all" | {
  kinds: Partial<Record<MetaNodeType, string[] | "*">>;
  relationCategories: string[];
  /** Extra built-in relation keys outside those categories. */
  relations?: string[];
  /** Attribute keys kept on built-in kinds (type-wide ones always stay unless listed in `dropAttributes`). */
  dropAttributes?: string[];
};

export type GraphTemplate = {
  kind: GraphTemplateKind;
  /** What the graph is called in copy: "your family graph", "your work graph". */
  noun: string;
  builtins: BuiltinSelection;
  kinds: TemplateKind[];
  relations: TemplateRelation[];
  attributes: TemplateAttribute[];
  circles: TemplateCircleDef[];
  /** Built-in kind → this template's circle (a colleague is "team" in a Work graph). */
  circleOf: Record<string, string>;
  today: TodayModule[];
  prompts: string[];
  onboarding: { title: string; lead: string; firstSteps: string[] };
  /** One sentence the assistant starts its system prompt with. */
  framing: string;
  /** An example for "Describe part of your world". */
  describeExample: string;
};

const PP = ["person"];
const ORG = ["organization"];
const PROJ = ["project"];
const ANY: string[] = [];

/* Generic relations most non-family graphs share. */
const WORK_RELATIONS: TemplateRelation[] = [
  { key: "works_on", label: "works on", inverseLabel: "worked on by", category: "work", fromTypes: PP, toTypes: ["project", "topic", "thing"] },
  { key: "member_of", label: "member of", inverseLabel: "has member", category: "work", fromTypes: PP, toTypes: ORG },
  { key: "belongs_to", label: "belongs to", inverseLabel: "has", category: "work", fromTypes: ["project", "organization", "thing", "topic"], toTypes: ["organization", "project"] },
  { key: "leads", label: "leads", inverseLabel: "led by", category: "work", fromTypes: PP, toTypes: ["project", "organization"] },
  { key: "depends_on", label: "depends on", inverseLabel: "needed by", category: "work", fromTypes: ["project", "thing", "topic"], toTypes: ["project", "thing", "organization"] },
  { key: "stakeholder_of", label: "stakeholder in", inverseLabel: "has stakeholder", category: "work", fromTypes: ["person", "organization"], toTypes: PROJ },
];

const GENERIC_KINDS: TemplateKind[] = [
  { nodeType: "organization", key: "company", label: "Company", pluralLabel: "Companies", icon: "building" },
  { nodeType: "organization", key: "association", label: "Association", pluralLabel: "Associations", icon: "users", description: "A club, union or forening." },
];

/**
 * A clinical practice (psychologists, therapists, doctors). Clients and patients, the clinicians, sessions and
 * consultations, and what is recorded about them. Everything here is sensitive and private to the clinician unless a
 * consent allows sharing with a named colleague; the clinical workspace (/clinical) is where it is worked with.
 */
const PRACTICE: GraphTemplate = {
  kind: "practice",
  describeExample: "Maria sees clients on Tuesdays and Thursdays; Dr. Holm takes the medical consultations.",
  noun: "practice graph",
  builtins: { kinds: { person: ["colleague", "doctor", "other"], place: ["clinic"], event: [], topic: [] }, relationCategories: ["care", "work", "time", "document"] },
  kinds: [
    { nodeType: "person", key: "client", label: "Client", pluralLabel: "Clients", circle: "clients", icon: "user", description: "Someone in therapy with the practice." },
    { nodeType: "person", key: "patient", label: "Patient", pluralLabel: "Patients", circle: "patients", icon: "user", description: "Someone the practice treats medically." },
    { nodeType: "person", key: "clinician", label: "Clinician", pluralLabel: "Clinicians", circle: "practice", icon: "stethoscope", description: "A psychologist, therapist, doctor or nurse in the practice." },
    { nodeType: "event", key: "session", label: "Session", pluralLabel: "Sessions", icon: "calendar", description: "A therapy session." },
    { nodeType: "event", key: "consultation", label: "Consultation", pluralLabel: "Consultations", icon: "calendar", description: "A medical consultation." },
    { nodeType: "event", key: "measure", label: "Measure", pluralLabel: "Measures", icon: "activity", description: "A score from a questionnaire such as PHQ-9 or GAD-7." },
    { nodeType: "event", key: "lab_result", label: "Lab result", pluralLabel: "Lab results", icon: "flask", description: "A lab value or measurement with its reference range." },
    { nodeType: "event", key: "referral", label: "Referral", pluralLabel: "Referrals", icon: "send" },
    { nodeType: "thing", key: "medication", label: "Medication", pluralLabel: "Medications", icon: "pill" },
    { nodeType: "thing", key: "allergen", label: "Allergy", pluralLabel: "Allergies", icon: "alert-triangle", description: "Something a patient is allergic to." },
    { nodeType: "topic", key: "diagnosis", label: "Diagnosis", pluralLabel: "Diagnoses", icon: "clipboard", description: "A confirmed ICD-10 or ICPC-2 code." },
  ],
  relations: [
    { key: "client_of", label: "client of", inverseLabel: "has client", category: "care", fromTypes: PP, toTypes: PP },
    { key: "attended", label: "attended", inverseLabel: "attended by", category: "care", fromTypes: PP, toTypes: ["event"] },
    { key: "diagnosed_with", label: "diagnosed with", inverseLabel: "diagnosis of", category: "care", fromTypes: PP, toTypes: ["topic"] },
    { key: "takes", label: "takes", inverseLabel: "taken by", category: "care", fromTypes: PP, toTypes: ["thing"] },
    { key: "allergic_to", label: "allergic to", inverseLabel: "allergy of", category: "care", fromTypes: PP, toTypes: ["thing", "topic"] },
    { key: "has_result", label: "has result", inverseLabel: "result of", category: "care", fromTypes: PP, toTypes: ["event"] },
    { key: "referred_to", label: "referred to", inverseLabel: "received referral of", category: "care", fromTypes: PP, toTypes: ["person", "organization", "event"] },
  ],
  attributes: [
    { nodeType: "person", kindKey: "client", key: "started_on", label: "Started", dataType: "date", sensitive: true },
    { nodeType: "person", kindKey: "client", key: "referral_reason", label: "Reason for referral", dataType: "longtext", sensitive: true },
    { nodeType: "person", kindKey: "patient", key: "started_on", label: "Started", dataType: "date", sensitive: true },
    { nodeType: "thing", kindKey: "medication", key: "dose", label: "Dose", dataType: "text", sensitive: true },
    { nodeType: "thing", kindKey: "medication", key: "frequency", label: "How often", dataType: "text", sensitive: true },
    { nodeType: "topic", kindKey: "diagnosis", key: "code", label: "Code", dataType: "text", sensitive: true },
    { nodeType: "topic", kindKey: "diagnosis", key: "code_system", label: "Code system", dataType: "enum", options: ["ICD-10", "ICPC-2"], sensitive: true },
    { nodeType: "event", kindKey: "lab_result", key: "value", label: "Value", dataType: "number", sensitive: true },
    { nodeType: "event", kindKey: "lab_result", key: "unit", label: "Unit", dataType: "text", sensitive: true },
    { nodeType: "event", kindKey: "lab_result", key: "reference_range", label: "Reference range", dataType: "text", sensitive: true },
    { nodeType: "event", kindKey: "measure", key: "instrument", label: "Instrument", dataType: "enum", options: ["PHQ-9", "GAD-7"], sensitive: true },
    { nodeType: "event", kindKey: "measure", key: "score", label: "Score", dataType: "number", sensitive: true },
  ],
  circles: [
    { key: "clients", label: "Clients", hint: "People in therapy with you." },
    { key: "patients", label: "Patients", hint: "People you treat medically." },
    { key: "practice", label: "Practice", hint: "Your colleagues in the practice." },
    { key: "network", label: "Network", hint: "Doctors, hospitals and others you refer to." },
  ],
  circleOf: { colleague: "practice", doctor: "network", other: "network" },
  today: ["quick_actions", "brief", "reminders", "waiting", "recent"],
  prompts: ["Which notes are waiting for my signature?", "What has changed for this client since the last session?", "Which follow-ups are due this week?"],
  onboarding: {
    title: "Your practice graph",
    lead: "Clients, patients, sessions and consultations, private to each clinician and shared only where a client has consented.",
    firstSteps: ["Add a client or patient and register their consent", "Record or dictate a session", "Read the drafted note and sign it"],
  },
  framing: "You are the assistant for a clinical practice's graph: clients and patients, sessions, consultations, notes and measures. Everything here is confidential health information.",
};

export const TEMPLATES: Record<GraphTemplateKind, GraphTemplate> = {
  family: {
    kind: "family",
    describeExample: "Emma goes to Nørre Skole in 2.B. Her football club is B93, and Lars is her coach.",
    noun: "family graph",
    builtins: "all",
    kinds: [],
    relations: [],
    attributes: [],
    circles: [
      { key: "family", label: "Family", hint: "Partner, children, parents, grandparents." },
      { key: "close", label: "Close friends", hint: "The people you would call at 2 am." },
      { key: "school", label: "School & daycare", hint: "Teachers, pedagogues, classmates." },
      { key: "care", label: "Care & health", hint: "Doctor, dentist, health visitor, babysitter." },
      { key: "social", label: "Friends & neighbours", hint: "Friends, neighbours, children's friends and their parents." },
    ],
    circleOf: {},
    today: ["quick_actions", "week", "brief", "reminders", "waiting", "attention", "activity", "recent", "ready"],
    prompts: ["What's happening at school this week?", "When is Emma's next dentist appointment?", "What did the last Aula letter say?", "Who is picking up on Friday?"],
    onboarding: {
      title: "Your family graph",
      lead: "Who the people are, what is coming and where every fact came from, kept for the whole family.",
      firstSteps: ["Add the people in your family", "Upload a school letter or a photo of the fridge calendar", "Ask what's coming up this week"],
    },
    framing: "You are the assistant for a family's private graph: the people in it, their school, health, plans and the letters they keep.",
  },

  personal: {
    kind: "personal",
    describeExample: "I am training for the Copenhagen half marathon with my running club, and my physio is at Fysio Nord.",
    noun: "personal graph",
    builtins: { kinds: { person: ["partner", "parent", "sibling", "close_friend", "friend", "colleague", "doctor", "dentist", "other"], place: ["home", "clinic", "holiday_place"], event: "*", topic: "*" }, relationCategories: ["family", "social", "care", "work", "place", "time", "document", "other"] },
    kinds: [
      ...GENERIC_KINDS,
      { nodeType: "project", key: "goal", label: "Goal", pluralLabel: "Goals", icon: "flag", description: "Something you are working towards." },
      { nodeType: "thing", key: "possession", label: "Belonging", pluralLabel: "Belongings", icon: "package", description: "Things you own and want to remember details about." },
      { nodeType: "topic", key: "interest", label: "Interest", pluralLabel: "Interests", icon: "sparkles" },
    ],
    relations: [
      { key: "owns", label: "owns", inverseLabel: "owned by", category: "other", fromTypes: PP, toTypes: ["thing"] },
      { key: "interested_in", label: "interested in", inverseLabel: "interest of", category: "social", fromTypes: PP, toTypes: ["topic", "project", "thing"] },
      WORK_RELATIONS[0],
    ],
    attributes: [
      { nodeType: "thing", key: "bought_on", label: "Bought on", dataType: "date" },
      { nodeType: "thing", key: "warranty_until", label: "Warranty until", dataType: "date" },
      { nodeType: "project", key: "target_date", label: "Target date", dataType: "date" },
    ],
    circles: [
      { key: "close", label: "Close", hint: "The people closest to you." },
      { key: "family", label: "Family", hint: "Your family, near and far." },
      { key: "social", label: "Friends", hint: "Friends and people you meet." },
      { key: "work", label: "Work", hint: "Colleagues and people from work." },
      { key: "care", label: "Care & health", hint: "Your doctor, dentist and others who look after you." },
    ],
    circleOf: {},
    today: ["quick_actions", "brief", "reminders", "waiting", "attention", "recent", "ready"],
    prompts: ["What did I decide about the car insurance?", "When does the warranty on my laptop run out?", "What have I written about my running goal?"],
    onboarding: {
      title: "Your personal graph",
      lead: "Only you see this graph unless you share it. Keep notes, plans, belongings and the people in your life.",
      firstSteps: ["Write down a goal you are working on", "Upload a receipt or a contract", "Ask what you noted last month"],
    },
    framing: "You are the assistant for one person's private graph: their notes, plans, belongings and the people in their life.",
  },

  work: {
    kind: "work",
    describeExample: "I work in Architecture Enablement. Our department runs the EAM Platform project with two suppliers…",
    noun: "work graph",
    builtins: { kinds: { person: ["colleague", "manager", "other"], place: [], event: ["decision", "trip", "milestone"], topic: [] }, relationCategories: ["work", "place", "time", "document"], relations: ["knows"] },
    kinds: [
      ...GENERIC_KINDS,
      { nodeType: "organization", key: "team", label: "Team", pluralLabel: "Teams", icon: "users" },
      { nodeType: "organization", key: "client", label: "Client", pluralLabel: "Clients", icon: "briefcase" },
      { nodeType: "organization", key: "supplier", label: "Supplier", pluralLabel: "Suppliers", icon: "truck" },
      { nodeType: "person", key: "client_contact", label: "Client contact", pluralLabel: "Client contacts", circle: "clients", icon: "user" },
      { nodeType: "person", key: "partner_contact", label: "Partner contact", pluralLabel: "Partner contacts", circle: "partners", icon: "user" },
      { nodeType: "event", key: "meeting", label: "Meeting", pluralLabel: "Meetings", icon: "calendar" },
      { nodeType: "event", key: "deadline", label: "Deadline", pluralLabel: "Deadlines", icon: "flag" },
      { nodeType: "thing", key: "system", label: "System", pluralLabel: "Systems", icon: "server", description: "An application, platform or tool." },
    ],
    relations: [...WORK_RELATIONS, { key: "reports_to", label: "reports to", inverseLabel: "manages", category: "work", fromTypes: PP, toTypes: PP }],
    attributes: [
      { nodeType: "person", key: "role", label: "Role", dataType: "text" },
      { nodeType: "person", key: "work_email", label: "Work email", dataType: "email" },
      { nodeType: "project", key: "status", label: "Status", dataType: "enum", options: ["Idea", "Planned", "Running", "Paused", "Done"] },
      { nodeType: "project", key: "due", label: "Due", dataType: "date" },
    ],
    circles: [
      { key: "team", label: "Team", hint: "The people you work with every day." },
      { key: "manager", label: "Managers", hint: "Who you report to, and their managers." },
      { key: "clients", label: "Clients", hint: "Clients and their contacts." },
      { key: "partners", label: "Partners", hint: "Suppliers and partner companies." },
      { key: "network", label: "Network", hint: "Everyone else you know through work." },
    ],
    circleOf: { colleague: "team", manager: "manager", other: "network" },
    today: ["quick_actions", "brief", "reminders", "waiting", "attention", "recent", "ready"],
    prompts: ["What are we waiting for on the EAM Platform?", "Who works on which project?", "What did we decide in last week's meetings?"],
    onboarding: {
      title: "Your work graph",
      lead: "Projects, teams, decisions and the people around them. Separate from your family and personal graphs.",
      firstSteps: ["Tell it what you are working on", "Upload meeting notes or a project plan", "Ask who works on what"],
    },
    framing: "You are the assistant for a person's work graph: their projects, teams, organisations, decisions and the people they work with.",
  },

  partner: {
    kind: "partner",
    describeExample: "We want to go back to the cabin in Skagen for our anniversary; Mette wishes for a new bike.",
    noun: "graph for the two of you",
    builtins: { kinds: { person: ["partner", "parent", "sibling", "in_law", "close_friend", "friend", "other"], place: ["home", "family_home", "holiday_place"], event: ["birthday", "trip", "milestone", "decision", "purchase"], topic: ["finances", "household", "health"] }, relationCategories: ["family", "social", "place", "time", "document", "other"] },
    kinds: [
      { nodeType: "event", key: "anniversary", label: "Anniversary", pluralLabel: "Anniversaries", icon: "heart" },
      { nodeType: "event", key: "date_night", label: "Date", pluralLabel: "Dates", icon: "heart" },
      { nodeType: "place", key: "favourite_place", label: "Favourite place", pluralLabel: "Favourite places", circle: "places", icon: "map-pin", description: "Restaurants, walks and places you return to." },
      { nodeType: "thing", key: "wish", label: "Wish", pluralLabel: "Wishes", icon: "gift", description: "Gift ideas and things one of you would like." },
      { nodeType: "project", key: "plan", label: "Plan", pluralLabel: "Plans", icon: "flag", description: "Something you plan together: a move, a trip, a renovation." },
    ],
    relations: [
      { key: "wishes_for", label: "wishes for", inverseLabel: "wished for by", category: "social", fromTypes: PP, toTypes: ["thing", "place", "event"] },
      { key: "likes", label: "likes", inverseLabel: "liked by", category: "social", fromTypes: PP, toTypes: ANY },
      { key: "plans", label: "plans", inverseLabel: "planned by", category: "time", fromTypes: PP, toTypes: ["project", "event"] },
    ],
    attributes: [{ nodeType: "place", kindKey: "favourite_place", key: "what_we_like", label: "What we like there", dataType: "longtext" }],
    circles: [
      { key: "us", label: "Us", hint: "The two of you." },
      { key: "friends", label: "Friends", hint: "Your friends, together and separately." },
      { key: "family", label: "Family", hint: "Both your families." },
      { key: "places", label: "Places", hint: "Places that matter to you." },
    ],
    circleOf: { partner: "us", close_friend: "friends", friend: "friends", parent: "family", sibling: "family", in_law: "family" },
    today: ["quick_actions", "week", "brief", "reminders", "waiting", "recent", "ready"],
    prompts: ["When is our anniversary?", "What did she say she wanted for her birthday?", "Which restaurants have we liked?"],
    onboarding: {
      title: "A graph for the two of you",
      lead: "Plans, wishes, dates and the places you love, shared between the two of you.",
      firstSteps: ["Add your partner", "Write down a plan or a wish", "Ask what is coming up for you two"],
    },
    framing: "You are the assistant for a couple's shared graph: their plans, wishes, dates, places and the people around them.",
  },

  project: {
    kind: "project",
    describeExample: "The migration workstream delivers the data model; the main risk is the supplier contract.",
    noun: "project graph",
    builtins: { kinds: { person: ["colleague", "manager", "other"], event: ["decision", "milestone"], place: [], topic: [] }, relationCategories: ["work", "time", "document"] },
    kinds: [
      ...GENERIC_KINDS,
      { nodeType: "project", key: "workstream", label: "Workstream", pluralLabel: "Workstreams", icon: "git-branch" },
      { nodeType: "thing", key: "deliverable", label: "Deliverable", pluralLabel: "Deliverables", icon: "package" },
      { nodeType: "thing", key: "risk", label: "Risk", pluralLabel: "Risks", icon: "alert-triangle" },
      { nodeType: "event", key: "meeting", label: "Meeting", pluralLabel: "Meetings", icon: "calendar" },
      { nodeType: "event", key: "deadline", label: "Deadline", pluralLabel: "Deadlines", icon: "flag" },
    ],
    relations: [...WORK_RELATIONS, { key: "delivers", label: "delivers", inverseLabel: "delivered by", category: "work", fromTypes: ["person", "organization", "project"], toTypes: ["thing"] }],
    attributes: [
      { nodeType: "thing", kindKey: "risk", key: "likelihood", label: "Likelihood", dataType: "enum", options: ["Low", "Medium", "High"] },
      { nodeType: "thing", kindKey: "deliverable", key: "due", label: "Due", dataType: "date" },
    ],
    circles: [
      { key: "team", label: "Team", hint: "Everyone working on the project." },
      { key: "stakeholders", label: "Stakeholders", hint: "Who the project is for, and who decides." },
      { key: "suppliers", label: "Suppliers", hint: "Partners and suppliers." },
    ],
    circleOf: { colleague: "team", manager: "stakeholders", other: "stakeholders" },
    today: ["quick_actions", "brief", "reminders", "waiting", "attention", "recent", "ready"],
    prompts: ["What are the open risks?", "Which deliverables are due this month?", "What did we decide about the scope?"],
    onboarding: {
      title: "Your project graph",
      lead: "One project: its workstreams, people, decisions, risks and deliverables.",
      firstSteps: ["Describe the project in a few sentences", "Upload the project plan", "Ask what is due next"],
    },
    framing: "You are the assistant for a project's graph: its workstreams, people, decisions, risks and deliverables.",
  },

  shared: {
    kind: "shared",
    describeExample: "The association meets in the community hall; Ida leads the garden group.",
    noun: "shared graph",
    builtins: { kinds: { person: ["close_friend", "friend", "other"], place: "*", event: "*", topic: "*" }, relationCategories: ["social", "place", "time", "document", "other"] },
    kinds: [...GENERIC_KINDS],
    relations: [WORK_RELATIONS[1]],
    attributes: [],
    circles: [
      { key: "close", label: "Close", hint: "The people this graph is about." },
      { key: "social", label: "Friends", hint: "Friends and acquaintances." },
      { key: "other", label: "Others", hint: "Everyone else." },
    ],
    circleOf: {},
    today: ["quick_actions", "brief", "reminders", "waiting", "recent", "ready"],
    prompts: ["What did we write down last time?", "Who is involved in this?"],
    onboarding: {
      title: "A shared graph",
      lead: "Shared with the people you invite, and nothing from your other graphs.",
      firstSteps: ["Invite the people it is for", "Add what you want to keep together", "Ask what has changed"],
    },
    framing: "You are the assistant for a graph shared between a few people: what they keep together and the people and things in it.",
  },

  other: {
    kind: "other",
    describeExample: "Describe how the things in this graph fit together…",
    noun: "graph",
    builtins: { kinds: { person: ["friend", "colleague", "other"], place: "*", event: "*", topic: "*" }, relationCategories: ["social", "work", "place", "time", "document", "other"] },
    kinds: [...GENERIC_KINDS],
    relations: [WORK_RELATIONS[0], WORK_RELATIONS[1], WORK_RELATIONS[2]],
    attributes: [],
    circles: [
      { key: "close", label: "Close", hint: "The people closest to this." },
      { key: "work", label: "Work", hint: "People from work." },
      { key: "other", label: "Others", hint: "Everyone else." },
    ],
    circleOf: {},
    today: ["quick_actions", "brief", "reminders", "waiting", "recent", "ready"],
    prompts: ["What do I know about this?", "What changed this week?"],
    onboarding: {
      title: "Your graph",
      lead: "Starts almost empty and learns the kinds of things it holds from what you add.",
      firstSteps: ["Describe what this graph is for", "Add a few things", "Ask a question"],
    },
    framing: "You are the assistant for a private knowledge graph: the people, things and facts its owner keeps in it.",
  },

  practice: PRACTICE,
};

export function isTemplateKind(k: unknown): k is GraphTemplateKind {
  return typeof k === "string" && (GRAPH_TEMPLATE_KINDS as string[]).includes(k);
}

/** The template for a graph kind; unknown kinds get the generic one. */
export function getTemplate(kind: string | null | undefined): GraphTemplate {
  return isTemplateKind(kind) ? TEMPLATES[kind] : TEMPLATES.other;
}

/** Does a template keep this built-in? */
export function keepsBuiltin(t: GraphTemplate, table: "kinds" | "relations" | "attributes",
  row: { key: string; nodeType?: string; kindKey?: string | null; category?: string }): boolean {
  const b = t.builtins;
  if (b === "all") return true;
  if (table === "kinds") {
    const keys = b.kinds[row.nodeType as MetaNodeType];
    if (keys === undefined) return true; // node types the template doesn't mention keep their built-ins
    return keys === "*" || keys.includes(row.key);
  }
  if (table === "relations") return b.relationCategories.includes(row.category ?? "other") || (b.relations ?? []).includes(row.key);
  if (b.dropAttributes?.includes(row.key)) return false;
  // Kind-specific attributes follow their kind.
  if (row.kindKey) return keepsBuiltin(t, "kinds", { nodeType: row.nodeType, key: row.kindKey });
  return true;
}

/**
 * Merge a template over the household's existing rows: which of the template's kinds/relations/attributes are missing
 * and need seeding. A row with the same key that is already there (built-in, household-wide or this graph's) wins, so
 * a household's own "Team" is never duplicated.
 */
export function missingFromTemplate(t: GraphTemplate, have: { kinds: { nodeType: string; key: string }[]; relations: { key: string }[]; attributes: { nodeType: string; kindKey: string | null; key: string }[] }) {
  const kk = new Set(have.kinds.map((k) => `${k.nodeType}:${k.key}`));
  const rk = new Set(have.relations.map((r) => r.key));
  const ak = new Set(have.attributes.map((a) => `${a.nodeType}:${a.kindKey ?? "*"}:${a.key}`));
  return {
    kinds: t.kinds.filter((k) => !kk.has(`${k.nodeType}:${k.key}`)),
    relations: t.relations.filter((r) => !rk.has(r.key)),
    attributes: t.attributes.filter((a) => !ak.has(`${a.nodeType}:${a.kindKey ?? "*"}:${a.key}`)),
  };
}

/** Circle labels a graph uses (its template's), falling back to the key. */
export function circleLabel(t: GraphTemplate, key: string | null | undefined): string {
  return t.circles.find((c) => c.key === key)?.label ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Others");
}
