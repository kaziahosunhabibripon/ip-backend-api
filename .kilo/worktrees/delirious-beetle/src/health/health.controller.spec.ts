import type { Response } from 'express';
import type { Database } from '../db/database';
import { HealthController } from './health.controller';

const controllerWith = (execute: () => Promise<unknown>) =>
  new HealthController({ execute } as unknown as Database);

const fakeResponse = () => {
  const response = { status: jest.fn() };
  return { response, asExpress: response as unknown as Response };
};

describe('HealthController', () => {
  describe('liveness', () => {
    it('is ok while the database answers', async () => {
      await expect(
        controllerWith(() => Promise.resolve([])).check(),
      ).resolves.toEqual({ status: 'ok', database: 'ok' });
    });

    it('stays ok when the database is down, and says so', async () => {
      await expect(
        controllerWith(() => Promise.reject(new Error('down'))).check(),
      ).resolves.toEqual({ status: 'ok', database: 'unavailable' });
    });
  });

  describe('readiness', () => {
    it('answers 200 while the database answers', async () => {
      const { response, asExpress } = fakeResponse();
      await expect(
        controllerWith(() => Promise.resolve([])).ready(asExpress),
      ).resolves.toEqual({ status: 'ok', database: 'ok' });
      expect(response.status).not.toHaveBeenCalled();
    });

    it('answers 503 when the database is unreachable', async () => {
      const { response, asExpress } = fakeResponse();
      await expect(
        controllerWith(() => Promise.reject(new Error('down'))).ready(
          asExpress,
        ),
      ).resolves.toEqual({ status: 'unavailable', database: 'unavailable' });
      expect(response.status).toHaveBeenCalledWith(503);
    });
  });
});
