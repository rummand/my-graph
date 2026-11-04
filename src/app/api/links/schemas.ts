import { z } from "zod";

const id = z.uuid({ message: "Not a valid id" });
const field = z.string().trim().min(1).max(80).regex(/^(label|kind|aliases|summary|props\.[A-Za-z0-9_-]{1,60})$/, "Not a field that can be shared");

export const nodeQuery = z.object({ nodeId: id });
export const candidatesQuery = z.object({
  nodeId: id,
  q: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().trim().max(200).optional()),
  graphId: z.preprocess((v) => (v === "" || v === null ? undefined : v), id.optional()),
});
export const shareBody = z.object({
  nodeId: id, graphId: id, fields: z.array(field).max(40).default([]),
  visibility: z.enum(["private", "parents", "household"]).optional(),
});
export const connectBody = z.object({ nodeId: id, otherGraphId: id, otherNodeId: id, fields: z.array(field).max(40).optional() });
export const unlinkBody = z.object({ nodeId: id, otherNodeId: id.optional() });
