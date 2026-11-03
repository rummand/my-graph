import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://mygraph:mygraph@localhost:5433/mygraph";

// One pool per process (Next dev reloads modules; keep the client on globalThis).
const g = globalThis as unknown as { __pg?: ReturnType<typeof postgres> };
export const sql = g.__pg ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") g.__pg = sql;

export const db = drizzle(sql, { schema });
export { schema };
