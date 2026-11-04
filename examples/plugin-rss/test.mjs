// node --test examples/plugin-rss/test.mjs — the plugin's own tests: parsing, the cursor, and the protocol end to end
// against a local feed server (MG_ALLOW_PRIVATE=1, as in development).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { decode, newItems, parseFeed, text } from "./feed.mjs";
import { isPrivate } from "./fetch.mjs";

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Skolens nyheder</title>
<item><title>Juleklip &amp; gløgg</title><link>https://skole.example/a</link><guid>a</guid><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Kom og <b>klip</b></p>]]></description><dc:creator>Lærer Lise</dc:creator></item>
<item><title>Svømning</title><link>https://skole.example/b</link><guid>b</guid><pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate><description>Husk badetøj</description></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry><title>Hello</title><id>urn:1</id><link rel="alternate" href="https://blog.example/1"/><updated>2026-11-01T09:00:00Z</updated><summary>Hi &lt;there&gt;</summary></entry></feed>`;

test("parses RSS: entities, CDATA, HTML to text, newest first", () => {
  const f = parseFeed(RSS);
  assert.equal(f.title, "Skolens nyheder");
  assert.deepEqual(f.items.map((i) => i.id), ["b", "a"]);
  assert.equal(f.items[1].title, "Juleklip & gløgg");
  assert.equal(f.items[1].text, "Kom og klip");
  assert.equal(f.items[1].author, "Lærer Lise");
});
test("parses Atom", () => {
  const f = parseFeed(ATOM);
  assert.equal(f.items[0].url, "https://blog.example/1");
  assert.equal(f.items[0].text, "Hi");
});
test("refuses what isn't a feed", () => assert.throws(() => parseFeed("<html></html>")));
test("decode and text are safe with odd input", () => {
  assert.equal(decode("&#0;&#x110000;&amp;"), "&");
  assert.equal(text("<script>alert(1)</script>ok"), "ok");
});
test("the cursor remembers what was seen", () => {
  const items = parseFeed(RSS).items;
  const first = newItems(items, null);
  assert.equal(first.fresh.length, 2);
  const second = newItems(items, { seen: first.seen });
  assert.equal(second.fresh.length, 0);
});
test("private addresses are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "::1", "::ffff:10.0.0.1", "fd00::1"]) assert.equal(isPrivate(ip), true, ip);
  assert.equal(isPrivate("93.184.216.34"), false);
});

const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));
const run = (cmd, input, env = {}) => {
  const r = spawnSync(process.execPath, [entry, cmd], { input: `${JSON.stringify(input)}\n`, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, messages: r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
};

test("spec and discover", () => {
  assert.equal(run("spec", { config: {} }).messages[0].type, "SPEC");
  assert.equal(run("discover", { config: {} }).messages[0].catalog.streams[0].name, "items");
});

test("read: records then state, and nothing new the second time; private feeds refused without MG_ALLOW_PRIVATE", async () => {
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "application/rss+xml", etag: '"1"' }); res.end(RSS); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/feed`;
  try {
    const { spawn } = await import("node:child_process");
    const go = (input, env) => new Promise((resolve) => {
      const c = spawn(process.execPath, [entry, "read"], { env: { PATH: process.env.PATH, ...env } });
      let out = ""; c.stdout.on("data", (d) => { out += d; });
      c.on("close", (status) => resolve({ status, messages: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
      c.stdin.end(`${JSON.stringify(input)}\n`);
    });
    const a = await go({ config: { url } }, { MG_ALLOW_PRIVATE: "1" });
    assert.deepEqual(a.messages.map((m) => m.type), ["LOG", "RECORD", "RECORD", "STATE"]);
    const state = a.messages.at(-1).state.cursor;
    const b = await go({ config: { url }, state: { streams: { items: state } } }, { MG_ALLOW_PRIVATE: "1" });
    assert.deepEqual(b.messages.map((m) => m.type), ["LOG", "STATE"]);
    const c = await go({ config: { url } }, {});
    assert.equal(c.status, 1);
    assert.equal(c.messages.at(-1).type, "TRACE");
    assert.equal(c.messages.at(-1).trace.error.failureType, "config_error");
  } finally {
    server.close();
  }
});
