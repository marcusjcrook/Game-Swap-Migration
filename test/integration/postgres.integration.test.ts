import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.DATABASE_INTEGRATION_URL;
const schemaName = `integration_${randomUUID().replace(/-/g, '')}`;
const quotedSchemaName = `"${schemaName}"`;

describe.skipIf(!connectionString)('PostgreSQL schema integration', () => {
    let pool: Pool;
    let client: PoolClient;

    beforeAll(async () => {
        pool = new Pool({ connectionString });
        await pool.query(`CREATE SCHEMA ${quotedSchemaName}`);
        client = await pool.connect();
        await client.query(`SET search_path TO ${quotedSchemaName}`);
        const schemaSql = await readFile(new URL('../../src/init.sql', import.meta.url), 'utf8');
        await client.query(schemaSql);
    });

    afterAll(async () => {
        if (client) client.release();
        if (pool) {
            await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
            await pool.end();
        }
    });

    it('enforces schema constraints and cascades item deletion to subtype and swap rows', async () => {
        await client.query(
            `INSERT INTO addresses (postal_code, city, state, latitude, longitude)
             VALUES ('12345', 'Testville', 'TS', 40, -75)`
        );
        await client.query(
            `INSERT INTO users (email, password_hash, first_name, last_name, nickname, postal_code)
             VALUES
                ('proposer@example.test', 'test-hash', 'Proposer', 'Test', 'Proposer', '12345'),
                ('recipient@example.test', 'test-hash', 'Recipient', 'Test', 'Recipient', '12345')`
        );

        const itemResult = await client.query(
            `INSERT INTO items (title, condition, email)
             VALUES
                ('Board game', 'Mint', 'proposer@example.test'),
                ('Puzzle', 'Like New', 'recipient@example.test')
             RETURNING item_id`
        );
        const [proposedItem, desiredItem] = itemResult.rows.map((row) => row.item_id as number);

        await client.query('INSERT INTO board_games (item_id) VALUES ($1)', [proposedItem]);
        await client.query(
            'INSERT INTO jigsaw_puzzles (item_id, pieces) VALUES ($1, $2)',
            [desiredItem, 500]
        );
        await client.query(
            `INSERT INTO swaps (
                proposed_item_number, desired_item_number, accepted, proposer_rating, counterparty_rating
             ) VALUES ($1, $2, TRUE, 5, 4)`,
            [proposedItem, desiredItem]
        );

        const averageResult = await client.query(
            `SELECT ROUND(AVG(rating), 2) AS average_rating
             FROM (
                SELECT s.proposer_rating AS rating
                FROM swaps s
                JOIN items proposed ON proposed.item_id = s.proposed_item_number
                WHERE s.accepted IS TRUE AND proposed.email = $1
                UNION ALL
                SELECT s.counterparty_rating AS rating
                FROM swaps s
                JOIN items desired ON desired.item_id = s.desired_item_number
                WHERE s.accepted IS TRUE AND desired.email = $1
             ) user_ratings`,
            ['proposer@example.test']
        );
        expect(averageResult.rows[0].average_rating).toBe('5.00');

        await expect(
            client.query(
                'INSERT INTO jigsaw_puzzles (item_id, pieces) VALUES ($1, 0)',
                [desiredItem]
            )
        ).rejects.toMatchObject({ code: '23514' });

        await client.query('DELETE FROM items WHERE item_id = $1', [desiredItem]);
        const cascadeResult = await client.query(
            `SELECT
                (SELECT COUNT(*) FROM swaps WHERE proposed_item_number = $1 OR desired_item_number = $1) AS swap_count,
                (SELECT COUNT(*) FROM jigsaw_puzzles WHERE item_id = $1) AS subtype_count`,
            [desiredItem]
        );
        expect(cascadeResult.rows[0]).toEqual({ swap_count: '0', subtype_count: '0' });
    });

    it('enforces unique phone numbers and one phone per user, cascading phone deletion', async () => {
        await client.query(
            `INSERT INTO addresses (postal_code, city, state, latitude, longitude)
             VALUES ('54321', 'Phoneville', 'PH', 40, -75)`
        );
        await client.query(
            `INSERT INTO users (email, password_hash, first_name, last_name, nickname, postal_code)
             VALUES ('phone@example.test', 'test-hash', 'Phone', 'User', 'PhoneUser', '54321')`
        );
        await client.query(
            `INSERT INTO phones (phone_number, type, shareable, email)
             VALUES ('404-555-1212', 'Mobile', TRUE, 'phone@example.test')`
        );

        await expect(
            client.query(
                `INSERT INTO phones (phone_number, type, email)
                 VALUES ('404-555-1212', 'Home', 'phone@example.test')`
            )
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
            client.query(
                `INSERT INTO phones (phone_number, type, email)
                 VALUES ('404-555-3434', 'Home', 'phone@example.test')`
            )
        ).rejects.toMatchObject({ code: '23505' });

        await client.query('DELETE FROM users WHERE email = $1', ['phone@example.test']);
        const phoneResult = await client.query(
            'SELECT COUNT(*) FROM phones WHERE email = $1',
            ['phone@example.test']
        );
        expect(phoneResult.rows[0].count).toBe('0');
    });
});
