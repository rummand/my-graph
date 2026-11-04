"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ArrowLeft } from "lucide-react";
import { clsx } from "clsx";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote } from "../login/notes";
import { useT } from "@/lib/i18n/client";

type Step = "home" | "you";
const STEPS: { key: Step; label: string }[] = [{ key: "home", label: "auth.setup.stepHome" }, { key: "you", label: "auth.setup.stepYou" }];

/** First run as two short steps: name the household, then create the owner's account. One request at the end. */
/** `mark` is the product mark, rendered on the server (the shell module is server-only). */
export function SetupForm({ mark }: { mark: ReactNode }) {
  const router = useRouter();
  const t = useT();
  const [step, setStep] = useState<Step>("home");
  const [f, setF] = useState({ householdName: "", name: "", email: "", password: "", confirm: "" });
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dir = useRef(1);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const go = (s: Step) => { dir.current = s === "you" ? 1 : -1; setStep(s); };

  function nextStep(e: React.FormEvent) {
    e.preventDefault();
    if (!f.householdName.trim()) { setFields({ householdName: t("auth.setup.errHome") }); return; }
    setFields({});
    go("you");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const errs: FieldErrors = {};
    if (!f.name.trim()) errs.name = t("auth.setup.errName");
    if (!f.email.trim()) errs.email = t("auth.setup.errEmail");
    if (f.password.length < 10) errs.password = t("auth.setup.errShort");
    if (f.password !== f.confirm) errs.confirm = t("auth.setup.errMatch");
    setFields(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("/api/auth/setup", { json: { householdName: f.householdName, name: f.name, email: f.email, password: f.password } });
      router.replace("/settings/family?welcome=1");
      router.refresh();
    } catch (err) {
      const fe = errorFields(err);
      setFields(fe);
      setError(errorMessage(err));
      if (fe.householdName) go("home");
      setBusy(false);
    }
  }

  const input = (k: keyof typeof f, props: React.InputHTMLAttributes<HTMLInputElement>, hint?: boolean) => (
    <Input id={`setup-${k}`} name={k} value={f[k]} onChange={set(k)} aria-invalid={!!fields[k] || undefined} className="h-10"
      aria-describedby={describedBy(`setup-${k}`, fields[k], hint)} {...props} />
  );
  const index = STEPS.findIndex((s) => s.key === step);

  return (
    <MotionConfig reducedMotion="user">
      <ol className="mb-8 grid grid-cols-2 gap-2" aria-label={t("auth.setup.steps")}>
        {STEPS.map((s, i) => (
          <li key={s.key} aria-current={i === index ? "step" : undefined}>
            <span className={clsx("block h-1 rounded-full transition-colors duration-300", i <= index ? "bg-fg" : "bg-surface-2")} />
            <span className={clsx("mt-2 block text-sm", i === index ? "font-medium text-fg" : "text-muted")}>{t(s.label)}</span>
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait" initial={false} custom={dir.current}>
        {step === "home" ? (
          <motion.form key="home" onSubmit={nextStep} noValidate custom={dir.current} {...slide}>
            <Field id="setup-householdName" label={t("auth.setup.homeLabel")} error={fields.householdName} hint={t("auth.setup.homeHint")}>
              {input("householdName", { autoFocus: true, maxLength: 80 }, true)}
            </Field>
            <div className="mt-6 rounded-lg bg-surface-2/70 p-3 lg:bg-bg">
              <p className="mb-2 text-xs text-muted">{t("auth.setup.preview")}</p>
              <div className="flex items-center gap-2.5">
                {mark}
                <span className="min-w-0 leading-tight">
                  <span className="block text-sm font-semibold">My Graph</span>
                  <span className={clsx("block truncate text-xs", f.householdName.trim() ? "text-muted" : "text-muted/60")}>{f.householdName.trim() || t("auth.setup.previewEmpty")}</span>
                </span>
              </div>
            </div>
            <Button type="submit" className="mt-8 h-10 w-full">{t("auth.setup.continue")}</Button>
          </motion.form>
        ) : (
          <motion.form key="you" onSubmit={submit} noValidate custom={dir.current} {...slide}>
            <p className="mb-6 text-sm text-muted">{t("auth.setup.owner", { home: f.householdName.trim() })}</p>
            <div className="space-y-4">
              <Field id="setup-name" label={t("auth.setup.name")} error={fields.name}>
                {input("name", { autoComplete: "name", maxLength: 80, autoFocus: true })}
              </Field>
              <Field id="setup-email" label={t("auth.setup.email")} error={fields.email}>
                {input("email", { type: "email", autoComplete: "email", autoCapitalize: "none", spellCheck: false })}
              </Field>
              <Field id="setup-password" label={t("auth.setup.password")} error={fields.password} hint={t("auth.setup.passwordHint")}>
                {input("password", { type: "password", autoComplete: "new-password" }, true)}
              </Field>
              <Field id="setup-confirm" label={t("auth.setup.again")} error={fields.confirm}>
                {input("confirm", { type: "password", autoComplete: "new-password" })}
              </Field>
            </div>
            <ErrorNote message={error} className="mt-4" />
            <div className="mt-8 flex gap-2">
              <Button type="button" variant="ghost" className="h-10" onClick={() => go("home")} disabled={busy}>
                <ArrowLeft size={16} aria-hidden />{t("auth.setup.back")}
              </Button>
              <Button type="submit" className="h-10 flex-1" disabled={busy}>{busy ? t("auth.setup.creating") : t("auth.setup.create")}</Button>
            </div>
            <p className="mt-4 text-sm text-muted">{t("auth.setup.passkeyLater")}</p>
          </motion.form>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

const slide = {
  variants: {
    enter: (d: number) => ({ opacity: 0, x: 16 * d }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: -16 * d }),
  },
  initial: "enter", animate: "center", exit: "exit",
  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const },
};
