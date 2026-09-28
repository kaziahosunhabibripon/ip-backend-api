import type { Request } from 'express';

export interface RequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

export const getRequestMeta = (request: Request): RequestMeta => ({
  userAgent: request.headers['user-agent'],
  ipAddress: request.ip,
});
