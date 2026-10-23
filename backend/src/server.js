import { createApp } from './app.js';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { logger } from './utils/logger.js';

// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback.
const server = createApp().listen(config.port, (err) => {
  if (err) {
    const hint = err.code === 'EADDRINUSE' ? ` Port ${config.port} is already in use; stop the other process or set PORT.` : '';
    logger.error(`api failed to start.${hint}`, { error: err.message, code: err.code });
    process.exit(1);
  }
  logger.info('api listening', { port: config.port, env: config.env, database: config.db.database });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
