import { Client } from 'pg';
import { databaseConnection } from '../config/database.config';

/**
 * `npm run admin:grant -- jane@company.com` / `npm run admin:revoke -- jane@company.com`
 *
 * There is deliberately no API for making someone an administrator: the first one has to come from whoever runs
 * the server, and the rest are made the same way. Granting needs an existing, unsuspended account; revoking signs
 * nobody out (their next request simply stops being allowed into `/admin`).
 */
const main = async () => {
  const [command, rawEmail] = process.argv.slice(2);
  const email = rawEmail?.trim().toLowerCase();
  if ((command !== 'grant' && command !== 'revoke') || !email) {
    throw new Error('Usage: admin-role <grant|revoke> <email>');
  }

  const client = new Client(databaseConnection);
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      role: string;
      suspended_at: Date | null;
    }>('select id, role, suspended_at from users where email = $1', [email]);
    const user = rows[0];
    if (!user) {
      throw new Error(`No account with the email ${email}.`);
    }

    const role = command === 'grant' ? 'admin' : 'user';
    if (command === 'grant' && user.suspended_at) {
      throw new Error(`${email} is suspended. Reactivate the account first.`);
    }
    if (user.role === role) {
      console.log(
        `${email} is already ${role === 'admin' ? 'an administrator' : 'a regular user'}.`,
      );
      return;
    }

    await client.query('update users set role = $1 where id = $2', [
      role,
      user.id,
    ]);
    console.log(
      role === 'admin'
        ? `${email} is now an administrator.`
        : `${email} is no longer an administrator.`,
    );
  } finally {
    await client.end();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
