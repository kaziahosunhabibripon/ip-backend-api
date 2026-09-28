import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { TeamMailService } from './team-mail.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamsStore } from './teams-store.service';

/**
 * Global: `TeamsService.effectivePlan` is read from a handful of places that have nothing else to do with
 * teams (the auth guard, the monitoring and bulk-lookup background runners) — making this global means none
 * of those need to import a whole module just to ask "what plan does this account actually get right now?".
 */
@Global()
@Module({
  imports: [AuthModule, MailModule],
  controllers: [TeamsController],
  providers: [TeamsService, TeamsStore, TeamMailService],
  exports: [TeamsService],
})
export class TeamsModule {}
