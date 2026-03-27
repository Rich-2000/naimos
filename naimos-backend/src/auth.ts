/**
 * ============================================================
 *  NAIMOS AMS — Authentication & Authorization Module
 *  JWT · bcrypt · MongoDB · HMAC-SHA256 · Production-Grade
 *  (unchanged from your working version)
 * ============================================================
 */

import { Request, Response, NextFunction } from 'express';
import jwt     from 'jsonwebtoken';
import bcrypt  from 'bcryptjs';
import { MongoClient, Collection, Db } from 'mongodb';
import crypto  from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface NaimosUser {
  _id?: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: Date;
  updatedAt: Date;
  lastLogin?: Date;
  loginAttempts: number;
  lockedUntil?: Date | null;
  passwordResetToken?: string | null;
  passwordResetExpiry?: Date | null;
  isActive: boolean;
}

export interface JWTPayload {
  sub: string;
  role: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthRequest extends Request {
  user?: JWTPayload;
}

// ── Config ───────────────────────────────────────────────────────────────────
const JWT_SECRET         = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN     = '8h';
const BCRYPT_ROUNDS      = 14;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS   = 15 * 60 * 1000; // 15 minutes

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[AUTH] FATAL: JWT_SECRET is missing or too short (must be ≥32 chars).');
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

// ── MongoDB singleton ─────────────────────────────────────────────────────────
let _db:     Db         | null = null;
let _client: MongoClient | null = null;

async function getDb(): Promise<Db> {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI || '';
  if (!uri) throw new Error('[AUTH] MONGODB_URI is not set.');
  _client = new MongoClient(uri, { connectTimeoutMS: 10_000, serverSelectionTimeoutMS: 10_000, tls: true });
  await _client.connect();
  _db = _client.db();
  console.log('[AUTH] MongoDB connected ✓');
  return _db;
}

export async function getUsersCollection(): Promise<Collection<NaimosUser>> {
  const db = await getDb();
  return db.collection<NaimosUser>('users');
}

// ── Token revocation (in-memory) ──────────────────────────────────────────────
const revokedTokens = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────────
export function generateH2HToken(payload: string): string {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(payload + Date.now().toString())
    .digest('hex');
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(user: NaimosUser): string {
  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: user.username,
    role: user.role,
    jti: crypto.randomUUID(),
  };
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: no token provided.' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    if (revokedTokens.has(payload.jti)) {
      res.status(401).json({ error: 'Unauthorized: token has been revoked.' });
      return;
    }
    req.user = payload;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired. Please log in again.' });
    } else {
      res.status(401).json({ error: 'Unauthorized: invalid token.' });
    }
  }
}

export function revokeToken(jti: string): void {
  revokedTokens.add(jti);
  if (revokedTokens.size > 1000) {
    const arr = [...revokedTokens];
    arr.slice(0, 500).forEach(t => revokedTokens.delete(t));
  }
}

// ── Route Handlers ────────────────────────────────────────────────────────────
export async function loginHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username, password } = req.body as { username?: unknown; password?: unknown };

    if (
      typeof username !== 'string' || !username.trim() ||
      typeof password !== 'string' || !password.trim()
    ) {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const cleanUsername = username.trim().slice(0, 64);
    const cleanPassword = password.trim().slice(0, 128);

    if (/[${}()\[\]<>\\;]/.test(cleanUsername)) {
      res.status(400).json({ error: 'Invalid characters in username.' });
      return;
    }

    const users = await getUsersCollection();
    const user  = await users.findOne({ username: cleanUsername, isActive: true });

    if (!user) {
      await bcrypt.compare(cleanPassword, '$2a$14$invalidhashplaceholder00000000000000000');
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({ error: `Account locked. Try again in ${minutesLeft} minute(s).` });
      return;
    }

    const passwordOk = await verifyPassword(cleanPassword, user.passwordHash);

    if (!passwordOk) {
      const newAttempts = (user.loginAttempts || 0) + 1;
      const lockUpdate: Partial<NaimosUser> =
        newAttempts >= MAX_LOGIN_ATTEMPTS
          ? { loginAttempts: newAttempts, lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) }
          : { loginAttempts: newAttempts };
      await users.updateOne({ username: cleanUsername }, { $set: lockUpdate });
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }

    await users.updateOne(
      { username: cleanUsername },
      { $set: { loginAttempts: 0, lockedUntil: null, lastLogin: new Date() } }
    );

    const token = signToken(user);
    res.json({ token, user: { username: user.username, role: user.role }, expiresIn: JWT_EXPIRES_IN });
  } catch (err: any) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
}

export function logoutHandler(req: AuthRequest, res: Response): void {
  if (req.user?.jti) revokeToken(req.user.jti);
  res.json({ message: 'Logged out successfully.' });
}

export async function forgotPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { username } = req.body as { username?: unknown };
    if (typeof username !== 'string' || !username.trim()) {
      res.status(400).json({ error: 'Username is required.' });
      return;
    }
    const cleanUsername = username.trim().slice(0, 64);
    const users = await getUsersCollection();
    const user  = await users.findOne({ username: cleanUsername, isActive: true });

    if (!user) {
      res.json({ message: 'If that account exists, a reset token has been generated.' });
      return;
    }

    const resetToken  = generateH2HToken(cleanUsername);
    const resetExpiry = new Date(Date.now() + 30 * 60 * 1000);
    await users.updateOne({ username: cleanUsername }, { $set: { passwordResetToken: resetToken, passwordResetExpiry: resetExpiry } });
    console.log(`[AUTH] Password reset token for ${cleanUsername}: ${resetToken}`);

    res.json({
      message: 'Password reset token generated. Contact your system administrator.',
      ...(process.env.NODE_ENV !== 'production' && { resetToken }),
    });
  } catch (err: any) {
    console.error('[AUTH] Forgot-password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

export async function resetPasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { resetToken, newPassword } = req.body as { resetToken?: unknown; newPassword?: unknown };

    if (
      typeof resetToken  !== 'string' || !resetToken.trim() ||
      typeof newPassword !== 'string' || !newPassword.trim()
    ) {
      res.status(400).json({ error: 'Reset token and new password are required.' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters.' });
      return;
    }

    const users = await getUsersCollection();
    const user  = await users.findOne({
      passwordResetToken:  resetToken.trim(),
      passwordResetExpiry: { $gt: new Date() },
      isActive: true,
    });

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset token.' });
      return;
    }

    const passwordHash = await hashPassword(newPassword.trim());
    await users.updateOne(
      { _id: user._id },
      { $set: { passwordHash, updatedAt: new Date(), passwordResetToken: null, passwordResetExpiry: null, loginAttempts: 0, lockedUntil: null } }
    );
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err: any) {
    console.error('[AUTH] Reset-password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

export function meHandler(req: AuthRequest, res: Response): void {
  res.json({ user: req.user });
}