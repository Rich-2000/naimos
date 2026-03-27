/**
 * ============================================================
 *  NAIMOS AMS — Auth Router  (unchanged from your working version)
 *  Mounts at /api/auth
 * ============================================================
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  loginHandler,
  logoutHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  meHandler,
  requireAuth,
} from '../auth';
import { sanitizeBody } from '../middleware/sanitize';

export const authRouter = Router();

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

authRouter.post('/login',           authLimiter,   sanitizeBody, loginHandler);
authRouter.post('/logout',          requireAuth,                 logoutHandler);
authRouter.post('/forgot-password', forgotLimiter, sanitizeBody, forgotPasswordHandler);
authRouter.post('/reset-password',                 sanitizeBody, resetPasswordHandler);
authRouter.get('/me',               requireAuth,                 meHandler);