import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./origin";

const base = { origin: null, secFetchSite: null, host: "app.example.com", forwardedHost: null };

describe("isAllowedOrigin", () => {
  it("allows same-origin requests", () => {
    expect(isAllowedOrigin({ ...base, origin: "https://app.example.com", secFetchSite: "same-origin" })).toBe(true);
  });
  it("allows the forwarded host behind a proxy", () => {
    expect(isAllowedOrigin({ ...base, host: "10.0.0.1:8080", forwardedHost: "app.example.com", origin: "https://app.example.com" })).toBe(true);
  });
  it("blocks other origins", () => {
    expect(isAllowedOrigin({ ...base, origin: "https://evil.example" })).toBe(false);
    expect(isAllowedOrigin({ ...base, origin: "https://app.example.com.evil.example" })).toBe(false);
    expect(isAllowedOrigin({ ...base, origin: "null" })).toBe(false);
  });
  it("blocks requests the browser marks cross-site even without Origin", () => {
    expect(isAllowedOrigin({ ...base, secFetchSite: "cross-site" })).toBe(false);
  });
  it("lets non-browser clients through to the session check", () => {
    expect(isAllowedOrigin(base)).toBe(true);
  });
  it("accepts APP_URL", () => {
    expect(isAllowedOrigin({ ...base, host: "internal:3000", origin: "https://mygraph.eu", appUrl: "https://mygraph.eu" })).toBe(true);
  });
});
