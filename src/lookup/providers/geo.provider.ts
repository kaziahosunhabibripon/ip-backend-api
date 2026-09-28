import { Injectable } from '@nestjs/common';
import tzlookup from 'tz-lookup';
import type { GeoLocation } from '../../contracts';
import { ipVersionOf } from '../normalizer/ip-address';
import { GeoIpDatabases } from './geoip-databases.service';
import { ProviderUnavailableError } from './provider.types';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

const countryName = (code: string) => {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};

const timezoneAt = (latitude: number, longitude: number) => {
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return 'UTC';
  }
};

@Injectable()
export class GeoProvider {
  constructor(private readonly databases: GeoIpDatabases) {}

  locate(ip: string): GeoLocation {
    const database =
      ipVersionOf(ip) === 6 ? this.databases.city6 : this.databases.city4;
    if (!database) {
      throw new ProviderUnavailableError(
        'The geolocation database is not available.',
      );
    }

    const record = database.get(ip);
    if (
      !record?.country_code ||
      record.latitude === undefined ||
      record.longitude === undefined
    ) {
      throw new ProviderUnavailableError(
        'No location data is available for this address.',
      );
    }

    const region = record.state1 || record.state2 || '';
    return {
      country: countryName(record.country_code),
      countryCode: record.country_code,
      region,
      city: record.city ?? '',
      postalCode: record.postcode || undefined,
      timezone:
        record.timezone || timezoneAt(record.latitude, record.longitude),
      latitude: record.latitude,
      longitude: record.longitude,
      // The free database reports no accuracy; these are honest ceilings by how specific the match is.
      accuracyRadiusKm: record.city ? 50 : region ? 200 : 500,
    };
  }
}
