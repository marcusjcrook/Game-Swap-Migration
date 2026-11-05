import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { itemRoutes } from '../../src/routes/item.routes';
import {
    createApp,
    createMockPool,
    queryResult,
    sessionCookie,
    stubSessionSecret
} from './test-utils';

describe('item routes', () => {
    let app: ReturnType<typeof createApp>;
    let pool: ReturnType<typeof createMockPool>;

    beforeEach(async () => {
        stubSessionSecret();
        app = createApp();
        pool = createMockPool();
        await app.register(itemRoutes, { dbPool: pool.dbPool }).ready();
    });

    afterEach(async () => {
        await app.close();
        vi.unstubAllEnvs();
    });

    it('requires authentication to list owned items', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/items/mine' });

        expect(response.statusCode).toBe(401);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects invalid search parameters before querying the database', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/items/search?limit=101',
            headers: { cookie: sessionCookie('owner@example.test') }
        });

        expect(response.statusCode, response.body).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('creates an item and its subtype in one transaction', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{ item_id: 42 }]))
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/items',
            headers: { cookie: sessionCookie('owner@example.test') },
            payload: {
                type: 'jigsawPuzzle',
                title: 'Puzzle',
                condition: 'Mint',
                email: 'owner@example.test',
                pieces: 500
            }
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ itemID: 42, type: 'jigsawPuzzle' });
        expect(pool.client.query.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            expect.stringContaining('INSERT INTO items'),
            'INSERT INTO jigsaw_puzzles (item_id, pieces) VALUES ($1, $2)',
            'COMMIT'
        ]);
        expect(pool.client.query.mock.calls[2][1]).toEqual([42, 500]);
        expect(pool.client.release).toHaveBeenCalledOnce();
    });

    it('rejects updates whose subtype fields do not match the item type', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{ item_id: 42 }]))
            .mockResolvedValueOnce(queryResult([{ type: 'videoGame' }]))
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/v1/items/42',
            headers: { cookie: sessionCookie('owner@example.test') },
            payload: { pieces: 500 }
        });

        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error).toMatch(/type-specific fields/);
        expect(pool.client.query.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            expect.stringContaining('FOR UPDATE'),
            expect.stringContaining('LEFT JOIN board_games'),
            'ROLLBACK'
        ]);
    });

    it('returns not found when an item detail query has no matching row', async () => {
        pool.query.mockResolvedValueOnce(queryResult([], 0));

        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/items/999',
            headers: { cookie: sessionCookie('owner@example.test') }
        });

        expect(response.statusCode).toBe(404);
    });
});
