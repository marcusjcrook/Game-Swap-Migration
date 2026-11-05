import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { getSessionEmail } from '../auth/session';
import {
    ItemCountsQuerySchema,
    ItemIdParamsSchema,
    ItemSchema,
    ItemSearchQuerySchema,
    ItemTypeSchema,
    ItemUpdateSchema,
    PcPlatformEnum
} from '../domain/item.schema';

// The CASE expression determines the item type based on which subtype table has a matching row for the item.
const ItemTypeCase = `
    CASE
        WHEN bg.item_id IS NOT NULL THEN 'boardGame'
        WHEN cg.item_id IS NOT NULL THEN 'cardGame'
        WHEN jp.item_id IS NOT NULL THEN 'jigsawPuzzle'
        WHEN pc.item_id IS NOT NULL THEN 'computerGame'
        WHEN vg.item_id IS NOT NULL THEN 'videoGame'
    END
`;

// The SELECT clause retrieves common item fields, type-specific fields, and owner information.
const ItemDetailsColumns = `
    i.item_id,
    i.title,
    i.condition,
    i.description,
    ${ItemTypeCase} AS type,
    jp.pieces,
    CASE
        WHEN pc.item_id IS NOT NULL THEN pc.platform::text
        WHEN vg.item_id IS NOT NULL THEN vg.platform
    END AS platform,
    vg.media,
    u.nickname AS owner_nickname,
    a.postal_code,
    a.city,
    a.state
`;

// The FROM clause joins the items table to the users and addresses tables to get owner information,
// and left joins the subtype tables to get type-specific fields. 
// Each item has a row in exactly one subtype table.
const ItemDetailsFrom = `
    FROM items i
    JOIN users u ON u.email = i.email
    JOIN addresses a ON a.postal_code = u.postal_code
    LEFT JOIN board_games bg ON bg.item_id = i.item_id
    LEFT JOIN card_games cg ON cg.item_id = i.item_id
    LEFT JOIN jigsaw_puzzles jp ON jp.item_id = i.item_id
    LEFT JOIN computer_games pc ON pc.item_id = i.item_id
    LEFT JOIN video_games vg ON vg.item_id = i.item_id
`;

const ItemDetailsSelect = `SELECT ${ItemDetailsColumns} ${ItemDetailsFrom}`;

// The Haversine formula calculates the great-circle distance between two points on a 
// sphere given their longitudes and latitudes.
// LEAST guards against floating-point rounding that can push the asin input above 1.
const ItemDistanceMiles = `
    ROUND((
        3958.75 * 2 * ASIN(SQRT(LEAST(1::double precision,
            POWER(SIN(RADIANS(a.latitude - origin.latitude) / 2), 2) +
            COS(RADIANS(origin.latitude)) * COS(RADIANS(a.latitude)) *
            POWER(SIN(RADIANS(a.longitude - origin.longitude) / 2), 2)
        )))
    )::numeric, 1)
`;

// This function extracts the session email from the request's cookie header.
function getSessionUserEmail(request: FastifyRequest): string | null {
    const cookieHeader = request.headers.cookie;
    return getSessionEmail(typeof cookieHeader === 'string' ? cookieHeader : undefined);
}

// This function checks if the provided field exists in the given object.
function hasField<K extends string>(
    fields: Record<string, unknown>,
    field: K
): boolean {
    // Use Object.hasOwn to check for the presence of the field in the object, 
    // which is safer than using the 'in' operator.
    return Object.hasOwn(fields, field);
}

// The main function that registers item-related routes with the Fastify instance.
export async function itemRoutes(fastify: FastifyInstance, options: { dbPool: Pool }) {
    // Return per-type counts for the requested account; this route does not return item records.
    fastify.get('/api/v1/items/counts', async (request, reply) => {
        const queryResult = ItemCountsQuerySchema.safeParse(request.query);
        // Validate the query parameters and return a 400 error if validation fails.
        if (!queryResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(queryResult.error)
            });
        }

        const { email } = queryResult.data;
        const result = await options.dbPool.query(
            `
           -- Each item has a row in exactly one subtype table; count those rows by category.
           SELECT
                COUNT(*) FILTER (WHERE bg.item_id IS NOT NULL) AS board_game_count,
                COUNT(*) FILTER (WHERE cg.item_id IS NOT NULL) AS card_game_count,
                COUNT(*) FILTER (WHERE vg.item_id IS NOT NULL) AS video_game_count,
                COUNT(*) FILTER (WHERE jp.item_id IS NOT NULL) AS puzzle_count,
                COUNT(*) FILTER (WHERE pc.item_id IS NOT NULL) AS computer_game_count
            FROM items i
            LEFT JOIN board_games bg ON bg.item_id = i.item_id
            LEFT JOIN card_games cg ON cg.item_id = i.item_id
            LEFT JOIN video_games vg ON vg.item_id = i.item_id
            LEFT JOIN jigsaw_puzzles jp ON jp.item_id = i.item_id
            LEFT JOIN computer_games pc ON pc.item_id = i.item_id
            WHERE i.email = $1;
            `,
            [email]
        );

        return reply.send({ items: result.rows });
    });

    // Get the authenticated user's items
    // Item ownership comes from the authenticated session, not a query parameter.
    fastify.get('/api/v1/items/mine', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }
        // Return the user's items in reverse chronological order by item ID, 
        // which is a proxy for creation time.
        try {
            const result = await options.dbPool.query(
                `${ItemDetailsSelect}
                 WHERE i.email = $1
                 ORDER BY i.item_id DESC`,
                [email]
            );
            return reply.send({ items: result.rows });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to load your items.' });
        }
    });

    // Search only listings available for a new proposal and rank results by distance.
    fastify.get('/api/v1/items/search', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        // Validate the query parameters and return a 400 error if validation fails.
        const queryResult = ItemSearchQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(queryResult.error)
            });
        }
 
        const {
            q, // The 'q' parameter is a general search term that can match item titles or descriptions.
            keyword, // An alternative search term that can also match item titles or descriptions.
            type,
            condition,
            postal_code,
            my_postal,
            miles,
            platform,
            limit,
            offset
        } = queryResult.data;
        // Use the first non-null search term from the query parameters, or null if none are provided.
        const searchTerm = q ?? keyword ?? null;
        try {
            const values: unknown[] = [email];
            const filters = [
                'i.email <> $1',
                // Pending and accepted proposals reserve an item; rejected ones do not.
                `NOT EXISTS (
                    SELECT 1
                    FROM swaps s
                    WHERE (s.proposed_item_number = i.item_id
                           OR s.desired_item_number = i.item_id)
                      AND s.accepted IS DISTINCT FROM FALSE
                )`
            ];
            // Add a parameter to the values array and return its placeholder for use in the SQL query.
            const addParameter = (value: unknown): string => {
                values.push(value);
                // The placeholder is 1-indexed for PostgreSQL, 
                // so return the length of the values array as the placeholder.
                return `$${values.length}`;
            };

            // Build placeholders alongside values so user input is never interpolated into SQL.
            // Use ILIKE for case-insensitive matching and COALESCE to treat null descriptions 
            // as empty strings.
            if (searchTerm) {
                const parameter = addParameter(`%${searchTerm}%`);
                filters.push(`(
                    i.title ILIKE ${parameter}
                    OR COALESCE(i.description, '') ILIKE ${parameter}
                )`);
            }
            // Add filters for type, condition, postal code, and distance if 
            // they are provided in the query parameters.
            if (type) filters.push(`${ItemTypeCase} = ${addParameter(type)}`);
            if (condition) filters.push(`i.condition::text = ${addParameter(condition)}`);
            if (postal_code) {
                filters.push(`a.postal_code = ${addParameter(postal_code)}`);
            } else if (my_postal) {
                filters.push('a.postal_code = origin.postal_code');
            }
            if (miles !== undefined) {
                filters.push(`${ItemDistanceMiles} <= ${addParameter(miles)}`);
            }
            if (platform) {
                const parameter = addParameter(platform);
                filters.push(`(pc.platform::text = ${parameter} OR vg.platform = ${parameter})`);
            }

            const limitParameter = addParameter(limit);
            const offsetParameter = addParameter(offset);

            // The query uses a CTE (Common Table Expression) to retrieve the user's search location once,
            // and then cross joins it with the candidate items to calculate distances.
            const result = await options.dbPool.query(
                `WITH searcher AS (
                    SELECT home.postal_code, home.latitude, home.longitude
                    FROM users search_account
                    JOIN addresses home ON home.postal_code = search_account.postal_code
                    WHERE search_account.email = $1
                 )
                 SELECT ${ItemDetailsColumns},
                        ${ItemDistanceMiles} AS distance_miles
                 ${ItemDetailsFrom}
                 CROSS JOIN searcher origin
                 WHERE ${filters.join('\n                   AND ')}
                 ORDER BY distance_miles ASC, i.item_id ASC
                 LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
                values
            );
            return reply.send({
                items: result.rows,
                pagination: { limit, offset }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to search items.' });
        }
    });

    // Get the details of a specific item by its ID, including distance and owner rating.
    // Listing details are visible only to signed-in users and include owner context.
    fastify.get('/api/v1/items/:itemId', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        // Validate the item ID parameter and return a 400 error if validation fails.
        const paramsResult = ItemIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(paramsResult.error)
            });
        }

        try {
            // Load the item details along with the distance from the viewer's location 
            // and the owner's average rating.
            // The distance is calculated using the Haversine formula, and the average rating is computed
            // from the ratings in the swaps table for all accepted swaps involving the owner.
            const result = await options.dbPool.query(
                `-- Load the viewer's saved coordinates once for the distance calculation.
                 WITH viewer AS (
                    SELECT home.latitude, home.longitude
                    FROM users viewing_user
                    JOIN addresses home ON home.postal_code = viewing_user.postal_code
                    WHERE viewing_user.email = $1
                 )
                 SELECT ${ItemDetailsColumns},
                        ${ItemDistanceMiles} AS distance_miles,
                        -- The viewer's own items do not have an owner rating.
                        CASE WHEN i.email = $1 THEN NULL
                             ELSE (
                                 SELECT ROUND(AVG(CASE
                                     WHEN proposed.email = i.email THEN s.proposer_rating
                                     WHEN desired.email = i.email THEN s.counterparty_rating
                                 END), 2)
                                 FROM swaps s
                                 JOIN items proposed ON proposed.item_id = s.proposed_item_number
                                 JOIN items desired ON desired.item_id = s.desired_item_number
                                 WHERE s.accepted IS TRUE
                                   AND (proposed.email = i.email OR desired.email = i.email)
                             )
                        END AS owner_average_rating
                 ${ItemDetailsFrom}
                 -- Attach the viewer's coordinates to each candidate item for distance calculation.
                 CROSS JOIN viewer origin
                 WHERE i.item_id = $2`,
                [email, paramsResult.data.itemId]
            );
            if (result.rowCount === 0) {
                return reply.code(404).send({ error: 'Item not found.' });
            }
            return reply.send({ item: result.rows[0] });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to load item.' });
        }
    });

    // Create a new item listing for the authenticated user.
    // A type-specific table stores fields that do not apply to every item category.
    fastify.post('/api/v1/items', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        const parseResult = ItemSchema.safeParse(request.body);

        if (!parseResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(parseResult.error)
            });
        }

        const itemData = parseResult.data;
        if (itemData.email !== email) {
            return reply.code(403).send({ error: 'You can only create items for your own account.' });
        }

        const client = await options.dbPool.connect();

        // Use a transaction to ensure that the item and its subtype row are created together.
        try {
            await client.query('BEGIN');
            const itemRes = await client.query(
                `INSERT INTO items (title, condition, description, email)
                 VALUES ($1, $2, $3, $4)
                 RETURNING item_id`,
                [itemData.title, itemData.condition, itemData.description ?? null, itemData.email]
            );
            const itemID = itemRes.rows[0].item_id;

            // Insert a row into the appropriate subtype table based on the item type.
            if (itemData.type === 'boardGame') {
                await client.query('INSERT INTO board_games (item_id) VALUES ($1)', [itemID]);
            } else if (itemData.type === 'cardGame') {
                await client.query('INSERT INTO card_games (item_id) VALUES ($1)', [itemID]);
            } else if (itemData.type === 'jigsawPuzzle') {
                await client.query(
                    'INSERT INTO jigsaw_puzzles (item_id, pieces) VALUES ($1, $2)',
                    [itemID, itemData.pieces]
                );
            } else if (itemData.type === 'computerGame') {
                await client.query(
                    'INSERT INTO computer_games (item_id, platform) VALUES ($1, $2)',
                    [itemID, itemData.platform]
                );
            } else if (itemData.type === 'videoGame') {
                await client.query(
                    'INSERT INTO video_games (item_id, media, platform) VALUES ($1, $2, $3)',
                    [itemID, itemData.media, itemData.platform]
                );
            }

            await client.query('COMMIT');
            return reply.status(201).send({
                itemID,
                type: itemData.type,
                status: 'Item created successfully'
            });
        } catch (error) {
            await client.query('ROLLBACK');
            fastify.log.error(error);
            if (isPostgresErrorCode(error, '23503')) {
                return reply.code(409).send({
                    error: 'Foreign key check failed. Verify user or platform exists.'
                });
            }
            return reply.code(500).send({ error: 'Failed to create item.' });
        } finally {
            client.release();
        }
    });

    // Update an existing item listing for the authenticated user.
    // Updates may change common fields and fields specific to the item's type. 
    // The item type itself cannot be changed.
    fastify.patch('/api/v1/items/:itemId', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        // Validate the item ID parameter and return a 400 error if validation fails.
        const paramsResult = ItemIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(paramsResult.error)
            });
        }

        // Validate the request body against the update schema and return a 400 error if validation fails.
        const bodyResult = ItemUpdateSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(bodyResult.error)
            });
        }

        const updates = bodyResult.data;
        const client = await options.dbPool.connect();
        try {
            await client.query('BEGIN');
            // Lock the owned item row to prevent concurrent updates from overwriting each other.
            const lockedItemResult = await client.query(
                `SELECT i.item_id
                 FROM items i
                 WHERE i.item_id = $1 AND i.email = $2
                 FOR UPDATE`,
                [paramsResult.data.itemId, email]
            );

            if (lockedItemResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return reply.code(404).send({ error: 'Item not found.' });
            }

            // Determine the item type to validate that any type-specific fields 
            // in the update match the existing item.
            const itemResult = await client.query(
                `SELECT ${ItemTypeCase} AS type
                 FROM items i
                 LEFT JOIN board_games bg ON bg.item_id = i.item_id
                 LEFT JOIN card_games cg ON cg.item_id = i.item_id
                 LEFT JOIN jigsaw_puzzles jp ON jp.item_id = i.item_id
                 LEFT JOIN computer_games pc ON pc.item_id = i.item_id
                 LEFT JOIN video_games vg ON vg.item_id = i.item_id
                 WHERE i.item_id = $1`,
                [paramsResult.data.itemId]
            );
            // The item type is guaranteed to be one of the enum values 
            // because the database schema enforces that each item has 
            // a row in exactly one subtype table.
            const itemType = ItemTypeSchema.parse(itemResult.rows[0].type);
            const hasPieces = hasField(updates, 'pieces');
            const hasPlatform = hasField(updates, 'platform');
            const hasMedia = hasField(updates, 'media');
            const hasSubtypeFields = hasPieces || hasPlatform || hasMedia;
            const allowedSubtypeFields =
                !hasSubtypeFields ||
                (itemType === 'jigsawPuzzle' && hasPieces && !hasPlatform && !hasMedia) ||
                (itemType === 'computerGame' && hasPlatform && !hasPieces && !hasMedia) ||
                (itemType === 'videoGame' && !hasPieces);

            if (!allowedSubtypeFields) {
                await client.query('ROLLBACK');
                return reply.code(400).send({
                    error: 'Provided type-specific fields do not match this item type.'
                });
            }
            // Validate that the platform value is one of the allowed enum values for computer games.
            if (
                itemType === 'computerGame' &&
                updates.platform !== undefined &&
                !PcPlatformEnum.safeParse(updates.platform).success
            ) {
                await client.query('ROLLBACK');
                return reply.code(400).send({
                    error: 'Computer game platform must be Linux, macOS, or Windows.'
                });
            }

            // Update only the fields that are present in the request body. 
            // The common item fields are updated in a single query, while 
            // type-specific fields are updated in separate queries.
            const commonUpdates: Array<[string, unknown]> = [];
            if (updates.title !== undefined) commonUpdates.push(['title', updates.title]);
            if (updates.condition !== undefined) commonUpdates.push(['condition', updates.condition]);
            if (updates.description !== undefined) commonUpdates.push(['description', updates.description]);

            if (commonUpdates.length > 0) {
                // Column names come only from the fixed update schema; values remain parameterized.
                const assignments = commonUpdates.map(([field], index) => `${field} = $${index + 1}`);
                const values = commonUpdates.map(([, value]) => value);
                values.push(paramsResult.data.itemId, email);
                await client.query(
                    `UPDATE items
                     SET ${assignments.join(', ')}
                     WHERE item_id = $${values.length - 1} AND email = $${values.length}`,
                    values
                );
            }

            //  Update type-specific fields in their respective subtype tables based on the item type.
            if (itemType === 'jigsawPuzzle' && updates.pieces !== undefined) {
                await client.query(
                    'UPDATE jigsaw_puzzles SET pieces = $1 WHERE item_id = $2',
                    [updates.pieces, paramsResult.data.itemId]
                );
            } else if (itemType === 'computerGame' && updates.platform !== undefined) {
                await client.query(
                    'UPDATE computer_games SET platform = $1 WHERE item_id = $2',
                    [updates.platform, paramsResult.data.itemId]
                );
            } else if (itemType === 'videoGame') {
                if (updates.platform !== undefined) {
                    await client.query(
                        'UPDATE video_games SET platform = $1 WHERE item_id = $2',
                        [updates.platform, paramsResult.data.itemId]
                    );
                }
                if (updates.media !== undefined) {
                    await client.query(
                        'UPDATE video_games SET media = $1 WHERE item_id = $2',
                        [updates.media, paramsResult.data.itemId]
                    );
                }
            }

            // After the updates, retrieve the updated item details to return in the response.
            const updatedResult = await client.query(
                `${ItemDetailsSelect} WHERE i.item_id = $1`,
                [paramsResult.data.itemId]
            );
            await client.query('COMMIT');
            return reply.send({ item: updatedResult.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            fastify.log.error(error);
            if (isPostgresErrorCode(error, '23503')) {
                return reply.code(409).send({ error: 'Provided platform does not exist.' });
            }
            return reply.code(500).send({ error: 'Unable to update item.' });
        } finally {
            client.release();
        }
    });

    // Cascading foreign keys remove subtype and swap rows associated with a deleted item.
    fastify.delete('/api/v1/items/:itemId', async (request, reply) => {
        const email = getSessionUserEmail(request);
        if (!email) {
            return reply.code(401).send({ error: 'Authentication required.' });
        }

        const paramsResult = ItemIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({
                error: 'Validation Failed',
                details: z.flattenError(paramsResult.error)
            });
        }

        // Delete the item if it exists and belongs to the authenticated user.
        try {
            const result = await options.dbPool.query(
                'DELETE FROM items WHERE item_id = $1 AND email = $2 RETURNING item_id',
                [paramsResult.data.itemId, email]
            );
            if (result.rowCount === 0) {
                return reply.code(404).send({ error: 'Item not found.' });
            }
            return reply.code(204).send();
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Unable to delete item.' });
        }
    });
}

// This function checks if the provided error object is a PostgreSQL error with the specified error code.
function isPostgresErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code;
}
