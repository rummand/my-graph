import {
  pgTable, pgEnum, uuid, text, timestamp, integer, real, boolean, jsonb, index, uniqueIndex, unique, vector, customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
export const nodeTypeEnum = pgEnum("node_type", ["person", "place", "event", "topic", "document", "source", "organization", "project", "thing"]);
export const timePrecisionEnum = pgEnum("time_precision", ["minute", "day", "month", "year"]);
export const edgeStatusEnum = pgEnum("edge_status", ["confirmed", "unconfirmed", "inferred", "rejected", "superseded"]);
export const sourceKindEnum = pgEnum("source_kind", ["upload", "wiki", "chat", "manual", "sync", "web", "email", "connector"]);
export const sourceStatusEnum = pgEnum("source_status", ["pending", "processing", "ready", "failed"]);
export const activityEnum = pgEnum("activity", ["upload", "ocr", "transcription", "llm_extraction", "manual_edit", "inference", "import"]);
export const agentTypeEnum = pgEnum("agent_type", ["user", "model", "rule"]);
export const subjectTypeEnum = pgEnum("subject_type", ["node", "edge"]);
export const authorKindEnum = pgEnum("author_kind", ["user", "assistant"]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system"]);
export const graphKindEnum = pgEnum("graph_kind", ["family", "personal", "work", "shared", "other", "partner", "project"]);
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
  /** Interface language: "en" | "da". */
  locale: text("locale").notNull().default("en"),
  /** "system" | "light" | "dark" */
  theme: text("theme").notNull().default("system"),
  timeZone: text("time_zone").notNull().default("Europe/Copenhagen"),
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
  /** When the document itself is dated (letter date, email sent, photo taken, scan date), not when it was uploaded. */
  documentDate: timestamp("document_date", { withTimezone: true }),
  documentDatePrecision: text("document_date_precision"),
  /** Groups correspondence: an email thread (Message-ID/References root), an Aula thread, a letter exchange. */
  threadKey: text("thread_key"),
  /** Where it came from outside: a web page URL, a connector item id. */
  url: text("url"),
  externalId: text("external_id"),
  connectionId: uuid("connection_id"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sources_thread_idx").on(t.graphId, t.threadKey), index("sources_docdate_idx").on(t.graphId, t.documentDate), index("sources_owner_idx").on(t.ownerId, t.createdAt), index("sources_graph_idx").on(t.graphId, t.createdAt)]);

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
  /** Inbox-style controls (Scout): pinned to the top, flagged to revisit. */
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  unreadAt: timestamp("unread_at", { withTimezone: true }),
  /** Highest visibility level touched in this chat: normal, parents or private. Raised, never lowered. */
  sensitivity: text("sensitivity").notNull().default("normal"),
  /** Summary of earlier turns after "compact this conversation". */
  summary: text("summary"),
  summaryUpToMessageId: uuid("summary_up_to_message_id"),
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
  /** What the assistant did while answering, shown as "Searched the library, read 3 letters …". */
  steps: jsonb("steps").$type<AssistantStep[]>().notNull().default([]),
  thoughtMs: integer("thought_ms"),
  /** A clarifying question with preset choices (the user may also type, or skip). */
  clarify: jsonb("clarify").$type<{ question: string; choices: string[] } | null>(),
  /** Thumbs up (1) or down (-1) from the person who asked. */
  feedback: integer("feedback"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AssistantStep = { kind: "search" | "read" | "timeline" | "people" | "memory" | "think" | "write" | "other"; label: string; count?: number; ms?: number; /** A change set this step proposed (shown as a link). */ changeSetId?: string };

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
  /** Emergent meta model: candidate (proposed from evidence) | active | hidden. */
  status: text("status").notNull().default("active"),
  /** builtin | template | manual | emergent */
  origin: text("origin").notNull().default("manual"),
  /** Set when the element belongs to one graph only (e.g. a Work graph's "Department"); null = whole household. */
  graphId: uuid("graph_id"),
  evidenceCount: integer("evidence_count").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  changeSetId: uuid("change_set_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("meta_kinds_graph_key_uq").on(t.householdId, t.graphId, t.nodeType, t.key).nullsNotDistinct()]);

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
  /** Emergent meta model: candidate (proposed from evidence) | active | hidden. */
  status: text("status").notNull().default("active"),
  /** builtin | template | manual | emergent */
  origin: text("origin").notNull().default("manual"),
  /** Set when the element belongs to one graph only (e.g. a Work graph's "Department"); null = whole household. */
  graphId: uuid("graph_id"),
  evidenceCount: integer("evidence_count").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  changeSetId: uuid("change_set_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("meta_relations_graph_key_uq").on(t.householdId, t.graphId, t.key).nullsNotDistinct()]);

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
  /** Emergent meta model: candidate (proposed from evidence) | active | hidden. */
  status: text("status").notNull().default("active"),
  /** builtin | template | manual | emergent */
  origin: text("origin").notNull().default("manual"),
  /** Set when the element belongs to one graph only (e.g. a Work graph's "Department"); null = whole household. */
  graphId: uuid("graph_id"),
  evidenceCount: integer("evidence_count").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  changeSetId: uuid("change_set_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("meta_attributes_graph_key_uq").on(t.householdId, t.graphId, t.nodeType, t.kindKey, t.key).nullsNotDistinct()]);

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


/* ── Always-on assistant (inspired by Microsoft Scout, see docs/scout-research.md) ───────────────────────── */

export const memoryKindEnum = pgEnum("memory_kind", ["preference", "rule", "fact", "note"]);
export const memoryOriginEnum = pgEnum("memory_origin", ["chat", "upload", "external", "manual", "automation"]);
export const memoryStatusEnum = pgEnum("memory_status", ["active", "pending", "paused"]);

/** What the assistant remembers in a graph: preferences, family rules and notes, each with where it came from. */
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** Who added it, or on whose chat it was learned. */
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: memoryKindEnum("kind").notNull(),
  text: text("text").notNull(),
  /** Person/place/topic nodes it is about, e.g. a rule that only applies to Emma. */
  aboutNodeIds: jsonb("about_node_ids").$type<string[]>().notNull().default([]),
  origin: memoryOriginEnum("origin").notNull(),
  /** Where it came from: a conversation/message, a source document, an automation run. */
  conversationId: uuid("conversation_id"),
  messageId: uuid("message_id"),
  sourceId: uuid("source_id"),
  runId: uuid("run_id"),
  quote: text("quote"),
  confidence: real("confidence").notNull().default(1),
  /** pending = learned from outside content, waits for a person to confirm before it is used. */
  status: memoryStatusEnum("status").notNull().default("active"),
  visibility: visibilityEnum("visibility").notNull().default("household"),
  createdByKind: authorKindEnum("created_by_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => [index("memories_graph_idx").on(t.graphId, t.status)]);

export const triggerKindEnum = pgEnum("trigger_kind", ["schedule", "condition", "heartbeat"]);
export const runStatusEnum = pgEnum("run_status", ["running", "done", "failed", "skipped"]);

/** Saved prompts the family writes ("Weekly family summary"), usable in chat, on Today, or in an automation. */
export const recipes = pgTable("recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  prompt: text("prompt").notNull(),
  visibility: visibilityEnum("visibility").notNull().default("household"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("recipes_graph_idx").on(t.graphId)]);

/** Work the assistant does on its own: a schedule, a condition it checks, or the Heartbeat check-in. */
export const automations = pgTable("automations", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** Runs as this person: it sees exactly what they may see in the graph, never more. */
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  recipeId: uuid("recipe_id"),
  trigger: triggerKindEnum("trigger").notNull(),
  /** schedule: { days: [0-6], time: "HH:MM", tz }  condition: { check: string, everyMinutes }  heartbeat: { everyMinutes, days, from, to, tz } */
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  oneShot: boolean("one_shot").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("automations_due_idx").on(t.enabled, t.nextRunAt), index("automations_graph_idx").on(t.graphId)]);

export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  status: runStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** One plain sentence: what it found and did. */
  summary: text("summary"),
  output: text("output"),
  citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
  steps: jsonb("steps").$type<AssistantStep[]>().notNull().default([]),
  /** Steps that would have needed approval and were skipped because nobody was watching. */
  skipped: jsonb("skipped").$type<string[]>().notNull().default([]),
  suggestionCount: integer("suggestion_count").notNull().default(0),
  error: text("error"),
}, (t) => [index("automation_runs_automation_idx").on(t.automationId, t.startedAt)]);

export const suggestionKindEnum = pgEnum("suggestion_kind", ["fact", "reminder", "merge", "rule", "memory", "wiki_edit", "nudge"]);
export const suggestionStatusEnum = pgEnum("suggestion_status", ["pending", "approved", "denied", "expired"]);

/** The assistant's proposals waiting for a person: approve, always allow, or deny. */
export const suggestions = pgTable("suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** Who should decide. */
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: suggestionKindEnum("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  /** Exactly what would be written if approved (shown as the preview). */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
  origin: text("origin").notNull(), // "chat" | "automation" | "heartbeat" | "ingest"
  runId: uuid("run_id"),
  conversationId: uuid("conversation_id"),
  /** Same key = same suggestion; used to avoid repeating one the person already denied. */
  dedupeKey: text("dedupe_key"),
  status: suggestionStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: uuid("decided_by"),
}, (t) => [index("suggestions_inbox_idx").on(t.graphId, t.userId, t.status), index("suggestions_dedupe_idx").on(t.graphId, t.dedupeKey)]);

/** Everything the assistant did, and when (Scout's Heartbeat log), per graph. */
export const assistantActivity = pgTable("assistant_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** The person it acted for. */
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  actor: text("actor").notNull(), // "chat" | "automation" | "heartbeat" | "ingest" | "wiki"
  action: text("action").notNull(), // e.g. "suggested_reminder", "saved_memory", "ran_automation", "edited_wiki"
  summary: text("summary").notNull(),
  subjectType: text("subject_type"),
  subjectId: uuid("subject_id"),
  runId: uuid("run_id"),
  conversationId: uuid("conversation_id"),
  visibility: visibilityEnum("visibility").notNull().default("household"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("assistant_activity_graph_idx").on(t.graphId, t.createdAt)]);

/** Per person, per graph: what the assistant may do and how it behaves. Defaults are deliberately conservative. */
export const assistantSettings = pgTable("assistant_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Save memories it learns in chat without asking (facts still always need approval). */
  autoSaveMemories: boolean("auto_save_memories").notNull().default(true),
  /** Kinds of action the person chose "Always allow" for, e.g. "reminder.create", "memory.save". */
  alwaysAllow: jsonb("always_allow").$type<string[]>().notNull().default([]),
  /** Capabilities the assistant may use at all: library, timeline, people, wiki_write, reminders. Off = tool removed. */
  capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull().default({}),
  /** "warm" | "brief" | "detailed" */
  tone: text("tone").notNull().default("warm"),
  /** Max proactive suggestions per day (avoid nagging). */
  dailySuggestionCap: integer("daily_suggestion_cap").notNull().default(5),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("assistant_settings_graph_user_uq").on(t.graphId, t.userId)]);

/** A recipe run started by hand ("Run" on a recipe), outside any automation. Same shape as automation_runs. */
export const recipeRuns = pgTable("recipe_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** Who ran it (it ran as them). */
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: runStatusEnum("status").notNull().default("running"),
  /** The prompt as run, with its fill-ins. */
  prompt: text("prompt").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  summary: text("summary"),
  output: text("output"),
  citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
  steps: jsonb("steps").$type<AssistantStep[]>().notNull().default([]),
  skipped: jsonb("skipped").$type<string[]>().notNull().default([]),
  suggestionCount: integer("suggestion_count").notNull().default(0),
  error: text("error"),
}, (t) => [index("recipe_runs_graph_user_idx").on(t.graphId, t.userId, t.startedAt)]);


/* ── Versioning: the graph works like a git repo (see docs/versioning-plan.md, after Nexus) ───────────── */

export const changeSetStatusEnum = pgEnum("change_set_status", ["draft", "delivered", "abandoned"]);

/** A branch: proposed changes that don't touch the graph until a person delivers (merges) them. */
export const changeSets = pgTable("change_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: changeSetStatusEnum("status").notNull().default("draft"),
  /** person | assistant | chat | connector | web | ingest | automation | heartbeat | restore */
  origin: text("origin").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  /** Who it is waiting for (null = anyone who may write in the graph). */
  forUserId: uuid("for_user_id"),
  /** The moment of the graph it was cut from. */
  baseAt: timestamp("base_at", { withTimezone: true }).notNull().defaultNow(),
  /** Evidence and provenance for the whole set: conversation, message, source, run, quote. */
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  /** Hash of the ops; an approval with an older fingerprint is stale. */
  fingerprint: text("fingerprint"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deliveredBy: uuid("delivered_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("change_sets_graph_idx").on(t.graphId, t.status, t.createdAt)]);

/** One op on a change set (a commit-sized unit). Node ids for new nodes are minted when the op is written. */
export const changes = pgTable("changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeSetId: uuid("change_set_id").notNull().references(() => changeSets.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  /** addNode | updateNode | retireNode | mergeNodes | addEdge | updateEdge | removeEdge | addKind | addRelationType | addAttribute | updateMeta | addReminder | addMemory | editWiki */
  op: text("op").notNull(),
  nodeId: uuid("node_id"),
  edgeId: uuid("edge_id"),
  subject: text("subject"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  /** Why, in one sentence. */
  note: text("note"),
  /** Evidence for this op: { sourceId, chunkId, locator, quote, url, messageId, confidence }. */
  receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull().default({}),
  /** included = will be delivered; excluded = the person unticked it. */
  included: boolean("included").notNull().default(true),
  authorKind: text("author_kind").notNull(), // person | assistant | connector | system
  authorId: uuid("author_id"),
  authorName: text("author_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("changes_set_idx").on(t.changeSetId, t.seq)]);

/** The history log: one row per field that moved on a node or edge (or meta element), observed at write time. */
export const graphEvents = pgTable("graph_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** node | edge | meta | wiki | source */
  subjectType: text("subject_type").notNull(),
  /** No FK on purpose: history outlives deletes. */
  subjectId: uuid("subject_id").notNull(),
  subjectName: text("subject_name"),
  /** created | updated | retired | restored | merged | added | removed */
  kind: text("kind").notNull(),
  field: text("field"),
  fromValue: jsonb("from_value"),
  toValue: jsonb("to_value"),
  /** For edges: both ends, so edges can be rewound too. */
  fromNodeId: uuid("from_node_id"),
  toNodeId: uuid("to_node_id"),
  actorKind: text("actor_kind").notNull(), // person | assistant | connector | import | system
  actorId: uuid("actor_id"),
  actorName: text("actor_name"),
  changeSetId: uuid("change_set_id"),
  context: text("context"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("graph_events_graph_at_idx").on(t.graphId, t.at), index("graph_events_subject_idx").on(t.subjectId, t.at)]);

/** A named moment (a tag). Restoring one creates a change set; history is never rewritten. */
export const checkpoints = pgTable("checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("checkpoints_graph_idx").on(t.graphId, t.at)]);

/* ── @mentions everywhere ───────────────────────────────────────────────────────────────────────────── */

/** Where a node is mentioned: a chat message, wiki page, reminder, memory, automation, recipe, note. */
export const mentions = pgTable("mentions", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull(),
  /** message | wiki | reminder | memory | automation | recipe | note | change_set */
  inType: text("in_type").notNull(),
  inId: uuid("in_id").notNull(),
  /** The text as written ("@EAM Platform"), for display if the node is later renamed. */
  label: text("label"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("mentions_node_idx").on(t.graphId, t.nodeId), uniqueIndex("mentions_in_uq").on(t.inType, t.inId, t.nodeId)]);

/* ── Connectors (see the Aula and connectors proposal) ─────────────────────────────────────────────── */

/** One connection: a person's account at a source, feeding one graph. */
export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Connector id from its manifest: "ics", "imap", "aula_calendar", "aula", "folder" … */
  connector: text("connector").notNull(),
  label: text("label").notNull(),
  /** Non-secret settings (host, folder names, ICS URL is a secret). */
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  /** Encrypted secrets (AES-256-GCM with APP key): tokens, passwords, secret URLs. Never sent to mux. */
  secrets: text("secrets"),
  /** Per-stream cursors, committed in the same transaction as what they brought in. */
  state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
  /** ok | needs_you | error | paused */
  status: text("status").notNull().default("ok"),
  statusDetail: text("status_detail"),
  everyMinutes: integer("every_minutes").notNull().default(15),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("connections_due_idx").on(t.status, t.nextRunAt), index("connections_graph_idx").on(t.graphId)]);

export const connectionRuns = pgTable("connection_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectionId: uuid("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  status: runStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** { stream: { fetched, added, updated, skipped } } */
  counts: jsonb("counts").$type<Record<string, unknown>>().notNull().default({}),
  changeSetId: uuid("change_set_id"),
  error: text("error"),
}, (t) => [index("connection_runs_conn_idx").on(t.connectionId, t.startedAt)]);

/* ── The Brain Keeper (after mux's keeper): curates memory per person per graph, every write journalled ──── */

/** One keeper run for one person in one graph: what it read, what it changed (with why) and its short report. */
export const keeperRuns = pgTable("keeper_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** It runs as this person: it reads only their material and what they may see, and writes memories as theirs. */
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** schedule | person */
  trigger: text("trigger").notNull().default("schedule"),
  /** running | done | failed | skipped */
  status: text("status").notNull().default("running"),
  /** Material newer than this was read. */
  since: timestamp("since", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** { conversations, proposals, sources, activity, changeSets } */
  read: jsonb("read").$type<Record<string, number>>().notNull().default({}),
  /** The journal: every write with what, why, the memory's text before/after, and its evidence links. */
  actions: jsonb("actions").$type<Record<string, unknown>[]>().notNull().default([]),
  report: text("report"),
  model: text("model"),
  error: text("error"),
}, (t) => [
  index("keeper_runs_graph_user_idx").on(t.graphId, t.userId, t.startedAt),
  uniqueIndex("keeper_runs_one_running_uq").on(t.graphId, t.userId).where(sql`status = 'running'`),
]);

/* ── Cross-graph objects: one person (or thing) known in several graphs (workstream: cross-graph links) ─── */

/**
 * One real-world identity that has a node in more than one graph ("Anna" in Family and in For Sara). Nothing else
 * crosses graphs: each graph keeps its own node, and only a member of both graphs ever sees that they are linked.
 */
export const nodeIdentities = pgTable("node_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One graph's node in an identity. A node belongs to at most one identity. */
export const nodeIdentityMembers = pgTable("node_identity_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityId: uuid("identity_id").notNull().references(() => nodeIdentities.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** No FK: a share waiting in a change set points at the node id minted for it before the node exists. */
  nodeId: uuid("node_id").notNull(),
  /** Which fields travel to and from this node: "label", "kind", "aliases", "summary", "props.<key>". */
  shareFields: jsonb("share_fields").$type<string[]>().notNull().default([]),
  /** active | pending (shared through a change set that has not been delivered yet) */
  status: text("status").notNull().default("active"),
  changeSetId: uuid("change_set_id"),
  linkedBy: uuid("linked_by").references(() => users.id, { onDelete: "set null" }),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("node_identity_members_node_uq").on(t.nodeId),
  index("node_identity_members_identity_idx").on(t.identityId),
  index("node_identity_members_graph_idx").on(t.graphId),
]);

/* ── Design sets and artifacts: reports, one-pagers, decks, briefs and profiles made from the graph ──────── */

/**
 * A custom design set (the built-ins — My Graph, Minimal, Editorial, Corporate — live in code, src/lib/design-sets).
 * `tokens` and `templates` are validated by src/lib/design-sets; every save bumps `version` and writes a
 * design_set_versions row, so published artifacts can keep the look they were published with.
 * `graphId` null is reserved for household-wide sets; sets made in the app always belong to one graph.
 */
export const designSets = pgTable("design_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").references(() => graphs.id, { onDelete: "cascade" }),
  householdId: uuid("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  tokens: jsonb("tokens").$type<Record<string, unknown>>().notNull(),
  templates: jsonb("templates").$type<Record<string, unknown>>().notNull().default({}),
  version: integer("version").notNull().default(1),
  /** The website it was proposed from, if any. */
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [index("design_sets_graph_idx").on(t.graphId)]);

/** Every saved version of a custom design set (what a pinned artifact renders with). */
export const designSetVersions = pgTable("design_set_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  designSetId: uuid("design_set_id").notNull().references(() => designSets.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  tokens: jsonb("tokens").$type<Record<string, unknown>>().notNull(),
  templates: jsonb("templates").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("design_set_versions_uq").on(t.designSetId, t.version)]);

/** The design set a graph's new artifacts start with. `designSetId` is a built-in key ("mygraph") or a design_sets id. */
export const graphDesignDefaults = pgTable("graph_design_defaults", {
  graphId: uuid("graph_id").primaryKey().references(() => graphs.id, { onDelete: "cascade" }),
  designSetId: text("design_set_id").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An artifact made from the graph: kind report | one_pager | deck | brief | profile; status draft | published.
 * The assistant only ever writes drafts; a person publishes. `designSetVersion` is pinned at publish time and kept
 * until someone chooses "Refresh design". `content` holds structured blocks whose claims cite graph items.
 */
export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  /** private (only the owner) | parents | household (everyone in the graph), as for nodes. */
  visibility: visibilityEnum("visibility").notNull().default("private"),
  designSetId: text("design_set_id").notNull(),
  designSetVersion: integer("design_set_version").notNull().default(1),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  /** What it is about: { about: [{nodeId,label}], question, from, to, text }. */
  sourceQuery: jsonb("source_query").$type<Record<string, unknown>>().notNull().default({}),
  /** Drafted from sensitive material: model calls stay local. */
  sensitive: boolean("sensitive").notNull().default(false),
  version: integer("version").notNull().default(1),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [index("artifacts_graph_idx").on(t.graphId, t.updatedAt)]);

/** Every kept version of an artifact (saves, publishes, accepted regenerations, design refreshes). */
export const artifactVersions = pgTable("artifact_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  designSetId: text("design_set_id").notNull(),
  designSetVersion: integer("design_set_version").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  /** drafted | saved | published | regenerated | design_refreshed | design_changed | restored */
  event: text("event").notNull(),
  authorKind: text("author_kind").notNull().default("person"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("artifact_versions_uq").on(t.artifactId, t.version)]);
