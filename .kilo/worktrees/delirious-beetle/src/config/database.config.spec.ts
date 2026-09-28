describe('databaseConnection', () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
    jest.resetModules();
  });

  it('pins the session time zone to UTC, so now() defaults match how Drizzle reads timestamps', async () => {
    // The module needs some connection string to load; which one doesn't matter here.
    process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/db';

    const { databaseConnection } = await import('./database.config');

    expect(databaseConnection.options).toBe('-c timezone=UTC');
  });
});
