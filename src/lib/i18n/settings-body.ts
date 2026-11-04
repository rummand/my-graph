/** The body of PATCH /api/settings, shared by the route and its tests. */
import { z } from "zod";
import { LOCALES, THEMES } from "./core";
import { isTimeZone } from "./dates";

export const settingsBody = z.object({
  locale: z.enum(LOCALES as [string, ...string[]], { message: "Choose English or Dansk." }).optional(),
  theme: z.enum(THEMES as [string, ...string[]], { message: "Choose System, Light or Dark." }).optional(),
  timeZone: z.string().refine(isTimeZone, "That isn't a time zone we know.").optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

export type SettingsBody = z.infer<typeof settingsBody>;
