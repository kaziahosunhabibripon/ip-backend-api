import type { ConfigService } from '@nestjs/config';
import { createServer, type Server, type Socket } from 'node:net';
import { CacheService } from './cache.service';

/**
 * A tiny Redis-protocol server (PING/INFO/CLIENT/SET/GET/INCR/EXPIRE/MULTI/EXEC/QUIT) so the real `ioredis` client can run
 * against something that speaks RESP — no Docker needed, and it records the TTL it was given.
 */
class FakeRedis {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private readonly transactions = new Map<Socket, string[][]>();
  private readonly server: Server;
  port = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);

      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = this.parse(buffer);
          if (!parsed) {
            return;
          }
          buffer = buffer.subarray(parsed.consumed);
          socket.write(this.handle(socket, parsed.args));
        }
      });
    });
  }

  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop() {
    this.sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private parse(buffer: Buffer): { args: string[]; consumed: number } | null {
    const text = buffer.toString('utf8');
    if (!text.startsWith('*')) {
      return null;
    }
    const lines = text.split('\r\n');
    const count = Number(lines[0].slice(1));
    const args: string[] = [];
    let offset = lines[0].length + 2;
    for (let index = 0; index < count; index += 1) {
      const header = lines[1 + index * 2];
      const value = lines[2 + index * 2];
      if (header === undefined || value === undefined) {
        return null;
      }
      const length = Number(header.slice(1));
      if (
        Buffer.byteLength(value) < length &&
        lines.length <= 2 + index * 2 + 1
      ) {
        return null;
      }
      args.push(value);
      offset += header.length + 2 + Buffer.byteLength(value) + 2;
    }
    return offset <= buffer.length ? { args, consumed: offset } : null;
  }

  /** MULTI queues commands until EXEC, which runs them and answers with one array. */
  private handle(socket: Socket, args: string[]): string {
    const name = args[0].toUpperCase();
    if (name === 'MULTI') {
      this.transactions.set(socket, []);
      return '+OK\r\n';
    }
    if (name === 'EXEC') {
      const queued = this.transactions.get(socket) ?? [];
      this.transactions.delete(socket);
      return `*${queued.length}\r\n${queued.map((command) => this.reply(command)).join('')}`;
    }
    const queue = this.transactions.get(socket);
    if (queue) {
      queue.push(args);
      return '+QUEUED\r\n';
    }
    return this.reply(args);
  }

  private reply(args: string[]): string {
    switch (args[0].toUpperCase()) {
      case 'INFO':
        return `$${'redis_version:7.0.0\r\nloading:0'.length}\r\nredis_version:7.0.0\r\nloading:0\r\n`;
      case 'SET': {
        this.data.set(args[1], args[2]);
        if (args[3]?.toUpperCase() === 'EX') {
          this.ttls.set(args[1], Number(args[4]));
        }
        return '+OK\r\n';
      }
      case 'GET': {
        const value = this.data.get(args[1]);
        return value === undefined
          ? '$-1\r\n'
          : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
      }
      case 'INCR': {
        const next = Number(this.data.get(args[1]) ?? 0) + 1;
        this.data.set(args[1], String(next));
        return `:${next}\r\n`;
      }
      case 'EXPIRE': {
        this.ttls.set(args[1], Number(args[2]));
        return ':1\r\n';
      }
      default:
        return '+OK\r\n'; // CLIENT SETINFO, QUIT, PING, …
    }
  }
}

const configFor = (port: number) =>
  ({
    get: (key: string) =>
      ({ REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port) })[key],
  }) as unknown as ConfigService;

const untilReady = async (cache: CacheService) => {
  const redis = (cache as unknown as { redis: { status: string } }).redis;
  for (
    let attempt = 0;
    attempt < 60 && redis.status !== 'ready';
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(redis.status).toBe('ready');
};

describe('CacheService against a Redis server', () => {
  const server = new FakeRedis();
  const services: CacheService[] = [];

  const connect = async () => {
    const cache = new CacheService(configFor(server.port));
    services.push(cache);
    cache.onModuleInit();
    await untilReady(cache);
    return cache;
  };

  beforeAll(() => server.start());
  afterAll(() => server.stop());
  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((cache) => cache.onModuleDestroy()),
    );
    server.data.clear();
    server.ttls.clear();
  });

  it('stores JSON in Redis with the requested TTL and reads it back', async () => {
    const cache = await connect();

    await cache.set('lookup:dns:example.com', { ips: ['1.2.3.4'] }, 300);

    expect(server.ttls.get('lookup:dns:example.com')).toBe(300);
    expect(
      JSON.parse(server.data.get('lookup:dns:example.com')!),
    ).toMatchObject({
      v: { ips: ['1.2.3.4'] },
    });
    await expect(cache.get('lookup:dns:example.com')).resolves.toMatchObject({
      value: { ips: ['1.2.3.4'] },
      ageSeconds: 0,
    });
  });

  it('shares entries between instances — the reason to use Redis at all', async () => {
    const first = await connect();
    const second = await connect();

    await first.set('shared', 'value', 60);

    await expect(second.get('shared')).resolves.toMatchObject({
      value: 'value',
    });
  });

  it('counts hits in one shared window, so a rate limit holds across API instances', async () => {
    const first = await connect();
    const second = await connect();

    // An hour-long window keeps the test from straddling a boundary.
    const a = await first.increment('rate:key_1', 3600);
    const b = await second.increment('rate:key_1', 3600);
    const c = await first.increment('rate:key_1', 3600);

    expect([a.count, b.count, c.count]).toEqual([1, 2, 3]);
    expect(a.resetsInSeconds).toBeGreaterThan(0);
    expect(a.resetsInSeconds).toBeLessThanOrEqual(3600);
    const stored = [...server.data.keys()].filter((key) =>
      key.startsWith('rate:key_1:'),
    );
    expect(stored).toHaveLength(1);
    // Twice the window, so a counter that never gets reset still disappears on its own.
    expect(server.ttls.get(stored[0])).toBe(7200);
  });

  it('counts separate keys separately', async () => {
    const cache = await connect();

    await cache.increment('rate:one', 3600);
    await cache.increment('rate:one', 3600);
    const other = await cache.increment('rate:two', 3600);

    expect(other.count).toBe(1);
  });

  it('misses cleanly for an unknown key', async () => {
    const cache = await connect();
    await expect(cache.get('nope')).resolves.toBeNull();
  });

  it('keeps working from memory, without throwing, once the Redis server goes away', async () => {
    const cache = await connect();
    await cache.set('before', 1, 60);

    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(cache.set('during', 2, 60)).resolves.toBeUndefined();
    await expect(cache.get('during')).resolves.toMatchObject({ value: 2 });

    await server.start(); // a fresh port for the following tests
  });
});
