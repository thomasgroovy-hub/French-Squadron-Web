import mysql from 'mysql2/promise';

let poolInstance = null;
let sitePoolInstance = null;

const MAIN_DATABASE_VARS = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
const SITE_DATABASE_VARS = ['SITE_MYSQL_HOST', 'SITE_MYSQL_USER', 'SITE_MYSQL_PASSWORD', 'SITE_MYSQL_DATABASE'];

/** A variable left unset *or* set to an empty string both count as missing. */
export function findMissingEnv(names) {
  return names.filter((name) => !process.env[name]);
}

function describeMissingDatabase(label, missing) {
  return new Error(
    `Missing required environment variables for the ${label} database: ${missing.join(', ')}. `
    + 'Set them in your host environment (Render dashboard > Environment). '
    + 'A variable set to an empty string counts as missing.',
  );
}

/**
 * Stable per-database identity, used to cache one-time schema initialization.
 * Tolerates a missing or partial pool so callers fail with an actionable
 * message instead of a `TypeError` on `null.config`.
 */
export function getPoolKey(pool) {
  const config = pool?.config || pool?._config || {};
  return `${config.host ?? 'unknown-host'}:${config.database ?? 'unknown-database'}`;
}

export function getDatabasePool() {
  if (poolInstance) return poolInstance;

  const missing = findMissingEnv(MAIN_DATABASE_VARS);
  if (missing.length > 0) throw describeMissingDatabase('main', missing);

  poolInstance = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number.parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10_000,
  });

  return poolInstance;
}

export function getSiteDatabasePool() {
  if (sitePoolInstance) return sitePoolInstance;

  const missing = findMissingEnv(SITE_DATABASE_VARS);
  if (missing.length > 0) throw describeMissingDatabase('site', missing);

  sitePoolInstance = mysql.createPool({
    host: process.env.SITE_MYSQL_HOST,
    port: Number.parseInt(process.env.SITE_MYSQL_PORT || '3306', 10),
    user: process.env.SITE_MYSQL_USER,
    password: process.env.SITE_MYSQL_PASSWORD,
    database: process.env.SITE_MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10_000,
  });

  return sitePoolInstance;
}

export async function closeDatabasePool() {
  if (poolInstance) {
    const pool = poolInstance;
    poolInstance = null;
    await pool.end();
  }
  if (sitePoolInstance) {
    const pool = sitePoolInstance;
    sitePoolInstance = null;
    await pool.end();
  }
}
