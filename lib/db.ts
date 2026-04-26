import mysql, { Pool, PoolOptions, RowDataPacket } from "mysql2/promise";

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
    connectTimeout: 15000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };
}

export const dbPool: Pool = mysql.createPool(createPoolConfig());

type DbErrorLike = {
  code?: string;
  errno?: number;
  message?: string;
};

function isTransientDbError(error: unknown): boolean {
  const dbError = error as DbErrorLike | undefined;
  const code = dbError?.code ?? "";
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "PROTOCOL_SEQUENCE_TIMEOUT"
  );
}

export async function queryStats<T = RowDataPacket[]>(
  sql: string,
  params: Array<string | number | Date> = [],
): Promise<T> {
  try {
    const [rows] = await dbPool.query(sql, params);
    return rows as T;
  } catch (error) {
    if (!isTransientDbError(error)) {
      throw error;
    }
    console.warn("Transient DB error detected, retrying query once:", error);
    const [rows] = await dbPool.query(sql, params);
    return rows as T;
  }
}

export async function closeDbPool(): Promise<void> {
  await dbPool.end();
}

export default dbPool;
