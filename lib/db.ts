import mysql, { Pool, PoolOptions } from "mysql2/promise";

const requiredEnvKeys = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
] as const;

function getRequiredEnv(key: (typeof requiredEnvKeys)[number]): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required database environment variable: ${key}`);
  }

  return value;
}

function createPoolConfig(): PoolOptions {
  const port = Number(getRequiredEnv("DB_PORT"));

  if (Number.isNaN(port)) {
    throw new Error("DB_PORT must be a valid number");
  }

  return {
    host: getRequiredEnv("DB_HOST"),
    port,
    user: getRequiredEnv("DB_USER"),
    password: getRequiredEnv("DB_PASSWORD"),
    database: getRequiredEnv("DB_NAME"),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4",
  };
}

export const dbPool: Pool = mysql.createPool(createPoolConfig());

export async function closeDbPool(): Promise<void> {
  await dbPool.end();
}

export default dbPool;
