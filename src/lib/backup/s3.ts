/**
 * A small S3-compatible client (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Hetzner, Scaleway): put, get, head,
 * delete and list, signed with AWS Signature Version 4. Path-style URLs (endpoint/bucket/key). No SDK, no other
 * service. Bodies are sent as UNSIGNED-PAYLOAD so large files stream from disk. Server-only.
 * Credentials come from the S3Config (environment) and never appear in errors or logs.
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { S3Config } from "./policy";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hex = (b: Buffer) => b.toString("hex");
const sha256 = (s: string | Buffer) => hex(createHash("sha256").update(s).digest());
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

/** RFC 3986 encoding as SigV4 wants it ('/' kept in paths when `keepSlash`). */
export function uriEncode(s: string, keepSlash: boolean): string {
  return Array.from(Buffer.from(s, "utf8")).map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export type SignInput = {
  method: string; host: string; path: string; query?: Record<string, string>;
  headers?: Record<string, string>; payloadHash: string;
  accessKey: string; secret: string; region: string; now: Date; service?: string;
};

/** The SigV4 Authorization header (and the headers that must be sent with it). Pure, for tests. */
export function signV4(i: SignInput): { authorization: string; amzDate: string; headers: Record<string, string> } {
  const amzDate = i.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const service = i.service ?? "s3";
  const headers: Record<string, string> = { host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = Object.entries(i.query ?? {}).map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [i.method, uriEncode(i.path, true), query, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kDate = hmac(`AWS4${i.secret}`, date);
  const kSigning = hmac(hmac(hmac(kDate, i.region), service), "aws4_request");
  const signature = hex(hmac(kSigning, toSign));
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate, headers,
  };
}

export class S3Error extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "S3Error"; }
}

export type S3Object = { key: string; size: number; lastModified: Date | null };

export class S3Client {
  constructor(private c: S3Config, private fetchImpl: typeof fetch = fetch) {}

  private url(key: string, query?: Record<string, string>): { url: string; host: string; path: string } {
    const u = new URL(this.c.endpoint);
    const base = u.pathname.replace(/\/+$/, "");
    const path = `${base}/${this.c.bucket}${key ? `/${key}` : ""}`;
    const qs = query ? Object.entries(query).map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).join("&") : "";
    return { url: `${u.protocol}//${u.host}${uriEncode(path, true)}${qs ? `?${qs}` : ""}`, host: u.host, path };
  }

  private async request(method: string, key: string, opts: {
    query?: Record<string, string>; headers?: Record<string, string>; body?: BodyInit | null; payloadHash?: string; ok?: number[];
  } = {}): Promise<Response> {
    const { url, host, path } = this.url(key, opts.query);
    const signed = signV4({
      method, host, path, query: opts.query, headers: opts.headers, payloadHash: opts.payloadHash ?? EMPTY_SHA,
      accessKey: this.c.accessKey, secret: this.c.secret, region: this.c.region, now: new Date(),
    });
    const headers: Record<string, string> = { ...signed.headers, authorization: signed.authorization };
    delete headers.host;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: opts.body ?? undefined, ...(opts.body ? { duplex: "half" } : {}) } as RequestInit);
    } catch (e) {
      throw new S3Error(`The storage service at ${host} couldn't be reached (${e instanceof Error ? e.message : "network error"}).`, 0);
    }
    if (!(opts.ok ?? [200, 204]).includes(res.status)) {
      const text = await res.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new S3Error(`The storage service refused ${method} ${key || "(bucket)"}: ${res.status}${code ? ` ${code}` : ""}.`, res.status);
    }
    return res;
  }

  async putBuffer(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    const res = await this.request("PUT", key, {
      body: new Uint8Array(body), payloadHash: sha256(body),
      headers: { "content-type": contentType, "content-length": String(body.length) },
    });
    await res.arrayBuffer().catch(() => {});
  }

  /** Stream a file from disk (UNSIGNED-PAYLOAD: the bytes aren't hashed twice). Up to 5 GB (one PUT). */
  async putFile(key: string, path: string, contentType = "application/octet-stream"): Promise<void> {
    const size = (await stat(path)).size;
    if (size > 5 * 1024 ** 3) throw new S3Error(`${key} is larger than 5 GB, which a single upload can't hold.`, 0);
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
    const res = await this.request("PUT", key, {
      body, payloadHash: "UNSIGNED-PAYLOAD", headers: { "content-type": contentType, "content-length": String(size) },
    });
    await res.arrayBuffer().catch(() => {});
  }

  async get(key: string): Promise<Response> {
    return this.request("GET", key);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.request("HEAD", key, { ok: [200, 404] });
    return res.status === 200;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request("DELETE", key, { ok: [200, 204, 404] });
    await res.arrayBuffer().catch(() => {});
  }

  /** Every object under `prefix` (ListObjectsV2, following continuation tokens). */
  async list(prefix: string, limit = 100_000): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.request("GET", "", { query })).text();
      out.push(...parseListXml(xml));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || undefined : undefined;
    } while (token && out.length < limit);
    return out;
  }
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The objects in a ListObjectsV2 response. Pure. */
export function parseListXml(xml: string): S3Object[] {
  const out: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    if (!key) continue;
    const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
    const lm = /<LastModified>([^<]+)<\/LastModified>/.exec(body)?.[1];
    out.push({ key: decodeXml(key), size, lastModified: lm ? new Date(lm) : null });
  }
  return out;
}
