// src/queue/redis/redis.config.ts

import { Logger } from '@nestjs/common';
import type { RedisOptions } from 'bullmq';

const logger = new Logger('RedisConfig');

/**
 * BullMQ connection options for the §7 drip queue.
 *
 * Accepts either a single REDIS_URL (`redis://` / `rediss://`, the form managed
 * providers hand out) or discrete REDIS_HOST/REDIS_PORT vars. Falls back to
 * localhost with a warning rather than throwing, so the HTTP API still boots in
 * environments where the queue is not configured.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands.
 */
export function getRedisOptions(): RedisOptions {
  const base: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  const url = process.env.REDIS_URL;

  if (url) {
    return { ...base, url };
  }

  const host = process.env.REDIS_HOST;

  if (!host) {
    logger.warn(
      'Neither REDIS_URL nor REDIS_HOST is set — defaulting to localhost:6379. ' +
        'Drip emails will not be scheduled until Redis is reachable.',
    );
  }

  return {
    ...base,
    host: host || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
  };
}
