/** An error with an HTTP status and a message that is safe to show to the person uploading. */
export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "IngestError";
  }
}
