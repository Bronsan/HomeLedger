/**
 * The one error type the UI branches on.
 *
 * It lives in its own module because both the HTTP client and the local engine
 * throw it, and the HTTP client is the one that decides where a request goes.
 * Keeping it here avoids a cycle between those two files.
 */
export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}
