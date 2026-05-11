import { Router } from "express";
import bcrypt from "bcrypt";
import { getPool, sql } from "../lib/db";
import { signSessionToken, verifySessionToken } from "../lib/jwt";

export const authRouter = Router();

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

// POST /auth/signup  { email, password }
authRouter.post("/signup", async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const password = req.body?.password;
  if (!email)
    return void res.status(400).json({ detail: "Invalid email address" });
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return void res.status(400).json({
      detail: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  const pool = await getPool();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const insertResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .input("password_hash", sql.NVarChar, passwordHash)
      .query<{ id: string; email: string }>(
        `insert into dbo.users (email, password_hash)
         output inserted.id, inserted.email
         values (@email, @password_hash)`,
      );
    const user = insertResult.recordset[0];

    await pool
      .request()
      .input("user_id", sql.UniqueIdentifier, user.id)
      .query(
        `if not exists (select 1 from dbo.user_profiles where user_id = @user_id)
           insert into dbo.user_profiles (user_id) values (@user_id)`,
      );

    const token = signSessionToken({ sub: user.id, email: user.email });
    res.json({
      access_token: token,
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // SQL Server unique-constraint violation
    if (msg.includes("UNIQUE") || msg.includes("uq_users_email") || msg.includes("Violation")) {
      return void res.status(409).json({ detail: "Email already registered" });
    }
    res.status(500).json({ detail: msg || "Signup failed" });
  }
});

// POST /auth/login  { email, password }
authRouter.post("/login", async (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || typeof password !== "string") {
    return void res.status(400).json({ detail: "Email and password required" });
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input("email", sql.NVarChar, email)
    .query<{ id: string; email: string; password_hash: string }>(
      `select id, email, password_hash from dbo.users where email = @email`,
    );
  const user = result.recordset[0];
  if (!user)
    return void res.status(401).json({ detail: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok)
    return void res.status(401).json({ detail: "Invalid credentials" });

  const token = signSessionToken({ sub: user.id, email: user.email });
  res.json({
    access_token: token,
    user: { id: user.id, email: user.email },
  });
});

// GET /auth/me   (requires Bearer token)
authRouter.get("/me", async (req, res) => {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer "))
    return void res.status(401).json({ detail: "Missing token" });
  const session = verifySessionToken(auth.slice(7).trim());
  if (!session)
    return void res.status(401).json({ detail: "Invalid token" });
  res.json({ user: { id: session.sub, email: session.email } });
});
