import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import type {
  BillingCycle,
  ChangePlanRequest,
  ChangePlanResult,
  Invoice,
  InvoiceStatus,
  PendingPayment,
  Plan,
  PlanDefinition,
  PlanLimits,
  PlanQuote,
  QueuedPlan,
  Subscription,
  SubscriptionStatus,
} from '../../contracts';

export class ChangePlanDto implements ChangePlanRequest {
  @ApiProperty({
    enum: ['free', 'pro', 'business'],
    description:
      'Enterprise is arranged with sales and cannot be chosen here. `free` means "don\'t renew": there is nothing to buy, and a paid period simply runs out.',
  })
  @IsIn(['free', 'pro', 'business'])
  plan: Plan;

  @ApiProperty({ enum: ['monthly', 'annual'] })
  @IsIn(['monthly', 'annual'])
  billingCycle: BillingCycle;
}

/** The same two choices as query parameters, for `GET /subscription/quote`. */
export class QuoteQueryDto extends ChangePlanDto {}

class PlanLimitsDto implements PlanLimits {
  @ApiProperty({ nullable: true, type: Number }) lookups: number | null;
  @ApiProperty({ enum: ['month'] }) lookupPeriod: 'month';
  @ApiProperty({ nullable: true, type: Number }) apiRequests: number | null;
  @ApiProperty({ nullable: true, type: Number }) monitors: number | null;
  @ApiProperty({ nullable: true, type: Number }) bulkBatchSize: number | null;
  @ApiProperty({ nullable: true, type: Number }) teamSeats: number | null;
}

export class PlanDefinitionDto implements PlanDefinition {
  @ApiProperty({ enum: ['free', 'pro', 'business', 'enterprise'] })
  id: Plan;

  @ApiProperty() name: string;
  @ApiProperty() tagline: string;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'US dollars a month, paid monthly (30 days). Null means "talk to sales".',
  })
  priceMonthly: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Effective dollars a month when paying for a year (365 days) at once.',
  })
  priceAnnualMonthly: number | null;

  @ApiProperty({ required: false }) highlighted?: boolean;
  @ApiProperty({ required: false }) badge?: string;
  @ApiProperty() cta: string;
  @ApiProperty({ type: [String] }) features: string[];
  @ApiProperty({ type: PlanLimitsDto }) limits: PlanLimitsDto;
}

class QueuedPlanDto implements QueuedPlan {
  @ApiProperty({ enum: ['free', 'pro', 'business', 'enterprise'] }) plan: Plan;
  @ApiProperty({ enum: ['monthly', 'annual'] }) billingCycle: BillingCycle;
}

class PendingPaymentDto implements PendingPayment {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['free', 'pro', 'business', 'enterprise'] }) plan: Plan;
  @ApiProperty({ enum: ['monthly', 'annual'] }) billingCycle: BillingCycle;
  @ApiProperty({ description: 'What it charges, in US dollars.' })
  amount: number;
  @ApiProperty({ description: 'The payment gateway’s hosted checkout for it.' })
  checkoutUrl: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  expiresAt: string | null;
}

export class SubscriptionDto implements Subscription {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['free', 'pro', 'business', 'enterprise'] }) plan: Plan;
  @ApiProperty({
    enum: ['active', 'trialing', 'past_due', 'canceled'],
    description:
      'Always `active`: a plan is either paid for or the account is on Free.',
  })
  status: SubscriptionStatus;
  @ApiProperty({ enum: ['monthly', 'annual'] }) billingCycle: BillingCycle;
  @ApiProperty({ format: 'date-time' }) currentPeriodStart: string;
  @ApiProperty({
    format: 'date-time',
    description:
      'When the paid period ends — after that the account is on Free unless it was renewed. On Free, the end of the calendar month the free allowance counts in.',
  })
  currentPeriodEnd: string;
  @ApiProperty({
    description: 'The price of one period, in US dollars. 0 on Free.',
  })
  amount: number;
  @ApiProperty({ description: 'True in the last 7 days of a paid period.' })
  renewalDue: boolean;
  @ApiProperty({
    type: QueuedPlanDto,
    nullable: true,
    description: 'A plan already paid for that starts when this period ends.',
  })
  queued: QueuedPlanDto | null;
  @ApiProperty({
    type: PendingPaymentDto,
    nullable: true,
    description:
      'An invoice sent for payment and not yet paid; `checkoutUrl` resumes it.',
  })
  pendingPayment: PendingPaymentDto | null;
}

export class ChangePlanResultDto implements ChangePlanResult {
  @ApiProperty({ type: SubscriptionDto, nullable: true })
  subscription: SubscriptionDto | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The payment gateway’s checkout URL. Send the customer there; the plan changes when the payment is confirmed.',
  })
  checkoutUrl: string | null;
}

export class PlanQuoteDto implements PlanQuote {
  @ApiProperty({ enum: ['purchase', 'renewal', 'upgrade', 'queue', 'none'] })
  kind: PlanQuote['kind'];
  @ApiProperty({ description: 'What the invoice would charge, in US dollars.' })
  amount: number;
  @ApiProperty({
    description: 'What was taken off for the unused days of the current plan.',
  })
  credit: number;
  @ApiProperty({ description: 'The plan’s price for the cycle.' })
  listPrice: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) startsAt:
    string | null;
}

export class InvoiceDto implements Invoice {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'IPS-00042' }) number: string;
  @ApiProperty({ format: 'date-time' }) issuedAt: string;
  @ApiProperty() description: string;
  @ApiProperty({ description: 'US dollars.' }) amount: number;
  @ApiProperty({ enum: ['paid', 'open', 'failed', 'refunded'] })
  status: InvoiceStatus;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'For an open invoice, where to pay it. Otherwise null.',
  })
  hostedUrl: string | null;
}
