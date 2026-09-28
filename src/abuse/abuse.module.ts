import { Module } from '@nestjs/common';
import { AbuseService } from './abuse.service';
import { AbuseStore } from './abuse-store.service';

@Module({
  providers: [AbuseStore, AbuseService],
  exports: [AbuseService, AbuseStore],
})
export class AbuseModule {}
