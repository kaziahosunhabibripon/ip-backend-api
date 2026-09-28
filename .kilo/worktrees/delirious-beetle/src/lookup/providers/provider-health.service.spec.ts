import {
  HEALTH_WINDOW_MS,
  ProviderHealthService,
} from './provider-health.service';

const NOW = 1_800_000_000_000;

describe('ProviderHealthService', () => {
  it('has nothing to say about a provider nobody called', () => {
    expect(new ProviderHealthService().statsFor('dns', NOW)).toEqual({
      calls: 0,
      errors: 0,
      errorRate: 0,
      latencyMs: 0,
    });
  });

  it('counts calls, errors and the average time of the calls that answered', () => {
    const health = new ProviderHealthService();
    health.record('dns', true, 100, NOW - 3000);
    health.record('dns', true, 300, NOW - 2000);
    health.record('dns', false, 4000, NOW - 1000); // a timeout is an error, and not a "latency"

    expect(health.statsFor('dns', NOW)).toEqual({
      calls: 3,
      errors: 1,
      errorRate: 1 / 3,
      latencyMs: 200,
    });
  });

  it('keeps providers apart', () => {
    const health = new ProviderHealthService();
    health.record('dns', false, 10, NOW);
    health.record('geo', true, 5, NOW);

    expect(health.statsFor('dns', NOW).errors).toBe(1);
    expect(health.statsFor('geo', NOW).errors).toBe(0);
    expect(health.statsFor('asn', NOW).calls).toBe(0);
  });

  it('forgets what is older than the window', () => {
    const health = new ProviderHealthService();
    health.record('dns', false, 10, NOW - HEALTH_WINDOW_MS - 1);
    health.record('dns', true, 20, NOW - 1000);

    expect(health.statsFor('dns', NOW)).toMatchObject({ calls: 1, errors: 0 });
    // …and it has aged out for good: a later look does not bring it back.
    expect(health.statsFor('dns', NOW + 1)).toMatchObject({ calls: 1 });
  });

  it('is empty again once everything has aged out', () => {
    const health = new ProviderHealthService();
    health.record('dns', true, 20, NOW);

    expect(health.statsFor('dns', NOW + HEALTH_WINDOW_MS + 1).calls).toBe(0);
  });

  it('does not grow without bound under heavy traffic', () => {
    const health = new ProviderHealthService();
    for (let i = 0; i < 5000; i += 1) {
      health.record('dns', true, 1, NOW);
    }

    expect(health.statsFor('dns', NOW).calls).toBeLessThanOrEqual(2000);
    expect(health.statsFor('dns', NOW).calls).toBeGreaterThan(0);
  });
});
