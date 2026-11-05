import {
  pgTable, pgEnum, uuid, text, timestamp, integer, real, boolean, jsonb, index, uniqueIndex, unique, vector, customType, primaryKey,
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
export const sourceKindEnum = pgEnum("source_kind", ["upload", "wiki", "chat", "manual", "sync", "web", "email", "connector", "recording"]);
export const sourceStatusEnum = pgEnum("source_status", ["pending", "processing", "ready", "failed"]);
export const activityEnum = pgEnum("activity", ["upload", "ocr", "transcription", "llm_extraction", "manual_edit", "inference", "import"]);
export const agentTypeEnum = pgEnum("agent_type", ["user", "model", "rule"]);
export const subjectTypeEnum = pgEnum("subject_type", ["node", "edge"]);
export const authorKindEnum = pgEnum("author_kind", ["user", "assistant"]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system"]);
export const graphKindEnum = pgEnum("graph_kind", ["family", "personal", "work", "shared", "other", "partner", "project", "practice"]);
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
}, (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)]);

export const passkeys = pgTable("passkeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports").array(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("passkeys_credential_idx").on(t.credentialId), index("passkeys_user_idx").on(t.userId)]);

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
  /**
   * Revisions (src/lib/ingest/revisions.ts): every version of one document shares a lineage (the first version's id);
   * `revision` counts from 1 and older versions get `supersededAt` when a newer one is kept. `docKey` is what survives
   * re-saving (a PDF's document id, an Office file's creation stamp, a photo's capture time and camera), `nameKey` the
   * file name without "(1)", "v2", "final" …, and `contentKey` a hash of the normalised text.
   */
  lineageId: uuid("lineage_id"),
  revision: integer("revision").notNull().default(1),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  docKey: text("doc_key"),
  nameKey: text("name_key"),
  contentKey: text("content_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sources_thread_idx").on(t.graphId, t.threadKey), index("sources_lineage_idx").on(t.graphId, t.lineageId), index("sources_dockey_idx").on(t.graphId, t.docKey), index("sources_namekey_idx").on(t.graphId, t.nameKey), index("sources_contentkey_idx").on(t.graphId, t.contentKey), index("sources_docdate_idx").on(t.graphId, t.documentDate), index("sources_owner_idx").on(t.ownerId, t.createdAt), index("sources_graph_idx").on(t.graphId, t.createdAt), index("sources_node_idx").on(t.nodeId)]);

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

/**
 * Where a passage sits in its original. `slide` (presentations), `sheet` + `range` (spreadsheets, e.g. "A1:F40"),
 * `image` (which picture in the file, e.g. "ppt/media/image3.png" or "page 2"), `region` (where in the picture, as the
 * reader described it) and `bbox` ([x, y, width, height] in pixels) are optional additions to page/chars/time.
 */
export type Locator = {
  page?: number; charStart?: number; charEnd?: number; bbox?: [number, number, number, number]; timeStartSec?: number; timeEndSec?: number;
  slide?: number; sheet?: string; range?: string; image?: string; region?: string;
  /** A recording: the moment on its own time line, in ms (a meeting from Record), and who was speaking there. */
  time?: number; speaker?: string;
};

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
}, (t) => [index("provenance_subject_idx").on(t.subjectType, t.subjectId), index("provenance_graph_idx").on(t.graphId), index("provenance_source_idx").on(t.sourceId)]);

/** Explicit share of a node to a user (guests, or a private item shown to one person). */
export const shares = pgTable("shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canEdit: boolean("can_edit").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("shares_node_idx").on(t.nodeId)]);

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
}, (t) => [index("wiki_revisions_page_idx").on(t.pageId, t.createdAt)]);

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
}, (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)]);

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
}, (t) => [index("observations_person_at_idx").on(t.personNodeId, t.at), index("observations_graph_idx").on(t.graphId), index("observations_source_idx").on(t.sourceId)]);


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

/**
 * The always-active assistant session: per person, per graph, the conversation the Ask panel, /chat and the apps
 * open on. "New conversation" clears it (the next question starts one); opening a saved session makes it active.
 */
export const assistantSessions = pgTable("assistant_sessions", {
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.graphId, t.userId] })]);

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
  /** The title as an i18n key + params ("changes.titles.fromSource", { title }), so each reader sees it in their language. `title` keeps the English. */
  titleKey: text("title_key"),
  titleParams: jsonb("title_params").$type<Record<string, string | number>>(),
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

/* ── Background jobs: a durable queue in Postgres (reading files, rebuilding), claimed with SKIP LOCKED ──── */

/**
 * One piece of background work, e.g. reading an uploaded file. Workers claim queued jobs with
 * `FOR UPDATE SKIP LOCKED` and hold a lease (`leaseUntil`, renewed while running); a job whose lease ran out
 * (the server restarted) goes back to the queue. Failures retry with back-off until `maxAttempts`.
 */
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** It runs as this person (re-checked when it starts: still a member who may write). */
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** ingest.read | ingest.rebuild */
  kind: text("kind").notNull(),
  /** What it works on: a source id. */
  subjectId: uuid("subject_id").references(() => sources.id, { onDelete: "cascade" }),
  /** queued | running | done | failed | cancelled */
  status: text("status").notNull().default("queued"),
  /** OCR, vision and transcription: run fewer of these at once. */
  heavy: boolean("heavy").notNull().default(false),
  /** Options for the handler, e.g. { fromFile: true }. */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  /** Times a run was cut off by a restart (not counted as attempts, but capped). */
  interruptions: integer("interruptions").notNull().default(0),
  /** Higher first. */
  priority: integer("priority").notNull().default(0),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lockedBy: text("locked_by"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** { step, done, total, label } */
  progress: jsonb("progress").$type<{ step: string; done?: number; total?: number; label?: string }>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("jobs_claim_idx").on(t.status, t.priority, t.runAfter),
  index("jobs_graph_idx").on(t.graphId, t.status, t.createdAt),
  index("jobs_subject_idx").on(t.subjectId, t.status),
  // At most one waiting job per thing (a second "Read it again" while one waits is the same job).
  uniqueIndex("jobs_one_queued_uq").on(t.kind, t.subjectId).where(sql`status = 'queued'`),
]);

/* ── Corpora and compliance: bodies of rules the graph follows (law, internal governance, guardrails) ───────── */

/**
 * A corpus: a body of knowledge that carries rules — legislation (BEK 260), an interpretation guide, the architecture
 * board's ADR governance, a guardrail. It is a node in the graph (type document, kind "corpus", see the meta model)
 * with this row for what only a corpus has. Its rules are read from its sources and only checked once a person
 * approves them. `scope` limits where it applies: { all } or { targetTypes, nodeKinds, tags, wikiSlugs, artifactKinds }.
 */
export const corpora = pgTable("corpora", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** The corpus's own node (type document, kind corpus). */
  nodeId: uuid("node_id"),
  name: text("name").notNull(),
  description: text("description"),
  /** legislation | regulation | internal_governance | guardrail | policy | standard | other */
  kind: text("kind").notNull().default("other"),
  /** Who issues it: "Energistyrelsen", "Our architecture board". */
  authority: text("authority"),
  /** mandatory | advisory */
  binding: text("binding").notNull().default("mandatory"),
  version: text("version"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  /** draft | active | retired */
  status: text("status").notNull().default("draft"),
  scope: jsonb("scope").$type<Record<string, unknown>>().notNull().default({ all: true }),
  /** In the graph's default set: checked wherever no page picks its own corpora. */
  checkByDefault: boolean("check_by_default").notNull().default(true),
  /** Bumped whenever an active rule changes, so cached checks against the old rules are not reused. */
  rulesVersion: integer("rules_version").notNull().default(1),
  /** The last "Read rules": { status: running|done|failed, done, total, found, error, at, mode }. */
  readState: jsonb("read_state").$type<Record<string, unknown>>(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("corpora_graph_idx").on(t.graphId, t.status)]);

/** The documents a corpus is read from (library items, web pages). role: text | interpretation | supporting. */
export const corpusSources = pgTable("corpus_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  corpusId: uuid("corpus_id").notNull().references(() => corpora.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("text"),
  /** The corpus version this source belongs to. */
  corpusVersion: text("corpus_version"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("corpus_sources_uq").on(t.corpusId, t.sourceId)]);

/**
 * One rule of a corpus, in plain words, with the exact passage it was read from. Read rules start `proposed` and are
 * only checked once a person approves them (`active`). A new version of a corpus proposes a diff: `change` added |
 * changed | removed, with `supersedesId` pointing at the rule it replaces or retires.
 */
export const corpusRules = pgTable("corpus_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  corpusId: uuid("corpus_id").notNull().references(() => corpora.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** "§16 stk. 2", "ADR-4.2". */
  ref: text("ref").notNull(),
  /** Grouping on the corpus page ("§ 16", "ADR-4"). */
  section: text("section"),
  title: text("title").notNull(),
  /** The rule in plain words, in the reader's language. */
  text: text("text").notNull(),
  /** must | must_not | should | should_not | may */
  modality: text("modality").notNull().default("must"),
  /** Narrows the corpus scope for this rule (same shape as corpora.scope). */
  appliesTo: jsonb("applies_to").$type<Record<string, unknown>>().notNull().default({}),
  /** What compliance looks like, and what evidence would show it. */
  checkHint: text("check_hint"),
  /** blocker | major | minor | info */
  severity: text("severity").notNull().default("major"),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  chunkId: uuid("chunk_id"),
  locator: jsonb("locator").$type<Locator>().notNull().default({}),
  /** The exact passage, in the source's own language. */
  quote: text("quote"),
  embedding: vector("embedding", { dimensions: 1024 }),
  /** proposed | active | retired | dropped */
  status: text("status").notNull().default("proposed"),
  /** On a new version: added | changed | removed (null on a first read). */
  change: text("change"),
  supersedesId: uuid("supersedes_id"),
  corpusVersion: text("corpus_version"),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("corpus_rules_corpus_idx").on(t.corpusId, t.status), index("corpus_rules_graph_idx").on(t.graphId, t.status)]);

/**
 * What a check found: one rule against one text (a wiki page, a document, a chat answer, a change set). Advisory —
 * nothing is blocked silently. `span` says where in the checked text ({ start, end, text, block }). open → fixed when
 * the text no longer breaks the rule; accepted when a person keeps the deviation, with their reason.
 */
export const complianceFindings = pgTable("compliance_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** wiki | artifact | message | change_set | node */
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  targetVersion: integer("target_version"),
  ruleId: uuid("rule_id").notNull().references(() => corpusRules.id, { onDelete: "cascade" }),
  corpusId: uuid("corpus_id").notNull().references(() => corpora.id, { onDelete: "cascade" }),
  /** compliant | non_compliant | missing | unclear */
  verdict: text("verdict").notNull(),
  explanation: text("explanation").notNull().default(""),
  span: jsonb("span").$type<{ start: number; end: number; text: string; block?: string | null } | null>(),
  suggestion: text("suggestion"),
  /** Same rule + same passage = the same finding across checks. */
  fingerprint: text("fingerprint").notNull(),
  /** open | fixed | accepted */
  status: text("status").notNull().default("open"),
  acceptedReason: text("accepted_reason"),
  acceptedBy: uuid("accepted_by"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  fixedAt: timestamp("fixed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("compliance_findings_target_idx").on(t.graphId, t.targetType, t.targetId, t.status)]);

/**
 * Which corpora a text is checked against. targetType "graph" with targetId "" is the graph's default; a wiki page or
 * document may pick its own ("Check against"). No row = the graph default.
 */
export const complianceTargets = pgTable("compliance_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull().default(""),
  corpusIds: jsonb("corpus_ids").$type<string[]>().notNull().default([]),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("compliance_targets_uq").on(t.graphId, t.targetType, t.targetId)]);

/** One check, for the strip ("Checked against 2 corpora") and to keep the cost visible (model calls, cache hits). */
export const complianceRuns = pgTable("compliance_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  targetVersion: integer("target_version"),
  /** running | done | failed | skipped */
  status: text("status").notNull().default("running"),
  corpusIds: jsonb("corpus_ids").$type<string[]>().notNull().default([]),
  rulesChecked: integer("rules_checked").notNull().default(0),
  paragraphs: integer("paragraphs").notNull().default(0),
  paragraphsCached: integer("paragraphs_cached").notNull().default(0),
  muxCalls: integer("mux_calls").notNull().default(0),
  /** { blocker, major, minor, info, missing } open findings after the check. */
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  ms: integer("ms"),
  error: text("error"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("compliance_runs_target_idx").on(t.graphId, t.targetType, t.targetId, t.createdAt)]);

/* ── Plans, add-ons and the platform admin console (tiers-admin, migration plans_admin) ─────────────────── */

/**
 * Subscription plans. `public` plans (free, plus, family) may be shown on pricing, onboarding and the settings plan
 * list; hidden ones (ultimate) are only ever shown to the platform admin and to the people who have them.
 * `stripePriceId` is the payments seam: null until billing exists.
 */
export const plans = pgTable("plans", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  public: boolean("public").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  description: text("description"),
  stripePriceId: text("stripe_price_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The features a plan turns on (feature ids as used by hasFeature). */
export const planFeatures = pgTable("plan_features", {
  planKey: text("plan_key").notNull().references(() => plans.key, { onDelete: "cascade" }),
  feature: text("feature").notNull(),
}, (t) => [primaryKey({ columns: [t.planKey, t.feature] })]);

/**
 * A person's own plan (per user account). Household members without a row inherit the household owner's plan for
 * shared features; add-ons never inherit.
 */
export const accountPlans = pgTable("account_plans", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  planKey: text("plan_key").notNull().references(() => plans.key),
  assignedBy: uuid("assigned_by"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Sub-items of Ultimate granted to one account (practice_psychology, practice_medical, insights). */
export const accountAddons = pgTable("account_addons", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  addon: text("addon").notNull(),
  grantedBy: uuid("granted_by"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.addon] })]);

/**
 * Admin controls on an account. `lockedAt` set: the person can't sign in and every session ends.
 * `tempPasswordHash`: a temporary password the admin set; while users.password_hash still equals it, the person has
 * to choose a new password before using the app.
 */
export const accountControls = pgTable("account_controls", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: uuid("locked_by"),
  lockReason: text("lock_reason"),
  tempPasswordHash: text("temp_password_hash"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time password reset links (24 hours, single use). Only sha256(token) is stored. */
export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdBy: uuid("created_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("password_resets_token_idx").on(t.tokenHash), index("password_resets_user_idx").on(t.userId)]);

/* ── Clinical practice (clinical workstream, migration clinical) ─────────────────────────────────────────── */

/**
 * A client's or patient's written consent, per purpose: recording | transcription | notes | analysis | sharing.
 * `sharedWith` names the colleagues (user ids) the client agreed may see their record. Valid while signed, not past
 * `reviewAt` and not withdrawn. Every change writes a `clinical_consent_events` row.
 */
export const clinicalConsents = pgTable("clinical_consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  householdId: uuid("household_id").notNull(),
  clientNodeId: uuid("client_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  clinicianId: uuid("clinician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The signed consent form in the library. */
  documentSourceId: uuid("document_source_id").references(() => sources.id, { onDelete: "set null" }),
  purposes: text("purposes").array().notNull().default([]),
  sharedWith: uuid("shared_with").array().notNull().default([]),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
  reviewAt: timestamp("review_at", { withTimezone: true }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnNote: text("withdrawn_note"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("clinical_consents_client_idx").on(t.graphId, t.clientNodeId)]);

/** History of a consent: created | changed | withdrawn | renewed, with the row before and after. */
export const clinicalConsentEvents = pgTable("clinical_consent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  consentId: uuid("consent_id").notNull().references(() => clinicalConsents.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  clientNodeId: uuid("client_node_id").notNull(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown> | null>(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("clinical_consent_events_client_idx").on(t.graphId, t.clientNodeId, t.at)]);

/**
 * A therapy session or a medical consultation: its node in the practice graph (private to the clinician, shared by
 * `shares`), the audio and the transcript (sensitive sources), and the state of the background work on it.
 */
export const clinicalSessions = pgTable("clinical_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  householdId: uuid("household_id").notNull(),
  clientNodeId: uuid("client_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  clinicianId: uuid("clinician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
  /** psychology | medical */
  discipline: text("discipline").notNull(),
  /** session | consultation */
  kind: text("kind").notNull(),
  title: text("title"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  /** planned | recorded | transcribed | drafted | signed */
  status: text("status").notNull().default("planned"),
  /** da | en */
  language: text("language").notNull().default("da"),
  audioSourceId: uuid("audio_source_id").references(() => sources.id, { onDelete: "set null" }),
  transcriptSourceId: uuid("transcript_source_id").references(() => sources.id, { onDelete: "set null" }),
  /** idle | running | done | failed — transcription and drafting run in the background. */
  work: text("work").notNull().default("idle"),
  workError: text("work_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("clinical_sessions_client_idx").on(t.graphId, t.clientNodeId, t.startsAt), index("clinical_sessions_clinician_idx").on(t.clinicianId, t.startsAt)]);

/**
 * Everything drafted or recorded for a client: notes and letters (to sign), suggested codes, medications, allergies,
 * lab values, themes, hypotheses and follow-ups (proposed → confirmed or dismissed), risk flags (open → acknowledged)
 * and measures (PHQ-9, GAD-7). Nothing reaches the graph until the clinician signs or confirms it; then it is
 * delivered as a change set they author (`changeSetId`).
 */
export const clinicalItems = pgTable("clinical_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  householdId: uuid("household_id").notNull(),
  clientNodeId: uuid("client_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => clinicalSessions.id, { onDelete: "cascade" }),
  clinicianId: uuid("clinician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("proposed"),
  /** The consent purpose that allowed it (notes | analysis …): withdrawn analysis hides analysis items. */
  purpose: text("purpose").notNull().default("notes"),
  title: text("title"),
  content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
  /** [{ quote, sourceId, locator }] */
  evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull().default([]),
  value: real("value"),
  unit: text("unit"),
  refLow: real("ref_low"),
  refHigh: real("ref_high"),
  measuredAt: timestamp("measured_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  model: text("model"),
  changeSetId: uuid("change_set_id"),
  artifactId: uuid("artifact_id"),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("clinical_items_client_idx").on(t.graphId, t.clientNodeId, t.kind), index("clinical_items_session_idx").on(t.sessionId)]);

/** Every version of a clinical item: who drafted, edited, signed, confirmed or dismissed it, and what it said. */
export const clinicalItemRevisions = pgTable("clinical_item_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => clinicalItems.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
  actorKind: text("actor_kind").notNull(),
  actorId: uuid("actor_id"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("clinical_item_revisions_item_idx").on(t.itemId, t.version)]);

/* ── Living profiles (profiles workstream): the written part of a person's or any node's profile ─────────── */

/**
 * The free-text blocks of a node's profile page (TipTap JSON, validated by src/lib/profile/doc). Read and written by
 * whoever may read / edit the node; `version` bumps on every save and each save keeps a profile_doc_versions row.
 */
export const profileDocs = pgTable("profile_docs", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  doc: jsonb("doc").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("profile_docs_node_uq").on(t.graphId, t.nodeId)]);

/**
 * Every saved version of a profile doc, plus "Restore as a proposal" drafts. event: saved | restored | proposed |
 * delivered | dropped. Saved/restored rows carry the version they became; a proposal carries the version it restores
 * (`basedOn`) and waits for a person.
 */
export const profileDocVersions = pgTable("profile_doc_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  doc: jsonb("doc").$type<Record<string, unknown>>().notNull(),
  text: text("text").notNull().default(""),
  event: text("event").notNull().default("saved"),
  basedOn: integer("based_on"),
  authorKind: text("author_kind").notNull().default("person"),
  createdBy: uuid("created_by"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("profile_doc_versions_node_idx").on(t.graphId, t.nodeId, t.createdAt)]);

/**
 * "How they've been doing": insights about a person generated for one viewer from what that viewer may read. Private to
 * `viewerId` (never shown to anyone else); regenerated on demand. `evidenceHash` says whether new evidence arrived.
 */
export const profileInsights = pgTable("profile_insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  viewerId: uuid("viewer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  model: text("model"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("profile_insights_viewer_uq").on(t.graphId, t.nodeId, t.viewerId)]);

/* ── Recordings from an MCP server (Record): the time line the player follows ─────────────────────────── */

/**
 * The time line of a recording source (kind "recording"): every word with its moment (ms on the recording's own time
 * line), the lines (speaker turns) and who the speakers are, as the MCP server gave them; and the waveform's peaks
 * (0–1), fetched with the audio and kept here. Read by the player; the words never go to mux from here.
 */
export const recordingTimelines = pgTable("recording_timelines", {
  sourceId: uuid("source_id").primaryKey().references(() => sources.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  durationMs: integer("duration_ms").notNull().default(0),
  /** [{ a, b, w, line }] */
  words: jsonb("words").$type<{ a: number; b: number; w: string; line: number }[]>().notNull().default([]),
  /** [{ a, b, speaker, first, last, text }] */
  lines: jsonb("lines").$type<{ a: number; b: number; speaker: string | null; first: number; last: number; text: string }[]>().notNull().default([]),
  /** [{ key, name, email }] */
  speakers: jsonb("speakers").$type<{ key: string; name: string; email: string | null }[]>().notNull().default([]),
  peaks: jsonb("peaks").$type<number[] | null>(),
  /** "exact": word times from the server; "estimated": spread over each line from a plain transcript. */
  timing: text("timing").notNull().default("exact"),
  /** Whether the server can give this recording's sound (null: not asked yet). */
  hasAudio: boolean("has_audio"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("recording_timelines_graph_idx").on(t.graphId)]);

/* ── My Graph as an MCP server: AI apps (OAuth) and personal access keys (mcp-server workstream) ─────────── */

/**
 * Apps that registered themselves (OAuth dynamic client registration, RFC 7591): claude.ai, ChatGPT, Claude Code.
 * The name is the one the app gave itself, never checked. A client secret, when there is one, is kept as a hash.
 */
export const mcpClients = pgTable("mcp_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  uri: text("uri"),
  redirectUris: text("redirect_uris").array().notNull(),
  /** none | client_secret_post | client_secret_basic */
  authMethod: text("auth_method").notNull(),
  secretHash: text("secret_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A code from the consent page: ten minutes, used once, bound to its PKCE challenge, one graph and one scope. */
export const mcpCodes = pgTable("mcp_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => mcpClients.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  /** read | propose */
  scope: text("scope").notNull(),
  resource: text("resource").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  challenge: text("challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  grantId: text("grant_id"),
}, (t) => [index("mcp_codes_expires_idx").on(t.expiresAt)]);

/** One connected app: a person allowed an app into one graph, to read or to read and propose. */
export const mcpGrants = pgTable("mcp_grants", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().references(() => mcpClients.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  resource: text("resource").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("mcp_grants_user_idx").on(t.userId, t.revokedAt)]);

/** Access tokens (an hour) and refresh tokens (30 days, rotated on every use) of a grant, kept as hashes. */
export const mcpTokens = pgTable("mcp_tokens", {
  id: text("id").primaryKey(),
  grantId: text("grant_id").notNull().references(() => mcpGrants.id, { onDelete: "cascade" }),
  /** access | refresh */
  kind: text("kind").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("mcp_tokens_hash_uq").on(t.tokenHash), index("mcp_tokens_grant_idx").on(t.grantId)]);

/** Personal access keys for the MCP server: one person, one graph, read or read and propose. Shown once, hashed. */
export const mcpKeys = pgTable("mcp_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").notNull().references(() => graphs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** The first characters, to tell keys apart ("mgk_3fA9…"). */
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  scope: text("scope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [uniqueIndex("mcp_keys_hash_uq").on(t.tokenHash), index("mcp_keys_user_idx").on(t.userId, t.revokedAt)]);

/* ── Security: shared limits (hardening) ──────────────────────────────────────────────────────────────── */

/**
 * Fixed-window counters shared by every server process: one row per (bucket, key, window start). `bucket` names the
 * limit ("mcp", "transcribe", "paste", "login.ip", ...), `key` who it counts (a hashed credential, user or IP), and
 * `windowStart` the start of the window. Old windows are swept on use. Keys are hashed; nothing personal is stored.
 */
export const rateLimits = pgTable("rate_limits", {
  bucket: text("bucket").notNull(),
  key: text("key").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.bucket, t.key, t.windowStart] }), index("rate_limits_expires_idx").on(t.expiresAt)]);

/** One-time tokens already spent (MCP tool approvals): the hash of the token, until the token would have expired. */
export const usedApprovals = pgTable("used_approvals", {
  tokenHash: text("token_hash").primaryKey(),
  kind: text("kind").notNull(),
  userId: uuid("user_id"),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("used_approvals_expires_idx").on(t.expiresAt)]);

/**
 * Payments (Stripe) for the public paid plans. One row per account that has ever started a checkout. The webhook
 * keeps it in step with Stripe and sets account_plans from it; Ultimate (admin-assigned) is never touched by billing.
 * `reviewAt`: the next moment the plan can change without a webhook (a held downgrade or the end of a grace period).
 */
export const billingAccounts = pgTable("billing_accounts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** The plan Stripe is billing for now (plus | family), from the subscription's price. */
  planKey: text("plan_key"),
  /** month | year */
  interval: text("interval"),
  /** Stripe's subscription status: active, trialing, past_due, unpaid, canceled, incomplete, incomplete_expired, paused. */
  status: text("status"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /** A downgrade made mid-period keeps the paid-for plan until here. */
  heldPlanKey: text("held_plan_key"),
  heldUntil: timestamp("held_until", { withTimezone: true }),
  /** A failed payment keeps the plan until here. */
  graceUntil: timestamp("grace_until", { withTimezone: true }),
  reviewAt: timestamp("review_at", { withTimezone: true }),
  /** `created` of the newest subscription event applied (Stripe doesn't promise order). */
  subscriptionEventAt: timestamp("subscription_event_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("billing_accounts_customer_uq").on(t.stripeCustomerId), index("billing_accounts_review_idx").on(t.reviewAt)]);

/** Every Stripe webhook event received, by Stripe's event id: processing is idempotent and retried until done. */
export const billingEvents = pgTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  userId: uuid("user_id"),
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  /** What went wrong on the last attempt (never contains secrets or card data). */
  error: text("error"),
}, (t) => [index("billing_events_received_idx").on(t.receivedAt)]);

/* ── iPhone push (push workstream): devices, per-person push settings and what was sent ───────────────── */

/**
 * One app install that can receive push: its APNs device token (hex), tied to the session it registered from, so
 * signing out (or a revoked session) removes it with the session. The token is a routing address, not a secret.
 */
export const deviceTokens = pgTable("device_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  /** ios */
  platform: text("platform").notNull().default("ios"),
  /** sandbox | production: which APNs host accepts this token (debug builds are sandbox). Null = APNS_ENV. */
  environment: text("environment"),
  appVersion: text("app_version"),
  /** en | da: the language notifications are written in for this device. */
  locale: text("locale"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("device_tokens_token_uq").on(t.token), index("device_tokens_user_idx").on(t.userId)]);

/** Per person: whether push is on, which kinds, and quiet hours (minutes after local midnight, in users.time_zone). */
export const pushSettings = pgTable("push_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  /** { reminders, waiting, connections, clinical }: false turns that kind off. Missing = on. */
  categories: jsonb("categories").$type<Record<string, boolean>>().notNull().default({}),
  /** Null start or end = no quiet hours. */
  quietStart: integer("quiet_start").default(1320),
  quietEnd: integer("quiet_end").default(420),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every push decided for a person: sent, or skipped (no device, failed). `key` makes each thing notify once
 * ("reminder:<id>", "risk:<id>", "connection:<id>:<since>", "waiting:<graph>:<newest>"). `counted` = it counts
 * toward the daily cap (assistant_settings.daily_suggestion_cap). Holds no notification text.
 */
export const pushDeliveries = pgTable("push_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  graphId: uuid("graph_id").references(() => graphs.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  /** reminders | waiting | connections | clinical | test */
  category: text("category").notNull(),
  counted: boolean("counted").notNull().default(false),
  /** sent | failed | no_device */
  status: text("status").notNull(),
  devices: integer("devices").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("push_deliveries_user_key_uq").on(t.userId, t.key), index("push_deliveries_user_idx").on(t.userId, t.createdAt)]);

/* ── Data safety: exports and account deletion ───────────────────────────────────────────────────────── */

/**
 * A person's download of their data: one graph they own, or their whole account, built in the background into a zip
 * under EXPORT_DIR (see src/lib/export). The link works for its owner only, until `expiresAt` (24 hours after it is
 * ready); then the file is removed and the row says `expired`.
 */
export const dataExports = pgTable("data_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** graph | account */
  scope: text("scope").notNull(),
  /** The graph (scope = graph); null for the whole account. */
  graphId: uuid("graph_id").references(() => graphs.id, { onDelete: "cascade" }),
  /** queued | running | ready | failed | expired */
  status: text("status").notNull().default("queued"),
  progress: jsonb("progress").$type<{ step: string; done?: number; total?: number }>(),
  /** { bytes, sha256, counts: { nodes, edges, … }, files } once ready. */
  info: jsonb("info").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [index("data_exports_user_idx").on(t.userId, t.createdAt), index("data_exports_status_idx").on(t.status, t.expiresAt)]);

/**
 * A request to delete an account, carried out after a 7-day grace period unless the person signs in again.
 * No foreign key on `userId`: the row outlives the account, and holds nothing personal (no name, no email).
 * `formerId` is the stand-in account their kept contributions in shared graphs are attributed to ("a former member").
 */
export const accountDeletions = pgTable("account_deletions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  householdId: uuid("household_id").notNull(),
  /** scheduled | cancelled | done | failed */
  status: text("status").notNull().default("scheduled"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  /** signed_in | by_person | blocked */
  cancelReason: text("cancel_reason"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  formerId: uuid("former_id"),
  /** What was deleted and what was kept, as counts. */
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
}, (t) => [
  index("account_deletions_due_idx").on(t.status, t.scheduledFor),
  uniqueIndex("account_deletions_one_scheduled_uq").on(t.userId).where(sql`status = 'scheduled'`),
]);

/* ── Observability (performance workstream): server errors, slow requests and route timings ──────────────────────── */

/**
 * One row per kind of server problem, grouped by a fingerprint of (kind, error name, message shape, top stack frames,
 * route). Metadata only: the message is redacted (ids, numbers, quoted text, e-mails, tokens removed), frames are code
 * locations, users are counted by a salted hash. Never a request body, header, query string or anything a person wrote.
 */
export const serverErrors = pgTable("server_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  fingerprint: text("fingerprint").notNull(),
  /** "error" (thrown), "status" (answered 5xx without throwing), "slow" (took longer than the slow threshold). */
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  message: text("message").notNull(),
  stackHash: text("stack_hash").notNull(),
  frames: jsonb("frames").$type<string[]>().notNull().default([]),
  /** The route pattern ("/people/[id]"), never the concrete URL. */
  route: text("route").notNull(),
  method: text("method").notNull().default(""),
  /** Where it happened: render, route, action, middleware or request. */
  source: text("source").notNull().default("request"),
  status: integer("status"),
  digest: text("digest"),
  count: integer("count").notNull().default(0),
  /** Salted hashes of the accounts that hit it (at most 50 kept), for "how many people saw this". */
  userHashes: jsonb("user_hashes").$type<string[]>().notNull().default([]),
  lastDurationMs: integer("last_duration_ms"),
  maxDurationMs: integer("max_duration_ms"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set by an admin; cleared when it happens again. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [uniqueIndex("server_errors_fingerprint_uq").on(t.fingerprint), index("server_errors_last_seen_idx").on(t.lastSeenAt)]);

/**
 * Request timings per route and minute, flushed from each server process's in-memory collector. `hist` counts
 * requests per latency bucket (bounds in src/lib/observability/histogram.ts), so p50/p95 over any window are read by
 * summing buckets. Route patterns only, never URLs.
 */
export const routeTimings = pgTable("route_timings", {
  id: uuid("id").primaryKey().defaultRandom(),
  bucket: timestamp("bucket", { withTimezone: true }).notNull(),
  route: text("route").notNull(),
  method: text("method").notNull(),
  count: integer("count").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  slow: integer("slow").notNull().default(0),
  sumMs: integer("sum_ms").notNull().default(0),
  maxMs: integer("max_ms").notNull().default(0),
  hist: integer("hist").array().notNull(),
}, (t) => [uniqueIndex("route_timings_bucket_route_uq").on(t.bucket, t.route, t.method), index("route_timings_bucket_idx").on(t.bucket)]);
