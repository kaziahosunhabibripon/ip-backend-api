import { Module } from '@nestjs/common';
import { AbuseModule } from '../abuse/abuse.module';
import { UsageModule } from '../usage/usage.module';
import { CheckStore } from './check-store.service';
import { LookupController } from './lookup.controller';
import { LookupService } from './lookup.service';
import { AsnProvider } from './providers/asn.provider';
import { DnsProvider } from './providers/dns.provider';
import { GeoProvider } from './providers/geo.provider';
import { GeoIpDatabases } from './providers/geoip-databases.service';
import { ProviderHealthService } from './providers/provider-health.service';
import { ProviderRunner } from './providers/provider-runner';
import { SecurityProvider } from './providers/security.provider';
import { TorExitListService } from './providers/tor-exit-list.service';

@Module({
  imports: [UsageModule, AbuseModule],
  controllers: [LookupController],
  providers: [
    LookupService,
    CheckStore,
    ProviderHealthService,
    ProviderRunner,
    DnsProvider,
    GeoIpDatabases,
    GeoProvider,
    AsnProvider,
    TorExitListService,
    SecurityProvider,
  ],
  // Monitoring runs the same analysis on a schedule; the admin view reads how the providers are doing.
  // GeoProvider is also reused for the Sessions list's location — exporting it keeps the mmdb a single
  // in-memory instance instead of a second copy in whichever module wants a location.
  exports: [LookupService, ProviderHealthService, GeoProvider],
})
export class LookupModule {}
