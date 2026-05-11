import sql from "mssql";

let _poolPromise: Promise<sql.ConnectionPool> | null = null;

/**
 * Singleton mssql connection pool. Reads either DATABASE_URL (a
 * `Server=...;Database=...;User ID=...;Password=...;` style connection
 * string, or the mssql URL form) from the environment.
 */
export function getPool(): Promise<sql.ConnectionPool> {
  if (_poolPromise) return _poolPromise;
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error("DATABASE_URL is not set");
  _poolPromise = new sql.ConnectionPool(connStr).connect();
  return _poolPromise;
}

export { sql };
