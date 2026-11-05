import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { vi } from 'vitest';
import { createSessionToken } from '../../src/auth/session';

export const testSessionSecret = 'vitest-route-test-secret-with-at-least-32-characters';

export function createMockPool() {
    const client = {
        query: vi.fn(),
        release: vi.fn()
    };
    const pool = {
        query: vi.fn(),
        connect: vi.fn().mockResolvedValue(client)
    };
    return {
        dbPool: pool as unknown as Pool,
        query: pool.query,
        connect: pool.connect,
        client
    };
}

export function createApp(): FastifyInstance {
    return Fastify({ logger: false });
}

export function sessionCookie(email: string): string {
    return `gameswap_session=${createSessionToken(email)}`;
}

export function queryResult<Row extends Record<string, unknown>>(
    rows: Row[] = [],
    rowCount = rows.length
) {
    return { rows, rowCount };
}

export function stubSessionSecret(): void {
    vi.stubEnv('SESSION_SECRET', testSessionSecret);
}
