"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field, FormError, FormNotice } from "@/lib/auth/client/field";
import { passkeysSupported, signInWithPasskey } from "@/lib/auth/client/passkeys";

export function LoginForm({ next, notice }: { next: string; notice: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [canPasskey, setCanPasskey] = useState(false);

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
    <div className="space-y-4">
      <FormNotice message={notice} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="login-email" label="Email or username" error={fields.email}>
          <Input id="login-email" name="email" type="text" inputMode="email" autoComplete="username webauthn" autoCapitalize="none"
            spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus
            aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("login-email", fields.email)} />
        </Field>
        <Field id="login-password" label="Password" error={fields.password}>
          <Input id="login-password" name="password" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!fields.password || undefined} aria-describedby={describedBy("login-password", fields.password)} />
        </Field>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={busy !== null}>{busy === "password" ? "Signing in…" : "Sign in"}</Button>
      </form>
      {canPasskey && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
          </div>
          <Button type="button" variant="secondary" className="w-full" onClick={passkey} disabled={busy !== null}>
            <KeyRound size={16} aria-hidden="true" />
            {busy === "passkey" ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </Button>
        </>
      )}
    </div>
  );
}
