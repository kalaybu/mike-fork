import { DbClient } from "./db/shim";
import { verifySessionToken } from "./jwt";

/**
 * Returns a query client. The function is named `createServerSupabase` for
 * legacy reasons — its `.from(...).select()` API matches the slice of the
 * Supabase JS client this codebase uses, but is now backed by Microsoft
 * SQL Server via the in-process shim in `db/shim.ts`.
 */
export function createServerSupabase() {
  return new DbClient();
}

/**
 * Verify the JWT in the Authorization header and return the user id.
 * Throws a Response with 401 when missing or invalid.
 */
export async function getUserIdFromRequest(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", {
      status: 401,
    });
  }
  const token = auth.slice(7).trim();
  const session = verifySessionToken(token);
  if (!session) {
    throw new Response("Invalid or expired token", { status: 401 });
  }
  return session.sub;
}
