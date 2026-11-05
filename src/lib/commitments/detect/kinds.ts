import type { CommitmentKind } from "../types";

/** Every commitment kind, for validation (the contract's union as a list). */
export const COMMITMENT_KINDS_LIST: CommitmentKind[] = ["reply", "payment", "renewal", "notice", "appointment", "form", "deliver", "return", "other"];
