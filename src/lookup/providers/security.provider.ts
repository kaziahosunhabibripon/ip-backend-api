import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AdvancedSecurity,
  BasicSecurity,
  NetworkInfo,
  RiskLevel,
  SecurityIntelligence,
  SecuritySignal,
} from '../../contracts';
import { ProviderUnavailableError } from './provider.types';
import { TorExitListService } from './tor-exit-list.service';

/** The `data` object of AbuseIPDB's CHECK endpoint (with `verbose`). */
export interface AbuseIpdbReport {
  abuseConfidenceScore: number;
  usageType?: string | null;
  isTor?: boolean;
  totalReports?: number;
  lastReportedAt?: string | null;
  reports?: { reportedAt: string; categories: number[] }[];
}

// https://www.abuseipdb.com/categories
const CATEGORY_NAMES: Record<number, string> = {
  1: 'DNS Compromise',
  2: 'DNS Poisoning',
  3: 'Fraud Orders',
  4: 'DDoS Attack',
  5: 'FTP Brute-Force',
  6: 'Ping of Death',
  7: 'Phishing',
  8: 'Fraud VoIP',
  9: 'Open Proxy',
  10: 'Web Spam',
  11: 'Email Spam',
  12: 'Blog Spam',
  13: 'VPN IP',
  14: 'Port Scan',
  15: 'Hacking',
  16: 'SQL Injection',
  17: 'Spoofing',
  18: 'Brute-Force',
  19: 'Bad Web Bot',
  20: 'Exploited Host',
  21: 'Web App Attack',
  22: 'SSH',
  23: 'IoT Targeted',
};
const CATEGORY_OPEN_PROXY = 9;
const CATEGORY_VPN = 13;
const BLACKLIST_SCORE = 50;

const riskLevel = (score: number): RiskLevel =>
  score >= 75
    ? 'critical'
    : score >= 50
      ? 'high'
      : score >= 25
        ? 'medium'
        : 'low';

const signal = (
  count: number,
  percent: number,
  detected: string,
  clear: string,
): SecuritySignal => {
  if (count === 0) {
    return { state: 'clear', summary: clear };
  }
  return {
    state: percent >= 30 ? 'detected' : 'warning',
    summary: detected.replace('{n}', String(count)),
  };
};

/**
 * Turns one AbuseIPDB report (plus the Tor list and what we know of the network) into the
 * `SecurityIntelligence` shape. Every signal says where it comes from, so "clear" only ever means
 * "not flagged by the sources we check" — never "safe".
 */
export const buildSecurityIntelligence = (
  report: AbuseIpdbReport,
  network: NetworkInfo,
  onTorList: boolean,
  now = new Date(),
): SecurityIntelligence => {
  const reports = report.reports ?? [];
  const perCategory = new Map<number, number>();
  for (const entry of reports) {
    for (const category of new Set(entry.categories)) {
      perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
    }
  }
  const countOf = (category: number) => perCategory.get(category) ?? 0;
  const percentOf = (category: number) =>
    reports.length ? Math.round((countOf(category) / reports.length) * 100) : 0;

  const isTor = Boolean(report.isTor) || onTorList;
  const hostingUsage = /data center|web hosting|transit/i.test(
    report.usageType ?? '',
  );
  const inDatacenter = hostingUsage || network.connectionType === 'datacenter';
  const score = Math.round(report.abuseConfidenceScore);

  const basic: BasicSecurity = {
    vpn: signal(
      countOf(CATEGORY_VPN),
      percentOf(CATEGORY_VPN),
      '{n} recent abuse reports describe this address as a VPN.',
      'No recent reports describe this address as a VPN.',
    ),
    proxy: signal(
      countOf(CATEGORY_OPEN_PROXY),
      percentOf(CATEGORY_OPEN_PROXY),
      '{n} recent abuse reports describe this address as an open proxy.',
      'No recent reports describe this address as an open proxy.',
    ),
    tor: isTor
      ? { state: 'detected', summary: 'This address is a known Tor exit node.' }
      : { state: 'clear', summary: 'Not a known Tor exit node.' },
    datacenter: inDatacenter
      ? {
          state: 'detected',
          summary: 'This address belongs to a hosting or data-center network.',
        }
      : {
          state: 'clear',
          summary: 'Not part of a hosting or data-center network.',
        },
  };

  const entries: { name: string; listedAt: string }[] = [];
  if (isTor) {
    entries.push({ name: 'Tor exit node list', listedAt: now.toISOString() });
  }
  if (score >= BLACKLIST_SCORE) {
    entries.push({
      name: `AbuseIPDB (confidence ${BLACKLIST_SCORE}% or higher)`,
      listedAt: report.lastReportedAt ?? now.toISOString(),
    });
  }

  const categories = [...perCategory.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .flatMap(([id]) => (CATEGORY_NAMES[id] ? [CATEGORY_NAMES[id]] : []));

  const advanced: AdvancedSecurity = {
    vpn: { confidence: percentOf(CATEGORY_VPN) },
    proxy: {
      kind: countOf(CATEGORY_OPEN_PROXY) > 0 ? 'public' : undefined,
      confidence: percentOf(CATEGORY_OPEN_PROXY),
    },
    tor: { role: isTor ? 'exit' : undefined },
    residentialProxy: {
      state: 'clear',
      summary:
        "Residential proxy detection isn't available with the current data sources.",
      confidence: 0,
    },
    reputation: {
      score,
      level: riskLevel(score),
      categories,
      lastReportedAt: report.lastReportedAt ?? undefined,
    },
    blacklists: { checked: 2, listed: entries.length, entries },
  };

  return { basic, advanced: { access: 'included', data: advanced } };
};

@Injectable()
export class SecurityProvider {
  private readonly logger = new Logger(SecurityProvider.name);
  private readonly apiKey: string | undefined;

  constructor(
    config: ConfigService,
    private readonly torList: TorExitListService,
  ) {
    this.apiKey = config.get<string>('ABUSEIPDB_API_KEY')?.trim() || undefined;
    if (!this.apiKey) {
      this.logger.warn(
        'ABUSEIPDB_API_KEY is not set — the security section will report "unavailable" until it is.',
      );
    }
  }

  async assess(
    ip: string,
    network: NetworkInfo | null,
    signal: AbortSignal,
  ): Promise<SecurityIntelligence> {
    if (!this.apiKey) {
      throw new ProviderUnavailableError(
        'Security intelligence is not configured on this server.',
      );
    }

    const report = await this.fetchReport(ip, this.apiKey, signal);
    return buildSecurityIntelligence(
      report,
      network ?? {
        asn: 0,
        asnName: '',
        organization: '',
        isp: '',
        network: '',
        connectionType: 'unknown',
        anycast: false,
      },
      this.torList.isExit(ip),
    );
  }

  private async fetchReport(
    ip: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<AbuseIpdbReport> {
    const query = new URLSearchParams({ ipAddress: ip, maxAgeInDays: '90' });
    const response = await fetch(
      `https://api.abuseipdb.com/api/v2/check?${query.toString()}&verbose`,
      { headers: { Key: apiKey, Accept: 'application/json' }, signal },
    );

    if (response.status === 429) {
      throw new ProviderUnavailableError(
        'The security data source is limiting requests. Try again shortly.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      this.logger.error(
        `AbuseIPDB rejected the API key (HTTP ${response.status}).`,
      );
      throw new ProviderUnavailableError(
        'Security intelligence is not configured correctly.',
      );
    }
    if (!response.ok) {
      throw new ProviderUnavailableError(
        'The security data source is not responding.',
      );
    }

    const body = (await response.json()) as { data?: AbuseIpdbReport };
    if (!body.data || typeof body.data.abuseConfidenceScore !== 'number') {
      throw new ProviderUnavailableError(
        'The security data source returned an unexpected answer.',
      );
    }

    return body.data;
  }
}
