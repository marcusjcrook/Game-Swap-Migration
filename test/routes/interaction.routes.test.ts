import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interactionRoutes } from '../../src/routes/interaction.routes';
import {
    createApp,
    createMockPool,
    queryResult,
    sessionCookie,
    stubSessionSecret
} from './test-utils';

describe('interaction routes', () => {
    let app: ReturnType<typeof createApp>;
    let pool: ReturnType<typeof createMockPool>;

    beforeEach(async () => {
        stubSessionSecret();
        app = createApp();
        pool = createMockPool();
        await app.register(interactionRoutes, { dbPool: pool.dbPool }).ready();
    });

    afterEach(async () => {
        await app.close();
        vi.unstubAllEnvs();
    });

    it('requires authentication to view incoming proposals', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/swaps/incoming' });

        expect(response.statusCode).toBe(401);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects invalid pagination without running a query', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/swaps/history?offset=-1',
            headers: { cookie: sessionCookie('user@example.test') }
        });

        expect(response.statusCode).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('applies pagination to incoming proposals and returns an empty list', async () => {
        pool.query.mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/swaps/incoming?limit=8&offset=16',
            headers: { cookie: sessionCookie('recipient@example.test') }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            swaps: [],
            pagination: { limit: 8, offset: 16 }
        });
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('LIMIT $2 OFFSET $3'),
            ['recipient@example.test', 8, 16]
        );
    });

    it('prevents a user from proposing an item owned by someone else', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                proposer_email: 'actual-owner@example.test',
                counterparty_email: 'recipient@example.test'
            }]))
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/swaps',
            headers: { cookie: sessionCookie('not-owner@example.test') },
            payload: {
                proposed_item_number: 1,
                desired_item_number: 2,
                date_proposed: '2026-01-15'
            }
        });

        expect(response.statusCode).toBe(403);
        expect(pool.client.query.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            expect.stringContaining('FOR SHARE OF proposed, desired'),
            'ROLLBACK'
        ]);
    });

    it('creates a proposal when the authenticated user owns the proposed item', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                proposer_email: 'owner@example.test',
                counterparty_email: 'recipient@example.test'
            }]))
            .mockResolvedValueOnce(queryResult([{
                proposed_item_number: 1,
                desired_item_number: 2,
                accepted: null,
                date_proposed: '2026-01-15'
            }]))
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/swaps',
            headers: { cookie: sessionCookie('owner@example.test') },
            payload: {
                proposed_item_number: 1,
                desired_item_number: 2,
                date_proposed: '2026-01-15'
            }
        });

        expect(response.statusCode).toBe(201);
        expect(response.json().swap).toMatchObject({
            proposed_item_number: 1,
            desired_item_number: 2
        });
        expect(pool.client.query.mock.calls[2][0]).toContain('INSERT INTO swaps');
        expect(pool.client.query.mock.calls[3][0]).toBe('COMMIT');
    });
});
