import mysql from 'mysql2/promise';

let poolInstance = null;
let sitePoolInstance = null;

export function getDatabasePool() {
  if (poolInstance) return poolInstance;

  const required = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  if (required.some((name) => !process.env[name])) return null;

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

  const required = ['SITE_MYSQL_HOST', 'SITE_MYSQL_USER', 'SITE_MYSQL_PASSWORD', 'SITE_MYSQL_DATABASE'];
  if (required.some((name) => !process.env[name])) return null;

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

export function createDatabasePool() {
  return getDatabasePool();
}

export function createSiteDatabasePool() {
  return getSiteDatabasePool();
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
