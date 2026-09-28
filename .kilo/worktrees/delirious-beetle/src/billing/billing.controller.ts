import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type {
  ChangePlanResult,
  Invoice,
  PlanDefinition,
  PlanQuote,
  Subscription,
  User,
} from '../contracts';
import { BillingService } from './billing.service';
import {
  ChangePlanDto,
  ChangePlanResultDto,
  InvoiceDto,
  PlanDefinitionDto,
  PlanQuoteDto,
  QuoteQueryDto,
  SubscriptionDto,
} from './dto/billing.dto';

/**
 * Billing is a signed-in, cookie-authenticated job: an API key can never change a plan or read invoices. Card
 * details never reach this server — the payment gateway's own checkout page collects the payment.
 *
 * Plans are paid a period at a time and never renew by themselves; see `Subscription` for how that shows up.
 */
@ApiTags('billing')
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('plans')
  @ApiOperation({
    summary: 'The plan catalogue',
    description:
      'Prices, features and limits of every plan. Public, so the pricing page can use it signed out.',
  })
  @ApiOkResponse({ type: [PlanDefinitionDto] })
  plans(): PlanDefinition[] {
    return this.billing.plans();
  }

  @Get('subscription')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The caller’s plan and billing state',
    description:
      'Free accounts get a free-plan answer. For a paid plan: cycle, when the paid period ends, whether it is time to renew, a plan already paid for after it, and any invoice still waiting to be paid.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  @ApiErrorResponses(401)
  subscription(@RequiredUser() user: User): Promise<Subscription> {
    return this.billing.subscription(user);
  }

  @Get('subscription/quote')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'What choosing a plan would cost',
    description:
      'Worked out from the caller’s current paid period, without opening an invoice: a first purchase or a renewal is the full price; an upgrade is the new price less a credit for the unused days of the current plan; a smaller plan is bought now and starts when the current period ends (no refund). Works even when billing is off.',
  })
  @ApiOkResponse({ type: PlanQuoteDto })
  @ApiErrorResponses(401, 422)
  quote(
    @RequiredUser() user: User,
    @Query() query: QuoteQueryDto,
  ): Promise<PlanQuote> {
    return this.billing.quote(user, query);
  }

  @Post('subscription')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Buy, renew or change a plan',
    description: [
      'Opens an invoice at the payment gateway for what `GET /subscription/quote` says, and answers with its checkout URL (`checkoutUrl`): send the customer there. The plan changes when the payment is confirmed — the gateway’s webhook, the background poller, or `POST /subscription/refresh` when they come back.',
      '',
      'Asking again for the same thing while its invoice is still open returns the same checkout URL. At most three invoices may be open at once (`409`).',
      '',
      '`free` opens nothing (`checkoutUrl` is null): a paid period just runs out. A smaller plan is `409` while another one is already paid for after the current period. `503` when billing is not configured or the gateway can’t be reached.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: ChangePlanResultDto })
  @ApiErrorResponses(401, 409, 422, 429, 503)
  changePlan(
    @RequiredUser() user: User,
    @Body() dto: ChangePlanDto,
  ): Promise<ChangePlanResult> {
    return this.billing.changePlan(user, dto);
  }

  @Post('subscription/refresh')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Check the gateway for the caller’s open invoices now',
    description:
      'The background poller and the gateway’s webhook are the normal ways a payment is noticed. The billing page calls this when a customer comes back from paying, so they don’t wait for the next round. Safe to call any time.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  @ApiErrorResponses(401, 429)
  refresh(@RequiredUser() user: User): Promise<Subscription> {
    return this.billing.refresh(user);
  }

  @Get('subscription/invoices')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Invoices, newest first',
    description:
      'Every invoice opened for the caller — paid, waiting, expired or refunded.',
  })
  @ApiOkResponse({ type: [InvoiceDto] })
  @ApiErrorResponses(401)
  invoices(@RequiredUser() user: User): Promise<Invoice[]> {
    return this.billing.invoices(user);
  }
}
