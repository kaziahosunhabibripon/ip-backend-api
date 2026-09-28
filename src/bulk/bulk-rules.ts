import type {
  BulkItem,
  BulkItemError,
  BulkItemStatus,
  BulkItemSummary,
  BulkJob,
  BulkJobStatus,
  BulkStopReason,
  DomainCheckResult,
  InputType,
  Plan,
} from '../contracts';
import { PLAN_LIMITS } from '../common/plans';
import { normalizeTarget } from '../lookup/normalizer/target-normalizer';

/** What "custom" (Enterprise) means in practice: no batch is worth more than this in one request. */
export const BULK_HARD_CAP = 10_000;
/** Batches one account may have queued or running at once. */
export const MAX_OPEN_JOBS = 2;
export const MAX_NAME_LENGTH = 80;

/** Most lines one batch may hold on this plan; 0 when the plan has no bulk lookup. */
export const batchLimitFor = (plan: Plan): number =>
  PLAN_LIMITS[plan].bulkBatchSize ?? BULK_HARD_CAP;

/** What the API tells the client: `null` for a negotiated (Enterprise) size. */
export const advertisedBatchSize = (plan: Plan): number | null =>
  PLAN_LIMITS[plan].bulkBatchSize;

export interface PreparedItem {
  position: number;
  input: string;
  target: string | null;
  type: InputType | null;
  status: 'pending' | 'invalid';
  error: BulkItemError | null;
  /** Set when the line was refused for being an internal address: the caller reports it to abuse detection. */
  internal: boolean;
}

export interface Prepared {
  items: PreparedItem[];
  duplicates: number;
}

/**
 * Turns what was typed into the lines of a batch. Blank entries are dropped; a line that names the same target
 * as an earlier one is left out (and counted); a line that isn't a domain or public IP address is kept, marked
 * `invalid`, so the person sees which of their lines was refused and why instead of a smaller batch than they sent.
 * Positions run from 1 over the lines that were kept.
 */
export const prepareEntries = (entries: string[]): Prepared => {
  const items: PreparedItem[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const raw of entries) {
    const input = raw.trim();
    if (!input) {
      continue;
    }

    const normalized = normalizeTarget(input);
    if (!normalized.ok) {
      const key = `invalid:${input}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      items.push({
        position: items.length + 1,
        input,
        target: null,
        type: null,
        status: 'invalid',
        error: {
          code: 'INVALID_INPUT',
          message: normalized.title,
        },
        internal:
          normalized.reason === 'private_ip' ||
          normalized.reason === 'reserved_domain',
      });
      continue;
    }

    if (seen.has(normalized.value)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized.value);
    items.push({
      position: items.length + 1,
      input,
      target: normalized.value,
      type: normalized.type,
      status: 'pending',
      error: null,
      internal: false,
    });
  }

  return { items, duplicates };
};

/** The lookup's own status, as the batch line's status. */
export const itemStatusOf = (
  status: DomainCheckResult['status'],
): DomainCheckResult['status'] => status;

/** The headline of a result: what a table row and a CSV line need. Reads the first address when a domain has several. */
export const summarize = (result: DomainCheckResult): BulkItemSummary => {
  const first = result.ips[0];
  const geo = first?.geo.status === 'ok' ? first.geo.data : null;
  const network = first?.network.status === 'ok' ? first.network.data : null;
  const security = first?.security.status === 'ok' ? first.security.data : null;
  const advanced =
    security?.advanced.access === 'included' ? security.advanced.data : null;

  return {
    ips: result.ips.map((entry) => entry.ip),
    country: geo?.country ?? null,
    city: geo?.city || null,
    asn: network?.asn ?? null,
    organization: network?.organization ?? null,
    connectionType: network?.connectionType ?? null,
    riskScore: advanced?.reputation.score ?? null,
    riskLevel: advanced?.reputation.level ?? null,
    vpn: security?.basic.vpn.state ?? null,
    proxy: security?.basic.proxy.state ?? null,
    tor: security?.basic.tor.state ?? null,
    datacenter: security?.basic.datacenter.state ?? null,
  };
};

export interface JobCounts {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/** Folds the per-status row counts of one job into the numbers a job shows. */
export const countsFrom = (
  byStatus: Partial<Record<BulkItemStatus, number>>,
): JobCounts => {
  const n = (status: BulkItemStatus) => byStatus[status] ?? 0;
  const succeeded = n('completed') + n('partial') + n('no_records');
  const failed = n('failed') + n('invalid');
  const skipped = n('skipped');
  return {
    processed: succeeded + failed + skipped,
    succeeded,
    failed,
    skipped,
  };
};

export interface JobRow {
  id: string;
  name: string | null;
  status: BulkJobStatus;
  duplicates: number;
  stoppedReason: BulkStopReason | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export const toBulkJob = (
  row: JobRow,
  byStatus: Partial<Record<BulkItemStatus, number>>,
): BulkJob => {
  const counts = countsFrom(byStatus);
  const total = Object.values(byStatus).reduce((sum, n) => sum + (n ?? 0), 0);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    total,
    ...counts,
    duplicates: row.duplicates,
    stoppedReason: row.stoppedReason,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
};

export interface ItemRow {
  position: number;
  input: string;
  target: string | null;
  type: InputType | null;
  status: BulkItemStatus;
  summary: BulkItemSummary | null;
  error: BulkItemError | null;
}

export const toBulkItem = (row: ItemRow): BulkItem => ({
  position: row.position,
  input: row.input,
  target: row.target,
  type: row.type,
  status: row.status,
  summary: row.summary,
  error: row.error,
});
