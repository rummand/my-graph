# Commitments ("Aftaler og frister")

Everything the household owes, is owed, or was promised, from every source, with proof, an owner and early warning.
Agents propose, humans decide; provenance on everything; everything is a graph; graphs never leak.

Three workstreams build it against one contract, `src/lib/commitments/types.ts`:

| Workstream | Owns |
| --- | --- |
| LEDGER (this doc's author) | `src/lib/commitments/*.ts` (except detect/, watch/), node-type plumbing, migration `0029_commitments_node`, `/commitments`, `/api/commitments/**`, `src/components/commitments/**`, Today line, Ask page actions, search section |
| DETECTION | `src/lib/commitments/detect/**` + small hooks in `src/lib/ingest/pipeline.ts` |
| WATCH | `src/lib/commitments/watch/**` (clashes, contradictions, fulfilment, risk signals, morning line) |

## The graph shape

A commitment is a node of `type: "commitment"` (a new `node_type` enum value, migration `drizzle/0029_commitments_node.sql`).

- `label`: one plain sentence from the household's side ("Reply to Vejle Kommune about Emma's school transport").
- `startAt`: when it is due (same as `props.dueAt`; null when no date is known yet).
- `kind` (the meta kind): the same as `props.kind`. Built-in meta kinds for `commitment`: reply, payment, renewal,
  notice, appointment, form, deliver, return, other (en + da in `src/lib/meta/builtins.ts`, `people.kindName`).
- `props`: `CommitmentProps` (types.ts). The ledger reads them with `readProps()` (defensive, falls back to startAt/kind).
- `visibility`: default `household` (ops.ts). Use `parents` + `sensitive: true` for health, money and legal matters
  a child shouldn't see.

Edges (built-in relations in the meta model, en + da labels):

| Edge | Meaning |
| --- | --- |
| person `responsible_for` → commitment | who has to do it (for `owed`: who it is owed to) |
| commitment `with` → person/organisation/place | the other party |
| commitment `about` → anything | what it concerns (built-in `about` now also allows `commitment` as from-type) |
| commitment `arises_from` → document/rule/event/message node | where it comes from |
| commitment `clashes_with` → commitment/event (symmetric) | found by WATCH, proposed like anything else |

### Additive props the ledger added to `CommitmentProps`

All optional; nothing existing changed.

| Prop | Set by | Meaning |
| --- | --- | --- |
| `snoozedUntil` | ledger (Snooze) | the reminder moves here; the due date does not. While in the future the commitment is not "at risk". |
| `progressAt`, `progressNote` | ledger ("I've started"), WATCH (`withSignal`) | someone has done something about it: not "at risk" |
| `doneNote` | ledger (Done) | the note given when marked done |
| `cancelledAt`, `cancelReason` | ledger (Drop / Not mine) | `not_mine` · `not_a_commitment` · `duplicate` · `cancelled`. **DETECTION: don't propose again what a person dropped** — match on `fingerprint` (or `fingerprintWithoutDay`) against cancelled ones with `not_a_commitment` / `duplicate` / `not_mine`. |
| `previousId` | ledger (roll-forward) | the occurrence this one rolled forward from |

## API for DETECTION and WATCH

Server: `import { … } from "@/lib/commitments"`. Pure (also in the browser): `@/lib/commitments/pure`, `@/lib/commitments/ops`.

### Proposing a new commitment — `commitmentOps(draft)` (ops.ts, pure)

```ts
import { commitmentOps, type CommitmentDraft } from "@/lib/commitments/ops";
const { nodeId, ops } = commitmentOps({
  label, direction: "owe", kind: "reply", dueAt: "2026-11-14T22:59:00.000Z", dueKind: "deadline",
  amount: { value: 1250, currency: "DKK" }, consequence: "…", fingerprint,
  responsibleIds: [annaId], withIds: [kommuneId] /* or newCounterparty: { label, type: "organization" } */,
  aboutIds: [emmaId], arisesFromIds: [letterNodeId],
  visibility: "household", sensitive: false,
  receipt: { sourceId, chunkId, quote, locator: { page: 1 }, confidence: 0.8 },  // on every op
  note: "Why, in words",
});
await proposeChanges(v, { title: `From “${sourceTitle}”`, origin: "ingest", changes: ops });
```

- `nodeId` is minted up front, so more ops can point at it (an `addReminder`, a `clashes_with` edge).
- Leave `leadDays` out to get the kind's default (`DEFAULT_LEAD_DAYS`).
- **Reminders:** you don't need an `addReminder` op. The ledger creates the reminder when the commitment is in the
  graph (at `dueAt − leadDays`, `reminders.node_id = commitment id`). If you do add one (or the pipeline already
  made one from the same source), the ledger **adopts** it instead of making a second: an open reminder with
  `node_id` null, the same `source_id` as one of the commitment's sources, and the same day (due day or reminder
  day) or ≥60 % of the same words (`matchReminder` / `planReminder` in pure.ts).
- The ledger's "Waiting for you" picks up any draft change set that has an included `addNode` with
  `type: "commitment"` (`waitingProposals`).

### Reading

| Function | What |
| --- | --- |
| `loadCommitments(v, { ids?, status?, personId?, limit? })` | `CommitmentView[]` the viewer may read in the current graph: props, `responsible` / `counterparty` / `about` / `arisesFrom` / `clashes` (readable parties only, with `edgeId`), `sources` (readable passages with `href` to the exact passage), `reminder`, `canEdit` |
| `getCommitment(v, id)` | one, or null |
| `loadLedger(v, { now, tz, personId })` | everything the /commitments page shows, and syncs reminders |
| `todayCommitments(v, { now, tz, max })` | `{ counts, urgent }` for Today |
| `personCommitments(v, personId)` | open ones a person is responsible for, most urgent first |
| `commitmentContext(v, { days: 14 })` | compact lines for the assistant |
| `waitingProposals(v)` | draft change sets adding commitments |

### Pure helpers (`@/lib/commitments/pure`)

`readProps`, `leadDaysOf`, `dayKey`, `daysUntil` (calendar days in `Europe/Copenhagen` by default), `urgencyOf`
(overdue / at_risk / this_week / later / undated; null when not open), `groupByUrgency`, `groupByPerson`,
`groupByDirection`, `groupByKind`, `filterTab`, `filterPerson`, `countLedger`, `parseRRule`, `nextOccurrence`,
`moveFingerprint`, `rollForwardOps`, `reminderDueAt`, `matchReminder`, `planReminder`, `forViewer`, `onlyReadable`,
`formatAmount`, `assistantLine`.

**Urgency rules** (`urgencyOf`): overdue when its calendar day has passed; at risk when due within `leadDays` and no
`progressAt` and not snoozed (appointments are never at risk on their own); this_week = due in the next 7 days;
later; undated. WATCH's `withSignal` folds a progress signal into `progressAt` so `urgencyOf` sees it.

### Person actions (ledger only)

`actOnCommitment(v, id, action)` — `done` (note, evidenceSourceId), `reopen`, `snooze` (until), `progress` (note),
`reassign` (personId), `edit` (label, dueAt, amount, consequence, leadDays, recurrence), `cancel` (reason, note).
Each is a change set the person authors (origin `person`) and delivers at once (allowed caller in the
"who may deliver" test). If they may read but not change it, it stays as a proposal (`status: "proposed"`).
Marking a recurring one done **proposes** the next occurrence (origin `assistant`, title "Next time: …").

**WATCH:** fulfilment you find ("paid", "replied") must be a *proposal* (an `updateNode` setting
`props.status: "done"`, `doneAt`, `doneEvidenceSourceId` with a receipt quoting the evidence) — never delivered.
`src/lib/commitments/detect/**` and `watch/**` are in the test that forbids reaching `deliverChangeSet`.

### HTTP (for the browser, Ask page actions and iOS)

| Route | |
| --- | --- |
| `GET /api/commitments?person=<id>&status=open` | `{ ledger: LedgerData }` (or `{ items }` with `person`) |
| `GET /api/commitments/<id>` | `{ commitment, canWrite, everyone }` |
| `POST /api/commitments/<id>` | body = `CommitmentAction` → `ActionResult` |

## UI

- `/commitments` ("Commitments" / "Aftaler og frister"): header line, tabs All / We owe / Owed to us / Promises / Done,
  person filter, sections Overdue / At risk / Coming week / Later / No date yet; "Waiting for you" (proposals of new
  commitments, Deliver / Review / Drop) beside the list on desktop, above it on phones.
- Ask page actions on /commitments: `commitments.list`, `commitments.filter`, `commitments.people` (read);
  `commitments.mark_done`, `commitments.snooze`, `commitments.reassign` (approval card first).
- The detail is the node's living profile (`/node/<id>`, `/commitments/<id>` redirects) with a commitment panel.
- Person pages: a "Commitments" block (theirs, open).
- Today: one line + the overdue/at-risk ones as cards.
- Search: a Commitments section. MCP: `commitment` is a node type (`search_graph`, `get_node`, `propose_changes`).
- Timeline: commitments with a date show as events in the responsible person's lane (their reminder isn't drawn twice).

## Changes outside the commitments folders (all additive)

- `node_type` enum + `commitment` in every node-type list (gbrain, meta, deliver, graph view, MCP, mentions, provenance labels).
- `src/lib/changes/rebase.ts` `matchExisting` (+ `store.ts` index): a proposed commitment is "already in the graph"
  only when a commitment with the same words is due **the same day** (so "Pay the SFO fee" next month is new).
- `src/lib/changes/changes.test.ts`: `lib/commitments/actions.ts` may deliver (person-triggered); `lib/commitments/detect`
  and `lib/commitments/watch` may never reach `deliverChangeSet`.
- Search: section `commitments` (prefixes `commitment:`, `due:`, `aftale:`, `frist:`), excluded from People and things.
- Timeline: a commitment's own reminder isn't drawn a second time next to it.
- Assistant (`src/lib/assistant/retrieve.ts`): for to-do/time questions, open commitments due within 14 days go into
  the context as `node` items of `nodeType: "commitment"` (one compact `assistantLine` each).
- Profile sections: a `commitment` case; a person's commitments land under Important dates.

## Ledger ⇄ WATCH

`loadLedger`, `todayCommitments` and `personCommitments` fold WATCH's `withProgress` into the props (so a reply in
the same thread takes a commitment out of "at risk"), and `loadLedger` returns `flags` (`contradictionFlags`) that the
rows show as a warning with both sources. Both fail soft (the ledger shows without them).

## Push

No new push code: a commitment's reminder is a normal `reminders` row (`node_id` = the commitment, due lead days
before), so the existing reminder push (`src/lib/push/collect.ts dueReminders`, respecting device registration and
sensitivity) is the morning warning. Open: a snoozed (moved) reminder is not pushed a second time (push key is per
reminder id).

## Demo data

`npx tsx scripts/seed-commitments.ts` adds five believable letters/messages to Anna's Family library and proposes one
commitment from each (plus Emma's passport and Noah's SFO fee). Nothing is delivered by the script.

## Open decisions

- `globals.css` has no `--t-commitment` token yet; `typeColor("commitment")` falls back to amber `#a8741a`.
- `CitationChip` (shared UI) uses `tabular-nums`, which spaces out ":" in source titles ("Tryg : Din …").

## The watch (WATCH, `src/lib/commitments/watch/**`)

Connects the dots no single document shows and closes the loop. Everything it finds is a **proposal** (origin
`automation`, made as and addressed to — `forUserId` — the commitment's or event's owner, reads done as that person)
or an **advisory flag** computed on read. No model is called. Each finding has a stable `evidence.watchKey`
(`overlap:…`, `travel:…`, `nobody_free:…`, `done:<commitment>:<source>`, `fix:<commitment>:<field>:…`) and
`evidence.watch` = `clash | done | fix`; once proposed — delivered, waiting or dropped — it is never proposed again.

| Check | Output |
| --- | --- |
| Clashes (`clash.ts`): per person, open appointments + events in the next 60 days. `overlap` (same person, same time; all-day only for trips/camps/tournaments), `travel` (back to back, both places have `lat/lon`, gap < road time at 40 km/h + 10 min), `nobody_free` (a child's appointment needing a grown-up while every parent from `parent_of` is booked) | change set with `clashes_with` edge(s); `props: { watch: "clash", kind, explanation: { en, da }, evidence: [both items with source + quote], people }`; receipt = the first item's source passage |
| Fulfilment (`fulfil.ts`): after each source is read, and for new commitments looking back ≤ 90 days | "Looks done: …" = `updateNode` `props: { status: "done", doneAt, doneEvidenceSourceId }` + `arises_from` edge to the evidence document (`props.role: "done_evidence"`), receipt quotes the proof. One waiting "looks done" per commitment. Appointments: an event with the other party that took place (not the one read from the same letter). Missed is never proposed. |
| Contradictions (`contradict.ts`) | flags on read: `contradictionFlags(v, list)` → `{ [commitmentId]: CommitmentFlag[] }` (both quotes with `href`, plain sentence in the reader's language, `winner`, `fixable`). A fix (`updateNode` dueAt/startAt or amount) is proposed only when the stronger source (official > letter > email > chat; newer on a tie) holds a different value than the commitment. Rules flag, never fix. |
| At risk (`risk.ts`) | `progressSignals(v, list)` → newest related source after it appeared (same thread, naming/addressing the other party); `withProgress(v, list)` folds them into `props.progressAt` so `urgencyOf` sees them; pure `assessRisk(props, appearedAt, signal, now)` |
| Morning line (`summary.ts`) | pure `morningSummary(items, "en" \| "da", now)`; server `morningLine(v)` (with signals). `COMMITMENTS_SUMMARY_POLISH=1` lets a fast model smooth it (never when a commitment is sensitive). |

**Imports.** Pure (browser-safe): `@/lib/commitments/watch/pure`. Server: `@/lib/commitments/watch` (re-exports pure).

**Hooks** (marked `HOOK (commitments watch)`): `src/lib/changes/deliver.ts` after commit → `afterDelivery` (debounced
3 s per graph: clashes; for touched commitments, earlier proof + contradiction fixes); `src/lib/ingest/pipeline.ts`
after a source is ready → `afterSourceRead`; `src/instrumentation.ts` → `startCommitmentWatch()` (hourly tick, runs
`dailyWatch` once a day after 06:00 Copenhagen for every graph with open commitments; `DISABLE_SCHEDULER=1` off).

**Precision rules.** Payment proof needs a done-phrase ("Kvittering", "Tak for din betaling", "Payment received"…),
the payee (name without A/S etc., address or domain) or the same thread, and the amount when the commitment has one;
reminders ("Rykker", "ikke betalt", "overdue") and requests/invoices ("skal være betalt senest", "please pay") never
count. Notice needs a notice confirmation (a polite "Tak for din henvendelse" is not one). Due dates and amounts are
compared only between a commitment's own sources and its thread; periods (notice, complaint) also with sources naming
the other party (or organisations the commitment's own documents are linked to). Event-only clashes need two
different sources (two items from one calendar feed overlapping is normal).
