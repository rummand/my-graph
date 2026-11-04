import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getViewer } from "@/lib/auth";
import { secureCookies } from "@/lib/auth/constants";
import { AuthError, handle, parseBody } from "@/lib/auth/http";
import { getPrefs, LOCALE_COOKIE, THEME_COOKIE } from "@/lib/i18n";
import { settingsBody } from "@/lib/i18n/settings-body";

const YEAR = 60 * 60 * 24 * 365;
const cookie = { path: "/", sameSite: "lax" as const, maxAge: YEAR, httpOnly: false, secure: secureCookies() };

/** GET: your language, theme and time zone. */
export async function GET() {
  return handle(async () => {
    const p = await getPrefs();
    return NextResponse.json({ settings: { locale: p.locale, theme: p.theme, timeZone: p.timeZone } });
  });
}

/**
 * PATCH { locale?, theme?, timeZone? }: saves them on your account and in cookies (so the sign-in page speaks your
 * language too). Signed out, only the language and theme cookies change. CSRF: the middleware's origin check.
 */
export async function PATCH(req: Request) {
  return handle(async () => {
    const body = await parseBody(req, settingsBody);
    const v = await getViewer();
    if (!v && body.timeZone) throw new AuthError(401, "Please sign in again.");
    if (v) {
      await db.update(users).set({
        ...(body.locale ? { locale: body.locale } : {}),
        ...(body.theme ? { theme: body.theme } : {}),
        ...(body.timeZone ? { timeZone: body.timeZone } : {}),
      }).where(eq(users.id, v.id));
    }
    const res = NextResponse.json({ ok: true, settings: body });
    if (body.locale) res.cookies.set(LOCALE_COOKIE, body.locale, cookie);
    if (body.theme) res.cookies.set(THEME_COOKIE, body.theme, cookie);
    return res;
  });
}
