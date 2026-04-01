import { load } from 'cheerio';
import db from './db';
import { ArbitrageEngine } from './arbitrageEngine';
import { createRequire } from 'module';

type ExternalOdds = {
  win?: string;
  draw?: string;
  lose?: string;
};

type ExternalAsia = {
  handicap?: string;
  homeWater?: string;
  awayWater?: string;
};

type ExternalHandicap = {
  type: string;
  home_odds: number;
  away_odds: number;
};

type ExternalMatch = {
  id: string;
  league?: string;
  round?: string;
  matchTime?: string;
  homeTeam?: string;
  awayTeam?: string;
  handicap?: string;
  jingcaiHandicap?: string;
  crownOdds?: ExternalOdds;
  jingcaiOdds?: ExternalOdds;
  jingcaiHandicapOdds?: ExternalOdds;
  crownAsia?: ExternalAsia;
  crownHandicaps?: ExternalHandicap[];
};

type ParsedOdds = {
  win: number;
  draw: number;
  lose: number;
};

type HgaMatch = {
  ecid: string;
  league: string;
  matchTime: string;
  homeTeam: string;
  awayTeam: string;
  strong: 'H' | 'C' | '';
  sourceShowtype: 'today' | 'early';
  crownOdds: ParsedOdds;
  handicaps: ExternalHandicap[];
};

const REQUIRED_CROWN_HANDICAP_COUNT = 3;
const HGA_SESSION_EXPIRED = 'HGA_SESSION_EXPIRED';
const HGA_ACCOUNT_LOCKED = 'HGA_ACCOUNT_LOCKED';
const HGA_LOCK_HINT = '密码错误次数过多';

const handicapMappings: Array<[string, string]> = [
  ['平手/半球', '0/0.5'],
  ['半球/一球', '0.5/1'],
  ['一球/球半', '1/1.5'],
  ['球半/两球', '1.5/2'],
  ['两球/两球半', '2/2.5'],
  ['平手', '0'],
  ['半球', '0.5'],
  ['一球', '1'],
  ['球半', '1.5'],
  ['两球', '2'],
  ['两球半', '2.5'],
];

const HANDICAP_TEXT_MAP: Record<string, string> = {
  '\u5e73\u624b': '0',
  '\u534a\u7403': '0.5',
  '\u4e00\u7403': '1',
  '\u7403\u534a': '1.5',
  '\u4e24\u7403': '2',
  '\u4e24\u7403\u534a': '2.5',
  '\u5e73\u624b/\u534a\u7403': '0/0.5',
  '\u534a\u7403/\u4e00\u7403': '0.5/1',
  '\u4e00\u7403/\u7403\u534a': '1/1.5',
  '\u7403\u534a/\u4e24\u7403': '1.5/2',
  '\u4e24\u7403/\u4e24\u7403\u534a': '2/2.5',
};

const HGA_BASE_URL = 'https://hga050.com/transform_nl.php';
const HGA_ALT_BASE_URL = 'https://hga050.com/transform.php';
const HGA_VER = '2026-03-19-fireicon_142';
const HGA_FETCH_TIMEOUT_MS = 25000;
const SYNC_MIN_ROW_RATIO = 0.6;
const PLAYWRIGHT_FALLBACK_TIMEOUT_MS = 45000;
const TRADE500_XML_NSPF_URL = 'https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml';
const TRADE500_XML_SPF_URL = 'https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml';
const TRADE500_ODDS_XML_HOSTS = ['https://www.500.com', 'https://trade.500.com', 'https://ews.500.com'];
const TRADE500_ODDS_XML_PATH = '/static/public/jczq/xml/odds/odds.xml';
const TRADE500_XML_STALE_DAYS = 2;

type Trade500XmlRow = {
  date: string;
  matchnum: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  matchTime: string;
  odds: ExternalOdds;
};

type Trade500DomHandicap = {
  regularHandicap: string;
  jingcaiHandicap: string;
  matchTime: string;
};

type Trade500DomHandicapMap = {
  byExact: Map<string, Trade500DomHandicap>;
  byMatchnum: Map<string, Trade500DomHandicap>;
};

type HttpCacheEntry = {
  body: string;
  etag?: string;
  lastModified?: string;
};

type NormalizedSyncRow = {
  match_id: string;
  league: string;
  round: string;
  handicap: string;
  jingcai_handicap: string;
  home_team: string;
  away_team: string;
  match_time: string;
  j_w: number;
  j_d: number;
  j_l: number;
  j_hw: number;
  j_hd: number;
  j_hl: number;
  c_w: number;
  c_d: number;
  c_l: number;
  c_h: ExternalHandicap[];
};

const HTTP_TEXT_CACHE = new Map<string, HttpCacheEntry>();
const require = createRequire(import.meta.url);

export class CrawlerService {
  private static hgaLoginBlockedUntil = 0;
  private static hgaLoginBlockedReason = '';
  private static hgaRiskBlocked = false;

  private static lastFetchMeta: {
    hga_status: 'ok' | 'empty' | 'failed' | 'timeout' | 'unknown' | 'locked';
    hga_count: number;
    base_count: number;
    merged_count: number;
    playwright_fallback_used: boolean;
  } = {
    hga_status: 'unknown',
    hga_count: 0,
    base_count: 0,
    merged_count: 0,
    playwright_fallback_used: false,
  };

  static async mockCrawl() {
    return this.syncFromExternalScraper();
  }

  static async onlineCrawl(_apiUrl: string) {
    return this.syncFromExternalScraper();
  }

  static async syncFromExternalScraper() {
    const startedAt = Date.now();
    const onlyCompleteMatches = this.shouldOnlySyncCompleteMatches();
    const rawMatches = await this.fetchExternalMatches();
    if (rawMatches.length === 0) {
      console.warn('External scraper returned 0 matches, skip overwrite and keep existing database rows');
      this.logScrapeHealth({
        status: 'empty',
        fetched_total: 0,
        filtered_total: 0,
        synced_total: 0,
        complete_total: 0,
        note: 'raw empty, keep existing rows',
        duration_ms: Date.now() - startedAt,
      });
      return 0;
    }
    const matches = onlyCompleteMatches ? rawMatches.filter((match) => this.isMatchComplete(match)) : rawMatches;
    const existingHandicapMap = this.getExistingCrownHandicapMap();
    const incomingRows = matches.map((match) => this.toNormalizedSyncRow(match, existingHandicapMap));
    const currentRows = this.getCurrentNonManualSyncRows();
    const currentMap = new Map(currentRows.map((row) => [row.match_id, row] as const));
    const stabilizedRows = incomingRows.map((row) => this.stabilizeRowWithCurrent(row, currentMap.get(row.match_id)));

    if (currentRows.length > 0 && stabilizedRows.length < Math.max(1, Math.floor(currentRows.length * SYNC_MIN_ROW_RATIO))) {
      console.warn(
        `External scraper row count dropped too much (${stabilizedRows.length}/${currentRows.length}), skip overwrite to avoid partial-data regression`
      );
      this.logScrapeHealth({
        status: 'skipped',
        fetched_total: rawMatches.length,
        filtered_total: matches.length,
        synced_total: currentRows.length,
        complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
        note: 'row drop protection triggered',
        duration_ms: Date.now() - startedAt,
      });
      return currentRows.length;
    }

    if (this.isSameSyncRows(currentRows, stabilizedRows)) {
      console.log(`External scraper data unchanged, skip database update (${stabilizedRows.length} matches)`);
      this.logScrapeHealth({
        status: 'unchanged',
        fetched_total: rawMatches.length,
        filtered_total: matches.length,
        synced_total: stabilizedRows.length,
        complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
        note: 'same rows',
        duration_ms: Date.now() - startedAt,
      });
      return stabilizedRows.length;
    }

    db.transaction(() => {
      db.prepare('DELETE FROM arbitrage_opportunities').run();
      db.prepare('DELETE FROM parlay_opportunities').run();
      db.prepare("DELETE FROM crown_odds WHERE match_id NOT LIKE 'manual_%'").run();
      db.prepare("DELETE FROM jingcai_odds WHERE match_id NOT LIKE 'manual_%'").run();
      db.prepare("DELETE FROM matches WHERE match_id NOT LIKE 'manual_%'").run();

      const insertMatch = db.prepare(`
        INSERT INTO matches (match_id, league, round, handicap, jingcai_handicap, home_team, away_team, match_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
      `);

      const insertJingcai = db.prepare(`
        INSERT INTO jingcai_odds (
          match_id,
          win_odds,
          draw_odds,
          lose_odds,
          handicap_win_odds,
          handicap_draw_odds,
          handicap_lose_odds
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const insertCrown = db.prepare(`
        INSERT INTO crown_odds (match_id, win_odds, draw_odds, lose_odds, handicaps)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const row of stabilizedRows) {
        insertMatch.run(
          row.match_id,
          row.league,
          row.round,
          row.handicap,
          row.jingcai_handicap,
          row.home_team,
          row.away_team,
          row.match_time
        );

        insertJingcai.run(
          row.match_id,
          row.j_w,
          row.j_d,
          row.j_l,
          row.j_hw,
          row.j_hd,
          row.j_hl
        );

        insertCrown.run(
          row.match_id,
          row.c_w,
          row.c_d,
          row.c_l,
          JSON.stringify(row.c_h)
        );
      }
    })();

    const users = db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
    for (const user of users) {
      await this.scanOpportunities(user.id);
    }

    console.log(
      `External scraper sync completed with ${stabilizedRows.length} matches` +
        (onlyCompleteMatches ? ` (filtered from ${rawMatches.length})` : '')
    );
    this.logScrapeHealth({
      status: 'ok',
      fetched_total: rawMatches.length,
      filtered_total: matches.length,
      synced_total: stabilizedRows.length,
      complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
      note: onlyCompleteMatches ? 'only_complete_matches=true' : '',
      duration_ms: Date.now() - startedAt,
    });
    return stabilizedRows.length;
  }

  private static logScrapeHealth(payload: {
    status: 'ok' | 'unchanged' | 'skipped' | 'empty' | 'error';
    fetched_total: number;
    filtered_total: number;
    synced_total: number;
    complete_total: number;
    note?: string;
    duration_ms: number;
  }) {
    const meta = this.lastFetchMeta;
    db.prepare(
      `CREATE TABLE IF NOT EXISTS scrape_health_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT DEFAULT 'external',
        status TEXT NOT NULL,
        fetched_total INTEGER DEFAULT 0,
        filtered_total INTEGER DEFAULT 0,
        synced_total INTEGER DEFAULT 0,
        complete_total INTEGER DEFAULT 0,
        hga_status TEXT DEFAULT 'unknown',
        hga_count INTEGER DEFAULT 0,
        base_count INTEGER DEFAULT 0,
        merged_count INTEGER DEFAULT 0,
        playwright_fallback_used INTEGER DEFAULT 0,
        note TEXT,
        duration_ms INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();
    db.prepare(
      `INSERT INTO scrape_health_logs
       (source, status, fetched_total, filtered_total, synced_total, complete_total, hga_status, hga_count, base_count, merged_count, playwright_fallback_used, note, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'external',
      payload.status,
      payload.fetched_total,
      payload.filtered_total,
      payload.synced_total,
      payload.complete_total,
      meta.hga_status,
      meta.hga_count,
      meta.base_count,
      meta.merged_count,
      meta.playwright_fallback_used ? 1 : 0,
      payload.note || '',
      payload.duration_ms
    );
  }

  private static stabilizeRowWithCurrent(incoming: NormalizedSyncRow, current?: NormalizedSyncRow): NormalizedSyncRow {
    if (!current) return incoming;
    return {
      ...incoming,
      league: incoming.league || current.league,
      round: incoming.round || current.round,
      handicap: incoming.handicap || current.handicap,
      jingcai_handicap: incoming.jingcai_handicap || current.jingcai_handicap,
      home_team: incoming.home_team || current.home_team,
      away_team: incoming.away_team || current.away_team,
      match_time: incoming.match_time || current.match_time,
      j_w: incoming.j_w > 0 ? incoming.j_w : current.j_w,
      j_d: incoming.j_d > 0 ? incoming.j_d : current.j_d,
      j_l: incoming.j_l > 0 ? incoming.j_l : current.j_l,
      j_hw: incoming.j_hw > 0 ? incoming.j_hw : current.j_hw,
      j_hd: incoming.j_hd > 0 ? incoming.j_hd : current.j_hd,
      j_hl: incoming.j_hl > 0 ? incoming.j_hl : current.j_hl,
      c_w: incoming.c_w > 0 ? incoming.c_w : current.c_w,
      c_d: incoming.c_d > 0 ? incoming.c_d : current.c_d,
      c_l: incoming.c_l > 0 ? incoming.c_l : current.c_l,
      c_h: (incoming.c_h || []).length > 0 ? incoming.c_h : current.c_h,
    };
  }

  private static getExistingCrownHandicapMap() {
    const rows = db
      .prepare("SELECT match_id, handicaps FROM crown_odds WHERE match_id NOT LIKE 'manual_%'")
      .all() as Array<{ match_id: string; handicaps?: string }>;
    const map = new Map<string, ExternalHandicap[]>();
    for (const row of rows) {
      if (!row.match_id) continue;
      let parsed: any = [];
      try {
        parsed = row.handicaps ? JSON.parse(row.handicaps) : [];
      } catch {
        parsed = [];
      }
      const normalized = this.getValidCrownHandicaps(Array.isArray(parsed) ? parsed : []);
      if (normalized.length > 0) map.set(row.match_id, normalized);
    }
    return map;
  }

  private static mergeHandicapCandidates(primary: ExternalHandicap[], secondary: ExternalHandicap[]) {
    return this.getValidCrownHandicaps([...(primary || []), ...(secondary || [])]).slice(0, REQUIRED_CROWN_HANDICAP_COUNT);
  }

  private static buildHandicapsWithFallback(match: ExternalMatch, existingMap: Map<string, ExternalHandicap[]>) {
    const latest = this.buildHandicaps(match);
    if (latest.length >= REQUIRED_CROWN_HANDICAP_COUNT) return latest.slice(0, REQUIRED_CROWN_HANDICAP_COUNT);
    const old = existingMap.get(match.id) || [];
    return this.mergeHandicapCandidates(latest, old);
  }

  private static toNormalizedSyncRow(match: ExternalMatch, existingMap: Map<string, ExternalHandicap[]>): NormalizedSyncRow {
    const correctedOdds = this.resolveJingcaiOddsMapping(match);
    return {
      match_id: match.id,
      league: match.league || '',
      round: match.round || '',
      handicap: match.handicap || '',
      jingcai_handicap: match.jingcaiHandicap || '',
      home_team: match.homeTeam || '',
      away_team: match.awayTeam || '',
      match_time: this.normalizeMatchTime(match.matchTime),
      j_w: correctedOdds.standard.win,
      j_d: correctedOdds.standard.draw,
      j_l: correctedOdds.standard.lose,
      j_hw: correctedOdds.handicap.win,
      j_hd: correctedOdds.handicap.draw,
      j_hl: correctedOdds.handicap.lose,
      c_w: this.parseOdds(match.crownOdds?.win),
      c_d: this.parseOdds(match.crownOdds?.draw),
      c_l: this.parseOdds(match.crownOdds?.lose),
      c_h: this.buildHandicapsWithFallback(match, existingMap),
    };
  }

  private static getCurrentNonManualSyncRows(): NormalizedSyncRow[] {
    const rows = db
      .prepare(`
        SELECT m.match_id, m.league, m.round, m.handicap, m.jingcai_handicap, m.home_team, m.away_team, m.match_time,
               j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
               j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
               c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h
        FROM matches m
        LEFT JOIN jingcai_odds j ON m.match_id = j.match_id
        LEFT JOIN crown_odds c ON m.match_id = c.match_id
        WHERE m.match_id NOT LIKE 'manual_%'
      `)
      .all() as Array<any>;
    return rows.map((row) => {
      let parsed: any = [];
      try {
        parsed = row.c_h ? JSON.parse(row.c_h) : [];
      } catch {
        parsed = [];
      }
      return {
        match_id: String(row.match_id || ''),
        league: String(row.league || ''),
        round: String(row.round || ''),
        handicap: String(row.handicap || ''),
        jingcai_handicap: String(row.jingcai_handicap || ''),
        home_team: String(row.home_team || ''),
        away_team: String(row.away_team || ''),
        match_time: this.normalizeMatchTime(row.match_time),
        j_w: Number(row.j_w || 0),
        j_d: Number(row.j_d || 0),
        j_l: Number(row.j_l || 0),
        j_hw: Number(row.j_hw || 0),
        j_hd: Number(row.j_hd || 0),
        j_hl: Number(row.j_hl || 0),
        c_w: Number(row.c_w || 0),
        c_d: Number(row.c_d || 0),
        c_l: Number(row.c_l || 0),
        c_h: this.getValidCrownHandicaps(Array.isArray(parsed) ? parsed : []).slice(0, REQUIRED_CROWN_HANDICAP_COUNT),
      } as NormalizedSyncRow;
    });
  }

  private static serializeSyncRows(rows: NormalizedSyncRow[]) {
    const normalized = rows
      .map((row) => ({
        ...row,
        c_h: this.getValidCrownHandicaps(row.c_h || []).slice(0, REQUIRED_CROWN_HANDICAP_COUNT),
      }))
      .sort((a, b) => a.match_id.localeCompare(b.match_id));
    return JSON.stringify(normalized);
  }

  private static isSameSyncRows(currentRows: NormalizedSyncRow[], incomingRows: NormalizedSyncRow[]) {
    if (currentRows.length !== incomingRows.length) return false;
    return this.serializeSyncRows(currentRows) === this.serializeSyncRows(incomingRows);
  }

  private static async fetchExternalMatches(): Promise<ExternalMatch[]> {
    this.lastFetchMeta = {
      hga_status: 'unknown',
      hga_count: 0,
      base_count: 0,
      merged_count: 0,
      playwright_fallback_used: false,
    };
    const strictByHgaHandicapCount = (rows: ExternalMatch[]) =>
      rows.filter((match) => this.getValidCrownHandicaps(this.buildHandicaps(match)).length >= REQUIRED_CROWN_HANDICAP_COUNT);

    let baseMatches: ExternalMatch[] = [];
    try {
      baseMatches = await this.fetchTrade500AsPrimaryMatches();
      this.lastFetchMeta.base_count = baseMatches.length;
    } catch (err: any) {
      console.warn(`Trade500 primary source failed: ${err?.message || err}`);
      this.lastFetchMeta.hga_status = 'failed';
      return [];
    }

    if (this.hgaRiskBlocked) {
      this.lastFetchMeta.hga_status = 'locked';
      console.warn(`HGA risk lock detected, skip HGA fetch: ${this.hgaLoginBlockedReason || 'locked by upstream'}`);
      const withPw = await this.tryPlaywrightFallback(baseMatches, 'hga-locked');
      if (withPw.length > 0) baseMatches = withPw;
      const strictBase = strictByHgaHandicapCount(baseMatches);
      console.warn(`Trade500 strict fallback reference: ${strictBase.length}/${baseMatches.length} matches`);
      return baseMatches;
    }

    try {
      const hgaMatches = await this.withTimeout(this.fetchHgaMatches(), HGA_FETCH_TIMEOUT_MS, 'HGA fetch timeout');
      this.lastFetchMeta.hga_count = hgaMatches.length;
      if (hgaMatches.length === 0) {
        this.lastFetchMeta.hga_status = 'empty';
        console.warn('HGA returned 0 matches, fallback to Trade500 primary source');
        const withPw = await this.tryPlaywrightFallback(baseMatches, 'hga-empty');
        if (withPw.length > 0) baseMatches = withPw;
        const strictBase = strictByHgaHandicapCount(baseMatches);
        console.warn(`Trade500 strict fallback reference: ${strictBase.length}/${baseMatches.length} matches`);
        return baseMatches;
      }
      const merged = this.mergeHgaCrownData(baseMatches, hgaMatches);
      this.lastFetchMeta.hga_status = 'ok';
      this.lastFetchMeta.merged_count = merged.length;
      const strict = strictByHgaHandicapCount(merged);
      console.log(
        `HGA strict filter kept ${strict.length}/${merged.length} matches (requires ${REQUIRED_CROWN_HANDICAP_COUNT} crown handicaps)`
      );
      // Strict set is informational only. Do not shrink result set, or match list may collapse to 1-2 rows.
      if (strict.length === 0) {
        console.warn('HGA strict filter produced 0 matches, fallback to merged results without strict filter');
      }
      return merged;
    } catch (err: any) {
      const errText = String(err?.message || '');
      if (errText.includes(HGA_ACCOUNT_LOCKED)) {
        this.lastFetchMeta.hga_status = 'locked';
        this.hgaRiskBlocked = true;
      } else {
        this.lastFetchMeta.hga_status = errText.includes('timeout') ? 'timeout' : 'failed';
      }
      console.warn(`HGA source failed, fallback to Trade500 primary source: ${err?.message || err}`);
      const withPw = await this.tryPlaywrightFallback(baseMatches, this.lastFetchMeta.hga_status === 'locked' ? 'hga-locked' : 'hga-failed');
      if (withPw.length > 0) baseMatches = withPw;
      const strictBase = strictByHgaHandicapCount(baseMatches);
      console.warn(`Trade500 strict fallback reference: ${strictBase.length}/${baseMatches.length} matches`);
      return baseMatches;
    }
  }

  private static async tryPlaywrightFallback(baseMatches: ExternalMatch[], reason: string): Promise<ExternalMatch[]> {
    try {
      const force = process.env.FORCE_PLAYWRIGHT_FALLBACK === 'true';
      if (!force && baseMatches.length > 0) {
        // Only trigger Playwright fallback when HGA degraded and base rows may be incomplete.
        const completeCount = baseMatches.filter((m) => this.isMatchComplete(m)).length;
        if (completeCount >= Math.max(1, Math.floor(baseMatches.length * 0.7))) {
          return baseMatches;
        }
      }

      const pwRows = await this.withTimeout(this.fetchPlaywrightMatches(), PLAYWRIGHT_FALLBACK_TIMEOUT_MS, 'Playwright fallback timeout');
      if (!Array.isArray(pwRows) || pwRows.length === 0) return baseMatches;
      const merged = this.mergePlaywrightData(baseMatches, pwRows);
      this.lastFetchMeta.playwright_fallback_used = true;
      this.lastFetchMeta.merged_count = merged.length;
      console.log(`Playwright fallback merged ${merged.length} matches (reason=${reason}, source=${pwRows.length})`);
      return merged;
    } catch (err: any) {
      console.warn(`Playwright fallback skipped: ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static async fetchPlaywrightMatches(): Promise<ExternalMatch[]> {
    const mod = require('./scraper/playwright-scraper-full.cjs');
    const scrape = mod?.scrapeFullMatchData;
    if (typeof scrape !== 'function') return [];
    const rows = await scrape(null);
    return Array.isArray(rows) ? rows : [];
  }

  private static mergePlaywrightData(baseMatches: ExternalMatch[], pwMatches: ExternalMatch[]): ExternalMatch[] {
    if (baseMatches.length === 0 || pwMatches.length === 0) return baseMatches;
    const byPair = new Map<string, ExternalMatch[]>();
    for (const row of pwMatches) {
      const key = `${this.normalizeNameForMatch(row.homeTeam)}|${this.normalizeNameForMatch(row.awayTeam)}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key)!.push(row);
    }

    const isValidTriplet = (odds?: ExternalOdds) =>
      this.parseOdds(odds?.win) > 0 && this.parseOdds(odds?.draw) > 0 && this.parseOdds(odds?.lose) > 0;

    let enriched = 0;
    return baseMatches.map((base) => {
      const key = `${this.normalizeNameForMatch(base.homeTeam)}|${this.normalizeNameForMatch(base.awayTeam)}`;
      const candidates = byPair.get(key) || [];
      if (candidates.length === 0) return base;
      const chosen =
        candidates.find((x) => this.normalizeMatchTime(x.matchTime).slice(0, 16) === this.normalizeMatchTime(base.matchTime).slice(0, 16)) ||
        candidates.find((x) => this.normalizeMatchTime(x.matchTime).slice(0, 10) === this.normalizeMatchTime(base.matchTime).slice(0, 10)) ||
        candidates[0];
      if (!chosen) return base;

      const merged: ExternalMatch = {
        ...base,
        crownOdds: isValidTriplet(base.crownOdds) ? base.crownOdds : chosen.crownOdds || base.crownOdds,
        crownAsia:
          (this.parseOdds(base.crownAsia?.homeWater) > 0 && this.parseOdds(base.crownAsia?.awayWater) > 0)
            ? base.crownAsia
            : chosen.crownAsia || base.crownAsia,
      };
      const baseOddsValid = isValidTriplet(base.crownOdds);
      const mergedOddsValid = isValidTriplet(merged.crownOdds);
      const baseHandicapCount = this.buildHandicaps(base).length;
      const mergedHandicaps = this.mergeHandicapCandidates(this.buildHandicaps(merged), this.buildHandicaps(chosen));
      if (mergedHandicaps.length > baseHandicapCount) {
        merged.crownHandicaps = mergedHandicaps;
      }
      if ((!baseOddsValid && mergedOddsValid) || mergedHandicaps.length > baseHandicapCount) enriched += 1;
      return merged;
    });
  }

  private static withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private static async fetchTrade500AsPrimaryMatches(): Promise<ExternalMatch[]> {
    const tradeRows = await this.fetchTrade500MatchesFromXml();
    if (tradeRows.length === 0) {
      return [];
    }

    let crownMap = {
      byExact: new Map<string, { crownOdds: ExternalOdds; crownAsia: ExternalAsia }>(),
      byMatchnum: new Map<string, { crownOdds: ExternalOdds; crownAsia: ExternalAsia }>(),
    };
    try {
      crownMap = await this.fetchTrade500CrownMapFromOddsXml();
    } catch (err: any) {
      console.warn(`Trade500 odds.xml enrichment failed, continue with empty crown odds: ${err?.message || err}`);
    }
    const out: ExternalMatch[] = tradeRows.map((row) => {
      const key = `${row.date}|${row.matchnum}`;
      const crown = crownMap.byExact.get(key) || crownMap.byMatchnum.get(row.matchnum);
      const standardOdds = row.odds;
      const handicapOdds = ((row as any).__handicapOdds || {}) as ExternalOdds;
      const regularHandicap = String((row as any).__regularHandicap || '').trim() || '0';
      const jingcaiHandicap = String((row as any).__jingcaiHandicap || '').trim() || '-';

      return {
        id: key,
        league: row.league || '',
        round: row.matchnum || '',
        matchTime: row.matchTime,
        homeTeam: row.homeTeam || '',
        awayTeam: row.awayTeam || '',
        handicap: regularHandicap,
        jingcaiHandicap,
        jingcaiOdds: standardOdds,
        jingcaiHandicapOdds: handicapOdds,
        crownOdds: crown?.crownOdds || { win: '-', draw: '-', lose: '-' },
        crownAsia: crown?.crownAsia || { handicap: '-', homeWater: '-', awayWater: '-' },
      };
    });

    console.log(`Trade500 primary source built ${out.length} matches`);
    return out;
  }

  private static async fetchTrade500MatchesFromXml(): Promise<Trade500XmlRow[]> {
    const [nspfXml, spfXml] = await Promise.all([
      this.fetchTextWithCheck(TRADE500_XML_NSPF_URL),
      this.fetchTextWithCheck(TRADE500_XML_SPF_URL),
    ]);

    const nspfRows = this.parseTrade500XmlRows(nspfXml);
    const spfRows = this.parseTrade500XmlRows(spfXml);
    if (nspfRows.length === 0 || spfRows.length === 0) {
      return [];
    }
    if (!this.isTrade500RowsFresh(nspfRows) || !this.isTrade500RowsFresh(spfRows)) {
      console.warn('Trade500 XML appears stale, skip this round');
      return [];
    }

    const dates = Array.from(new Set([...nspfRows, ...spfRows].map((item) => item.date).filter(Boolean)));
    const domHandicapMap = await this.fetchTrade500DomHandicapMap(dates);

    const spfMap = new Map<string, Trade500XmlRow>();
    for (const row of spfRows) {
      spfMap.set(`${row.date}|${row.matchnum}`, row);
    }

    const out: Trade500XmlRow[] = [];
    for (const standard of nspfRows) {
      const key = `${standard.date}|${standard.matchnum}`;
      const handicap = spfMap.get(key);
      if (!handicap) {
        continue;
      }

      const dom = domHandicapMap.byExact.get(key) || domHandicapMap.byMatchnum.get(standard.matchnum);
      const effectiveMatchTime = dom?.matchTime || standard.matchTime || handicap.matchTime;
      out.push({
        date: standard.date,
        matchnum: standard.matchnum,
        league: standard.league,
        homeTeam: standard.homeTeam,
        awayTeam: standard.awayTeam,
        matchTime: effectiveMatchTime,
        odds: standard.odds,
      });

      // 通过把行写入 map，再在 merge 阶段读取两组赔率和盘口，避免改变已有 ExternalMatch 结构
      (out[out.length - 1] as any).__handicapOdds = handicap.odds;
      (out[out.length - 1] as any).__regularHandicap = dom?.regularHandicap || '0';
      (out[out.length - 1] as any).__jingcaiHandicap = dom?.jingcaiHandicap || '-';
    }

    console.log(`Trade500 XML gray source fetched ${out.length} matches`);
    return out;
  }

  private static async fetchTrade500DomHandicapMap(dates: string[]): Promise<Trade500DomHandicapMap> {
    const byExact = new Map<string, Trade500DomHandicap>();
    const byMatchnum = new Map<string, Trade500DomHandicap>();
    for (const date of dates) {
      if (!date) continue;
      try {
        const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?date=${date}`);
        const $ = load(html);
        $('tr[data-processname]').each((_, element) => {
          const processDate = String($(element).attr('data-processdate') || '').trim();
          const processName = String($(element).attr('data-processname') || '').trim();
          if (!processDate || !processName) return;

          const parts = $(element)
            .find('td.td-rang p')
            .map((__, p) => String($(p).text() || '').replace(/\s+/g, '').replace(/^单关/u, '').trim())
            .get()
            .filter(Boolean);

          const regular = this.normalizeNumericHandicap(parts[0] || '0');
          const rawJingcai = parts[1] || String($(element).attr('data-rangqiu') || '').trim() || '-';
          const jingcai = this.normalizeSignedHandicap(rawJingcai);
          const dataDate = String($(element).attr('data-matchdate') || processDate).trim();
          const dataTime = String($(element).attr('data-matchtime') || '').trim();
          const kickoff = /^\d{2}:\d{2}$/.test(dataTime) ? `${dataDate} ${dataTime}:00` : '';
          const item = {
            regularHandicap: regular || '0',
            jingcaiHandicap: jingcai || '-',
            matchTime: this.normalizeMatchTime(kickoff || `${dataDate} 00:00`),
          };
          byExact.set(`${processDate}|${processName}`, item);
          if (dataDate) {
            byExact.set(`${dataDate}|${processName}`, item);
          }
          if (!byMatchnum.has(processName)) {
            byMatchnum.set(processName, item);
          }
        });
      } catch (err: any) {
        console.warn(`Trade500 DOM handicap fallback failed for ${date}: ${err?.message || err}`);
      }
    }
    return { byExact, byMatchnum };
  }

  private static parseTrade500XmlRows(xml: string): Trade500XmlRow[] {
    const out: Trade500XmlRow[] = [];
    const matchRegex = /<m\s+([^>]+)>([\s\S]*?)<\/m>/g;
    let match: RegExpExecArray | null;
    while ((match = matchRegex.exec(xml)) !== null) {
      const attrs = this.parseXmlAttributes(match[1]);
      const body = match[2] || '';
      const rowMatch = body.match(/<row\s+([^>]+?)\/>/);
      if (!rowMatch) continue;

      const rowAttrs = this.parseXmlAttributes(rowMatch[1]);
      const win = rowAttrs.win || '';
      const draw = rowAttrs.draw || '';
      const lose = rowAttrs.lost || '';

      const item: Trade500XmlRow = {
        date: attrs.date || '',
        matchnum: attrs.matchnum || '',
        league: attrs.league || '',
        homeTeam: attrs.home || '',
        awayTeam: attrs.away || '',
        matchTime: this.normalizeMatchTime(rowAttrs.time || `${attrs.date || ''} 00:00`),
        odds: { win, draw, lose },
      };

      if (item.date && item.matchnum && item.homeTeam && item.awayTeam) {
        out.push(item);
      }
    }
    return out;
  }

  private static isTrade500RowsFresh(rows: Trade500XmlRow[]) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return rows.some((row) => {
      const date = this.parseYmdDate(row.date);
      if (!date) return false;
      const diff = Math.abs((date.getTime() - today.getTime()) / 86400000);
      return diff <= TRADE500_XML_STALE_DAYS;
    });
  }

  private static parseYmdDate(input?: string) {
    const text = String(input || '').trim();
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private static parseXmlAttributes(input: string) {
    const attrs: Record<string, string> = {};
    const attrRegex = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(input)) !== null) {
      attrs[m[1]] = this.decodeXmlEntities(m[2]);
    }
    return attrs;
  }

  private static decodeXmlEntities(text: string) {
    return (text || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  private static normalizeNumericHandicap(input?: string) {
    const text = String(input || '').trim();
    if (!text) return '';
    const first = text.match(/[+-]?\d+(?:\.\d+)?(?:\/[+-]?\d+(?:\.\d+)?)?/);
    if (!first) return '';
    return first[0].replace(/^\+/, '');
  }

  private static normalizeSignedHandicap(input?: string) {
    const base = this.normalizeNumericHandicap(input);
    if (!base) return '';
    if (base.startsWith('-') || base.startsWith('+')) return base;
    const raw = String(input || '').trim();
    if (raw.startsWith('-') || raw.startsWith('+')) return `${raw[0]}${base}`;
    return base;
  }

  private static async fetchTextWithCheck(url: string) {
    let lastErr: any = null;
    const cached = HTTP_TEXT_CACHE.get(url);
    for (let i = 0; i < 3; i++) {
      try {
        const headers: Record<string, string> = {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          accept: '*/*',
        };
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let response: Response;
        try {
          response = await fetch(url, {
            headers,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (response.status === 304 && cached?.body) {
          return cached.body;
        }
        if (!response.ok) {
          lastErr = new Error(`request failed: ${response.status} ${url}`);
          continue;
        }
        const text = await response.text();
        HTTP_TEXT_CACHE.set(url, {
          body: text,
          etag: response.headers.get('etag') || undefined,
          lastModified: response.headers.get('last-modified') || undefined,
        });
        return text;
      } catch (err: any) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`request failed: ${url}`);
  }

  private static mergeTrade500JingcaiData(legacyMatches: ExternalMatch[], tradeRows: Trade500XmlRow[]) {
    if (legacyMatches.length === 0 || tradeRows.length === 0) {
      return legacyMatches;
    }

    const grouped = new Map<string, Trade500XmlRow[]>();
    for (const item of tradeRows) {
      const key = `${this.normalizeNameForMatch(item.homeTeam)}|${this.normalizeNameForMatch(item.awayTeam)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }
    for (const rows of grouped.values()) {
      rows.sort((a, b) => a.matchTime.localeCompare(b.matchTime));
    }

    let patchedCount = 0;
    const merged = legacyMatches.map((legacy) => {
      const key = `${this.normalizeNameForMatch(legacy.homeTeam)}|${this.normalizeNameForMatch(legacy.awayTeam)}`;
      const candidates = grouped.get(key) || [];
      if (candidates.length === 0) {
        return legacy;
      }

      const legacyTime = this.normalizeMatchTime(legacy.matchTime);
      const chosen =
        candidates.find((row) => this.normalizeMatchTime(row.matchTime).slice(0, 16) === legacyTime.slice(0, 16)) ||
        candidates.find((row) => this.normalizeMatchTime(row.matchTime).slice(0, 10) === legacyTime.slice(0, 10)) ||
        candidates[0];

      if (!chosen) return legacy;

      const handicapOdds = (chosen as any).__handicapOdds as ExternalOdds | undefined;
      const regularHandicap = String((chosen as any).__regularHandicap || '').trim();
      const jingcaiHandicap = String((chosen as any).__jingcaiHandicap || '').trim();
      const hasStandardOdds =
        this.parseOdds(chosen.odds?.win) > 0 &&
        this.parseOdds(chosen.odds?.draw) > 0 &&
        this.parseOdds(chosen.odds?.lose) > 0;
      const hasHandicapOdds =
        this.parseOdds(handicapOdds?.win) > 0 &&
        this.parseOdds(handicapOdds?.draw) > 0 &&
        this.parseOdds(handicapOdds?.lose) > 0;

      if (!hasStandardOdds || !hasHandicapOdds) {
        return legacy;
      }

      patchedCount += 1;
      return {
        ...legacy,
        handicap: regularHandicap || legacy.handicap || '0',
        jingcaiHandicap: jingcaiHandicap || legacy.jingcaiHandicap || '-',
        jingcaiOdds: chosen.odds,
        jingcaiHandicapOdds: handicapOdds,
      };
    });

    console.log(`Trade500 XML gray source patched jingcai data for ${patchedCount}/${legacyMatches.length} matches`);
    return merged;
  }

  private static async fetchTrade500CrownMapFromOddsXml() {
    let lastErr: any = null;
    for (const host of TRADE500_ODDS_XML_HOSTS) {
      try {
        const xml = await this.fetchTextWithCheck(`${host}${TRADE500_ODDS_XML_PATH}`);
        if (!this.isTrade500OddsXmlFresh(xml)) {
          console.warn(`Trade500 odds.xml from ${host} is stale, trying next host`);
          continue;
        }
        return this.parseTrade500CrownMap(xml);
      } catch (err: any) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Trade500 odds.xml unavailable on all hosts');
  }

  private static parseTrade500CrownMap(xml: string) {
    const byExact = new Map<string, { crownOdds: ExternalOdds; crownAsia: ExternalAsia }>();
    const byMatchnum = new Map<string, { crownOdds: ExternalOdds; crownAsia: ExternalAsia }>();

    const matchRegex = /<match\s+([^>]+)>([\s\S]*?)<\/match>/g;
    let match: RegExpExecArray | null;
    while ((match = matchRegex.exec(xml)) !== null) {
      const attrs = this.parseXmlAttributes(match[1]);
      const date = attrs.processdate || '';
      const matchnum = attrs.processname || '';
      if (!date || !matchnum) continue;
      const key = `${date}|${matchnum}`;

      const body = match[2] || '';
      const europeTag = body.match(/<europe\s+([^>]+?)\/>/);
      const asianTag = body.match(/<asian\s+([^>]+?)\/>/);
      const europeAttrs = europeTag ? this.parseXmlAttributes(europeTag[1]) : {};
      const asianAttrs = asianTag ? this.parseXmlAttributes(asianTag[1]) : {};

      const hgEurope = this.parseCommaOdds(europeAttrs.hg);
      const hgAsian = this.parseCommaAsian(asianAttrs.hg);

      const item = {
        crownOdds: {
          win: hgEurope?.win || '-',
          draw: hgEurope?.draw || '-',
          lose: hgEurope?.lose || '-',
        },
        crownAsia: {
          handicap: hgAsian?.handicap || '-',
          homeWater: hgAsian?.homeWater || '-',
          awayWater: hgAsian?.awayWater || '-',
        },
      };
      byExact.set(key, item);
      if (!byMatchnum.has(matchnum)) {
        byMatchnum.set(matchnum, item);
      }
    }

    return { byExact, byMatchnum };
  }

  private static isTrade500OddsXmlFresh(xml: string) {
    const updateTime = (xml.match(/<updatetime>(.*?)<\/updatetime>/)?.[1] || '').trim();
    if (!updateTime) return false;
    const parsed = new Date(updateTime.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return false;
    const now = new Date();
    const diffMinutes = Math.abs(now.getTime() - parsed.getTime()) / 60000;
    return diffMinutes <= 24 * 60;
  }

  private static parseCommaOdds(raw?: string) {
    if (!raw) return null;
    const parts = raw.split(',').map((item) => item.trim());
    if (parts.length < 3) return null;
    return { win: parts[0], draw: parts[1], lose: parts[2] };
  }

  private static parseCommaAsian(raw?: string) {
    if (!raw) return null;
    const parts = raw.split(',').map((item) => item.trim());
    if (parts.length < 3) return null;
    return {
      homeWater: parts[0],
      handicap: this.normalizeHandicapV2(parts[1] || '') || parts[1] || '-',
      awayWater: parts[2],
    };
  }

  private static normalizeMatchTime(raw?: string) {
    if (!raw) {
      return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }

    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.length === 16 ? `${trimmed}:00` : trimmed;
    }

    const mdhm = trimmed.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (mdhm) {
      const year = new Date().getFullYear();
      const [, month, day, hour, minute] = mdhm;
      return `${year}-${month}-${day} ${hour}:${minute}:00`;
    }

    return trimmed;
  }

  private static parseOdds(value?: string) {
    if (!value || value === '-') return 0;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private static parseHandicapMagnitude(value?: string) {
    if (!value || value === '-') return 0;
    const clean = String(value).replace('+', '').replace('-', '').trim();
    if (!clean) return 0;
    if (clean.includes('/')) {
      const parts = clean
        .split('/')
        .map((p) => Number.parseFloat(p))
        .filter((p) => Number.isFinite(p));
      if (parts.length !== 2) return 0;
      return Math.abs((parts[0] + parts[1]) / 2);
    }
    const n = Number.parseFloat(clean);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  }

  private static parseOddsTriplet(odds?: ExternalOdds): ParsedOdds {
    return {
      win: this.parseOdds(odds?.win),
      draw: this.parseOdds(odds?.draw),
      lose: this.parseOdds(odds?.lose),
    };
  }

  private static getTripletStats(odds: ParsedOdds) {
    const values = [odds.win, odds.draw, odds.lose].filter((v) => Number.isFinite(v) && v > 0);
    if (values.length !== 3) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, spread: max / min };
  }

  private static shouldSwapJingcaiMarkets(standard: ParsedOdds, handicap: ParsedOdds, handicapLine?: string) {
    const lineAbs = this.parseHandicapMagnitude(handicapLine);
    if (lineAbs < 1.5) return false;

    const s = this.getTripletStats(standard);
    const h = this.getTripletStats(handicap);
    if (!s || !h) return false;

    const standardLooksBalanced = s.min >= 1.7 && s.max <= 4.5 && s.spread <= 2.2;
    const handicapLooksSkewed = h.min <= 1.65 && h.max >= 4.5 && h.spread >= 2.5;
    return standardLooksBalanced && handicapLooksSkewed;
  }

  private static resolveJingcaiOddsMapping(match: ExternalMatch) {
    const standard = this.parseOddsTriplet(match.jingcaiOdds);
    const handicap = this.parseOddsTriplet(match.jingcaiHandicapOdds);
    const line = (match.jingcaiHandicap || match.handicap || '').trim();
    const lineAbs = this.parseHandicapMagnitude(line);
    const handicapIsEmpty = handicap.win <= 0 && handicap.draw <= 0 && handicap.lose <= 0;

    if (this.shouldSwapJingcaiMarkets(standard, handicap, line)) {
      return { standard: handicap, handicap: standard };
    }

    // 某些场次仅返回一组赔率，且盘口是 -2 / +2 等深盘，这组实际上是让球胜平负。
    // 这里将其归入 handicap，避免误写到标准胜平负。
    if (lineAbs >= 1.5 && handicapIsEmpty) {
      const s = this.getTripletStats(standard);
      if (s && s.min >= 1.7 && s.max <= 4.5) {
        return {
          standard: { win: 0, draw: 0, lose: 0 },
          handicap: standard,
        };
      }
    }

    return { standard, handicap };
  }

  private static buildHandicaps(match: ExternalMatch) {
    if (Array.isArray(match.crownHandicaps) && match.crownHandicaps.length > 0) {
      return this.getValidCrownHandicaps(match.crownHandicaps);
    }

    const rawHandicap = this.normalizeHandicapV2(match.crownAsia?.handicap);
    const homeOdds = this.parseOdds(match.crownAsia?.homeWater);
    const awayOdds = this.parseOdds(match.crownAsia?.awayWater);

    if (!rawHandicap || !homeOdds || !awayOdds) {
      return [];
    }

    const normalizedType = /^[+-]/.test(rawHandicap) ? rawHandicap : `${this.inferHomeHandicapSign(match)}${rawHandicap}`;
    return this.getValidCrownHandicaps([
      {
        type: normalizedType,
        home_odds: homeOdds,
        away_odds: awayOdds,
      },
    ]);
  }

  private static getValidCrownHandicaps(items: ExternalHandicap[]) {
    const seen = new Set<string>();
    const normalized = items
      .filter((item) => item && item.type && item.home_odds > 0 && item.away_odds > 0)
      .map((item) => ({
        type: this.normalizeHandicapV2(String(item.type || '')) || String(item.type || ''),
        home_odds: Number(item.home_odds),
        away_odds: Number(item.away_odds),
      }))
      .filter((item) => {
        const key = item.type;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    normalized.sort((a, b) => this.getHandicapSortValue(a.type) - this.getHandicapSortValue(b.type));
    return normalized.slice(0, REQUIRED_CROWN_HANDICAP_COUNT);
  }

  private static getHandicapSortValue(type: string) {
    const raw = String(type || '').trim();
    const sign = raw.startsWith('-') ? -1 : 1;
    const numeric = raw.replace(/^[+-]/, '');
    if (!numeric) return Number.POSITIVE_INFINITY;
    if (numeric.includes('/')) {
      const parts = numeric
        .split('/')
        .map((p) => Number.parseFloat(p))
        .filter((p) => Number.isFinite(p));
      if (parts.length === 2) return sign * ((parts[0] + parts[1]) / 2);
    }
    const v = Number.parseFloat(numeric);
    return Number.isFinite(v) ? sign * v : Number.POSITIVE_INFINITY;
  }

  private static inferHomeHandicapSign(match: ExternalMatch) {
    const homeWin = this.parseOdds(match.crownOdds?.win);
    const awayWin = this.parseOdds(match.crownOdds?.lose);
    if (homeWin > 0 && awayWin > 0) {
      return homeWin <= awayWin ? '-' : '+';
    }

    return '-';
  }

  private static normalizeHandicap(value?: string) {
    if (!value || value === '-') return null;

    const text = value.trim();
    const cleaned = text.replace(/\s+/g, '').replace(/(升|降)$/u, '');

    for (const [source, target] of handicapMappings) {
      if (cleaned === source.replace(/\s+/g, '')) return target;
    }

    if (cleaned.startsWith('受让')) return `+${cleaned.replace(/^受让/u, '').trim()}`;
    if (cleaned.startsWith('让')) return `-${cleaned.replace(/^让/u, '').trim()}`;

    return /^[0-9./+-]+$/.test(cleaned) ? cleaned.replace(/^\+/, '') : null;
  }

  private static normalizeHandicapV2(value?: string) {
    if (!value || value === '-') return null;

    const cleaned = value
      .trim()
      .replace(/\s+/g, '')
      .replace(/[()（）]/g, '')
      .replace(/\u76d8$/u, '')
      .replace(/\u76d8\u53e3$/u, '')
      .replace(/[\u5347\u964d]$/u, '');

    let sign = '';
    let body = cleaned;

    if (body.startsWith('+') || body.startsWith('-')) {
      sign = body[0];
      body = body.slice(1);
    } else if (body.startsWith('\u53d7\u8ba9')) {
      sign = '+';
      body = body.replace(/^\u53d7\u8ba9/u, '');
    } else if (body.startsWith('\u53d7')) {
      sign = '+';
      body = body.replace(/^\u53d7/u, '');
    } else if (body.startsWith('\u8ba9')) {
      sign = '-';
      body = body.replace(/^\u8ba9/u, '');
    }

    const mapped = HANDICAP_TEXT_MAP[body] || body;
    if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(mapped)) {
      return null;
    }

    return sign ? `${sign}${mapped}` : mapped;
  }

  private static async fetchHgaMatches(): Promise<HgaMatch[]> {
    const username = process.env.HGA_USERNAME || 'Boom8899';
    const password = process.env.HGA_PASSWORD || 'Aabb112233';
    const uid = await this.hgaLogin(username, password);
    if (!uid) throw new Error('HGA login failed');

    const listXmls = await Promise.all([
      this.fetchHgaGameListXml(uid, 'today', ''),
      this.fetchHgaGameListXml(uid, 'early', 'all'),
      this.fetchHgaGameListXml(uid, 'early', ''),
    ]);

    const all = [
      ...this.parseHgaGameList(listXmls[0], 'today'),
      ...this.parseHgaGameList(listXmls[1], 'early'),
      ...this.parseHgaGameList(listXmls[2], 'early'),
    ];
    const seen = new Set<string>();
    const baseMatches: HgaMatch[] = [];
    for (const item of all) {
      if (!item.ecid || seen.has(item.ecid)) continue;
      seen.add(item.ecid);
      baseMatches.push(item);
    }
    if (baseMatches.length === 0) return [];

    const enriched = await this.enrichHgaHandicapsV2(uid, username, password, baseMatches);
    return enriched;
  }

  private static async fetchHgaGameListXml(uid: string, showtype: string, date: string) {
    try {
      return await this.hgaPost(
        new URLSearchParams({
          uid,
          ver: HGA_VER,
          langx: 'zh-cn',
          p: 'get_game_list',
          p3type: '',
          date,
          gtype: 'ft',
          showtype,
          rtype: 'r',
          ltype: '3',
          filter: 'FT',
          cupFantasy: 'N',
          sorttype: 'L',
          specialClick: '',
          isFantasy: 'N',
          ts: String(Date.now()),
          chgSortTS: '0',
        })
      );
    } catch {
      return '';
    }
  }

  private static async hgaLogin(username: string, password: string): Promise<string | null> {
    if (this.hgaRiskBlocked) {
      throw new Error(`${HGA_ACCOUNT_LOCKED}: ${this.hgaLoginBlockedReason || 'risk blocked'}`);
    }

    if (this.hgaLoginBlockedUntil > Date.now()) {
      const remainSec = Math.ceil((this.hgaLoginBlockedUntil - Date.now()) / 1000);
      throw new Error(`${HGA_ACCOUNT_LOCKED}: cooldown ${remainSec}s ${this.hgaLoginBlockedReason}`.trim());
    }

    const userAgent = Buffer.from(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'utf-8'
    ).toString('base64');

    const xml = await this.hgaPost(
      new URLSearchParams({
        p: 'chk_login',
        langx: 'zh-cn',
        ver: HGA_VER,
        username,
        password,
        app: 'N',
        auto: 'IFGBGC',
        blackbox: '',
        userAgent,
      })
    );

    const status = this.extractXmlTag(xml, 'status');
    if (status !== '200') {
      const codeMessage = this.extractXmlTag(xml, 'code_message') || this.extractXmlTag(xml, 'msg') || 'unknown';
      if (String(codeMessage).includes(HGA_LOCK_HINT)) {
        // Upstream account lock. Stop using HGA in this process to avoid repeated risky retries.
        this.hgaLoginBlockedUntil = Date.now() + 30 * 60 * 1000;
        this.hgaLoginBlockedReason = String(codeMessage);
        this.hgaRiskBlocked = true;
        throw new Error(`${HGA_ACCOUNT_LOCKED}: ${codeMessage}`);
      }
      return null;
    }
    this.hgaLoginBlockedUntil = 0;
    this.hgaLoginBlockedReason = '';
    this.hgaRiskBlocked = false;
    const uid = this.extractXmlTag(xml, 'uid');
    return uid || null;
  }

  private static async hgaPost(params: URLSearchParams) {
    return this.hgaPostByBase(HGA_BASE_URL, params);
  }

  private static async hgaPostAlt(params: URLSearchParams) {
    return this.hgaPostByBase(HGA_ALT_BASE_URL, params);
  }

  private static async hgaPostByBase(baseUrl: string, params: URLSearchParams) {
    let lastErr: any = null;
    for (let i = 0; i < 4; i++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let res: Response;
        try {
          res = await fetch(baseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            body: params.toString(),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) {
          lastErr = new Error(`HGA request failed: ${res.status}`);
        } else {
          return await res.text();
        }
      } catch (err: any) {
        lastErr = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 140 * (i + 1)));
    }
    throw lastErr || new Error('HGA request failed');
  }

  private static parseHgaGameList(xml: string, sourceShowtype: 'today' | 'early'): HgaMatch[] {
    const games: HgaMatch[] = [];
    const gameRegex = /<game id="[^"]+">([\s\S]*?)<\/game>/g;
    let m: RegExpExecArray | null;
    while ((m = gameRegex.exec(xml)) !== null) {
      const block = m[1];
      const ecid = this.extractXmlTag(block, 'ECID');
      const league = this.extractXmlTag(block, 'LEAGUE');
      const homeTeam = this.extractXmlTag(block, 'TEAM_H');
      const awayTeam = this.extractXmlTag(block, 'TEAM_C');
      const dateTime = this.extractXmlTag(block, 'DATETIME');
      const strongRaw = (this.extractXmlTag(block, 'STRONG') || '').toUpperCase();
      const strong = strongRaw === 'H' || strongRaw === 'C' ? strongRaw : '';

      if (!ecid || !homeTeam || !awayTeam || !dateTime) continue;

      const crownOdds: ParsedOdds = {
        win: this.parseOdds(this.extractXmlTag(block, 'IOR_MH')),
        draw: this.parseOdds(this.extractXmlTag(block, 'IOR_MN')),
        lose: this.parseOdds(this.extractXmlTag(block, 'IOR_MC')),
      };

      const mainLine = this.extractXmlTag(block, 'RATIO_R');
      const mainHome = this.parseOdds(this.extractXmlTag(block, 'IOR_RH'));
      const mainAway = this.parseOdds(this.extractXmlTag(block, 'IOR_RC'));
      const mainType = this.normalizeHgaRType(mainLine, strong);
      const mainHandicaps: ExternalHandicap[] =
        mainType && mainHome > 0 && mainAway > 0
          ? [{ type: mainType, home_odds: mainHome, away_odds: mainAway }]
          : [];

      games.push({
        ecid,
        league,
        matchTime: this.normalizeHgaDateTime(dateTime),
        homeTeam,
        awayTeam,
        strong,
        sourceShowtype,
        crownOdds,
        handicaps: mainHandicaps,
      });
    }
    return games;
  }

  private static async enrichHgaHandicaps(uid: string, username: string, password: string, matches: HgaMatch[]) {
    const concurrency = 3;
    let currentUid = uid;
    let reloginPromise: Promise<string | null> | null = null;
    const ensureUid = async (force = false) => {
      if (!force && currentUid) return currentUid;
      if (!reloginPromise) {
        reloginPromise = this.hgaLogin(username, password).finally(() => {
          reloginPromise = null;
        });
      }
      const refreshed = await reloginPromise;
      if (refreshed) currentUid = refreshed;
      return currentUid;
    };

    let cursor = 0;
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (cursor < matches.length) {
        const index = cursor++;
        const match = matches[index];
        try {
          const full = await this.fetchHgaObtHandicapsWithRetry(uid, match.ecid, match.strong);
          if (full.length >= REQUIRED_CROWN_HANDICAP_COUNT) {
            matches[index] = { ...match, handicaps: full };
          }
        } catch {
          // 灰度链路失败时保留主盘口，不中断整体采集
        }
      }
    });
    await Promise.all(workers);
    return matches;
  }

  private static async enrichHgaHandicapsV2(uid: string, username: string, password: string, matches: HgaMatch[]) {
    const concurrency = 3;
    let currentUid = uid;
    let reloginPromise: Promise<string | null> | null = null;
    const ensureUid = async (force = false) => {
      if (!force && currentUid) return currentUid;
      if (!reloginPromise) {
        reloginPromise = this.hgaLogin(username, password).finally(() => {
          reloginPromise = null;
        });
      }
      const refreshed = await reloginPromise;
      if (refreshed) currentUid = refreshed;
      return currentUid;
    };

    let cursor = 0;
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (cursor < matches.length) {
        const index = cursor++;
        const match = matches[index];

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const activeUid = await ensureUid(attempt > 0);
            if (!activeUid) break;
            const full = await this.fetchHgaObtHandicapsWithRetryV2(activeUid, match);
            if (full.length >= REQUIRED_CROWN_HANDICAP_COUNT) {
              matches[index] = { ...match, handicaps: full };
            }
            break;
          } catch (err: any) {
            if (String(err?.message || err) === HGA_SESSION_EXPIRED) {
              await ensureUid(true);
              continue;
            }
            break;
          }
        }
      }
    });

    await Promise.all(workers);
    return matches;
  }

  private static async fetchHgaObtHandicapsWithRetry(uid: string, ecid: string, strong: 'H' | 'C' | '') {
    let best: ExternalHandicap[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        const rowsToday = await this.fetchHgaObtHandicaps(uid, ecid, strong, 'today', 'N');
        const rowsEarly = await this.fetchHgaObtHandicaps(uid, ecid, strong, 'early', 'Y');
        const rows = rowsEarly.length > rowsToday.length ? rowsEarly : rowsToday;
        if (rows.length > best.length) {
          best = rows;
        }
        if (rows.length >= REQUIRED_CROWN_HANDICAP_COUNT) {
          return rows;
        }
      } catch {
        // ignore and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)));
    }
    return best;
  }

  private static async fetchHgaObtHandicapsWithRetryV2(uid: string, match: HgaMatch) {
    let best: ExternalHandicap[] = this.getValidCrownHandicaps(match.handicaps || []);
    const route: Array<{ showtype: 'today' | 'early' | 'parlay'; isEarly: 'N' | 'Y' }> =
      match.sourceShowtype === 'early'
        ? [
            { showtype: 'early', isEarly: 'Y' },
            { showtype: 'today', isEarly: 'N' },
            { showtype: 'parlay', isEarly: 'Y' },
          ]
        : [
            { showtype: 'today', isEarly: 'N' },
            { showtype: 'early', isEarly: 'Y' },
            { showtype: 'parlay', isEarly: 'Y' },
          ];
    const models: Array<'OU|MIX' | 'OU'> = ['OU|MIX', 'OU'];

    for (let i = 0; i < 3; i++) {
      try {
        for (const item of route) {
          for (const model of models) {
            const rows = await this.fetchHgaObtHandicaps(uid, match.ecid, match.strong, item.showtype, item.isEarly, model);
            const merged = this.getValidCrownHandicaps([...(best || []), ...rows]);
            if (merged.length > best.length) best = merged;
            if (best.length >= REQUIRED_CROWN_HANDICAP_COUNT) return best;
          }
        }
      } catch (err: any) {
        if (String(err?.message || err) === HGA_SESSION_EXPIRED) {
          throw err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)));
    }
    return best;
  }

  private static async fetchHgaObtHandicaps(
    uid: string,
    ecid: string,
    strong: 'H' | 'C' | '',
    showtype: 'today' | 'early' | 'parlay',
    isEarly: 'N' | 'Y',
    model: 'OU|MIX' | 'OU' = 'OU|MIX'
  ) {
    const buildParams = () =>
      new URLSearchParams({
        uid,
        ver: HGA_VER,
        langx: 'zh-cn',
        p: 'get_game_OBT',
        gtype: 'ft',
        showtype,
        isSpecial: '',
        isEarly,
        model,
        isETWI: 'N',
        ecid,
        ltype: '3',
        is_rb: 'N',
        ts: String(Date.now()),
        isClick: 'Y',
      });
    const isNoDataXml = (xmlText: string) => xmlText.includes('<code>noData</code>') || xmlText.startsWith('VariableStandard');

    let xml = await this.hgaPost(buildParams());
    if (xml.startsWith('CheckEMNU')) throw new Error(HGA_SESSION_EXPIRED);
    if (isNoDataXml(xml)) {
      const alt = await this.hgaPostAlt(buildParams());
      if (alt.startsWith('CheckEMNU')) throw new Error(HGA_SESSION_EXPIRED);
      xml = alt;
      if (isNoDataXml(xml)) return [];
    }

    const lines = [...xml.matchAll(/<RATIO_R>(.*?)<\/RATIO_R>/g)].map((x) => x[1]?.trim() || '');
    const homes = [...xml.matchAll(/<IOR_RH>(.*?)<\/IOR_RH>/g)].map((x) => this.parseOdds(x[1]));
    const aways = [...xml.matchAll(/<IOR_RC>(.*?)<\/IOR_RC>/g)].map((x) => this.parseOdds(x[1]));

    const maxLen = Math.min(lines.length, homes.length, aways.length);
    const out: ExternalHandicap[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < maxLen; i++) {
      const type = this.normalizeHgaRType(lines[i], strong);
      const home = homes[i];
      const away = aways[i];
      if (!type || home <= 0 || away <= 0) continue;
      const key = `${type}|${home}|${away}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, home_odds: home, away_odds: away });
    }
    return this.getValidCrownHandicaps(out);
  }

  private static normalizeHgaDateTime(raw: string) {
    const t = (raw || '').trim();
    const m = t.match(/^(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})([ap])$/i);
    if (!m) return this.normalizeMatchTime(t);
    const now = new Date();
    let year = now.getFullYear();
    const month = Number.parseInt(m[1], 10);
    const day = Number.parseInt(m[2], 10);
    let hour = Number.parseInt(m[3], 10);
    const minute = Number.parseInt(m[4], 10);
    const ap = m[5].toLowerCase();
    if (ap === 'p' && hour < 12) hour += 12;
    if (ap === 'a' && hour === 12) hour = 0;
    // 跨年兜底
    if (month === 1 && now.getMonth() >= 10) year += 1;
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    const mo = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mo}-${dd} ${hh}:${mm}:00`;
  }

  private static normalizeHgaRType(rawLine: string, strong: 'H' | 'C' | '') {
    const line = this.normalizeHandicapV2(rawLine);
    if (!line) return null;
    if (line.startsWith('+') || line.startsWith('-')) return line;
    const sign = strong === 'C' ? '+' : '-';
    return `${sign}${line}`;
  }

  private static extractXmlTag(block: string, tag: string) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const m = block.match(regex);
    return m ? m[1].trim() : '';
  }

  private static normalizeNameForMatch(name?: string) {
    return (name || '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  private static teamNameLikelySame(a?: string, b?: string) {
    const na = this.normalizeNameForMatch(a);
    const nb = this.normalizeNameForMatch(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if ((na.includes(nb) || nb.includes(na)) && Math.min(na.length, nb.length) >= 2) {
      return true;
    }
    return false;
  }

  private static pickBestHgaCandidate(oldMatch: ExternalMatch, candidates: HgaMatch[]) {
    if (candidates.length === 0) return null;
    const oldTime = this.normalizeMatchTime(oldMatch.matchTime);
    const oldDate = oldTime.slice(0, 10);
    const oldLeague = this.normalizeNameForMatch(oldMatch.league);
    const oldCrownWin = this.parseOdds(oldMatch.crownOdds?.win);
    const oldCrownDraw = this.parseOdds(oldMatch.crownOdds?.draw);
    const oldCrownLose = this.parseOdds(oldMatch.crownOdds?.lose);

    let best: { row: HgaMatch; score: number } | null = null;
    for (const row of candidates) {
      let score = 0;
      const homeExact = this.normalizeNameForMatch(row.homeTeam) === this.normalizeNameForMatch(oldMatch.homeTeam);
      const awayExact = this.normalizeNameForMatch(row.awayTeam) === this.normalizeNameForMatch(oldMatch.awayTeam);
      const homeLoose = this.teamNameLikelySame(row.homeTeam, oldMatch.homeTeam);
      const awayLoose = this.teamNameLikelySame(row.awayTeam, oldMatch.awayTeam);

      if (homeExact) score += 4;
      else if (homeLoose) score += 2;
      if (awayExact) score += 4;
      else if (awayLoose) score += 2;

      const rowTime = this.normalizeMatchTime(row.matchTime);
      if (rowTime.slice(0, 16) === oldTime.slice(0, 16)) score += 3;
      else if (rowTime.slice(0, 10) === oldDate) score += 1;

      const rowLeague = this.normalizeNameForMatch(row.league);
      if (oldLeague && rowLeague && (oldLeague === rowLeague || oldLeague.includes(rowLeague) || rowLeague.includes(oldLeague))) {
        score += 1;
      }

      if (oldCrownWin > 0 && oldCrownDraw > 0 && oldCrownLose > 0) {
        const diff =
          Math.abs(oldCrownWin - row.crownOdds.win) +
          Math.abs(oldCrownDraw - row.crownOdds.draw) +
          Math.abs(oldCrownLose - row.crownOdds.lose);
        if (diff <= 0.3) score += 4;
        else if (diff <= 0.7) score += 2;
      }

      const canAccept =
        score >= 5 ||
        (rowTime.slice(0, 16) === oldTime.slice(0, 16) &&
          oldCrownWin > 0 &&
          oldCrownDraw > 0 &&
          oldCrownLose > 0 &&
          Math.abs(oldCrownWin - row.crownOdds.win) +
            Math.abs(oldCrownDraw - row.crownOdds.draw) +
            Math.abs(oldCrownLose - row.crownOdds.lose) <=
            0.3);

      if (canAccept && (!best || score > best.score)) {
        best = { row, score };
      }
    }
    return best?.row || null;
  }

  private static mergeHgaCrownData(legacyMatches: ExternalMatch[], hgaMatches: HgaMatch[]) {
    if (legacyMatches.length === 0) return legacyMatches;
    const byPair = new Map<string, HgaMatch[]>();
    for (const m of hgaMatches) {
      const key = `${this.normalizeNameForMatch(m.homeTeam)}|${this.normalizeNameForMatch(m.awayTeam)}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key)!.push(m);
    }
    for (const list of byPair.values()) {
      list.sort((a, b) => a.matchTime.localeCompare(b.matchTime));
    }

    let enriched = 0;
    const merged = legacyMatches.map((oldMatch) => {
      const key = `${this.normalizeNameForMatch(oldMatch.homeTeam)}|${this.normalizeNameForMatch(oldMatch.awayTeam)}`;
      const strictCandidates = byPair.get(key) || [];
      const chosen =
        this.pickBestHgaCandidate(oldMatch, strictCandidates) ||
        this.pickBestHgaCandidate(oldMatch, hgaMatches);
      if (!chosen) return oldMatch;

      const patched: ExternalMatch = {
        ...oldMatch,
        crownOdds: {
          win: chosen.crownOdds.win > 0 ? String(chosen.crownOdds.win) : oldMatch.crownOdds?.win,
          draw: chosen.crownOdds.draw > 0 ? String(chosen.crownOdds.draw) : oldMatch.crownOdds?.draw,
          lose: chosen.crownOdds.lose > 0 ? String(chosen.crownOdds.lose) : oldMatch.crownOdds?.lose,
        },
        crownHandicaps: this.getValidCrownHandicaps([
          ...this.getValidCrownHandicaps(chosen.handicaps),
          ...this.getValidCrownHandicaps(this.buildHandicaps(oldMatch)),
        ]),
      };
      if ((patched.crownHandicaps || []).length >= REQUIRED_CROWN_HANDICAP_COUNT) {
        enriched += 1;
        return patched;
      }
      return patched;
    });
    console.log(`HGA gray source enriched crown data for ${enriched}/${legacyMatches.length} matches`);
    return merged;
  }

  private static shouldOnlySyncCompleteMatches() {
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id?: number } | undefined;
    if (!admin?.id) {
      return true;
    }

    const setting = db
      .prepare("SELECT value FROM system_settings WHERE user_id = ? AND key = 'only_complete_matches'")
      .get(admin.id) as { value?: string } | undefined;

    if (!setting) {
      return true;
    }

    return setting.value !== 'false';
  }

  private static isMatchComplete(match: ExternalMatch) {
    const hasBaseInfo = Boolean(
      match.league?.trim() &&
        match.round?.trim() &&
        match.matchTime?.trim() &&
        match.homeTeam?.trim() &&
        match.awayTeam?.trim()
    );

    const handicap = (match.handicap || '').trim();
    const jingcaiHandicap = (match.jingcaiHandicap || '').trim();
    const hasJingcaiOdds =
      this.parseOdds(match.jingcaiOdds?.win) > 0 &&
      this.parseOdds(match.jingcaiOdds?.draw) > 0 &&
      this.parseOdds(match.jingcaiOdds?.lose) > 0;
    const hasJingcaiHandicapOdds =
      this.parseOdds(match.jingcaiHandicapOdds?.win) > 0 &&
      this.parseOdds(match.jingcaiHandicapOdds?.draw) > 0 &&
      this.parseOdds(match.jingcaiHandicapOdds?.lose) > 0;
    const hasCrownOdds =
      this.parseOdds(match.crownOdds?.win) > 0 &&
      this.parseOdds(match.crownOdds?.draw) > 0 &&
      this.parseOdds(match.crownOdds?.lose) > 0;
    const hasCrownHandicaps = this.getValidCrownHandicaps(this.buildHandicaps(match)).length >= REQUIRED_CROWN_HANDICAP_COUNT;

    return (
      hasBaseInfo &&
      Boolean(handicap) &&
      handicap !== '-' &&
      Boolean(jingcaiHandicap) &&
      jingcaiHandicap !== '-' &&
      hasJingcaiOdds &&
      hasJingcaiHandicapOdds &&
      hasCrownOdds &&
      hasCrownHandicaps
    );
  }

  static async scanOpportunities(userId: number) {
    const settings = db.prepare('SELECT * FROM system_settings WHERE user_id = ?').all(userId);
    const settingsMap = settings.reduce((acc: any, curr: any) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});

    const jcRebate = parseFloat(settingsMap['default_jingcai_rebate'] || '0.13');
    const crownRebate = parseFloat(settingsMap['default_crown_rebate'] || '0.02');
    const jcShare = parseFloat(settingsMap['default_jingcai_share'] || '0');
    const crownShare = parseFloat(settingsMap['default_crown_share'] || '0');

    const matches = db.prepare(`
      SELECT m.*, m.jingcai_handicap as jc_handicap,
             j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
             j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
             j.rebate_rate as j_r, j.share_rate as j_s,
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h,
             c.rebate_rate as c_r, c.share_rate as c_s
      FROM matches m
      JOIN jingcai_odds j ON m.match_id = j.match_id
      JOIN crown_odds c ON m.match_id = c.match_id
      WHERE m.status = 'upcoming'
    `).all();

    db.prepare('DELETE FROM arbitrage_opportunities WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM parlay_opportunities WHERE user_id = ?').run(userId);

    const baseTypes: ('jingcai' | 'crown')[] = ['jingcai', 'crown'];

    for (const baseType of baseTypes) {
      for (const m of matches as any) {
        const jcOdds = {
          W: m.j_w,
          D: m.j_d,
          L: m.j_l,
          HW: m.j_hw,
          HD: m.j_hd,
          HL: m.j_hl,
          handicapLine: m.jc_handicap,
          rebate: Number.isFinite(Number(m.j_r)) ? Number(m.j_r) : jcRebate,
          share: Number.isFinite(Number(m.j_s)) ? Number(m.j_s) : jcShare
        };
        const crownOdds = {
          W: m.c_w,
          D: m.c_d,
          L: m.c_l,
          handicaps: m.c_h ? JSON.parse(m.c_h) : [],
          rebate: Number.isFinite(Number(m.c_r)) ? Number(m.c_r) : crownRebate,
          share: Number.isFinite(Number(m.c_s)) ? Number(m.c_s) : crownShare,
        };

        const opportunities = ArbitrageEngine.findAllOpportunities(10000, jcOdds, crownOdds, baseType);

        if (opportunities.length > 0) {
          const best = opportunities[0];
          const jcSide = best.jcSide || 'W';

          db.prepare(`
            INSERT INTO arbitrage_opportunities (user_id, match_id, jingcai_side, jingcai_odds, best_strategy, profit_rate, base_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            userId,
            m.match_id,
            jcSide,
            best.jc_odds || (jcOdds[jcSide as keyof typeof jcOdds] as number),
            JSON.stringify(best),
            best.min_profit_rate,
            baseType
          );
        }
      }

      const parlayOpportunities = ArbitrageEngine.findParlayOpportunities(
        10000,
        matches.map((m) => ({
          ...m,
          j_r: jcRebate,
          j_s: jcShare,
          c_r: crownRebate,
          c_s: crownShare,
        })),
        baseType
      );

      for (const p of parlayOpportunities) {
        db.prepare(`
          INSERT INTO parlay_opportunities (user_id, match_id_1, match_id_2, side_1, side_2, odds_1, odds_2, combined_odds, best_strategy, profit_rate, base_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          p.match_id_1,
          p.match_id_2,
          p.side_1,
          p.side_2,
          p.odds_1,
          p.odds_2,
          p.combined_odds,
          JSON.stringify(p.best_strategy),
          p.profit_rate,
          baseType
        );
      }
    }

    console.log(`Opportunity scan completed for user ${userId}`);
  }
}
