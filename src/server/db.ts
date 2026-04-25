import Database from 'better-sqlite3';
import path from 'path';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const dbPath = path.resolve(process.cwd(), 'arbitrage.db');
const db = new Database(dbPath);

export function formatLocalDbDateTime(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// 初始化数据库表
export function initDb() {
  // 迁移：处理 matches 表的架构变更 (移除 user_id 实现数据统一)
  try {
    const matchTableInfo = db.prepare("PRAGMA table_info(matches)").all() as any[];
    if (matchTableInfo.length > 0) {
      const hasUserId = matchTableInfo.some(col => col.name === 'user_id');
      if (hasUserId) {
        console.log('Detected user_id in matches table, dropping tables for unification...');
        db.exec("DROP TABLE IF EXISTS jingcai_odds");
        db.exec("DROP TABLE IF EXISTS crown_odds");
        db.exec("DROP TABLE IF EXISTS arbitrage_opportunities");
        db.exec("DROP TABLE IF EXISTS parlay_opportunities");
        db.exec("DROP TABLE IF EXISTS matches");
      }
    }
  } catch (e) {}

  // 迁移：处理 odds 表的架构变更
  try {
    const tableInfo = db.prepare("PRAGMA table_info(jingcai_odds)").all() as any[];
    if (tableInfo.length > 0) {
      const hasUserId = tableInfo.some(col => col.name === 'user_id');
      if (hasUserId) {
        db.exec("DROP TABLE IF EXISTS jingcai_odds");
        db.exec("DROP TABLE IF EXISTS crown_odds");
        db.exec("DROP TABLE IF EXISTS arbitrage_opportunities");
        db.exec("DROP TABLE IF EXISTS parlay_opportunities");
      }
    }
  } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'User', -- 'Admin' or 'User'
      package_name TEXT DEFAULT '基础套餐',
      expires_at DATETIME,
      status TEXT DEFAULT 'normal', -- normal | expired | locked
      max_duration INTEGER DEFAULT 3600, -- 预设使用时长阈值 (秒)
      used_duration INTEGER DEFAULT 0, -- 已使用时长 (秒)
      last_login_at DATETIME,
      last_activity_at DATETIME,
      login_fail_count INTEGER DEFAULT 0,
      is_locked BOOLEAN DEFAULT 0,
      lock_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      device_id TEXT,
      ip TEXT,
      user_agent TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      revoked_at DATETIME,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT,
      content TEXT,
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT UNIQUE,
      league TEXT,
      round TEXT,
      handicap TEXT,
      jingcai_handicap TEXT,
      home_team TEXT,
      away_team TEXT,
      match_time DATETIME,
      status TEXT DEFAULT 'upcoming',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jingcai_odds (
      match_id TEXT PRIMARY KEY,
      win_odds REAL,
      draw_odds REAL,
      lose_odds REAL,
      handicap_win_odds REAL,
      handicap_draw_odds REAL,
      handicap_lose_odds REAL,
      rebate_rate REAL DEFAULT 0.13,
      share_rate REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(match_id) REFERENCES matches(match_id)
    );

    CREATE TABLE IF NOT EXISTS crown_odds (
      match_id TEXT PRIMARY KEY,
      win_odds REAL,
      draw_odds REAL,
      lose_odds REAL,
      handicaps TEXT, -- JSON string
      goal_odds TEXT, -- JSON string
      over_under_odds TEXT, -- JSON string
      rebate_rate REAL DEFAULT 0.02,
      share_rate REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(match_id) REFERENCES matches(match_id)
    );

    CREATE TABLE IF NOT EXISTS arbitrage_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      match_id TEXT,
      jingcai_side TEXT,
      jingcai_odds REAL,
      best_strategy TEXT, -- JSON string
      profit_rate REAL,
      base_type TEXT DEFAULT 'jingcai', -- 'jingcai' or 'crown'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(match_id) REFERENCES matches(match_id)
    );

    CREATE TABLE IF NOT EXISTS parlay_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      match_id_1 TEXT,
      match_id_2 TEXT,
      side_1 TEXT,
      side_2 TEXT,
      odds_1 REAL,
      odds_2 REAL,
      combined_odds REAL,
      best_strategy TEXT, -- JSON string
      profit_rate REAL,
      base_type TEXT DEFAULT 'jingcai', -- 'jingcai' or 'crown'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(match_id_1) REFERENCES matches(match_id),
      FOREIGN KEY(match_id_2) REFERENCES matches(match_id)
    );

    CREATE TABLE IF NOT EXISTS bet_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      match_id TEXT,
      arbitrage_id INTEGER,
      jingcai_amount REAL,
      crown_bets_detail TEXT, -- JSON string
      total_invest REAL,
      expected_profit REAL,
      actual_result TEXT,
      actual_profit REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS scrape_health_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT DEFAULT 'external',
      status TEXT NOT NULL, -- ok | unchanged | skipped | empty | error
      fetched_total INTEGER DEFAULT 0,
      filtered_total INTEGER DEFAULT 0,
      synced_total INTEGER DEFAULT 0,
      complete_total INTEGER DEFAULT 0,
      hga_status TEXT DEFAULT 'unknown', -- ok | empty | failed | timeout | unknown
      hga_count INTEGER DEFAULT 0,
      base_count INTEGER DEFAULT 0,
      merged_count INTEGER DEFAULT 0,
      playwright_fallback_used INTEGER DEFAULT 0,
      note TEXT,
      duration_ms INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 处理 system_settings 的迁移
  try {
    const tableInfo = db.prepare("PRAGMA table_info(system_settings)").all() as any[];
    const hasUserId = tableInfo.some(col => col.name === 'user_id');
    if (!hasUserId) {
      const oldSettings = db.prepare("SELECT * FROM system_settings").all() as any[];
      db.exec("DROP TABLE system_settings");
      db.exec(`
        CREATE TABLE system_settings (
          user_id INTEGER,
          key TEXT,
          value TEXT,
          PRIMARY KEY (user_id, key),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
      `);
      // 迁移旧数据将在管理员创建后进行
      (global as any)._oldSettings = oldSettings;
    }
  } catch (e) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        user_id INTEGER,
        key TEXT,
        value TEXT,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);
  }

  // 迁移：添加 user_id 列（如果不存在）
  try {
    db.exec(`ALTER TABLE matches ADD COLUMN round TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE matches ADD COLUMN handicap TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE matches ADD COLUMN jingcai_handicap TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE jingcai_odds ADD COLUMN handicap_win_odds REAL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE jingcai_odds ADD COLUMN handicap_draw_odds REAL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE jingcai_odds ADD COLUMN handicap_lose_odds REAL`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE arbitrage_opportunities ADD COLUMN user_id INTEGER`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE parlay_opportunities ADD COLUMN user_id INTEGER`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE bet_records ADD COLUMN user_id INTEGER`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE bet_records ADD COLUMN match_id TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN package_name TEXT DEFAULT '基础套餐'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN expires_at DATETIME`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'normal'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN lock_until DATETIME`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE crown_odds ADD COLUMN goal_odds TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE crown_odds ADD COLUMN over_under_odds TEXT`);
  } catch (e) {}

  db.exec(`
    UPDATE users
    SET package_name = COALESCE(package_name, '基础套餐'),
        status = CASE
          WHEN is_locked = 1 THEN 'locked'
          ELSE COALESCE(status, 'normal')
        END
    WHERE package_name IS NULL OR status IS NULL OR status = ''
  `);
  db.exec(`
    UPDATE users
    SET expires_at = datetime('now', '+365 days')
    WHERE role = 'Admin' AND (expires_at IS NULL OR expires_at = '')
  `);
  db.exec(`
    UPDATE users
    SET expires_at = datetime('now', '+30 days')
    WHERE role = 'User' AND (expires_at IS NULL OR expires_at = '')
  `);

  // 创建默认管理员
  const adminUsername = process.env.ADMIN_INIT_USERNAME || 'admin';
  const adminExists = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUsername) as any;
  let adminId: number | bigint;
  if (!adminExists) {
    const configuredAdminPassword = process.env.ADMIN_INIT_PASSWORD;
    const generatedAdminPassword = randomBytes(12).toString('base64url');
    const initialAdminPassword = configuredAdminPassword || generatedAdminPassword;
    const hashedPassword = bcrypt.hashSync(initialAdminPassword, 10);
    const result = db.prepare('INSERT INTO users (username, password, role, package_name, expires_at, status, max_duration) VALUES (?, ?, ?, ?, datetime(\'now\', \'+3650 days\'), ?, ?)')
      .run(adminUsername, hashedPassword, 'Admin', '管理员套餐', 'normal', 999999999);
    adminId = result.lastInsertRowid;
    if (!configuredAdminPassword) {
      console.warn(`[SECURITY] 已自动创建管理员账号 "${adminUsername}"，临时密码为：${generatedAdminPassword}。请立即修改。`);
    }
    
    const defaultSettings = [
      ['auto_scan', 'false'],
      ['sound_alert', 'false'],
      ['scan_interval', '90'],
      ['last_sync_at', '0'],
      ['login_lock_short_minutes', '10'],
      ['login_lock_long_minutes', '120'],
      ['session_mode', 'single'],
      ['max_sessions', '1'],
      ['default_jingcai_rebate', '0.13'],
      ['default_crown_rebate', '0.02'],
      ['default_jingcai_share', '0'],
      ['default_crown_share', '0']
    ];
    
    // 如果有旧设置，优先使用旧设置
    const settingsToInsert = (global as any)._oldSettings || defaultSettings.map(([k, v]) => ({ key: k, value: v }));
    
    const insertSetting = db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)');
    if (Array.isArray(settingsToInsert)) {
      settingsToInsert.forEach((s: any) => {
        const key = s.key || s[0];
        const value = s.value || s[1];
        insertSetting.run(adminId, key, String(value));
      });
    }
  }

  db.exec(`
    INSERT OR IGNORE INTO system_settings (user_id, key, value)
    SELECT id, 'last_sync_at', '0' FROM users
  `);
  db.exec(`
    INSERT OR IGNORE INTO system_settings (user_id, key, value)
    SELECT id, 'login_lock_short_minutes', '10' FROM users
  `);
  db.exec(`
    INSERT OR IGNORE INTO system_settings (user_id, key, value)
    SELECT id, 'login_lock_long_minutes', '120' FROM users
  `);
  db.exec(`
    INSERT OR IGNORE INTO system_settings (user_id, key, value)
    SELECT id, 'session_mode', 'single' FROM users
  `);
  db.exec(`
    INSERT OR IGNORE INTO system_settings (user_id, key, value)
    SELECT id, 'max_sessions', '1' FROM users
  `);
}

export default db;
