import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { GatewayClient } from './gateway.client';

beforeAll(() => Logger.overrideLogger(false));

const FULL = {
  PAYMENT_GATEWAY_URL: 'https://gateway.example.com/graphql',
  PAYMENT_GATEWAY_SLUG: 'ipscope',
  PAYMENT_GATEWAY_API_KEY_ID: 'key_id_1',
  PAYMENT_GATEWAY_API_KEY_SECRET: 'key_secret_1',
  PAYMENT_GATEWAY_WEBHOOK_SECRET: 'whsec_test',
  APP_WEB_URL: 'https://app.example.com/',
};

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const client = (overrides: Record<string, string | undefined> = {}) =>
  new GatewayClient(config({ ...FULL, ...overrides }));

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
});
afterEach(() => fetchMock.mockRestore());

const reply = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected a rejection');
};

describe('GatewayClient — configuration', () => {
  it('is off when nothing is configured, and says so with a 503', () => {
    const off = client({
      PAYMENT_GATEWAY_URL: undefined,
      PAYMENT_GATEWAY_SLUG: undefined,
      PAYMENT_GATEWAY_API_KEY_ID: undefined,
      PAYMENT_GATEWAY_API_KEY_SECRET: undefined,
    });

    expect(off.enabled).toBe(false);
    expect(() => off.require()).toThrow("Billing isn't available right now.");
  });

  it.each([
    'PAYMENT_GATEWAY_URL',
    'PAYMENT_GATEWAY_SLUG',
    'PAYMENT_GATEWAY_API_KEY_ID',
    'PAYMENT_GATEWAY_API_KEY_SECRET',
  ])(
    'stays off when only %s is missing — half a configuration is not a working one',
    (missing) => {
      expect(client({ [missing]: undefined }).enabled).toBe(false);
    },
  );

  it('is on with everything, whether or not there is a webhook secret', () => {
    expect(client().enabled).toBe(true);
    expect(client({ PAYMENT_GATEWAY_WEBHOOK_SECRET: undefined }).enabled).toBe(
      true,
    );
  });

  it('refuses to send an API key over plain HTTP', () => {
    expect(() =>
      client({ PAYMENT_GATEWAY_URL: 'http://gateway.example.com/graphql' }),
    ).toThrow('https://');
  });

  it('accepts plain HTTP for a gateway on this machine', () => {
    expect(
      client({ PAYMENT_GATEWAY_URL: 'http://localhost:4100/graphql' }).enabled,
    ).toBe(true);
    expect(
      client({ PAYMENT_GATEWAY_URL: 'http://127.0.0.1:4100/graphql' }).enabled,
    ).toBe(true);
  });

  it('sends people back to the configured web address, without a trailing slash', () => {
    expect(client().webUrl).toBe('https://app.example.com');
    expect(client({ APP_WEB_URL: undefined }).webUrl).toBe(
      'http://localhost:3000',
    );
  });
});

describe('GatewayClient.createInvoice', () => {
  const created = {
    data: {
      createInvoice: {
        invoiceNo: 1042,
        amountUsd: '19.00',
        status: 'pending',
        checkoutUrl: 'https://pay.example.com/i/1042',
        expiresAt: '2026-09-27T12:00:00.000Z',
      },
    },
  };

  it('opens an invoice for the amount, on our payment link, and reads the answer', async () => {
    reply(created);

    const invoice = await client().createInvoice(
      1900,
      'https://app.example.com/billing?checkout=success',
    );

    expect(invoice).toEqual({
      invoiceNo: '1042',
      amountCents: 1900,
      status: 'pending',
      checkoutUrl: 'https://pay.example.com/i/1042',
      expiresAt: new Date('2026-09-27T12:00:00.000Z'),
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/graphql');
    const sent = JSON.parse(init.body as string) as {
      variables: { input: unknown };
    };
    expect(sent.variables.input).toEqual({
      slug: 'ipscope',
      amountUsd: 19,
      returnUrl: 'https://app.example.com/billing?checkout=success',
    });
  });

  it('authenticates as the merchant with HTTP Basic', async () => {
    reply(created);

    await client().createInvoice(1900, 'https://app.example.com/billing');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('key_id_1:key_secret_1').toString('base64')}`,
    );
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('turns dollars-and-cents floats into whole cents', async () => {
    reply({
      data: {
        createInvoice: { ...created.data.createInvoice, amountUsd: 66.34 },
      },
    });

    expect((await client().createInvoice(6634, 'x')).amountCents).toBe(6634);
  });

  it('converts cents to dollars for the request', async () => {
    reply(created);

    await client().createInvoice(6634, 'https://app.example.com/billing');

    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as {
      variables: { input: { amountUsd: number } };
    };
    expect(sent.variables.input.amountUsd).toBe(66.34);
  });

  it('treats a state it does not know as still pending — an unknown state must never grant a plan', async () => {
    reply({
      data: {
        createInvoice: {
          ...created.data.createInvoice,
          status: 'settling_soon',
        },
      },
    });

    expect((await client().createInvoice(1900, 'x')).status).toBe('pending');
  });

  it('has no checkout URL when the gateway gave none', async () => {
    reply({
      data: {
        createInvoice: {
          ...created.data.createInvoice,
          checkoutUrl: null,
          expiresAt: null,
        },
      },
    });

    expect(await client().createInvoice(1900, 'x')).toMatchObject({
      checkoutUrl: null,
      expiresAt: null,
    });
  });

  it('does not call the gateway at all when billing is off', async () => {
    const off = client({
      PAYMENT_GATEWAY_URL: undefined,
      PAYMENT_GATEWAY_SLUG: undefined,
      PAYMENT_GATEWAY_API_KEY_ID: undefined,
      PAYMENT_GATEWAY_API_KEY_SECRET: undefined,
    });

    expect((await errorOf(off.createInvoice(1900, 'x'))).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GatewayClient.getInvoice', () => {
  it('asks for one invoice by number and reads its state', async () => {
    reply({
      data: { invoice: { invoiceNo: '1042', amountUsd: 19, status: 'paid' } },
    });

    const invoice = await client().getInvoice('1042');

    expect(invoice).toMatchObject({
      invoiceNo: '1042',
      amountCents: 1900,
      status: 'paid',
    });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { variables: unknown };
    expect(sent.variables).toEqual({ n: '1042' });
  });

  it.each(['paid', 'expired', 'failed', 'cancelled', 'refunded', 'pending'])(
    'reads %s',
    async (status) => {
      reply({ data: { invoice: { invoiceNo: '1', amountUsd: 1, status } } });

      expect((await client().getInvoice('1')).status).toBe(status);
    },
  );

  it('is unavailable when the gateway has no such invoice', async () => {
    reply({ data: { invoice: null } });

    expect((await errorOf(client().getInvoice('nope'))).code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
  });
});

describe('GatewayClient — when the gateway misbehaves', () => {
  it.each([
    ['answers with an HTTP error', () => reply('boom', 502)],
    [
      'answers with something that is not JSON',
      () => reply('<html>nope</html>'),
    ],
    [
      'reports a GraphQL error',
      () =>
        reply({
          errors: [
            { message: 'bad slug ipscope', extensions: { code: 'NOT_FOUND' } },
          ],
        }),
    ],
    ['answers with no data', () => reply({})],
    [
      'sends an invoice we cannot read',
      () =>
        reply({
          data: {
            invoice: { invoiceNo: '1', amountUsd: 'lots', status: 'paid' },
          },
        }),
    ],
  ])('is a 503, not a crash, when it %s', async (_name, arrange) => {
    arrange();

    const error = await errorOf(client().getInvoice('1'));

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).not.toMatch(/ipscope|key_secret|502|NOT_FOUND/);
  });

  it('is a 503 when the gateway cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.1:443'),
    );

    const error = await errorOf(client().getInvoice('1'));

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).not.toContain('ECONNREFUSED');
  });
});

describe('GatewayClient.verifyWebhook', () => {
  const sign = (body: string, secret = 'whsec_test') =>
    createHmac('sha256', secret).update(body).digest('hex');
  const body = JSON.stringify({
    invoiceNo: 1042,
    status: 'paid',
    amountUsd: 19,
    slug: 'ipscope',
  });

  it('gives the invoice number of a body signed with our secret', () => {
    expect(client().verifyWebhook(Buffer.from(body), sign(body))).toBe('1042');
  });

  it('accepts the raw body as a string too, and a signature with stray whitespace', () => {
    expect(client().verifyWebhook(body, ` ${sign(body)}\n`)).toBe('1042');
  });

  it('refuses a body signed with another secret', () => {
    expect(
      client().verifyWebhook(Buffer.from(body), sign(body, 'whsec_other')),
    ).toBeNull();
  });

  it('refuses a body altered after it was signed', () => {
    const signature = sign(body);

    expect(
      client().verifyWebhook(
        Buffer.from(body.replace('1042', '9999')),
        signature,
      ),
    ).toBeNull();
  });

  it.each([
    ['no signature', undefined],
    ['an empty signature', ''],
    ['a signature that is not hex', 'not-hex-at-all'],
    ['a signature that is too short', 'abcd'],
  ])('refuses %s', (_name, signature) => {
    expect(client().verifyWebhook(Buffer.from(body), signature)).toBeNull();
  });

  it('refuses everything when there is no webhook secret here', () => {
    const noSecret = client({ PAYMENT_GATEWAY_WEBHOOK_SECRET: undefined });

    expect(noSecret.verifyWebhook(Buffer.from(body), sign(body))).toBeNull();
    expect(
      noSecret.verifyWebhook(Buffer.from(body), sign(body, '')),
    ).toBeNull();
  });

  it('refuses a missing body', () => {
    expect(client().verifyWebhook(undefined, sign(body))).toBeNull();
  });

  it('refuses a message about another payment link', () => {
    const other = JSON.stringify({ invoiceNo: 1, slug: 'someone-else' });

    expect(client().verifyWebhook(Buffer.from(other), sign(other))).toBeNull();
  });

  it('accepts a message that names no payment link', () => {
    const bare = JSON.stringify({ invoiceNo: '77' });

    expect(client().verifyWebhook(Buffer.from(bare), sign(bare))).toBe('77');
  });

  it('refuses a signed body that is not JSON, or has no invoice number', () => {
    expect(
      client().verifyWebhook(Buffer.from('nope'), sign('nope')),
    ).toBeNull();
    const noNumber = JSON.stringify({ slug: 'ipscope' });
    expect(
      client().verifyWebhook(Buffer.from(noNumber), sign(noNumber)),
    ).toBeNull();
  });
});
