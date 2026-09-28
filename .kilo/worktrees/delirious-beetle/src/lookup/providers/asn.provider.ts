import { Injectable } from '@nestjs/common';
import type { NetworkInfo } from '../../contracts';
import { networkOf } from '../normalizer/ip-address';
import { GeoIpDatabases } from './geoip-databases.service';
import { classifyNetwork } from './network-classifier';
import { ProviderUnavailableError } from './provider.types';

@Injectable()
export class AsnProvider {
  constructor(private readonly databases: GeoIpDatabases) {}

  lookup(ip: string): NetworkInfo {
    const database = this.databases.asn;
    if (!database) {
      throw new ProviderUnavailableError(
        'The network-ownership database is not available.',
      );
    }

    const [record, prefixLength] = database.getWithPrefixLength(ip);
    if (
      !record?.autonomous_system_number ||
      !record.autonomous_system_organization
    ) {
      throw new ProviderUnavailableError(
        'No network data is available for this address.',
      );
    }

    const asn = record.autonomous_system_number;
    // The database knows the AS holder, not a separate "ISP", so the same name fills all three.
    const organization = record.autonomous_system_organization;
    return {
      asn,
      asnName: organization,
      organization,
      isp: organization,
      network: networkOf(ip, prefixLength) ?? '',
      ...classifyNetwork(asn, organization),
    };
  }
}
