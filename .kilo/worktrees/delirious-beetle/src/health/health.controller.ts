import { Controller, Get, Res } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import type { Database } from '../db/database';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness',
    description:
      'For "is the process up" probes: 200 whenever the API answers, even when the database is down.',
  })
  @ApiOkResponse({
    description:
      'Always 200 once the process is up — `database` reports whether Postgres is reachable.',
    schema: {
      example: { status: 'ok', database: 'ok' },
    },
  })
  async check() {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok', database: 'ok' };
    } catch {
      return { status: 'ok', database: 'unavailable' };
    }
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness',
    description:
      'For load balancers: 200 only while Postgres answers, 503 otherwise, so traffic is routed away from an instance that cannot serve it.',
  })
  @ApiOkResponse({ schema: { example: { status: 'ok', database: 'ok' } } })
  @ApiServiceUnavailableResponse({
    schema: { example: { status: 'unavailable', database: 'unavailable' } },
  })
  async ready(@Res({ passthrough: true }) response: Response) {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok', database: 'ok' };
    } catch {
      response.status(503);
      return { status: 'unavailable', database: 'unavailable' };
    }
  }
}
