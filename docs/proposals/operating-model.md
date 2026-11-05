# The self-describing enterprise

**A proposal for My Graph's operating-model layer: one language for how any business works, lenses for every function, and a company that keeps its own map up to date.**

Draft v1 · 5 Nov 2026 · Status: proposal for review · Owner: the founder · Related: `PROPOSAL.md`, `docs/versioning-plan.md`, `docs/commitments.md`

---

## 1. In one page

My Graph already holds what actually happens in a company — mail, meetings, chats, documents, decisions, customers, systems — every fact with its source, its history and a person who approved it. What it does not yet hold is **how the company is meant to work**: what it can do, how it does it, who does it, under which rules, towards which goals. Every company keeps that in drawings that are out of date the month they are made.

This proposal adds that second world **to the same graph**, in a small, universal grammar, and lets the first world keep it alive:

1. **Facts** — what is (built).
2. **The operating model** — how a business works: capabilities, processes, roles, rules, commitments, decisions, goals and signals. The same for every enterprise; seeded from a reference model (APQC's Process Classification Framework) as a template, then grown from evidence.
3. **Lenses** — how people look at it: declared viewpoints for a function or a question (enterprise architecture, customer service, finance, HR, compliance, management, a new employee), computed live from facts, every answer traceable to its source.

The bridge between facts and model is **anchoring**: everything that comes in is placed on the capability and process it belongs to — proposed by agents, confirmed by people as patterns, not one item at a time.

The result is a company that **describes itself**. The org chart, the process map and the capability map stop being drawings and become living views of what really happens — dated, comparable, and presentable with one click. Every feature we have discussed (commitments, compliance, the customer radar, onboarding, the board pack, what-if) becomes *a lens + rules + an agent* on one layer, instead of a separate product. The same machinery serves a family, a clinic and a 200-person company: only the template differs.

---

## 2. The problem: two worlds that never meet

| What actually happens | How it is supposed to work |
| --- | --- |
| Mail, Slack, meetings, calls, tickets, invoices, contracts, code | Org charts, process maps, capability maps, policies, RACI, KPIs |
| Scattered across 10–40 systems | Drawn once in slides and spreadsheets |
| Fresh, detailed, unconnected | Connected, simplified, stale |
| Read by the people doing the work | Read by management, architects, auditors |

Because the two never meet:

- Nobody can answer "why do we do it this way?" without finding the person who was there.
- Every function buys its own system (CRM, ticketing, ERP, GRC, EA repository, intranet) and each holds a partial, contradicting truth.
- Architecture, compliance and strategy work starts with weeks of collecting what already exists somewhere.
- New employees spend weeks learning who knows what.
- AI agents guess, because they have no map of the business they are working in.

---

## 3. Principles (unchanged — they carry over from the product)

1. **Everything is a graph.** The operating model is not a separate tool; capabilities, processes, goals and lenses are objects and edges in the same graph as the facts.
2. **Agents propose, humans decide.** Anchoring, discovered processes, model changes and lens results that change anything are proposals with receipts. People approve, edit or drop them; "always allow" is itself a revocable human decision.
3. **Provenance on everything.** Every number in a lens can be opened down to the email, the meeting minute, the clause or the commit behind it.
4. **Generic, not special.** Graph kinds are templates. Family, personal, practice and work run the same machinery with different templates.
5. **Emergent.** The model starts from a reference template and grows from evidence, with history, like kinds, relations, attributes and roles already do.
6. **Graphs never leak.** Lenses read only what the viewer may read, in the current graph; crossings between graphs are explicit and consented.
7. **Plain words.** Expert vocabulary exists, but every view has a plain-language reading for people who are not architects.

---

## 4. The three layers

### 4.1 Facts (exists)

People, organisations, places, events, documents, messages, meetings, decisions, commitments, systems, rules, roles held — with provenance, versions, history at any date, and change sets.

### 4.2 The operating model (new): a grammar every business shares

| Building block | Answers | Examples | Status in My Graph |
| --- | --- | --- | --- |
| **Capability** | *What* can the business do? | Invoice customers · Recruit · Handle complaints · Manage suppliers | new |
| **Process** | *How* is it done, step by step? | Quote → order → delivery → invoice → payment | new |
| **Activity / step** | The steps of a process, with inputs and outputs | "Send invoice", "Chase overdue payment" | new |
| **Role** | *Who* does it? | Bookkeeper · Account manager · Class teacher | built (roles) |
| **Rule** | What *must / must not* happen? | Bookkeeping act § 10 · our refund policy | built (Rules) |
| **Commitment** | What did we *promise*, by when? | "Quote by Friday" · "Renewal notice by 2 Dec" | being built |
| **Decision** | What did we *choose*, and why? | "We use supplier X because …" | new node type |
| **Goal** | *Why* do we do it? | "90 % of complaints answered in 2 days" | new |
| **Signal** | How do we *see* how it is going? | Response time · open commitments · churned customers | new (computed) |
| **System** | *With what*? | e-conomic · HubSpot · Slack · GitHub | partly (connectors) |
| **Information** | *About what*? | Customer · Order · Invoice · Employee · Data subject | built (kinds) |

**One sentence ties it together** — the grammar can be read aloud:

> The **role** performs the **process**, which realises the **capability**, using **systems** and **information**, governed by **rules**, producing **commitments**, **decisions** and **artifacts**, observed through **signals**, towards **goals**.

Every enterprise fits this sentence. A bakery, a law firm, a SaaS company and a municipality differ in *which* capabilities matter and *how* their processes run — not in the grammar.

### 4.3 Lenses (new): how people look

A **lens** is a declared way of looking at the graph for a stakeholder and a set of concerns. It is the *viewpoint* idea from enterprise architecture (ISO/IEC/IEEE 42010, ArchiMate viewpoints), but **computed live from facts with provenance**, instead of drawn by hand.

A lens has:

- **for** — the stakeholder (enterprise architect, customer-service lead, CFO, new employee, auditor, the board)
- **concerns** — what they need to know
- **scope** — the part of the model (capabilities, processes, roles, information) and the period
- **questions** — coverage, flow, freshness, risk, gaps, trends, conflicts
- **measures** — signals and how they are computed
- **show** — the representation: map, flow, matrix, timeline, ledger, heatmap, narrative
- **vocabulary** — the words this function uses for shared objects ("customer" / "debtor" / "data subject")

The same fact appears in many lenses with different words and different context — that is how functions finally share one truth without sharing one jargon.

---

## 5. Reference models and templates

### 5.1 The work template: APQC as the backbone

APQC's **Process Classification Framework (PCF)** is the closest thing the world has to a shared map of how enterprises work: 13 categories, about 1,000 processes, five levels deep, with industry variants. Its top level:

1. Develop vision and strategy
2. Develop and manage products and services
3. Market and sell products and services
4. Manage supply chain for physical products
5. Deliver services
6. Manage customer service
7. Develop and manage human capital
8. Manage information technology
9. Manage financial resources
10. Acquire, construct and manage assets
11. Manage enterprise risk, compliance, remediation and resiliency
12. Manage external relationships
13. Develop and manage business capabilities

**Plan:** an **SME edition** — the 13 categories, two to three levels deep (≈ 150–250 elements), in English and Danish, written in plain words, with industry editions later (clinic, law firm, bakery, construction, SaaS, school, municipality). It is a *template*: the company keeps what fits, renames, adds and removes — every change with history.

> **Licensing check before shipping.** APQC publishes the PCF for free use with attribution as far as we know; confirm the current terms and attribution text before we ship the template. If the terms do not fit, we write our own SME edition aligned to the same structure (capability maps à la BIZBOK are an alternative backbone).

### 5.2 The same layer in every graph kind

| Template | Capabilities look like | Processes look like | Typical lenses |
| --- | --- | --- | --- |
| **Work (SME)** | APQC SME edition | Order-to-cash, hire-to-retire, complaint handling | EA, customer service, finance, HR, compliance, management |
| **Practice** (clinic, therapist) | Treat clients, keep records, manage consent, bill | Referral → intake → sessions → closure | Clinician, practice manager, data protection |
| **Family** | Run the home, raise the children, keep health, manage money, keep in touch | School year, moving house, insurance renewal | "Who does what at home", family admin, money |
| **Personal** | Work, learn, health, home, relationships | Job search, training plan | You (self-insights), life admin |
| **Project** | The project's deliverables | Plan → build → review → deliver | Status, risks, decisions |

---

## 6. Anchoring: the bridge between facts and model

Everything that comes in — a mail, a meeting, an invoice, a Slack thread, an issue, a contract, a commitment, a decision — is **anchored** to the capability, process (and step) it belongs to, and to the role performing it.

- **Agents propose anchors** with a receipt ("this mail asks for a refund → Handle complaints › Decide on compensation").
- **People approve patterns, not items**: "everything from billing@ belongs to *Invoice customers*", "issues labelled *bug* belong to *Resolve incidents*", "Aula messages belong to *School and daycare*". Patterns are rules in the graph, with history; agents apply them and only ask when unsure.
- **Unanchored facts** are visible as a queue — they are where the model is missing something (a capability nobody named yet).

What anchoring makes possible, and nobody has today:

1. **Where the work really happens** — a heatmap of activity per capability, compared with where the org chart says it happens.
2. **Discovered processes** — the order in which steps actually happen (process mining on the graph's events), set against the designed process; deviations become proposals: "change the rule, or change the practice?"
3. **One language across functions** — the glossary per lens maps each function's words to the same objects.
4. **Agents with a map** — an agent knows which capability it is working in, which rules apply, who owns it and what the goal is.

---

## 7. The lens language (draft specification)

Lenses are declarative so that (a) people can read them, (b) the assistant can write them from ordinary speech, and (c) they can be versioned, shared, compared over time and turned into artifacts.

### 7.1 Shape

```yaml
lens: <name>
for: <stakeholder>            # role or person; drives vocabulary and defaults
concerns: [<text>, …]         # what this viewer needs to know
scope:
  capabilities: [<path>, …]   # e.g. "Manage customer service › Handle complaints"
  processes: [<path>, …]
  roles: [<key>, …]
  information: [<kind>, …]
  period: <date range | "last 90 days" | "2026-Q3">
  graph: current              # never another graph without an explicit, consented crossing
questions:
  - coverage: <what should exist for each item in scope>     # owner, process, rule, proof, system
  - flow: <which items move through which steps>             # designed vs discovered
  - freshness: <how old the newest evidence is>
  - risk: <rules without proof, commitments at risk, single points of knowledge>
  - conflicts: <contradicting decisions, rules, sources>
  - trend: <signal over time>
  - compare: <this period vs that period | this unit vs that unit>
measures:
  - name: <signal>
    of: <set of facts>
    as: count | sum | median | p90 | share | duration | age
    goal: <optional target>
show: map | flow | matrix | timeline | ledger | heatmap | narrative | deck
vocabulary:
  customer: "debtor"          # optional per-lens wording
```

### 7.2 Semantics

- A lens is **compiled** into graph queries scoped to the viewer and the current graph; every result row carries its **receipts** (source, quote, locator).
- A lens is **an artifact** (kind `lens`): saved, shared with visibility like any artifact, versioned, viewable **as of any date** (the history layer already supports the graph at a date), and **diffable** between two dates.
- A lens never changes the graph. Actions taken from a lens (assign an owner, accept a discovered process, fix a missing proof) are **proposals** like everything else.
- The assistant writes lenses from speech ("show me where complaints got stuck in Q3") and explains them in plain words; people can edit the YAML or the form behind it.

### 7.3 Built-in lenses (first release)

**Enterprise architecture — capability health**
```yaml
lens: Capability health
for: Enterprise architect
scope: { capabilities: ["*"], period: "last 180 days" }
questions:
  - coverage: owner, process, systems, rules, information for every capability
  - freshness: newest decision and activity per capability
  - risk: capabilities with one knowledgeable person; rules without proof; systems without owner
  - conflicts: decisions that contradict each other
show: map
```

**Customer service — where complaints get stuck**
```yaml
lens: Complaints, Q3
for: Customer service lead
scope: { capabilities: ["Manage customer service › Handle complaints"], period: 2026-Q3 }
questions:
  - flow: discovered vs designed steps
  - risk: open commitments to customers past due
  - trend: time to first answer, time to resolution
measures:
  - { name: first answer, of: complaints, as: median, goal: "≤ 1 day" }
show: flow
```

**Finance — what we owe and are owed**
```yaml
lens: Obligations
for: CFO
scope: { information: [invoice, contract, commitment], period: "next 90 days" }
questions:
  - risk: notices and renewals within lead time; payments overdue
  - trend: days sales outstanding
show: ledger
```

**Compliance — what applies to us**
```yaml
lens: What applies
for: Compliance owner
scope: { capabilities: ["*"], information: [rule] }
questions:
  - coverage: each rule → the capabilities it applies to → owner → proof (and when proof expires)
  - risk: missing or expiring proof; rules with no owner
show: matrix
```

**Management — goals and what drives them**
```yaml
lens: Goals
for: Management team
scope: { capabilities: ["*"], period: "this quarter" }
questions:
  - trend: each goal's signal
  - risk: decisions overdue; capabilities without owners
  - conflicts: goals pulling in different directions
show: narrative
```

**New employee — my first week**
```yaml
lens: Onboarding
for: <the new person's role>
scope: { roles: [<role>], period: "last 12 months" }
questions:
  - coverage: people to know (and what to ask them), decisions that shaped this area, customers touched, rules for this role, first commitments
show: narrative
```

---

## 8. Living views and presentations

- **Views are live.** A published lens is not a screenshot; it updates as facts arrive, and shows *what changed since you last looked*.
- **Views are dated.** Open any lens "as of" a date; compare two dates; see who changed what in between (history and who-said already exist).
- **"Present that" is one click.** A lens becomes a deck or a report in the graph's design set (Artifacts already draft decks and documents with citations); the deck keeps a link back to the live lens.
- **Meetings run on lenses.** The agenda is generated from what moved in the relevant lenses since the last meeting; decisions taken are written back as decision nodes, anchored and cited.

---

## 9. Every function, one graph

| Function | Today buys | In My Graph it is a lens over one graph showing |
| --- | --- | --- |
| Enterprise architecture | EA repository, consultants | Capability map coloured by health; systems, owners, data, rules, open decisions, risks; target vs current |
| Customer service | Ticketing tool | Journeys through processes, open customer commitments, recurring issues anchored to the step that causes them |
| Sales | CRM | Relationship radar (who went quiet, who is double-covered), pipeline from real conversations |
| Finance | ERP reports | Obligations ledger, payment patterns, contracts with notice periods, cost per capability |
| HR | HR system, intranet | Roles × people × knowledge; key-person risk; onboarding per role; handovers when people leave |
| Compliance | GRC tool | Rules × capabilities; owners; proof and expiry; deviations log; data-processing records |
| Management | Board decks | Goals ← signals ← processes; decisions made and overdue; strategy-to-capability gaps |
| IT | CMDB | Systems ↔ capabilities ↔ information; who depends on what; impact of a change |
| Everyone | Intranet, wiki, Slack search | "Why do we do it this way?" with the decision, the meeting and the people |

---

## 10. The ten work ideas, re-expressed on the layer

Each earlier idea becomes **a lens + rules + an agent**, not a product:

| # | Idea | Lens | Rules | Agent |
| --- | --- | --- | --- | --- |
| 1 | Company memory: "why did we decide that?" | Decisions by capability | "Decisions need a reason and a source" | Finds decisions in meetings/threads, flags contradictions |
| 2 | Onboarding in a day | Onboarding (per role) | Role rules | Builds and refreshes the newcomer's view |
| 3 | Commitments for the company | Obligations ledger | Lead times per kind | Detects, watches clashes, closes the loop |
| 4 | Compliance by itself | What applies | Law and policy rule sets | Maps rules to capabilities, chases proof |
| 5 | Meetings that follow themselves up | Since last meeting | "Every decision has an owner and a date" | Writes decisions and commitments back |
| 6 | Customer and relationship radar | Relationships by customer | "Key accounts every 4 weeks" | Flags fading and double coverage |
| 7 | Who knows what | Knowledge by capability | "No capability with one knower" | Suggests handovers before people leave |
| 8 | The company as a tool for every AI | All lenses via MCP | Viewer scoping | Other AIs read lenses and propose changes |
| 9 | Board pack writes itself | Goals + changes since last | Reporting rules | Drafts the deck with citations |
| 10 | What-if for the business | Impact of a change | Notice periods, contracts, laws | Plays the scenario through the model |

---

## 11. Going further: the wild part

These build on the same layer. Some are near, some are far; all are unique to a company that describes itself in one graph.

### 11.1 The company as code: reorganisations as pull requests
The operating model is versioned like a repository. A reorganisation, a new process or a merged department is a **branch**: you change roles, owners and processes on the branch, and the graph shows the **impact** before you merge — which commitments change owner, which rules lose their owner, which customers lose their contact, which knowledge leaves with whom. Merge when the people affected have approved. Rollback is a proposal like any other.

### 11.2 Replay a quarter
Pick a quarter and **replay** it on the model: watch work flow through capabilities day by day, where it queued, where decisions waited, where rules were bent. Then replay it **counterfactually**: "same quarter, but with the new complaint process" — the discovered event log re-run through the designed process to estimate what would have changed.

### 11.3 The company's vital signs
One screen, like a patient chart: a handful of signals per capability (flow, backlog, freshness, risk, mood of the people doing it), each with a normal range learned from the company's own history, alarms only when something leaves its range. Management meetings start here.

### 11.4 Self-healing operating model
Agents continuously look for **holes in the model** and propose fixes: capabilities with no owner, processes nobody performs any more, rules nothing anchors to, systems nobody uses, roles with no person, knowledge held by one person. Each proposal arrives with the evidence and the smallest fix.

### 11.5 Contracts that watch themselves
A signed contract is compiled into rules and commitments (prices, SLAs, notice periods, volumes, penalties). The graph then **watches the contract against reality**: "the SLA says 4-hour response; the last 6 tickets took 9 hours", "volume discount threshold reached — claim it", "notice window opens next week". The contract becomes a living object, not a PDF.

### 11.6 Strategy compiler
Write the strategy in plain words. The graph compiles it into **goals → required capabilities → gaps (missing, weak, unowned) → initiatives → commitments**, each initiative a change set on the model. Progress is a lens; drift between strategy and where the work actually goes is an alarm.

### 11.7 Regulatory foresight
When a new law, executive order or standard is published (Rules already reads laws from a link and re-checks them), the graph computes its **impact before it applies**: which capabilities, processes, roles, systems and contracts it touches, what must change by when — as commitments with owners. Compliance moves from catch-up to ahead-of-time.

### 11.8 Agents as colleagues, in the org chart
AI agents get **a place in the operating model**: a role, the capabilities they serve, the rules that govern them, the signals they are measured on, and a human owner who approves their proposals. You can see what each agent did, why, under which rule, and turn its "always allow" on or off per capability. Digital colleagues, governed like people.

### 11.9 Federated graphs between companies
Two companies (customer and supplier, partners in a project, a company and its accountant or auditor) share a **consented lens** across their graphs — the cross-graph objects we already built, extended to organisations. Shared commitments, shared decisions, shared proof — each side keeps its own graph; only the lens crosses, with receipts. Supply chains and partnerships get one truth without one system.

### 11.10 Auditor mode
An auditor, a certifier or a buyer doing due diligence gets a **time-bound, read-only lens** with full provenance: every claim clickable to its source, every change with who and when. Audits that take weeks become days; due diligence becomes a link.

### 11.11 Benchmarks without exposure
Because every company speaks the same grammar, anonymous, opt-in **benchmarks** become possible on the reference model: "your order-to-cash takes 41 days; similar companies take 23", computed from aggregates that never reveal a company's facts (privacy-preserving aggregation, minimum group sizes).

### 11.12 Template and lens marketplace
Industry editions, lens packs and rule packs as shareable, versioned packages: *Danish clinic*, *law firm*, *construction SME*, *SaaS startup*, *ISO 27001 pack*, *NIS2 pack*. A new company starts from a template that already knows its industry's capabilities, processes, rules and lenses.

### 11.13 Explain the company — as a film
We already produced a narrated film of My Graph from the product itself. The same pipeline can produce **"how this company works"** — a short narrated film generated from the operating model and real (permitted) examples, for onboarding, for investors, for a new board member. Regenerated each quarter.

### 11.14 The company as a city
A spatial view of the enterprise: capabilities as districts, processes as roads, activity as traffic, risk as weather, people as lights in windows. Walk through it, fly over it, see a district go dark when its only expert is on holiday. Not a gimmick: humans read space faster than tables.

### 11.15 Knowledge that stays when people leave
When someone leaves, their part of the graph — decisions, commitments, customers, know-how — is **handed over by proposal** to the people who inherit their roles, with a briefing generated from what they actually did. What they bring with them to their personal graph is explicit and consented (cross-graph objects), so the boundary between "mine" and "the company's" is clear and fair.

### 11.16 Ask the company anything — and get a lens back
Every question to the assistant can return **a lens**, not just an answer: "how do we handle refunds?" returns the process as it really runs, the rule, the owner, the last five cases and where they deviated — saved as a lens you can share. The company's knowledge becomes navigable by question.

### 11.17 Decisions with a pre-mortem
Before a decision is taken, the graph runs a **pre-mortem**: which earlier decisions it contradicts, which rules it touches, which commitments it changes, which people it affects, what happened the last time something similar was decided. After the decision, it schedules its own **review** ("check in 90 days whether this worked") with the signals to judge it by.

### 11.18 The organisation's immune system
Patterns that preceded trouble before — a key customer going quiet, an overloaded capability, promises piling up on one person, a rule bent repeatedly — are learned from the company's own history and flagged early, with the evidence. Not surveillance of people: signals about the work, owned and seen by the people doing it.

---

## 12. Architecture

### 12.1 Data model (additive)

| Object | Where | Notes |
| --- | --- | --- |
| Capability, Process, Activity, Goal | meta model (like `meta_roles`): `meta_capabilities`, `meta_processes`, `meta_goals` — or node types with a model flag; decide in design | Built-ins per template; household/organisation-wide or per graph; emergent via `addCapability` / `addProcess` change ops; history |
| Decision | node type `decision` | Rationale, alternatives, status (proposed / taken / superseded / reviewed), review date |
| Signal | definition in lens or meta (`meta_signals`), values computed | Never stored as truth; cached with the facts they came from |
| Anchors | edges `realizes` (fact → capability), `in_process` (fact → process/step), `performed_by` (step → role) | Proposed by agents; pattern rules in a `anchor_rules` table with history |
| Lens | artifact kind `lens` (registry in `src/lib/artifacts/kinds.ts`) | YAML/JSON definition + rendering; versioned; visibility like artifacts |
| Discovered process | computed from `graph_events` + anchored facts; snapshot as a lens result | Conformance vs designed process |

### 12.2 Engines

- **Anchoring engine** — runs after ingest/delivery; applies pattern rules; asks the model only when unsure; proposes anchors in the same change set as the source's other proposals.
- **Lens engine** — compiles a lens to scoped queries (viewer, graph, period, as-of date), computes measures, attaches receipts, renders the chosen representation; caches by (lens version, graph version, viewer).
- **Process discovery** — orders anchored events per case (an order, a complaint, a hire) into traces; derives the discovered process; computes conformance against the designed one.
- **Model health** — the self-healing checks (11.4) as scheduled jobs that propose.

### 12.3 Interfaces

- `/model` — the operating model: capabilities, processes, goals, roles, rules, with history.
- `/lenses` (inside Artifacts) — lenses, built-in and saved; "New lens" from speech or form.
- Ask — returns lenses; page actions on lenses (assign owner, accept discovered process).
- MCP server — new tools `list_capabilities`, `run_lens`, `what_applies`, `why_decided`, scoped like today.
- Search — capabilities, processes, decisions and lenses as sections.

---

## 13. Trust, privacy and governance

- **Viewer-scoped always.** A lens shows only what the viewer may read; aggregates never reveal what the viewer could not see item by item.
- **About the work, not surveillance of people.** Signals are about capabilities and processes; person-level signals are visible to the person themself first (as in "You"), never ranked for management by default.
- **Proposals, receipts, history.** Every model change and every action from a lens is a change set; every number has receipts; every view can be seen as of any date.
- **Templates are suggestions.** Nothing from a template is binding until the company adopts it.
- **Crossings are explicit.** Federated lenses and auditor access are consented, time-bound and logged.

---

## 14. Roadmap

| Phase | Delivers | Builds on |
| --- | --- | --- |
| **1. The language** | Capabilities, processes, goals in the meta model; decision node type; SME edition of the reference model (en/da) as the work template; `/model` page | Meta model, roles, rules, commitments |
| **2. Anchoring** | Anchoring engine; pattern rules; unanchored queue; anchors in ingest and connectors | Importers, connectors, change sets |
| **3. Lenses** | Lens language v1; lens engine; five built-in lenses (EA, customer service, finance, compliance, management) + onboarding; lenses as artifacts | Artifacts, history, search |
| **4. Living views** | As-of and diff for lenses; "present that" to decks; meetings on lenses | Artifacts, Record, history |
| **5. Discovery** | Discovered processes and conformance; model health (self-healing) | graph_events, anchoring |
| **6. Wild** | Company as code (branches of the model), contracts that watch themselves, regulatory foresight, agents in the org chart, auditor mode, federated lenses, benchmarks, marketplace, the city view, the company film | Everything above |

Phase 1 and 2 are the foundation; Commitments (being built now) plugs straight in — a commitment is anchored to a process step and owned by a role.

---

## 15. Open decisions

1. **Reference model and licence** — APQC PCF (confirm terms and attribution) vs our own SME edition aligned to it.
2. **Model objects as meta tables or as nodes** — meta tables keep the model separate and versioned like kinds; nodes make the model itself traversable in the same graph. Proposal: meta tables for the *types*, nodes for the *company's own instances* (its capabilities and processes), so both are graph and both have history.
3. **Lens language surface** — YAML only for experts, a form for everyone, speech via the assistant; which one is primary in the UI.
4. **Names people see** — "Operating model" / "Sådan arbejder vi"? "Lenses" / "Visninger"? "Capabilities" / "Evner"? To be tested with real users in Danish.
5. **First industry editions** — which three after the generic SME edition (clinic, law firm, SaaS?).
6. **Benchmarks** — whether and when to offer cross-company aggregates, and the privacy threshold.

---

*Sources of inspiration: APQC Process Classification Framework; capability-based planning (BIZBOK); ISO/IEC/IEEE 42010 and ArchiMate viewpoints; process mining (discovered vs designed processes); Nexus (rules, controls, evidence, exceptions, "what applies", plans as branches) — see the Rules work in `src/lib/corpus`.*
