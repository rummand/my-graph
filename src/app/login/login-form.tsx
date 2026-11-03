"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { passkeysSupported, signInWithPasskey } from "@/lib/auth/client/passkeys";
import { ErrorNote, Notice } from "./notes";

export function LoginForm({ next, notice }: { next: string; notice: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  // Assume passkeys work (they do in every current browser) so the page doesn't jump; correct it after mount.
  const [canPasskey, setCanPasskey] = useState(true);

  useEffect(() => setCanPasskey(passkeysSupported()), []);

  function done(pending: boolean) {
    router.replace(pending ? "/login/pending" : next);
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setFields({});
    const f: FieldErrors = {};
    if (!email.trim()) f.email = "Enter your email or username.";
    if (!password) f.password = "Enter your password.";
    if (Object.keys(f).length) { setFields(f); return; }
    setBusy("password");
    try {
      const r = await api<{ pending: boolean }>("/api/auth/login", { json: { email, password } });
      done(r.pending);
    } catch (err) {
      setFields(errorFields(err));
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function passkey() {
    setError(null); setFields({});
    setBusy("passkey");
    try {
      const r = await signInWithPasskey();
      done(r.pending);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <div>
      {notice && <Notice message={notice} className="mb-6 rounded-md bg-surface-2 px-3 py-2 lg:bg-bg" />}
      {canPasskey && (
        <div className="mb-8">
          <Button type="button" className="h-11 w-full text-[15px]" onClick={passkey} disabled={busy !== null}>
            <Fingerprint size={18} aria-hidden />
            {busy === "passkey" ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </Button>
          <p className="mt-2 text-sm text-muted">Use your fingerprint, face or device PIN.</p>
        </div>
      )}
      <form onSubmit={submit} noValidate aria-label="Sign in with your password">
        {canPasskey && <p className="mb-4 text-sm font-medium">Or use your password</p>}
        <div className="space-y-4">
          <Field id="login-email" label="Email or username" error={fields.email}>
            <Input id="login-email" name="email" type="text" inputMode="email" autoComplete="username webauthn" autoCapitalize="none"
              spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus className="h-10"
              aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("login-email", fields.email)} />
          </Field>
          <Field id="login-password" label="Password" error={fields.password}>
            <Input id="login-password" name="password" type="password" autoComplete="current-password" value={password} className="h-10"
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!fields.password || undefined} aria-describedby={describedBy("login-password", fields.password)} />
          </Field>
        </div>
        <ErrorNote message={error} className="mt-4" />
        <Button type="submit" variant={canPasskey ? "secondary" : "primary"} className="mt-5 h-10 w-full" disabled={busy !== null}>
          {busy === "password" ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
