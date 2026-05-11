import { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../lib/jwt";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();
  const session = verifySessionToken(token);
  if (!session) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  res.locals.userId = session.sub;
  res.locals.userEmail = session.email.toLowerCase();
  next();
}
