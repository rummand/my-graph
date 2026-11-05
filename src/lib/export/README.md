# Exports and account deletion

## Export (Settings > Your data > Download a copy)

`POST /api/export { scope: "account" }` or `{ scope: "graph", graphId }` (a graph you own) makes a `data_exports` row and
builds a zip in the background: through the jobs queue as `export.build` once `src/lib/jobs/handlers.ts` registers
`exportBuildJob`, otherwise in-process (the 5-minute sweep restarts interrupted builds). The zip lives in `EXPORT_DIR`
(default `/data/exports`) and `GET /api/export/<id>/download` serves it to its owner only, for 24 hours; then the sweep
deletes it. One export at a time per person, 10 a day.

What is in it: what the person could see when signed in, read with the GBrain access rules in that graph:
a graph they own in full (`mode: "full"`); in an account export, other graphs only with what they added
(`mode: "mine"`). Other people's private items are never included. `assembleExport` (pure) checks scope again: rows
from a graph that wasn't asked for are dropped whatever the loader returned (tested in `format.test.ts`).

### Format (version 1)

```
README.md                       the same description, for the person
manifest.json                   { format: "my-graph-export", version: 1, createdAt, scope, person {id,name},
                                  graphs [{ id, name, kind, role, mode, folder, counts }], totals, missingFiles }
account.json                    whole-account exports: profile, household name, graphs and roles
graphs/<name>-<id8>/
  graph.json                    id, name, kind, role, createdAt, mode
  nodes.json                    nodes rows (no embedding / search vector)
  edges.json                    facts: fromId, relation, toId, status, confidence, validFrom/To, visibility
  provenance.json               per node/edge: sourceId, chunkId, locator, quote, activity, agentType, agentId,
                                confidence, sourceInExport
  sources.json                  sources rows incl. textContent; exportPath → the original in this zip
  files/<sourceId>/<name>       the originals, byte for byte
  wiki.json                     pages (TipTap JSON + text) each with `revisions`
  history.json                  graph_events for the exported items
  referenced-nodes.json         mode "mine": id/type/kind/label of others' nodes their facts point to
  reminders.json, conversations.json (with messages), memories.json, artifacts.json   theirs, when any
```

UTF-8 JSON, ISO 8601 UTC dates, UUID ids consistent across files.

## Account deletion (Settings > Your data > Delete your account)

Rules (`deletion-policy.ts`, tested): not the platform admin; children ask a parent; a household owner hands the
household to a parent first (`POST /api/account/transfer { kind: "household", to }`) unless they are its only member;
a graph they own that others use is handed over (`{ kind: "graph", graphId, to }`) or deleted first. Confirmation is
their sign-in email typed. Then every session ends and nothing happens for 7 days; any sign-in in that time cancels it.

When it runs (one transaction): a stand-in account "A former member" (household `Former members`, address on
`former-member.invalid`, can't sign in) takes over what they added for others in graphs that stay (nodes, edges,
sources and chunks, wiki pages, artifacts; provenance, history, revisions and change sets name the stand-in); graphs
only they used are deleted; the household too if they were its only member; then the account row, which removes the
rest (private items, chats, memories, reminders, connections, passkeys, sessions, AI-app access, plan) through the
foreign keys. Unreferenced originals are removed from storage. Audit: `account.deletion_requested`,
`account.deletion_cancelled`, `account.deleted` (counts only, no name or email).
