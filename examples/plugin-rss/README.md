# RSS and Atom feeds (example connector plugin)

Reads a feed and gives My Graph one document per new item (title, text, link, date, author). The cursor remembers the
last 300 item ids and the feed's ETag and Last-Modified, so an unchanged feed costs one conditional request.

Settings: `url` (the feed's https address), `maxItems` (new items per run, 1–500, default 50) and, as a secret
setting, `token` (sent as a Bearer token, for a feed that needs one).

No dependencies. `node --test examples/plugin-rss/test.mjs` runs its tests. The protocol is in
[docs/plugins/README.md](../../docs/plugins/README.md).
