const hasCode = (error: unknown, code: string): boolean => {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === code) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
};

/** Postgres error code for a UNIQUE violation. Drizzle wraps the driver error, so walk `cause` too. */
export const isUniqueViolation = (error: unknown): boolean =>
  hasCode(error, '23505');

/** Postgres error code for a FOREIGN KEY violation: a row pointing at one that doesn't exist. */
export const isForeignKeyViolation = (error: unknown): boolean =>
  hasCode(error, '23503');
