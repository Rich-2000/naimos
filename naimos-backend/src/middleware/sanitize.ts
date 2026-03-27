/**
 * ============================================================
 *  NAIMOS AMS — Input Sanitization Middleware  (unchanged)
 * ============================================================
 */

import { Request, Response, NextFunction } from 'express';

const NOSQL_BLACKLIST = /\$where|\$gt|\$lt|\$gte|\$lte|\$ne|\$in|\$nin|\$or|\$and|\$not|\$nor|\$exists|\$type|\$mod|\$regex|\$text|\$search|\$elemMatch|\$size|\$all|\$slice|\$comment|\$meta|\$expr|\$jsonSchema|\$lookup|\$unwind|\$group|\$project|\$match|\$sort|\$limit|\$skip|\$count|\$facet|\$bucket|\$graphLookup|\$addFields|\$replaceRoot|\$sortByCount|\$out|\$merge|\$set|\$unset|\$rename|\$inc|\$mul|\$min|\$max|\$push|\$pop|\$pull|\$addToSet|\$each|\$position|\$slice|\$sort|\$bit|\$currentDate|\$isolated/i;

const XSS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /javascript\s*:/gi,
  /on\w+\s*=/gi,
  /<\s*iframe/gi,
  /<\s*object/gi,
  /<\s*embed/gi,
  /<\s*form/gi,
  /eval\s*\(/gi,
  /expression\s*\(/gi,
  /vbscript\s*:/gi,
  /data\s*:\s*text\/html/gi,
];

const SQL_PATTERNS = [
  /(\b)(union|select|insert|update|delete|drop|create|alter|exec|execute|xp_|sp_|declare|cast|convert|char|varchar|nvarchar|waitfor|delay|benchmark|sleep|load_file|into outfile|information_schema|sys\.|sysobjects|syscolumns)(\b)/gi,
  /--\s/,
  /\/\*[\s\S]*?\*\//,
  /;\s*(drop|delete|update|insert|create|alter)/gi,
  /'\s*(or|and)\s*'?\d/gi,
  /1\s*=\s*1/gi,
  /'\s*;\s*/gi,
];

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class SanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SanitizationError';
  }
}

function sanitizeString(val: string, fieldName = ''): string {
  let s = val.replace(/\0/g, '');
  if (NOSQL_BLACKLIST.test(s)) throw new SanitizationError(`Prohibited operator in field "${fieldName}".`);
  for (const pattern of XSS_PATTERNS) s = s.replace(pattern, '');
  for (const pattern of SQL_PATTERNS) {
    if (pattern.test(s)) {
      console.warn(`[SANITIZE] SQL pattern in field "${fieldName}": ${s.slice(0, 80)}`);
      s = s.replace(pattern, '');
    }
  }
  return s;
}

function sanitizeObject(obj: any, depth = 0): any {
  if (depth > 10) throw new SanitizationError('Payload too deeply nested.');
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item, depth + 1));
  if (obj !== null && typeof obj === 'object') {
    const sanitized: any = {};
    for (const key of Object.keys(obj)) {
      if (PROTO_KEYS.has(key)) { console.warn(`[SANITIZE] Prototype pollution blocked: key="${key}"`); continue; }
      sanitized[key] = sanitizeObject(obj[key], depth + 1);
    }
    return sanitized;
  }
  if (typeof obj === 'string') return sanitizeString(obj);
  return obj;
}

export function sanitizeBody(req: Request, res: Response, next: NextFunction): void {
  try {
    if (req.body && typeof req.body === 'object') req.body = sanitizeObject(req.body);
    next();
  } catch (err: any) {
    if (err instanceof SanitizationError) res.status(400).json({ error: `Invalid input: ${err.message}` });
    else next(err);
  }
}

export function sanitizeQuery(req: Request, res: Response, next: NextFunction): void {
  try {
    if (req.query && typeof req.query === 'object') {
      for (const key of Object.keys(req.query)) {
        const val = req.query[key];
        if (typeof val === 'string') req.query[key] = sanitizeString(val, key);
      }
    }
    next();
  } catch (err: any) {
    if (err instanceof SanitizationError) res.status(400).json({ error: `Invalid query parameter: ${err.message}` });
    else next(err);
  }
}

export function sanitizeParams(req: Request, res: Response, next: NextFunction): void {
  try {
    for (const key of Object.keys(req.params)) {
      const val = req.params[key];
      if (typeof val === 'string') req.params[key] = sanitizeString(val, key);
    }
    next();
  } catch (err: any) {
    if (err instanceof SanitizationError) res.status(400).json({ error: `Invalid path parameter: ${err.message}` });
    else next(err);
  }
}

export function globalSanitize(req: Request, res: Response, next: NextFunction): void {
  sanitizeBody(req, res, () => {
    sanitizeQuery(req, res, () => {
      sanitizeParams(req, res, next);
    });
  });
}