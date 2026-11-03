/** zod schemas for every auth route body. Pure; shared by the routes and their tests. */
import { z } from "zod";
import { passwordProblem } from "./passwords";

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign-in name: an email address, or a short username (handy for children without email). Stored lowercase. */
export const loginName = z.string().trim().toLowerCase().min(1, "Enter your email or username.").max(254, "That is too long.")
  .refine((s) => EMAIL.test(s) || USERNAME.test(s), "Enter an email address, or a username of 3–40 letters, digits, dots or dashes.");

export const personName = z.string().trim().min(1, "Enter a name.").max(80, "Keep the name under 80 characters.");

/** A new password that meets the rules (context checks happen in the route with passwordProblem). */
export const newPassword = z.string().max(1000, "That password is too long.").superRefine((s, ctx) => {
  const problem = passwordProblem(s);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const loginBody = z.object({
  email: loginName,
  password: z.string().min(1, "Enter your password.").max(1000),
});

export const setupBody = z.object({
  householdName: z.string().trim().min(1, "Give your household a name.").max(80),
  name: personName,
  email: z.string().trim().toLowerCase().regex(EMAIL, "Enter a valid email address.").max(254),
  password: newPassword,
});

export const profileBody = z.object({
  name: personName,
  email: loginName,
});

export const changePasswordBody = z.object({
  currentPassword: z.string().max(1000).optional(),
  newPassword,
  signOutOthers: z.boolean().default(true),
});

const thisYear = () => new Date().getUTCFullYear();

export const memberRole = z.enum(["parent", "child", "guest"]);

export const createMemberBody = z.object({
  role: memberRole,
  name: personName,
  email: loginName,
  password: newPassword,
  birthYear: z.coerce.number().int().min(1900).max(9999).nullish(),
  /** ISO date or datetime; guests only. */
  accessExpiresAt: z.coerce.date().nullish(),
}).superRefine((m, ctx) => {
  if (m.role === "child") {
    if (m.birthYear == null) ctx.addIssue({ code: "custom", path: ["birthYear"], message: "Enter the year the child was born." });
    else if (m.birthYear > thisYear() || m.birthYear < thisYear() - 30) ctx.addIssue({ code: "custom", path: ["birthYear"], message: "Enter a birth year within the last 30 years." });
  }
  if (m.role === "guest") {
    if (!m.accessExpiresAt) ctx.addIssue({ code: "custom", path: ["accessExpiresAt"], message: "Choose when the guest's access ends." });
    else if (m.accessExpiresAt.getTime() <= Date.now()) ctx.addIssue({ code: "custom", path: ["accessExpiresAt"], message: "Pick a date in the future." });
  }
});

export const updateMemberBody = z.object({
  name: personName.optional(),
  email: loginName.optional(),
  role: memberRole.optional(),
  birthYear: z.coerce.number().int().min(1900).max(9999).nullish(),
  accessExpiresAt: z.coerce.date().nullish(),
  password: newPassword.optional(),
  /** Turns off password and passkey sign-in and signs the member out everywhere. Their brain stays. */
  disableSignIn: z.boolean().optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change.");

export const passkeyRenameBody = z.object({ name: z.string().trim().min(1, "Give the passkey a name.").max(60) });

export const passkeyVerifyBody = z.object({
  challengeId: z.uuid(),
  /** The browser's JSON response; @simplewebauthn/server validates its structure. */
  response: z.looseObject({ id: z.string().min(1).max(1024), rawId: z.string().min(1).max(1024), type: z.literal("public-key") }),
  name: z.string().trim().max(60).optional(),
});

export const idParam = z.object({ id: z.uuid("That id isn't valid.") });

export const approveDeviceBody = z.object({ approve: z.boolean() });
