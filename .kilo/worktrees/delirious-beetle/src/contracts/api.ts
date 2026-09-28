/**
 * Error codes shared with the backend. The UI maps these to designed error states,
 * so the backend should return the same strings in `{ error: { code, message } }`.
 */
export type ApiErrorCode =
  | "INVALID_INPUT"
  | "AUTH_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "CONFLICT"
  | "FORBIDDEN"
  | "PLAN_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "DNS_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK"
  | "INTERNAL";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Machine-readable extras, e.g. `retryAfterSeconds` or `reason`. */
    details?: Record<string, string | number | boolean>;
  };
}
