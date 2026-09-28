import type { Request } from 'express';
import type { ApiKeyPrincipal } from '../../api-keys/api-key-auth.service';
import type { User } from '../../contracts';

/**
 * What AuthGuard attaches: the user when the request carries a valid `ipscope_session` cookie or — on
 * routes that accept them — a valid API key (then `apiKey` says which one; `sessionId` is unset).
 */
export interface AuthenticatedRequest extends Request {
  user?: User;
  sessionId?: string;
  apiKey?: ApiKeyPrincipal;
}
