import { ApiProperty } from '@nestjs/swagger';
import { QuotaDto } from '../../common/dto/user.dto';

/** What a Pro caller gets for a domain. A free or signed-out caller sees `{ "access": "locked", "requiredPlan": "pro" }` in place of every `advanced` block. */
const EXAMPLE_RESULT = {
  id: 'chk_h3k2p9x0q1w8',
  input: 'https://www.github.com/features',
  target: 'www.github.com',
  type: 'domain',
  status: 'partial',
  checkedAt: '2026-09-24T14:30:00.000Z',
  durationMs: 412,
  cache: { hit: false },
  dns: {
    status: 'resolved',
    resolver: '1.1.1.1',
    latencyMs: 38,
    records: [
      {
        id: 'cname_0',
        type: 'CNAME',
        name: 'www.github.com',
        value: 'github.com',
        ttl: 3600,
      },
      {
        id: 'a_1',
        type: 'A',
        name: 'github.com',
        value: '20.205.243.166',
        ttl: 38,
      },
    ],
    advanced: {
      access: 'included',
      data: [
        {
          id: 'mx_0',
          type: 'MX',
          name: 'github.com',
          value: 'github-com.mail.protection.outlook.com',
          ttl: 273,
          priority: 0,
        },
      ],
    },
  },
  hosting: { provider: 'Microsoft Corporation', kind: 'cloud' },
  ips: [
    {
      ip: '20.205.243.166',
      version: 4,
      source: 'A',
      geo: {
        status: 'ok',
        data: {
          country: 'Singapore',
          countryCode: 'SG',
          region: 'Singapore',
          city: 'Singapore',
          timezone: 'Asia/Singapore',
          latitude: 1.28967,
          longitude: 103.85,
          accuracyRadiusKm: 50,
        },
      },
      network: {
        status: 'ok',
        data: {
          asn: 8075,
          asnName: 'Microsoft Corporation',
          organization: 'Microsoft Corporation',
          isp: 'Microsoft Corporation',
          network: '20.205.0.0/16',
          connectionType: 'datacenter',
          anycast: false,
        },
      },
      security: {
        status: 'unavailable',
        message: 'Security intelligence is not configured on this server.',
      },
    },
  ],
  providers: {
    dns: { status: 'ok', latencyMs: 38 },
    geo: { status: 'ok', latencyMs: 0 },
    asn: { status: 'ok', latencyMs: 0 },
    security: {
      status: 'unavailable',
      latencyMs: 0,
      message: 'Security intelligence is not configured on this server.',
    },
  },
  reverseDns: null,
};

export class CheckResponseDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The `DomainCheckResult` from ipscope-web `types/lookup.ts`. Each section (`dns`, and per address `geo`, `network`, `security`) reports its own `status` — `ok`, `unavailable` or `timeout` — so one failing data source never blocks the rest.',
    example: EXAMPLE_RESULT,
  })
  result: Record<string, unknown>;

  @ApiProperty({ type: QuotaDto })
  quota: QuotaDto;

  @ApiProperty({
    description:
      'True when this check was written to the caller’s history (signed-in callers, and only for a fresh lookup — not a cache hit).',
  })
  savedToHistory: boolean;
}
