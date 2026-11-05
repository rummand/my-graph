import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { S3Client, parseListXml, signV4 } from "./s3";

describe("SigV4", () => {
  it("matches AWS's documented example (GET object with a range)", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (example: GET Object)
    const s = signV4({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKey: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(s.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches AWS's documented example (GET bucket with a query)", () => {
    const s = signV4({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/", query: { "max-keys": "2", prefix: "J" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKey: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(s.authorization.endsWith("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7")).toBe(true);
  });
});

describe("list responses", () => {
  it("reads keys, sizes and dates, decoding XML entities", () => {
    const xml = `<ListBucketResult><Contents><Key>my-graph/backups/a&amp;b/meta.json</Key><Size>12</Size><LastModified>2026-11-04T02:00:00.000Z</LastModified></Contents>
      <Contents><Key>x</Key><Size>0</Size></Contents></ListBucketResult>`;
    expect(parseListXml(xml)).toEqual([
      { key: "my-graph/backups/a&b/meta.json", size: 12, lastModified: new Date("2026-11-04T02:00:00.000Z") },
      { key: "x", size: 0, lastModified: null },
    ]);
  });
});

describe("client against a stand-in S3", () => {
  const store = new Map<string, Buffer>();
  const auth: string[] = [];
  let server: Server;
  let endpoint = "";
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mg-s3-"));
    server = createServer((req, res) => {
      auth.push(String(req.headers.authorization ?? ""));
      const u = new URL(req.url ?? "/", "http://x");
      const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ""));
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") { store.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); return; }
        if (req.method === "HEAD") { res.writeHead(store.has(key) ? 200 : 404).end(); return; }
        if (req.method === "DELETE") { store.delete(key); res.writeHead(204).end(); return; }
        if (req.method === "GET" && !key) {
          const prefix = u.searchParams.get("prefix") ?? "";
          const items = [...store.entries()].filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join("");
          res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
          return;
        }
        if (req.method === "GET" && store.has(key)) { res.writeHead(200).end(store.get(key)); return; }
        res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it("puts, lists, reads, checks and deletes objects, signing every request", async () => {
    const c = new S3Client({ endpoint, bucket: "bucket", accessKey: "AK", secret: "SECRET", region: "us-east-1", prefix: "p/", files: true });
    const file = path.join(dir, "f.bin");
    await writeFile(file, Buffer.from("streamed from disk"));
    await c.putFile("p/backups/1/database.sql.gz.mgbk", file);
    await c.putBuffer("p/backups/1/meta.json", Buffer.from("{}"), "application/json");
    expect(store.get("p/backups/1/database.sql.gz.mgbk")?.toString()).toBe("streamed from disk");
    expect((await c.list("p/backups/")).map((o) => o.key).sort()).toEqual(["p/backups/1/database.sql.gz.mgbk", "p/backups/1/meta.json"]);
    expect(await (await c.get("p/backups/1/meta.json")).text()).toBe("{}");
    expect(await c.exists("p/backups/1/meta.json")).toBe(true);
    await c.delete("p/backups/1/meta.json");
    expect(await c.exists("p/backups/1/meta.json")).toBe(false);
    await expect(c.get("p/nothing")).rejects.toThrow(/404 NoSuchKey/);
    expect(auth.every((a) => a.startsWith("AWS4-HMAC-SHA256 Credential=AK/"))).toBe(true);
    expect(auth.join(" ")).not.toContain("SECRET");
  });
});
