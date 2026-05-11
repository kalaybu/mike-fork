import jwt from "jsonwebtoken";

export type SessionPayload = {
  sub: string; // user id
  email: string;
};

const TOKEN_LIFETIME = "30d";

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}

export function signSessionToken(payload: SessionPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_LIFETIME });
}

export function verifySessionToken(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as Record<string, unknown>;
    if (typeof decoded.sub !== "string" || typeof decoded.email !== "string") {
      return null;
    }
    return { sub: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}
