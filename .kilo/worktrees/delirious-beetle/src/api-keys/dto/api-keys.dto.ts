import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';
import type {
  ApiKey,
  ApiKeyStatus,
  CreateApiKeyRequest,
  CreatedApiKey,
} from '../../contracts';
import type { ApiKeyEnvironment } from '../api-key-secret';
import { MAX_NAME_LENGTH } from '../api-keys.service';

const ENVIRONMENTS: ApiKeyEnvironment[] = ['production', 'development'];

export class CreateApiKeyDto implements CreateApiKeyRequest {
  @ApiProperty({
    example: 'CI pipeline',
    maxLength: MAX_NAME_LENGTH,
    description: 'A label to recognise the key by. Not secret.',
  })
  @MaxLength(MAX_NAME_LENGTH)
  @IsString()
  name: string;

  @ApiProperty({
    enum: ENVIRONMENTS,
    description:
      '`production` keys start with `ips_live_` and follow the plan’s rate limit; `development` keys start with `ips_test_` and are limited to 100 requests a minute. Both count towards the monthly request quota.',
  })
  @IsIn(ENVIRONMENTS)
  environment: ApiKeyEnvironment;
}

export class ApiKeyDto implements ApiKey {
  @ApiProperty() id: string;

  @ApiProperty({ example: 'CI pipeline' })
  name: string;

  @ApiProperty({ enum: ENVIRONMENTS })
  environment: ApiKeyEnvironment;

  @ApiProperty({
    example: 'ips_live_a1b2',
    description: 'The non-secret start of the key, to recognise it by.',
  })
  prefix: string;

  @ApiProperty({ enum: ['active', 'revoked'] })
  status: ApiKeyStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Accurate to about a minute.',
  })
  lastUsedAt: string | null;

  @ApiProperty({
    example: 1000,
    description:
      'Requests per minute this key may make. Follows the owner’s plan and the key’s environment.',
  })
  rateLimit: number;
}

export class CreatedApiKeyDto implements CreatedApiKey {
  @ApiProperty({ type: ApiKeyDto })
  key: ApiKeyDto;

  @ApiProperty({
    example: 'ips_live_x7Yk…',
    description:
      'The full key. Returned this once and never again — only its hash is stored.',
  })
  secret: string;
}
