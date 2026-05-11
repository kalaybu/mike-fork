import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { getPool, sql } from "../lib/db";

export const userRouter = Router();

// GET /user/profile  — returns the current user's profile row.
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ profile: data ?? null });
});

// POST /user/profile  — bootstrap the row (idempotent). Called once after
// login/signup by the AuthContext.
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

const ALLOWED_FIELDS = new Set([
  "display_name",
  "organisation",
  "tabular_model",
  "claude_api_key",
  "gemini_api_key",
  "message_credits_used",
  "credits_reset_date",
]);

// PATCH /user/profile  — partial update. Body keys are passed through if
// they're in the allow-list; everything else is dropped.
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(k)) update[k] = v;
  }
  if (Object.keys(update).length === 0) {
    return void res.status(400).json({ detail: "No allowed fields to update" });
  }
  update.updated_at = new Date().toISOString();
  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .update(update)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ profile: data });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const pool = await getPool();
  await pool
    .request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .query("delete from dbo.users where id = @user_id");
  res.status(204).send();
});
