#!/usr/bin/env node
// My Graph connector plugin: RSS and Atom feeds. Speaks the plugin protocol (docs/plugins/README.md): run with one
// command (spec | check | discover | read), reads one JSON line on stdin, writes JSON lines on stdout.
import { getFeed, FetchError } from "./fetch.mjs";
import { newItems, parseFeed } from "./feed.mjs";

const SPEC = {
  protocolVersion: 1, name: "RSS and Atom feeds", version: "1.0.0",
  connectionSpecification: {
    type: "object", required: ["url"], additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri", title: "Feed address", description: "The feed's https:// address." },
      maxItems: { type: "integer", minimum: 1, maximum: 500, default: 50, title: "Items per run", description: "At most this many new items each time." },
      token: { type: "string", secret: true, title: "Access token", description: "Only for a feed that needs one; sent as a Bearer token." },
    },
  },
};
const CATALOG = { streams: [{ name: "items", maps: "document", description: "One document per feed item." }] };

const emit = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (message, level = "info") => emit({ type: "LOG", log: { level, message } });

async function readInput() {
  let data = "";
  for await (const chunk of process.stdin) { data += chunk; if (data.includes("\n")) break; }
  const line = data.split("\n")[0].trim();
  return line ? JSON.parse(line) : {};
}

function headersFor(config, cursor) {
  const h = {};
  if (config.token) h.authorization = `Bearer ${config.token}`;
  if (cursor?.etag) h["if-none-match"] = cursor.etag;
  if (cursor?.lastModified) h["if-modified-since"] = cursor.lastModified;
  return h;
}

async function main() {
  const command = process.argv[2];
  const input = await readInput();
  const config = input.config ?? {};
  switch (command) {
    case "spec":
      emit({ type: "SPEC", spec: SPEC });
      return;
    case "check": {
      try {
        const r = await getFeed(config.url, headersFor(config));
        const feed = parseFeed(r.body);
        emit({ type: "CONNECTION_STATUS", connectionStatus: { status: "SUCCEEDED", message: `Read "${feed.title || "the feed"}": ${feed.items.length} items.` } });
      } catch (e) {
        emit({ type: "CONNECTION_STATUS", connectionStatus: { status: "FAILED", message: e.message } });
      }
      return;
    }
    case "discover":
      emit({ type: "CATALOG", catalog: CATALOG });
      return;
    case "read": {
      const cursor = input.state?.streams?.items ?? null;
      const r = await getFeed(config.url, headersFor(config, cursor));
      if (r.status === 304) {
        log("The feed hasn't changed since the last time.");
        emit({ type: "STATE", state: { stream: "items", cursor } });
        return;
      }
      let feed;
      try { feed = parseFeed(r.body); } catch (e) { throw new FetchError(e.message, "config_error"); }
      const { fresh, seen } = newItems(feed.items, cursor, Number(config.maxItems) || 50);
      log(`${feed.title || "The feed"}: ${feed.items.length} items, ${fresh.length} new.`);
      for (const i of fresh.reverse()) {
        emit({ type: "RECORD", record: { stream: "items", key: i.id, emittedAt: Date.now(), data: {
          title: i.title.slice(0, 500), text: i.text.slice(0, 100_000), url: i.url || undefined, date: i.date, author: i.author, mime: "text/plain", feed: feed.title || undefined,
        } } });
      }
      emit({ type: "STATE", state: { stream: "items", cursor: { seen, etag: r.headers.etag ?? null, lastModified: r.headers["last-modified"] ?? null } } });
      return;
    }
    default:
      emit({ type: "TRACE", trace: { type: "error", error: { message: `Unknown command "${command}". Use spec, check, discover or read.`, failureType: "system_error" } } });
      process.exitCode = 2;
  }
}

main().catch((e) => {
  emit({ type: "TRACE", trace: { type: "error", error: { message: String(e?.message ?? e).slice(0, 1000), failureType: e instanceof FetchError ? e.failureType : "system_error" } } });
  process.exitCode = 1;
});
