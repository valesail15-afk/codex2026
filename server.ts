import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import db, { formatLocalDbDateTime, initDb } from './src/server/db';
import { CrawlerService } from './src/server/crawler';
import { ArbitrageEngine } from './src/server/arbitrageEngine';
import { authenticateToken, authorizeAdmin, generateToken, logAction, AuthRequest, revokeAllUserSessions, revokeSession } from './src/server/auth';
import { invertHandicap, normalizeCrownTarget, parseParlayRawSide, sideToLabel } from './src/shared/oddsText';

const DEFAULT_SYNC_INTERVAL_SECONDS = 90;
const MIN_SYNC_INTERVAL_SECONDS = 60;
const LAST_SYNC_SETTING_KEY = 'last_sync_at';
const ADMIN_ONLY_SETTINGS_KEYS = new Set([
  'hga_enabled',
  'hga_username',
  'hga_password',
  'hga_team_alias_map',
  'hga_runtime_status',
  'hga_runtime_message',
]);
let nextAutoScanAtMs = 0;

function isAdminUser(user?: { role?: string } | null) {
  return user?.role === 'Admin';
}

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

function isAdminHgaEnabled() {
  const adminId = getAdminUserId();
  if (!adminId) return false;
  const row = db
    .prepare("SELECT value FROM system_settings WHERE user_id = ? AND key = 'hga_enabled'")
    .get(adminId) as { value?: string } | undefined;
  return row?.value === 'true';
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
  const adminId = getAdminUserId();
  const intervalSeconds = getEffectiveSyncIntervalSeconds();
  const lastSyncAtMs = getLastSyncTimeMs();
  const hgaEnabled = isAdminHgaEnabled();
  const autoScanRow = adminId
    ? (db
        .prepare("SELECT value FROM system_settings WHERE user_id = ? AND key = 'auto_scan'")
        .get(adminId) as { value?: string } | undefined)
    : undefined;
  const autoScanEnabled = autoScanRow?.value === 'true';
  if (!autoScanEnabled) {
    nextAutoScanAtMs = 0;
    return {
      auto_scan_enabled: false,
      hga_enabled: hgaEnabled,
      interval_seconds: intervalSeconds,
      last_sync_at: lastSyncAtMs > 0 ? new Date(lastSyncAtMs).toISOString() : null,
      next_sync_at: null,
      remaining_seconds: 0,
      can_refresh: false,
    };
  }
  const now = Date.now();
  const scheduledNextSyncAtMs = nextAutoScanAtMs > now
    ? nextAutoScanAtMs
    : (lastSyncAtMs > 0 ? lastSyncAtMs + intervalSeconds * 1000 : now);
  const remainingSeconds = Math.max(0, Math.ceil((scheduledNextSyncAtMs - now) / 1000));

  return {
    auto_scan_enabled: true,
    hga_enabled: hgaEnabled,
    interval_seconds: intervalSeconds,
    last_sync_at: lastSyncAtMs > 0 ? new Date(lastSyncAtMs).toISOString() : null,
    next_sync_at: new Date(scheduledNextSyncAtMs).toISOString(),
    remaining_seconds: remainingSeconds,
    can_refresh: remainingSeconds <= 0,
  };
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

function toDisplayOdds(value: any) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Number(n) : 0;
}

function handicapSideLabel(side: 'W' | 'D' | 'L', handicapLine: string) {
  if (side === 'W') return `主胜(${handicapLine})`;
  if (side === 'D') return `平(${handicapLine})`;
  return `客胜(${invertHandicap(handicapLine)})`;
}

function parseNormalizedCrownLabel(label: string) {
  const matched = String(label || '').trim().match(/^(主胜|平|客胜)(?:\(([^)]+)\))?$/);
  if (!matched) return null;
  return {
    sideKey: matched[1] === '主胜' ? 'W' : matched[1] === '平' ? 'D' : 'L',
    handicapLine: matched[2] || '',
  } as const;
}

function buildSingleJcMatrix(match: any) {
  const handicapLine = String(match.jc_handicap || match.j_h || '0').trim() || '0';
  return {
    standard: {
      W: { key: 'jc_standard_W', label: sideToLabel('W'), odds: toDisplayOdds(match.j_w) },
      D: { key: 'jc_standard_D', label: sideToLabel('D'), odds: toDisplayOdds(match.j_d) },
      L: { key: 'jc_standard_L', label: sideToLabel('L'), odds: toDisplayOdds(match.j_l) },
    },
    handicap: {
      W: { key: 'jc_handicap_W', label: handicapSideLabel('W', handicapLine), odds: toDisplayOdds(match.j_hw) },
      D: { key: 'jc_handicap_D', label: handicapSideLabel('D', handicapLine), odds: toDisplayOdds(match.j_hd) },
      L: { key: 'jc_handicap_L', label: handicapSideLabel('L', handicapLine), odds: toDisplayOdds(match.j_hl) },
    },
  };
}

function buildSingleCrownMatrix(match: any) {
  const handicaps = normalizeCrownHandicaps(match.c_h);
  const grouped = new Map<
    string,
    {
      line: string;
      order: number;
      cells: Record<'W' | 'D' | 'L', { key: string; label: string; odds: number } | null>;
    }
  >();

  for (const item of handicaps) {
    const line = String(item.type || '').trim();
    if (!line) continue;
    const order = Math.abs(Number.parseFloat(line.replace('+', '')));
    if (!grouped.has(line)) {
      grouped.set(line, {
        line,
        order: Number.isFinite(order) ? order : 999,
        cells: { W: null, D: null, L: null },
      });
    }
    const row = grouped.get(line)!;
    row.cells.W = {
      key: `crown_ah_${line}_W`,
      label: handicapSideLabel('W', line),
      odds: toDisplayOdds(item.home_odds),
    };
    row.cells.L = {
      key: `crown_ah_${line}_L`,
      label: handicapSideLabel('L', line),
      odds: toDisplayOdds(item.away_odds),
    };
  }

  const handicapRows = Array.from(grouped.values())
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.line.localeCompare(b.line, 'zh-CN');
    })
    .slice(0, 3)
    .map((row) => ({
      line: row.line,
      cells: row.cells,
    }));

  return {
    standard: {
      W: { key: 'crown_standard_W', label: sideToLabel('W'), odds: toDisplayOdds(match.c_w) },
      D: { key: 'crown_standard_D', label: sideToLabel('D'), odds: toDisplayOdds(match.c_d) },
      L: { key: 'crown_standard_L', label: sideToLabel('L'), odds: toDisplayOdds(match.c_l) },
    },
    handicapRows,
  };
}

function buildSingleHighlightKeys(strategy: any) {
  const keys = new Set<string>();
  const side = String(strategy?.jcSide || '').trim();
  const market = String(strategy?.jc_market || 'normal').trim();
  if (side === 'W' || side === 'D' || side === 'L') {
    keys.add(market === 'handicap' ? `jc_handicap_${side}` : `jc_standard_${side}`);
  }

  const crownBets = [
    ...(strategy?.hg_base_bet?.type ? [strategy.hg_base_bet] : []),
    ...(Array.isArray(strategy?.crown_bets) ? strategy.crown_bets : []),
  ];

  for (const bet of crownBets) {
    const normalized = normalizeCrownTarget(String(bet?.type || ''));
    if (!normalized) continue;
    const parsed = parseNormalizedCrownLabel(normalized);
    if (!parsed) continue;
    const sideKey = parsed.sideKey;
    const handicapLine =
      parsed.handicapLine && sideKey === 'L'
        ? invertHandicap(parsed.handicapLine)
        : parsed.handicapLine;
    if (handicapLine) {
      keys.add(`crown_ah_${handicapLine}_${sideKey}`);
    } else {
      keys.add(`crown_standard_${sideKey}`);
    }
  }

  return Array.from(keys);
}

function createMatrixCell(key: string, label: string, odds: any) {
  return {
    key,
    label,
    odds: toDisplayOdds(odds),
  };
}

function buildParlayJcMatrix(match: any, sideRaw: string, oddsRaw: any, prefix: string) {
  const handicapLine = String(match.jc_handicap || match.j_h || '0').trim() || '0';
  const parsedSide = parseParlayRawSide(String(sideRaw || ''));
  const selectedOdds = toDisplayOdds(oddsRaw);
  const fallbackOdds = parsedSide.isHandicap
    ? parsedSide.side === 'W'
      ? toDisplayOdds(match.j_hw)
      : parsedSide.side === 'D'
        ? toDisplayOdds(match.j_hd)
        : toDisplayOdds(match.j_hl)
    : parsedSide.side === 'W'
      ? toDisplayOdds(match.j_w)
      : parsedSide.side === 'D'
        ? toDisplayOdds(match.j_d)
        : toDisplayOdds(match.j_l);

  const selectedLabel = parsedSide.isHandicap
    ? handicapSideLabel(parsedSide.side, handicapLine)
    : sideToLabel(parsedSide.side);

  return {
    standard: {
      W: createMatrixCell(`${prefix}_jc_standard_W`, sideToLabel('W'), match.j_w),
      D: createMatrixCell(`${prefix}_jc_standard_D`, sideToLabel('D'), match.j_d),
      L: createMatrixCell(`${prefix}_jc_standard_L`, sideToLabel('L'), match.j_l),
    },
    handicap: {
      W: createMatrixCell(`${prefix}_jc_handicap_W`, handicapSideLabel('W', handicapLine), match.j_hw),
      D: createMatrixCell(`${prefix}_jc_handicap_D`, handicapSideLabel('D', handicapLine), match.j_hd),
      L: createMatrixCell(`${prefix}_jc_handicap_L`, handicapSideLabel('L', handicapLine), match.j_hl),
    },
    selected: {
      key: `${prefix}_${parsedSide.isHandicap ? 'jc_handicap' : 'jc_standard'}_${parsedSide.side}`,
      label: selectedLabel,
      odds: selectedOdds || fallbackOdds,
    },
  };
}

function buildParlayCrownMatrix(match: any, strategy: any, matchIndex: number, prefix: string) {
  const crownMatrix = buildSingleCrownMatrix(match);
  const strategyBets = Array.isArray(strategy?.crown_bets)
    ? strategy.crown_bets.filter((bet: any) => Number(bet?.match_index || 0) === matchIndex)
    : [];
  const handicapBet = strategyBets.find((bet: any) => /\([^)]+\)/.test(normalizeCrownTarget(String(bet?.type || ''))));
  const handicapMatch = handicapBet ? parseNormalizedCrownLabel(normalizeCrownTarget(String(handicapBet.type || ''))) : null;
  const preferredLine = handicapMatch?.handicapLine || '';
  const preferredRow = preferredLine
    ? crownMatrix.handicapRows.find((row: any) => String(row.line) === preferredLine)
    : crownMatrix.handicapRows[0] || null;

  return {
    standard: {
      W: createMatrixCell(`${prefix}_crown_standard_W`, sideToLabel('W'), match.c_w),
      D: createMatrixCell(`${prefix}_crown_standard_D`, sideToLabel('D'), match.c_d),
      L: createMatrixCell(`${prefix}_crown_standard_L`, sideToLabel('L'), match.c_l),
    },
    handicap: preferredRow
      ? {
          line: preferredRow.line,
          cells: {
            W: preferredRow.cells?.W
              ? createMatrixCell(`${prefix}_crown_ah_${preferredRow.line}_W`, handicapSideLabel('W', preferredRow.line), preferredRow.cells.W.odds)
              : null,
            D: preferredRow.cells?.D
              ? createMatrixCell(`${prefix}_crown_ah_${preferredRow.line}_D`, handicapSideLabel('D', preferredRow.line), preferredRow.cells.D.odds)
              : null,
            L: preferredRow.cells?.L
              ? createMatrixCell(`${prefix}_crown_ah_${preferredRow.line}_L`, handicapSideLabel('L', preferredRow.line), preferredRow.cells.L.odds)
              : null,
          },
        }
      : {
          line: '',
          cells: { W: null, D: null, L: null },
        },
  };
}

function buildParlayHighlightKeys(sideRaw: string, strategy: any, matchIndex: number, prefix: string) {
  const keys = new Set<string>();
  const parsedSide = parseParlayRawSide(String(sideRaw || ''));
  keys.add(`${prefix}_${parsedSide.isHandicap ? 'jc_handicap' : 'jc_standard'}_${parsedSide.side}`);

  for (const bet of strategy?.crown_bets || []) {
    if (Number(bet?.match_index || 0) !== matchIndex) continue;
    const normalized = normalizeCrownTarget(String(bet?.type || ''));
    const parsed = parseNormalizedCrownLabel(normalized);
    if (!parsed) continue;
    const sideKey = parsed.sideKey;
    const handicapLine = parsed.handicapLine;
    keys.add(handicapLine ? `${prefix}_crown_ah_${handicapLine}_${sideKey}` : `${prefix}_crown_standard_${sideKey}`);
  }

  return Array.from(keys);
}

function buildParlayDisplayRecord(row: any) {
  const strategy = row.best_strategy ? (typeof row.best_strategy === 'string' ? JSON.parse(row.best_strategy) : row.best_strategy) : null;
  return {
    ...row,
    best_strategy: strategy,
    match_1_matrix: {
      jc: buildParlayJcMatrix(
        {
          jc_handicap: row.jc_handicap_1,
          j_w: row.j1_w,
          j_d: row.j1_d,
          j_l: row.j1_l,
          j_hw: row.j1_hw,
          j_hd: row.j1_hd,
          j_hl: row.j1_hl,
        },
        row.side_1,
        row.odds_1,
        'm1'
      ),
      crown: buildParlayCrownMatrix(
        {
          c_w: row.c1_w,
          c_d: row.c1_d,
          c_l: row.c1_l,
          c_h: row.c1_h,
        },
        strategy,
        0,
        'm1'
      ),
      highlight_keys: buildParlayHighlightKeys(row.side_1, strategy, 0, 'm1'),
    },
    match_2_matrix: {
      jc: buildParlayJcMatrix(
        {
          jc_handicap: row.jc_handicap_2,
          j_w: row.j2_w,
          j_d: row.j2_d,
          j_l: row.j2_l,
          j_hw: row.j2_hw,
          j_hd: row.j2_hd,
          j_hl: row.j2_hl,
        },
        row.side_2,
        row.odds_2,
        'm2'
      ),
      crown: buildParlayCrownMatrix(
        {
          c_w: row.c2_w,
          c_d: row.c2_d,
          c_l: row.c2_l,
          c_h: row.c2_h,
        },
        strategy,
        1,
        'm2'
      ),
      highlight_keys: buildParlayHighlightKeys(row.side_2, strategy, 1, 'm2'),
    },
  };
}

function isManualMatchId(matchId?: string) {
  return typeof matchId === 'string' && matchId.startsWith('manual_');
}

function parseSingleBaseType(raw: any): 'jingcai' | 'crown' | 'hg' | null {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'jingcai' || v === 'crown' || v === 'hg') return v;
  return null;
}

function parseParlayBaseType(raw: any): 'jingcai' | 'crown' | null {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'jingcai' || v === 'crown') return v;
  return null;
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

  // Initialize database
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
        return res.status(400).json({ error: 'username 鍜?password 蹇呭～', code: 'INVALID_LOGIN_PAYLOAD' });
      }
      const ip = req.ip || '';
      const userAgent = String(req.headers['user-agent'] || '');
      const security = getAdminSecuritySettings();

      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername) as any;

      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (isUserExpired(user)) {
        db.prepare("UPDATE users SET status = 'expired', updated_at = ? WHERE id = ?").run(formatLocalDbDateTime(), user.id);
        revokeAllUserSessions(user.id);
        return res.status(403).json({ error: '账户已到期，请联系管理员续费。', code: 'ACCOUNT_EXPIRED', expires_at: user.expires_at });
      }

      const lockUntilTs = user.lock_until ? new Date(user.lock_until).getTime() : 0;
      if (user.status === 'locked' || user.is_locked || (lockUntilTs && lockUntilTs > Date.now())) {
        return res.status(403).json({ error: '账户已锁定', code: 'ACCOUNT_LOCKED', lock_until: user.lock_until || null });
      }

      const passwordMatch = bcrypt.compareSync(normalizedPassword, user.password);
      if (!passwordMatch) {
        const now = new Date();
        const nowText = formatLocalDbDateTime(now);
        const failCount = (user.login_fail_count || 0) + 1;
        const lockMinutes = failCount >= 10 ? security.loginLockLongMinutes : failCount >= 5 ? security.loginLockShortMinutes : 0;
        if (lockMinutes > 0) {
          const lockUntil = new Date(now.getTime() + lockMinutes * 60 * 1000);
          db.prepare("UPDATE users SET login_fail_count = ?, is_locked = 1, status = 'locked', lock_until = ?, updated_at = ? WHERE id = ?")
            .run(failCount, formatLocalDbDateTime(lockUntil), nowText, user.id);
        } else {
          db.prepare('UPDATE users SET login_fail_count = ?, updated_at = ? WHERE id = ?').run(failCount, nowText, user.id);
        }
        logAction(user.id, user.username, 'login_failed', `Failed login attempt ${failCount}`, ip);
        return res.status(401).json({ error: 'Invalid username or password', code: lockMinutes > 0 ? 'ACCOUNT_LOCKED' : undefined });
      }

      {
        const nowText = formatLocalDbDateTime();
        db.prepare("UPDATE users SET login_fail_count = 0, is_locked = 0, status = 'normal', lock_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?")
          .run(nowText, nowText, user.id);
      }

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

      {
        const now = new Date();
        const nowText = formatLocalDbDateTime(now);
        const expiresAt = formatLocalDbDateTime(new Date(now.getTime() + 24 * 60 * 60 * 1000));
        db.prepare("INSERT INTO user_sessions (session_id, user_id, device_id, ip, user_agent, is_active, created_at, last_activity_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)")
          .run(sid, user.id, deviceId, ip, userAgent, nowText, nowText, expiresAt);
      }

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
      db.prepare("UPDATE users SET status = 'expired', updated_at = ? WHERE id = ?").run(formatLocalDbDateTime(), userId);
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
      const nowText = formatLocalDbDateTime();
      const result = db.prepare('INSERT INTO users (username, password, role, package_name, expires_at, status, max_duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          username,
          hashedPassword,
          role,
          package_name || '鍩虹濂楅',
          expires_at || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          'normal',
          max_duration || 0,
          nowText,
          nowText
        );
      
      const defaultSettings = [
        ['auto_scan', 'false'],
        ['sound_alert', 'false'],
        ['scan_interval', String(DEFAULT_SYNC_INTERVAL_SECONDS)],
        [LAST_SYNC_SETTING_KEY, '0'],
        ['login_lock_short_minutes', '10'],
        ['login_lock_long_minutes', '120'],
        ['session_mode', 'single'],
        ['max_sessions', '1'],
        ['hga_enabled', 'false'],
        ['hga_username', ''],
        ['hga_password', ''],
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
        db.prepare(`UPDATE users SET username = ?, password = ?, role = ?, package_name = ?, expires_at = ?, status = ?, is_locked = CASE WHEN ? = 'locked' THEN 1 ELSE 0 END, max_duration = ?, updated_at = ? WHERE id = ?`)
          .run(username, hashedPassword, role, package_name || '鍩虹濂楅', expires_at || null, status || 'normal', status || 'normal', max_duration || 0, formatLocalDbDateTime(), id);
      } else {
        db.prepare(`UPDATE users SET username = ?, role = ?, package_name = ?, expires_at = ?, status = ?, is_locked = CASE WHEN ? = 'locked' THEN 1 ELSE 0 END, max_duration = ?, updated_at = ? WHERE id = ?`)
          .run(username, role, package_name || '鍩虹濂楅', expires_at || null, status || 'normal', status || 'normal', max_duration || 0, formatLocalDbDateTime(), id);
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
    db.prepare("UPDATE users SET package_name = COALESCE(?, package_name), expires_at = ?, status = 'normal', is_locked = 0, lock_until = NULL, updated_at = ? WHERE id = ?")
      .run(package_name || null, target, formatLocalDbDateTime(), id);
    logAction(req.user!.id, req.user!.username, 'user_renew', `Renew user ID=${id} to ${target}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/freeze', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    if (Number(id) === req.user!.id) {
      return res.status(400).json({ error: '管理员不能冻结自己' });
    }
    db.prepare("UPDATE users SET status = 'locked', is_locked = 1, lock_until = ?, updated_at = ? WHERE id = ?").run(formatLocalDbDateTime(new Date(Date.now() + 3650 * 24 * 3600 * 1000)), formatLocalDbDateTime(), id);
    revokeAllUserSessions(Number(id));
    logAction(req.user!.id, req.user!.username, 'user_freeze', `Freeze user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/unfreeze', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    db.prepare("UPDATE users SET status = CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE 'normal' END, is_locked = 0, lock_until = NULL, login_fail_count = 0, updated_at = ? WHERE id = ?").run(formatLocalDbDateTime(), id);
    logAction(req.user!.id, req.user!.username, 'user_unfreeze', `Unfreeze user ID=${id}`, req.ip || '');
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/users/:id/reset-password', authenticateToken, authorizeAdmin, (req: AuthRequest, res) => {
    const { id } = req.params;
    const { password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const hash = bcrypt.hashSync(String(password), 10);
    db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?').run(hash, formatLocalDbDateTime(), id);
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
    db.prepare("UPDATE users SET login_fail_count = 0, is_locked = 0, lock_until = NULL, status = CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE 'normal' END, updated_at = ? WHERE id = ?").run(formatLocalDbDateTime(), id);
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

  // API 鐠侯垳鏁?(Protected)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/matches', authenticateToken, (req: AuthRequest, res) => {
    try {
      const matches = db.prepare(`
        SELECT m.*, m.jingcai_handicap as jc_handicap,
               j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
               j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
               j.rebate_rate as j_r, j.share_rate as j_s,
               c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h, c.rebate_rate as c_r, c.share_rate as c_s
        FROM matches m
        LEFT JOIN jingcai_odds j ON m.match_id = j.match_id
        LEFT JOIN crown_odds c ON m.match_id = c.match_id
        WHERE m.match_id LIKE 'manual_%'
           OR m.created_at = (
             SELECT MAX(created_at)
             FROM matches
             WHERE match_id NOT LIKE 'manual_%'
           )
        ORDER BY m.match_time ASC
      `).all();
      res.json(
        matches
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
    const baseType = parseSingleBaseType(req.query.base_type);
    if (!baseType) {
      return res.status(400).json({ error: 'Invalid base_type, expected jingcai|crown|hg' });
    }
    const opps = db.prepare(`
      SELECT o.*, m.league, m.home_team, m.away_team, m.match_time, m.jingcai_handicap as jc_handicap,
             j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
             j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h
      FROM arbitrage_opportunities o
      JOIN matches m ON o.match_id = m.match_id
      LEFT JOIN jingcai_odds j ON o.match_id = j.match_id
      LEFT JOIN crown_odds c ON o.match_id = c.match_id
      WHERE o.base_type = ? AND o.user_id = ?
      ORDER BY o.profit_rate DESC
    `).all(baseType, req.user!.id);
    const rows = opps
      .map((o: any) => ({
        ...o,
        best_strategy: o.best_strategy ? JSON.parse(o.best_strategy) : null,
        jc_matrix: buildSingleJcMatrix(o),
        crown_matrix: buildSingleCrownMatrix(o),
      }))
      .map((o: any) => ({
        ...o,
        highlight_keys: buildSingleHighlightKeys(o.best_strategy),
      }))
      .filter((o: any) => ArbitrageEngine.hasAllPositiveSingleTotalProfits(o.best_strategy, 0.01));
    res.json(rows);
  });

  app.get('/api/arbitrage/parlay-opportunities', authenticateToken, (req: AuthRequest, res) => {
    const baseType = parseParlayBaseType(req.query.base_type);
    if (!baseType) {
      return res.status(400).json({ error: 'Invalid base_type, expected jingcai|crown' });
    }
    const opps = db.prepare(`
      SELECT o.*, 
             m1.league as league_1, m1.home_team as home_team_1, m1.away_team as away_team_1, m1.match_time as match_time_1, m1.jingcai_handicap as jc_handicap_1,
             m2.league as league_2, m2.home_team as home_team_2, m2.away_team as away_team_2, m2.match_time as match_time_2, m2.jingcai_handicap as jc_handicap_2,
             j1.win_odds as j1_w, j1.draw_odds as j1_d, j1.lose_odds as j1_l,
             j1.handicap_win_odds as j1_hw, j1.handicap_draw_odds as j1_hd, j1.handicap_lose_odds as j1_hl,
             j2.win_odds as j2_w, j2.draw_odds as j2_d, j2.lose_odds as j2_l,
             j2.handicap_win_odds as j2_hw, j2.handicap_draw_odds as j2_hd, j2.handicap_lose_odds as j2_hl,
             c1.win_odds as c1_w, c1.draw_odds as c1_d, c1.lose_odds as c1_l, c1.handicaps as c1_h,
             c2.win_odds as c2_w, c2.draw_odds as c2_d, c2.lose_odds as c2_l, c2.handicaps as c2_h
      FROM parlay_opportunities o
      JOIN matches m1 ON o.match_id_1 = m1.match_id
      JOIN matches m2 ON o.match_id_2 = m2.match_id
      LEFT JOIN jingcai_odds j1 ON o.match_id_1 = j1.match_id
      LEFT JOIN jingcai_odds j2 ON o.match_id_2 = j2.match_id
      LEFT JOIN crown_odds c1 ON o.match_id_1 = c1.match_id
      LEFT JOIN crown_odds c2 ON o.match_id_2 = c2.match_id
      WHERE o.base_type = ? AND o.user_id = ?
      ORDER BY o.profit_rate DESC
    `).all(baseType, req.user!.id);
    const rows = opps.map((o: any) => buildParlayDisplayRecord(o));
    res.json(rows);
  });

  app.get('/api/arbitrage/parlay-opportunities/:id', authenticateToken, (req: AuthRequest, res) => {
    const baseType = parseParlayBaseType(req.query.base_type);
    if (!baseType) {
      return res.status(400).json({ error: 'Invalid base_type, expected jingcai|crown' });
    }
    const { id } = req.params;
    const row = db.prepare(`
      SELECT o.*,
             m1.league as league_1, m1.home_team as home_team_1, m1.away_team as away_team_1, m1.match_time as match_time_1, m1.jingcai_handicap as jc_handicap_1,
             m2.league as league_2, m2.home_team as home_team_2, m2.away_team as away_team_2, m2.match_time as match_time_2, m2.jingcai_handicap as jc_handicap_2,
             j1.win_odds as j1_w, j1.draw_odds as j1_d, j1.lose_odds as j1_l,
             j1.handicap_win_odds as j1_hw, j1.handicap_draw_odds as j1_hd, j1.handicap_lose_odds as j1_hl,
             j2.win_odds as j2_w, j2.draw_odds as j2_d, j2.lose_odds as j2_l,
             j2.handicap_win_odds as j2_hw, j2.handicap_draw_odds as j2_hd, j2.handicap_lose_odds as j2_hl,
             c1.win_odds as c1_w, c1.draw_odds as c1_d, c1.lose_odds as c1_l, c1.handicaps as c1_h,
             c2.win_odds as c2_w, c2.draw_odds as c2_d, c2.lose_odds as c2_l, c2.handicaps as c2_h
      FROM parlay_opportunities o
      JOIN matches m1 ON o.match_id_1 = m1.match_id
      JOIN matches m2 ON o.match_id_2 = m2.match_id
      LEFT JOIN jingcai_odds j1 ON o.match_id_1 = j1.match_id
      LEFT JOIN jingcai_odds j2 ON o.match_id_2 = j2.match_id
      LEFT JOIN crown_odds c1 ON o.match_id_1 = c1.match_id
      LEFT JOIN crown_odds c2 ON o.match_id_2 = c2.match_id
      WHERE o.id = ? AND o.user_id = ? AND o.base_type = ?
      LIMIT 1
    `).get(id, req.user!.id, baseType) as any;

    if (!row) return res.status(404).json({ error: 'Parlay opportunity not found' });
    res.json(buildParlayDisplayRecord(row));
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
    const currentBaseType = parseSingleBaseType(base_type || 'jingcai');
    if (!currentBaseType) {
      return res.status(400).json({ error: 'Invalid base_type, expected jingcai|crown|hg' });
    }
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

    const settingsRows = db
      .prepare(
        "SELECT key, value FROM system_settings WHERE user_id = ? AND key IN ('default_jingcai_rebate','default_jingcai_share','default_crown_rebate','default_crown_share')"
      )
      .all(req.user!.id) as Array<{ key: string; value: string }>;
    const settingsMap = settingsRows.reduce((acc: Record<string, string>, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    const configuredJcRebate = Number.parseFloat(settingsMap['default_jingcai_rebate'] || '');
    const configuredJcShare = Number.parseFloat(settingsMap['default_jingcai_share'] || '');
    const configuredCrownRebate = Number.parseFloat(settingsMap['default_crown_rebate'] || '');
    const configuredCrownShare = Number.parseFloat(settingsMap['default_crown_share'] || '');

    const jcOdds = {
      W: m.j_w,
      D: m.j_d,
      L: m.j_l,
      HW: m.j_hw,
      HD: m.j_hd,
      HL: m.j_hl,
      handicapLine: m.jc_handicap,
      rebate: Number.isFinite(configuredJcRebate) ? configuredJcRebate : m.j_r,
      share: Number.isFinite(configuredJcShare) ? configuredJcShare : m.j_s
    };
    const crownOdds = { 
      W: m.c_w, D: m.c_d, L: m.c_l, 
      handicaps: m.c_h ? JSON.parse(m.c_h) : [], 
      rebate: Number.isFinite(configuredCrownRebate) ? configuredCrownRebate : m.c_r,
      share: Number.isFinite(configuredCrownShare) ? configuredCrownShare : m.c_s
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
      const nowText = formatLocalDbDateTime();
      db.prepare(`
        INSERT INTO matches (match_id, league, round, handicap, jingcai_handicap, home_team, away_team, match_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(match_id, league, round || '', handicap || '', jc_handicap || '', home_team, away_team, match_time, nowText, nowText);
      
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
            match_time = COALESCE(?, match_time),
            updated_at = ?
        WHERE match_id = ?
      `).run(league, round, handicap, jc_handicap, home_team, away_team, match_time, formatLocalDbDateTime(), match_id);

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
    
    // 闁插秵鏌婇幍顐ｅ伎婵傛鍩勯張杞扮窗
    void CrawlerService.scanOpportunities(req.user!.id).catch((err) => {
      console.error('scanOpportunities failed after update odds:', err);
    });
    
    res.json({ status: 'ok' });
  });

  // 娑撳鏁炵拋鏉跨秿 API
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
    
    logAction(req.user!.id, req.user!.username, '鐠佹澘缍嶆稉瀣暈', `閹舵洖鍙? ${total_invest}, 妫板嫭婀￠崚鈺傞紟: ${expected_profit}`, req.ip || '');
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
    if (!isAdminUser(req.user)) {
      for (const key of ADMIN_ONLY_SETTINGS_KEYS) {
        delete settingsMap[key];
      }
      return res.json(settingsMap);
    }

    const hgaStatus = CrawlerService.getHgaStatus();
    const hgaMappings = CrawlerService.getHgaMappingSettings();
    const hgaDefaultTeamAliasMap = CrawlerService.getDefaultHgaTeamAliasMapText();
    settingsMap.hga_enabled = settingsMap.hga_enabled === true;
    settingsMap.hga_username = String(settingsMap.hga_username || '');
    settingsMap.hga_password = String(settingsMap.hga_password || '');
    settingsMap.hga_team_alias_map = String(settingsMap.hga_team_alias_map || hgaMappings.hga_team_alias_map || '');
    settingsMap.hga_team_alias_map_default = String(hgaDefaultTeamAliasMap || '');
    settingsMap.hga_password_configured = hgaStatus.password_configured;
    settingsMap.hga_status = hgaStatus.status;
    settingsMap.hga_status_message = hgaStatus.message;
    settingsMap.hga_blocked_until = hgaStatus.blocked_until;
    delete settingsMap.hga_runtime_status;
    delete settingsMap.hga_runtime_message;
    res.json(settingsMap);
  });

  app.post('/api/settings', authenticateToken, (req: AuthRequest, res) => {
    const values = { ...req.body } as Record<string, any>;
    if (!isAdminUser(req.user)) {
      for (const key of ADMIN_ONLY_SETTINGS_KEYS) {
        delete values[key];
      }
    }
    if (values.scan_interval !== undefined) {
      const parsed = Number.parseInt(String(values.scan_interval), 10);
      values.scan_interval = Number.isFinite(parsed)
        ? Math.max(MIN_SYNC_INTERVAL_SECONDS, parsed)
        : DEFAULT_SYNC_INTERVAL_SECONDS;
    }
    if (isAdminUser(req.user)) {
      if (values.hga_enabled !== undefined) {
        values.hga_enabled = values.hga_enabled === true;
        if (values.hga_enabled) {
          CrawlerService.resetHgaRuntimeState();
        }
      }
      if (values.hga_username !== undefined) {
        values.hga_username = String(values.hga_username || '').trim();
      }
      if (values.hga_password !== undefined) {
        const nextPassword = String(values.hga_password || '').trim();
        if (!nextPassword) {
          delete values.hga_password;
        } else {
          values.hga_password = nextPassword;
        }
      }
      if (values.hga_team_alias_map !== undefined) {
        try {
          const parsed = JSON.parse(String(values.hga_team_alias_map || '').trim());
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return res.status(400).json({ status: 'failed', message: 'HGA 鐞冮槦鍒悕鏄犲皠蹇呴』鏄?JSON 瀵硅薄' });
          }
          values.hga_team_alias_map = CrawlerService.saveHgaTeamAliasMap(JSON.stringify(parsed, null, 2));
        } catch {
          return res.status(400).json({ status: 'failed', message: 'HGA 鐞冮槦鍒悕鏄犲皠鏍煎紡鏃犳晥锛岃濉啓 JSON 瀵硅薄' });
        }
      }
    }
    db.transaction(() => {
      if (isAdminUser(req.user)) {
        db.prepare("DELETE FROM system_settings WHERE user_id = ? AND key = 'hga_fixture_pair_alias_map'").run(req.user!.id);
      }
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
    CrawlerService.resetHgaMappingCache();
    
    startAutoScan();
    
    res.json({ status: 'ok' });
  });

  app.post('/api/settings/hga/test-login', authenticateToken, authorizeAdmin, async (req: AuthRequest, res) => {
    try {
      const username = req.body?.hga_username !== undefined ? String(req.body.hga_username || '').trim() : undefined;
      const rawPassword = req.body?.hga_password !== undefined ? String(req.body.hga_password || '').trim() : undefined;
      const password = rawPassword && rawPassword !== '******' ? rawPassword : undefined;
      const result = await CrawlerService.testHgaLogin({ username, password });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({
        status: 'failed',
        message: err?.message || 'HGA 鐧诲綍娴嬭瘯澶辫触',
      });
    }
  });

  app.post('/api/matches/refresh', authenticateToken, async (req: AuthRequest, res) => {
    return res.status(403).json({
      error: 'Manual data sync is disabled. System uses automatic sync only.',
      ...getSyncRefreshStatus(),
    });
  });

  // Vite development / production bootstrap
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
    // 閸掓繂顫愬Ο鈩冨珯閻栴剙褰?(娴犲懎缍嬮弫鐗堝祦鎼存挷璐熺粚鐑樻)
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
    nextAutoScanAtMs = 0;

    // 閼奉亜濮╅幍顐ｅ伎闁槒绶敍?    // 1. 閹垫儳鍩岀粻锛勬倞閸涙顔曠純顔炬畱閹殿偅寮块梻鎾閿涘牊鍨ㄩ懓鍛寸帛鐠?60s閿?    // 2. 鐎规碍婀￠悥顒€褰囬弫鐗堝祦
    // 3. 閻栴剙褰囬崥搴濊礋閹碘偓閺堝绱戦崥顖欑啊閼奉亜濮╅幍顐ｅ伎閻ㄥ嫮鏁ら幋鐤吀缁犳婧€娴?    
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as any;
    if (!admin) return;

    const autoScanSetting = db.prepare("SELECT value FROM system_settings WHERE key = 'auto_scan' AND user_id = ?").get(admin.id) as any;
    if (autoScanSetting?.value !== 'true') {
      console.log('Auto scan is disabled globally (by admin)');
      return;
    }

    const interval = getEffectiveSyncIntervalSeconds();
    nextAutoScanAtMs = Date.now() + interval * 1000;
    
    console.log(`Starting global auto scan every ${interval} seconds`);
    scanTimer = setInterval(async () => {
      if (autoScanRunning) {
        console.log('Skip background sync: previous run still in progress');
        return;
      }
      nextAutoScanAtMs = Date.now() + interval * 1000;
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

  // 閸掓繂顫愰崥顖氬З閼奉亜濮╅幍顐ｅ伎
  startAutoScan();
}

startServer();
