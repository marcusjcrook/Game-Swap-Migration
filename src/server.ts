import Fastify from 'fastify';
import { Pool } from 'pg';
import { userRoutes } from './routes/user.routes';
import { itemRoutes } from './routes/item.routes';
import { interactionRoutes } from './routes/interaction.routes';

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be configured before starting the API.`);
  }
  return value;
}

const sessionSecret = getRequiredEnvironmentVariable('SESSION_SECRET');
if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
}

const databasePort = Number(process.env.PGPORT ?? 5432);
if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535) {
  throw new Error('PGPORT must be a valid TCP port number.');
}

const fastify = Fastify({ logger: true });

const dbPool = new Pool({
  host: getRequiredEnvironmentVariable('PGHOST'),
  port: databasePort,
  user: getRequiredEnvironmentVariable('PGUSER'),
  password: getRequiredEnvironmentVariable('PGPASSWORD'),
  database: getRequiredEnvironmentVariable('PGDATABASE'),
  max: 20,
  idleTimeoutMillis: 30000,
});

// Health check endpoint to verify that the server is running and responsive.
fastify.get('/', async () => ({
  name: 'Game Swap Migration API',
  status: 'ok',
  endpoints: [
    'POST /api/v1/users',
    'POST /api/v1/items',
    'GET /api/v1/items/counts',
    'POST /api/v1/swaps',
    'PATCH /api/v1/swaps/decision',
    'PATCH /api/v1/swaps/rate',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/logout',
    'GET /api/v1/users/me',
    'PATCH /api/v1/users/me',
    'GET /api/v1/dashboard',
    'GET /api/v1/items/mine',
    'GET /api/v1/items/search',
    'GET /api/v1/items/:itemId',
    'PATCH /api/v1/items/:itemId',
    'DELETE /api/v1/items/:itemId',
    'GET /api/v1/swaps/incoming',
    'GET /api/v1/swaps/ratings/pending',
    'GET /api/v1/swaps/history'
  ]
}));

fastify.get('/health', async () => ({ status: 'ok' }));

// Register route modules with the Fastify instance, passing the database pool for database operations.
fastify.register(userRoutes, { dbPool });
fastify.register(itemRoutes, { dbPool });
fastify.register(interactionRoutes, { dbPool });

// Start the Fastify server and listen on the specified port and host. 
// Log the server status or any errors encountered during startup.
const start = async () => {
  try {
    await fastify.listen({ port: 4000, host: '0.0.0.0' });
    console.log('Fastify Migration Server live on http://localhost:4000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown on SIGINT (Ctrl+C) signal. Close database pools and the Fastify server before exiting.
process.on('SIGINT', async () => {
  fastify.log.info('Graceful shutdown initiated. Closing database pools...');
  await dbPool.end();
  await fastify.close();
  process.exit(0);
});

start();
