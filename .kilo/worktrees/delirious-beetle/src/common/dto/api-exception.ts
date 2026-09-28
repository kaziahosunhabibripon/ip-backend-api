/**
 * Mirrors `types/api.ts` in ipscope-web. Keep these two lists identical —
 * the frontend's ERROR_CATALOG maps every one of these codes to a designed UI state.
 */
export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'PLAN_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'DNS_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK'
  | 'INTERNAL';

export type ApiErrorDetails = Record<string, string | number | boolean>;

/** HTTP status per code, from NESTJS_BACKEND_PLAN.md §4.1. NETWORK is client-only, never thrown here. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  INVALID_INPUT: 422,
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  CONFLICT: 409,
  FORBIDDEN: 403,
  PLAN_REQUIRED: 403,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  DNS_TIMEOUT: 504,
  PROVIDER_UNAVAILABLE: 503,
  NETWORK: 0,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetails;
  };
}

/** Throw this from a service or guard; ApiExceptionFilter turns it into the exact body ipscope-web expects. */
export class ApiException extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiException';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = details;
  }
}
