import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import db, { initDb } from './src/server/db';
import { CrawlerService } from './src/server/crawler';
import { ArbitrageEngine } from './src/server/arbitrageEngine';
import { authenticateToken, authorizeAdmin, generateToken, logAction, AuthRequest, revokeAllUserSessions, revokeSession } from './src/server/auth';

const DEFAULT_SYNC_INTERVAL_SECONDS = 90;
const MIN_SYNC_INTERVAL_SECONDS = 60;
const LAST_SYNC_SETTING_KEY = 'last_sync_at';

function isUserExpired(user: any) {
  if (!user?.expires_at || user.role === 'Admin') return false;
  const ts = new Date(user.expires_at).getTime();
  return Number.isFinite(ts) && ts <= Date.now();
}

function getAdminSecuritySettings() {
  const adminId = getAdminUserId();
  const defaults = {
    loginLockShortMinutes: 10,
    loginLockLongMinutes: 120,
    sessionMode: 'single',
    maxSessions: 1,
  };
  if (!adminId) return defaults;
  const map = getUserSettingsMap(adminId);
  return {
    loginLockShortMinutes: Math.max(1, Number(map.login_lock_short_minutes || defaults.loginLockShortMinutes)),
    loginLockLongMinutes: Math.max(1, Number(map.login_lock_long_minutes || defaults.loginLockLongMinutes)),
    sessionMode: map.session_mode === 'multi' ? 'multi' : 'single',
    maxSessions: Math.max(1, Number(map.max_sessions || defaults.maxSessions)),
  };
}

function buildDeviceId(req: express.Request) {
  const ua = String(req.headers['user-agent'] || 'unknown');
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return Buffer.from(`${ua}|${ip}`).toString('base64').slice(0, 120);
}

function getUserSettingsMap(userId: number) {
  const settings = db.prepare('SELECT key, value FROM system_settings WHERE user_id = ?').all(userId) as Array<{
    key: string;
    value: string;
  }>;

  return settings.reduce<Record<string, string>>((acc, curr) => {
    acc[curr.key] = curr.value;
    return acc;
  }, {});
}

function getAdminUserId() {
  const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id?: number } | undefined;
  return admin?.id;
}

function getEffectiveSyncIntervalSeconds() {
  const adminId = getAdminUserId();
  if (!adminId) return DEFAULT_SYNC_INTERVAL_SECONDS;
  const row = db
    .prepare("SELECT value FROM system_settings WHERE user_id = ? AND key = 'scan_interval'")
    .get(adminId) as { value?: string } | undefined;
  const parsed = Number.parseInt(String(row?.value || DEFAULT_SYNC_INTERVAL_SECONDS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SYNC_INTERVAL_SECONDS;
  return Math.max(MIN_SYNC_INTERVAL_SECONDS, parsed);
}

function getLastSyncTimeMs() {
  const adminId = getAdminUserId();
  if (!adminId) return 0;
  const row = db
    .prepare('SELECT value FROM system_settings WHERE user_id = ? AND key = ?')
    .get(adminId, LAST_SYNC_SETTING_KEY) as { value?: string } | undefined;
  const ms = Number.parseInt(String(row?.value || '0'), 10);
  return Number.isFinite(ms) ? ms : 0;
}

function setLastSyncTimeMs(ts: number) {
  const adminId = getAdminUserId();
  if (!adminId) return;
  db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
    .run(adminId, LAST_SYNC_SETTING_KEY, String(ts));
}

function getSyncRefreshStatus() {
  const intervalSeconds = getEffectiveSyncIntervalSeconds();
  const lastSyncAtMs = getLastSyncTimeMs();
  const now = Date.now();
  const elapsed = lastSyncAtMs > 0 ? Math.floor((now - lastSyncAtMs) / 1000) : Number.MAX_SAFE_INTEGER;
  const remainingSeconds = Math.max(0, intervalSeconds - elapsed);
  const nextSyncAtMs = lastSyncAtMs > 0 ? lastSyncAtMs + intervalSeconds * 1000 : now;

  return {
    interval_seconds: intervalSeconds,
    last_sync_at: lastSyncAtMs > 0 ? new Date(lastSyncAtMs).toISOString() : null,
    next_sync_at: new Date(nextSyncAtMs).toISOString(),
    remaining_seconds: remainingSeconds,
    can_refresh: remainingSeconds <= 0,
  };
}

function hasCompleteMatchData(match: any) {
  const hasBaseInfo = Boolean(
    match.league &&
      match.round &&
      match.match_time &&
      match.home_team &&
      match.away_team &&
      match.handicap &&
      match.handicap !== '-' &&
      match.jc_handicap &&
      match.jc_handicap !== '-'
  );
  const hasJingcaiOdds = [match.j_w, match.j_d, match.j_l].every((value) => Number(value) > 0);
  const hasJingcaiHandicapOdds = [match.j_hw, match.j_hd, match.j_hl].every((value) => Number(value) > 0);
  const hasCrownOdds = [match.c_w, match.c_d, match.c_l].every((value) => Number(value) > 0);

  return hasBaseInfo && hasJingcaiOdds && hasJingcaiHandicapOdds && hasCrownOdds;
}

function normalizeCrownHandicaps(raw: any) {
  const toNumber = (value: any) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const normalizeItem = (item: any) => {
    if (!item || typeof item !== 'object') return null;
    const type = String(item.type ?? item.handicap ?? '').trim();
    const homeOdds = toNumber(item.home_odds ?? item.homeOdds ?? item.homeWater);
    const awayOdds = toNumber(item.away_odds ?? item.awayOdds ?? item.awayWater);
    if (!type || homeOdds <= 0 || awayOdds <= 0) return null;
    return { type, home_odds: homeOdds, away_odds: awayOdds };
  };

  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeItem).filter(Boolean);
  }

  const single = normalizeItem(parsed);
  return single ? [single] : [];
}

function isManualMatchId(matchId?: string) {
  return typeof matchId === 'string' && matchId.startsWith('manual_');
}

function getExpectedOrigin(req: express.Request) {
  const host = req.get('host');
  if (!host) return null;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || req.protocol || 'http';
  return `${proto}://${host}`.toLowerCase();
}

function isHttpsRequest(req: express.Request) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || xfProto === 'https';
}

function isTrustedOrigin(req: express.Request) {
  const expectedOrigin = getExpectedOrigin(req);
  if (!expectedOrigin) return true;

  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin) return origin === expectedOrigin;

  const referer = String(req.headers.referer || '').trim();
  if (!referer) return true;
  try {
    const refererOrigin = new URL(referer).origin.toLowerCase();
    return refererOrigin === expectedOrigin;
  } catch {
    return false;
  }
}

async function startServer() {
  console.log('Starting server...');
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    const requiresCsrfCheck = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!requiresCsrfCheck) return next();
    if (!isTrustedOrigin(req)) {
      return res.status(403).json({ error: 'Invalid request origin', code: 'CSRF_BLOCKED' });
    }
    next();
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (res.statusCode >= 400) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
      }
    });
    next();
  });

  // 鍒濆鍖栨暟鎹簱
  try {
    console.log('Initializing database...');
    initDb();
    console.log('Database initialized.');
  } catch (err) {
    console.error('Database initialization failed:', err);
  }

  // Auth API
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const normalizedUsername = typeof username === 'string' ? username.trim() : '';
      const normalizedPassword = typeof password === 'string' ? password : '';
      if (!normalizedUsername || !normalizedPassword) {
        return res.status(400).json({ error: 'username 和 password 必填', code: 'INVALID_LOGIN_PAYLOAD' });
      }
      const ip = req.ip || '';
      const userAgent = String(req.headers['user-agent'] || '');
      const security = getAdminSecuritySettings();

      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername) as any;

      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (isUserExpired(user)) {
        db.prepare("UPDATE users SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
        revokeAllUserSessions(user.id);
        return res.status(403).json({ error: '账户已到期，请联系管理员续费。', code: 'ACCOUNT_EXPIRED', expires_at: user.expires_at });
      }

      const lockUntilTs = user.lock_until ? new Date(user.lock_until).getTime() : 0;
      if (user.status === 'locked' || user.is_locked || (lockUntilTs && lockUntilTs > Date.now())) {
        return res.status(403).json({ error: '账户已锁定', code: 'ACCOUNT_LOCKED', lock_until: user.lock_until || null });
      }

      const passwordMatch = bcrypt.compareSync(normalizedPassword, user.password);
      if (!passwordMatch) {
        const failCount = (user.login_fail_count || 0) + 1;
        const lockMinutes = failCount >= 10 ? security.loginLockLongMinutes : failCount >= 5 ? security.loginLockShortMinutes : 0;
        if (lockMinutes > 0) {
          db.prepare("UPDATE users SET login_fail_count = ?, is_locked = 1, status = 'locked', lock_until = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(failCount, `+${lockMinutes} minutes`, user.id);
        } else {
          db.prepare('UPDATE users SET login_fail_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(failCount, user.id);
        }
        logAction(user.id, user.username, 'login_failed', `Failed login attempt ${failCount}`, ip);
        return res.status(401).json({ error: 'Invalid username or password', code: lockMinutes > 0 ? 'ACCOUNT_LOCKED' : undefined });
      }

      db.prepare("UPDATE users SET login_fail_count = 0, is_locked = 0, status = 'normal', lock_until = NULL, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(user.id);

      const sid = randomUUID();
      const deviceId = buildDeviceId(req);
      const sessionMode = security.sessionMode;
      const maxSessions = security.maxSessions;

      if (sessionMode === 'single') {
        revokeAllUserSessions(user.id);
      } else {
        const activeSessions = db
          .prepare('SELECT id, session_id FROM user_sessions WHERE user_id = ? AND is_active = 1 ORDER BY last_activity_at DESC, created_at DESC')
          .all(user.id) as any[];
        if (activeSessions.length >= maxSessions) {
          const toRevoke = activeSessions.slice(maxSessions - 1);
          for (const s of toRevoke) revokeSession(String(s.session_id));
        }
      }

      db.prepare("INSERT INTO user_sessions (session_id, user_id, device_id, ip, user_agent, is_active, expires_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now', '+1 day'))")
        .run(sid, user.id, deviceId, ip, userAgent);

      if (user.role === 'User') {
        try {
          const existingOppCount = db.prepare('SELECT COUNT(*) as count FROM arbitrage_opportunities WHERE user_id = ?').get(user.id) as { count?: number } | undefined;
          if ((existingOppCount?.count || 0) === 0) {
            await CrawlerService.scanOpportunities(user.id);
          }
        } catch (scanErr) {
          console.error(`Failed to initialize opportunities for user ${user.id}:`, scanErr);
        }
      }

      const token = generateToken({ id: user.id, username: user.username, role: user.role, sid });
      const isProduction = process.env.NODE_ENV === 'production';
      const useSecureCookie = isProduction && isHttpsRequest(req);
      res.cookie('token', token, {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        secure: useSecureCookie,
        sameSite: 'lax'
      });
      
      logAction(user.id, user.username, 'login_success', 'User logged in successfully', ip);
      const freshUser = db
        .prepare('SELECT id, username, role, package_name, expires_at, status, max_duration, used_duration FROM users WHERE id = ?')
        .get(user.id);
      res.json(freshUser);
    } catch (err: any) {
      console.error('Login API error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/auth/logout', authenticateToken, (req: AuthRequest, res) => {
    if (req.user?.sid) revokeSession(req.user.sid);
    res.clearCookie('token');
    res.json({ status: 'ok' });
  });

  app.get('/api/auth/me', authenticateToken, (req: AuthRequest, res) => {
    const user = db
      .prepare('SELECT id, username, role, package_name, expires_at, status, max_duration, used_duration FROM users WHERE id = ?')
      .get(req.user!.id) as any;
    res.json(user);
  });

  app.post('/api/auth/heartbeat', authenticateToken, (req: AuthRequest, res) => {
    const userId = req.user!.id;
    const user = db.prepare('SELECT role, package_name, expires_at, status FROM users WHERE id = ?').get(userId) as any;

    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.role !== 'Admin' && isUserExpired(user)) {
      db.prepare("UPDATE users SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(userId);
      revokeAllUserSessions(userId);
      return res.json({ status: 'expired', remaining: 0, code: 'ACCOUNT_EXPIRED', expires_at: user.expires_at });
    }

    const remaining = user.expires_at ? Math.max(0, Math.floor((new Date(user.expires_at).getTime() - Date.now()) / 1000)) : null;
    res.json({ status: 'ok', remaining, package_name: user.package_name, expires_at: user.expires_at, account_status: user.status });
  });

  // User Management API (Admin only)
  app.get('/api/admin/users', authenticateToken, authorizeAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, package_name, expires_at, status, max_duration, used_duration, login_fail_count, lock_until, is_locked, last_login_at, created_at FROM users').all();
    res.json(users);
  });

  app.post('/api/admin/users', authenticateToken, authorizeAdmin, async (req: AuthRequest, res) => {
    const { username, password, role, package_name, expires_at, max_duration } = req.body;
    try {
      const hashedPassword = bcrypt.hashSync(password, 10);
      const result = db.prepare('INSERT INTO users (username, password, role, package_name, expires_at, status, max_duration) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          username,
          hashedPassword,
          role,
          package_name || '基础套餐',
          expires_at || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          'normal',
          max_duration || 0
        );
      
      const defaultSettings = [
        ['auto_scan', 'false'],
        ['only_complete_matches', 'true'],
        ['sound_alert', 'false'],
        ['scan_interval', String(DEFAULT_SYNC_INTERVAL_SECONDS)],
        [LAST_SYNC_SETTING_KEY, '0'],
        ['login_lock_short_minutes', '10'],
        ['login_lock_long_minutes', '120'],
        ['session_mode', 'single'],
        ['max_sessions', '1'],
        ['default_jingcai_rebate', '0.13'],
        ['default_crown_rebate', '0.02'],
        ['default_jingcai_share', '0'],
        ['default_crown_share', '0']
      ];
      const insertSetting = db.prepare('INSERT INTO system_settings (user_id, key, value) VALUES (?, ?, ?)');
      defaultSettings.forEach(([key, value]) => insertSetting.run(result.lastInsertRowid, key, value));

      if (role === 'User') {
        try {
          await CrawlerService.scanOpportunities(Number(result.lastInsertRowid));
        } catch (scanErr) {
          console.error(`Failed to precompute opportunities for new user ${result.lastInsertRowid}:`, scanErr);
        }
      }

      logAction(req.user!.id, req.user!.username, 'user_create', `Created user ${username}`, req.ip || '');
      res.json({ id: result.lastInsertRowid });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/admin/users/:id', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    const { username, password, role, package_name, expires_at, max_duration, status } = req.body;
    try {
      if (Number(id) === req.user!.id && status === 'locked') {
        return res.status(400).json({ error: '管理员不能冻结自己' });
      }
      if (password) {
        const hashedPassword = bcrypt.hashSync(password, 10);
        db.prepare(`UPDATE users SET username = ?, password = ?, role = ?, package_name = ?, expires_at = ?, status = ?, is_locked = CASE WHEN ? = 'locked' THEN 1 ELSE 0 END, max_duration = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(username, hashedPassword, role, package_name || '基础套餐', expires_at || null, status || 'normal', status || 'normal', max_duration || 0, id);
      } else {
        db.prepare(`UPDATE users SET username = ?, role = ?, package_name = ?, expires_at = ?, status = ?, is_locked = CASE WHEN ? = 'locked' THEN 1 ELSE 0 END, max_duration = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(username, role, package_name || '基础套餐', expires_at || null, status || 'normal', status || 'normal', max_duration || 0, id);
      }
      if (status === 'locked') {
        revokeAllUserSessions(Number(id));
      }
      logAction(req.user!.id, req.user!.username, 'user_update', `Updated user ${username} (ID: ${id})`, req.ip || '');
      res.json({ status: 'ok' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/users/:id/renew', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    const { package_name, extend_days, expires_at } = req.body || {};
    const days = Math.max(1, Number(extend_days || 30));
    const target = expires_at
      ? new Date(expires_at).toISOString()
      : new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    db.prepare("UPDATE users SET package_name = COALESCE(?, package_name), expires_at = ?, status = 'normal', is_locked = 0, lock_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(package_name || null, target, id);
    logAction(req.user!.id, req.user!.username, 'user_renew', `Renew user ID=${id} to ${target}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/freeze', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    if (Number(id) === req.user!.id) {
      return res.status(400).json({ error: '管理员不能冻结自己' });
    }
    db.prepare("UPDATE users SET status = 'locked', is_locked = 1, lock_until = datetime('now', '+3650 days'), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    revokeAllUserSessions(Number(id));
    logAction(req.user!.id, req.user!.username, 'user_freeze', `Freeze user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/unfreeze', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    db.prepare("UPDATE users SET status = CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE 'normal' END, is_locked = 0, lock_until = NULL, login_fail_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logAction(req.user!.id, req.user!.username, 'user_unfreeze', `Unfreeze user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/reset-password', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    const { password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const hash = bcrypt.hashSync(String(password), 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, id);
    revokeAllUserSessions(Number(id));
    logAction(req.user!.id, req.user!.username, 'user_reset_password', `Reset password and force logout user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/force-logout', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    revokeAllUserSessions(Number(id));
    logAction(req.user!.id, req.user!.username, 'user_force_logout', `Force logout user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/unlock', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    db.prepare("UPDATE users SET login_fail_count = 0, is_locked = 0, lock_until = NULL, status = CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE 'normal' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logAction(req.user!.id, req.user!.username, 'user_unlock', `Admin unlock user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.get('/api/admin/users/:id/sessions', authenticateToken, authorizeAdmin, (req, res) => {
    const { id } = req.params;
    const sessions = db
      .prepare('SELECT id, session_id, device_id, ip, user_agent, is_active, created_at, last_activity_at, expires_at FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(id);
    res.json(sessions);
  });

  app.post('/api/admin/users/:id/sessions/:sid/kick', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { sid } = req.params;
    revokeSession(String(sid));
    logAction(req.user!.id, req.user!.username, 'session_kick', `Kick session=${sid}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.delete('/api/admin/users/:id', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    try {
      if (Number(id) === req.user!.id) {
        return res.status(400).json({ error: '管理员不能删除自己' });
      }
      const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as any;
      db.transaction(() => {
        db.prepare('DELETE FROM arbitrage_opportunities WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM parlay_opportunities WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM system_settings WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM bet_records WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM logs WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      })();
      logAction(req.user!.id, req.user!.username, 'user_delete', `Deleted user ${user?.username} (ID: ${id})`, req.ip || '');
      res.json({ status: 'ok' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/admin/logs', authenticateToken, authorizeAdmin, (req, res) => {
    const logs = db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT 1000').all();
    res.json(logs);
  });

  app.get('/api/admin/scrape-health', authenticateToken, authorizeAdmin, (req, res) => {
    const limitRaw = Number.parseInt(String(req.query.limit || 50), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(200, limitRaw)) : 50;
    const rows = db
      .prepare(
        `SELECT id, source, status, fetched_total, filtered_total, synced_total, complete_total,
                hga_status, hga_count, base_count, merged_count, playwright_fallback_used, note, duration_ms, created_at
         FROM scrape_health_logs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as any[];

    const stats = rows.reduce(
      (acc: any, row: any) => {
        acc.total += 1;
        if (row.status === 'ok' || row.status === 'unchanged') acc.success += 1;
        if (row.status === 'skipped') acc.skipped += 1;
        if (row.status === 'empty' || row.status === 'error') acc.failed += 1;
        if (row.playwright_fallback_used) acc.playwright_used += 1;
        acc.avg_duration_ms += Number(row.duration_ms || 0);
        return acc;
      },
      { total: 0, success: 0, failed: 0, skipped: 0, playwright_used: 0, avg_duration_ms: 0 }
    );
    if (stats.total > 0) stats.avg_duration_ms = Math.round(stats.avg_duration_ms / stats.total);

    res.json({ stats, rows });
  });

  // API 璺敱 (Protected)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/matches', authenticateToken, (req: AuthRequest, res) => {
    try {
      const settingsMap = getUserSettingsMap(req.user!.id);
      const onlyCompleteMatches = settingsMap.only_complete_matches !== 'false';
      const matches = db.prepare(`
        SELECT m.*, m.jingcai_handicap as jc_handicap,
               j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
               j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
               j.rebate_rate as j_r, j.share_rate as j_s,
               c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h, c.rebate_rate as c_r, c.share_rate as c_s
        FROM matches m
        LEFT JOIN jingcai_odds j ON m.match_id = j.match_id
        LEFT JOIN crown_odds c ON m.match_id = c.match_id
        ORDER BY m.match_time ASC
      `).all();
      res.json(
        matches
          .filter((m: any) => !onlyCompleteMatches || hasCompleteMatchData(m))
          .map((m: any) => ({
            ...m,
            c_h: normalizeCrownHandicaps(m.c_h)
          }))
      );
    } catch (err: any) {
      console.error('Failed to fetch matches:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/matches/export', authenticateToken, (req: AuthRequest, res) => {
    try {
      const matches = db.prepare(`
        SELECT m.*, m.jingcai_handicap as jc_handicap,
               j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
               j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
               c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h
        FROM matches m
        LEFT JOIN jingcai_odds j ON m.match_id = j.match_id
        LEFT JOIN crown_odds c ON m.match_id = c.match_id
      `).all();
      
      const exportData = matches.map((m: any) => ({
        ...m,
        c_h: normalizeCrownHandicaps(m.c_h)
      }));
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=matches_export.json');
      res.send(JSON.stringify(exportData, null, 2));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/matches/import', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const matches = req.body;
    if (!Array.isArray(matches)) {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    try {
      db.transaction(() => {
        for (const m of matches) {
          db.prepare(`
            INSERT OR REPLACE INTO matches (match_id, league, round, handicap, jingcai_handicap, home_team, away_team, match_time, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            m.match_id,
            m.league,
            m.round || '',
            m.handicap || '',
            m.jc_handicap || '',
            m.home_team,
            m.away_team,
            m.match_time,
            m.status || 'upcoming'
          );
          
          db.prepare(`
            INSERT OR REPLACE INTO jingcai_odds (match_id, win_odds, draw_odds, lose_odds, handicap_win_odds, handicap_draw_odds, handicap_lose_odds, rebate_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(m.match_id, m.j_w || 0, m.j_d || 0, m.j_l || 0, m.j_hw || 0, m.j_hd || 0, m.j_hl || 0, 0.13);
          
          db.prepare(`
            INSERT OR REPLACE INTO crown_odds (match_id, win_odds, draw_odds, lose_odds, handicaps, rebate_rate)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(m.match_id, m.c_w || 0, m.c_d || 0, m.c_l || 0, JSON.stringify(m.c_h || []), 0.02);
        }
      })();
      
      void CrawlerService.scanOpportunities(req.user!.id).catch((err) => {
        console.error('scanOpportunities failed after import:', err);
      });
      res.json({ status: 'ok', count: matches.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/matches/refresh-status', authenticateToken, (_req: AuthRequest, res) => {
    res.json(getSyncRefreshStatus());
  });

  app.get('/api/matches/:id', authenticateToken, (req: AuthRequest, res) => {
    const match = db.prepare(`
      SELECT m.*, m.jingcai_handicap as jc_handicap,
             j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
             j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
             j.rebate_rate as j_r, j.share_rate as j_s,
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h, c.rebate_rate as c_r, c.share_rate as c_s
      FROM matches m
      LEFT JOIN jingcai_odds j ON m.match_id = j.match_id
      LEFT JOIN crown_odds c ON m.match_id = c.match_id
      WHERE m.match_id = ?
    `).get(req.params.id) as any;
    
    if (!match) return res.status(404).json({ error: 'Match not found' });
    
    res.json({
      ...match,
      j_share: match.j_s,
      c_share: match.c_s,
      c_h: match.c_h ? JSON.parse(match.c_h) : []
    });
  });

  app.get('/api/arbitrage/opportunities', authenticateToken, (req: AuthRequest, res) => {
    const baseType = req.query.base_type || 'jingcai';
    const opps = db.prepare(`
      SELECT o.*, m.league, m.home_team, m.away_team, m.match_time
      FROM arbitrage_opportunities o
      JOIN matches m ON o.match_id = m.match_id
      WHERE o.base_type = ? AND o.user_id = ?
      ORDER BY o.profit_rate DESC
    `).all(baseType, req.user!.id);
    const rows = opps
      .map((o: any) => ({
        ...o,
        best_strategy: o.best_strategy ? JSON.parse(o.best_strategy) : null
      }))
      .filter((o: any) => ArbitrageEngine.hasAllPositiveSingleTotalProfits(o.best_strategy, 0.01));
    res.json(rows);
  });

  app.get('/api/arbitrage/parlay-opportunities', authenticateToken, (req: AuthRequest, res) => {
    const baseType = req.query.base_type || 'jingcai';
    const opps = db.prepare(`
      SELECT o.*, 
             m1.league as league_1, m1.home_team as home_team_1, m1.away_team as away_team_1, m1.match_time as match_time_1,
             m2.league as league_2, m2.home_team as home_team_2, m2.away_team as away_team_2, m2.match_time as match_time_2,
             j1.win_odds as j1_w, j1.draw_odds as j1_d, j1.lose_odds as j1_l,
             j2.win_odds as j2_w, j2.draw_odds as j2_d, j2.lose_odds as j2_l
      FROM parlay_opportunities o
      JOIN matches m1 ON o.match_id_1 = m1.match_id
      JOIN matches m2 ON o.match_id_2 = m2.match_id
      LEFT JOIN jingcai_odds j1 ON o.match_id_1 = j1.match_id
      LEFT JOIN jingcai_odds j2 ON o.match_id_2 = j2.match_id
      WHERE o.base_type = ? AND o.user_id = ?
      ORDER BY o.profit_rate DESC
    `).all(baseType, req.user!.id);
    const rows = opps
      .map((o: any) => ({
        ...o,
        best_strategy: o.best_strategy ? JSON.parse(o.best_strategy) : null
      }));
    res.json(rows);
  });

  app.get('/api/arbitrage/parlay-opportunities/:id', authenticateToken, (req: AuthRequest, res) => {
    const baseType = (req.query.base_type as string) || 'jingcai';
    const { id } = req.params;
    const row = db.prepare(`
      SELECT o.*,
             m1.league as league_1, m1.home_team as home_team_1, m1.away_team as away_team_1, m1.match_time as match_time_1,
             m2.league as league_2, m2.home_team as home_team_2, m2.away_team as away_team_2, m2.match_time as match_time_2,
             j1.win_odds as j1_w, j1.draw_odds as j1_d, j1.lose_odds as j1_l,
             j2.win_odds as j2_w, j2.draw_odds as j2_d, j2.lose_odds as j2_l
      FROM parlay_opportunities o
      JOIN matches m1 ON o.match_id_1 = m1.match_id
      JOIN matches m2 ON o.match_id_2 = m2.match_id
      LEFT JOIN jingcai_odds j1 ON o.match_id_1 = j1.match_id
      LEFT JOIN jingcai_odds j2 ON o.match_id_2 = j2.match_id
      WHERE o.id = ? AND o.user_id = ? AND o.base_type = ?
      LIMIT 1
    `).get(id, req.user!.id, baseType) as any;

    if (!row) return res.status(404).json({ error: 'Parlay opportunity not found' });
    const parsed = row.best_strategy ? JSON.parse(row.best_strategy) : null;
    res.json({
      ...row,
      best_strategy: parsed
    });
  });

  app.post('/api/arbitrage/rescan', authenticateToken, async (req: AuthRequest, res) => {
    try {
      await CrawlerService.scanOpportunities(req.user!.id);
      res.json({ status: 'ok' });
    } catch (err: any) {
      res.status(500).json({ error: `Re-scan failed: ${err.message}` });
    }
  });

  app.post('/api/arbitrage/calculate', authenticateToken, (req: AuthRequest, res) => {
    const { match_id, jingcai_side, jingcai_market, jingcai_amount, hedge_strategy_name, base_type, integer_unit } = req.body;
    const currentBaseType = base_type || 'jingcai';
    const currentIntegerUnit = Math.max(1000, Number.parseInt(String(integer_unit || 10000), 10) || 10000);
    
    const m = db.prepare(`
      SELECT j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
             j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
             j.rebate_rate as j_r, j.share_rate as j_s,
             m.jingcai_handicap as jc_handicap,
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h, c.rebate_rate as c_r, c.share_rate as c_s
      FROM jingcai_odds j
      JOIN crown_odds c ON j.match_id = c.match_id
      JOIN matches m ON j.match_id = m.match_id
      WHERE j.match_id = ?
    `).get(match_id) as any;

    if (!m) return res.status(404).json({ error: 'Match not found' });

    const jcOdds = {
      W: m.j_w,
      D: m.j_d,
      L: m.j_l,
      HW: m.j_hw,
      HD: m.j_hd,
      HL: m.j_hl,
      handicapLine: m.jc_handicap,
      rebate: m.j_r,
      share: m.j_s
    };
    const crownOdds = { 
      W: m.c_w, D: m.c_d, L: m.c_l, 
      handicaps: m.c_h ? JSON.parse(m.c_h) : [], 
      rebate: m.c_r,
      share: m.c_s
    };

    const opportunities = ArbitrageEngine.findAllOpportunities(jingcai_amount, jcOdds, crownOdds, currentBaseType, currentIntegerUnit);
    const filteredOpportunities = opportunities.filter((o: any) => {
      if (o.jcSide !== jingcai_side) return false;
      if (jingcai_market && o.jc_market !== jingcai_market) return false;
      return true;
    });
    res.json(filteredOpportunities);
  });

  app.post('/api/matches', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { league, round, handicap, jc_handicap, home_team, away_team, match_time, j_w, j_d, j_l, j_hw, j_hd, j_hl, c_w, c_d, c_l, c_h, j_rebate, j_share, c_rebate, c_share } = req.body;
    const match_id = `manual_${Date.now()}`;
    
    const settings = db.prepare('SELECT * FROM system_settings WHERE user_id = ?').all(req.user!.id);
    const settingsMap = settings.reduce((acc: any, curr: any) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});

    const jcRebate = j_rebate !== undefined && j_rebate !== null ? parseFloat(j_rebate) : parseFloat(settingsMap['default_jingcai_rebate'] || '0.13');
    const crownRebate = c_rebate !== undefined && c_rebate !== null ? parseFloat(c_rebate) : parseFloat(settingsMap['default_crown_rebate'] || '0.02');
    const jcShare = j_share !== undefined && j_share !== null ? parseFloat(j_share) : parseFloat(settingsMap['default_jingcai_share'] || '0');
    const crownShare = c_share !== undefined && c_share !== null ? parseFloat(c_share) : parseFloat(settingsMap['default_crown_share'] || '0');

    db.transaction(() => {
      db.prepare(`
        INSERT INTO matches (match_id, league, round, handicap, jingcai_handicap, home_team, away_team, match_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(match_id, league, round || '', handicap || '', jc_handicap || '', home_team, away_team, match_time);
      
      db.prepare(`
        INSERT INTO jingcai_odds (match_id, win_odds, draw_odds, lose_odds, handicap_win_odds, handicap_draw_odds, handicap_lose_odds, rebate_rate, share_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(match_id, j_w || 0, j_d || 0, j_l || 0, j_hw || 0, j_hd || 0, j_hl || 0, jcRebate, jcShare);
      
      db.prepare(`
        INSERT INTO crown_odds (match_id, win_odds, draw_odds, lose_odds, handicaps, rebate_rate, share_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(match_id, c_w || 0, c_d || 0, c_l || 0, JSON.stringify(c_h || []), crownRebate, crownShare);
    })();
    
    void CrawlerService.scanOpportunities(req.user!.id).catch((err) => {
      console.error('scanOpportunities failed after create match:', err);
    });
    res.json({ status: 'ok', match_id });
  });

  app.delete('/api/matches/:id', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    if (!isManualMatchId(id)) {
      return res.status(403).json({ error: 'Only manually added matches can be deleted' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM arbitrage_opportunities WHERE match_id = ?').run(id);
      db.prepare('DELETE FROM parlay_opportunities WHERE match_id_1 = ? OR match_id_2 = ?').run(id, id);
      db.prepare('DELETE FROM bet_records WHERE match_id = ?').run(id);
      db.prepare('DELETE FROM jingcai_odds WHERE match_id = ?').run(id);
      db.prepare('DELETE FROM crown_odds WHERE match_id = ?').run(id);
      db.prepare('DELETE FROM matches WHERE match_id = ?').run(id);
    })();
    res.json({ status: 'ok' });
  });

  app.post('/api/matches/update-odds', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { match_id, league, round, handicap, jc_handicap, home_team, away_team, match_time, j_w, j_d, j_l, j_hw, j_hd, j_hl, c_w, c_d, c_l, c_h, j_rebate, j_share, c_rebate, c_share } = req.body;
    if (!isManualMatchId(match_id)) {
      return res.status(403).json({ error: 'Only manually added matches can be updated' });
    }
    
    db.transaction(() => {
      db.prepare(`
        UPDATE matches 
        SET league = COALESCE(?, league), 
            round = COALESCE(?, round),
            handicap = COALESCE(?, handicap),
            jingcai_handicap = COALESCE(?, jingcai_handicap),
            home_team = COALESCE(?, home_team), 
            away_team = COALESCE(?, away_team), 
            match_time = COALESCE(?, match_time)
        WHERE match_id = ?
      `).run(league, round, handicap, jc_handicap, home_team, away_team, match_time, match_id);

      db.prepare(`
        UPDATE jingcai_odds 
        SET win_odds = ?, draw_odds = ?, lose_odds = ?,
            handicap_win_odds = ?, handicap_draw_odds = ?, handicap_lose_odds = ?,
            rebate_rate = COALESCE(?, rebate_rate),
            share_rate = COALESCE(?, share_rate)
        WHERE match_id = ?
      `).run(j_w, j_d, j_l, j_hw, j_hd, j_hl, j_rebate, j_share, match_id);
      
      db.prepare(`
        UPDATE crown_odds 
        SET win_odds = ?, draw_odds = ?, lose_odds = ?${c_h !== undefined ? ', handicaps = ?' : ''},
            rebate_rate = COALESCE(?, rebate_rate),
            share_rate = COALESCE(?, share_rate)
        WHERE match_id = ?
      `).run(...[c_w, c_d, c_l, ...(c_h !== undefined ? [JSON.stringify(c_h)] : []), c_rebate, c_share, match_id]);
    })();
    
    // 閲嶆柊鎵弿濂楀埄鏈轰細
    void CrawlerService.scanOpportunities(req.user!.id).catch((err) => {
      console.error('scanOpportunities failed after update odds:', err);
    });
    
    res.json({ status: 'ok' });
  });

  // 涓嬫敞璁板綍 API
  app.get('/api/history', authenticateToken, (req: AuthRequest, res) => {
    const records = db.prepare(`
      SELECT br.*, m.home_team, m.away_team, m.league, ao.jingcai_side
      FROM bet_records br
      LEFT JOIN arbitrage_opportunities ao ON br.arbitrage_id = ao.id
      LEFT JOIN matches m ON COALESCE(br.match_id, ao.match_id) = m.match_id
      WHERE br.user_id = ?
      ORDER BY br.created_at DESC
    `).all(req.user!.id);
    res.json(records);
  });

  app.post('/api/history', authenticateToken, (req: AuthRequest, res) => {
    const { match_id, arbitrage_id, jingcai_amount, crown_bets_detail, total_invest, expected_profit } = req.body;
    const result = db.prepare(`
      INSERT INTO bet_records (user_id, match_id, arbitrage_id, jingcai_amount, crown_bets_detail, total_invest, expected_profit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user!.id,
      match_id || null,
      arbitrage_id,
      jingcai_amount,
      JSON.stringify(crown_bets_detail),
      total_invest,
      expected_profit
    );
    
    logAction(req.user!.id, req.user!.username, '璁板綍涓嬫敞', `鎶曞叆: ${total_invest}, 棰勬湡鍒╂鼎: ${expected_profit}`, req.ip || '');
    res.json({ status: 'ok', id: result.lastInsertRowid });
  });

  app.delete('/api/history/:id', authenticateToken, (req: AuthRequest, res) => {
    const { id } = req.params;
    db.prepare('DELETE FROM bet_records WHERE id = ? AND user_id = ?').run(id, req.user!.id);
    res.json({ status: 'ok' });
  });

  app.get('/api/settings', authenticateToken, (req: AuthRequest, res) => {
    const settings = db.prepare('SELECT * FROM system_settings WHERE user_id = ?').all(req.user!.id);
    const settingsMap = settings.reduce((acc: any, curr: any) => {
      let val: any = curr.value;
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(Number(val)) && val !== '') val = Number(val);
      acc[curr.key] = val;
      return acc;
    }, {});
    res.json(settingsMap);
  });

  app.post('/api/settings', authenticateToken, (req: AuthRequest, res) => {
    const values = { ...req.body } as Record<string, any>;
    if (values.scan_interval !== undefined) {
      const parsed = Number.parseInt(String(values.scan_interval), 10);
      values.scan_interval = Number.isFinite(parsed)
        ? Math.max(MIN_SYNC_INTERVAL_SECONDS, parsed)
        : DEFAULT_SYNC_INTERVAL_SECONDS;
    }
    db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(req.user!.id, key, String(value));
      }

      if (values.default_jingcai_rebate !== undefined) {
        db.prepare("UPDATE jingcai_odds SET rebate_rate = ? WHERE match_id IN (SELECT match_id FROM matches WHERE status = 'upcoming')").run(values.default_jingcai_rebate);
      }
      if (values.default_jingcai_share !== undefined) {
        db.prepare("UPDATE jingcai_odds SET share_rate = ? WHERE match_id IN (SELECT match_id FROM matches WHERE status = 'upcoming')").run(values.default_jingcai_share);
      }
      if (values.default_crown_rebate !== undefined) {
        db.prepare("UPDATE crown_odds SET rebate_rate = ? WHERE match_id IN (SELECT match_id FROM matches WHERE status = 'upcoming')").run(values.default_crown_rebate);
      }
      if (values.default_crown_share !== undefined) {
        db.prepare("UPDATE crown_odds SET share_rate = ? WHERE match_id IN (SELECT match_id FROM matches WHERE status = 'upcoming')").run(values.default_crown_share);
      }
    })();
    
    CrawlerService.scanOpportunities(req.user!.id).catch(console.error);
    
    startAutoScan();
    
    res.json({ status: 'ok' });
  });

  app.post('/api/matches/refresh', authenticateToken, async (req: AuthRequest, res) => {
    return res.status(403).json({
      error: 'Manual data sync is disabled. System uses automatic sync only.',
      ...getSyncRefreshStatus(),
    });
  });

  // Vite 鏁村悎
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled Error:', err);
    // Ensure JSON response even for unhandled errors
    if (!res.headersSent) {
      res.status(err.status || 500).json({ 
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR'
      });
    }
  });

  const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // 鍒濆妯℃嫙鐖彇 (浠呭綋鏁版嵁搴撲负绌烘椂)
    try {
      const count = db.prepare('SELECT COUNT(*) as count FROM matches').get() as any;
      if (count.count === 0) {
        console.log('Matches empty, running initial external scraper sync...');
        await CrawlerService.syncFromExternalScraper();
        setLastSyncTimeMs(Date.now());
      } else {
        console.log('Matches exist, skip blocking full scan at startup (will rely on auto scan).');
      }
    } catch (err) {
      console.error('Failed to run initial data check:', err);
    }
  });

  let scanTimer: NodeJS.Timeout | null = null;
  let autoScanRunning = false;

  async function startAutoScan() {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }

    // 鑷姩鎵弿閫昏緫锛?    // 1. 鎵惧埌绠＄悊鍛樿缃殑鎵弿闂撮殧锛堟垨鑰呴粯璁?60s锛?    // 2. 瀹氭湡鐖彇鏁版嵁
    // 3. 鐖彇鍚庝负鎵€鏈夊紑鍚簡鑷姩鎵弿鐨勭敤鎴疯绠楁満浼?    
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as any;
    if (!admin) return;

    const autoScanSetting = db.prepare("SELECT value FROM system_settings WHERE key = 'auto_scan' AND user_id = ?").get(admin.id) as any;
    if (autoScanSetting?.value !== 'true') {
      console.log('Auto scan is disabled globally (by admin)');
      return;
    }

    const interval = getEffectiveSyncIntervalSeconds();
    
    console.log(`Starting global auto scan every ${interval} seconds`);
    scanTimer = setInterval(async () => {
      if (autoScanRunning) {
        console.log('Skip background sync: previous run still in progress');
        return;
      }
      autoScanRunning = true;
      console.log('Running background sync and scan...');
      try {
        await CrawlerService.syncFromExternalScraper();
        setLastSyncTimeMs(Date.now());
      } catch (err) {
        console.error(err);
      } finally {
        autoScanRunning = false;
      }

    }, interval * 1000);
  }

  // 鍒濆鍚姩鑷姩鎵弿
  startAutoScan();
}

startServer();
