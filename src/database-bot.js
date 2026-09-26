import mysql from 'mysql2/promise';

let botPoolInstance = null;

export function getBotDatabasePool() {
  if (botPoolInstance) return botPoolInstance;

  const required = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  if (required.some((name) => !process.env[name])) return null;

  botPoolInstance = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number.parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10_000,
  });

  return botPoolInstance;
}

export async function closeBotDatabasePool() {
  if (botPoolInstance) {
    const pool = botPoolInstance;
    botPoolInstance = null;
    await pool.end();
  }
}