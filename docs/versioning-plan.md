# Versioning the graph like a git repo (from Nexus)

Studied /Users/rummand/orca/nexus/nexus (apps/web/src/lib/change, lib/history, lib/facts). Nexus's vocabulary
(lib/change/git-words.ts): Now = main, Plan = branch, change = commit, Checkpoint = tag, Stand = checkout,
Deliver = merge, Review = pull request, Compare = diff, History = log, plus rebase.

## What My Graph takes

1. **Event log** `graph_events` (graph_id, node_id/edge_id without FK, name copied in, kind, field, from, to, actor
   kind/id/name, context, change_set_id, at). Written by a `remembering(tx, scope, write)` wrapper that snapshots,
   writes, diffs per field, records. Edges carry both ends so they can be rewound. Coalesce rapid edits by the same
   actor on the same field (2 min).
2. **The graph at time T** by rewinding events newer than T, newest first (Nexus lib/history/asof.ts), plus
   `diffEstates(a, b)` for "what changed between two moments". Optional later: bitemporal facts
   (valid_from/valid_until + recorded_at/superseded_at) for edges.
3. **Change sets = branches** `change_sets` (graph_id, name, status draft|delivered|abandoned, base_at, created_by,
   origin person|assistant|connector|chat) and `changes` (op addNode|updateNode|retireNode|addEdge|removeEdge|
   setKind|setRelationType|setAttribute…, node_id minted up front, payload, note, receipt = evidence/provenance,
   author, for). A pure `project(rows, changes)` shows the branch; `deliver()` applies ops inside `remembering`,
   stamping source "change:<id>". Never applied until delivered.
4. **Agents propose on a branch, humans deliver.** Every assistant/connector/web/chat proposal is a change on a
   change set; approval cards and "Send" in the live-highlight composer deliver it. A fingerprint over the ops makes
   an approval stale if the change set changes afterwards.
5. **Compare** branch vs main by id (`stateOf` + `diffStates`), no merge base needed.
6. **Rebase verdicts** per op: outstanding, landed, conflicted; never deliver with stale ops.
7. **Checkpoints** = label + timestamp; restore = a generated change set (history is never rewritten).
8. **Blame** `whoSaid(node, field)`: latest event for that field, its change set, its author, its provenance.
9. **Meta model changes** (new kinds, relations, attributes) are ops on the same change sets, so the emergent
   model has the same history and review.

## Skipped (overkill for My Graph)

Plateaus, scenarios, dependency ordering, MODELOWNERS, governance gates, review threads, plan-from-plan lineage,
source branches, protected-Now day plans. Nexus stores timestamps as text and filters as-of in JS; we use
timestamptz/jsonb and SQL predicates with indexes.
