import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '../../contracts';
import { ApiException } from '../dto/api-exception';
import type { AuthenticatedRequest } from '../types/authenticated-request.type';

const getRequest = (context: ExecutionContext) =>
  context.switchToHttp().getRequest<AuthenticatedRequest>();

/** The signed-in user, or undefined on a `@Public()` route with no session. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User | undefined =>
    getRequest(context).user,
);

/** For routes that require a session: the signed-in user, never undefined (AuthGuard has already rejected anonymous callers). */
export const RequiredUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const { user } = getRequest(context);
    if (!user) {
      throw new ApiException('AUTH_REQUIRED', 'Log in to continue.');
    }
    return user;
  },
);

/** The API key the request authenticated with; undefined for cookie and anonymous requests. */
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => getRequest(context).apiKey,
);

/** Id of the session row behind this request's cookie. */
export const CurrentSessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    getRequest(context).sessionId,
);
