import jwt from "jsonwebtoken";

export type AuthTokenPayload = {
  sub: string;
  email: string;
  isAdmin: boolean;
  tokenVersion: number;
};

export function signAuthToken(payload: AuthTokenPayload): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET environment variable.");
  const expiresIn = (process.env.JWT_EXPIRES_IN ?? "7d") as jwt.SignOptions["expiresIn"];
  return jwt.sign(
    {
      sub: payload.sub,
      email: payload.email,
      isAdmin: payload.isAdmin,
      tokenVersion: payload.tokenVersion,
    },
    secret,
    { expiresIn },
  );
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET environment variable.");
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload & Partial<AuthTokenPayload>;
  if (!decoded.sub || typeof decoded.sub !== "string") throw new Error("Invalid token payload.");
  return {
    sub: decoded.sub,
    email: String(decoded.email ?? ""),
    isAdmin: Boolean(decoded.isAdmin),
    tokenVersion: Number(decoded.tokenVersion ?? 0),
  };
}
