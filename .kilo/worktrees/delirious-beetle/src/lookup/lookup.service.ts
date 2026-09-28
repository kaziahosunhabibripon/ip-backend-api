import { Injectable, Logger } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { AbuseService } from '../abuse/abuse.service';
import { ApiException } from '../common/dto/api-exception';
import { tierOf } from '../common/features';
import { buildQuotaSnapshot, quotaFromScope } from '../common/quota';
import type { ApiKeyPrincipal } from '../api-keys/api-key-auth.service';
import { CacheService } from '../cache/cache.service';
import type {
  CheckResponse,
  CheckStatus,
  DomainCheckResult,
  GeoLocation,
  HostingInfo,
  InputType,
  IPIntelligence,
  NetworkInfo,
  ProviderState,
  ProviderStatusMap,
  SectionResult,
  SectionStatus,
  SecurityIntelligence,
  User,
} from '../contracts';
import {
  UsageEventsService,
  type LatencyByProvider,
  type LookupEventInput,
} from '../usage/usage-events.service';
import { UsageService, type UsageScope } from '../usage/usage.service';
import { CheckStore } from './check-store.service';
import { applyEntitlements } from './gating';
import { isPublicIp } from './normalizer/ip-address';
import { normalizeTarget } from './normalizer/target-normalizer';
import { AsnProvider } from './providers/asn.provider';
import {
  DnsProvider,
  type DnsLookup,
  type ResolvedAddress,
} from './providers/dns.provider';
import { GeoProvider } from './providers/geo.provider';
import { ProviderRunner, type Outcome } from './providers/provider-runner';
import { SecurityProvider } from './providers/security.provider';

export interface Viewer {
  user: User | null;
  ip: string | undefined;
  /** Set when the request was authenticated with an API key rather than a session or nothing. */
  apiKey?: ApiKeyPrincipal;
  /** A bulk batch keeps its own results, so its lines must not also flood the account's history page. */
  skipHistory?: boolean;
}

/** Which providers must skip the cache for one analysis. */
interface Freshness {
  dns: boolean;
  security: boolean;
}

const RESULT_TTL_SECONDS = 600;
const DNS_TTL_SECONDS = 300;
const ADVANCED_DNS_TTL_SECONDS = 900;
const PTR_TTL_SECONDS = 900;
const SECURITY_TTL_SECONDS = 3600;

const TIMEOUT_MS = {
  dns: 5000,
  reverse: 3000,
  geo: 1000,
  asn: 1000,
  security: 4000,
};

/** A domain can resolve to dozens of addresses; analyzing more than this multiplies provider cost for little value. */
const MAX_ADDRESSES = 6;
/** Anycast addresses are served from many places at once, so a single pin on the map is only a rough guide. */
const ANYCAST_ACCURACY_KM = 2000;

const SEVERITY: Record<SectionStatus, number> = {
  ok: 0,
  unavailable: 1,
  timeout: 2,
};

/** Folds several provider calls (e.g. one per address) into the one status the UI shows for that provider. */
const summarize = (outcomes: Outcome<unknown>[]): ProviderState => {
  if (outcomes.length === 0) {
    return { status: 'ok' };
  }

  let status: SectionStatus = 'ok';
  let message: string | undefined;
  for (const { section } of outcomes) {
    if (SEVERITY[section.status] > SEVERITY[status]) {
      status = section.status;
      message = section.status === 'ok' ? undefined : section.message;
    }
  }

  const latencyMs = Math.max(...outcomes.map((outcome) => outcome.latencyMs));
  return status === 'ok'
    ? { status, latencyMs }
    : { status, latencyMs, message };
};

/** How long each provider that answered took — feeds the latency chart in usage analytics. */
const latencyOf = (providers: ProviderStatusMap): LatencyByProvider => {
  const latency: LatencyByProvider = {};
  for (const key of Object.keys(providers) as (keyof ProviderStatusMap)[]) {
    const provider = providers[key];
    if (provider.status === 'ok' && provider.latencyMs !== undefined) {
      latency[key] = provider.latencyMs;
    }
  }
  return latency;
};

const shortName = (organization: string) =>
  organization.replace(
    /,?\s+(inc|llc|ltd|limited|corp|corporation|gmbh)\.?$/i,
    '',
  );

const hostingOf = (network: NetworkInfo | null): HostingInfo | undefined => {
  if (!network) {
    return undefined;
  }
  if (network.connectionType === 'cdn') {
    return { provider: shortName(network.organization), kind: 'cdn' };
  }
  if (network.connectionType === 'datacenter') {
    return { provider: shortName(network.organization), kind: 'cloud' };
  }
  return undefined;
};

interface IpAnalysis {
  intelligence: IPIntelligence;
  geo: Outcome<GeoLocation>;
  asn: Outcome<NetworkInfo>;
  security: Outcome<SecurityIntelligence>;
}

@Injectable()
export class LookupService {
  private readonly logger = new Logger(LookupService.name);
  /** Identical concurrent requests share one run, so a double-click or a React Strict Mode double effect can't spend quota twice. */
  private readonly inflight = new Map<string, Promise<CheckResponse>>();
  /** Analyses in progress for API requests, shared between concurrent callers (each is still charged). */
  private readonly analyses = new Map<string, Promise<DomainCheckResult>>();

  constructor(
    private readonly runner: ProviderRunner,
    private readonly dns: DnsProvider,
    private readonly geo: GeoProvider,
    private readonly asn: AsnProvider,
    private readonly security: SecurityProvider,
    private readonly cache: CacheService,
    private readonly usage: UsageService,
    private readonly store: CheckStore,
    private readonly events: UsageEventsService,
    private readonly abuse: AbuseService,
  ) {}

  async check(
    input: string,
    viewer: Viewer,
    refresh: boolean,
  ): Promise<CheckResponse> {
    // Signed-out visitors are told apart by their (hashed) network, which is also what an administrator can block.
    const visitor = viewer.user ? null : this.usage.visitorId(viewer.ip);
    if (visitor && (await this.abuse.isBlocked(visitor))) {
      throw new ApiException(
        'FORBIDDEN',
        'Requests from your network have been blocked. Contact support if you think this is a mistake.',
      );
    }

    const normalized = normalizeTarget(input);
    if (!normalized.ok) {
      if (
        normalized.reason === 'private_ip' ||
        normalized.reason === 'reserved_domain'
      ) {
        // Somebody asking about localhost and private ranges is either confused or probing; a few are noise, many are a flag.
        void this.abuse.note(
          viewer.user ? 'account' : 'ip_address',
          viewer.user?.id ?? visitor ?? 'unknown',
          'internal_targets',
        );
      }
      throw new ApiException('INVALID_INPUT', normalized.title, {
        reason: normalized.reason,
        hint: normalized.message,
      });
    }

    if (viewer.apiKey && viewer.user) {
      return this.checkForApiKey(
        input.trim(),
        normalized.value,
        normalized.type,
        viewer.user,
        refresh,
      );
    }

    const scope = this.usage.scopeFor(viewer.user, viewer.ip);
    const key = `${scope.key}|${normalized.value}|${refresh}`;
    const running = this.inflight.get(key);
    if (running) {
      return running;
    }

    const work = this.execute(
      input.trim(),
      normalized.value,
      normalized.type,
      viewer,
      scope,
      refresh,
    ).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /**
   * A fresh look at a target for a monitor: everything the plans include (a monitor is a Pro feature), with
   * no quota spent, nothing saved to history and no analytics event — a monitor checking every five minutes
   * is not the user "looking things up". DNS is always read live so a change is seen when it happens; the
   * security reading may come from the cache, which keeps the AbuseIPDB budget for people's own lookups.
   * Throws the same `ApiException`s as `check` when nothing could be read.
   */
  inspect(target: string, type: InputType): Promise<DomainCheckResult> {
    return this.analyze(target, target, type, { dns: true, security: false });
  }

  async getSaved(id: string, user: User): Promise<CheckResponse> {
    const stored = await this.store.find(user.id, id);
    if (!stored) {
      throw new ApiException('NOT_FOUND', 'That check was not found.');
    }

    const used = await this.usage.getUsed(this.usage.scopeFor(user, undefined));
    return {
      result: applyEntitlements(stored, tierOf(user)),
      quota: buildQuotaSnapshot(user, used),
      savedToHistory: true,
    };
  }

  /**
   * A request made with an API key. It differs from a web lookup in three ways: every request counts against
   * the monthly API allowance (cache hits too — the allowance meters calls, not provider work; only a request
   * that got nothing back is refunded); nothing is saved to history, so a script can't fill someone's
   * history page; and the analytics event is tagged `api`. Concurrent identical requests still share one
   * analysis, so a burst of the same target costs the providers one run — but each caller is charged.
   */
  private async checkForApiKey(
    input: string,
    target: string,
    type: InputType,
    user: User,
    refresh: boolean,
  ): Promise<CheckResponse> {
    const started = Date.now();
    const scope = this.usage.apiScopeFor(user);

    const charge = await this.usage.tryConsume(scope);
    if (!charge.allowed) {
      throw new ApiException(
        'QUOTA_EXCEEDED',
        "You've used all your API requests for this month.",
        {
          scope: scope.kind,
          limit: scope.limit,
          resetsAt: scope.resetsAt.toISOString(),
        },
      );
    }

    try {
      const { result, cacheHit } = await this.resolveShared(
        input,
        target,
        type,
        refresh,
      );
      this.recordEvent(user, {
        source: 'api',
        status: result.status,
        cacheHit,
        durationMs: Date.now() - started,
        ...(cacheHit ? {} : { latency: latencyOf(result.providers) }),
      });
      return {
        result: applyEntitlements(result, tierOf(user)),
        quota: quotaFromScope(scope, charge.used),
        savedToHistory: false,
      };
    } catch (error) {
      // Nothing came back, so the request is free.
      await this.usage.refund(scope);
      this.recordEvent(user, {
        source: 'api',
        status: 'failed',
        cacheHit: false,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  /** The cached result if there is one, otherwise one analysis shared by every caller asking for it right now. */
  private async resolveShared(
    input: string,
    target: string,
    type: InputType,
    refresh: boolean,
  ): Promise<{ result: DomainCheckResult; cacheHit: boolean }> {
    const resultKey = `lookup:result:${target}`;
    if (!refresh) {
      const cached = await this.cache.get<DomainCheckResult>(resultKey);
      if (cached) {
        return {
          result: {
            ...cached.value,
            input,
            cache: { hit: true, ageSeconds: cached.ageSeconds },
          },
          cacheHit: true,
        };
      }
    }

    const shareKey = `${target}|${refresh}`;
    let running = this.analyses.get(shareKey);
    if (!running) {
      running = this.analyze(input, target, type, {
        dns: refresh,
        security: refresh,
      })
        .then(async (fresh) => {
          await this.cache.set(resultKey, fresh, RESULT_TTL_SECONDS);
          return fresh;
        })
        .finally(() => this.analyses.delete(shareKey));
      this.analyses.set(shareKey, running);
    }
    return { result: { ...(await running), input }, cacheHit: false };
  }

  /** Analytics bookkeeping for signed-in users; deliberately not awaited so it can't slow or fail a lookup. */
  private recordEvent(user: User | null, event: LookupEventInput) {
    if (user) {
      // A rejected, un-awaited promise would take the whole process down, so never leave one unhandled.
      this.events.record(user.id, event).catch((error: unknown) => {
        this.logger.error(
          `Could not record a lookup event: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  /** The lookup itself succeeded; failing to file it away shouldn't hide the answer. */
  private async saveToHistory<T>(
    checkId: string,
    save: () => Promise<T>,
  ): Promise<{ value: T } | null> {
    try {
      return { value: await save() };
    } catch (error) {
      this.logger.error(
        `Could not save check ${checkId} to history: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async execute(
    input: string,
    target: string,
    type: InputType,
    viewer: Viewer,
    scope: UsageScope,
    refresh: boolean,
  ): Promise<CheckResponse> {
    const started = Date.now();
    const { user } = viewer;
    const tier = tierOf(user);
    const resultKey = `lookup:result:${target}`;

    // A repeat of a recent lookup is served from the cache and doesn't spend quota.
    if (!refresh) {
      const cached = await this.cache.get<DomainCheckResult>(resultKey);
      if (cached) {
        const used = await this.usage.getUsed(scope);
        this.recordEvent(viewer.user, {
          status: cached.value.status,
          cacheHit: true,
          durationMs: Date.now() - started,
        });
        // Free of quota, but still something this user looked up, so it belongs in their history. The
        // response carries the id of their own saved copy: the cached report's id is someone else's.
        const saved =
          user && !viewer.skipHistory
            ? await this.saveToHistory(cached.value.id, () =>
                this.store.saveFromCache(user.id, { ...cached.value, input }),
              )
            : null;
        return {
          result: applyEntitlements(
            {
              ...cached.value,
              id: saved?.value ?? cached.value.id,
              input,
              cache: { hit: true, ageSeconds: cached.ageSeconds },
            },
            tier,
          ),
          quota: buildQuotaSnapshot(user, used),
          savedToHistory: saved !== null,
        };
      }
    }

    const charge = await this.usage.tryConsume(scope);
    if (!charge.allowed) {
      if (scope.kind === 'anonymous') {
        // Turned away for the day and asking again: a few retries are a person, hundreds are a script.
        void this.abuse.note(
          'ip_address',
          this.usage.visitorId(viewer.ip),
          'daily_limit_retries',
        );
      }
      throw new ApiException(
        'QUOTA_EXCEEDED',
        "You've used all your lookups.",
        {
          scope: scope.kind,
          limit: scope.limit,
          resetsAt: scope.resetsAt.toISOString(),
        },
      );
    }

    let result: DomainCheckResult;
    try {
      result = await this.analyze(input, target, type, {
        dns: refresh,
        security: refresh,
      });
    } catch (error) {
      // Nothing came back, so the attempt is free.
      await this.usage.refund(scope);
      this.recordEvent(viewer.user, {
        status: 'failed',
        cacheHit: false,
        durationMs: Date.now() - started,
      });
      throw error;
    }

    await this.cache.set(resultKey, result, RESULT_TTL_SECONDS);
    this.recordEvent(viewer.user, {
      status: result.status,
      cacheHit: false,
      durationMs: result.durationMs,
      latency: latencyOf(result.providers),
    });

    const saved =
      user && !viewer.skipHistory
        ? await this.saveToHistory(result.id, () =>
            this.store.save(user.id, result),
          )
        : null;

    return {
      result: applyEntitlements(result, tier),
      quota: buildQuotaSnapshot(user, charge.used),
      savedToHistory: saved !== null,
    };
  }

  private async analyze(
    input: string,
    target: string,
    type: InputType,
    fresh: Freshness,
  ): Promise<DomainCheckResult> {
    const started = Date.now();
    const id = `chk_${createId()}`;
    const checkedAt = new Date().toISOString();

    let dnsResult: DomainCheckResult['dns'] = null;
    let reverseDns: DomainCheckResult['reverseDns'] = null;
    let addresses: ResolvedAddress[];
    let dnsOutcomes: Outcome<unknown>[];
    let dnsStatus: DnsLookup['status'] | null = null;

    if (type === 'domain') {
      const [main, advanced] = await Promise.all([
        this.runner.run({
          provider: 'dns',
          cacheKey: `lookup:dns:${target}`,
          ttlSeconds: DNS_TTL_SECONDS,
          timeoutMs: TIMEOUT_MS.dns,
          bypassCache: fresh.dns,
          work: (signal) => this.dns.resolveAddresses(target, signal),
        }),
        this.runner.run({
          provider: 'dns',
          cacheKey: `lookup:dns-advanced:${target}`,
          ttlSeconds: ADVANCED_DNS_TTL_SECONDS,
          timeoutMs: TIMEOUT_MS.dns,
          bypassCache: fresh.dns,
          work: (signal) => this.dns.resolveAdvanced(target, signal),
        }),
      ]);

      if (main.section.status !== 'ok') {
        throw main.section.status === 'timeout'
          ? new ApiException('DNS_TIMEOUT', 'DNS resolution timed out.')
          : new ApiException(
              'PROVIDER_UNAVAILABLE',
              main.section.message ??
                'DNS resolvers are temporarily unavailable.',
            );
      }

      const lookup = main.section.data;
      dnsStatus = lookup.status;
      dnsOutcomes = [main, advanced];
      addresses = lookup.addresses
        .filter((address) => isPublicIp(address.ip))
        .slice(0, MAX_ADDRESSES);
      dnsResult = {
        status: lookup.status,
        resolver: lookup.resolver,
        latencyMs: main.latencyMs,
        records: lookup.records,
        advanced: {
          access: 'included',
          data: advanced.section.status === 'ok' ? advanced.section.data : [],
        },
      };
    } else {
      addresses = [
        { ip: target, version: type === 'ipv4' ? 4 : 6, source: 'A' },
      ];
      const ptr = await this.runner.run({
        provider: 'dns',
        cacheKey: `lookup:ptr:${target}`,
        ttlSeconds: PTR_TTL_SECONDS,
        timeoutMs: TIMEOUT_MS.reverse,
        bypassCache: fresh.dns,
        work: (signal) => this.dns.reverse(target, signal),
      });
      dnsOutcomes = [ptr];
      reverseDns = {
        access: 'included',
        data: ptr.section.status === 'ok' ? ptr.section.data : [],
      };
    }

    const analyses = await Promise.all(
      addresses.map((address) =>
        this.analyzeIp(address, type === 'domain', fresh),
      ),
    );

    const geoOutcomes = analyses.map((analysis) => analysis.geo);
    const asnOutcomes = analyses.map((analysis) => analysis.asn);
    const securityOutcomes = analyses.map((analysis) => analysis.security);
    const intelligenceOutcomes = [
      ...geoOutcomes,
      ...asnOutcomes,
      ...securityOutcomes,
    ];

    // Every source failed for every address: there's nothing to show, so say so instead of an empty result.
    if (
      intelligenceOutcomes.length > 0 &&
      intelligenceOutcomes.every((outcome) => outcome.section.status !== 'ok')
    ) {
      throw new ApiException(
        'PROVIDER_UNAVAILABLE',
        'Intelligence providers are temporarily unavailable.',
      );
    }

    const providers: ProviderStatusMap = {
      dns: summarize(dnsOutcomes),
      geo: summarize(geoOutcomes),
      asn: summarize(asnOutcomes),
      security: summarize(securityOutcomes),
    };

    const firstNetwork = analyses[0]?.asn.section;
    const network = firstNetwork?.status === 'ok' ? firstNetwork.data : null;

    let status: CheckStatus;
    if (type === 'domain' && addresses.length === 0) {
      status = dnsStatus === 'servfail' ? 'partial' : 'no_records';
    } else {
      status = Object.values(providers).some(
        (provider) => provider.status !== 'ok',
      )
        ? 'partial'
        : 'completed';
    }

    return {
      id,
      input,
      target,
      type,
      status,
      checkedAt,
      durationMs: Date.now() - started,
      cache: { hit: false },
      dns: dnsResult,
      hosting: hostingOf(network),
      ips: analyses.map((analysis) => analysis.intelligence),
      providers,
      reverseDns,
    };
  }

  private async analyzeIp(
    address: ResolvedAddress,
    fromDomain: boolean,
    fresh: Freshness,
  ): Promise<IpAnalysis> {
    const { ip } = address;

    const [geo, asn] = await Promise.all([
      this.runner.run({
        provider: 'geo',
        timeoutMs: TIMEOUT_MS.geo,
        work: () => Promise.resolve(this.geo.locate(ip)),
      }),
      this.runner.run({
        provider: 'asn',
        timeoutMs: TIMEOUT_MS.asn,
        work: () => Promise.resolve(this.asn.lookup(ip)),
      }),
    ]);

    const network = asn.section.status === 'ok' ? asn.section.data : null;
    const security = await this.runner.run({
      provider: 'security',
      cacheKey: `lookup:security:${ip}`,
      ttlSeconds: SECURITY_TTL_SECONDS,
      timeoutMs: TIMEOUT_MS.security,
      bypassCache: fresh.security,
      work: (signal) => this.security.assess(ip, network, signal),
    });

    let geoSection: SectionResult<GeoLocation> = geo.section;
    if (geoSection.status === 'ok' && network?.anycast) {
      geoSection = {
        status: 'ok',
        data: {
          ...geoSection.data,
          accuracyRadiusKm: Math.max(
            geoSection.data.accuracyRadiusKm,
            ANYCAST_ACCURACY_KM,
          ),
        },
      };
    }

    return {
      intelligence: {
        ip,
        version: address.version,
        // Which record type produced the address only means something for a domain lookup.
        ...(fromDomain ? { source: address.source } : {}),
        geo: geoSection,
        network: asn.section,
        security: security.section,
      },
      geo,
      asn,
      security,
    };
  }
}
