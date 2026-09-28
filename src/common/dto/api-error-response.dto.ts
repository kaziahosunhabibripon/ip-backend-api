import { ApiProperty } from '@nestjs/swagger';
import type { ApiErrorCode } from './api-exception';

class ApiErrorDto {
  @ApiProperty({
    description:
      'Machine-readable code — see NESTJS_BACKEND_PLAN.md §4.1 for the full table and matching HTTP status.',
    example: 'INVALID_INPUT',
  })
  code: ApiErrorCode;

  @ApiProperty({ example: 'The request failed validation.' })
  message: string;

  @ApiProperty({
    required: false,
    description:
      'Machine-readable extras, e.g. a per-field validation message or `retryAfterSeconds`.',
    example: { email: 'must be a valid email address' },
  })
  details?: Record<string, string | number | boolean>;
}

/** Documents the `{ error: { code, message, details? } }` shape every failed request returns — attach with `@ApiResponse({ status, type: ApiErrorResponseDto })`. */
export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorDto })
  error: ApiErrorDto;
}
