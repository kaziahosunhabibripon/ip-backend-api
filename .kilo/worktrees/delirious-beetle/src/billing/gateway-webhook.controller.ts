import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { Public } from '../common/decorators/public.decorator';
import { BillingService } from './billing.service';

/**
 * Where the payment gateway reports that an invoice changed. It has no session: the HMAC signature on the raw body
 * (`X-Gateway-Signature`, keyed with `PAYMENT_GATEWAY_WEBHOOK_SECRET`) is the only credential, so this reads the
 * body exactly as it arrived (`rawBody: true` in `main.ts`). It is optional — the poller finds every payment anyway.
 */
@ApiTags('billing')
@Controller('webhooks')
export class GatewayWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Post('gateway')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Payment gateway webhook receiver',
    description:
      'Called by the gateway, not by the web app. Verifies `X-Gateway-Signature` (hex HMAC-SHA256 of the raw body) and then asks the gateway what the named invoice looks like now, acting on that — so a replayed or reordered message changes nothing. `503` when no webhook secret is configured.',
  })
  @ApiOkResponse({ schema: { example: { received: true } } })
  @ApiErrorResponses(422, 503)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-gateway-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    await this.billing.handleWebhook(request.rawBody, signature);
    return { received: true };
  }
}
