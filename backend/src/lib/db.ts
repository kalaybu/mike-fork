// Re-export the mssql pool getter so existing call sites keep working.
export { getPool, sql } from "./db/pool";
