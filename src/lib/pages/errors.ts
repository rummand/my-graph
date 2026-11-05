/** A problem the caller can act on; `status` maps straight to an HTTP status, `details` is merged into the JSON body. */
export class WikiError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 413 | 422, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "WikiError";
  }
}
