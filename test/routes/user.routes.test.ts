import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../src/auth/password';
import { userRoutes } from '../../src/routes/user.routes';
import {
    createApp,
    createMockPool,
    queryResult,
    sessionCookie,
    stubSessionSecret
} from './test-utils';

describe('user routes', () => {
    let app: ReturnType<typeof createApp>;
    let pool: ReturnType<typeof createMockPool>;

    beforeEach(async () => {
        stubSessionSecret();
        app = createApp();
        pool = createMockPool();
        await app.register(userRoutes, { dbPool: pool.dbPool }).ready();
    });

    afterEach(async () => {
        await app.close();
        vi.unstubAllEnvs();
    });

    it('requires authentication to retrieve the current profile', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/users/me' });

        expect(response.statusCode).toBe(401);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('includes the account phone in the authenticated user response', async () => {
        const passwordHash = await hashPassword('secure-password');
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                email: 'user@example.test',
                password_hash: passwordHash,
                first_name: 'Test',
                last_name: 'User',
                nickname: 'Tester',
                postal_code: '12345'
            }]))
            .mockResolvedValueOnce(queryResult([{
                phone_number: '404-555-1212',
                type: 'Mobile',
                shareable: true
            }]))
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email: 'user@example.test', password: 'secure-password' }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().user.phone).toEqual({
            phone_number: '404-555-1212',
            type: 'Mobile',
            shareable: true
        });
    });

    it('rejects an empty profile update before querying the database', async () => {
        const response = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('user@example.test') },
            payload: {}
        });

        expect(response.statusCode).toBe(400);
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('returns the profile for the authenticated account', async () => {
        pool.query.mockResolvedValueOnce(queryResult([{
            email: 'user@example.test',
            first_name: 'Test',
            last_name: 'User',
            nickname: 'Tester',
            postal_code: '12345',
            phone_number: '404-555-1212',
            phone_type: 'Mobile',
            phone_shareable: true
        }]));

        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('user@example.test') }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            email: 'user@example.test',
            nickname: 'Tester',
            phone: {
                phone_number: '404-555-1212',
                type: 'Mobile',
                shareable: true
            }
        });
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE u.email = $1'),
            ['user@example.test']
        );
    });

    it('reports a missing profile', async () => {
        pool.query.mockResolvedValueOnce(queryResult([], 0));

        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('missing@example.test') }
        });

        expect(response.statusCode).toBe(404);
    });

    it('converts an invalid postal-code foreign key to a conflict response', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{ email: 'user@example.test' }]))
            .mockRejectedValueOnce(Object.assign(new Error('foreign key violation'), { code: '23503' }));

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('user@example.test') },
            payload: { postal_code: '99999' }
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/postal code/);
    });

    it('updates phone details and returns the updated profile', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{ email: 'user@example.test' }]))
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                email: 'user@example.test',
                first_name: 'Test',
                last_name: 'User',
                nickname: 'Tester',
                postal_code: '12345',
                phone_number: '404-555-1212',
                phone_type: 'Mobile',
                phone_shareable: true
            }]))
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('user@example.test') },
            payload: { phone: { phone_number: '404-555-1212', type: 'Mobile', shareable: true } }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().phone).toEqual({
            phone_number: '404-555-1212',
            type: 'Mobile',
            shareable: true
        });
        expect(pool.client.query.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            expect.stringContaining('FOR UPDATE'),
            'DELETE FROM phones WHERE email = $1',
            expect.stringContaining('INSERT INTO phones'),
            expect.stringContaining('LEFT JOIN phones'),
            'COMMIT'
        ]);
    });

    it('removes the account phone when the profile phone is null', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{ email: 'user@example.test' }]))
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                email: 'user@example.test',
                first_name: 'Test',
                last_name: 'User',
                nickname: 'Tester',
                postal_code: '12345',
                phone_number: null,
                phone_type: null,
                phone_shareable: null
            }]))
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('user@example.test') },
            payload: { phone: null }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().phone).toBeNull();
        expect(pool.client.query.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            expect.stringContaining('FOR UPDATE'),
            'DELETE FROM phones WHERE email = $1',
            expect.stringContaining('LEFT JOIN phones'),
            'COMMIT'
        ]);
    });

    it('rejects a phone number registered to another user', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{ email: 'user@example.test' }]))
            .mockResolvedValueOnce(queryResult())
            .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
                code: '23505',
                constraint: 'phones_pkey'
            }));

        const response = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { cookie: sessionCookie('user@example.test') },
            payload: { phone: { phone_number: '404-555-1212', type: 'Mobile' } }
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/phone number already registered/i);
        expect(pool.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    });

    it('registers a user and optional phone in one transaction', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                email: 'new@example.test',
                first_name: 'New',
                last_name: 'User',
                nickname: 'NewUser',
                postal_code: '12345'
            }]))
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult());

        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/users',
            payload: {
                email: 'new@example.test',
                password: 'secure-password',
                first_name: 'New',
                last_name: 'User',
                nickname: 'NewUser',
                postal_code: '12345',
                phone: { phone_number: '404-555-1212', type: 'Mobile' }
            }
        });

        expect(response.statusCode).toBe(201);
        expect(response.json().phone).toEqual({
            phone_number: '404-555-1212',
            type: 'Mobile',
            shareable: false
        });
        expect(pool.client.query.mock.calls.map(([sql]) => sql)).toEqual([
            'BEGIN',
            expect.stringContaining('INSERT INTO users'),
            expect.stringContaining('INSERT INTO phones'),
            'COMMIT'
        ]);
    });

    it('rejects a registration phone number already in use', async () => {
        pool.client.query
            .mockResolvedValueOnce(queryResult())
            .mockResolvedValueOnce(queryResult([{
                email: 'new@example.test',
                first_name: 'New',
                last_name: 'User',
                nickname: 'NewUser',
                postal_code: '12345'
            }]))
            .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
                code: '23505',
                constraint: 'phones_pkey'
            }));

        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/users',
            payload: {
                email: 'new@example.test',
                password: 'secure-password',
                first_name: 'New',
                last_name: 'User',
                nickname: 'NewUser',
                postal_code: '12345',
                phone: { phone_number: '404-555-1212', type: 'Mobile' }
            }
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/phone number already registered/i);
        expect(pool.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    });
});
