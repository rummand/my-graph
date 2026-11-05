/** An error with an HTTP status and a message that is safe to show to the person uploading. */
export class IngestError extends Error {
  readonly status: number;
  /** A stable name for the problem, so the page can say it in the reader's language ("nameTaken", "cycle" …). */
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "IngestError";
  }
}
