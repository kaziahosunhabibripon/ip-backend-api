import type { AlertSeverity } from '../contracts';

const RANK: Record<AlertSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const maxSeverity = (severities: AlertSeverity[]): AlertSeverity =>
  severities.reduce<AlertSeverity>(
    (top, next) => (RANK[next] > RANK[top] ? next : top),
    'info',
  );

export const isAtLeast = (severity: AlertSeverity, floor: AlertSeverity) =>
  RANK[severity] >= RANK[floor];
