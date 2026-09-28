import type {
  AlertCategory,
  AlertSeverity,
  AlertType,
  MonitorWatch,
} from '../contracts';

/** An alert as monitoring describes it, before the inbox gives it an id and a time. */
export interface AlertDraft {
  type: AlertType;
  category: AlertCategory;
  severity: AlertSeverity;
  /** The kind of change it reports; null for a failure. */
  watch: MonitorWatch | null;
  message: string;
  /** One short line, shown as the monitor's "latest change". */
  summary: string;
}
