import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Skips AuthGuard's "must be signed in" check. A valid session cookie is still resolved,
 * so a handler can serve signed-in and anonymous viewers differently (e.g. `/check`, `/auth/me`).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
