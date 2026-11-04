"use client";
/** CONTRACT (client side of src/lib/i18n): `const t = useT()`. Provider is mounted in the root layout by the i18n workstream. */
import { interpolate, type TFn } from "./index";

export function useT(): TFn {
  return (key, vars) => interpolate(key, vars);
}
