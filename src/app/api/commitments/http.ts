/** Small helpers for the commitments route handlers. */
import { NextResponse } from "next/server";
import { CommitmentError } from "@/lib/commitments";
import { GBrainError } from "@/lib/gbrain";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/** Runs a handler: a thrown Response (signed out) passes through; known errors keep their status; the rest is a 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) return err;
    if (err instanceof CommitmentError || err instanceof GBrainError) return jsonError(err.status, err.message);
    console.error("[commitments]", err);
    return jsonError(500, "Something went wrong on our side. Please try again.");
  }
}
