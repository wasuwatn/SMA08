// Self-contained pre-deploy smoke test: spins up a throwaway local Postgres
// and the hub API against it, runs the HTTP assertion suite in checks.mjs,
// then tears both down. No external DB or manually-started server needed —
// run with `npm test` from server/.
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { runChecks } from './checks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..');
const PG_DATA_DIR = path.join(__dirname, '.pgdata-test'); // gitignored, wiped each run
const PG_PORT = 55432; // unlikely to collide with a real local Postgres on 5432
const API_PORT = 4099; // avoid colliding with `npm run dev`'s :4000

async function waitForServer(baseUrl, exitedEarly) {
  for (let i = 0; i < 40; i++) {
    if (exitedEarly.happened) throw new Error(`Server exited before it came up:\n${exitedEarly.output}`);
    try {
      await fetch(baseUrl + '/api/tables');
      return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become reachable within 20s');
}

async function main() {
  await rm(PG_DATA_DIR, { recursive: true, force: true }); // start from a clean slate every run

  console.log('Starting ephemeral test Postgres...');
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DATA_DIR, user: 'postgres', password: 'test', port: PG_PORT, persistent: false
  });
  await pg.initialise();
  await pg.start();

  console.log('Starting hub API against it...');
  const server = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:test@localhost:${PG_PORT}/postgres`,
      JWT_SECRET: 'test-secret-not-for-production',
      PGSSLMODE: 'disable',
      PORT: String(API_PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exitedEarly = { happened: false, output: '' };
  server.stdout.on('data', (d) => { exitedEarly.output += d; });
  server.stderr.on('data', (d) => { exitedEarly.output += d; });
  server.once('exit', (code) => { if (code !== null) exitedEarly.happened = true; });

  const baseUrl = `http://localhost:${API_PORT}`;
  let result = { pass: 0, fail: 1 };
  try {
    await waitForServer(baseUrl, exitedEarly);
    result = await runChecks(baseUrl);
  } catch (e) {
    console.error(e);
  } finally {
    server.kill();
    await pg.stop();
    await rm(PG_DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n==== ${result.pass} passed, ${result.fail} failed ====`);
  process.exit(result.fail ? 1 : 0);
}

main();
