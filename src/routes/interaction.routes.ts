import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';
import { getSessionEmail } from '../auth/session';
import {
    PaginationQuerySchema,
    SwapDecisionSchema,
    SwapRatingSchema,
    SwapSchema
} from '../domain/interaction.schema';

// Extract the authenticated user's email from the session cookie in the request headers.
function getSessionUserEmail(request: FastifyRequest): string | null {
    const cookieHeader = request.headers.cookie;
    return getSessionEmail(typeof cookieHeader === 'string' ? cookieHeader : undefined);
}

// Swap listing rows are enriched with item types and proposer averages before returning to the client.
interface SwapListingRow extends QueryResultRow {
    proposed_item_number: number;
    desired_item_number: number;
    proposed_item_title: string;
    desired_item_title: string;
    accepted: boolean | null;
    date_proposed: string;
    date_accepted_rejected: string | null;
    proposer_rating: number | null;
    counterparty_rating: number | null;
    proposer_nickname: string;
    counterparty_nickname: string;
    proposer_email: string;
    counterparty_email: string;
    proposer_distance_miles: string | number;
    your_role: 'proposer' | 'counterparty';
}

// The base SQL query for listing swaps, including distance calculation and role determination.
const SwapListingSelect = `
    SELECT
        s.proposed_item_number,
        s.desired_item_number,
        s.accepted,
        s.date_proposed,
        s.date_accepted_rejected,
        s.proposer_rating,
        s.counterparty_rating,
        i.title AS proposed_item_title,
        j.title AS desired_item_title,
        proposer.email AS proposer_email,
        counterparty.email AS counterparty_email,
        proposer.nickname AS proposer_nickname,
        counterparty.nickname AS counterparty_nickname,
        ROUND((
            3958.75 * 2 * ASIN(SQRT(LEAST(1::double precision,
                POWER(SIN(RADIANS(proposer_address.latitude - viewer_address.latitude) / 2), 2) +
                COS(RADIANS(viewer_address.latitude)) * COS(RADIANS(proposer_address.latitude)) *
                POWER(SIN(RADIANS(proposer_address.longitude - viewer_address.longitude) / 2), 2)
            )))
        )::numeric, 1) AS proposer_distance_miles,
        CASE
            WHEN i.email = $1 THEN 'proposer'
            WHEN j.email = $1 THEN 'counterparty'
        END AS your_role
    FROM swaps s
    JOIN items i ON i.item_id = s.proposed_item_number
    JOIN items j ON j.item_id = s.desired_item_number
    JOIN users proposer ON proposer.email = i.email
    JOIN users counterparty ON counterparty.email = j.email
    JOIN addresses proposer_address ON proposer_address.postal_code = proposer.postal_code
    JOIN users viewer ON viewer.email = $1
    JOIN addresses viewer_address ON viewer_address.postal_code = viewer.postal_code
`;

// Fields added during enrichment.
type EnrichedSwapDetails = {
    proposed_item_type: string | null;
    desired_item_type: string | null;
    proposer_average_rating: string | number | null;
};

// The final shape omits participant emails and includes the enrichment fields.
export type CleanedSwapListing = Omit<SwapListingRow, 'proposer_email' | 'counterparty_email'> &
    EnrichedSwapDetails;

// Look up subtype labels and proposer averages in batches after pagination.
// This avoids multiplying the listing joins or issuing one extra query per swap row.
async function addSwapListingDetails(
    dbPool: Pool,
    rows: SwapListingRow[]
): Promise<CleanedSwapListing[]> {
    if (rows.length === 0) return [];

    // Gather unique IDs so each lookup only fetches data once, even when an item
    // or proposer appears in several listings on the same page.
    const itemIds = [...new Set(rows.flatMap((row) => [
        row.proposed_item_number,
        row.desired_item_number
    ]))];
    const proposerEmails = [...new Set(rows.map((row) => row.proposer_email))];

    // Item category lives in one of several subtype tables, so UNION them into
    // a single item_id-to-type lookup instead of joining every subtype to listings.
    // Ratings are attributed to the participant's role in each accepted swap;
    // AVG ignores unrated swaps and ROUND keeps the displayed value concise.
    // These lookups are independent and scoped to this page's items and proposers.
    const [typesResult, ratingsResult] = await Promise.all([
        dbPool.query<{ item_id: number; type: string }>(
            `SELECT item_id, 'boardGame' AS type FROM board_games WHERE item_id = ANY($1::int[])
             UNION ALL
             SELECT item_id, 'cardGame' AS type FROM card_games WHERE item_id = ANY($1::int[])
             UNION ALL
             SELECT item_id, 'jigsawPuzzle' AS type FROM jigsaw_puzzles WHERE item_id = ANY($1::int[])
             UNION ALL
             SELECT item_id, 'computerGame' AS type FROM computer_games WHERE item_id = ANY($1::int[])
             UNION ALL
             SELECT item_id, 'videoGame' AS type FROM video_games WHERE item_id = ANY($1::int[])`,
            [itemIds]
        ),
        dbPool.query<{ email: string; average_rating: string | null }>(
            `WITH requested_users AS (
                SELECT unnest($1::text[]) AS email
             ),
             user_ratings AS (
                SELECT proposed.email, s.proposer_rating AS rating
                FROM swaps s
                JOIN items proposed ON proposed.item_id = s.proposed_item_number
                WHERE s.accepted IS TRUE AND proposed.email = ANY($1::text[])
                UNION ALL
                SELECT desired.email, s.counterparty_rating AS rating
                FROM swaps s
                JOIN items desired ON desired.item_id = s.desired_item_number
                WHERE s.accepted IS TRUE AND desired.email = ANY($1::text[])
             )
             SELECT requested_users.email,
                    ROUND(AVG(user_ratings.rating), 2) AS average_rating
             FROM requested_users
             LEFT JOIN user_ratings ON user_ratings.email = requested_users.email
             GROUP BY requested_users.email`,
            [proposerEmails]
        )
    ]);

    // Index lookup results by item ID and email so each listing can be enriched
    // without repeatedly scanning the result arrays.
    const itemTypes = new Map(typesResult.rows.map((row) => [row.item_id, row.type]));
    const averageRatings = new Map(
        ratingsResult.rows.map((row) => [row.email, row.average_rating])
    );

    // Participant emails are used internally; omit them from the API response.
    return rows.map((row) => {
        const {
            proposer_email,
            counterparty_email,
            ...listing // include all other fields from the original row
        } = row;
        return {
            ...listing,
            // A missing value means no matching subtype or no ratings yet.
            proposed_item_type: itemTypes.get(row.proposed_item_number) ?? null,
            desired_item_type: itemTypes.get(row.desired_item_number) ?? null,
            proposer_average_rating: averageRatings.get(proposer_email) ?? null
        };
    });
}

// The interactionRoutes function registers all swap-related API endpoints with the Fastify instance.
export async function interactionRoutes(fastify: FastifyInstance, options: { dbPool: Pool }) {
    // Show proposals addressed to the signed-in user that have not been decided yet.
    fastify.get('/api/v1/swaps/incoming', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        // Validate pagination parameters to ensure they are within acceptable ranges and types.
        const pagination = PaginationQuerySchema.safeParse(request.query);
        if (!pagination.success) {
            return reply.code(400).send({
                error: 'Validation Failed',
                details: z.flattenError(pagination.error)
            });
        }

        const { limit, offset } = pagination.data;
        try {
            // Use the base swap listing query to fetch incoming proposals for the authenticated user,
            // filtering by counterparty email and ensuring the proposal is still pending (accepted IS NULL).
            const result = await options.dbPool.query<SwapListingRow>(
                `${SwapListingSelect}
                 WHERE counterparty.email = $1 AND s.accepted IS NULL
                 ORDER BY s.date_proposed DESC, s.proposed_item_number DESC
                 LIMIT $2 OFFSET $3`,
                [email, limit, offset]
            );
            const swaps = await addSwapListingDetails(options.dbPool, result.rows);
            return reply.send({ swaps, pagination: { limit, offset } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to load incoming swap proposals.' });
        }
    });

    // Accepted swaps remain pending for a user until that participant submits a rating.
    fastify.get('/api/v1/swaps/ratings/pending', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        // Validate pagination parameters to ensure they are within acceptable ranges and types.
        const pagination = PaginationQuerySchema.safeParse(request.query);
        if (!pagination.success) {
            return reply.code(400).send({
                error: 'Validation Failed',
                details: z.flattenError(pagination.error)
            });
        }

        const { limit, offset } = pagination.data;
        try {
            // Use the base swap listing query to fetch accepted swaps for the authenticated user
            // that have not yet been rated by that participant, filtering by proposer or counterparty email.
            const result = await options.dbPool.query<SwapListingRow>(
                `${SwapListingSelect}
                 WHERE s.accepted IS TRUE
                   AND ((proposer.email = $1 AND s.proposer_rating IS NULL)
                     OR (counterparty.email = $1 AND s.counterparty_rating IS NULL))
                 ORDER BY s.date_accepted_rejected DESC, s.proposed_item_number DESC
                 LIMIT $2 OFFSET $3`,
                [email, limit, offset]
            );
            // Enrich the swap listings with item types and proposer average ratings 
            // before sending the response.
            const swaps = await addSwapListingDetails(options.dbPool, result.rows);
            return reply.send({ swaps, pagination: { limit, offset } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to load pending swap ratings.' });
        }
    });

    // Include accepted and rejected swaps in which the user participated.
    fastify.get('/api/v1/swaps/history', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        // Validate pagination parameters to ensure they are within acceptable ranges and types.
        const pagination = PaginationQuerySchema.safeParse(request.query);
        if (!pagination.success) {
            return reply.code(400).send({
                error: 'Validation Failed',
                details: z.flattenError(pagination.error)
            });
        }

        const { limit, offset } = pagination.data;
        try {
            // Use the base swap listing query to fetch all swaps for the authenticated user 
            // that have been decided (accepted IS NOT NULL),vfiltering by proposer or counterparty email, 
            // and ordering by the most recent decision date.
            const result = await options.dbPool.query<SwapListingRow>(
                `${SwapListingSelect}
                 WHERE (proposer.email = $1 OR counterparty.email = $1) AND s.accepted IS NOT NULL
                 ORDER BY COALESCE(s.date_accepted_rejected, s.date_proposed) DESC,
                          s.proposed_item_number DESC
                 LIMIT $2 OFFSET $3`,
                [email, limit, offset]
            );
            // Enrich the swap listings with item types and proposer average ratings 
            // before sending the response to ensure consistent data structure.
            const swaps = await addSwapListingDetails(options.dbPool, result.rows);
            return reply.send({ swaps, pagination: { limit, offset } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to load swap history.' });
        }
    });

    // Only the owner of the offered item may create a proposal, and self-swaps are rejected.
    fastify.post('/api/v1/swaps', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        const parseResult = SwapSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.code(400).send({
                error: 'Validation Failed',
                details: z.flattenError(parseResult.error)
            });
        }

        const swapData = parseResult.data;
        const client = await options.dbPool.connect();
        try {
            // Lock both item rows while validating ownership so they cannot be
            // reassigned or removed between the check and proposal insert.
            await client.query('BEGIN');
            const itemOwners = await client.query(
                `SELECT proposed.email AS proposer_email, desired.email AS counterparty_email
                 FROM items proposed
                 JOIN items desired ON desired.item_id = $2
                 WHERE proposed.item_id = $1
                 FOR SHARE OF proposed, desired`,
                [swapData.proposed_item_number, swapData.desired_item_number]
            );

            if (itemOwners.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'One or both items were not found.' });
            }
            if (itemOwners.rows[0].proposer_email !== email) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'You can only propose a swap using your own item.' });
            }
            if (itemOwners.rows[0].counterparty_email === email) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: 'You cannot propose a swap for your own item.' });
            }

            // Insert the new swap proposal into the database, returning the relevant fields for the response.
            const result = await client.query(
                `INSERT INTO swaps (proposed_item_number, desired_item_number, date_proposed)
                 VALUES ($1, $2, $3)
                 RETURNING proposed_item_number, desired_item_number, accepted, date_proposed`,
                [
                    swapData.proposed_item_number,
                    swapData.desired_item_number,
                    swapData.date_proposed
                ]
            );
            await client.query('COMMIT');
            return reply.code(201).send({ swap: result.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            fastify.log.error(error);
            if (isPostgresErrorCode(error, '23505')) {
                return reply.code(409).send({
                    error: 'A swap proposal already exists for this item combination.'
                });
            }
            if (isPostgresErrorCode(error, '23503')) {
                return reply.code(404).send({ error: 'One or both items were not found.' });
            }
            return reply.code(500).send({ error: 'Unable to create swap proposal.' });
        } finally {
            client.release();
        }
    });

    // Only the owner of the requested item may decide a still-pending proposal.
    fastify.patch('/api/v1/swaps/decision', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        const parseResult = SwapDecisionSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.code(400).send({
                error: 'Validation Failed',
                details: z.flattenError(parseResult.error)
            });
        }

        const { proposed_item_number, desired_item_number, accepted } = parseResult.data;
        const client = await options.dbPool.connect();
        try {
            await client.query('BEGIN');
            // Lock the swap row while checking participant identity and preventing concurrent decisions.
            // The join to the desired item ensures that only the owner of that item can decide the proposal.
            const swapResult = await client.query(
                `SELECT s.accepted, desired.email AS counterparty_email
                 FROM swaps s
                 JOIN items desired ON desired.item_id = s.desired_item_number
                 WHERE s.proposed_item_number = $1 AND s.desired_item_number = $2
                 FOR UPDATE OF s`,
                [proposed_item_number, desired_item_number]
            );

            if (swapResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'Swap proposal not found.' });
            }
            if (swapResult.rows[0].counterparty_email !== email) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'Only the recipient can decide this proposal.' });
            }
            if (swapResult.rows[0].accepted !== null) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'This proposal has already been decided.' });
            }

            // Update the swap decision in the database, setting the accepted status and 
            // recording the decision date.
            const result = await client.query(
                `UPDATE swaps
                 SET accepted = $1, date_accepted_rejected = CURRENT_DATE
                 WHERE proposed_item_number = $2 AND desired_item_number = $3
                 RETURNING proposed_item_number, desired_item_number, accepted, date_accepted_rejected`,
                [accepted, proposed_item_number, desired_item_number]
            );
            await client.query('COMMIT');
            return reply.send({ swap: result.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to record swap decision.' });
        } finally {
            client.release();
        }
    });

    // Each participant may submit one rating for an accepted swap.
    fastify.patch('/api/v1/swaps/rate', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        const parseResult = SwapRatingSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.code(400).send({
                error: 'Validation Failed',
                details: z.flattenError(parseResult.error)
            });
        }

        const { proposed_item_number, desired_item_number, role, rating } = parseResult.data;
        // The role is validated above, so this selects only one of the two known rating columns.
        const ratingColumn = role === 'proposer' ? 'proposer_rating' : 'counterparty_rating';
        const client = await options.dbPool.connect();
        try {
            await client.query('BEGIN');
            // Lock the swap while checking participant identity and preventing duplicate ratings.
            // The join to the proposed and desired items ensures that only the owner of the 
            // corresponding item can submit a rating.
            const swapResult = await client.query(
                `SELECT s.accepted, s.proposer_rating, s.counterparty_rating,
                        proposed.email AS proposer_email, desired.email AS counterparty_email
                 FROM swaps s
                 JOIN items proposed ON proposed.item_id = s.proposed_item_number
                 JOIN items desired ON desired.item_id = s.desired_item_number
                 WHERE s.proposed_item_number = $1 AND s.desired_item_number = $2
                 FOR UPDATE OF s`,
                [proposed_item_number, desired_item_number]
            );

            // Validate that the swap exists, is accepted, and that the authenticated user is 
            // the correct participant for the specified role.
            if (swapResult.rowCount === 0 || swapResult.rows[0].accepted !== true) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'Accepted swap not found.' });
            }
            const expectedEmail = role === 'proposer'
                ? swapResult.rows[0].proposer_email
                : swapResult.rows[0].counterparty_email;
            // Ensure that the authenticated user is the correct participant for the specified role.
            if (expectedEmail !== email) {
                await client.query('ROLLBACK');
                return reply.code(403).send({ error: 'You cannot submit a rating for the other participant.' });
            }
            if (swapResult.rows[0][ratingColumn] !== null) {
                await client.query('ROLLBACK');
                return reply.code(409).send({ error: 'You have already rated this swap.' });
            }

            // Update the swap rating in the database, setting the appropriate rating column 
            // for the participant's role.
            const result = await client.query(
                `UPDATE swaps
                 SET ${ratingColumn} = $1
                 WHERE proposed_item_number = $2 AND desired_item_number = $3
                 RETURNING proposed_item_number, desired_item_number, proposer_rating, counterparty_rating`,
                [rating, proposed_item_number, desired_item_number]
            );
            await client.query('COMMIT');
            return reply.send({ swap: result.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to save swap rating.' });
        } finally {
            client.release();
        }
    });
} 

// Check if the error is a PostgreSQL error with the specified code.
function isPostgresErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code;
}
