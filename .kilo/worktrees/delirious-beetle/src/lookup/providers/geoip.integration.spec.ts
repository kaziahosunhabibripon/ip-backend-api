import { AsnProvider } from './asn.provider';
import { GeoProvider } from './geo.provider';
import { GeoIpDatabases } from './geoip-databases.service';
import { classifyNetwork } from './network-classifier';
import { ProviderUnavailableError } from './provider.types';

// Loads the real databases from node_modules, so these also prove the packages and file paths are right.
describe('geo + ASN providers on the real databases', () => {
  const databases = new GeoIpDatabases();
  const geo = new GeoProvider(databases);
  const asn = new AsnProvider(databases);

  beforeAll(async () => {
    await databases.onModuleInit();
  }, 60_000);

  it('locates an IPv4 address, filling the timezone the database leaves empty', () => {
    const location = geo.locate('8.8.8.8');

    expect(location).toMatchObject({
      country: 'United States',
      countryCode: 'US',
      city: 'Mountain View',
      region: 'California',
      timezone: 'America/Los_Angeles',
    });
    expect(location.latitude).toBeCloseTo(37.4, 0);
    expect(location.accuracyRadiusKm).toBe(50);
  });

  it('locates an IPv6 address', () => {
    expect(geo.locate('2606:4700:4700::1111')).toMatchObject({
      countryCode: 'CA',
      timezone: expect.stringMatching(/^America\//) as unknown,
    });
  });

  it('names the network, its CIDR block and its type', () => {
    expect(asn.lookup('8.8.8.8')).toMatchObject({
      asn: 15169,
      organization: 'Google LLC',
      network: '8.8.8.0/24',
      connectionType: 'datacenter',
      anycast: false,
    });
    expect(asn.lookup('1.1.1.1')).toMatchObject({
      asn: 13335,
      organization: 'Cloudflare, Inc.',
      network: '1.1.1.0/24',
      connectionType: 'cdn',
      anycast: true,
    });
    expect(asn.lookup('2606:4700:4700::1111')).toMatchObject({
      asn: 13335,
      network: '2606:4700:4700::/48',
    });
  });

  it('reports "unavailable" for addresses the databases have nothing on', () => {
    expect(() => geo.locate('10.0.0.1')).toThrow(ProviderUnavailableError);
    expect(() => asn.lookup('10.0.0.1')).toThrow(ProviderUnavailableError);
  });

  it('reports "unavailable" instead of crashing when a database failed to load', () => {
    const empty = new GeoIpDatabases();
    expect(() => new GeoProvider(empty).locate('8.8.8.8')).toThrow(
      /not available/,
    );
    expect(() => new AsnProvider(empty).lookup('8.8.8.8')).toThrow(
      /not available/,
    );
  });
});

describe('classifyNetwork', () => {
  it.each([
    [13335, 'Cloudflare, Inc.', 'cdn', true],
    [54113, 'Fastly, Inc.', 'cdn', true],
    [20940, 'Akamai International B.V.', 'cdn', false],
    [16509, 'Amazon.com, Inc.', 'datacenter', false],
    [64500, 'Acme Web Hosting Ltd', 'datacenter', false],
    [64501, 'State University Network', 'education', false],
    [64502, 'Ministry of Finance', 'government', false],
    [64503, 'Example Mobile Networks', 'mobile', false],
    [64504, 'Some Broadband Provider', 'unknown', false],
  ] as const)(
    'AS%i %s -> %s (anycast: %s)',
    (asnNumber, organization, connectionType, anycast) => {
      expect(classifyNetwork(asnNumber, organization)).toEqual({
        connectionType,
        anycast,
      });
    },
  );
});
