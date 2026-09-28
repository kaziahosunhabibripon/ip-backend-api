import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiException } from '../common/dto/api-exception';

/** What the gateway calls an invoice's state. */
export type GatewayStatus =
  'pending' | 'paid' | 'expired' | 'failed' | 'cancelled' | 'refunded';

export interface GatewayInvoice {
  invoiceNo: string;
  amountCents: number;
  status: GatewayStatus;
  checkoutUrl: string | null;
  expiresAt: Date | null;
}

const KNOWN_STATUSES: readonly GatewayStatus[] = [
  'pending',
  'paid',
  'expired',
  'failed',
  'cancelled',
  'refunded',
];

const REQUEST_TIMEOUT_MS = 15_000;

const UNAVAILABLE = () =>
  new ApiException(
    'PROVIDER_UNAVAILABLE',
    "Payments aren't available right now. Please try again shortly.",
  );

/** Anything but the gateway's own words is treated as still waiting: an unknown state must never grant a plan. */
const toStatus = (value: unknown): GatewayStatus =>
  KNOWN_STATUSES.includes(value as GatewayStatus)
    ? (value as GatewayStatus)
    : 'pending';

/**
 * The payment gateway (`payment-gateway-api`): a shared service that turns "charge $19" into a hosted checkout page
 * (card, Lightning or crypto — whatever its administrator set up for our payment link) and tells us when it was paid.
 * It speaks GraphQL over HTTPS with a merchant API key (HTTP Basic), takes one-off invoices only (no subscriptions,
 * no saved cards) and reports status either when asked (`getInvoice`) or by a signed webhook.
 *
 * Billing ships dark: it is on only when the URL, our payment link's slug and the API key are all set. The webhook
 * secret is optional — without it we simply rely on asking, which is always enough.
 */
@Injectable()
export class GatewayClient {
  private readonly logger = new Logger(GatewayClient.name);
  private readonly url: string;
  private readonly slug: string;
  private readonly authorization: string;
  readonly enabled: boolean;
  readonly webhookSecret: string;
  /** Where the customer is sent back to. Comes from configuration, never from a request. */
  readonly webUrl: string;

  constructor(config: ConfigService) {
    const read = (key: string) => config.get<string>(key)?.trim() ?? '';
    this.url = read('PAYMENT_GATEWAY_URL');
    this.slug = read('PAYMENT_GATEWAY_SLUG');
    const keyId = read('PAYMENT_GATEWAY_API_KEY_ID');
    const keySecret = read('PAYMENT_GATEWAY_API_KEY_SECRET');
    this.webhookSecret = read('PAYMENT_GATEWAY_WEBHOOK_SECRET');
    this.webUrl = (read('APP_WEB_URL') || 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

    const provided = [this.url, this.slug, keyId, keySecret].filter(Boolean);
    if (provided.length === 0) {
      this.enabled = false;
      this.logger.warn(
        'Billing is off: PAYMENT_GATEWAY_URL, PAYMENT_GATEWAY_SLUG and the PAYMENT_GATEWAY_API_KEY_* pair are not set.',
      );
      return;
    }
    if (provided.length < 4) {
      this.enabled = false;
      this.logger.error(
        'Billing is off: PAYMENT_GATEWAY_URL, PAYMENT_GATEWAY_SLUG, PAYMENT_GATEWAY_API_KEY_ID and PAYMENT_GATEWAY_API_KEY_SECRET must all be set.',
      );
      return;
    }
    // The API key travels in every request: never over plain HTTP, except to a gateway on this machine.
    if (
      !/^https:\/\//i.test(this.url) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(this.url)
    ) {
      throw new Error(
        'PAYMENT_GATEWAY_URL must be an https:// address (http:// is only accepted for localhost).',
      );
    }

    this.enabled = true;
    this.logger.log(
      `Billing is on through the payment gateway at ${new URL(this.url).host}${this.webhookSecret ? '' : ' (no webhook secret: settlement is found by asking the gateway)'}.`,
    );
  }

  /** Throws a clear 503 when billing is off. */
  require(): void {
    if (!this.enabled) {
      throw new ApiException(
        'PROVIDER_UNAVAILABLE',
        "Billing isn't available right now.",
      );
    }
  }

  /** Opens an invoice for `amountCents` and returns where the customer pays it. */
  async createInvoice(
    amountCents: number,
    returnUrl: string,
  ): Promise<GatewayInvoice> {
    const data = await this.graphql<{ createInvoice: RawInvoice }>(
      `mutation($input: CreateInvoiceInput!) {
        createInvoice(input: $input) { invoiceNo amountUsd status checkoutUrl expiresAt }
      }`,
      { input: { slug: this.slug, amountUsd: amountCents / 100, returnUrl } },
    );
    return this.parse(data.createInvoice);
  }

  async getInvoice(invoiceNo: string): Promise<GatewayInvoice> {
    const data = await this.graphql<{ invoice: RawInvoice | null }>(
      `query($n: String!) { invoice(invoiceNo: $n) { invoiceNo amountUsd status } }`,
      { n: invoiceNo },
    );
    if (!data.invoice) {
      throw UNAVAILABLE();
    }
    return this.parse(data.invoice);
  }

  /**
   * The invoice number a signed webhook is about — or null when it is unsigned, forged, for another payment link, or
   * this gateway has no webhook secret here. The body is only a nudge: what is acted on is what `getInvoice` says
   * afterwards, so a replayed or out-of-order delivery can't change anything.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature: string | undefined,
  ): string | null {
    if (!this.webhookSecret || !rawBody || !signature) {
      return null;
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest();
    const provided = Buffer.from(signature.trim(), 'hex');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return null;
    }

    try {
      const body = JSON.parse(rawBody.toString('utf8')) as {
        invoiceNo?: unknown;
        slug?: unknown;
      };
      if (body.slug !== undefined && body.slug !== this.slug) {
        return null;
      }
      const invoiceNo = body.invoiceNo;
      return typeof invoiceNo === 'string' || typeof invoiceNo === 'number'
        ? String(invoiceNo)
        : null;
    } catch {
      return null;
    }
  }

  private parse(raw: RawInvoice): GatewayInvoice {
    const dollars = Number(raw.amountUsd);
    if (
      !Number.isFinite(dollars) ||
      raw.invoiceNo === undefined ||
      raw.invoiceNo === null
    ) {
      this.logger.error(
        'The payment gateway answered with an invoice we could not read.',
      );
      throw UNAVAILABLE();
    }
    return {
      invoiceNo: String(raw.invoiceNo),
      amountCents: Math.round(dollars * 100),
      status: toStatus(raw.status),
      checkoutUrl: raw.checkoutUrl ?? null,
      expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : null,
    };
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    this.require();
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authorization,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `The payment gateway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw UNAVAILABLE();
    }

    if (!response.ok) {
      this.logger.error(
        `The payment gateway answered HTTP ${response.status}.`,
      );
      throw UNAVAILABLE();
    }

    let body: {
      data?: T;
      errors?: { message?: string; extensions?: { code?: string } }[];
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      this.logger.error(
        'The payment gateway answered with something that is not JSON.',
      );
      throw UNAVAILABLE();
    }
    if (body.errors?.length) {
      // The code says what kind of refusal it was; the message may echo our input, so it stays out of the log.
      this.logger.error(
        `The payment gateway refused a request: ${body.errors[0].extensions?.code ?? 'UNKNOWN'}.`,
      );
      throw UNAVAILABLE();
    }
    if (!body.data) {
      throw UNAVAILABLE();
    }
    return body.data;
  }
}

interface RawInvoice {
  invoiceNo?: string | number | null;
  amountUsd?: string | number | null;
  status?: string | null;
  checkoutUrl?: string | null;
  expiresAt?: string | null;
}
