import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OTEL_API_VERSION, __test } from "./otel";

const { AlsContextManager, Tracer, SPAN_KEY, ROOT_SPAN_TYPE } = __test;

describe("request timer", () => {
  it("registers at a version the installed @opentelemetry/api accepts", () => {
    const pkg = JSON.parse(readFileSync(path.resolve("node_modules/@opentelemetry/api/package.json"), "utf8")) as { version: string };
    const [maj, min] = pkg.version.split(".").map(Number);
    const [omaj, omin] = OTEL_API_VERSION.split(".").map(Number);
    // A consumer accepts the global when majors match and its own minor is <= the global's.
    expect(omaj).toBe(maj);
    expect(omin).toBeGreaterThanOrEqual(min);
  });

  it("reports the root request span with its route once it ends, nested spans included", async () => {
    const ended: { name: string; ms: number; route: unknown; errored: boolean }[] = [];
    const cm = new AlsContextManager();
    const tracer = new Tracer(cm, (s, ms) => {
      if (!s.root && s.attr("next.span_type") === ROOT_SPAN_TYPE) ended.push({ name: s.name, ms, route: s.attr("next.route"), errored: s.errored });
    });
    await tracer.startActiveSpan("GET /people/abc", { attributes: { "next.span_type": ROOT_SPAN_TYPE, "http.method": "GET" } }, async (root) => {
      // A nested span (rendering) sees the root as its parent through the async context.
      await new Promise((r) => setTimeout(r, 5));
      const child = tracer.startSpan("render", { attributes: { "next.span_type": "AppRender.getBodyResult" } });
      expect(child.root).toBe(root);
      child.recordException();
      child.end();
      expect(cm.active().getValue(SPAN_KEY)).toBe(root);
      root.setAttributes({ "next.route": "/people/[id]", "http.status_code": 200 });
      root.updateName("GET /people/[id]");
      root.end();
    });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ name: "GET /people/[id]", route: "/people/[id]", errored: true });
    expect(ended[0].ms).toBeGreaterThanOrEqual(4);
  });

  it("keeps concurrent requests apart", async () => {
    const cm = new AlsContextManager();
    const tracer = new Tracer(cm, () => {});
    const seen: string[] = [];
    await Promise.all(["a", "b"].map((n) => tracer.startActiveSpan(n, {}, async (span) => {
      await new Promise((r) => setTimeout(r, n === "a" ? 10 : 1));
      seen.push(`${n}:${(cm.active().getValue(SPAN_KEY) as typeof span).name}`);
      span.end();
    })));
    expect(seen.sort()).toEqual(["a:a", "b:b"]);
  });
});
