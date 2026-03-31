import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  loginHandler,
  logoutHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  meHandler,
  requireAuth,
  getUsersCollection,
  verifyPassword,
  signToken,
} from '../auth';
import { sanitizeBody } from '../middleware/sanitize';

export const authRouter = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true,
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many password reset requests. Please try again in 1 hour.' },
});

// ── Cookie constants ──────────────────────────────────────────────────────────
const COOKIE_NAME    = 'naimos_session';
const COOKIE_MAX_AGE = 8 * 60 * 60; // 8 hours in seconds (matches JWT_EXPIRES_IN)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS   = 15 * 60 * 1000;

// ── Login handler with cookie ─────────────────────────────────────────────────
// Replicates the loginHandler logic so we can set the cookie header BEFORE
// calling res.json() — you cannot set headers after the response has been sent.
async function loginWithCookieHandler(req: Request, res: Response): Promise<void> {
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
      // Constant-time response to prevent username enumeration
      const bcrypt = await import('bcryptjs');
      await bcrypt.compare(cleanPassword, '$2a$14$invalidhashplaceholder00000000000000000');
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }

    // Account lock check
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      res.status(429).json({
        error: `Account temporarily locked due to multiple failed attempts. Try again in ${minutesLeft} minute(s).`,
      });
      return;
    }

    // Verify password
    const passwordOk = await verifyPassword(cleanPassword, user.passwordHash);

    if (!passwordOk) {
      const newAttempts = (user.loginAttempts || 0) + 1;
      const lockUpdate =
        newAttempts >= MAX_LOGIN_ATTEMPTS
          ? { loginAttempts: newAttempts, lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) }
          : { loginAttempts: newAttempts };

      await users.updateOne({ username: cleanUsername }, { $set: lockUpdate });
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }

    // Successful login — reset attempts, update lastLogin
    await users.updateOne(
      { username: cleanUsername },
      { $set: { loginAttempts: 0, lockedUntil: null, lastLogin: new Date() } }
    );

    const token = signToken(user);

    // ── Set HttpOnly cookie BEFORE res.json() ─────────────────────────────
    // This is the critical ordering — cookie() sets a response header, which
    // must happen before the response body is flushed by json().
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production', // HTTPS only in prod
      sameSite: 'strict',
      maxAge:   COOKIE_MAX_AGE * 1000,                 // express wants ms
      path:     '/',
    });

    // ── Now send the JSON response body ───────────────────────────────────
    res.json({
      token,
      user:      { username: user.username, role: user.role },
      expiresIn: '8h',
    });

  } catch (err: any) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
}

// ── Logout handler — also clears the cookie ──────────────────────────────────
function logoutWithCookieHandler(req: any, res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path:     '/',
  });
  logoutHandler(req, res);
}

// ── Routes ────────────────────────────────────────────────────────────────────
authRouter.post('/login',           authLimiter,   sanitizeBody, loginWithCookieHandler);
authRouter.post('/logout',          requireAuth,                 logoutWithCookieHandler);
authRouter.post('/forgot-password', forgotLimiter, sanitizeBody, forgotPasswordHandler);
authRouter.post('/reset-password',                 sanitizeBody, resetPasswordHandler);
authRouter.get('/me',               requireAuth,                 meHandler);