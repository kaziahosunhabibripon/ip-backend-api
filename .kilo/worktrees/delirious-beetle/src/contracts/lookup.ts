import type { Plan } from "./account";

/** What the user typed, once normalised. */
export type InputType = "domain" | "ipv4" | "ipv6";
export type IpVersion = 4 | 6;

/**
 * Entitlement wrapper. The backend decides what a caller may see and returns
 * `locked` instead of the data, so premium values never reach the browser for free users.
 */
export type Gated<T> =
  | { access: "included"; data: T }
  | { access: "locked"; requiredPlan: Plan };

export type SectionStatus = "ok" | "unavailable" | "timeout";

/** A slice of intelligence that can fail independently of the rest of the lookup. */
export type SectionResult<T> =
  | { status: "ok"; data: T }
  | { status: Exclude<SectionStatus, "ok">; message?: string };

// ---------------------------------------------------------------- providers

export type ProviderKey = "dns" | "geo" | "asn" | "security";

export interface ProviderState {
  status: SectionStatus;
  latencyMs?: number;
  message?: string;
}

export type ProviderStatusMap = Record<ProviderKey, ProviderState>;

// ---------------------------------------------------------------------- DNS

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "NS" | "TXT" | "SOA" | "PTR";

export interface DNSRecord {
  id: string;
  type: DnsRecordType;
  name: string;
  value: string;
  /** Seconds. */
  ttl: number;
  /** MX priority. */
  priority?: number;
}

export type DnsResolutionStatus = "resolved" | "no_records" | "nxdomain" | "timeout" | "servfail";

export interface DnsResult {
  status: DnsResolutionStatus;
  resolver: string;
  latencyMs: number;
  /** A, AAAA and CNAME — available to everyone. */
  records: DNSRecord[];
  /** MX, NS, TXT, SOA — Pro and above. */
  advanced: Gated<DNSRecord[]>;
}

// ------------------------------------------------------------ IP intelligence

export type ConnectionType =
  | "datacenter"
  | "cdn"
  | "residential"
  | "business"
  | "mobile"
  | "education"
  | "government"
  | "unknown";

export interface GeoLocation {
  country: string;
  countryCode: string;
  region: string;
  city: string;
  postalCode?: string;
  timezone: string;
  latitude: number;
  longitude: number;
  accuracyRadiusKm: number;
}

export interface NetworkInfo {
  asn: number;
  asnName: string;
  organization: string;
  isp: string;
  /** CIDR block the address belongs to. */
  network: string;
  domain?: string;
  connectionType: ConnectionType;
  anycast: boolean;
}

/** clear = nothing found, warning = weak/suspected signal, detected = confirmed. */
export type SignalState = "clear" | "warning" | "detected";

export interface SecuritySignal {
  state: SignalState;
  /** One plain-English sentence, safe to show to non-experts. */
  summary: string;
}

/** Headline flags available on every plan. */
export interface BasicSecurity {
  vpn: SecuritySignal;
  proxy: SecuritySignal;
  tor: SecuritySignal;
  datacenter: SecuritySignal;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Detail behind the headline flags plus reputation data — Pro and above. */
export interface AdvancedSecurity {
  vpn: { provider?: string; confidence: number };
  proxy: { kind?: "public" | "residential" | "datacenter" | "anonymous"; confidence: number };
  tor: { role?: "exit" | "relay" };
  residentialProxy: SecuritySignal & { confidence: number };
  reputation: {
    /** 0 (clean) – 100 (abusive). */
    score: number;
    level: RiskLevel;
    categories: string[];
    lastReportedAt?: string;
  };
  blacklists: {
    checked: number;
    listed: number;
    entries: { name: string; listedAt: string }[];
  };
  abuseContact?: string;
}

export interface SecurityIntelligence {
  basic: BasicSecurity;
  advanced: Gated<AdvancedSecurity>;
}

export interface IPIntelligence {
  ip: string;
  version: IpVersion;
  /** Which DNS record type produced this address, when the target was a domain. */
  source?: "A" | "AAAA";
  geo: SectionResult<GeoLocation>;
  network: SectionResult<NetworkInfo>;
  security: SectionResult<SecurityIntelligence>;
}

// ------------------------------------------------------------------- results

export type CheckStatus = "completed" | "partial" | "no_records";

export interface HostingInfo {
  /** e.g. "Cloudflare", "Google Cloud", "GitHub". */
  provider: string;
  kind: "cdn" | "cloud" | "isp" | "self_hosted";
}

export interface DomainCheckResult {
  id: string;
  /** Exactly what the user submitted. */
  input: string;
  /** Normalised domain or IP. */
  target: string;
  type: InputType;
  status: CheckStatus;
  checkedAt: string;
  durationMs: number;
  cache: { hit: boolean; ageSeconds?: number };
  /** Null when the target is an IP address. */
  dns: DnsResult | null;
  hosting?: HostingInfo;
  ips: IPIntelligence[];
  providers: ProviderStatusMap;
  /** Only present when the target is an IP address. */
  reverseDns: Gated<string[]> | null;
}

export interface QuotaSnapshot {
  scope: "anonymous" | "account";
  used: number;
  limit: number;
  period: "day" | "month";
  resetsAt: string;
}

export interface CheckResponse {
  result: DomainCheckResult;
  quota: QuotaSnapshot;
  /** True when the check was written to the caller's history. */
  savedToHistory: boolean;
}

export interface CheckRequest {
  /** Domain, URL or IP address exactly as the user typed it. */
  target: string;
  /** Bypass the result cache (counts against quota). */
  refresh?: boolean;
}

// ------------------------------------------------------------------- history

export type HistoryStatus = CheckStatus | "failed";

export interface CheckHistory {
  id: string;
  target: string;
  type: InputType;
  ipCount: number;
  status: HistoryStatus;
  checkedAt: string;
}

export type HistoryTypeFilter = "all" | "domain" | "ip";
export type HistoryRangeFilter = "any" | "today" | "7d" | "30d";
export type HistorySort = "newest" | "oldest" | "target" | "ips";

export interface HistoryQuery {
  q?: string;
  type?: HistoryTypeFilter;
  range?: HistoryRangeFilter;
  sort?: HistorySort;
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
