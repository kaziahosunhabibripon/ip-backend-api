import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { open } from 'maxmind';

export interface CityRecord {
  city?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
  postcode?: string;
  state1?: string;
  state2?: string;
  timezone?: string;
}

/**
 * The slice of `maxmind`'s reader we use. Its own types only describe MaxMind's record layout,
 * while these community databases use different field names, so we describe the records ourselves.
 */
export interface RecordReader<T> {
  get(ip: string): T | null;
  getWithPrefixLength(ip: string): [T | null, number];
}

export interface AsnRecord {
  autonomous_system_number?: number;
  autonomous_system_organization?: string;
}

/**
 * The offline IP databases, loaded once at startup:
 *  - DB-IP Lite city data (CC-BY-4.0 — pages that show results need a link to https://db-ip.com)
 *  - IP-to-ASN data (RouteViews / DB-IP, refreshed by upgrading the npm packages)
 * Lookups are in-memory and take microseconds, so they need no cache and cost nothing per request.
 */
@Injectable()
export class GeoIpDatabases implements OnModuleInit {
  private readonly logger = new Logger(GeoIpDatabases.name);

  city4: RecordReader<CityRecord> | null = null;
  city6: RecordReader<CityRecord> | null = null;
  asn: RecordReader<AsnRecord> | null = null;

  async onModuleInit() {
    const started = Date.now();
    [this.city4, this.city6, this.asn] = await Promise.all([
      this.load<CityRecord>(
        '@ip-location-db/dbip-city-mmdb/dbip-city-ipv4.mmdb',
      ),
      this.load<CityRecord>(
        '@ip-location-db/dbip-city-mmdb/dbip-city-ipv6.mmdb',
      ),
      this.load<AsnRecord>('@ip-location-db/asn-mmdb/asn.mmdb'),
    ]);

    const loaded = [this.city4, this.city6, this.asn].filter(Boolean).length;
    this.logger.log(
      `Loaded ${loaded}/3 IP databases in ${Date.now() - started} ms.`,
    );
  }

  private async load<T>(specifier: string): Promise<RecordReader<T> | null> {
    try {
      const reader = await open(require.resolve(specifier));
      return reader as unknown as RecordReader<T>;
    } catch (error) {
      this.logger.error(
        `Could not load ${specifier} — that section will report "unavailable": ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
