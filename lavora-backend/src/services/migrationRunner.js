/**
 * Database migration runner.
 *
 * Migrations live in /migrations/*.sql, named NNN_description.sql.
 * A schema_migrations table tracks which ones have been applied.
 * Running runMigrations() is safe to call on every startup — it only
 * applies migrations that haven't run yet, in order.
 *
 * Local dev (no DATABASE_URL): no-op — JSON files need no migrations.
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger').child('MIGRATE');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function runMigrations(pool) {
  if (!pool || !process.env.DATABASE_URL) {
    log.info('Migrations: skipped (local JSON mode)');
    return;
  }

  // Ensure the tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Load migration files sorted by filename (001_, 002_, ...)
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    log.info('Migrations: no migration files found');
    return;
  }

  // Fetch already-applied migrations
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map(r => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    log.info(`Applying migration: ${file}`);

    // Run migration + record it in a single transaction
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await pool.query('COMMIT');
      log.info(`Migration applied: ${file}`);
      count++;
    } catch (err) {
      await pool.query('ROLLBACK');
      log.error(`Migration FAILED: ${file} — ${err.message}`);
      throw err; // Halt startup — don't run the app with a broken schema
    }
  }

  if (count === 0) {
    log.info(`Migrations: all ${files.length} already applied`);
  } else {
    log.info(`Migrations: ${count} new migration(s) applied`);
  }
}

module.exports = { runMigrations };
