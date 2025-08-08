import crypto from "node:crypto";
import jwt from "jsonwebtoken";
export type Role = "admin" | "supervisor" | "agent";
export type Claims = { sub: string; email: string; role: Role };
const configuredSecret = process.env.JWT_SECRET;
if (
  process.env.NODE_ENV === "production" &&
  (!configuredSecret || configuredSecret.length < 32)
)
  throw new Error("JWT_SECRET must be at least 32 characters in production");
const secret = configuredSecret ?? "dev-only-secret-change-me-please-32-chars";
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${digest}`;
}
export function verifyPassword(password: string, encoded: string) {
  try {
    const [scheme, salt, expected] = encoded.split("$");
    if (scheme !== "scrypt" || !salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 32).toString("hex");
    const a = Buffer.from(actual, "hex"),
      b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
export const sign = (c: Claims) =>
  jwt.sign(c, secret, { issuer: "wingops", expiresIn: "2h" });
export const read = (t: string) =>
  jwt.verify(t, secret, { issuer: "wingops" }) as Claims;
