import { Client } from 'pg';
import { isProductionEnvironment } from '../config/env.config';
import { parseSetPlanArgs } from './set-plan.args';

/**
 * `npm run dev:set-plan -- jane@company.com business`
 *
 * A development shortcut: puts an account on a plan straight away, so plan-gated screens (monitoring, API keys,
 * analytics) can be tried without going through a payment. It writes `users.plan` — what every limit is enforced
 * from — and nothing else, so it never opens an invoice. It refuses to run in production, where a plan can only
 * come from a payment (or, for Enterprise, from a person arranging it).
 *
 * Billing state is left alone: a paid period the account already has, a payment that lands afterwards, or a period
 * ending, will move the plan again the way it normally does.
 */
const main = async () => {
  if (isProductionEnvironment()) {
    throw new Error(
      'dev:set-plan is for development databases and refuses to run with NODE_ENV=production.',
    );
  }
  const args = parseSetPlanArgs(process.argv.slice(2));
  if (!args.ok) {
    throw new Error(args.message);
  }

  // Loaded only now: importing it reads the database settings, which a production environment may not even have
  // here, and the refusal above should be the message people see.

  /* eslint-disable @typescript-eslint/no-require-imports */
  const config =
    require('../config/database.config') as typeof import('../config/database.config');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const client = new Client(config.databaseConnection);
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      'update users set plan = $1 where email = $2 returning id',
      [args.plan, args.email],
    );
    if (rows.length === 0) {
      throw new Error(`No account with the email ${args.email}.`);
    }
    // Which database this touched, without the credentials in the connection string.
    const target = client.host
      ? `${client.host}:${client.port}/${client.database}`
      : 'the configured database';
    console.log(`${args.email} is now on the ${args.plan} plan (${target}).`);
    console.log(
      'Billing is untouched: a paid period, a payment or a period ending can still move the plan.',
    );
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
