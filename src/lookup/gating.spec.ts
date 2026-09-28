import type { DomainCheckResult, Tier } from '../contracts';
import { applyEntitlements } from './gating';

const SECRET_MX = 'secret-mx.example';
const SECRET_PTR = 'secret-ptr.example';
const SECRET_SCORE = 987654;

/** A complete result as gathered — every premium field present and included. */
const raw = (type: 'domain' | 'ipv4'): DomainCheckResult => ({
  id: 'chk_1',
  input: 'x',
  target: 'x',
  type,
  status: 'completed',
  checkedAt: '2026-09-24T00:00:00.000Z',
  durationMs: 1,
  cache: { hit: false },
  dns:
    type === 'domain'
      ? {
          status: 'resolved',
          resolver: '1.1.1.1',
          latencyMs: 1,
          records: [
            { id: 'a_0', type: 'A', name: 'x', value: '1.2.3.4', ttl: 60 },
          ],
          advanced: {
            access: 'included',
            data: [
              {
                id: 'mx_0',
                type: 'MX',
                name: 'x',
                value: SECRET_MX,
                ttl: 60,
                priority: 10,
              },
            ],
          },
        }
      : null,
  ips: [
    {
      ip: '1.2.3.4',
      version: 4,
      geo: { status: 'unavailable' },
      network: { status: 'unavailable' },
      security: {
        status: 'ok',
        data: {
          basic: {
            vpn: { state: 'clear', summary: '' },
            proxy: { state: 'clear', summary: '' },
            tor: { state: 'clear', summary: '' },
            datacenter: { state: 'clear', summary: '' },
          },
          advanced: {
            access: 'included',
            data: {
              vpn: { confidence: 0 },
              proxy: { confidence: 0 },
              tor: {},
              residentialProxy: { state: 'clear', summary: '', confidence: 0 },
              reputation: { score: SECRET_SCORE, level: 'low', categories: [] },
              blacklists: { checked: 0, listed: 0, entries: [] },
            },
          },
        },
      },
    },
    {
      ip: '5.6.7.8',
      version: 4,
      geo: { status: 'unavailable' },
      network: { status: 'unavailable' },
      security: { status: 'unavailable', message: 'down' },
    },
  ],
  providers: {
    dns: { status: 'ok' },
    geo: { status: 'ok' },
    asn: { status: 'ok' },
    security: { status: 'ok' },
  },
  reverseDns:
    type === 'ipv4' ? { access: 'included', data: [SECRET_PTR] } : null,
});

describe('applyEntitlements', () => {
  it.each<Tier>(['anonymous', 'free'])(
    'locks every premium field for %s and leaves none of its values in the payload',
    (tier) => {
      const domain = applyEntitlements(raw('domain'), tier);
      const ip = applyEntitlements(raw('ipv4'), tier);

      expect(domain.dns?.advanced).toEqual({
        access: 'locked',
        requiredPlan: 'pro',
      });
      expect(ip.reverseDns).toEqual({ access: 'locked', requiredPlan: 'pro' });
      const security = domain.ips[0].security;
      expect(security.status === 'ok' && security.data.advanced).toEqual({
        access: 'locked',
        requiredPlan: 'pro',
      });

      // The point of gating: the premium values must not appear anywhere in what's sent.
      const wire = JSON.stringify([domain, ip]);
      for (const secret of [SECRET_MX, SECRET_PTR, String(SECRET_SCORE)]) {
        expect(wire).not.toContain(secret);
      }
    },
  );

  it.each<Tier>(['pro', 'business', 'enterprise'])(
    'leaves everything included for %s',
    (tier) => {
      const domain = applyEntitlements(raw('domain'), tier);
      expect(domain.dns?.advanced.access).toBe('included');
      expect(JSON.stringify(domain)).toContain(SECRET_MX);
      expect(JSON.stringify(applyEntitlements(raw('ipv4'), tier))).toContain(
        SECRET_PTR,
      );
    },
  );

  it('keeps the basic (free) data for everyone', () => {
    const result = applyEntitlements(raw('domain'), 'anonymous');
    expect(result.dns?.records).toHaveLength(1);
    const security = result.ips[0].security;
    expect(security.status === 'ok' && security.data.basic.tor.state).toBe(
      'clear',
    );
  });

  it('passes a failed security section through untouched', () => {
    const result = applyEntitlements(raw('domain'), 'free');
    expect(result.ips[1].security).toEqual({
      status: 'unavailable',
      message: 'down',
    });
  });

  it('does not mutate its input, and is safe to apply twice', () => {
    const original = raw('domain');
    const once = applyEntitlements(original, 'free');
    expect(original.dns?.advanced.access).toBe('included');
    expect(applyEntitlements(once, 'free')).toEqual(once);
  });

  it('never upgrades a field that was already locked when stored', () => {
    const stored = applyEntitlements(raw('domain'), 'free'); // captured while on Free
    expect(applyEntitlements(stored, 'pro').dns?.advanced).toEqual({
      access: 'locked',
      requiredPlan: 'pro',
    });
  });

  it('downgrades a stored Pro result when the owner is no longer on Pro', () => {
    const stored = raw('domain'); // captured while on Pro
    expect(applyEntitlements(stored, 'free').dns?.advanced.access).toBe(
      'locked',
    );
  });
});
