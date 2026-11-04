# Connector plugins

A connector plugin brings outside content into My Graph from a source My Graph doesn't know itself: a feed, a school
system, a club's member site, a home-made export. It is a small program that runs **outside** the My Graph server
process and talks to it in JSON lines over stdin and stdout, after Airbyte's and Singer's protocols. My Graph runs it
as a connection of the kind **Plugin**: one person, one graph, on a schedule, with its own cursor and run log, like
every built-in connector.

The example in [`examples/plugin-rss`](../../examples/plugin-rss) reads an RSS or Atom feed. Copy it to start.

## Who may install and run plugins

- **Only the platform admin installs plugins**, by putting a plugin's folder in the plugin directory on the server
  (`MG_PLUGINS_DIR`). There is no upload. In development, when `MG_PLUGINS_DIR` is not set, the repo's
  `examples/plugin-*` folders are installed.
- **Only the platform admin runs them** (`PLATFORM_ADMIN_EMAILS`): a Plugin connection made by anyone else stops with
  "needs you" before the plugin starts.
- A plugin is trusted code on your server. My Graph limits what it can do by accident (below), but it is not a
  sandbox against a hostile plugin. Read a plugin before you install it, as you would any server software.

## A plugin's folder

```
my-plugin/
  plugin.json     the manifest
  index.mjs       the entry (any file in the folder)
```

`plugin.json`:

```json
{
  "id": "rss",
  "name": "RSS and Atom feeds",
  "version": "1.0.0",
  "protocol": 1,
  "runtime": "node",
  "entry": "index.mjs",
  "description": "Reads a news feed: each new item becomes a document in the library.",
  "limits": { "timeoutSeconds": 60, "memoryMb": 128, "maxRecords": 500 }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lower-case letters, digits and `_`, unique on the server. A connection names its plugin by this id. |
| `protocol` | `1`, this document. |
| `runtime` | `node`: run with the server's own Node, with `--max-old-space-size` set to `memoryMb`. `executable`: the entry is run as it is (a binary, a script with a `#!` line), so it can be written in any language. |
| `entry` | A path inside the folder. Symlinks are resolved and must stay inside the folder. |
| `limits` | Optional, never above the server's ceiling: `timeoutSeconds` (5–600, default 120 for `read`; `spec`, `check` and `discover` get 30), `memoryMb` (32–2048, default 256), `maxRecords` per run (default 2000). |

## Running a plugin

My Graph starts the entry with **one argument, the command**: `spec`, `check`, `discover` or `read`. It writes **one
JSON line on stdin** and closes it:

```json
{ "config": { "url": "https://skole.example/feed" }, "catalog": { "streams": [ … ] }, "state": { "streams": { "items": { … } } } }
```

- `config`: the connection's settings, already checked against the plugin's own specification (defaults applied,
  numbers and booleans coerced). Secret settings are included; they are never written to a file or put in arguments.
- `catalog`: on `read`, what `discover` said.
- `state`: on `read`, the last cursor of each stream (`null` the first time, or after a reset).

The plugin writes **JSON lines on stdout**, one message per line, and exits `0`. Anything on stdout that isn't a
message below is a protocol error and stops the run. **stderr** is kept (the last 16 KB, secrets redacted) for the run
log when the plugin fails.

### Messages

| Type | Shape | When |
| --- | --- | --- |
| `SPEC` | `{ "type": "SPEC", "spec": { "protocolVersion": 1, "name", "version", "documentationUrl"?, "connectionSpecification" } }` | answer to `spec` |
| `CONNECTION_STATUS` | `{ "type": "CONNECTION_STATUS", "connectionStatus": { "status": "SUCCEEDED" \| "FAILED", "message"? } }` | answer to `check` |
| `CATALOG` | `{ "type": "CATALOG", "catalog": { "streams": [ { "name", "maps": "document" \| "event" \| "note", "description"? } ] } }` | answer to `discover` |
| `RECORD` | `{ "type": "RECORD", "record": { "stream", "key", "data": { "title", "text"?, "url"?, "date"?, "start"?, "end"?, "allDay"?, "location"?, "mime"?, "author"? } } }` | during `read` |
| `STATE` | `{ "type": "STATE", "state": { "stream", "cursor" } }` | during `read`, after records |
| `LOG` | `{ "type": "LOG", "log": { "level": "debug" \| "info" \| "warn" \| "error", "message" } }` | any time |
| `TRACE` | `{ "type": "TRACE", "trace": { "type": "error", "error": { "message", "failureType": "config_error" \| "transient_error" \| "system_error" } } }` | when it fails |

**`connectionSpecification`** is a JSON Schema subset: an object whose `properties` are `string`, `number`,
`integer`, `boolean` or `array` (of strings), with `title`, `description`, `default`, `enum`, `minimum`, `maximum`,
`maxLength`, `format` (`uri`, `email`, `date`) and **`secret: true`** for anything secret (Airbyte's
`airbyte_secret`). `required` and `additionalProperties: false` are honoured.

**Streams** are lower-case names (`items`, `messages`, `calendar`). `maps` says what a stream's records become:

- `document`: a source in the library (kind connector), with the record's title, text, link and date. When the
  connection's *Read documents* is on, the library reads it as it reads an upload, and what it finds is proposed.
- `event`: a source, and a proposed timeline event (`start`, `end`, `allDay`, `location`), linked to the
  connection's person; a changed record proposes the change to the same event.
- `note`: a source, kept as it is.

**`key`** identifies an item at the source (a GUID, a message id). A record with a key My Graph has already stored for
this connection updates that source when its data changed and is skipped when it didn't, so sending an item twice
never duplicates it.

**`STATE` is the cursor**: whatever JSON the plugin needs to continue next time (an ETag, the newest date, the ids it
has seen). My Graph stores the records before a `STATE` and the cursor **in one transaction**, so a run that dies never
moves a cursor past data it didn't store. Records after the last `STATE` are stored too, with the cursor left where
it was; the next run sends them again and they are skipped. Send a `STATE` at least at the end of each stream, even
when nothing was new.

**Failing well**: write a `TRACE` with the reason and exit non-zero. `config_error` (the address is gone, a password
was refused) stops the connection until the person fixes it ("needs you"); `transient_error` and `system_error` are
tried again with back-off. A plugin that crashes, times out or breaks the protocol is tried again (crash, timeout) or
shown as broken (protocol), never silently ignored.

## What My Graph does around a plugin

- **Settings**: checked against the plugin's specification before every run. Secret settings are entered under the
  connection's secret settings, encrypted at rest (AES-256-GCM, like every connection's secrets), never shown again,
  never sent to mux, and every value in them is redacted from log lines and stderr. A secret setting typed into the
  plain settings is refused.
- **Web addresses**: every `format: "uri"` setting goes through the same SSRF guard as the built-in connectors
  before the plugin starts: https only, standard ports, no addresses on this computer or a private network
  (localhost only in development). The plugin is told whether private addresses are allowed (`MG_ALLOW_PRIVATE`) and
  should apply the same rule to every address it fetches, on the address it actually connects to (the RSS example
  does it in its DNS lookup).
- **Environment**: the plugin gets only `PATH`, a temporary `HOME` and `TMPDIR`, `LANG`, `TZ=UTC`,
  `NODE_ENV=production`, `MG_PLUGIN_ID`, `MG_PLUGIN_PROTOCOL` and `MG_ALLOW_PRIVATE`. It never sees the database
  address, the session secret, the connector key, mux's key or anything else of the server's.
- **Limits**: a wall-clock timeout and an idle timeout (60 seconds without output), at most 64 MB on stdout, 512 KB
  in one line, `maxRecords` records, a memory cap for Node plugins; the plugin runs in its own process group and a
  timeout kills the group. The connection's own run timeout (5 minutes) and "Disconnect" stop it too.
- **What it can't do**: write to the graph. Records are stored as sources; everything derived from them is a change
  set a person delivers. Outside text is data: the assistant reads it as quoted content, never as instructions.

## Writing one

1. Copy `examples/plugin-rss`, change `plugin.json`'s `id` and `name`.
2. Answer `spec` with your settings, `discover` with your streams, `check` by trying the settings.
3. On `read`, read from `state.streams.<name>`, emit `RECORD`s, then a `STATE`.
4. Test it by hand: `echo '{"config":{"url":"https://…"}}' | node index.mjs read`, and with `node --test`.
5. Put the folder in the plugin directory. As the platform admin, add a connection of the kind Plugin with the id,
   the settings as JSON (`{"url": "https://…"}`) and the secret settings as JSON.

## Running the example's tests

```
node --test examples/plugin-rss/test.mjs          # the plugin on its own
npx vitest run src/lib/plugins                    # protocol, runner limits, the example through the runner
PLUGIN_DB_TESTS=1 npx vitest run src/lib/plugins/plugin.db.test.ts   # a Plugin connection against the database
```
