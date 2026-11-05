# The self-describing enterprise

**A proposal for My Graph's operating-model layer: one language for how any business works, lenses for every function, and a company that keeps its own map up to date.**

Draft v2 · 5 Nov 2026 · Status: proposal for review · Owner: the founder · Related: `PROPOSAL.md`, `docs/versioning-plan.md`, `docs/commitments.md`

---

## 1. In one page

My Graph already holds what actually happens in a company — mail, meetings, chats, documents, decisions, customers, systems — every fact with its source, its history and a person who approved it. What it does not yet hold is **how the company is meant to work**: what it can do, how it does it, who does it, under which rules, towards which goals. Every company keeps that in drawings that are out of date the month they are made.

This proposal adds that second world **to the same graph**, in a small, universal grammar, and lets the first world keep it alive:

1. **Facts** — what is (built).
2. **The operating model** — how a business works, expressed in our own **Enterprise Kernel** (section 5): nine questions every organisation answers (why, for whom, what, how, who, with what, under which rules, how well, what is changing), a fixed grammar of relations and five laws. Established frameworks — APQC, BIZBOK, ITIL, COBIT, IT4IT, SAFe, OKR, COSO, Team Topologies and more — become optional, licence-aware **packs** mapped onto the kernel. Seeded from our own SME edition, then grown from evidence.
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

## 5. The overarching framework: the Enterprise Kernel

Every established framework describes a business well **along one or two axes** — APQC the activities, BIZBOK the capabilities, ITIL the services, COBIT the governance, SAFe the delivery of change, COSO the controls, OKR the goals, Team Topologies the teams. None describes the whole, none is anchored in evidence, all are drawn by hand, and several cannot be shipped inside a product. So we do not pick one. We define **our own small kernel** that every business shares — from a family to an enterprise — and treat the established frameworks as **packs**: optional, mapped, licence-aware views onto the same kernel.

### 5.1 What we studied, and what each brings

| Framework | Describes | What we take | What it lacks for us | Licence / openness (verify before shipping) |
| --- | --- | --- | --- | --- |
| **APQC PCF** (cross-industry + industry PCFs) | Activities: 13 categories, ~1,000 processes, 5 levels | A complete, numbered activity tree; industry variants; benchmarks | Activities only — no capabilities, goals, controls, evidence | Cross-industry reported royalty-free with attribution; industry PCFs (co-developed with IBM) carry their own terms |
| **BIZBOK** (Business Architecture Guild) | Capabilities, value streams, information concepts, stakeholders | Capability ≠ process; value streams as stakeholder value stages; capability × value-stream matrix | Members-only; static maps | Restricted: vendor licence needed, no redistribution — **do not ship**; import if the customer is licensed |
| **TOGAF / ArchiMate** (The Open Group) | Architecture method; layered language (motivation, strategy, business, application, technology, implementation) | Layers; motivation elements (driver, goal, outcome, principle, requirement); viewpoints | A notation and method, not a living model | Open Group terms — use concepts, not text |
| **ISO/IEC/IEEE 42010** | Stakeholders, concerns, viewpoints, views | The lens idea itself | Abstract | Standard — concepts only |
| **IT4IT** (The Open Group) | IT as a value chain: Strategy→Portfolio, Requirement→Deploy, Request→Fulfil, Detect→Correct | Value streams with data objects that flow between them | IT only | Open Group terms — concepts only |
| **ITIL 4** (PeopleCert/Axelos) | Service value system: guiding principles, value chain (plan, improve, engage, design & transition, obtain/build, deliver & support), 34 practices | Services and value co-creation; the six value-chain activities | Heavy, IT-centred | Copyrighted — concepts only, no text |
| **COBIT 2019** (ISACA) | Governance (EDM) vs management (APO, BAI, DSS, MEA) objectives; design factors; capability levels | The split between *governing* and *managing*; objectives as controllable goals; design factors that tailor | IT governance; dense | Copyrighted — structure-level mapping, licensed customers import |
| **SAFe** | Portfolio, operational vs development value streams, lean budgets, epics, PI planning | Operational vs development value streams; lean portfolio; initiatives funded by value stream | Big-company ceremony | Trademark + licence — concepts only, never branded content |
| **Scrum / Kanban / Lean / VSM** | Flow of work, WIP, waste, lead time | Flow metrics; value-stream mapping; cases flowing through steps | No enterprise structure | Open concepts |
| **Porter value chain** | Primary vs support activities | Primary/support split for the SME map | Pre-digital, coarse | Public concept |
| **Business Model Canvas / Value Proposition** | Customers, value, channels, revenue, costs, partners | The "for whom / why" axis; offerings and segments | No operations | Concepts (canvas under CC BY-SA) |
| **OKR / Balanced Scorecard / EFQM** | Goals, key results, perspectives, excellence | Goal → outcome → signal chain; four perspectives as default lens groups | Disconnected from the work | Public concepts (EFQM model licensed) |
| **COSO / ISO 31000 / Three Lines** | Internal control, risk management, who checks whom | Risk ↔ control ↔ evidence; three lines as role pattern | Paperwork-heavy | Concepts only |
| **ISO 9001 / ISO 27001 / NIST CSF / NIS2 / GDPR** | Quality, security, cyber, privacy | As **rule packs** (we already read laws into Rules) | Each one silo | Laws free (EUR-Lex, retsinformation); ISO text copyrighted — customers bring their copy; NIST public domain |
| **SCOR** (ASCM) | Supply chain: plan, source, make, deliver, return, enable | Industry pack for physical goods | Supply chain only | Licensed |
| **eTOM / TM Forum** | Telecom process framework | Industry pack pattern | Telecom only | Member licence |
| **BPMN / DMN / CMMN** (OMG) | Notation for processes, decisions, cases | Process steps, decision tables, case management as views | Notation, not content | Open specifications |
| **Team Topologies** | Stream-aligned, platform, enabling, complicated-subsystem teams; interaction modes | Team types and interaction modes on the "who" axis | Teams only | Concepts |
| **Domain-Driven Design** | Bounded contexts, ubiquitous language | Each function's vocabulary = a bounded context → lens glossary | Software-centred | Concepts |
| **Viable System Model** (Stafford Beer) | A self-regulating organisation: operations, coordination, control, intelligence, policy | The cybernetic loop that makes the kernel self-steering (5.4) | Abstract | Concepts |
| **Wardley maps** | Value chain × evolution (genesis → commodity) | Evolution as a property of capabilities ("build, buy, rent") | Strategy only | CC BY-SA |
| **Cynefin** | Clear / complicated / complex / chaotic contexts | Decision context on decisions (how to decide) | No structure | Concepts |
| **Jobs-to-be-done** | Customer jobs and outcomes | "For whom / why" from the customer's side | No operations | Concepts |
| **McKinsey 7S** | Strategy, structure, systems, shared values, style, staff, skills | Values and skills as first-class | Consultancy framing | Concepts |
| **RACI / DACI** | Who is responsible, accountable, consulted, informed | Responsibility edges on everything | A matrix, not a model | Concepts |
| **PMBOK / PRINCE2** | Projects | Initiatives and change as branches | Projects only | Concepts |
| **DORA / SPACE** | Delivery performance | Signals for the software-delivery pack | Software only | Public research |

**What they all agree on:** a business has a *purpose*, serves *someone*, has stable *capabilities*, runs *flows* of work, organises *people and teams*, uses *information, systems and money*, is *governed* by rules and risks, is *measured* against goals, and *changes* through initiatives.

**What none of them does:** stay true by itself. Every one of them is a model people maintain by hand, disconnected from the evidence of what actually happens. None handles promises (commitments), none spans a family and an enterprise, none is federated between organisations, and none puts AI agents in the picture as accountable actors. That is the gap the Enterprise Kernel fills.

### 5.2 The Enterprise Kernel: nine questions every organisation answers

The kernel is the smallest set of object types and relations that lets any of the frameworks above be expressed — and lets the graph's facts anchor to them. It is organised as **nine questions**:

| # | Question | Kernel objects | Inspired by |
| --- | --- | --- | --- |
| 1 | **Why?** | Purpose · Value (principle) · Driver · Goal · Outcome | ArchiMate motivation, OKR, 7S |
| 2 | **For whom?** | Stakeholder · Customer segment · Offering (product/service) · Job to be done | BMC, JTBD, ITIL services, BIZBOK stakeholders |
| 3 | **What can we do?** | Capability (with level and evolution) | BIZBOK, Wardley, COBIT capability levels |
| 4 | **How does work flow?** | Value stream · Process · Activity · **Case** (one instance: an order, a complaint, a hire) | APQC, IT4IT, SAFe, Lean, CMMN |
| 5 | **Who?** | Person · Role · Team (type) · Unit · Partner · **Agent** (AI) | RACI, Team Topologies, three lines |
| 6 | **With what?** | Information object · System · Asset · Budget / money flow | ArchiMate application/technology, Porter support activities |
| 7 | **Under which rules?** | Rule (law, policy, standard, contract term) · Control · Risk · **Decision** · **Commitment** · **Evidence** | COSO, ISO 31000, COBIT, ADRs, Nexus |
| 8 | **How well?** | Signal · Target · Observation | BSC, DORA, flow metrics, EFQM |
| 9 | **What is changing?** | Initiative · Change (branch of the model) · Plan · Release | SAFe/PMBOK, our change sets |

Plus two dimensions that run through all nine: **time** (every object and edge has history; the model can be read *as of* any date) and **evidence** (every object can be anchored to the facts that show it is real).

### 5.3 The kernel's relations (its grammar)

A small, fixed vocabulary of typed relations — the same in every graph, labelled per lens and language:

| Relation | From → To | Reads as |
| --- | --- | --- |
| `serves` | Offering / Value stream → Stakeholder | "delivers value to" |
| `realises` | Process / Activity → Capability | "is how we do" |
| `stage_of` | Process → Value stream | "is a stage of" |
| `part_of` | any → same kind | decomposition (capability levels, process levels) |
| `flows_through` | Case → Process / Activity | "went through" (with timestamps) |
| `performs` | Role / Team / Agent → Activity | "does" |
| `holds` | Person → Role (in a context, over time) | already built (roles) |
| `owns` | Role / Person → any | accountability (the A in RACI) |
| `uses` · `produces` · `consumes` | Activity → System / Information | "with", "makes", "needs" |
| `governs` | Rule → Capability / Process / Offering / System | "applies to" |
| `controls` | Control → Risk / Rule | "keeps in check" |
| `threatens` | Risk → Goal / Capability | "puts at risk" |
| `proves` | Evidence → Control / Rule / Commitment | "shows it is met" |
| `decides` | Decision → any | "settled" (with rationale, alternatives) |
| `commits` | Commitment → Stakeholder / Case | "we promised" (already built) |
| `measures` | Signal → Goal / Capability / Process | "tells us how it goes" |
| `contributes_to` | Outcome / Capability → Goal | "helps achieve" |
| `changes` | Initiative → any | "will alter" (a branch of the model) |
| `depends_on` | any → any | dependency |
| `anchored_in` | any model object → fact (message, document, meeting, event) | "we know this because" |

### 5.4 The kernel's laws

Five rules the kernel enforces — each a built-in rule (Rules) whose breaches show up as proposals, not as errors:

1. **Everything is anchored.** A model object without evidence is a hypothesis and is shown as one.
2. **Every capability has an owner and a reason.** No owner → proposal to assign one; no goal it contributes to → question to the owner.
3. **Every rule has a control, and every control has proof.** Missing or expired proof is a commitment someone owns.
4. **Every case runs through a value stream.** Work that fits no stream reveals a capability nobody named yet.
5. **Every change is a branch.** The model is never edited in place; reorganisations, new processes and new rules are change sets with impact, reviewed and delivered by people.

### 5.5 The self-steering loop (from the Viable System Model)

Stafford Beer's Viable System Model describes what any organisation needs to stay alive. The kernel maps it onto features we already have or are building, so the company **steers itself with people in the loop**:

| VSM system | What it does | In My Graph |
| --- | --- | --- |
| **1 · Operations** | Do the work | Cases flowing through processes; commitments being kept |
| **2 · Coordination** | Stop parts colliding | Clash detection (commitments watch), shared calendars, double-coverage alerts |
| **3 · Control** | Keep operations within rules and resources | Rules, controls, evidence, budgets; the self-healing model checks |
| **3\* · Audit** | Look directly, sporadically | Auditor mode; "who said this"; history at a date |
| **4 · Intelligence** | Look outside and ahead | Regulatory foresight, web research, connectors, benchmarks, what-if |
| **5 · Policy** | Identity, purpose, balance between now and next | Purpose, values, goals; the strategy compiler; decisions with pre-mortems |

### 5.6 Packs: every framework as an optional view onto the kernel

A **pack** = a template (objects to seed) + a mapping (pack concept → kernel type and relation) + lenses + rules. Packs are versioned, licence-tagged, and can be combined. The kernel is ours, so the product never depends on one licensor.

| Pack | Maps onto the kernel as | Ships |
| --- | --- | --- |
| **SME edition** (ours, 5.7) | Capabilities + processes for any small business, mapped to APQC numbers for interoperability | Built in |
| **APQC PCF cross-industry** | Process tree with PCF ids → Process/Activity, `realises` our capabilities | If the licence allows embedding, with attribution; otherwise import of the customer's download |
| **APQC industry PCFs** | Same, per industry | Import only (separate terms) |
| **BIZBOK capability maps** | Capabilities, value streams, information concepts | Import only for licensed customers |
| **ITIL-style service management** | Offerings (services), value-chain stages, practices as capabilities | Our own wording, concepts only |
| **IT4IT-style IT value chain** | Four IT value streams with their data objects | Our own wording |
| **COBIT-style governance** | Governance vs management objectives → Goals + Rules + Controls with capability levels | Structure-level; licensed customers import the text |
| **SAFe-style portfolio** | Operational / development value streams, initiatives, lean budgets | Concepts only |
| **Team Topologies** | Team types and interaction modes on Team and `depends_on` | Concepts only |
| **OKR / Balanced Scorecard** | Goals, outcomes, signals, four perspectives as lens groups | Built in |
| **Rule packs**: GDPR, Danish Bookkeeping Act, Working Environment Act, NIS2, ISO 27001 / 9001, NIST CSF | Rules (read from a link) + controls + evidence | Laws built in from official sources; ISO from the customer's own copy |
| **Industry packs** (later): clinic, law firm, construction, SaaS, retail, school, municipality | SME edition + industry capabilities + rule packs + lenses | Ours |
| **Family, personal, practice** | The same kernel at household scale (5.8) | Built in |

### 5.7 The SME edition (our own default capability map)

Thirteen domains, written by us in plain words (English and Danish), each mapped to APQC categories for interoperability. Primary domains create value for customers; support domains keep the company able to.

| Domain | Capabilities (level 2) | ≈ APQC |
| --- | --- | --- |
| **Direction** | Purpose and values · Strategy · Goals and priorities · Portfolio of initiatives · Board and owners | 1, 13 |
| **Market and customers** | Understand customers · Brand and marketing · Segments and offerings · Pricing | 2, 3 |
| **Sales** | Find leads · Quote and win · Contracts with customers · Key accounts | 3 |
| **Offerings** | Design products and services · Develop and improve · Launch and retire | 2 |
| **Delivery** | Plan delivery · Produce or perform · Deliver and install · Quality | 4, 5 |
| **Customer care** | Answer and help · Complaints and claims · Returns and warranties · Customer feedback | 6 |
| **People** | Recruit · Onboard · Develop and review · Pay and benefits · Working environment · Leave and offboard | 7 |
| **Money** | Budget and forecast · Invoice and collect · Pay suppliers · Bookkeeping and closing · Tax and VAT · Funding and cash | 9 |
| **Information and technology** | Systems and tools · Data and documents · Security · Support | 8 |
| **Assets and places** | Premises · Equipment and vehicles · Maintenance | 10 |
| **Risk and compliance** | Laws and rules · Data protection · Internal control · Insurance · Incidents and continuity | 11 |
| **Partners and suppliers** | Choose suppliers · Purchase · Supplier contracts · Partnerships | 4, 12 |
| **Change and improvement** | Ideas and improvements · Projects · Process improvement · Knowledge and learning | 13 |

Depth grows only where the company's own evidence asks for it: anchoring (section 6) proposes level-3 capabilities and processes when enough facts cluster under a level-2 one.

### 5.8 The same kernel in every graph kind

The kernel is fractal: the nine questions apply to a family as much as to a company — only the template and the depth differ.

| Template | Why | For whom | What (capabilities) | How (flows) | Under which rules | Typical lenses |
| --- | --- | --- | --- | --- | --- | --- |
| **Work (SME)** | Purpose, goals | Customers, owners, staff | SME edition | Order-to-cash, hire-to-retire, complaint handling | Laws, policies, contracts | EA, customer service, finance, HR, compliance, management |
| **Practice** (clinic, therapist) | Good care | Clients, patients, referrers | Treat, keep records, manage consent, bill | Referral → intake → sessions → closure | Health law, GDPR, consent | Clinician, practice manager, data protection |
| **Family** | A good life together | The family members | Run the home, raise the children, health, money, keep in touch | School year, moving house, insurance renewal | House rules, school rules, tenancy law | Who does what at home, family admin, money |
| **Personal** | My goals | Me | Work, learn, health, home, relationships | Job search, training plan | My own rules | You, life admin |
| **Project** | The project's goal | Sponsor, users | The deliverables | Plan → build → review → deliver | Contract, standards | Status, risks, decisions |

### 5.9 Why this is new

- **Evidence-anchored:** every box on every map is backed by facts, or visibly marked as a hypothesis.
- **Live and dated:** maps change as work changes, and can be read as of any date and compared.
- **One kernel, many frameworks:** APQC, ITIL, COBIT, SAFe, OKR and the rest become lenses on one model rather than competing repositories.
- **Promises and decisions are first-class:** commitments and decisions sit in the model next to processes and rules.
- **Humans and agents in one org model:** AI agents hold roles, perform activities, are governed by rules and owned by people.
- **Family to enterprise:** the same nine questions, the same machinery, different templates.
- **Federated:** two organisations can share a lens on their kernels without sharing their graphs.
- **Licence-safe:** the kernel and the SME edition are ours; third-party frameworks are packs that ship only where their terms allow.

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
| **1. The language** | The Enterprise Kernel in the meta model (nine questions, the relation grammar, the five laws as built-in rules); decision node type; the SME edition (en/da) as the work template; `/model` page; first packs (OKR, rule packs) | Meta model, roles, rules, commitments |
| **2. Anchoring** | Anchoring engine; pattern rules; unanchored queue; anchors in ingest and connectors | Importers, connectors, change sets |
| **3. Lenses** | Lens language v1; lens engine; five built-in lenses (EA, customer service, finance, compliance, management) + onboarding; lenses as artifacts | Artifacts, history, search |
| **4. Living views** | As-of and diff for lenses; "present that" to decks; meetings on lenses | Artifacts, Record, history |
| **5. Discovery** | Discovered processes and conformance; model health (self-healing) | graph_events, anchoring |
| **6. Wild** | Company as code (branches of the model), contracts that watch themselves, regulatory foresight, agents in the org chart, auditor mode, federated lenses, benchmarks, marketplace, the city view, the company film | Everything above |

Phase 1 and 2 are the foundation; Commitments (being built now) plugs straight in — a commitment is anchored to a process step and owned by a role.

---

## 15. Open decisions

1. **Packs and licences** — the kernel and SME edition are ours; confirm APQC's current cross-industry terms (embed with attribution vs import only), and keep BIZBOK, COBIT, ITIL, SAFe, SCOR and ISO content as customer-licensed imports or concept-level mappings.
2. **Model objects as meta tables or as nodes** — meta tables keep the model separate and versioned like kinds; nodes make the model itself traversable in the same graph. Proposal: meta tables for the *types*, nodes for the *company's own instances* (its capabilities and processes), so both are graph and both have history.
3. **Lens language surface** — YAML only for experts, a form for everyone, speech via the assistant; which one is primary in the UI.
4. **Names people see** — "Operating model" / "Sådan arbejder vi"? "Lenses" / "Visninger"? "Capabilities" / "Evner"? To be tested with real users in Danish.
5. **First industry editions** — which three after the generic SME edition (clinic, law firm, SaaS?).
6. **Benchmarks** — whether and when to offer cross-company aggregates, and the privacy threshold.

---

*Sources of inspiration: APQC Process Classification Framework; BIZBOK; TOGAF and ArchiMate; IT4IT; ITIL 4; COBIT 2019; SAFe; Lean and value-stream mapping; Porter's value chain; Business Model Canvas; OKR, Balanced Scorecard, EFQM; COSO, ISO 31000 and the Three Lines; ISO 9001/27001, NIST CSF; SCOR; eTOM; BPMN/DMN/CMMN; Team Topologies; Domain-Driven Design; Stafford Beer's Viable System Model; Wardley maps; Cynefin; Jobs-to-be-done; McKinsey 7S; RACI; PMBOK/PRINCE2; DORA; capability-based planning (BIZBOK); ISO/IEC/IEEE 42010 and ArchiMate viewpoints; process mining (discovered vs designed processes); Nexus (rules, controls, evidence, exceptions, "what applies", plans as branches) — see the Rules work in `src/lib/corpus`.*

---

## Appendix A: Fifty sources of inspiration

Grouped by the kernel question they mostly inform. Each line: the source, and what we take from it.

**Activities, processes and value streams (How?)**
1. **APQC Process Classification Framework** — a complete, numbered activity tree (13 categories, ~1,000 processes), industry variants, benchmarks.
2. **IT4IT (The Open Group)** — the IT value chain as four value streams with the data objects that flow between them.
3. **SCOR (ASCM)** — supply chain as plan, source, make, deliver, return, enable.
4. **eTOM / TM Forum Frameworx** — an industry process framework done at depth (telecom).
5. **Lean and value-stream mapping** — flow, waste, lead time, the customer's view of the work.
6. **Kanban** — work in progress limits and flow metrics on any process.
7. **BPMN 2.0 (OMG)** — a shared notation for process steps and handovers.
8. **CMMN (OMG)** — case management for work that doesn't follow a fixed path.
9. **Process mining (van der Aalst; Celonis, ProM)** — discovering the real process from event logs and checking conformance.
10. **Porter's value chain** — primary vs support activities.

**Capabilities and architecture (What can we do?)**
11. **BIZBOK (Business Architecture Guild)** — capabilities, value streams, information concepts and their matrix.
12. **TOGAF (The Open Group)** — the architecture development method and content metamodel.
13. **ArchiMate (The Open Group)** — layered modelling language with motivation, strategy and implementation elements.
14. **ISO/IEC/IEEE 42010** — stakeholders, concerns, viewpoints and views: the basis of lenses.
15. **Zachman Framework** — the six interrogatives (what, how, where, who, when, why) across perspectives.
16. **Capability-based planning** — investing by capability gaps rather than projects.
17. **Wardley maps** — capabilities on an evolution axis (genesis → custom → product → commodity).
18. **Domain-Driven Design** — bounded contexts and a ubiquitous language per domain: the lens glossary.

**Services and IT management**
19. **ITIL 4** — the service value system, value co-creation and the service value chain.
20. **COBIT 2019 (ISACA)** — governance vs management objectives, design factors, capability levels.
21. **ISO/IEC 20000** — service management as a certifiable system.
22. **VeriSM** — service management across the whole organisation, not just IT.
23. **DORA / Accelerate** — delivery performance signals (lead time, deployment frequency, change failure, recovery).
24. **SPACE framework** — developer productivity beyond output counts.

**Strategy, goals and measurement (Why? How well?)**
25. **OKR (Grove, Doerr)** — objectives and measurable key results.
26. **Balanced Scorecard (Kaplan & Norton)** and **strategy maps** — four perspectives and cause-and-effect between goals.
27. **EFQM Model** — direction, execution, results as a cycle of excellence.
28. **Hoshin Kanri** — strategy deployed level by level with catchball.
29. **Business Model Canvas and Value Proposition Canvas (Osterwalder)** — customers, value, channels, revenue and costs on one page.
30. **Jobs-to-be-done (Christensen, Ulwick)** — the customer's job and desired outcomes.
31. **Playing to Win (Lafley & Martin)** — strategy as a cascade of choices.
32. **Theory of Constraints (Goldratt)** — the bottleneck decides the throughput.

**People, teams and organisation (Who?)**
33. **Team Topologies (Skelton & Pais)** — team types and interaction modes.
34. **RACI / DACI** — responsibility and decision roles on every item.
35. **McKinsey 7S** — shared values, skills and style next to structure and systems.
36. **Sociocracy / holacracy** — roles and circles as explicit, changeable structure.
37. **Viable System Model (Stafford Beer)** — operations, coordination, control, intelligence and policy: the self-steering loop.

**Governance, risk, control and compliance (Under which rules?)**
38. **COSO Internal Control and ERM** — control environment, risk assessment, control activities, information, monitoring.
39. **ISO 31000** — risk management principles and process.
40. **The Three Lines model (IIA)** — who does, who oversees, who assures independently.
41. **ISO 9001** — the process approach and plan-do-check-act.
42. **ISO/IEC 27001 and NIST Cybersecurity Framework 2.0** — security as governed, evidenced controls.
43. **GDPR and NIS2** — data protection and cyber obligations as rule packs read from the law itself.
44. **Architecture Decision Records (Nygard)** — decisions with context, options and consequences.
45. **Nexus (our own)** — requirements, controls, evidence that expires, exceptions with end dates, "what applies", plans as branches.

**Change and delivery (What is changing?)**
46. **SAFe** — operational vs development value streams, lean portfolio management, epics.
47. **PMBOK and PRINCE2** — projects, stages, tolerances and governance of change.
48. **Scrum** — short cycles, review and adapt.

**Thinking tools**
49. **Cynefin (Snowden)** — choosing how to decide by the kind of situation.
50. **Systems thinking (Senge, Meadows)** — feedback loops, delays and leverage points behind the signals.
