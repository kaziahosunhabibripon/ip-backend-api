import type { ApiErrorCode } from "./api";
import type { ConnectionType, InputType, RiskLevel, SignalState } from "./lookup";

// ----------------------------------------------------------------- bulk lookup

/** A batch moves queued → running → completed; it never goes back. Deleting it (at any point) cancels what is left. */
export type BulkJobStatus = "queued" | "running" | "completed";

/**
 * One line of a batch.
 * - `pending`: not looked at yet.
 * - `completed` / `partial` / `no_records`: the lookup's own status.
 * - `failed`: nothing came back (DNS timeout, every provider down).
 * - `invalid`: the line isn't a domain or public IP address; it costs nothing.
 * - `skipped`: never run, because the batch stopped first (see `BulkJob.stoppedReason`).
 */
export type BulkItemStatus = "pending" | "completed" | "partial" | "no_records" | "failed" | "invalid" | "skipped";

/** Why a batch stopped before every line was looked at. `quota`: the month's lookups ran out. `plan`: the account no longer has bulk lookup. */
export type BulkStopReason = "quota" | "plan";

/** The headline of one result, enough for a table and a CSV row. Taken from the first address when a domain has several. */
export interface BulkItemSummary {
  ips: string[];
  country: string | null;
  city: string | null;
  asn: number | null;
  organization: string | null;
  connectionType: ConnectionType | null;
  /** 0 (clean) – 100 (abusive). */
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  vpn: SignalState | null;
  proxy: SignalState | null;
  tor: SignalState | null;
  datacenter: SignalState | null;
}

export interface BulkItemError {
  code: ApiErrorCode;
  message: string;
}

export interface BulkItem {
  /** Line number within the batch, from 1, in the order submitted. */
  position: number;
  /** Exactly what was submitted. */
  input: string;
  /** Normalised domain or IP; null for an invalid line. */
  target: string | null;
  type: InputType | null;
  status: BulkItemStatus;
  summary: BulkItemSummary | null;
  error: BulkItemError | null;
}

export interface BulkJob {
  id: string;
  name: string | null;
  status: BulkJobStatus;
  /** Lines in the batch (after removing blanks and repeats). */
  total: number;
  /** Lines no longer pending, whatever the outcome. */
  processed: number;
  /** Lines that came back with a result (`completed`, `partial` or `no_records`). */
  succeeded: number;
  /** Lines that failed or were invalid. */
  failed: number;
  skipped: number;
  /** Repeats of an earlier line that were left out. */
  duplicates: number;
  stoppedReason: BulkStopReason | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateBulkRequest {
  /** One domain, URL or IP address per entry, as typed. */
  targets: string[];
  /** A label to recognise the batch by. */
  name?: string;
}

export interface BulkOverview {
  /** Newest first. */
  jobs: BulkJob[];
  /** Most lines one batch may hold on this plan; null when it is negotiated (Enterprise). */
  batchSize: number | null;
  /** Batches that may be queued or running at once. */
  openJobsLimit: number;
}

export interface BulkJobPage {
  job: BulkJob;
  items: BulkItem[];
  offset: number;
  limit: number;
}
