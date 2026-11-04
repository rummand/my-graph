/** Edge-safe constants (no Node imports): shared by middleware and server code. */
export const SESSION_COOKIE = "mg_session";
/** Long-lived random id for the browser, so a parent approves a device once rather than every sign-in. */
export const DEVICE_COOKIE = "mg_device";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Set by middleware on every request so requireUser() knows whether to redirect (pages) or answer 401 (API). */
export const API_HEADER = "x-mg-api";
export const PATH_HEADER = "x-mg-path";

/** Paths that work without signing in. */
export function isPublicPath(path: string): boolean {
  return path === "/login" || path.startsWith("/login/") || path === "/setup" || path.startsWith("/setup/")
    || path.startsWith("/invite/") || path.startsWith("/.well-known/")
    || path.startsWith("/api/") || path.startsWith("/_next/") || path === "/manifest.webmanifest"
    || path === "/favicon.ico" || path === "/robots.txt" || path.startsWith("/icons/")
    || /\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|webmanifest|woff2?)$/.test(path);
}

/** Secure cookies everywhere except plain-http local development. */
export function secureCookies(env: { NODE_ENV?: string; APP_URL?: string } = process.env): boolean {
  if (env.APP_URL?.startsWith("http://")) return false;
  return env.NODE_ENV === "production";
}

export function sessionCookieOptions(env?: { NODE_ENV?: string; APP_URL?: string }) {
  return {
    httpOnly: true,
    secure: secureCookies(env),
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

