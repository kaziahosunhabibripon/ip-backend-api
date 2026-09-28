import type { CookieOptions, Response } from 'express';
import { isProductionEnvironment } from '../config/env.config';

/** Hard-coded on the frontend too — proxy.ts in ipscope-web checks for this exact name. */
export const SESSION_COOKIE_NAME = 'ipscope_session';

const baseOptions = (): CookieOptions => {
  // Frontend and backend on two different sites (e.g. two separate tunnel subdomains during testing) makes
  // this a genuinely cross-site request — SameSite=Lax never sends the cookie back on those, only
  // SameSite=None does, and browsers reject None without Secure. Off by default: it only helps when the
  // traffic is real HTTPS end to end (as a tunnel provides), and it's a weaker default than Lax, so it's
  // opt-in, not tied to NODE_ENV. Read here, not at module load — `loadEnvironment()` hasn't necessarily run
  // yet by the time this module is first imported.
  const crossSite = process.env.COOKIE_CROSS_SITE?.trim() === 'true';

  return {
    httpOnly: true,
    secure: crossSite || isProductionEnvironment(),
    sameSite: crossSite ? 'none' : 'lax',
    path: '/',
    // In production set to the shared parent domain (e.g. ".ipscope.com") so api.* and the frontend both see it.
    domain: process.env.COOKIE_DOMAIN?.trim() || undefined,
  };
};

/** `persistUntil` set = "remember me" (survives browser restarts); omitted = a browser-session cookie. */
export const setSessionCookie = (
  response: Response,
  token: string,
  persistUntil?: Date,
) => {
  response.cookie(SESSION_COOKIE_NAME, token, {
    ...baseOptions(),
    ...(persistUntil ? { expires: persistUntil } : {}),
  });
};

export const clearSessionCookie = (response: Response) => {
  response.clearCookie(SESSION_COOKIE_NAME, baseOptions());
};
