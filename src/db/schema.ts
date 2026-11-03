import {
  pgTable, pgEnum, uuid, text, timestamp, integer, real, boolean, jsonb, index, uniqueIndex, vector, customType,
} from "drizzle-orm/pg-core";

/**
 * My Graph's data model. Content lives in graphs (see `graphs`): every content row carries a `graphId`, and a
 * viewer only ever reads the graph they are working in, and only while they are a member of it. Within a graph,
 * every item has an `ownerId` (who added it) and a `visibility` deciding who else in that graph may see it.
 * In the household's family graph:
 *   private   — only the owner
 *   parents   — the owner + every parent/owner in the household
 *   household — everyone in the household (children included)
 * Guests only see items explicitly shared to them through `shares`.
 * In any other graph, "household" means every member of that graph and "parents" its owner and editors.
 * Rule: no fact (edge) or node may exist without at least one `provenance` row.
 */

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const roleEnum = pgEnum("role", ["owner", "parent", "child", "guest"]);
export const visibilityEnum = pgEnum("visibility", ["private", "parents", "household"]);
export const nodeTypeEnum = pgEnum("node_type", ["person", "place", "event", "topic", "document", "source"]);
export const timePrecisionEnum = pgEnum("time_precision", ["minute", "day", "month", "year"]);
export const edgeStatusEnum = pgEnum("edge_status", ["confirmed", "unconfirmed", "inferred", "rejected", "superseded"]);
export const sourceKindEnum = pgEnum("source_kind", ["upload", "wiki", "chat", "manual", "sync"]);
export const sourceStatusEnum = pgEnum("source_status", ["pending", "processing", "ready", "failed"]);
export const activityEnum = pgEnum("activity", ["upload", "ocr", "transcription", "llm_extraction", "manual_edit", "inference", "import"]);
export const agentTypeEnum = pgEnum("agent_type", ["user", "model", "rule"]);
export const subjectTypeEnum = pgEnum("subject_type", ["node", "edge"]);
export const authorKindEnum = pgEnum("author_kind", ["user", "assistant"]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system"]);
export const graphKindEnum = pgEnum("graph_kind", ["family", "personal", "work", "shared", "other"]);
export const graphRoleEnum = pgEnum("graph_role", ["owner", "editor", "viewer"]);

/* ── Accounts ─────────────────────────────────────────────────────────────────────────────────────────── */

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  passwordHash: text("password_hash"),
  totpSecret: text("totp_secret"),
  birthYear: integer("birth_year"),
  /** Guest access ends at this time. */
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  /** The user's own person node in their brain. */
  personNodeId: uuid("person_node_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  /** A new device needs a parent's approval before the session works (children and guests). */
  approved: boolean("approved").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash)]);

export const passkeys = pgTable("passkeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports").array(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("passkeys_credential_idx").on(t.credentialId)]);

/** Short-lived WebAuthn challenges. */
export const authChallenges = pgTable("auth_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  challenge: text("challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_household_at_idx").on(t.householdId, t.at)]);

/* ── Graphs: separate brains a person owns and shares ─────────────────────────────────────────────────── */

/**
 * A graph is one separate brain. Every content row (nodes, edges, sources, chunks, provenance, wiki pages,
 * conversations, reminders, observations) belongs to exactly one graph, and nothing ever connects two graphs.
 * Each household has one `family` graph (all household members, family rules); a person can own more graphs
 * (personal, work, one built for someone) and share them with specific people through `graph_members`.
 * `householdId` is the owner's household: its meta model is the graph's ontology.
 */
export const graphs = pgTable("graphs", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  /** Hue (0-359) for the graph's colour dot. */
  color: integer("color").notNull().default(210),
  kind: graphKindEnum("kind").notNull().default("other"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  index("graphs_household_idx").on(t.householdId),
  index("graphs_owner_idx").on(t.ownerId),
]);

export const graphMembers = pgTable("graph_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: graphRoleEnum("role").notNull(),
  addedBy: uuid("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("graph_members_graph_user_idx").on(t.graphId, t.userId),
  index("graph_members_user_idx").on(t.userId),
]);

/** An invitation link to join a graph. The link carries a random token; only sha256(token) is stored. */
export const graphInvites = pgTable("graph_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: graphRoleEnum("role").notNull().default("editor"),
  tokenHash: text("token_hash").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("graph_invites_token_idx").on(t.tokenHash),
  index("graph_invites_graph_idx").on(t.graphId),
]);

/* ── GBrain: the per-login knowledge graph ────────────────────────────────────────────────────────────── */

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: nodeTypeEnum("type").notNull(),
  /** Meta-model kind within the type (meta_kinds.key), e.g. person → "teacher", place → "school". */
  kind: text("kind"),
  label: text("label").notNull(),
  aliases: text("aliases").array().notNull().default([]),
  summary: text("summary"),
  props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
  /** Events (and anything placed in time) — drives the timeline. */
  startAt: timestamp("start_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  timePrecision: timePrecisionEnum("time_precision"),
  visibility: visibilityEnum("visibility").notNull().default("private"),
  /** Health, finance, legal: forces local-only models in mux and parents-only by default. */
  sensitive: boolean("sensitive").notNull().default(false),
  /** Set when entity resolution merged this node into another. */
  mergedInto: uuid("merged_into"),
  embedding: vector("embedding", { dimensions: 1024 }),
  search: tsvector("search"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("nodes_owner_type_idx").on(t.ownerId, t.type),
  index("nodes_household_start_idx").on(t.householdId, t.startAt),
  index("nodes_graph_type_idx").on(t.graphId, t.type),
  index("nodes_graph_start_idx").on(t.graphId, t.startAt),
]);

export const edges = pgTable("edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fromId: uuid("from_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  toId: uuid("to_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  /** snake_case verb: parent_of, attends, treated_by, knows, located_at, happened_at, involves, follows, caused_by, about, tagged_with, mentions, derived_from, version_of, supports */
  relation: text("relation").notNull(),
  props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  confidence: real("confidence").notNull().default(1),
  status: edgeStatusEnum("status").notNull().default("unconfirmed"),
  supersededBy: uuid("superseded_by"),
  visibility: visibilityEnum("visibility").notNull().default("private"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("edges_from_idx").on(t.fromId), index("edges_to_idx").on(t.toId), index("edges_graph_idx").on(t.graphId)]);

/** Original artefacts: uploaded files, wiki pages, chat messages, manual entries. Stored unchanged. */
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: sourceKindEnum("kind").notNull(),
  title: text("title").notNull(),
  mime: text("mime"),
  /** Path under UPLOAD_DIR (content-addressed: <sha256>). */
  storageKey: text("storage_key"),
  sha256: text("sha256"),
  size: integer("size"),
  textContent: text("text_content"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  status: sourceStatusEnum("status").notNull().default("pending"),
  error: text("error"),
  visibility: visibilityEnum("visibility").notNull().default("private"),
  sensitive: boolean("sensitive").notNull().default(false),
  /** The source's own document node in the graph. */
  nodeId: uuid("node_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sources_owner_idx").on(t.ownerId, t.createdAt), index("sources_graph_idx").on(t.graphId, t.createdAt)]);

/** Text chunks of a source for retrieval; locator points back into the source (page, offsets, bbox, time). */
export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull(),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  locator: jsonb("locator").$type<Locator>().notNull().default({}),
  embedding: vector("embedding", { dimensions: 1024 }),
  search: tsvector("search"),
}, (t) => [index("chunks_source_idx").on(t.sourceId), index("chunks_graph_idx").on(t.graphId)]);

export type Locator = { page?: number; charStart?: number; charEnd?: number; bbox?: [number, number, number, number]; timeStartSec?: number; timeEndSec?: number };

/** W3C PROV-style record: why we believe a node or edge. */
export const provenance = pgTable("provenance", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  subjectType: subjectTypeEnum("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  chunkId: uuid("chunk_id"),
  locator: jsonb("locator").$type<Locator>().notNull().default({}),
  /** The exact passage the fact was read from. */
  quote: text("quote"),
  activity: activityEnum("activity").notNull(),
  agentType: agentTypeEnum("agent_type").notNull(),
  /** user id, "mux:<model>" or rule name */
  agentId: text("agent_id").notNull(),
  confidence: real("confidence").notNull().default(1),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("provenance_subject_idx").on(t.subjectType, t.subjectId), index("provenance_graph_idx").on(t.graphId)]);

/** Explicit share of a node to a user (guests, or a private item shown to one person). */
export const shares = pgTable("shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canEdit: boolean("can_edit").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── Wiki ─────────────────────────────────────────────────────────────────────────────────────────────── */

export const wikiPages = pgTable("wiki_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  /** TipTap JSON document. */
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  contentText: text("content_text").notNull().default(""),
  /** The page's document node in the graph (its mentions become edges). */
  nodeId: uuid("node_id"),
  /** The page's source row (so facts read from it carry provenance). */
  sourceId: uuid("source_id"),
  visibility: visibilityEnum("visibility").notNull().default("private"),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("wiki_graph_slug_idx").on(t.graphId, t.slug)]);

export const wikiRevisions = pgTable("wiki_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  contentText: text("content_text").notNull().default(""),
  authorId: uuid("author_id"),
  authorKind: authorKindEnum("author_kind").notNull(),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── Assistant ────────────────────────────────────────────────────────────────────────────────────────── */

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New conversation"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("conversations_graph_user_idx").on(t.graphId, t.userId)]);

export type Citation = { n: number; sourceId?: string; nodeId?: string; edgeId?: string; title: string; quote?: string; locator?: Locator; confidence?: number };

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
  /** mux response headers: x-mux-model / x-mux-route / x-mux-request-id */
  model: text("model"),
  route: text("route"),
  muxRequestId: text("mux_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reminders = pgTable("reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The person the reminder is about (e.g. a child's person node). */
  aboutNodeId: uuid("about_node_id"),
  /** The event or document that caused it. */
  nodeId: uuid("node_id"),
  sourceId: uuid("source_id"),
  title: text("title").notNull(),
  detail: text("detail"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  done: boolean("done").notNull().default(false),
  createdByKind: authorKindEnum("created_by_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("reminders_owner_due_idx").on(t.ownerId, t.dueAt), index("reminders_graph_due_idx").on(t.graphId, t.dueAt)]);

/* ── Meta model: the household's own ontology on top of the graph ─────────────────────────────────────── */

export const attrTypeEnum = pgEnum("attr_type", ["text", "longtext", "date", "number", "boolean", "enum", "email", "phone", "url"]);

/** Kinds within a node type (person → family, friend, teacher, doctor …). householdId null = built-in default. */
export const metaKinds = pgTable("meta_kinds", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
  nodeType: nodeTypeEnum("node_type").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  pluralLabel: text("plural_label"),
  description: text("description"),
  /** Circle on the people overview: family · close · social · school · care · work · other */
  circle: text("circle"),
  parentKey: text("parent_key"),
  icon: text("icon"),
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("meta_kinds_key_idx").on(t.householdId, t.nodeType, t.key)]);

/** Relation types: the allowed edge.relation values, with labels both ways. */
export const metaRelations = pgTable("meta_relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  inverseLabel: text("inverse_label").notNull(),
  /** family · social · care · school · work · place · time · document · other */
  category: text("category").notNull().default("other"),
  fromTypes: text("from_types").array().notNull().default([]),
  toTypes: text("to_types").array().notNull().default([]),
  symmetric: boolean("symmetric").notNull().default(false),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("meta_relations_key_idx").on(t.householdId, t.key)]);

/** Attributes a node type or kind carries (stored in nodes.props[key]). kindKey null = every node of nodeType. */
export const metaAttributes = pgTable("meta_attributes", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
  nodeType: nodeTypeEnum("node_type").notNull(),
  kindKey: text("kind_key"),
  key: text("key").notNull(),
  label: text("label").notNull(),
  dataType: attrTypeEnum("data_type").notNull().default("text"),
  options: text("options").array().notNull().default([]),
  required: boolean("required").notNull().default(false),
  /** Sensitive attributes are parents-only and stay on local models. */
  sensitive: boolean("sensitive").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("meta_attributes_key_idx").on(t.householdId, t.nodeType, t.kindKey, t.key)]);

/* ── People: how they are, over time ──────────────────────────────────────────────────────────────────── */

export const observationKindEnum = pgEnum("observation_kind", ["wellbeing", "health", "milestone", "contact", "note"]);

/** A dated check-in about a person: how they are, a milestone, a contact moment. */
export const observations = pgTable("observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  personNodeId: uuid("person_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  kind: observationKindEnum("kind").notNull(),
  /** Wellbeing 1 (struggling) … 5 (thriving); null for other kinds. */
  score: integer("score"),
  note: text("note"),
  tags: text("tags").array().notNull().default([]),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  authorKind: authorKindEnum("author_kind").notNull().default("user"),
  visibility: visibilityEnum("visibility").notNull().default("private"),
  sensitive: boolean("sensitive").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("observations_person_at_idx").on(t.personNodeId, t.at), index("observations_graph_idx").on(t.graphId)]);
