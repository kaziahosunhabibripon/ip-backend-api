import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../dto/api-error-response.dto';

const DESCRIPTIONS: Record<number, string> = {
  401: 'AUTH_REQUIRED or INVALID_CREDENTIALS',
  403: 'FORBIDDEN or PLAN_REQUIRED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'INVALID_INPUT',
  429: 'RATE_LIMITED',
};

/** Documents the shared `{ error: { code, message, details? } }` body for each listed failure status. */
export const ApiErrorResponses = (...statuses: number[]) =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? 'Error',
        type: ApiErrorResponseDto,
      }),
    ),
  );
