# My Graph for Mac: the app's API

The contract the native macOS menu bar app is built against. Server code: `src/lib/connectors/mac/app.ts` (pure),
`src/lib/connectors/mac/app-server.ts`, routes under `src/app/api/connections/mac/`. Importer shapes:
`src/lib/importers/schemas.ts` (additive changes only).

Rules that hold everywhere:

- **Agents propose, humans decide.** Everything the Mac sends becomes library sources and *proposals* (change sets)
  the person delivers in My Graph. The Mac writes nothing into the graph directly. The only write the Mac makes is
  ticking one of the person's own reminders done (`/outbox/ack`).
- **Every source is off until the person turns it on** (`PUT /settings`). A batch for a source that is off is refused
  with `409` and `code: "macSourceOff:<source>"`.
- **Auth.** One sign-in with the person's session (`POST /device`) gives a token `mgmac_…` (shown once; only a hash is
  stored). Every other call sends `Authorization: Bearer mgmac_…`. On every call the server re-checks that the person
  still exists, is still a member of that graph and may write in it. Keep the token in the Keychain.
- **One connection per person per graph.** The app and the Node helper share it: signing in with the app replaces the
  helper's token and pairing the helper replaces the app's (the old token then gets `401`, `code: "macUnpaired"`).
  To use another graph, sign in again with that graph chosen in the session.
- **Errors** are JSON `{ error, code? }` with a proper status. `401 macUnpaired` → sign in again. `403 notMember` /
  `readOnly` → the person can no longer add to that graph. `409 macPaused` → paused on the web. `429` carries
  `Retry-After` (seconds). `error` is plain English; show your own words for known `code`s.
- No `Origin` header from the app (the CSRF check lets requests without one through; a browser on another site is
  refused). Timestamps are ISO 8601 with offset; the server stores UTC.

## 1. Sign in: `POST /api/connections/mac/device`

Signed in with the person's **session cookie** (`mg_session`, from `POST /api/auth/login` or the web sign-in), working
in the **current graph** (`mg_graph` cookie). Rate limited (10 per 15 minutes per person).

```http
POST /api/connections/mac/device
Cookie: mg_session=…; mg_graph=…
Content-Type: application/json

{ "deviceName": "Ida's MacBook Air", "appVersion": "1.0.0" }
```

`201`

```json
{
  "connectionId": "e4eea0ba-71d0-475a-9447-f54531716f7e",
  "token": "mgmac_0E2E_P4iRFqlae-s0C6TxaZIquS7W9B5iCjxAWNWIvE",
  "graph": { "id": "daecdb75-…", "name": "Family", "kind": "family" }
}
```

Errors: `401` not signed in, `403` guest or read-only in this graph, `429`.
`GET /api/auth/me` (session) tells who is signed in and which graph is current, if the app wants to show it first.

## 2. Settings: `GET` / `PUT /api/connections/mac/settings`

`GET` (bearer) →

```json
{
  "connectionId": "e4eea0ba-…",
  "label": "My Graph for Mac: Ida's MacBook Air",
  "visibility": "private",
  "maxBatchBytes": 5000000,
  "messages": { "enabled": false, "chats": [], "backfill": [], "cursor": null, "since": "2025-11-04T10:25:15.160Z", "generation": 0 },
  "notes": { "enabled": false, "folders": null, "cursor": null, "generation": 0 },
  "sources": {
    "messages": false, "notes": false, "contacts": false, "calendar": false, "reminders": false,
    "photos": false, "files": false, "voiceMemos": false, "calls": false
  },
  "writeBack": { "reminders": false, "events": false },
  "folders": [],
  "graph": { "id": "daecdb75-…", "name": "Family", "kind": "family" },
  "cursors": { "calls": null },
  "uploadMaxBytes": 52428800
}
```

- `messages` / `notes`: the same fields the Node helper uses (which conversations it may send, cursors, generation —
  when `generation` goes up the person asked to send everything again: forget local cursors). Which Messages
  conversations are allowed is chosen on the web page `/connections/mac` (from the list the app reports with
  `POST /api/connections/mac/catalog`, same as the helper) — `messages.chats` is the allow-list; anything else is
  dropped by the server.
- `sources.messages` mirrors `messages.enabled`, `sources.notes` mirrors `notes.enabled`.
- `folders`: the folder **labels** the person chose (e.g. `"Documents/Taxes"`). Paths stay on the Mac; the app maps
  label → path itself. Files are accepted only from a label in this list.
- `cursors.calls`: the newest call time the server has (send calls from this moment on; earlier ones are dropped).

`PUT` (bearer), every field optional, left-out fields stay as they are; unknown fields → `400`:

```json
{
  "sources": { "calendar": true, "files": true, "reminders": true },
  "writeBack": { "reminders": true, "events": true },
  "folders": ["Documents/Taxes", "School"]
}
```

→ `200` with the same body as `GET`. Audited.

## 3. Import door: `POST /api/connections/mac/import/<importer>`

`<importer>` ∈ `imessage | apple_notes | contacts | photos | calendar | reminders | calls`. Each needs its switch
(`messages | notes | contacts | photos | calendar | reminders | calls`). Body ≤ 8 MB (aim for ≤ 5 MB per batch);
counts against the person's import limit (30 batches / 10 minutes; `429` + `Retry-After`).

Envelope (same as the helper's):

```json
{
  "runId": "6a0c4c9e-1111-4111-8111-111111111111",
  "batch": "cal-2026-11-05T10",
  "final": true,
  "device": "Ida's MacBook Air",
  "data": { … }
}
```

- `runId`: a UUID per sync run (batches of one run show as one run on the web).
- `batch`: names the batch (`[A-Za-z0-9._:-]{1,120}`); the same batch name again updates instead of duplicating.
- `imessage` / `apple_notes` also take `phase`, `lastRowId`, `notesCursor`, `covered` (see the helper).
- For the app's sources, **send the whole current window each time** — the server keeps a fingerprint of what it
  already has per item id and drops what is unchanged, so nothing is proposed twice. Only new or changed items are
  stored. If nothing is new, nothing is stored.

`data` shapes (`src/lib/importers/schemas.ts`):

```jsonc
// contacts (contactsPayload)
{ "contacts": [{ "id": "CNContact.identifier", "name": "Ida Hansen", "givenName": "Ida", "familyName": "Hansen",
  "emails": [{ "label": "home", "value": "ida@example.com" }], "phones": [{ "label": "mobile", "value": "+45 11 22 33 44" }],
  "birthday": "1984-03-02", "addresses": [], "organization": "…", "jobTitle": "…", "related": [{ "label": "mother", "name": "…" }], "note": "…" }] }

// photos (photosPayload): metadata only; images are not sent through this door
{ "photos": [{ "id": "PHAsset.localIdentifier", "takenAt": "2026-07-12T14:03:00+02:00", "lat": 55.67, "lon": 12.56,
  "placeName": "Tivoli", "albums": ["Summer 2026"], "favorite": true }] }

// calendar (calendarPayload): server keeps 30 days back .. 120 days ahead; send at most that window
{ "events": [{ "id": "EKEvent.calendarItemExternalIdentifier (+ occurrence date for repeats)", "calendar": "Family",
  "title": "Football final", "start": "2026-11-08T10:00:00+01:00", "end": "2026-11-08T11:00:00+01:00", "allDay": false,
  "location": "Skovbo Skole", "notes": "Bring water", "attendees": [{ "name": "Ida", "email": "ida@example.com" }], "url": "https://…" }] }

// reminders (remindersPayload): only open ones with a due date become proposals; finished ones are not stored
{ "reminders": [{ "id": "EKReminder.calendarItemExternalIdentifier", "list": "Home", "title": "Fix bike",
  "due": "2026-11-09T09:00:00+01:00", "notes": "…", "done": false, "priority": 1 }] }

// calls (callsPayload): always sensitive and private
{ "calls": [{ "id": "ZCALLRECORD.ZUNIQUE_ID", "at": "2026-11-01T09:12:00+01:00", "durationSec": 240,
  "direction": "in" | "out" | "missed", "handle": "+45 11 22 33 44" | "ida@example.com", "name": "Ida Hansen",
  "service": "phone" | "facetime_audio" | "facetime_video" }] }
```

What each becomes (always a proposal):

- **calendar**: an event per new event (title, time, location, calendar), linked to the person and to attendees
  already in the graph; a moved event → a proposed change; events already in My Graph (same Mac id, or the same name
  on the same day) are skipped; at most 300 per batch, nearest first. Unknown attendees are never proposed as people.
- **reminders**: an open dated reminder → a proposed reminder for the person. Reminders the person already has in My
  Graph (same title and due day) are dropped before storing — this includes the ones My Graph wrote to the Mac.
  Undated ones are only searchable text.
- **calls**: a searchable call log per day; a person is proposed only for a frequent contact the Mac has a name for
  (≥ 3 calls on ≥ 2 days) who isn't in the graph yet. Never a one-off or unnamed number.
- **contacts / photos**: the existing importers (people matched by phone/email; trips and days out from photos).

Response: `201` when a source was stored, else `200`:

```json
{ "sourceId": "66a9c6a5-…", "duplicate": false, "kept": 1, "dropped": 1, "unchanged": 0 }
```

`kept`: items stored; `dropped`: refused (outside the window, finished reminders, ones already in My Graph, or for
messages/notes: not chosen); `unchanged`: already sent in this exact form. `sourceId` is `null` when nothing was new.

## 4. File door: `POST /api/connections/mac/upload`

Bearer, `multipart/form-data`, one file per request, ≤ 50 MB (`413` above), rate limited (300 per 10 minutes).

| field | |
| --- | --- |
| `file` | the bytes (send the right `Content-Type` if you know it; the server checks the bytes itself) |
| `fileId` | the Mac's stable id for the file, e.g. `<volumeUUID>:<inode>` or a bookmark hash, `[A-Za-z0-9._:+/=-]{1,200}` |
| `relPath` | path relative to the chosen folder, e.g. `Taxes/2025/Return.pdf` (the file name is its last part) |
| `folderLabel` | the chosen folder's label; must be in `settings.folders` (else `409 macFolderNotChosen`) |
| `modifiedAt` | optional, ISO 8601 |
| `source` | optional: `files` (default, needs `sources.files`) or `voiceMemos` (needs `sources.voiceMemos`; audio only; `folderLabel` e.g. `"Voice Memos"`, not checked against `folders`) |

- New `fileId` → stored like a library upload, as the person, in the connection's graph → `201 { outcome: "new" }`.
- Same `fileId`, new bytes → the **next version** of that document (the earlier one stays, marked superseded) →
  `201 { outcome: "version", revision: 2 }`.
- Same `fileId`, same bytes → nothing happens → `200 { outcome: "unchanged" }`.
- A new `fileId` whose bytes this person already has in the graph (any name) → not stored twice →
  `200 { outcome: "duplicate", sameAs: "<title>" }`.
- Voice Memos are kept private and transcribed by the library (mux, sensitive); files take the connection's visibility.
- Unsupported types → `415` with the reason.

```json
{ "sourceId": "2fe8ca61-…", "outcome": "version", "revision": 2, "title": "packing.txt" }
```

Keep `fileId` stable across renames/moves inside the folder; if the app can't, the server still recognises the same
bytes, but a changed file under a new id becomes a separate document.

## 5. Write-back outbox: `GET /api/connections/mac/outbox?since=<cursor>`

Bearer. Only:

- with `writeBack.reminders`: the person's **own** reminders in this graph — open ones, and ones finished in the
  last 30 days (reminders that came from the Mac's own Reminders are not handed back);
- with `writeBack.events`: upcoming events (now .. 60 days) the person can read in this graph — never sensitive
  events, never events that came from a Mac calendar.

```http
GET /api/connections/mac/outbox?since=35
```

```json
{
  "items": [
    { "id": "4c3990e6-…", "kind": "reminder", "title": "Buy milk", "notes": "…", "dueAt": "2026-11-07T09:00:00.000Z",
      "done": true, "deleted": false, "updatedAt": "2026-11-05T10:26:17.085Z", "url": "https://mygraph.example/?reminder=4c3990e6-…" },
    { "id": "9b1c…", "kind": "event", "title": "Parents' evening", "startAt": "2026-11-20T17:00:00.000Z", "endAt": "2026-11-20T18:30:00.000Z",
      "allDay": false, "done": false, "deleted": false, "updatedAt": "…", "url": "https://mygraph.example/node/9b1c…" },
    { "id": "77aa…", "kind": "reminder", "title": "Old title", "done": false, "deleted": true, "updatedAt": "…", "url": "…" }
  ],
  "cursor": "38"
}
```

- No `since` (or an unknown/invalid one): every live item (no tombstones) — a full sync. Then send the returned
  `cursor` next time and you get only what changed after it, deletions as `deleted: true`.
- `deleted: true` means it was deleted in My Graph, is no longer visible to the person, or write-back for that kind
  was turned off: remove the copy the app wrote. Items that only leave the window (an event that has started, an old
  finished reminder) do **not** come as deleted; leave them.
- `id` is My Graph's id; keep the mapping My Graph id → EventKit item on the Mac, and put `url` in the item's URL/notes
  so the person can open it in My Graph. Don't send items the app wrote from the outbox back through the import door
  (the server drops them anyway: same title and day).
- `optional` fields are left out when empty.

### Tick a reminder done: `POST /api/connections/mac/outbox/ack`

```json
{ "id": "4c3990e6-…", "kind": "reminder", "done": true }
```

→ `200 { "id": "4c3990e6-…", "done": true }`. Only the person's own reminder in this graph (`404` otherwise),
only with `writeBack.reminders` on (`409 macWriteBackOff`). Audited. No other writes.

## 6. Status: `GET /api/connections/mac/status`

Bearer → for the menu bar badge and notifications:

```json
{
  "waiting": 3,
  "lastImports": [
    { "sourceId": "68e1bd86-…", "title": "Reminders from Ida's MacBook Air: 2 reminders", "kind": "reminders", "status": "processing", "at": "2026-11-05T10:26:18.286Z" },
    { "sourceId": "2fe8ca61-…", "title": "packing.txt", "kind": "files", "status": "ready", "at": "2026-11-05T10:25:41.914Z" }
  ],
  "graph": { "id": "daecdb75-…", "name": "Family", "kind": "family" },
  "connection": { "id": "e4eea0ba-…", "status": "ok", "lastRunAt": "2026-11-05T10:26:18.300Z" }
}
```

- `waiting`: draft change sets waiting for this person in this graph (the same count as the web's Changes badge).
  Open `/changes` in the browser to review.
- `lastImports[].kind`: the importer id (`calendar`, `reminders`, …) or `files` / `voiceMemos`; `status`:
  `pending | processing | ready | failed`. A source page is `/library/<sourceId>`.

## 7. Other routes the app may use (shared with the helper)

- `POST /api/connections/mac/catalog` (bearer): `{ device?, chats: [{ id, name?, participants: [{ handle, name? }], count, lastAt? }], folders: [{ name, count }], canRead?: { messages?, notes? } }` — the Messages conversations (no messages) and Notes folders (no notes) the person can choose from on the web. Answers like `GET /settings` (helper fields only).
- Download page: `/connections/mac` recommends the app and links `/downloads/MyGraph-mac.zip` (served from
  `MG_DOWNLOADS_DIR`, default `./downloads`; `404` until a build is placed there).
