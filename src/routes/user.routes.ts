import { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password';
import { 
  UserLoginSchema, 
  UserRegistrationSchema, 
  UserResponseSchema,
  ProfileUpdateSchema
} from '../domain/user.schema';
import {
  createClearedSessionCookie,
  createSessionCookie,
  createSessionToken,
  getSessionEmail
} from '../auth/session';

// Extracts the email from a signed session cookie, if present and valid.
function getSessionUserEmail(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  return getSessionEmail(typeof cookieHeader === 'string' ? cookieHeader : undefined);
}

// Formats a database row into a user response object, validating it against the UserResponseSchema.
function formatUserResponse(row: {
  email: string;
  first_name: string;
  last_name: string;
  nickname: string;
  postal_code: string;
  phone_number: string | null;
  phone_type: 'Home' | 'Mobile' | 'Work' | null;
  phone_shareable: boolean | null;
}) {
  return UserResponseSchema.parse({
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    nickname: row.nickname,
    postal_code: row.postal_code,
    phone: row.phone_number === null ? null : {
      phone_number: row.phone_number,
      type: row.phone_type,
      shareable: row.phone_shareable
    }
  });
}

// Extracts PostgreSQL error details, specifically the error code and constraint name,
// to facilitate more precise error handling in the application.
function getPostgresError(error: unknown): { code?: string; constraint?: string } {
  if (!(error instanceof Error)) return {};

  return {
    code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
    constraint: 'constraint' in error && typeof error.constraint === 'string'
      ? error.constraint
      : undefined
  };
}

// Defines the user-related routes for the Fastify application, 
// including authentication, profile management, and dashboard summary.
export async function userRoutes(fastify: FastifyInstance, options: { dbPool: Pool }) {
  // Verify credentials and issue a signed session cookie after a successful login.
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const parseResult = UserLoginSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Failed',
        details: z.flattenError(parseResult.error)
      });
    }

    const { email, password } = parseResult.data;
    const client = await options.dbPool.connect();

    // Use a transaction to ensure atomicity of the login process, 
    // including password verification and potential hash upgrade.
    try {
      await client.query('BEGIN');
      // Lock the row while checking/upgrading a legacy password to prevent
      // concurrent logins from overwriting each other's credential updates.
      const result = await client.query(
        `SELECT email, password_hash, first_name, last_name, nickname, postal_code
         FROM users
         WHERE email = $1
         FOR UPDATE`,
        [email]
      );
      const user = result.rows[0];

      if (!user) {
        await client.query('ROLLBACK');
        return reply.code(401).send({ error: 'Invalid email or password.' });
      }

      // Verify the provided password against the stored hash or legacy plaintext value.
      const passwordResult = await verifyPassword(password, user.password_hash);
      if (!passwordResult.valid) {
        await client.query('ROLLBACK');
        return reply.code(401).send({ error: 'Invalid email or password.' });
      }

      // Upgrade the password hash if it was previously stored in plaintext
      if (passwordResult.needsUpgrade) {
        // Upgrade legacy plaintext credentials immediately after successful
        // verification; later logins use the stronger scrypt representation.
        const passwordHash = await hashPassword(password);
        await client.query(
          'UPDATE users SET password_hash = $1 WHERE email = $2',
          [passwordHash, email]
        );
      }

      // Retrieve the user's phone information, if any, to include in the response.
      const phoneResult = await client.query(
        `SELECT phone_number, type, shareable
         FROM phones
         WHERE email = $1`,
        [email]
      );
      const phone = phoneResult.rows[0];

      // Create a signed session token and set it in a secure, HTTP-only cookie for the client.
      const sessionToken = createSessionToken(user.email);
      // Prepare the response data according to the defined schema, excluding sensitive information.
      const responseData = formatUserResponse({
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        nickname: user.nickname,
        postal_code: user.postal_code,
        phone_number: phone?.phone_number ?? null,
        phone_type: phone?.type ?? null,
        phone_shareable: phone?.shareable ?? null
      });

      await client.query('COMMIT');
      return reply
        .code(200)
        .header('Set-Cookie', createSessionCookie(sessionToken))
        .send({ user: responseData });
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Unable to complete login.' });
    } finally {
      client.release();
    }
  });

  // Expire the browser cookie; stateless tokens remain valid until expiry if copied elsewhere.
  fastify.post('/api/v1/auth/logout', async (_request, reply) =>
    reply.code(200).header('Set-Cookie', createClearedSessionCookie()).send({ status: 'ok' })
  );

  // Retrieve the authenticated user's profile information based on the session cookie.
  fastify.get('/api/v1/users/me', async (request, reply) => {
    const email = getSessionUserEmail(request);
    if (!email) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }

    // Query the database for the user's profile information using their email from the session.
    const result = await options.dbPool.query(
      `SELECT u.email, u.first_name, u.last_name, u.nickname, u.postal_code,
              p.phone_number, p.type AS phone_type, p.shareable AS phone_shareable
       FROM users u
       LEFT JOIN phones p ON p.email = u.email
       WHERE u.email = $1`,
      [email]
    );

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'User not found.' });
    }

    // Return the user's profile information, validated against the response schema, 
    // to ensure consistent structure and types.
    return reply.send(formatUserResponse(result.rows[0]));
  });

  // Update only fields explicitly allowed by the profile schema.
  fastify.patch('/api/v1/users/me', async (request, reply) => {
    const email = getSessionUserEmail(request);
    if (!email) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }

    // Validate the request body against the ProfileUpdateSchema to ensure only allowed fields are updated.
    const parseResult = ProfileUpdateSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Failed',
        details: z.flattenError(parseResult.error)
      });
    }

    // Destructure the phone field from the validated data, separating it from other profile updates.
    const { phone, ...profileUpdates } = parseResult.data;
    const client = await options.dbPool.connect();

    // Use a transaction to ensure atomicity of the profile update process, 
    // including potential phone number changes.
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        'SELECT email FROM users WHERE email = $1 FOR UPDATE',
        [email]
      );

      // If the user does not exist, roll back the transaction and return a 404 error.
      if (userResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'User not found.' });
      }

      // Dynamically construct the SQL update statement based on the provided profile updates.
      const fields = Object.keys(profileUpdates);
      if (fields.length > 0) {
        const values = Object.values(profileUpdates);
        const assignments = fields.map((field, index) => `${field} = $${index + 1}`);
        values.push(email);
        await client.query(
          `UPDATE users
           SET ${assignments.join(', ')}
           WHERE email = $${values.length}`,
          values
        );
      }

      // Handle phone number updates: delete existing phone record if present, and insert new one if provided.
      if (Object.hasOwn(parseResult.data, 'phone')) {
        await client.query('DELETE FROM phones WHERE email = $1', [email]);
        if (phone) {
          await client.query(
            `INSERT INTO phones (phone_number, type, shareable, email)
             VALUES ($1, $2, $3, $4)`,
            [phone.phone_number, phone.type, phone.shareable, email]
          );
        }
      }

      // After updating the user's profile and phone information, retrieve the updated 
      // data to return in the response.
      const result = await client.query(
        `SELECT u.email, u.first_name, u.last_name, u.nickname, u.postal_code,
                p.phone_number, p.type AS phone_type, p.shareable AS phone_shareable
         FROM users u
         LEFT JOIN phones p ON p.email = u.email
         WHERE u.email = $1`,
        [email]
      );
      const responseData = formatUserResponse(result.rows[0]);
      await client.query('COMMIT');
      return reply.send(responseData);
    } catch (dbError) {
      await client.query('ROLLBACK');
      fastify.log.error(dbError);
      const { code, constraint } = getPostgresError(dbError);
      if (code === '23503') {
        return reply.status(409).send({ error: 'Provided postal code does not exist.' });
      }
      if (code === '23505' && constraint === 'phones_pkey') {
        return reply.status(409).send({ error: 'Phone number already registered.' });
      }
      return reply.status(500).send({ error: 'Unable to update profile.' });
    } finally {
      client.release();
    }
  });

  // Summarize rating and action counts from swaps involving the current user.
  fastify.get('/api/v1/dashboard', async (request, reply) => {
    const email = getSessionUserEmail(request);
    if (!email) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }

    // Query the database to calculate the average rating, unaccepted swaps, 
    // overdue swaps, and unrated swaps for the authenticated user.
    try {
      // Use a single query with conditional aggregation to compute the summary statistics efficiently.
      const summaryResult = await options.dbPool.query(
        `SELECT
           ROUND(AVG(CASE
             WHEN i.email = $1 THEN s.proposer_rating
             WHEN j.email = $1 THEN s.counterparty_rating
           END) FILTER (WHERE s.accepted IS TRUE), 2) AS average_rating,
           COUNT(*) FILTER (WHERE j.email = $1 AND s.accepted IS NULL) AS unaccepted_swaps,
           COUNT(*) FILTER (
             WHERE j.email = $1
               AND s.accepted IS NULL
               AND s.date_proposed < CURRENT_DATE - INTERVAL '5 days'
           ) AS overdue_swaps,
           COUNT(*) FILTER (WHERE (i.email = $1 AND s.proposer_rating IS NULL AND s.accepted IS TRUE)
             OR (j.email = $1 AND s.counterparty_rating IS NULL AND s.accepted IS TRUE)) AS unrated_swaps
         FROM swaps s
         JOIN items i ON i.item_id = s.proposed_item_number
         JOIN items j ON j.item_id = s.desired_item_number
         WHERE i.email = $1 OR j.email = $1;`,
        [email]
      );

      const summary = summaryResult.rows[0] ?? {};
      // Return the computed summary statistics, ensuring that null values are 
      // handled appropriately for the response.
      return reply.send({
        average_rating: summary.average_rating ?? null,
        unaccepted_swaps: Number(summary.unaccepted_swaps ?? 0),
        overdue_swaps: Number(summary.overdue_swaps ?? 0),
        unrated_swaps: Number(summary.unrated_swaps ?? 0)
      });
    } catch (dbError) {
      fastify.log.error(dbError);
      return reply.code(500).send({ error: 'Unable to load dashboard.' });
    }
  });

  // Create a new account with a one-way password hash.
  fastify.post('/api/v1/users', async (request, reply) => {
    const parseResult = UserRegistrationSchema.safeParse(request.body);
    
    if (!parseResult.success) {
      return reply.status(400).send({ 
        error: "Validation Failed", 
        details: z.flattenError(parseResult.error)
      });
    }

    const { email, password, first_name, last_name, nickname, postal_code, phone } = parseResult.data;
    const client = await options.dbPool.connect();
    try {
      // Store only the derived password hash; the submitted password is never persisted.
      const passwordHash = await hashPassword(password);
      await client.query('BEGIN');
      const queryText = `
        INSERT INTO users (email, password_hash, first_name, last_name, nickname, postal_code)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING email, first_name, last_name, nickname, postal_code;
      `;
      const values = [email, passwordHash, first_name, last_name, nickname, postal_code];
      
      const dbResult = await client.query(queryText, values);
      const createdUser = dbResult.rows[0];

      // If a phone number is provided during registration, insert it into the phones table.
      if (phone) {
        await client.query(
          `INSERT INTO phones (phone_number, type, shareable, email)
           VALUES ($1, $2, $3, $4)`,
          [phone.phone_number, phone.type, phone.shareable, email]
        );
      }

      // Prepare the response data according to the UserResponseSchema, 
      // ensuring that the structure and types are validated before 
      // sending it back to the client.
      const responseData = UserResponseSchema.parse({
        email: createdUser.email,
        first_name: createdUser.first_name,
        last_name: createdUser.last_name,
        nickname: createdUser.nickname,
        postal_code: createdUser.postal_code,
        phone: phone ?? null
      });

      await client.query('COMMIT');
      return reply.status(201).send(responseData);
    } catch (dbError) {
      await client.query('ROLLBACK');
      fastify.log.error(dbError);
      const { code, constraint } = getPostgresError(dbError);
      if (code === '23503') {
        return reply.status(409).send({ error: "Provided postal code does not exist." });
      }
      if (code === '23505' && constraint === 'phones_pkey') {
        return reply.status(409).send({ error: 'Phone number already registered.' });
      }
      if (code === '23505') {
        return reply.status(409).send({ error: "User already exists inside target schema." });
      }
      
      return reply.status(500).send({ error: "Internal Database Execution Error" });
    } finally {
      client.release();
    }
  });
}