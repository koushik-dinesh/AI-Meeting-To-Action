// Tiny SQL migration runner: applies db/migrations/*.sql in filename order, once each.
// Usage: npm run migrate            (uses DB_NAME)
//        NODE_ENV=test npm run migrate   (uses DB_TEST_NAME)
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export async function migrate() {
  // Separate connection with multipleStatements; the app pool never enables it.
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum   CHAR(64) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    const [rows] = await conn.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      const sql = await readFile(MIGRATIONS_DIR + file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied. Add a new migration instead.`);
        }
        continue;
      }

      // MySQL DDL auto-commits, so a failed file may be partially applied; fix forward.
      await conn.query(sql);
      await conn.execute('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [file, checksum]);
      logger.info('migration applied', { file, database: config.db.database });
      count++;
    }
    logger.info('migrations complete', { applied: count, database: config.db.database });
    return count;
  } finally {
    await conn.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch((err) => {
    logger.error('migration failed', { error: err.message });
    process.exit(1);
  });
}
