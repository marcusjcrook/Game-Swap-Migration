const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (!process.env.DATABASE_INTEGRATION_URL) {
  console.error('Set DATABASE_INTEGRATION_URL to a disposable PostgreSQL database before running integration tests.');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'test/integration'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
