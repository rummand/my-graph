# My Graph: a family brain you can trust

A private knowledge graph that holds everything about your life, helps you run it with your kids, and shows where every fact came from.

Draft v1 · 3 Nov 2026 · Visual version: https://claude.ai/artifact/QvvpxsJjJ6KN5CZ5RKGtQS

## Summary

My Graph is a private, family-scale knowledge system. At its core is **GBrain**, a personal knowledge graph where every fact links back to its source. Five things sit on top of it:

- **Chat assistant** that sends each request through **mux**, a routing layer that picks the right model for the task.
- **Knowledge library** for files, documents, photos, scans and email exports, each parsed into the graph.
- **Wiki pages** written by you and the assistant together, linked to the people, places and events they mention.
- **Visual timeline** of what happened, what was decided and what is coming, for you and each child.
- **Family accounts** with login, roles and strict privacy, built for children's data from day one.

## Goals and non-goals

The system works if a parent can answer "when, why, and who says so?" about anything in family life in under 10 seconds.

**Goals**

1. Capture everything: any file type lands in the graph within minutes.
2. Trust every answer: each fact, summary and reply shows sources, confidence and history.
3. See life as a flow: one timeline, filtered by person, topic or source.
4. Help ahead of time: reminders and preparation for school, health, activities and admin.
5. Write together: wiki pages with full version history.
6. Stay private: family-owned, encrypted, never used to train outside models.

**Not in v1:** social sharing, replacing official record systems, multi-tenant SaaS (v1 serves one household of 2 to 10 people), native mobile apps (PWA first).

## Core capabilities

| Capability | What you get | Key detail |
| --- | --- | --- |
| GBrain | Living model of people, places, events, documents, decisions | Every node and edge records source, extractor, time, confidence |
| Chat via mux | Ask, plan, draft and decide in plain language | Fast model for lookups, strongest for reasoning, local for sensitive data |
| Library | Upload PDFs, Office files, photos, scans, audio, email | OCR, transcription, captions, entity extraction; originals unchanged |
| Wiki pages | Pages with backlinks, mentions, embeds | Assistant drafts and updates; every edit versioned and attributed |
| Timeline | Zoomable, a lane per person | Click any event for its sources and graph neighbourhood |
| Family help | School, health, activities, milestones, admin | Daily briefs, deadline reminders |
| Accounts | Parent, child, guest roles; per-item sharing | Passkeys + optional TOTP; parent-controlled child views |

## Architecture

```
Web app (PWA): Chat · Library · Wiki · Timeline · Graph view
                          │
     API and auth: passkeys, roles, per-node access control
        │                 │                  │
 Ingestion workers ──▶  GBrain  ◀── Assistant agent
        │                 │                  │
  Object storage     PostgreSQL       mux model router
                (AGE + pgvector + audit)  (Claude / local model)
```

## Data model

Six node types, one rule: no fact exists without a link to at least one Source.

| Node type | Examples | Main relations |
| --- | --- | --- |
| Person | You, children, teachers, doctors | parent_of, attends, treated_by, knows |
| Place | School, clinic, home | located_at, happened_at |
| Event | Appointment, trip, birthday, decision | involves, happened_at, follows, caused_by |
| Topic | Health, school, finances | about, tagged_with |
| Document | File, photo, wiki page, chat message | mentions, derived_from, version_of |
| Source | Original file + how it was processed | supports, extracted_by |

## Provenance

Every fact carries a W3C PROV-style record: `source_id`, `locator`, `activity`, `agent`, `confidence` (below 0.6 = "unconfirmed"), and `created_at` / `superseded_by`. Nothing is overwritten. Answers show citation chips; every node has a "Why do we believe this?" panel; inferred facts are marked and never silently promoted.

## Security and children's data

- Passkeys by default, TOTP fallback, no SMS. Parents approve new devices and manage child accounts.
- Roles: Owner, Parent, Child, Guest (time-limited). Per-node access lists; the assistant only sees what the asker may see.
- AES-256 at rest, TLS 1.3 in transit, per-household keys. Self-hosted or EU-hosted. One-click export and delete.
- mux sends sensitive data only to local or zero-retention providers. Append-only audit log. Targets GDPR incl. Article 8.

## Tech stack

Next.js + React + Tailwind + shadcn/ui · TipTap + Yjs · Cytoscape.js or Sigma.js · vis-timeline or D3 · Node (Fastify/tRPC) · PostgreSQL + Apache AGE + pgvector · MinIO · Python ingestion (Docling/Unstructured, Tesseract, Whisper) · mux with Claude · Better Auth or Keycloak · Docker Compose.

## Roadmap (about 24 weeks full-time)

| Phase | Weeks | Scope | Gate |
| --- | --- | --- | --- |
| 1. Foundation | 1–6 | Auth + roles, upload + storage, graph schema, basic wiki | Whole family logs in and uploads |
| 2. GBrain | 7–12 | OCR + extraction, provenance, entity resolution, graph view | 90% of facts show a source |
| 3. Assistant | 13–18 | Chat via mux, cited answers, timeline, reminders | Weekly use for 4 weeks |
| 4. Family | 19–24 | Child accounts, email + calendar sync, backups, security review | v1 launch after family pilot |

## Risks

| Risk | Mitigation |
| --- | --- |
| Wrong extractions shown as fact | Confidence thresholds, "unconfirmed" state, one-click correction |
| Sensitive data reaching cloud models | mux privacy rules, local models, audit log |
| Noisy, duplicated graph | Entity resolution with user-approved merges |
| Scope creep | Strict phase gates |
| Data loss | Nightly encrypted backups, tested restores, full export |

## Decisions needed

- [ ] GBrain: build from scratch or adopt an existing open-source project?
- [ ] mux: a model router or Coder's agent multiplexer?
- [ ] Hosting: home server or EU VPS?
- [ ] Users: how many, and at what age does a child get a login?
- [ ] v1 integrations: email, calendar, Aula, photo library?
