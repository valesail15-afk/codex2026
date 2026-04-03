import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import db, { formatLocalDbDateTime } from './db';

const jwtSecretFromEnv = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === 'production';
const isUnsafe = !jwtSecretFromEnv || jwtSecretFromEnv === 'your-secret-key';

if (isProd && isUnsafe) {
  throw new Error('JWT_SECRET ?????????????????????????????');
}

if (!isProd && isUnsafe) {
  console.warn('[auth] JWT_SECRET ??????????????????????? JWT_SECRET?');
}

const JWT_SECRET = isUnsafe ? 'dev-only-jwt-secret-change-me' : jwtSecretFromEnv;

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    role: string;
    sid: string;
  };
}

function isExpired(expiresAt?: string | null) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

function invalidateAllSessions(userId: number) {
  db.prepare('UPDATE user_sessions SET is_active = 0, revoked_at = ? WHERE user_id = ? AND is_active = 1').run(formatLocalDbDateTime(), userId);
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err: any, payload: any) => {
    if (err || !payload?.id || !payload?.sid) return res.status(401).json({ error: 'Unauthorized' });

    const dbUser = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id) as any;
    if (!dbUser) return res.status(401).json({ error: 'User not found' });

    const session = db
      .prepare('SELECT * FROM user_sessions WHERE session_id = ? AND user_id = ? AND is_active = 1')
      .get(payload.sid, payload.id) as any;
    if (!session) return res.status(401).json({ error: 'Session invalid' });

    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      db.prepare('UPDATE user_sessions SET is_active = 0, revoked_at = ? WHERE id = ?').run(formatLocalDbDateTime(), session.id);
      return res.status(401).json({ error: 'Session expired' });
    }

    const lockedByTime = dbUser.lock_until ? new Date(dbUser.lock_until).getTime() > Date.now() : false;
    if (dbUser.status === 'locked' || dbUser.is_locked || lockedByTime) {
      return res.status(403).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED', lock_until: dbUser.lock_until || null });
    }

    if (dbUser.role !== 'Admin' && isExpired(dbUser.expires_at)) {
      db.prepare("UPDATE users SET status = 'expired', is_locked = 0, updated_at = ? WHERE id = ?").run(formatLocalDbDateTime(), dbUser.id);
      invalidateAllSessions(dbUser.id);
      return res.status(403).json({ error: 'Account expired', code: 'ACCOUNT_EXPIRED', expires_at: dbUser.expires_at });
    }

    db.prepare('UPDATE user_sessions SET last_activity_at = ? WHERE id = ?').run(formatLocalDbDateTime(), session.id);
    // 权限以数据库实时角色为准，避免 token 中旧 role 导致越权
    req.user = { id: dbUser.id, username: dbUser.username, role: dbUser.role, sid: payload.sid };
    next();
  });
};

export const authorizeAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

export const generateToken = (user: { id: number; username: string; role: string; sid: string }) => {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
};

export const logAction = (userId: number | null, username: string | null, action: string, content: string, ip: string) => {
  db.prepare('INSERT INTO logs (user_id, username, action, content, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, username, action, content, ip, formatLocalDbDateTime());
};

export const revokeSession = (sessionId: string) => {
  db.prepare('UPDATE user_sessions SET is_active = 0, revoked_at = ? WHERE session_id = ?').run(formatLocalDbDateTime(), sessionId);
};

export const revokeAllUserSessions = (userId: number) => {
  invalidateAllSessions(userId);
};
