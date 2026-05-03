import { load } from 'cheerio';
import fs from 'fs';
import path from 'path';
import { Agent } from 'undici';
import db, { formatLocalDbDateTime } from './db';
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

type ExternalGoalOdds = {
  label: string;
  odds: number;
};

type ExternalOverUnderOdds = {
  line: string;
  over_odds: number;
  under_odds: number;
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
  crownGoalOdds?: ExternalGoalOdds[];
  crownOverUnderOdds?: ExternalOverUnderOdds[];
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
  overUnderOdds: ExternalOverUnderOdds[];
};

type HgaAliasSuggestion = {
  jingcai_name: string;
  huangguan_name: string;
  trade500_name?: string;
  hga_name?: string;
  source: 'odds_fallback';
  match_id: string;
  match_time: string;
  created_at: string;
  match_count: number;
};

type HgaAliasGroup = {
  group_id: string;
  canonical: string;
  aliases: string[];
};

type HgaAliasConflict = {
  duplicate_name: string;
  conflict_group_id: string;
  message: string;
};

const REQUIRED_CROWN_HANDICAP_COUNT = 3;
const CROWN_HANDICAP_STORE_LIMIT = 20;
const HGA_SESSION_EXPIRED = 'HGA_SESSION_EXPIRED';
const HGA_ACCOUNT_LOCKED = 'HGA_ACCOUNT_LOCKED';
const HGA_CREDENTIALS_INVALID = 'HGA_CREDENTIALS_INVALID';
const HGA_DOUBLE_LOGIN = 'HGA_DOUBLE_LOGIN';
const HGA_LOCK_HINT = '密码错误次数过多';
const HGA_CREDENTIAL_ERROR_HINTS = ['请检查账号或密码', '账号或密码错误', '密码错误', '登录失败'];
const DEFAULT_TEAM_NAME_ALIAS_MAP: Record<string, string> = {
  奥克兰fc: '奥克兰',
  女王公园巡游者: '女王公园',
  诺维奇: '诺域治',
  朴次茅斯: '朴茨茅夫',
  西布罗姆维奇: '西布朗',
  吉达联合: '伊蒂哈德吉达',
  拉斯决心: '艾哈斯姆',
  拉瓦勒: '拉华尔',
  巴黎圣日尔曼: '巴黎圣曼',
  巴黎圣日耳曼: '巴黎圣曼',
  巴黎圣曼: '巴黎圣日耳曼',
  图卢兹: '图鲁兹',
  里斯本竞技: '士砵亭',
  士砵亭: '里斯本竞技',
  圣克拉拉: '圣塔克莱拉',
  巴列卡诺: '华历简奴',
  埃尔切: '艾尔切',
  圣旺红星: '红星',
};
const DEFAULT_FIXTURE_PAIR_ALIAS_MAP: Record<string, string> = {
  '西布罗姆维奇|雷克斯汉姆': '西布朗|威斯汉姆',
};

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
const HGA_FETCH_TIMEOUT_MS = 150000;
const HGA_PHASE_LOGIN_TIMEOUT_MS = 25000;
const HGA_PHASE_LIST_TIMEOUT_MS = 30000;
const HGA_PHASE_MARKET_ITEM_TIMEOUT_MS = 22000;
const HGA_OBT_BATCH_SIZE = 8;
const HGA_OBT_BATCH_RETRY = 2;
const HGA_OBT_CONCURRENCY = 2;
const HGA_DEGRADED_KEEP_MAX_STREAK = 3;
const HGA_DEGRADED_KEEP_MAX_MINUTES = 20;
const SYNC_MIN_ROW_RATIO = (() => {
  const raw = Number(process.env.SYNC_MIN_ROW_RATIO || process.env.SNAPSHOT_MIN_ROW_RATIO || '0.5');
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return 0.5;
  return raw;
})();
const EMPTY_SNAPSHOT_STALE_THRESHOLD = 8;
const PLAYWRIGHT_FALLBACK_TIMEOUT_MS = 45000;
const PLAYWRIGHT_CROWN_PATCH_TIMEOUT_MS = 90000;
const PLAYWRIGHT_365RICH_PATCH_TIMEOUT_MS = 120000;
const TRADE500_XML_NSPF_URL = 'https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml';
const TRADE500_XML_SPF_URL = 'https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml';
const TRADE500_ODDS_XML_HOSTS = ['https://www.500.com', 'https://trade.500.com', 'https://ews.500.com'];
const TRADE500_ODDS_XML_PATH = '/static/public/jczq/xml/odds/odds.xml';
const TRADE500_XML_STALE_DAYS = 2;
const LIVE500_JCZQ_URL = 'https://live.500.com/jczq.php';
const LIVE500_ZQDC_URL = 'https://live.500.com/zqdc.php';
const ODDS500_OUZHI_URL = 'https://odds.500.com/fenxi/ouzhi-';
const LIVE500_CROWN_COMPANY_ID = '280';
const LIVE500_CROWN_FETCH_CONCURRENCY = 4;
const SOURCE_BUDGET_TIMEOUT_MS = 12000;
const HGA_TEAM_ALIAS_MAP_FILE = path.resolve(process.cwd(), 'config', 'hga-team-alias-map.json');
const HGA_PENDING_ALIAS_SUGGESTIONS_KEY = 'hga_team_alias_pending_suggestions';
const DEFAULT_HGA_ALIAS_AUTO_APPLY_THRESHOLD = 3;
const HGA_ALIAS_TIME_OFFSET_HOURS = 12;
const HGA_TIME_MATCH_TOLERANCE_MINUTES = 45;
const SPORTTERY_HAD_URL = 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=had';
const SPORTTERY_HHAD_URL = 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=hhad';
const SPORTTERY_TTG_URL = 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry?channel=c&poolCode=ttg';
const DEFAULT_365_MATCHER_CONFIG: Rich365MatcherConfig = {
  enabled: true,
  timeToleranceMinutes: 90,
  autoThreshold: 0.78,
  reviewThreshold: 0.6,
  aliasWeight: 0.45,
  timeWeight: 0.2,
  leagueWeight: 0.1,
  asianWeight: 0.2,
  ouWeight: 0.05,
  asianLineTolerance: 0.25,
  waterTolerance: 0.18,
  ouLineTolerance: 0.25,
  ouWaterTolerance: 0.18,
};
const GOAL_LABEL_ORDER = ['0球', '1球', '2球', '3球', '4球', '5球', '6球', '7+球'] as const;
const DISPLAY_TEAM_CANONICAL_MAP_FILE = path.resolve(process.cwd(), 'config/team-display-canonical-map.json');

const TARGETED_365_OU_RULES: Targeted365Rule[] = [
  {
    date: '2026-04-26',
    home: '哥德堡',
    away: '盖斯',
    scheduleId: '2912146',
    sourceUrl: 'https://m.365rich.cn/overunder/2912146.htm',
  },
  {
    date: '2026-04-27',
    home: '都灵',
    away: '国际米兰',
    scheduleId: '2784821',
    sourceUrl: 'https://m.365rich.cn/overunder/2784821.htm',
  },
  {
    date: '2026-04-27',
    home: '奥萨苏纳',
    away: '塞维利亚',
    scheduleId: '2804609',
    sourceUrl: 'https://m.365rich.cn/overunder/2804609.htm',
  },
  {
    date: '2026-04-27',
    home: '圣克拉拉',
    away: '布拉加',
    scheduleId: '2814999',
    sourceUrl: 'https://m.365rich.cn/overunder/2814999.htm',
  },
  {
    date: '2026-04-28',
    home: '曼联',
    away: '布伦特',
    scheduleId: '2789465',
    sourceUrl: 'https://m.365rich.cn/overunder/2789465.htm',
  },
  {
    date: '2026-04-28',
    home: '西班牙人',
    away: '莱万特',
    scheduleId: '2804607',
    sourceUrl: 'https://m.365rich.cn/overunder/2804607.htm',
  },
];

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

type Live500CrownOddsMap = {
  byExact: Map<string, ExternalOdds>;
  byMatchnum: Map<string, ExternalOdds>;
};

type Trade500CrownHandicapFallbackMap = {
  byExact: Map<string, ExternalHandicap>;
  byMatchnum: Map<string, ExternalHandicap>;
};

type Trade500GoalOddsFallbackMap = {
  byExact: Map<string, ExternalGoalOdds[]>;
  byMatchnum: Map<string, ExternalGoalOdds[]>;
  byPair: Map<string, ExternalGoalOdds[]>;
  byPairDate: Map<string, ExternalGoalOdds[]>;
};

type Odds500CrownHandicapMap = {
  byExact: Map<string, ExternalHandicap>;
  byMatchnum: Map<string, ExternalHandicap>;
  byPair: Map<string, ExternalHandicap>;
  byPairDate: Map<string, ExternalHandicap>;
};

type Odds500CrownOverUnderMap = {
  byExact: Map<string, ExternalOverUnderOdds>;
  byMatchnum: Map<string, ExternalOverUnderOdds>;
  byPair: Map<string, ExternalOverUnderOdds>;
  byPairDate: Map<string, ExternalOverUnderOdds>;
};
type Odds500DaxiaoListEntry = {
  fid: string;
  matchTime: string;
  homeTeam: string;
  awayTeam: string;
  round?: string;
  ou: ExternalOverUnderOdds;
};

type Live500FixtureMap = {
  byExact: Map<string, string>;
  byMatchnum: Map<string, string>;
  byPair: Map<string, string>;
  byExactTeams: Map<string, { home: string; away: string }>;
};

type Rich365CrownRow = {
  sourceMatchId: string;
  sourceDate?: string;
  matchTime: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  handicap?: { line?: string; homeOdds?: number; awayOdds?: number };
  overUnder?: { line?: string; overOdds?: number; underOdds?: number };
  handicaps?: ExternalHandicap[];
  overUnderOdds?: ExternalOverUnderOdds[];
};

type Rich365MatcherConfig = {
  enabled: boolean;
  timeToleranceMinutes: number;
  autoThreshold: number;
  reviewThreshold: number;
  aliasWeight: number;
  timeWeight: number;
  leagueWeight: number;
  asianWeight: number;
  ouWeight: number;
  asianLineTolerance: number;
  waterTolerance: number;
  ouLineTolerance: number;
  ouWaterTolerance: number;
};

type Rich365MatchScoreDetail = {
  aliasScore: number;
  timeScore: number;
  leagueScore: number;
  asianScore: number;
  ouScore: number;
  totalScore: number;
  timeDiffMinutes: number;
  hitRules: string[];
};

type Targeted365Rule = {
  date: string;
  home: string;
  away: string;
  scheduleId: string;
  sourceUrl: string;
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
  c_goal: ExternalGoalOdds[];
  c_ou: ExternalOverUnderOdds[];
};

type FieldTrace = {
  source: SourceKey;
  fetched_at: string;
  note?: string;
};

type UnifiedJcOdds = {
  win: number | null;
  draw: number | null;
  lose: number | null;
};

type UnifiedGoalOdds = {
  label: string;
  odds: number;
};

type UnifiedHandicapOdds = {
  line: string;
  home: number;
  away: number;
};

type UnifiedOverUnderOdds = {
  line: string;
  over: number;
  under: number;
};

type UnifiedSnapshotRecord = {
  match_key: string;
  source_match_id: Record<string, string>;
  issue_no: string;
  league_name: string;
  match_time: string;
  home_team: string;
  away_team: string;
  handicap: string;
  jc_spf: UnifiedJcOdds;
  jc_rqspf: UnifiedJcOdds;
  jc_goals: UnifiedGoalOdds[];
  hg_spf: UnifiedJcOdds;
  hg_handicap: UnifiedHandicapOdds[];
  hg_ou: UnifiedOverUnderOdds[];
  updated_at: string;
  source_trace: Record<string, FieldTrace | undefined>;
  raw?: {
    sporttery?: ExternalMatch;
    trade500?: ExternalMatch;
    merged?: ExternalMatch;
  };
};

type SyncRowChangeEvent = {
  match_id: string;
  change_type: 'insert' | 'update' | 'delete';
  changed_fields: string[];
};

type SourceKey = 'hga' | 'live500' | 'trade500' | 'odds500' | 'sporttery' | 'other';

const SOURCE_BUDGET_CONFIG: Record<
  SourceKey,
  { maxConcurrent: number; minIntervalMs: number; jitterMs: number; circuitFailThreshold: number; circuitOpenMs: number }
> = {
  hga: { maxConcurrent: 2, minIntervalMs: 120, jitterMs: 80, circuitFailThreshold: 10, circuitOpenMs: 90000 },
  live500: { maxConcurrent: 2, minIntervalMs: 200, jitterMs: 120, circuitFailThreshold: 10, circuitOpenMs: 180000 },
  trade500: { maxConcurrent: 2, minIntervalMs: 220, jitterMs: 120, circuitFailThreshold: 10, circuitOpenMs: 180000 },
  odds500: { maxConcurrent: 1, minIntervalMs: 450, jitterMs: 220, circuitFailThreshold: 8, circuitOpenMs: 300000 },
  sporttery: { maxConcurrent: 2, minIntervalMs: 180, jitterMs: 120, circuitFailThreshold: 8, circuitOpenMs: 120000 },
  other: { maxConcurrent: 2, minIntervalMs: 120, jitterMs: 80, circuitFailThreshold: 12, circuitOpenMs: 120000 },
};

const HTTP_TEXT_CACHE = new Map<string, HttpCacheEntry>();
const HGA_HTTP_AGENT = new Agent({
  connect: {
    timeout: 25000,
  },
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 120000,
});

type HgaTuningParams = {
  login_timeout_ms: number;
  list_timeout_ms: number;
  market_item_timeout_ms: number;
  obt_batch_size: number;
  obt_batch_retry: number;
  obt_concurrency: number;
};

const DEFAULT_HGA_TUNING_PARAMS: HgaTuningParams = {
  login_timeout_ms: HGA_PHASE_LOGIN_TIMEOUT_MS,
  list_timeout_ms: HGA_PHASE_LIST_TIMEOUT_MS,
  market_item_timeout_ms: HGA_PHASE_MARKET_ITEM_TIMEOUT_MS,
  obt_batch_size: HGA_OBT_BATCH_SIZE,
  obt_batch_retry: HGA_OBT_BATCH_RETRY,
  obt_concurrency: HGA_OBT_CONCURRENCY,
};
const require = createRequire(import.meta.url);

export class CrawlerService {
  private static displayTeamCanonicalMapCache: Map<string, string> | null = null;
  private static hgaLoginBlockedUntil = 0;
  private static hgaLoginBlockedReason = '';
  private static hgaRiskBlocked = false;
  private static hgaLastStatus: 'unknown' | 'disabled' | 'ok' | 'empty' | 'failed' | 'timeout' | 'locked' = 'unknown';
  private static hgaLastMessage = '';
  private static hgaMappingCache:
    | {
        teamAliasMap: Record<string, string>;
        teamAliasMapText: string;
        groups: HgaAliasGroup[];
      }
    | null = null;
  private static hgaMappingCacheFileMtimeMs = 0;

  private static lastFetchMeta: {
    hga_status: 'ok' | 'empty' | 'failed' | 'timeout' | 'unknown' | 'locked';
    hga_count: number;
    base_count: number;
    merged_count: number;
    playwright_fallback_used: boolean;
    rich365_match_auto_count: number;
    rich365_match_review_count: number;
    rich365_match_reject_count: number;
    rich365_d0_match_count: number;
    rich365_d1_match_count: number;
    rich365_ou_fallback_hit_count: number;
    odds500_yazhi_hit_count: number;
    odds500_daxiao_hit_count: number;
    trade500_jqs_hit_count: number;
    hga_override_hit_count: number;
    primary_source: 'sporttery' | 'trade500' | 'unknown';
  } = {
    hga_status: 'unknown',
    hga_count: 0,
    base_count: 0,
    merged_count: 0,
    playwright_fallback_used: false,
    rich365_match_auto_count: 0,
    rich365_match_review_count: 0,
    rich365_match_reject_count: 0,
    rich365_d0_match_count: 0,
    rich365_d1_match_count: 0,
    rich365_ou_fallback_hit_count: 0,
    odds500_yazhi_hit_count: 0,
    odds500_daxiao_hit_count: 0,
    trade500_jqs_hit_count: 0,
    hga_override_hit_count: 0,
    primary_source: 'unknown',
  };
  private static sourceActiveCount = new Map<SourceKey, number>();
  private static sourceNextAllowedAtMs = new Map<SourceKey, number>();
  private static sourceFailureMeta = new Map<SourceKey, { failCount: number; openUntilMs: number; lastReason: string }>();
  private static hgaTuningOverride: HgaTuningParams | null = null;
  private static hgaSessionCache: { uid: string; username: string; password: string; updatedAtMs: number } | null = null;
  private static hgaTargetHealth = new Map<
    string,
    { lastAttemptAtMs: number; lastSuccessAtMs: number; failStreak: number; handicapCount: number; overUnderCount: number }
  >();

  private static async yieldToEventLoop() {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  static async mockCrawl() {
    return this.syncFromExternalScraper();
  }

  static async onlineCrawl(_apiUrl: string) {
    return this.syncFromExternalScraper();
  }

  static getHgaStatus() {
    const config = this.getHgaConfig();
    const persistedRuntime = this.getPersistedHgaRuntimeState();
    const runtimeStatus = this.hgaLastStatus !== 'unknown' ? this.hgaLastStatus : persistedRuntime.status;
    const runtimeMessage = this.hgaLastMessage || persistedRuntime.message;
    const derivedStatus = !config.enabled
      ? runtimeStatus === 'failed' && runtimeMessage
        ? 'failed'
        : 'disabled'
      : this.hgaRiskBlocked
        ? 'locked'
        : runtimeStatus;
    const derivedMessage = !config.enabled
      ? runtimeMessage || 'HGA 抓取已关闭，当前仅使用 Trade500 主链路'
      : this.hgaRiskBlocked
        ? this.hgaLoginBlockedReason || runtimeMessage || 'HGA 已被上游风控锁定'
        : runtimeMessage;
    return {
      enabled: config.enabled,
      username: config.username,
      password_configured: Boolean(config.password),
      status: derivedStatus,
      message: derivedMessage,
      blocked_until: this.hgaLoginBlockedUntil > 0 ? new Date(this.hgaLoginBlockedUntil).toISOString() : null,
      last_fetch_meta: { ...this.lastFetchMeta },
    };
  }

  static resetHgaRuntimeState() {
    this.hgaLoginBlockedUntil = 0;
    this.hgaLoginBlockedReason = '';
    this.hgaRiskBlocked = false;
    this.hgaLastStatus = 'unknown';
    this.hgaLastMessage = '';
    this.hgaSessionCache = null;
    this.persistHgaRuntimeState('unknown', '');
  }

  private static clearHgaSessionCache() {
    this.hgaSessionCache = null;
  }

  private static normalizeHgaTuningParams(raw: Partial<HgaTuningParams> | null | undefined): HgaTuningParams {
    const toInt = (value: unknown, fallback: number) => {
      const n = Number.parseInt(String(value ?? fallback), 10);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      login_timeout_ms: Math.max(8000, Math.min(120000, toInt(raw?.login_timeout_ms, DEFAULT_HGA_TUNING_PARAMS.login_timeout_ms))),
      list_timeout_ms: Math.max(10000, Math.min(150000, toInt(raw?.list_timeout_ms, DEFAULT_HGA_TUNING_PARAMS.list_timeout_ms))),
      market_item_timeout_ms: Math.max(
        8000,
        Math.min(120000, toInt(raw?.market_item_timeout_ms, DEFAULT_HGA_TUNING_PARAMS.market_item_timeout_ms))
      ),
      obt_batch_size: Math.max(2, Math.min(20, toInt(raw?.obt_batch_size, DEFAULT_HGA_TUNING_PARAMS.obt_batch_size))),
      obt_batch_retry: Math.max(0, Math.min(5, toInt(raw?.obt_batch_retry, DEFAULT_HGA_TUNING_PARAMS.obt_batch_retry))),
      obt_concurrency: Math.max(1, Math.min(6, toInt(raw?.obt_concurrency, DEFAULT_HGA_TUNING_PARAMS.obt_concurrency))),
    };
  }

  private static getPersistedHgaTuningParams(): HgaTuningParams {
    const adminId = this.getAdminUserId();
    if (!adminId) return { ...DEFAULT_HGA_TUNING_PARAMS };
    const rows = db
      .prepare(
        "SELECT key, value FROM system_settings WHERE user_id = ? AND key IN ('hga_tune_login_timeout_ms','hga_tune_list_timeout_ms','hga_tune_market_item_timeout_ms','hga_tune_obt_batch_size','hga_tune_obt_batch_retry','hga_tune_obt_concurrency')"
      )
      .all(adminId) as Array<{ key: string; value: string }>;
    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = String(row.value || '');
      return acc;
    }, {});
    return this.normalizeHgaTuningParams({
      login_timeout_ms: Number(map.hga_tune_login_timeout_ms || DEFAULT_HGA_TUNING_PARAMS.login_timeout_ms),
      list_timeout_ms: Number(map.hga_tune_list_timeout_ms || DEFAULT_HGA_TUNING_PARAMS.list_timeout_ms),
      market_item_timeout_ms: Number(map.hga_tune_market_item_timeout_ms || DEFAULT_HGA_TUNING_PARAMS.market_item_timeout_ms),
      obt_batch_size: Number(map.hga_tune_obt_batch_size || DEFAULT_HGA_TUNING_PARAMS.obt_batch_size),
      obt_batch_retry: Number(map.hga_tune_obt_batch_retry || DEFAULT_HGA_TUNING_PARAMS.obt_batch_retry),
      obt_concurrency: Number(map.hga_tune_obt_concurrency || DEFAULT_HGA_TUNING_PARAMS.obt_concurrency),
    });
  }

  static getHgaTuningParams() {
    const persisted = this.getPersistedHgaTuningParams();
    const effective = this.hgaTuningOverride ? this.normalizeHgaTuningParams(this.hgaTuningOverride) : persisted;
    return {
      default: { ...DEFAULT_HGA_TUNING_PARAMS },
      persisted,
      effective,
      override_active: Boolean(this.hgaTuningOverride),
    };
  }

  static getHgaLastOptimizeResult() {
    const adminId = this.getAdminUserId();
    if (!adminId) return null;
    const row = db
      .prepare("SELECT value FROM system_settings WHERE user_id = ? AND key = 'hga_tune_last_optimize_result'")
      .get(adminId) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(String(row.value));
    } catch {
      return null;
    }
  }

  static saveHgaTuningParams(input: Partial<HgaTuningParams>) {
    const adminId = this.getAdminUserId();
    if (!adminId) return this.getHgaTuningParams().persisted;
    const normalized = this.normalizeHgaTuningParams(input);
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_login_timeout_ms', String(normalized.login_timeout_ms));
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_list_timeout_ms', String(normalized.list_timeout_ms));
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_market_item_timeout_ms', String(normalized.market_item_timeout_ms));
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_obt_batch_size', String(normalized.obt_batch_size));
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_obt_batch_retry', String(normalized.obt_batch_retry));
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_obt_concurrency', String(normalized.obt_concurrency));
    })();
    return normalized;
  }

  private static setHgaTuningOverride(input?: Partial<HgaTuningParams> | null) {
    this.hgaTuningOverride = input ? this.normalizeHgaTuningParams(input) : null;
  }

  static resetHgaMappingCache() {
    this.hgaMappingCache = null;
    this.hgaMappingCacheFileMtimeMs = 0;
  }

  static getHgaMappingSettings() {
    const mappings = this.getHgaMappings();
    const suggestions = this.getPendingHgaAliasSuggestions();
    return {
      hga_team_alias_map: mappings.teamAliasMapText,
      hga_team_alias_groups: JSON.stringify(mappings.groups, null, 2),
      hga_team_alias_pending_suggestions: JSON.stringify(suggestions, null, 2),
      hga_team_alias_auto_apply_threshold: this.getHgaAliasAutoApplyThreshold(),
    };
  }

  static getHgaAliasGroups() {
    return this.getHgaMappings().groups;
  }

  static getDefaultHgaTeamAliasMapText() {
    const fileRaw = this.readHgaTeamAliasMapFile();
    return this.parseStoredJsonMap(fileRaw, {}).text;
  }

  static saveHgaTeamAliasMap(raw: string) {
    const parsed = this.parseStoredJsonMap(raw, {});
    fs.mkdirSync(path.dirname(HGA_TEAM_ALIAS_MAP_FILE), { recursive: true });
    fs.writeFileSync(HGA_TEAM_ALIAS_MAP_FILE, parsed.text, 'utf8');
    this.resetHgaMappingCache();
    return parsed.text;
  }

  static saveHgaTeamAliasGroups(groups: HgaAliasGroup[]) {
    const normalized = this.normalizeAliasGroupsInput(groups);
    if (normalized.conflict) {
      return {
        status: 'failed' as const,
        ...normalized.conflict,
      };
    }
    const map = this.convertAliasGroupsToMap(normalized.groups);
    const mapText = this.saveHgaTeamAliasMap(JSON.stringify(map, null, 2));
    return {
      status: 'ok' as const,
      mapText,
      groups: this.getHgaAliasGroups(),
      count: normalized.groups.length,
    };
  }

  static getPendingHgaAliasSuggestions() {
    const adminId = this.getAdminUserId();
    if (!adminId) return [] as HgaAliasSuggestion[];
    const row = db
      .prepare('SELECT value FROM system_settings WHERE user_id = ? AND key = ?')
      .get(adminId, HGA_PENDING_ALIAS_SUGGESTIONS_KEY) as { value?: string } | undefined;
    return this.parseStoredAliasSuggestions(String(row?.value || ''));
  }

  static applyPendingHgaAliasSuggestion(jingcaiName: string, huangguanName: string) {
    const nextJingcaiName = String(jingcaiName || '').trim();
    const nextHuangguanName = String(huangguanName || '').trim();
    if (!nextJingcaiName || !nextHuangguanName) return { status: 'failed' as const, message: 'invalid_alias_input' };
    const currentGroups = this.getHgaAliasGroups();
    const leftNorm = this.normalizeAliasName(nextJingcaiName);
    const rightNorm = this.normalizeAliasName(nextHuangguanName);
    let leftIndex = -1;
    let rightIndex = -1;
    for (let idx = 0; idx < currentGroups.length; idx++) {
      const group = currentGroups[idx];
      const normalizedAliases = group.aliases.map((alias) => this.normalizeAliasName(alias));
      if (normalizedAliases.includes(leftNorm)) leftIndex = idx;
      if (normalizedAliases.includes(rightNorm)) rightIndex = idx;
    }

    const nextGroups = [...currentGroups].map((group) => ({
      ...group,
      aliases: [...group.aliases],
    }));

    if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) {
      const mergedAliases = [...nextGroups[leftIndex].aliases, ...nextGroups[rightIndex].aliases];
      nextGroups[leftIndex].aliases = mergedAliases;
      nextGroups.splice(rightIndex, 1);
    } else if (leftIndex >= 0 && rightIndex < 0) {
      nextGroups[leftIndex].aliases.push(nextHuangguanName);
    } else if (leftIndex < 0 && rightIndex >= 0) {
      nextGroups[rightIndex].aliases.push(nextJingcaiName);
    } else if (leftIndex < 0 && rightIndex < 0) {
      nextGroups.push({
        group_id: `group_${Date.now()}`,
        canonical: this.pickCanonicalFromAliases([nextJingcaiName, nextHuangguanName]),
        aliases: [nextJingcaiName, nextHuangguanName],
      });
    }

    const saved = this.saveHgaTeamAliasGroups(nextGroups);
    if (saved.status !== 'ok') {
      return saved;
    }
    this.dismissPendingHgaAliasSuggestion(nextJingcaiName, nextHuangguanName);
    this.resetHgaMappingCache();
    return { status: 'ok' as const };
  }

  static dismissPendingHgaAliasSuggestion(jingcaiName: string, huangguanName: string) {
    const adminId = this.getAdminUserId();
    if (!adminId) return;
    const nextJingcaiName = String(jingcaiName || '').trim().toLowerCase();
    const nextHuangguanName = String(huangguanName || '').trim().toLowerCase();
    const nextRows = this.getPendingHgaAliasSuggestions().filter(
      (item) =>
        item.jingcai_name.toLowerCase() !== nextJingcaiName || item.huangguan_name.toLowerCase() !== nextHuangguanName
    );
    db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      adminId,
      HGA_PENDING_ALIAS_SUGGESTIONS_KEY,
      JSON.stringify(nextRows, null, 2)
    );
  }

  static getHgaAliasAutoApplyThreshold() {
    const adminId = this.getAdminUserId();
    if (!adminId) return DEFAULT_HGA_ALIAS_AUTO_APPLY_THRESHOLD;
    const row = db
      .prepare('SELECT value FROM system_settings WHERE user_id = ? AND key = ?')
      .get(adminId, 'hga_team_alias_auto_apply_threshold') as { value?: string } | undefined;
    const parsed = Number.parseInt(String(row?.value || DEFAULT_HGA_ALIAS_AUTO_APPLY_THRESHOLD), 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : DEFAULT_HGA_ALIAS_AUTO_APPLY_THRESHOLD;
  }

  static async testHgaLogin(input?: { username?: string; password?: string }) {
    const config = this.getHgaConfig();
    const username = String(input?.username ?? config.username ?? '').trim();
    const password = String(input?.password ?? config.password ?? '').trim();

    if (!username || !password) {
      return {
        status: 'missing' as const,
        message: '测试失败：请先填写可用的 HGA 账号和密码',
      };
    }

    try {
      const uid = await this.getHgaUid(username, password, true);
      if (!uid) {
        return {
          status: 'failed' as const,
          message: '测试失败：HGA 登录未通过，请检查账号或密码',
        };
      }
      return {
        status: 'ok' as const,
        message: '测试成功：HGA 登录正常，可正常摘取数据',
      };
    } catch (err: any) {
      const errText = String(err?.message || err || '');
      if (errText.includes(HGA_ACCOUNT_LOCKED)) {
        return {
          status: 'locked' as const,
          message: `测试失败：${this.hgaLoginBlockedReason || errText || 'HGA 账号已被锁定'}`,
        };
      }
      if (errText.includes('fetch failed') || errText.includes('Client network socket disconnected') || errText.includes('ECONNRESET') || errText.includes('ENOTFOUND')) {
        return {
          status: 'failed' as const,
          message: '测试失败：HGA 站点连接失败，请检查当前网络、代理或目标站点状态',
        };
      }
      if (errText.includes('HGA request failed: 403') || errText.includes('HGA request failed: 401')) {
        return {
          status: 'failed' as const,
          message: '测试失败：HGA 拒绝了当前登录请求，请检查账号状态或站点风控',
        };
      }
      return {
        status: errText.includes('timeout') ? ('timeout' as const) : ('failed' as const),
        message: errText.includes('timeout')
          ? '测试失败：HGA 登录请求超时，请稍后重试'
          : errText === 'unknown' || errText.includes('请检查账号或密码')
          ? '测试失败：HGA 账号或密码错误'
          : `测试失败：${errText || 'HGA 登录测试失败'}`,
      };
    }
  }

  private static pickHgaOptimizationTargets(matches: ExternalMatch[], maxCount = 12) {
    const now = Date.now();
    const in3Days = now + 72 * 60 * 60 * 1000;
    const filtered = matches
      .filter((m) => {
        const ts = Date.parse(String(this.normalizeMatchTime(m.matchTime)).replace(' ', 'T'));
        if (!Number.isFinite(ts)) return true;
        return ts >= now - 2 * 60 * 60 * 1000 && ts <= in3Days;
      })
      .slice(0, maxCount);
    return filtered.length > 0 ? filtered : matches.slice(0, maxCount);
  }

  static async optimizeHgaTuning(options?: { rounds?: number; sample_size?: number }) {
    const rounds = Math.max(4, Math.min(30, Number(options?.rounds || 8)));
    const sampleSize = Math.max(6, Math.min(30, Number(options?.sample_size || 10)));
    const config = this.getHgaConfig();
    if (!config.enabled) {
      throw new Error('HGA is disabled, enable HGA before optimization');
    }
    if (!config.username || !config.password) {
      throw new Error('HGA credentials missing');
    }

    const baseMatches = await this.fetchSportteryAsPrimaryMatches();
    const targets = this.pickHgaOptimizationTargets(baseMatches, sampleSize);
    if (targets.length === 0) {
      throw new Error('No match targets for HGA tuning');
    }

    const persisted = this.getPersistedHgaTuningParams();
    const candidates: HgaTuningParams[] = [
      persisted,
      this.normalizeHgaTuningParams({
        ...persisted,
        list_timeout_ms: persisted.list_timeout_ms + 6000,
        market_item_timeout_ms: persisted.market_item_timeout_ms + 5000,
        obt_concurrency: Math.max(1, persisted.obt_concurrency - 1),
        obt_batch_size: Math.max(4, persisted.obt_batch_size - 2),
      }),
      this.normalizeHgaTuningParams({
        ...persisted,
        list_timeout_ms: Math.max(12000, persisted.list_timeout_ms - 4000),
        market_item_timeout_ms: Math.max(9000, persisted.market_item_timeout_ms - 3000),
        obt_concurrency: Math.min(6, persisted.obt_concurrency + 1),
        obt_batch_size: Math.min(20, persisted.obt_batch_size + 2),
      }),
      this.normalizeHgaTuningParams({
        ...persisted,
        login_timeout_ms: persisted.login_timeout_ms + 4000,
        list_timeout_ms: persisted.list_timeout_ms + 8000,
        market_item_timeout_ms: persisted.market_item_timeout_ms + 7000,
        obt_batch_retry: Math.min(5, persisted.obt_batch_retry + 1),
      }),
      this.normalizeHgaTuningParams({
        ...persisted,
        list_timeout_ms: Math.max(12000, persisted.list_timeout_ms - 8000),
        market_item_timeout_ms: Math.max(9000, persisted.market_item_timeout_ms - 7000),
        obt_batch_retry: Math.max(0, persisted.obt_batch_retry - 1),
        obt_concurrency: Math.min(6, persisted.obt_concurrency + 2),
      }),
      this.normalizeHgaTuningParams({
        ...persisted,
        obt_batch_size: Math.max(3, persisted.obt_batch_size - 3),
        obt_concurrency: 1,
      }),
    ];

    const uniq = new Map<string, HgaTuningParams>();
    for (const item of candidates) {
      const key = JSON.stringify(item);
      if (!uniq.has(key)) uniq.set(key, item);
    }
    const testPlan = Array.from(uniq.values());
    const runPlan: HgaTuningParams[] = [];
    while (runPlan.length < rounds) {
      runPlan.push(testPlan[runPlan.length % testPlan.length]);
    }

    const reports: Array<{
      candidate_key: string;
      params: HgaTuningParams;
      ok: boolean;
      duration_ms: number;
      match_count: number;
      handicap_count: number;
      over_under_count: number;
      error?: string;
      score: number;
    }> = [];

    for (const params of runPlan) {
      const startedAt = Date.now();
      this.clearSourceFailureMeta('hga');
      this.setHgaTuningOverride(params);
      const candidateKey = JSON.stringify(params);
      try {
        const rows = await this.fetchHgaMatches(targets);
        const handicapCount = rows.reduce((sum, row) => sum + this.getValidCrownHandicaps(row.handicaps || []).length, 0);
        const overUnderCount = rows.reduce((sum, row) => sum + this.getValidOverUnderOdds(row.overUnderOdds || []).length, 0);
        const duration = Date.now() - startedAt;
        const score = rows.length * 120 + handicapCount * 12 + overUnderCount * 10 - Math.floor(duration / 1200);
        reports.push({
          candidate_key: candidateKey,
          params,
          ok: rows.length > 0,
          duration_ms: duration,
          match_count: rows.length,
          handicap_count: handicapCount,
          over_under_count: overUnderCount,
          score,
        });
      } catch (err: any) {
        const duration = Date.now() - startedAt;
        reports.push({
          candidate_key: candidateKey,
          params,
          ok: false,
          duration_ms: duration,
          match_count: 0,
          handicap_count: 0,
          over_under_count: 0,
          error: String(err?.message || err || 'unknown'),
          score: -999999,
        });
      } finally {
        this.setHgaTuningOverride(null);
      }
      await this.sleep(300);
    }

    const aggregate = new Map<
      string,
      {
        params: HgaTuningParams;
        attempts: number;
        success: number;
        total_duration_ms: number;
        total_match_count: number;
        total_handicap_count: number;
        total_over_under_count: number;
        max_duration_ms: number;
      }
    >();
    for (const report of reports) {
      const prev = aggregate.get(report.candidate_key) || {
        params: report.params,
        attempts: 0,
        success: 0,
        total_duration_ms: 0,
        total_match_count: 0,
        total_handicap_count: 0,
        total_over_under_count: 0,
        max_duration_ms: 0,
      };
      prev.attempts += 1;
      if (report.ok) prev.success += 1;
      prev.total_duration_ms += Math.max(0, report.duration_ms || 0);
      prev.total_match_count += Math.max(0, report.match_count || 0);
      prev.total_handicap_count += Math.max(0, report.handicap_count || 0);
      prev.total_over_under_count += Math.max(0, report.over_under_count || 0);
      prev.max_duration_ms = Math.max(prev.max_duration_ms, Math.max(0, report.duration_ms || 0));
      aggregate.set(report.candidate_key, prev);
    }

    const aggregateList = Array.from(aggregate.values()).map((item) => {
      const attempts = Math.max(1, item.attempts);
      const successRate = item.success / attempts;
      const avgDuration = item.total_duration_ms / attempts;
      const avgMatch = item.total_match_count / attempts;
      const avgHandicap = item.total_handicap_count / attempts;
      const avgOverUnder = item.total_over_under_count / attempts;
      // Success rate first, then data completeness, then speed.
      const aggregateScore =
        successRate * 10000 + avgMatch * 140 + avgHandicap * 18 + avgOverUnder * 15 - avgDuration / 1000 - item.max_duration_ms / 8000;
      return {
        ...item,
        success_rate: Math.round(successRate * 10000) / 10000,
        avg_duration_ms: Math.round(avgDuration),
        avg_match_count: Math.round(avgMatch * 100) / 100,
        avg_handicap_count: Math.round(avgHandicap * 100) / 100,
        avg_over_under_count: Math.round(avgOverUnder * 100) / 100,
        aggregate_score: Math.round(aggregateScore * 100) / 100,
      };
    });

    const bestAggregate = [...aggregateList].sort((a, b) => {
      if (b.success_rate !== a.success_rate) return b.success_rate - a.success_rate;
      if (b.avg_handicap_count !== a.avg_handicap_count) return b.avg_handicap_count - a.avg_handicap_count;
      if (b.avg_over_under_count !== a.avg_over_under_count) return b.avg_over_under_count - a.avg_over_under_count;
      if (a.avg_duration_ms !== b.avg_duration_ms) return a.avg_duration_ms - b.avg_duration_ms;
      return b.aggregate_score - a.aggregate_score;
    })[0];

    const best = reports
      .filter((item) => item.candidate_key === JSON.stringify(bestAggregate.params))
      .sort((a, b) => b.score - a.score)[0];
    const shouldPersist = bestAggregate.success_rate > 0;
    const saved = shouldPersist ? this.saveHgaTuningParams(bestAggregate.params) : persisted;
    const adminId = this.getAdminUserId();
    if (adminId) {
      const summary = {
        ran_at: new Date().toISOString(),
        rounds: reports.length,
        sample_size: targets.length,
        best_score: bestAggregate.aggregate_score,
        best_success_rate: bestAggregate.success_rate,
        best_aggregate: bestAggregate,
        best_report: best,
        saved_applied: shouldPersist,
        aggregate_list: aggregateList,
        reports,
      };
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(adminId, 'hga_tune_last_optimize_result', JSON.stringify(summary));
    }

    return {
      rounds: reports.length,
      sample_size: targets.length,
      best,
      best_aggregate: bestAggregate,
      saved,
      saved_applied: shouldPersist,
      aggregate_list: aggregateList,
      reports,
    };
  }

  private static getAdminUserId() {
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id?: number } | undefined;
    return admin?.id || 0;
  }

  private static getPersistedHgaRuntimeState() {
    const adminId = this.getAdminUserId();
    if (!adminId) {
      return { status: 'unknown', message: '' };
    }
    const rows = db
      .prepare(
        "SELECT key, value FROM system_settings WHERE user_id = ? AND key IN ('hga_runtime_status', 'hga_runtime_message')"
      )
      .all(adminId) as Array<{ key: string; value: string }>;
    const map = rows.reduce<Record<string, string>>((acc, curr) => {
      acc[curr.key] = String(curr.value || '');
      return acc;
    }, {});
    return {
      status: map.hga_runtime_status || 'unknown',
      message: map.hga_runtime_message || '',
    };
  }

  private static persistHgaRuntimeState(status: string, message: string) {
    const adminId = this.getAdminUserId();
    if (!adminId) return;
    db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      adminId,
      'hga_runtime_status',
      String(status || 'unknown')
    );
    db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      adminId,
      'hga_runtime_message',
      String(message || '')
    );
  }

  private static setHgaRuntimeState(
    status: 'unknown' | 'disabled' | 'ok' | 'empty' | 'failed' | 'timeout' | 'locked',
    message: string
  ) {
    this.hgaLastStatus = status;
    this.hgaLastMessage = message;
    this.persistHgaRuntimeState(status, message);
  }

  private static disableHgaByCredentialFailure(message: string) {
    const adminId = this.getAdminUserId();
    const nextMessage = message || '检测到 HGA 账号或密码错误，已自动关闭 HGA 抓取，请更新配置后手动重新开启';
    if (adminId) {
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(
        adminId,
        'hga_enabled',
        'false'
      );
    }
    this.hgaLoginBlockedUntil = 0;
    this.hgaLoginBlockedReason = '';
    this.hgaRiskBlocked = false;
    this.clearHgaSessionCache();
    this.setHgaRuntimeState('failed', nextMessage);
  }

  private static disableHgaByLock(message: string) {
    const adminId = this.getAdminUserId();
    const nextMessage = message || '检测到 HGA 账号被锁，系统已自动关闭 HGA 抓取，请稍后解锁后手动重新开启。';
    if (adminId) {
      db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(
        adminId,
        'hga_enabled',
        'false'
      );
    }
    this.hgaLoginBlockedUntil = 0;
    this.hgaLoginBlockedReason = '';
    this.hgaRiskBlocked = false;
    this.clearHgaSessionCache();
    this.setHgaRuntimeState('locked', nextMessage);
  }

  private static isHgaCredentialError(message: string) {
    const text = String(message || '').trim();
    return HGA_CREDENTIAL_ERROR_HINTS.some((hint) => text.includes(hint));
  }

  private static normalizeAliasName(raw: string) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  private static pickCanonicalFromAliases(aliases: string[]) {
    const cleaned = aliases
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (cleaned.length === 0) return '';
    return [...cleaned].sort((a, b) => a.length - b.length || a.localeCompare(b, 'zh-CN'))[0];
  }

  private static normalizeAliasGroupsInput(rawGroups: unknown): { groups: HgaAliasGroup[]; conflict?: HgaAliasConflict } {
    const groups = Array.isArray(rawGroups) ? rawGroups : [];
    const dedupByGroup = new Map<string, HgaAliasGroup>();
    const occupied = new Map<string, string>();
    let counter = 1;

    for (const item of groups) {
      const aliasesRaw = Array.isArray((item as any)?.aliases) ? (item as any).aliases : [];
      const aliases: string[] = [];
      const seen = new Set<string>();
      for (const raw of aliasesRaw) {
        const value = String(raw || '').trim();
        const normalized = this.normalizeAliasName(value);
        if (!value || !normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        aliases.push(value);
      }

      const canonicalInput = String((item as any)?.canonical || '').trim();
      if (canonicalInput) {
        const normalized = this.normalizeAliasName(canonicalInput);
        if (normalized && !seen.has(normalized)) {
          aliases.unshift(canonicalInput);
          seen.add(normalized);
        }
      }

      if (aliases.length === 0) continue;

      const canonical = this.pickCanonicalFromAliases(aliases);
      const canonicalNorm = this.normalizeAliasName(canonical);
      const orderedAliases = [
        canonical,
        ...aliases.filter((alias) => this.normalizeAliasName(alias) !== canonicalNorm),
      ];
      if (orderedAliases.length === 1) {
        return {
          groups: [],
          conflict: {
            duplicate_name: orderedAliases[0],
            conflict_group_id: String((item as any)?.group_id || '').trim() || `group_${counter}`,
            message: '每行至少需要两个别名，单值行无效',
          },
        };
      }

      const groupId = String((item as any)?.group_id || '').trim() || `group_${counter++}`;
      for (const alias of orderedAliases) {
        const normalized = this.normalizeAliasName(alias);
        const existingGroup = occupied.get(normalized);
        if (existingGroup && existingGroup !== groupId) {
          return {
            groups: [],
            conflict: {
              duplicate_name: alias,
              conflict_group_id: existingGroup,
              message: `球队别名“${alias}”重复，不能跨组出现`,
            },
          };
        }
        occupied.set(normalized, groupId);
      }

      dedupByGroup.set(groupId, {
        group_id: groupId,
        canonical,
        aliases: orderedAliases,
      });
    }

    const normalizedGroups = Array.from(dedupByGroup.values()).sort((a, b) =>
      a.canonical.localeCompare(b.canonical, 'zh-CN')
    );
    return { groups: normalizedGroups };
  }

  private static buildAliasGroupsFromMap(map: Record<string, string>): HgaAliasGroup[] {
    const neighbors = new Map<string, Set<string>>();
    const labels = new Map<string, string>();
    const touch = (raw: string) => {
      const label = String(raw || '').trim();
      const normalized = this.normalizeAliasName(label);
      if (!normalized) return '';
      if (!neighbors.has(normalized)) neighbors.set(normalized, new Set());
      if (!labels.has(normalized)) labels.set(normalized, label);
      return normalized;
    };

    for (const [leftRaw, rightRaw] of Object.entries(map || {})) {
      const left = touch(leftRaw);
      const right = touch(rightRaw);
      if (!left || !right) continue;
      neighbors.get(left)!.add(right);
      neighbors.get(right)!.add(left);
    }

    const visited = new Set<string>();
    const groups: HgaAliasGroup[] = [];
    let index = 1;
    for (const node of neighbors.keys()) {
      if (visited.has(node)) continue;
      const queue = [node];
      const component: string[] = [];
      visited.add(node);
      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);
        for (const next of neighbors.get(current) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }
      const aliasLabels = component
        .map((key) => String(labels.get(key) || '').trim())
        .filter(Boolean);
      if (aliasLabels.length === 0) continue;
      const canonical = this.pickCanonicalFromAliases(aliasLabels);
      const canonicalNorm = this.normalizeAliasName(canonical);
      const aliases = [
        canonical,
        ...aliasLabels
          .filter((label) => this.normalizeAliasName(label) !== canonicalNorm)
          .sort((a, b) => a.localeCompare(b, 'zh-CN')),
      ];
      groups.push({
        group_id: `group_${index++}`,
        canonical,
        aliases,
      });
    }

    return groups.sort((a, b) => a.canonical.localeCompare(b.canonical, 'zh-CN'));
  }

  private static convertAliasGroupsToMap(groups: HgaAliasGroup[]) {
    const map: Record<string, string> = {};
    for (const group of groups) {
      const aliases = Array.isArray(group.aliases) ? group.aliases : [];
      const cleaned = aliases
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      if (cleaned.length <= 1) continue;
      const canonical = this.pickCanonicalFromAliases([group.canonical, ...cleaned]);
      const canonicalNorm = this.normalizeAliasName(canonical);
      for (const alias of cleaned) {
        const aliasNorm = this.normalizeAliasName(alias);
        if (!aliasNorm || aliasNorm === canonicalNorm) continue;
        map[alias] = canonical;
      }
    }
    return map;
  }

  private static parseStoredJsonMap(raw: string, fallback: Record<string, string>) {
    const fallbackText = JSON.stringify(fallback, null, 2);
    try {
      const parsed = JSON.parse(String(raw || '').trim());
      if (!parsed || typeof parsed !== 'object') {
        const fallbackGroups = this.buildAliasGroupsFromMap(fallback);
        return { map: { ...fallback }, text: fallbackText, groups: fallbackGroups };
      }
      if (Array.isArray((parsed as any).groups)) {
        const normalizedGroups = this.normalizeAliasGroupsInput((parsed as any).groups);
        if (normalizedGroups.conflict) {
          const fallbackGroups = this.buildAliasGroupsFromMap(fallback);
          return { map: { ...fallback }, text: fallbackText, groups: fallbackGroups };
        }
        const groupMap = this.convertAliasGroupsToMap(normalizedGroups.groups);
        const effectiveMap = Object.keys(groupMap).length > 0 ? groupMap : { ...fallback };
        return {
          map: effectiveMap,
          text: JSON.stringify(effectiveMap, null, 2),
          groups: this.buildAliasGroupsFromMap(effectiveMap),
        };
      }
      if (Array.isArray(parsed)) {
        const fallbackGroups = this.buildAliasGroupsFromMap(fallback);
        return { map: { ...fallback }, text: fallbackText, groups: fallbackGroups };
      }

      const normalized = Object.entries(parsed).reduce<Record<string, string>>((acc, [key, value]) => {
        const nextKey = String(key || '').trim();
        const nextValue = String(value || '').trim();
        if (!nextKey || !nextValue) return acc;
        acc[nextKey] = nextValue;
        return acc;
      }, {});
      const effectiveMap = Object.keys(normalized).length > 0 ? normalized : { ...fallback };
      return {
        map: effectiveMap,
        text: JSON.stringify(effectiveMap, null, 2),
        groups: this.buildAliasGroupsFromMap(effectiveMap),
      };
    } catch {
      const fallbackGroups = this.buildAliasGroupsFromMap(fallback);
      return { map: { ...fallback }, text: fallbackText, groups: fallbackGroups };
    }
  }

  private static readSuggestionLeftName(raw: any) {
    return String(raw?.jingcai_name || raw?.trade500_name || '').trim();
  }

  private static readSuggestionRightName(raw: any) {
    return String(raw?.huangguan_name || raw?.hga_name || '').trim();
  }

  private static toCompatAliasSuggestion(item: Omit<HgaAliasSuggestion, 'trade500_name' | 'hga_name'>): HgaAliasSuggestion {
    return {
      ...item,
      trade500_name: item.jingcai_name,
      hga_name: item.huangguan_name,
    };
  }

  private static parseStoredAliasSuggestions(raw: string) {
    try {
      const parsed = JSON.parse(String(raw || '').trim());
      if (!Array.isArray(parsed)) return [] as HgaAliasSuggestion[];
      const merged = new Map<string, HgaAliasSuggestion>();
      for (const item of parsed) {
        const leftName = this.readSuggestionLeftName(item);
        const rightName = this.readSuggestionRightName(item);
        const normalized = {
          jingcai_name: leftName,
          huangguan_name: rightName,
          source: 'odds_fallback' as const,
          match_id: String(item?.match_id || '').trim(),
          match_time: String(item?.match_time || '').trim(),
          created_at: String(item?.created_at || '').trim(),
          match_count: Math.max(1, Number.parseInt(String(item?.match_count || '1'), 10) || 1),
        };
        if (!normalized.jingcai_name || !normalized.huangguan_name) continue;
        const key = `${normalized.jingcai_name.toLowerCase()}|${normalized.huangguan_name.toLowerCase()}`;
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, this.toCompatAliasSuggestion(normalized));
          continue;
        }
        merged.set(key, {
          ...this.toCompatAliasSuggestion(normalized),
          match_id: normalized.match_id || existing.match_id,
          match_time: normalized.match_time || existing.match_time,
          created_at: normalized.created_at || existing.created_at,
          match_count: existing.match_count + normalized.match_count,
        });
      }
      return Array.from(merged.values())
        .sort((a, b) => b.match_count - a.match_count || a.jingcai_name.localeCompare(b.jingcai_name))
        .map((item) => ({
          ...item,
          match_count: Math.max(1, item.match_count),
        }));
    } catch {
      return [] as HgaAliasSuggestion[];
    }
  }

  private static buildBidirectionalAliasLookup(map: Record<string, string>) {
    const groups = this.buildAliasGroupsFromMap(map);
    const lookup: Record<string, string> = {};
    for (const group of groups) {
      const canonical = this.pickCanonicalFromAliases([group.canonical, ...group.aliases]);
      for (const alias of group.aliases) {
        const normalized = this.normalizeAliasName(alias);
        if (!normalized) continue;
        lookup[normalized] = canonical;
      }
    }
    return lookup;
  }

  private static appendPendingHgaAliasSuggestions(suggestions: HgaAliasSuggestion[]) {
    if (!Array.isArray(suggestions) || suggestions.length === 0) return;
    const adminId = this.getAdminUserId();
    if (!adminId) return;
    const existing = this.getPendingHgaAliasSuggestions();
    let merged = this.parseStoredAliasSuggestions(JSON.stringify([...existing, ...suggestions]));
    const threshold = this.getHgaAliasAutoApplyThreshold();
    const autoApply = merged.filter((item) => item.match_count >= threshold);
    const appliedKeys = new Set<string>();
    for (const item of autoApply) {
      const result = this.applyPendingHgaAliasSuggestion(item.jingcai_name, item.huangguan_name);
      if (result?.status === 'ok') {
        appliedKeys.add(`${item.jingcai_name.toLowerCase()}|${item.huangguan_name.toLowerCase()}`);
      }
    }
    if (appliedKeys.size > 0) {
      merged = merged.filter((item) => !appliedKeys.has(`${item.jingcai_name.toLowerCase()}|${item.huangguan_name.toLowerCase()}`));
    }
    db.prepare('INSERT OR REPLACE INTO system_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      adminId,
      HGA_PENDING_ALIAS_SUGGESTIONS_KEY,
      JSON.stringify(merged, null, 2)
    );
  }

  private static getHgaMappings() {
    const fileMtimeMs = this.getHgaTeamAliasFileMtimeMs();
    if (this.hgaMappingCache && this.hgaMappingCacheFileMtimeMs === fileMtimeMs) return this.hgaMappingCache;
    const fileRaw = this.readHgaTeamAliasMapFile();
    const teamAlias = this.parseStoredJsonMap(fileRaw, {});
    this.hgaMappingCache = {
      teamAliasMap: this.buildBidirectionalAliasLookup(teamAlias.map),
      teamAliasMapText: teamAlias.text,
      groups: teamAlias.groups,
    };
    this.hgaMappingCacheFileMtimeMs = fileMtimeMs;
    return this.hgaMappingCache;
  }

  private static getHgaTeamAliasFileMtimeMs() {
    try {
      if (!fs.existsSync(HGA_TEAM_ALIAS_MAP_FILE)) return 0;
      const stat = fs.statSync(HGA_TEAM_ALIAS_MAP_FILE);
      return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  private static readHgaTeamAliasMapFile() {
    try {
      if (!fs.existsSync(HGA_TEAM_ALIAS_MAP_FILE)) return '';
      return fs.readFileSync(HGA_TEAM_ALIAS_MAP_FILE, 'utf8');
    } catch {
      return '';
    }
  }

  static async syncFromExternalScraper() {
    const startedAt = Date.now();
    const rawMatches = await this.fetchExternalMatches();
    if (rawMatches.length === 0) {
      const consecutiveEmptyCount = this.getConsecutiveEmptyHealthCount() + 1;
      const clearedCount = this.clearStaleNonManualSnapshotIfNeeded(consecutiveEmptyCount);
      console.warn('External scraper returned 0 matches, skip overwrite and keep existing database rows');
      this.logScrapeHealth({
        status: 'empty',
        fetched_total: 0,
        filtered_total: 0,
        synced_total: 0,
        complete_total: 0,
        note:
          clearedCount > 0
            ? `raw empty, stale snapshot cleared after ${consecutiveEmptyCount} empties, removed=${clearedCount}`
            : 'raw empty, keep existing rows',
        duration_ms: Date.now() - startedAt,
      });
      return 0;
    }
    const matches = rawMatches;
    const incomingRows = matches.map((match) => this.toNormalizedSyncRow(match));
    const currentRows = this.getCurrentNonManualSyncRows();
    const currentMap = new Map(currentRows.map((row) => [row.match_id, row] as const));
    let handicapDowngradeSkipCount = 0;
    let overUnderDowngradeSkipCount = 0;
    const stabilizedRows = incomingRows.map((row) => {
      const stabilized = this.stabilizeRowWithCurrent(row, currentMap.get(row.match_id));
      if (stabilized.keptCurrentHandicaps) handicapDowngradeSkipCount += 1;
      if (stabilized.keptCurrentOverUnder) overUnderDowngradeSkipCount += 1;
      return stabilized.row;
    });
    // 已移除暴力对齐规则 (reconcileCrownHandicapDirection)，尊重各数据源原始正负号，由解析层自行保证准确性。
    const directionReconciledRows = stabilizedRows;
    if (handicapDowngradeSkipCount > 0 || overUnderDowngradeSkipCount > 0) {
      console.warn(
        `[crown] skip downgrade overwrite: c_h=${handicapDowngradeSkipCount}, c_ou=${overUnderDowngradeSkipCount}`
      );
    }
    const clearedCrownOuCount = stabilizedRows.reduce((count, row) => {
      const current = currentMap.get(row.match_id);
      if (!current) return count;
      const hadOu = Array.isArray(current.c_ou) && current.c_ou.length > 0;
      const hasOuNow = Array.isArray(row.c_ou) && row.c_ou.length > 0;
      return hadOu && !hasOuNow ? count + 1 : count;
    }, 0);
    const shouldLogCrownOuClear = ['failed', 'timeout', 'locked', 'empty'].includes(String(this.lastFetchMeta.hga_status || ''));
    if (clearedCrownOuCount > 0 && shouldLogCrownOuClear) {
      console.warn(
        `[crown-ou] cleared stale over/under odds for ${clearedCrownOuCount} matches (hga_status=${this.lastFetchMeta.hga_status})`
      );
    }
    const comparableCurrentRows = this.getComparableCurrentRowsByDate(currentRows, directionReconciledRows);
    const crownDirectionHealthNote = this.buildCrownDirectionHealthNote(directionReconciledRows);

    if (
      comparableCurrentRows.length > 0 &&
      directionReconciledRows.length < Math.max(1, Math.floor(comparableCurrentRows.length * SYNC_MIN_ROW_RATIO))
    ) {
      console.warn(
        `External scraper row count dropped too much (${directionReconciledRows.length}/${comparableCurrentRows.length}, min_ratio=${SYNC_MIN_ROW_RATIO}), skip overwrite to avoid partial-data regression`
      );
      this.logScrapeHealth({
        status: 'skipped',
        fetched_total: rawMatches.length,
        filtered_total: matches.length,
        synced_total: comparableCurrentRows.length,
        complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
        note: `row drop protection triggered min_ratio=${SYNC_MIN_ROW_RATIO}; ${this.buildSourceHitSummaryNote()}; ${crownDirectionHealthNote}`,
        duration_ms: Date.now() - startedAt,
      });
      return comparableCurrentRows.length;
    }

    const snapshotQuality = this.validateIncomingSnapshotQuality(comparableCurrentRows, directionReconciledRows);
    if (!snapshotQuality.ok) {
      console.warn(`Incoming snapshot rejected by quality guard: ${snapshotQuality.reason}`);
      this.logScrapeHealth({
        status: 'skipped',
        fetched_total: rawMatches.length,
        filtered_total: matches.length,
        synced_total: comparableCurrentRows.length,
        complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
        note: `snapshot quality guard: ${snapshotQuality.reason}; ${crownDirectionHealthNote}`,
        duration_ms: Date.now() - startedAt,
      });
      return comparableCurrentRows.length;
    }

    const diff = this.buildSyncRowDiff(currentRows, directionReconciledRows);
    if (diff.toUpsert.length === 0 && diff.toDelete.length === 0) {
      const cleanedHandicapRows = this.cleanupStoredCrownHandicaps();
      if (cleanedHandicapRows > 0) {
        const users = db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
        for (const user of users) {
          await this.yieldToEventLoop();
          await this.scanOpportunities(user.id);
        }
        console.log(
          `External scraper data unchanged, cleaned ${cleanedHandicapRows} persisted crown handicap rows and rescanned opportunities`
        );
      } else {
        console.log(`External scraper data unchanged, skip database update (${directionReconciledRows.length} matches)`);
      }
      this.logScrapeHealth({
        status: 'unchanged',
        fetched_total: rawMatches.length,
        filtered_total: matches.length,
        synced_total: directionReconciledRows.length,
        complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
        note:
          (cleanedHandicapRows > 0 ? `sporttery+500 same rows + handicap cleanup:${cleanedHandicapRows}` : 'sporttery+500 same rows') +
          (clearedCrownOuCount > 0 ? `; cleared_ou=${clearedCrownOuCount}` : '') +
          `; ${this.buildSourceHitSummaryNote()}; ${crownDirectionHealthNote}`,
        duration_ms: Date.now() - startedAt,
      });
      return directionReconciledRows.length;
    }

    const nowText = formatLocalDbDateTime();
    const batchCreatedAt = nowText;
    const incomingMatchIds = directionReconciledRows.map((row) => row.match_id);
    db.transaction(() => {
      // Keep old match rows so existing opportunities keep their FK parents if a later scan fails.
      // The current snapshot is selected by created_at/status, while missing rows are marked stale.

      const upsertMatch = db.prepare(`
        INSERT INTO matches (
          match_id, league, round, handicap, jingcai_handicap, home_team, away_team, match_time, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          league = excluded.league,
          round = excluded.round,
          handicap = excluded.handicap,
          jingcai_handicap = excluded.jingcai_handicap,
          home_team = excluded.home_team,
          away_team = excluded.away_team,
          match_time = excluded.match_time,
          status = 'upcoming',
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);

      const upsertJingcai = db.prepare(`
        INSERT INTO jingcai_odds (
          match_id, win_odds, draw_odds, lose_odds, handicap_win_odds, handicap_draw_odds, handicap_lose_odds
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          win_odds = excluded.win_odds,
          draw_odds = excluded.draw_odds,
          lose_odds = excluded.lose_odds,
          handicap_win_odds = excluded.handicap_win_odds,
          handicap_draw_odds = excluded.handicap_draw_odds,
          handicap_lose_odds = excluded.handicap_lose_odds,
          updated_at = CURRENT_TIMESTAMP
      `);

      const upsertCrown = db.prepare(`
        INSERT INTO crown_odds (
          match_id, win_odds, draw_odds, lose_odds, handicaps, goal_odds, over_under_odds
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          win_odds = excluded.win_odds,
          draw_odds = excluded.draw_odds,
          lose_odds = excluded.lose_odds,
          handicaps = excluded.handicaps,
          goal_odds = excluded.goal_odds,
          over_under_odds = excluded.over_under_odds,
          updated_at = CURRENT_TIMESTAMP
      `);

      for (const row of directionReconciledRows) {
        upsertMatch.run(
          row.match_id,
          row.league,
          row.round,
          row.handicap,
          row.jingcai_handicap,
          row.home_team,
          row.away_team,
          row.match_time,
          batchCreatedAt,
          nowText
        );
        upsertJingcai.run(
          row.match_id,
          row.j_w,
          row.j_d,
          row.j_l,
          row.j_hw,
          row.j_hd,
          row.j_hl
        );
        upsertCrown.run(
          row.match_id,
          row.c_w,
          row.c_d,
          row.c_l,
          JSON.stringify(row.c_h),
          JSON.stringify(row.c_goal),
          JSON.stringify(row.c_ou)
        );
      }
      if (incomingMatchIds.length > 0) {
        const placeholders = incomingMatchIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE matches
           SET status = 'stale', updated_at = ?
           WHERE match_id NOT LIKE 'manual_%'
             AND (
               match_id NOT IN (${placeholders})
               OR match_time < datetime(?, '-30 minutes')
             )`
        ).run(nowText, ...incomingMatchIds, nowText);
      }
      this.persistSyncChangeEvents(diff.events, nowText);
    })();

    const users = db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
    for (const user of users) {
      await this.yieldToEventLoop();
      await this.scanOpportunities(user.id);
    }

    console.log(`External scraper sync completed with ${directionReconciledRows.length} matches`);
    this.logScrapeHealth({
      status: 'ok',
      fetched_total: rawMatches.length,
      filtered_total: matches.length,
      synced_total: directionReconciledRows.length,
      complete_total: matches.filter((m) => this.isMatchComplete(m as any)).length,
      note: `sporttery+500 snapshot_apply=${directionReconciledRows.length},events=${diff.events.length}${
        clearedCrownOuCount > 0 ? `,cleared_ou=${clearedCrownOuCount}` : ''
      },${this.buildSourceHitSummaryNote()},${crownDirectionHealthNote}`,
      duration_ms: Date.now() - startedAt,
    });
    return directionReconciledRows.length;
  }

  static async buildUnifiedSnapshot(options: boolean | { includeRaw?: boolean; suppressAutoUpsert?: boolean } = true): Promise<{
    generated_at: string;
    total: number;
    records: UnifiedSnapshotRecord[];
  }> {
    const includeRaw = typeof options === 'boolean' ? options : options.includeRaw === true;
    const suppressAutoUpsert = typeof options === 'object' && options?.suppressAutoUpsert === true;
    const fetchedAt = formatLocalDbDateTime();
    let sportteryBase = await this.fetchSportteryAsPrimaryMatches();
    try {
      const tradeRows = await this.fetchTrade500MatchesFromXml();
      if (tradeRows.length > 0) {
        sportteryBase = this.mergeTrade500JingcaiData(sportteryBase, tradeRows);
      }
    } catch (err: any) {
      console.warn(`Trade500 jingcai merge skipped in snapshot build: ${err?.message || err}`);
    }
    const trade500Base = await this.fetchTrade500AsPrimaryMatches().catch(() => []);

    const stageLive = await this.enrichWithLive500CrownOdds(sportteryBase.map((m) => ({ ...m })));
    const stageOdds500 = await this.enrichWithOdds500CrownMarkets(stageLive.map((m) => ({ ...m })), { suppressAutoUpsert });
    const stageTrade500Odds = await this.enrichWithTrade500CrownOddsFallback(stageOdds500.map((m) => ({ ...m })));
    const finalMerged = await this.enrichWithTrade500CrownHandicapFallback(stageTrade500Odds.map((m) => ({ ...m })));

    const tradeIndex = this.buildExternalMatchIndex(trade500Base);
    const stageLiveIndex = this.buildExternalMatchIndex(stageLive);
    const stageOdds500Index = this.buildExternalMatchIndex(stageOdds500);
    const stageTrade500OddsIndex = this.buildExternalMatchIndex(stageTrade500Odds);

    const records: UnifiedSnapshotRecord[] = finalMerged.map((merged) => {
      const sporttery = merged;
      const trade = this.pickExternalMatchFromIndex(tradeIndex, merged);
      const live = this.pickExternalMatchFromIndex(stageLiveIndex, merged) || merged;
      const odds500 = this.pickExternalMatchFromIndex(stageOdds500Index, merged) || live;
      const trade500Odds = this.pickExternalMatchFromIndex(stageTrade500OddsIndex, merged) || odds500;

      const jcSpf = this.toUnifiedOdds(merged.jingcaiOdds);
      const jcRqspf = this.toUnifiedOdds(merged.jingcaiHandicapOdds);
      const jcGoals = this.toUnifiedGoalOdds(merged.crownGoalOdds || []);
      const hgSpf = this.toUnifiedOdds(merged.crownOdds);
      const hgHandicap = this.toUnifiedHandicapOdds(merged.crownHandicaps || []);
      const hgOu = this.toUnifiedOuOdds(merged.crownOverUnderOdds || []);

      const sourceTrace: UnifiedSnapshotRecord['source_trace'] = {
        issue_no: { source: 'sporttery', fetched_at: fetchedAt },
        league_name: { source: 'sporttery', fetched_at: fetchedAt },
        match_time: { source: 'sporttery', fetched_at: fetchedAt },
        home_team: { source: 'sporttery', fetched_at: fetchedAt },
        away_team: { source: 'sporttery', fetched_at: fetchedAt },
        handicap: { source: 'sporttery', fetched_at: fetchedAt, note: '竞彩让球线' },
        jc_spf: this.pickJcSourceTrace(sporttery, trade, fetchedAt),
        jc_rqspf: this.pickJcHSourceTrace(sporttery, trade, fetchedAt),
        jc_goals: this.pickGoalSourceTrace(sporttery, trade, fetchedAt),
        hg_spf: this.pickHgSpfTrace(live, odds500, trade500Odds, merged, fetchedAt),
        hg_handicap: this.pickHgHandicapTrace(odds500, trade500Odds, merged, fetchedAt),
        hg_ou: this.pickHgOuTrace(odds500, merged, fetchedAt),
      };

      const baseDate = merged.matchTime.slice(0, 10);
      const matchKey = `${baseDate}|${this.normalizeNameForMatch(merged.homeTeam)}|${this.normalizeNameForMatch(merged.awayTeam)}`;
      const sourceMatchId: Record<string, string> = {};
      if (sporttery?.id) sourceMatchId.sporttery = sporttery.id;
      if (trade?.id) sourceMatchId.trade500 = trade.id;
      if (merged?.id) sourceMatchId.final = merged.id;

      const out: UnifiedSnapshotRecord = {
        match_key: matchKey,
        source_match_id: sourceMatchId,
        issue_no: merged.round || '',
        league_name: merged.league || '',
        match_time: merged.matchTime || '',
        home_team: this.canonicalizeDisplayTeamName(merged.homeTeam || ''),
        away_team: this.canonicalizeDisplayTeamName(merged.awayTeam || ''),
        handicap: merged.jingcaiHandicap || merged.handicap || '',
        jc_spf: jcSpf,
        jc_rqspf: jcRqspf,
        jc_goals: jcGoals,
        hg_spf: hgSpf,
        hg_handicap: hgHandicap,
        hg_ou: hgOu,
        updated_at: fetchedAt,
        source_trace: sourceTrace,
      };
      if (includeRaw) {
        out.raw = { sporttery, trade500: trade || undefined, merged };
      }
      return out;
    });

    return {
      generated_at: fetchedAt,
      total: records.length,
      records,
    };
  }

  private static buildSourceHitSummaryNote() {
    const meta = this.lastFetchMeta;
    return `primary_source=${meta.primary_source},odds500_yazhi=${meta.odds500_yazhi_hit_count},odds500_daxiao=${meta.odds500_daxiao_hit_count},trade500_jqs=${meta.trade500_jqs_hit_count},rich365_ou=${meta.rich365_ou_fallback_hit_count},hga_override=${meta.hga_override_hit_count}`;
  }

  private static buildSourceDimensionWarningNote(completeTotal: number) {
    const meta = this.lastFetchMeta;
    const warnings: string[] = [];
    if (completeTotal === 0) warnings.push('complete_total=0');
    if (meta.hga_override_hit_count === 0) warnings.push('hga_override=0');
    if (meta.rich365_ou_fallback_hit_count === 0) warnings.push('rich365_ou=0');
    if (meta.primary_source === 'trade500') warnings.push('sporttery_primary_fallback=trade500');
    return warnings.length > 0 ? `source_dimension_warning=${warnings.join('|')}` : '';
  }

  private static reconcileCrownHandicapDirection(rows: NormalizedSyncRow[]) {
    const parseSign = (v?: string) => {
      const text = String(v || '').trim();
      if (text.startsWith('+')) return '+';
      if (text.startsWith('-')) return '-';
      return '';
    };
    const flipType = (v?: string) => {
      const text = String(v || '').trim();
      if (text.startsWith('+')) return `-${text.slice(1)}`;
      if (text.startsWith('-')) return `+${text.slice(1)}`;
      return text;
    };
    return (rows || []).map((row) => {
      const expected = parseSign(this.normalizeHandicapV2(row.jingcai_handicap) || row.jingcai_handicap);
      if (!expected || !Array.isArray(row.c_h) || row.c_h.length === 0) return row;

      // 增加安全性检查：只有当皇冠胜平负赔率 (c_w/c_l) 缺失，或者 SPF 赔率明确支持翻转时，
      // 才允许根据竞彩方向进行暴力对齐。
      const homeWin = Number(row.c_w || 0);
      const awayWin = Number(row.c_l || 0);
      if (homeWin > 0 && awayWin > 0) {
        const inferredSign = homeWin <= awayWin ? '-' : '+';
        // 如果皇冠自身的 SPF 赔率已经推断出主队是受让方 (+)，
        // 那么即便竞彩是让球方 (-)，我们也绝不应该翻转。
        if (inferredSign !== expected) {
          return row;
        }
      }

      const nonZero = row.c_h.filter((x) => !this.isZeroHandicapType(x?.type));
      if (nonZero.length === 0) return row;
      const allOpposite = nonZero.every((x) => parseSign(String(x?.type || '')) === (expected === '+' ? '-' : '+'));
      if (!allOpposite) return row;
      const corrected = row.c_h.map((x) => ({
        type: flipType(String(x?.type || '')),
        // Keep odds bound to team side; only normalize handicap sign representation.
        home_odds: Number(x?.home_odds || 0),
        away_odds: Number(x?.away_odds || 0),
      }));
      return { ...row, c_h: corrected };
    });
  }

  private static buildCrownDirectionHealthNote(rows: NormalizedSyncRow[]) {
    const parseSign = (v?: string) => {
      const text = String(v || '').trim();
      if (text.startsWith('+')) return '+';
      if (text.startsWith('-')) return '-';
      return '';
    };
    let comparable = 0;
    let aligned = 0;
    let conflict = 0;
    const conflictIds: string[] = [];
    for (const row of rows || []) {
      const jcSign = parseSign(this.normalizeHandicapV2(row.jingcai_handicap) || row.jingcai_handicap);
      const main = Array.isArray(row.c_h) && row.c_h.length > 0 ? row.c_h[0] : null;
      const crownType = main ? String(main.type || '') : '';
      const crownSign = parseSign(crownType);
      if (!jcSign || !crownSign) continue;
      comparable += 1;
      if (jcSign === crownSign) aligned += 1;
      else {
        conflict += 1;
        if (conflictIds.length < 8) conflictIds.push(String(row.match_id || ''));
      }
    }
    const rate = comparable > 0 ? ((aligned / comparable) * 100).toFixed(2) : '0.00';
    return `crown_dir_align=${aligned}/${comparable}(${rate}%),crown_dir_conflict=${conflict}${
      conflictIds.length > 0 ? `,crown_dir_conflict_ids=${conflictIds.join('|')}` : ''
    }`;
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
    const warningNote = this.buildSourceDimensionWarningNote(payload.complete_total);
    const note = [payload.note || '', warningNote].filter(Boolean).join('; ');
    if (warningNote) {
      console.warn(`[source-dimension] ${warningNote}; ${this.buildSourceHitSummaryNote()}`);
    }
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
       (source, status, fetched_total, filtered_total, synced_total, complete_total, hga_status, hga_count, base_count, merged_count, playwright_fallback_used, note, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      note,
      payload.duration_ms,
      formatLocalDbDateTime()
    );
  }

  private static getConsecutiveEmptyHealthCount() {
    try {
      const rows = db
        .prepare('SELECT status FROM scrape_health_logs ORDER BY id DESC LIMIT 50')
        .all() as Array<{ status?: string }>;
      let count = 0;
      for (const row of rows) {
        const status = String(row?.status || '').toLowerCase();
        if (status !== 'empty') break;
        count += 1;
      }
      return count;
    } catch {
      return 0;
    }
  }

  private static clearStaleNonManualSnapshotIfNeeded(consecutiveEmptyCount: number) {
    // 防止线上短时抓取异常导致“比赛列表被自动清空”。
    // 现在即使连续 empty，也保留当前快照，等待下一轮抓取恢复。
    if (consecutiveEmptyCount >= EMPTY_SNAPSHOT_STALE_THRESHOLD) {
      console.warn(
        `[snapshot-stale-guard] skip auto-clear after ${consecutiveEmptyCount} consecutive empty snapshots (preserve last snapshot)`
      );
    }
    return 0;
  }

  private static stabilizeRowWithCurrent(
    incoming: NormalizedSyncRow,
    current?: NormalizedSyncRow
  ): {
    row: NormalizedSyncRow;
    keptCurrentHandicaps: boolean;
    keptCurrentOverUnder: boolean;
  } {
    if (!current) {
      return {
        row: incoming,
        keptCurrentHandicaps: false,
        keptCurrentOverUnder: false,
      };
    }
    const incomingHandicaps = this.getValidCrownHandicaps(incoming.c_h || []);
    const currentHandicaps = this.getValidCrownHandicaps(current.c_h || []);
    const incomingOverUnder = this.getValidOverUnderOdds(incoming.c_ou || []);
    const currentOverUnder = this.getValidOverUnderOdds(current.c_ou || []);
    // 最新优先：不再因“组数变少”保留旧值，避免历史盘口污染实时数据。
    const keepCurrentHandicaps = false;
    const keepCurrentOverUnder = false;
    return {
      row: {
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
      // 皇冠字段必须以“本轮抓取结果”为准，不沿用历史值，避免失效旧数据污染套利计算。
      c_w: incoming.c_w > 0 ? incoming.c_w : 0,
      c_d: incoming.c_d > 0 ? incoming.c_d : 0,
      c_l: incoming.c_l > 0 ? incoming.c_l : 0,
      c_h: keepCurrentHandicaps ? currentHandicaps : incomingHandicaps.length > 0 ? incomingHandicaps : [],
      c_goal: (incoming.c_goal || []).length > 0 ? incoming.c_goal : current.c_goal,
      c_ou: keepCurrentOverUnder ? currentOverUnder : incomingOverUnder.length > 0 ? incomingOverUnder : [],
    },
      keptCurrentHandicaps: keepCurrentHandicaps,
      keptCurrentOverUnder: keepCurrentOverUnder,
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

  private static cleanupStoredCrownHandicaps() {
    const rows = db
      .prepare("SELECT match_id, handicaps FROM crown_odds WHERE match_id NOT LIKE 'manual_%'")
      .all() as Array<{ match_id: string; handicaps?: string }>;
    const update = db.prepare('UPDATE crown_odds SET handicaps = ?, updated_at = ? WHERE match_id = ?');
    const nowText = formatLocalDbDateTime();
    let cleaned = 0;

    for (const row of rows) {
      if (!row.match_id) continue;

      let parsed: any = [];
      try {
        parsed = row.handicaps ? JSON.parse(row.handicaps) : [];
      } catch {
        parsed = [];
      }

      const source = Array.isArray(parsed) ? parsed : [];
      const normalized = this.getValidCrownHandicaps(source);
      const sourceJson = JSON.stringify(source);
      const normalizedJson = JSON.stringify(normalized);
      if (sourceJson === normalizedJson) continue;

      update.run(normalizedJson, nowText, row.match_id);
      cleaned += 1;
    }

    return cleaned;
  }

  private static mergeHandicapCandidates(
    primary: ExternalHandicap[],
    secondary: ExternalHandicap[],
    options?: { preferPrimaryZero?: boolean }
  ) {
    let secondaryItems = secondary || [];
    if (options?.preferPrimaryZero && (primary || []).some((item) => this.isZeroHandicapType(item?.type))) {
      secondaryItems = secondaryItems.filter((item) => !this.isZeroHandicapType(item?.type));
    }
    return this.getValidCrownHandicaps([...(primary || []), ...secondaryItems]).slice(0, CROWN_HANDICAP_STORE_LIMIT);
  }

  private static buildHandicapsWithFallback(match: ExternalMatch) {
    const latest = this.buildHandicaps(match);
    // 让球只使用本轮抓取数据（含当轮兜底），不拼接数据库历史值。
    return latest.slice(0, CROWN_HANDICAP_STORE_LIMIT);
  }

  private static invertSignedHandicapLine(line?: string) {
    const normalized = this.normalizeHandicapV2(line);
    if (!normalized) return '';
    if (normalized.startsWith('+')) return `-${normalized.slice(1)}`;
    if (normalized.startsWith('-')) return `+${normalized.slice(1)}`;
    return normalized;
  }

  private static removeLikelyInjectedJingcaiHandicap(
    handicaps: ExternalHandicap[],
    jingcaiLine?: string,
    jhw?: number,
    jhl?: number
  ) {
    const targetLine = this.invertSignedHandicapLine(jingcaiLine);
    const home = Number(jhw || 0);
    const away = Number(jhl || 0);
    if (!targetLine || home <= 0 || away <= 0) return handicaps;
    const eps = 1e-6;
    return (handicaps || []).filter((item) => {
      const type = this.normalizeHandicapV2(String(item?.type || ''));
      const homeOdds = Number(item?.home_odds || 0);
      const awayOdds = Number(item?.away_odds || 0);
      const sameLine = type === targetLine;
      const sameOdds = Math.abs(homeOdds - home) <= eps && Math.abs(awayOdds - away) <= eps;
      return !(sameLine && sameOdds);
    });
  }

  private static toNormalizedSyncRow(match: ExternalMatch): NormalizedSyncRow {
    const correctedOdds = this.resolveJingcaiOddsMapping(match);
    const crownHandicaps = this.removeLikelyInjectedJingcaiHandicap(
      this.buildHandicapsWithFallback(match),
      match.jingcaiHandicap,
      correctedOdds.handicap.win,
      correctedOdds.handicap.lose
    );
    const homeTeamDisplay = this.canonicalizeDisplayTeamName(match.homeTeam || '');
    const awayTeamDisplay = this.canonicalizeDisplayTeamName(match.awayTeam || '');
    return {
      match_id: match.id,
      league: match.league || '',
      round: match.round || '',
      handicap: match.handicap || '',
      jingcai_handicap: match.jingcaiHandicap || '',
      home_team: homeTeamDisplay,
      away_team: awayTeamDisplay,
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
      c_h: crownHandicaps,
      c_goal: this.getValidGoalOdds(match.crownGoalOdds || []),
      c_ou: this.getValidOverUnderOdds(match.crownOverUnderOdds || []),
    };
  }

  private static buildExternalMatchIndex(rows: ExternalMatch[]) {
    const byId = new Map<string, ExternalMatch>();
    const byPairMinute = new Map<string, ExternalMatch>();
    const byPairDate = new Map<string, ExternalMatch>();
    for (const row of rows || []) {
      const id = String(row.id || '').trim();
      if (id) byId.set(id, row);
      const minuteKey = this.buildPairMinuteKey(row.matchTime, row.homeTeam, row.awayTeam);
      if (minuteKey && !byPairMinute.has(minuteKey)) byPairMinute.set(minuteKey, row);
      const dateKey = this.buildPairDateKey(row.matchTime, row.homeTeam, row.awayTeam);
      if (dateKey && !byPairDate.has(dateKey)) byPairDate.set(dateKey, row);
    }
    return { byId, byPairMinute, byPairDate };
  }

  private static pickExternalMatchFromIndex(
    index: { byId: Map<string, ExternalMatch>; byPairMinute: Map<string, ExternalMatch>; byPairDate: Map<string, ExternalMatch> },
    target: ExternalMatch
  ) {
    const id = String(target.id || '').trim();
    if (id && index.byId.has(id)) return index.byId.get(id) || null;
    const minuteKey = this.buildPairMinuteKey(target.matchTime, target.homeTeam, target.awayTeam);
    if (minuteKey && index.byPairMinute.has(minuteKey)) return index.byPairMinute.get(minuteKey) || null;
    const dateKey = this.buildPairDateKey(target.matchTime, target.homeTeam, target.awayTeam);
    if (dateKey && index.byPairDate.has(dateKey)) return index.byPairDate.get(dateKey) || null;
    return null;
  }

  private static buildPairMinuteKey(matchTime?: string, homeTeam?: string, awayTeam?: string) {
    const minute = this.normalizeMatchTime(matchTime || '').slice(0, 16);
    const home = this.normalizeNameForMatch(homeTeam || '');
    const away = this.normalizeNameForMatch(awayTeam || '');
    if (!minute || !home || !away) return '';
    return `${minute}|${home}|${away}`;
  }

  private static buildPairDateKey(matchTime?: string, homeTeam?: string, awayTeam?: string) {
    const date = this.normalizeMatchTime(matchTime || '').slice(0, 10);
    const home = this.normalizeNameForMatch(homeTeam || '');
    const away = this.normalizeNameForMatch(awayTeam || '');
    if (!date || !home || !away) return '';
    return `${date}|${home}|${away}`;
  }

  private static toUnifiedOdds(odds?: ExternalOdds): UnifiedJcOdds {
    return {
      win: this.parseOdds(odds?.win || ''),
      draw: this.parseOdds(odds?.draw || ''),
      lose: this.parseOdds(odds?.lose || ''),
    };
  }

  private static toUnifiedGoalOdds(items: ExternalGoalOdds[]): UnifiedGoalOdds[] {
    return this.getValidGoalOdds(items || []).map((item) => ({
      label: String(item.label || '').trim(),
      odds: Number(item.odds || 0),
    }));
  }

  private static toUnifiedHandicapOdds(items: ExternalHandicap[]): UnifiedHandicapOdds[] {
    return this.getValidCrownHandicaps(items || []).map((item) => ({
      line: String(item.type || '').trim(),
      home: Number(item.home_odds || 0),
      away: Number(item.away_odds || 0),
    }));
  }

  private static toUnifiedOuOdds(items: ExternalOverUnderOdds[]): UnifiedOverUnderOdds[] {
    return this.getValidOverUnderOdds(items || []).map((item) => ({
      line: String(item.line || '').trim(),
      over: Number(item.over_odds || 0),
      under: Number(item.under_odds || 0),
    }));
  }

  private static hasValidJcOdds(match?: ExternalMatch | null) {
    return !!(match && this.isValidExternalOdds(match.jingcaiOdds));
  }

  private static hasValidJcHOdds(match?: ExternalMatch | null) {
    return !!(match && this.isValidExternalOdds(match.jingcaiHandicapOdds));
  }

  private static hasValidGoalOdds(match?: ExternalMatch | null) {
    return !!(match && this.getValidGoalOdds(match.crownGoalOdds || []).length > 0);
  }

  private static hasValidHgSpf(match?: ExternalMatch | null) {
    return !!(match && this.isValidExternalOdds(match.crownOdds));
  }

  private static hasValidHgHandicap(match?: ExternalMatch | null) {
    return !!(match && this.getValidCrownHandicaps(match.crownHandicaps || []).length > 0);
  }

  private static hasValidHgOu(match?: ExternalMatch | null) {
    return !!(match && this.getValidOverUnderOdds(match.crownOverUnderOdds || []).length > 0);
  }

  private static pickJcSourceTrace(sporttery: ExternalMatch | null, trade: ExternalMatch | null, fetchedAt: string): FieldTrace {
    if (this.hasValidJcOdds(sporttery)) return { source: 'sporttery', fetched_at: fetchedAt };
    if (this.hasValidJcOdds(trade)) return { source: 'trade500', fetched_at: fetchedAt };
    return { source: 'other', fetched_at: fetchedAt, note: '缺失' };
  }

  private static pickJcHSourceTrace(sporttery: ExternalMatch | null, trade: ExternalMatch | null, fetchedAt: string): FieldTrace {
    if (this.hasValidJcHOdds(sporttery)) return { source: 'sporttery', fetched_at: fetchedAt };
    if (this.hasValidJcHOdds(trade)) return { source: 'trade500', fetched_at: fetchedAt };
    return { source: 'other', fetched_at: fetchedAt, note: '缺失' };
  }

  private static pickGoalSourceTrace(sporttery: ExternalMatch | null, trade: ExternalMatch | null, fetchedAt: string): FieldTrace {
    if (this.hasValidGoalOdds(sporttery)) return { source: 'sporttery', fetched_at: fetchedAt };
    if (this.hasValidGoalOdds(trade)) return { source: 'trade500', fetched_at: fetchedAt };
    return { source: 'other', fetched_at: fetchedAt, note: '缺失' };
  }

  private static pickHgSpfTrace(
    live: ExternalMatch | null,
    odds500: ExternalMatch | null,
    trade500Odds: ExternalMatch | null,
    finalMerged: ExternalMatch | null,
    fetchedAt: string
  ): FieldTrace {
    if (this.hasValidHgSpf(live)) return { source: 'live500', fetched_at: fetchedAt };
    if (this.hasValidHgSpf(odds500)) return { source: 'odds500', fetched_at: fetchedAt };
    if (this.hasValidHgSpf(trade500Odds)) return { source: 'trade500', fetched_at: fetchedAt };
    if (this.hasValidHgSpf(finalMerged)) return { source: 'other', fetched_at: fetchedAt };
    return { source: 'other', fetched_at: fetchedAt, note: '缺失' };
  }

  private static pickHgHandicapTrace(
    odds500: ExternalMatch | null,
    trade500Odds: ExternalMatch | null,
    finalMerged: ExternalMatch | null,
    fetchedAt: string
  ): FieldTrace {
    if (this.hasValidHgHandicap(odds500)) return { source: 'odds500', fetched_at: fetchedAt };
    if (this.hasValidHgHandicap(trade500Odds)) return { source: 'trade500', fetched_at: fetchedAt };
    if (this.hasValidHgHandicap(finalMerged)) return { source: 'other', fetched_at: fetchedAt };
    return { source: 'other', fetched_at: fetchedAt, note: '缺失' };
  }

  private static pickHgOuTrace(odds500: ExternalMatch | null, finalMerged: ExternalMatch | null, fetchedAt: string): FieldTrace {
    if (this.hasValidHgOu(odds500)) return { source: 'odds500', fetched_at: fetchedAt };
    if (this.hasValidHgOu(finalMerged)) return { source: 'other', fetched_at: fetchedAt };
    return { source: 'other', fetched_at: fetchedAt, note: '缺失' };
  }

  private static canonicalizeDisplayTeamName(name: string) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const map = this.getDisplayTeamCanonicalMap();
    const exact = map.get(raw);
    if (exact) return exact;
    const normalized = this.normalizeNameForMatch(raw);
    if (!normalized) return raw;
    const byNormalized = map.get(normalized);
    return byNormalized || raw;
  }

  private static getDisplayTeamCanonicalMap() {
    if (this.displayTeamCanonicalMapCache) return this.displayTeamCanonicalMapCache;
    const out = new Map<string, string>();
    try {
      if (fs.existsSync(DISPLAY_TEAM_CANONICAL_MAP_FILE)) {
        const text = fs.readFileSync(DISPLAY_TEAM_CANONICAL_MAP_FILE, 'utf8');
        const parsed = JSON.parse(text) as Record<string, string>;
        for (const [alias, canonical] of Object.entries(parsed || {})) {
          const left = String(alias || '').trim();
          const right = String(canonical || '').trim();
          if (!left || !right) continue;
          out.set(left, right);
          const normalizedLeft = this.normalizeNameForMatch(left);
          if (normalizedLeft) out.set(normalizedLeft, right);
        }
      }
    } catch (err: any) {
      console.warn(`load team display canonical map failed: ${err?.message || err}`);
    }
    this.displayTeamCanonicalMapCache = out;
    return out;
  }

  private static getCurrentNonManualSyncRows(): NormalizedSyncRow[] {
    const rows = db
      .prepare(`
        SELECT m.match_id, m.league, m.round, m.handicap, m.jingcai_handicap, m.home_team, m.away_team, m.match_time,
               j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
               j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
               c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h, c.goal_odds as c_goal, c.over_under_odds as c_ou
        FROM matches m
        LEFT JOIN jingcai_odds j ON m.match_id = j.match_id
        LEFT JOIN crown_odds c ON m.match_id = c.match_id
        WHERE m.match_id NOT LIKE 'manual_%'
          AND COALESCE(m.status, 'upcoming') != 'stale'
      `)
      .all() as Array<any>;
    return rows.map((row) => {
      let parsed: any = [];
      let parsedGoal: any = [];
      let parsedOu: any = [];
      try {
        parsed = row.c_h ? JSON.parse(row.c_h) : [];
      } catch {
        parsed = [];
      }
      try {
        parsedGoal = row.c_goal ? JSON.parse(row.c_goal) : [];
      } catch {
        parsedGoal = [];
      }
      try {
        parsedOu = row.c_ou ? JSON.parse(row.c_ou) : [];
      } catch {
        parsedOu = [];
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
        c_h: this.getValidCrownHandicaps(Array.isArray(parsed) ? parsed : []).slice(0, CROWN_HANDICAP_STORE_LIMIT),
        c_goal: this.getValidGoalOdds(Array.isArray(parsedGoal) ? parsedGoal : []),
        c_ou: this.getValidOverUnderOdds(Array.isArray(parsedOu) ? parsedOu : []),
      } as NormalizedSyncRow;
    });
  }

  private static getComparableCurrentRowsByDate(currentRows: NormalizedSyncRow[], incomingRows: NormalizedSyncRow[]) {
    if (currentRows.length === 0 || incomingRows.length === 0) return [];
    const incomingDates = new Set(
      incomingRows
        .map((row) => this.normalizeMatchTime(row.match_time).slice(0, 10))
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    );
    if (incomingDates.size === 0) return currentRows;
    return currentRows.filter((row) => incomingDates.has(this.normalizeMatchTime(row.match_time).slice(0, 10)));
  }

  private static serializeSyncRows(rows: NormalizedSyncRow[]) {
    const normalized = rows
      .map((row) => ({
        ...row,
        c_h: this.getValidCrownHandicaps(row.c_h || []).slice(0, CROWN_HANDICAP_STORE_LIMIT),
        c_goal: this.getValidGoalOdds(row.c_goal || []),
        c_ou: this.getValidOverUnderOdds(row.c_ou || []),
      }))
      .sort((a, b) => a.match_id.localeCompare(b.match_id));
    return JSON.stringify(normalized);
  }

  private static isSameSyncRows(currentRows: NormalizedSyncRow[], incomingRows: NormalizedSyncRow[]) {
    if (currentRows.length !== incomingRows.length) return false;
    return this.serializeSyncRows(currentRows) === this.serializeSyncRows(incomingRows);
  }

  private static getSyncComparableRow(row: NormalizedSyncRow) {
    return {
      ...row,
      c_h: this.getValidCrownHandicaps(row.c_h || []).slice(0, CROWN_HANDICAP_STORE_LIMIT),
      c_goal: this.getValidGoalOdds(row.c_goal || []),
      c_ou: this.getValidOverUnderOdds(row.c_ou || []),
    };
  }

  private static getChangedSyncFields(current: NormalizedSyncRow, incoming: NormalizedSyncRow) {
    const left = this.getSyncComparableRow(current);
    const right = this.getSyncComparableRow(incoming);
    const changed: string[] = [];
    const scalarFields: Array<keyof NormalizedSyncRow> = [
      'league',
      'round',
      'handicap',
      'jingcai_handicap',
      'home_team',
      'away_team',
      'match_time',
      'j_w',
      'j_d',
      'j_l',
      'j_hw',
      'j_hd',
      'j_hl',
      'c_w',
      'c_d',
      'c_l',
    ];
    for (const key of scalarFields) {
      if (left[key] !== right[key]) changed.push(String(key));
    }
    if (JSON.stringify(left.c_h) !== JSON.stringify(right.c_h)) changed.push('c_h');
    if (JSON.stringify(left.c_goal) !== JSON.stringify(right.c_goal)) changed.push('c_goal');
    if (JSON.stringify(left.c_ou) !== JSON.stringify(right.c_ou)) changed.push('c_ou');
    return changed;
  }

  private static buildSyncRowDiff(currentRows: NormalizedSyncRow[], incomingRows: NormalizedSyncRow[]) {
    const currentMap = new Map(currentRows.map((row) => [row.match_id, row] as const));
    const incomingMap = new Map(incomingRows.map((row) => [row.match_id, row] as const));
    const toUpsert: NormalizedSyncRow[] = [];
    const toDelete: string[] = [];
    const events: SyncRowChangeEvent[] = [];

    for (const row of incomingRows) {
      const current = currentMap.get(row.match_id);
      if (!current) {
        toUpsert.push(row);
        events.push({
          match_id: row.match_id,
          change_type: 'insert',
          changed_fields: [
            'league',
            'round',
            'handicap',
            'jingcai_handicap',
            'home_team',
            'away_team',
            'match_time',
            'j_w',
            'j_d',
            'j_l',
            'j_hw',
            'j_hd',
            'j_hl',
            'c_w',
            'c_d',
            'c_l',
            'c_h',
            'c_goal',
            'c_ou',
          ],
        });
        continue;
      }
      const changedFields = this.getChangedSyncFields(current, row);
      if (changedFields.length === 0) continue;
      toUpsert.push(row);
      events.push({
        match_id: row.match_id,
        change_type: 'update',
        changed_fields: changedFields,
      });
    }

    for (const row of currentRows) {
      if (incomingMap.has(row.match_id)) continue;
      toDelete.push(row.match_id);
      events.push({
        match_id: row.match_id,
        change_type: 'delete',
        changed_fields: [],
      });
    }

    return { toUpsert, toDelete, events };
  }

  private static validateIncomingSnapshotQuality(currentRows: NormalizedSyncRow[], incomingRows: NormalizedSyncRow[]) {
    if (!Array.isArray(incomingRows) || incomingRows.length === 0) {
      return { ok: false as const, reason: 'incoming rows empty' };
    }

    const countCrownWinDrawLose = (rows: NormalizedSyncRow[]) =>
      rows.filter((row) => row.c_w > 0 && row.c_d > 0 && row.c_l > 0).length;
    const countCrownHandicap = (rows: NormalizedSyncRow[]) =>
      rows.filter((row) => Array.isArray(row.c_h) && row.c_h.length > 0).length;
    const countCrownOverUnder = (rows: NormalizedSyncRow[]) =>
      rows.filter((row) => Array.isArray(row.c_ou) && row.c_ou.length > 0).length;

    const currentCrownWdl = countCrownWinDrawLose(currentRows);
    const incomingCrownWdl = countCrownWinDrawLose(incomingRows);
    const currentCrownHcap = countCrownHandicap(currentRows);
    const incomingCrownHcap = countCrownHandicap(incomingRows);
    const currentCrownOu = countCrownOverUnder(currentRows);
    const incomingCrownOu = countCrownOverUnder(incomingRows);

    // Only guard when we have enough historical baseline; avoid false positives on tiny sets.
    if (currentCrownWdl >= 10 && incomingCrownWdl < Math.floor(currentCrownWdl * 0.4)) {
      return {
        ok: false as const,
        reason: `crown wdl dropped too much (${incomingCrownWdl}/${currentCrownWdl})`,
      };
    }
    if (currentCrownHcap >= 10 && incomingCrownHcap < Math.floor(currentCrownHcap * 0.4)) {
      return {
        ok: false as const,
        reason: `crown handicap dropped too much (${incomingCrownHcap}/${currentCrownHcap})`,
      };
    }
    if (currentCrownOu >= 10 && incomingCrownOu < Math.floor(currentCrownOu * 0.4)) {
      return {
        ok: false as const,
        reason: `crown over_under dropped too much (${incomingCrownOu}/${currentCrownOu})`,
      };
    }

    return { ok: true as const, reason: 'ok' };
  }

  private static getNonManualBatchCreatedAtText() {
    const row = db
      .prepare("SELECT MAX(created_at) as created_at FROM matches WHERE match_id NOT LIKE 'manual_%'")
      .get() as { created_at?: string } | undefined;
    return String(row?.created_at || '').trim();
  }

  private static persistSyncChangeEvents(events: SyncRowChangeEvent[], version: string) {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS sync_change_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        changed_fields TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ).run();
    const insert = db.prepare(
      'INSERT INTO sync_change_events (match_id, change_type, changed_fields, version, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const event of events) {
      insert.run(
        event.match_id,
        event.change_type,
        JSON.stringify(event.changed_fields || []),
        version,
        formatLocalDbDateTime()
      );
    }
    // keep latest events only
    db.prepare(
      'DELETE FROM sync_change_events WHERE id NOT IN (SELECT id FROM sync_change_events ORDER BY id DESC LIMIT 5000)'
    ).run();
  }

  private static pruneHgaTargetHealth(maxSize = 600) {
    if (this.hgaTargetHealth.size <= maxSize) return;
    const sorted = Array.from(this.hgaTargetHealth.entries()).sort(
      (a, b) => (b[1].lastAttemptAtMs || 0) - (a[1].lastAttemptAtMs || 0)
    );
    this.hgaTargetHealth = new Map(sorted.slice(0, maxSize));
  }

  private static pickHgaIncrementalTargets(baseMatches: ExternalMatch[], maxPerRound = 24) {
    const now = Date.now();
    const horizonMs = 48 * 60 * 60 * 1000;
    const rows = baseMatches
      .map((match) => {
        const health = this.hgaTargetHealth.get(match.id) || {
          lastAttemptAtMs: 0,
          lastSuccessAtMs: 0,
          failStreak: 0,
          handicapCount: 0,
          overUnderCount: 0,
        };
        const matchTs = Date.parse(String(this.normalizeMatchTime(match.matchTime)).replace(' ', 'T'));
        const inHorizon = Number.isFinite(matchTs) ? matchTs >= now - 2 * 60 * 60 * 1000 && matchTs <= now + horizonMs : true;
        if (!inHorizon) return null;
        const handicapCount = this.getValidCrownHandicaps(this.buildHandicaps(match)).length;
        const overUnderCount = this.getValidOverUnderOdds(match.crownOverUnderOdds || []).length;
        const missingScore = (handicapCount < REQUIRED_CROWN_HANDICAP_COUNT ? 80 : 0) + (overUnderCount === 0 ? 40 : 0);
        const staleMinutes = (now - Math.max(health.lastSuccessAtMs || 0, 0)) / 60000;
        const backoffPenalty = health.failStreak >= 3 && now - (health.lastAttemptAtMs || 0) < 5 * 60 * 1000 ? 80 : 0;
        const score = missingScore + Math.min(60, Math.max(0, staleMinutes / 2)) + Math.min(40, health.failStreak * 8) - backoffPenalty;
        return { match, score };
      })
      .filter((item): item is { match: ExternalMatch; score: number } => Boolean(item));

    rows.sort((a, b) => b.score - a.score);
    const picked = rows.slice(0, Math.max(6, Math.min(maxPerRound, rows.length))).map((item) => item.match);
    return picked.length > 0 ? picked : baseMatches.slice(0, Math.min(maxPerRound, baseMatches.length));
  }

  private static markHgaTargetAttempt(targets: ExternalMatch[]) {
    const now = Date.now();
    for (const match of targets) {
      const prev = this.hgaTargetHealth.get(match.id) || {
        lastAttemptAtMs: 0,
        lastSuccessAtMs: 0,
        failStreak: 0,
        handicapCount: 0,
        overUnderCount: 0,
      };
      this.hgaTargetHealth.set(match.id, {
        ...prev,
        lastAttemptAtMs: now,
      });
    }
    this.pruneHgaTargetHealth();
  }

  private static hasHgaCandidateForMatch(match: ExternalMatch, hgaMatches: HgaMatch[]) {
    const pair = this.normalizeMatchPair(match.homeTeam, match.awayTeam);
    return hgaMatches.some((row) => this.normalizeMatchPair(row.homeTeam, row.awayTeam) === pair);
  }

  private static markHgaTargetResult(targets: ExternalMatch[], hgaMatches: HgaMatch[]) {
    const now = Date.now();
    for (const match of targets) {
      const prev = this.hgaTargetHealth.get(match.id) || {
        lastAttemptAtMs: now,
        lastSuccessAtMs: 0,
        failStreak: 0,
        handicapCount: 0,
        overUnderCount: 0,
      };
      if (this.hasHgaCandidateForMatch(match, hgaMatches)) {
        this.hgaTargetHealth.set(match.id, {
          ...prev,
          lastSuccessAtMs: now,
          failStreak: 0,
        });
      } else {
        this.hgaTargetHealth.set(match.id, {
          ...prev,
          failStreak: Math.min(10, (prev.failStreak || 0) + 1),
        });
      }
    }
    this.pruneHgaTargetHealth();
  }

  private static isHgaMatchDataSufficient(handicaps: ExternalHandicap[], overUnderOdds: ExternalOverUnderOdds[]) {
    const hcapCount = this.getValidCrownHandicaps(handicaps || []).length;
    const ouCount = this.getValidOverUnderOdds(overUnderOdds || []).length;
    return hcapCount >= REQUIRED_CROWN_HANDICAP_COUNT && ouCount >= 1;
  }

  private static getHgaSingleMatchRetryBudget(matchId: string, baseRetry = 2) {
    const health = this.hgaTargetHealth.get(matchId);
    const failStreak = Number(health?.failStreak || 0);
    if (failStreak >= 6) return 1;
    if (failStreak >= 3) return Math.max(1, baseRetry);
    return Math.max(1, baseRetry + 1);
  }

  private static async fetchExternalMatches(): Promise<ExternalMatch[]> {
    this.lastFetchMeta = {
      hga_status: 'unknown',
      hga_count: 0,
      base_count: 0,
      merged_count: 0,
      playwright_fallback_used: false,
      rich365_match_auto_count: 0,
      rich365_match_review_count: 0,
      rich365_match_reject_count: 0,
      rich365_d0_match_count: 0,
      rich365_d1_match_count: 0,
      rich365_ou_fallback_hit_count: 0,
      odds500_yazhi_hit_count: 0,
      odds500_daxiao_hit_count: 0,
      trade500_jqs_hit_count: 0,
      hga_override_hit_count: 0,
      primary_source: 'unknown',
    };
    const hgaConfig = this.getHgaConfig();
    const strictByHgaHandicapCount = (rows: ExternalMatch[]) =>
      rows.filter((match) => this.getValidCrownHandicaps(this.buildHandicaps(match)).length >= REQUIRED_CROWN_HANDICAP_COUNT);

    let baseMatches: ExternalMatch[] = [];
    let usedPrimarySource: 'sporttery' | 'trade500' = 'sporttery';
    let sportteryPrimaryError = '';
    try {
      baseMatches = await this.fetchSportteryAsPrimaryMatches();
      try {
        const tradeRows = await this.fetchTrade500MatchesFromXml();
        if (tradeRows.length > 0) {
          baseMatches = this.mergeTrade500JingcaiData(baseMatches, tradeRows);
        }
      } catch (mergeErr: any) {
        console.warn(`Trade500 jingcai merge skipped in sync chain: ${mergeErr?.message || mergeErr}`);
      }
      this.lastFetchMeta.primary_source = 'sporttery';
      baseMatches = await this.enrichWithLive500CrownOdds(baseMatches);
      baseMatches = await this.enrichWithOdds500CrownMarkets(baseMatches);
      // 先完成 Sporttery + live500 + odds500 基础补强，再进入 trade500/365rich 兜底。
      if (hgaConfig.enabled) {
        baseMatches = await this.enrichWithTrade500CrownOddsFallback(baseMatches);
        baseMatches = await this.enrichWithTrade500CrownHandicapFallback(baseMatches);
        baseMatches = await this.enrichWith365RichCrownFallback(baseMatches);
      }
      this.lastFetchMeta.base_count = baseMatches.length;
    } catch (err: any) {
      sportteryPrimaryError = String(err?.message || err || '');
      console.warn(`Sporttery primary source failed: ${sportteryPrimaryError}`);
      usedPrimarySource = 'trade500';
      this.lastFetchMeta.primary_source = 'trade500';
      try {
        baseMatches = await this.fetchTrade500AsPrimaryMatches();
        baseMatches = await this.enrichWithSportteryJingcai(baseMatches);
        baseMatches = await this.enrichWithSportteryTtg(baseMatches);
        baseMatches = await this.enrichWithTrade500GoalOddsFallback(baseMatches, 'trade500-primary');
        baseMatches = await this.enrichWithOdds500CrownMarkets(baseMatches);
        this.lastFetchMeta.base_count = baseMatches.length;
        console.warn(
          `Switched to Trade500 primary fallback due to sporttery failure: ${sportteryPrimaryError}; matches=${baseMatches.length}`
        );
        console.warn(
          `Trade500 fallback odds500 enrichment summary: ${this.buildSourceHitSummaryNote()}`
        );
      } catch (fallbackErr: any) {
        const fallbackError = String(fallbackErr?.message || fallbackErr || '');
        console.warn(`Trade500 primary fallback failed: ${fallbackError}`);
        this.lastFetchMeta.hga_status = 'failed';
        this.setHgaRuntimeState(
          'failed',
          `Primary source failed: sporttery=${sportteryPrimaryError || 'unknown'}; trade500=${fallbackError || 'unknown'}`
        );
        return [];
      }
    }
    if (!hgaConfig.enabled) {
      this.lastFetchMeta.hga_status = 'unknown';
      if (this.hgaLastStatus === 'unknown' || !this.hgaLastMessage) {
        this.setHgaRuntimeState(
          'disabled',
          usedPrimarySource === 'trade500'
            ? 'HGA disabled, using Trade500 primary fallback because sporttery is unavailable'
            : 'HGA disabled, using Sporttery primary source'
        );
      }
      return this.tryPlaywrightCrownPatch(baseMatches, 'hga-disabled');
    }

    if (!hgaConfig.username || !hgaConfig.password) {
      this.lastFetchMeta.hga_status = 'failed';
      this.setHgaRuntimeState('failed', 'HGA 账号或密码未配置，已跳过 HGA 抓取');
      return baseMatches;
    }

    if (this.isSourceCircuitOpen('hga')) {
      const circuitMeta = this.getSourceCircuitMeta('hga');
      this.lastFetchMeta.hga_status = 'failed';
      this.setHgaRuntimeState(
        'failed',
        `HGA circuit cooldown active until ${new Date(circuitMeta.openUntilMs).toISOString()} (${circuitMeta.lastReason || 'upstream instability'})`
      );
      console.warn(`HGA circuit open, skip fetch this round: ${circuitMeta.lastReason || 'cooldown'}`);
      return baseMatches;
    }

    if (this.hgaRiskBlocked) {
      this.lastFetchMeta.hga_status = 'locked';
      this.setHgaRuntimeState('locked', this.hgaLoginBlockedReason || 'HGA 已被上游风控锁定');
      console.warn(`HGA risk lock detected, skip HGA fetch: ${this.hgaLoginBlockedReason || 'locked by upstream'}`);
      const withPw = await this.tryPlaywrightFallback(baseMatches, 'hga-locked');
      if (withPw.length > 0) baseMatches = withPw;
      baseMatches = await this.tryPlaywrightCrownPatch(baseMatches, 'hga-locked');
      const strictBase = strictByHgaHandicapCount(baseMatches);
      console.warn(`Trade500 strict fallback reference: ${strictBase.length}/${baseMatches.length} matches`);
      return baseMatches;
    }

    let hgaTargets: ExternalMatch[] = [];
    try {
      hgaTargets = this.pickHgaIncrementalTargets(baseMatches, 24);
      console.log(`HGA incremental fetch targets: ${hgaTargets.length}/${baseMatches.length}`);
      this.markHgaTargetAttempt(hgaTargets);
      const hgaMatches = await this.withTimeout(this.fetchHgaMatches(hgaTargets), HGA_FETCH_TIMEOUT_MS, 'HGA fetch timeout');
      this.markHgaTargetResult(hgaTargets, hgaMatches);
      this.lastFetchMeta.hga_count = hgaMatches.length;
      if (hgaMatches.length === 0) {
        this.lastFetchMeta.hga_status = 'empty';
        this.setHgaRuntimeState('empty', 'HGA 返回空数据，已回退到 Trade500 主链路');
        console.warn('HGA returned 0 matches, fallback to Trade500 primary source');
        const withPw = await this.tryPlaywrightFallback(baseMatches, 'hga-empty');
        if (withPw.length > 0) baseMatches = withPw;
        baseMatches = await this.tryPlaywrightCrownPatch(baseMatches, 'hga-empty');
        const strictBase = strictByHgaHandicapCount(baseMatches);
        console.warn(`Trade500 strict fallback reference: ${strictBase.length}/${baseMatches.length} matches`);
        return baseMatches;
      }
      const merged = await this.tryPlaywrightCrownPatch(this.mergeHgaCrownData(baseMatches, hgaMatches), 'hga-partial');
      this.lastFetchMeta.hga_status = 'ok';
      this.lastFetchMeta.merged_count = merged.length;
      this.setHgaRuntimeState('ok', `HGA 抓取成功，返回 ${hgaMatches.length} 场，合并后 ${merged.length} 场`);
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
      if (hgaTargets.length > 0) {
        this.markHgaTargetResult(hgaTargets, []);
      }
      const errText = String(err?.message || '');
      if (errText.includes(HGA_ACCOUNT_LOCKED)) {
        this.lastFetchMeta.hga_status = 'locked';
        this.disableHgaByLock(errText.replace(`${HGA_ACCOUNT_LOCKED}:`, '').trim() || errText);
      } else if (errText.includes(HGA_CREDENTIALS_INVALID)) {
        this.lastFetchMeta.hga_status = 'failed';
        this.disableHgaByCredentialFailure(
          errText.replace(`${HGA_CREDENTIALS_INVALID}:`, '').trim() ||
            '检测到 HGA 账号或密码错误，已自动关闭 HGA 抓取，请更新配置后手动重新开启'
        );
      } else {
        this.lastFetchMeta.hga_status = errText.includes('timeout') ? 'timeout' : 'failed';
        this.setHgaRuntimeState(errText.includes('timeout') ? 'timeout' : 'failed', errText || 'HGA 抓取失败');
      }
      console.warn(`HGA source failed, fallback to Trade500 primary source: ${err?.message || err}`);
      if (this.lastFetchMeta.hga_status === 'timeout') {
        const strictBase = strictByHgaHandicapCount(baseMatches);
        console.warn(`Skip Playwright fallback on HGA timeout, keep Trade500 base result: ${strictBase.length}/${baseMatches.length} matches`);
        return this.tryPlaywrightCrownPatch(baseMatches, 'hga-timeout');
      }
      const withPw = await this.tryPlaywrightFallback(baseMatches, this.lastFetchMeta.hga_status === 'locked' ? 'hga-locked' : 'hga-failed');
      if (withPw.length > 0) baseMatches = withPw;
      baseMatches = await this.tryPlaywrightCrownPatch(
        baseMatches,
        this.lastFetchMeta.hga_status === 'locked' ? 'hga-locked' : 'hga-failed'
      );
      const strictBase = strictByHgaHandicapCount(baseMatches);
      console.warn(`Trade500 strict fallback reference: ${strictBase.length}/${baseMatches.length} matches`);
      return baseMatches;
    }
  }

  private static getHgaConfig() {
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id?: number } | undefined;
    const adminId = admin?.id;
    if (!adminId) {
      return { enabled: false, username: '', password: '' };
    }
    const rows = db
      .prepare(
        "SELECT key, value FROM system_settings WHERE user_id = ? AND key IN ('hga_enabled', 'hga_username', 'hga_password')"
      )
      .all(adminId) as Array<{ key: string; value: string }>;
    const map = rows.reduce<Record<string, string>>((acc, curr) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});
    return {
      enabled: map.hga_enabled === 'true',
      username: String(map.hga_username || '').trim(),
      password: String(map.hga_password || '').trim(),
    };
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

  private static async fetchPlaywrightMatchesForDates(dates: string[]): Promise<ExternalMatch[]> {
    const mod = require('./scraper/playwright-scraper-full.cjs');
    const scrape = mod?.scrapeFullMatchData;
    if (typeof scrape !== 'function') return [];
    const out: ExternalMatch[] = [];
    const seen = new Set<string>();
    for (const date of dates) {
      const rows = await scrape(date);
      for (const row of Array.isArray(rows) ? rows : []) {
        const key = String(row?.id || `${row?.homeTeam || ''}|${row?.awayTeam || ''}|${row?.matchTime || ''}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
    }
    return out;
  }

  private static async fetch365RichCrownRows(targetDate?: string): Promise<Rich365CrownRow[]> {
    const mod = require('./scraper/playwright-scraper-full.cjs');
    const scrape = mod?.scrape365RichCrownData;
    if (typeof scrape !== 'function') return [];
    const rows = await scrape(targetDate || null);
    if (!Array.isArray(rows)) return [];
    const shouldFilterByNow = (() => {
      const dateText = String(targetDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return true;
      const today = this.normalizeMatchTime(new Date().toISOString().slice(0, 19).replace('T', ' ')).slice(0, 10);
      // 历史日期不按“当前时间”过滤，避免历史批次无法匹配 365rich。
      return dateText >= today;
    })();
    if (!shouldFilterByNow) return rows;
    const nowMs = Date.now();
    return rows.filter((row) => this.is365RowNotStarted(row, nowMs));
  }

  private static async fetch365RichCrownDetails(matchIds: string[]) {
    const ids = Array.from(new Set((matchIds || []).map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id))));
    if (ids.length === 0) return {} as Record<string, { handicaps?: ExternalHandicap[]; overUnderOdds?: ExternalOverUnderOdds[] }>;
    const mod = require('./scraper/playwright-scraper-full.cjs');
    const scrape = mod?.scrape365RichCrownDetails;
    if (typeof scrape !== 'function') return {} as Record<string, { handicaps?: ExternalHandicap[]; overUnderOdds?: ExternalOverUnderOdds[] }>;
    const detailMap = await scrape(ids);
    return detailMap && typeof detailMap === 'object'
      ? (detailMap as Record<string, { handicaps?: ExternalHandicap[]; overUnderOdds?: ExternalOverUnderOdds[] }>)
      : {};
  }

  private static normalize365MatchTime(rawTime: string, baseMatchTime?: string, sourceDate?: string) {
    const hhmm = String(rawTime || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!hhmm) return '';
    const explicitDate = String(sourceDate || '').trim().match(/^(\d{4}-\d{2}-\d{2})$/);
    const hh = String(Number.parseInt(hhmm[1], 10)).padStart(2, '0');
    const mm = hhmm[2];
    if (explicitDate) {
      return `${explicitDate[1]} ${hh}:${mm}:00`;
    }
    const base = this.normalizeMatchTime(baseMatchTime || '');
    const baseDate = base.match(/^(\d{4}-\d{2}-\d{2})\s/);
    if (!baseDate) return '';
    return `${baseDate[1]} ${hh}:${mm}:00`;
  }

  private static parseLocalDateTimeToMs(value?: string) {
    const normalized = this.normalizeMatchTime(value);
    const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return Number.NaN;
    const y = Number.parseInt(m[1], 10);
    const mo = Number.parseInt(m[2], 10);
    const d = Number.parseInt(m[3], 10);
    const hh = Number.parseInt(m[4], 10);
    const mm = Number.parseInt(m[5], 10);
    const ss = Number.parseInt(m[6] || '0', 10);
    const ts = new Date(y, mo - 1, d, hh, mm, ss, 0).getTime();
    return Number.isFinite(ts) ? ts : Number.NaN;
  }

  private static is365RowNotStarted(row: Rich365CrownRow, nowMs = Date.now()) {
    const candidateTime = this.normalize365MatchTime(row.matchTime, undefined, row.sourceDate);
    const kickoffMs = this.parseLocalDateTimeToMs(candidateTime);
    if (!Number.isFinite(kickoffMs)) return true;
    return kickoffMs > nowMs;
  }

  private static pickRich365BaseDate(baseMatches: ExternalMatch[]) {
    const counter = new Map<string, number>();
    for (const match of baseMatches) {
      const date = this.normalizeMatchTime(match.matchTime).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      counter.set(date, (counter.get(date) || 0) + 1);
    }
    let bestDate = '';
    let bestCount = -1;
    for (const [date, count] of counter.entries()) {
      if (count > bestCount || (count === bestCount && date < bestDate)) {
        bestDate = date;
        bestCount = count;
      }
    }
    if (bestDate) return bestDate;
    return this.normalizeMatchTime(new Date().toISOString().slice(0, 19).replace('T', ' ')).slice(0, 10);
  }

  private static shiftYmdDate(dateText: string, deltaDays: number) {
    const m = String(dateText || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(date.getTime())) return '';
    date.setDate(date.getDate() + deltaDays);
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }

  private static get365MatcherConfig(): Rich365MatcherConfig {
    const adminId = this.getAdminUserId();
    if (!adminId) return { ...DEFAULT_365_MATCHER_CONFIG };
    const keys = [
      'matcher_enabled',
      'matcher_time_tolerance_minutes',
      'matcher_auto_threshold',
      'matcher_review_threshold',
      'matcher_alias_score',
      'matcher_time_score',
      'matcher_league_score',
      'matcher_asian_score',
      'matcher_ou_score',
      'matcher_asian_line_tolerance',
      'matcher_water_tolerance',
      'matcher_ou_line_tolerance',
      'matcher_ou_water_tolerance',
    ];
    const placeholders = keys.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT key, value FROM system_settings WHERE user_id = ? AND key IN (${placeholders})`)
      .all(adminId, ...keys) as Array<{ key: string; value: string }>;
    const map = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    const toNum = (key: string, fallback: number, min: number, max: number) => {
      const n = Number.parseFloat(String(map[key] ?? fallback));
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    };
    const cfg: Rich365MatcherConfig = {
      enabled: String(map.matcher_enabled ?? 'true').trim().toLowerCase() !== 'false',
      timeToleranceMinutes: toNum('matcher_time_tolerance_minutes', DEFAULT_365_MATCHER_CONFIG.timeToleranceMinutes, 15, 360),
      autoThreshold: toNum('matcher_auto_threshold', DEFAULT_365_MATCHER_CONFIG.autoThreshold, 0.5, 0.99),
      reviewThreshold: toNum('matcher_review_threshold', DEFAULT_365_MATCHER_CONFIG.reviewThreshold, 0.3, 0.95),
      aliasWeight: toNum('matcher_alias_score', DEFAULT_365_MATCHER_CONFIG.aliasWeight, 0, 1),
      timeWeight: toNum('matcher_time_score', DEFAULT_365_MATCHER_CONFIG.timeWeight, 0, 1),
      leagueWeight: toNum('matcher_league_score', DEFAULT_365_MATCHER_CONFIG.leagueWeight, 0, 1),
      asianWeight: toNum('matcher_asian_score', DEFAULT_365_MATCHER_CONFIG.asianWeight, 0, 1),
      ouWeight: toNum('matcher_ou_score', DEFAULT_365_MATCHER_CONFIG.ouWeight, 0, 1),
      asianLineTolerance: toNum('matcher_asian_line_tolerance', DEFAULT_365_MATCHER_CONFIG.asianLineTolerance, 0.05, 2),
      waterTolerance: toNum('matcher_water_tolerance', DEFAULT_365_MATCHER_CONFIG.waterTolerance, 0.03, 1),
      ouLineTolerance: toNum('matcher_ou_line_tolerance', DEFAULT_365_MATCHER_CONFIG.ouLineTolerance, 0.05, 2),
      ouWaterTolerance: toNum('matcher_ou_water_tolerance', DEFAULT_365_MATCHER_CONFIG.ouWaterTolerance, 0.03, 1),
    };
    if (cfg.reviewThreshold > cfg.autoThreshold) {
      cfg.reviewThreshold = Math.max(0.3, Math.min(cfg.autoThreshold, 0.95));
    }
    return cfg;
  }

  private static getRich365AliasScore(match: ExternalMatch, row: Rich365CrownRow) {
    const homeExact = this.normalizeNameForMatch(match.homeTeam) === this.normalizeNameForMatch(row.homeTeam);
    const awayExact = this.normalizeNameForMatch(match.awayTeam) === this.normalizeNameForMatch(row.awayTeam);
    const homeLoose = this.teamNameLikelySame(match.homeTeam, row.homeTeam);
    const awayLoose = this.teamNameLikelySame(match.awayTeam, row.awayTeam);
    const scoreSide = (exact: boolean, loose: boolean) => (exact ? 1 : loose ? 0.6 : 0);
    return (scoreSide(homeExact, homeLoose) + scoreSide(awayExact, awayLoose)) / 2;
  }

  private static getRich365LeagueScore(match: ExternalMatch, row: Rich365CrownRow) {
    const a = this.normalizeNameForMatch(match.league);
    const b = this.normalizeNameForMatch(row.league);
    if (!a || !b) return 0.5;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.6;
    return 0;
  }

  private static getRich365TimeScore(match: ExternalMatch, row: Rich365CrownRow, cfg: Rich365MatcherConfig) {
    const candidateTime = this.normalize365MatchTime(row.matchTime, match.matchTime, row.sourceDate);
    const diff = this.getMatchMinuteDiff(match.matchTime, candidateTime);
    if (!Number.isFinite(diff)) return { score: 0, diffMinutes: Number.POSITIVE_INFINITY };
    if (diff > cfg.timeToleranceMinutes) return { score: 0, diffMinutes: diff };
    return { score: Math.max(0, 1 - diff / cfg.timeToleranceMinutes), diffMinutes: diff };
  }

  private static getRich365AsianScore(match: ExternalMatch, row: Rich365CrownRow, cfg: Rich365MatcherConfig) {
    const base = this.getValidCrownHandicaps(this.buildHandicaps(match), match)[0];
    const line = this.resolveHandicapType(String(row.handicap?.line || ''), match) || this.normalizeSignedHandicap(String(row.handicap?.line || ''));
    const homeOdds = Number(row.handicap?.homeOdds || 0);
    const awayOdds = Number(row.handicap?.awayOdds || 0);
    if (!base) return 0.5;
    if (!line || !(homeOdds > 0) || !(awayOdds > 0)) return 0.4;
    const baseLine = this.resolveHandicapType(base.type, match) || base.type;
    const lineDiff = Math.abs(this.getHandicapSortValue(baseLine) - this.getHandicapSortValue(line));
    const lineScore = lineDiff <= cfg.asianLineTolerance ? Math.max(0, 1 - lineDiff / cfg.asianLineTolerance) : 0;
    const waterDiff = Math.max(Math.abs(base.home_odds - homeOdds), Math.abs(base.away_odds - awayOdds));
    const waterScore = waterDiff <= cfg.waterTolerance ? Math.max(0, 1 - waterDiff / cfg.waterTolerance) : 0;
    return lineScore * 0.7 + waterScore * 0.3;
  }

  private static getRich365OuScore(match: ExternalMatch, row: Rich365CrownRow, cfg: Rich365MatcherConfig) {
    const base = this.getValidOverUnderOdds(match.crownOverUnderOdds || [])[0];
    const line = this.normalizeOuLine(row.overUnder?.line);
    const overOdds = Number(row.overUnder?.overOdds || 0);
    const underOdds = Number(row.overUnder?.underOdds || 0);
    if (!base) return 0.5;
    if (!line || !(overOdds > 0) || !(underOdds > 0)) return 0.4;
    const lineDiff = Math.abs(this.parseOuLineSortValue(base.line) - this.parseOuLineSortValue(line));
    const lineScore = lineDiff <= cfg.ouLineTolerance ? Math.max(0, 1 - lineDiff / cfg.ouLineTolerance) : 0;
    const waterDiff = Math.max(Math.abs(base.over_odds - overOdds), Math.abs(base.under_odds - underOdds));
    const waterScore = waterDiff <= cfg.ouWaterTolerance ? Math.max(0, 1 - waterDiff / cfg.ouWaterTolerance) : 0;
    return lineScore * 0.7 + waterScore * 0.3;
  }

  private static scoreRich365Candidate(match: ExternalMatch, row: Rich365CrownRow, cfg: Rich365MatcherConfig): Rich365MatchScoreDetail {
    const aliasScore = this.getRich365AliasScore(match, row);
    const { score: timeScore, diffMinutes: timeDiffMinutes } = this.getRich365TimeScore(match, row, cfg);
    const leagueScore = this.getRich365LeagueScore(match, row);
    const asianScore = this.getRich365AsianScore(match, row, cfg);
    const ouScore = this.getRich365OuScore(match, row, cfg);
    const weightSum = Math.max(0.0001, cfg.aliasWeight + cfg.timeWeight + cfg.leagueWeight + cfg.asianWeight + cfg.ouWeight);
    const totalScore =
      (aliasScore * cfg.aliasWeight +
        timeScore * cfg.timeWeight +
        leagueScore * cfg.leagueWeight +
        asianScore * cfg.asianWeight +
        ouScore * cfg.ouWeight) /
      weightSum;
    const hitRules: string[] = [];
    if (aliasScore >= 0.99) hitRules.push('alias_exact');
    else if (aliasScore >= 0.6) hitRules.push('alias_loose');
    if (Number.isFinite(timeDiffMinutes) && timeDiffMinutes <= cfg.timeToleranceMinutes) hitRules.push('time_window');
    if (leagueScore > 0) hitRules.push('league_hint');
    if (asianScore >= 0.5) hitRules.push('asian_fingerprint');
    if (ouScore >= 0.5) hitRules.push('ou_fingerprint');
    return {
      aliasScore,
      timeScore,
      leagueScore,
      asianScore,
      ouScore,
      totalScore: Math.max(0, Math.min(1, totalScore)),
      timeDiffMinutes,
      hitRules,
    };
  }

  private static pickBest365RowByScore(match: ExternalMatch, rows: Rich365CrownRow[], cfg: Rich365MatcherConfig) {
    let best: { row: Rich365CrownRow; detail: Rich365MatchScoreDetail } | null = null;
    for (const row of rows) {
      const detail = this.scoreRich365Candidate(match, row, cfg);
      if (
        !best ||
        detail.totalScore > best.detail.totalScore ||
        (Math.abs(detail.totalScore - best.detail.totalScore) < 1e-9 && detail.timeDiffMinutes < best.detail.timeDiffMinutes)
      ) {
        best = { row, detail };
      }
    }
    return best;
  }

  private static pickBest365Row(match: ExternalMatch, rows: Rich365CrownRow[]) {
    if (rows.length === 0) return null;
    const baseTimeMs = this.parseMatchTimeToMs(match.matchTime);
    let best: { row: Rich365CrownRow; diff: number } | null = null;
    for (const row of rows) {
      const candidateTime = this.normalize365MatchTime(row.matchTime, match.matchTime, row.sourceDate);
      const candidateMs = this.parseMatchTimeToMs(candidateTime);
      const diff = Number.isFinite(baseTimeMs) && Number.isFinite(candidateMs) ? Math.abs(baseTimeMs - candidateMs) : Number.MAX_SAFE_INTEGER;
      if (!best || diff < best.diff) {
        best = { row, diff };
      }
    }
    return best?.row || rows[0];
  }

  private static async enrichWith365RichCrownFallback(baseMatches: ExternalMatch[]) {
    if (baseMatches.length === 0) return baseMatches;
    try {
      const ouMissingTargets = baseMatches.filter((match) => this.getValidOverUnderOdds(match.crownOverUnderOdds || []).length === 0);
      if (ouMissingTargets.length === 0) return baseMatches;
      const matcherCfg = this.get365MatcherConfig();
      if (!matcherCfg.enabled) return baseMatches;
      const baseDates = Array.from(
        new Set(
          baseMatches
            .map((match) => this.normalizeMatchTime(match.matchTime).slice(0, 10))
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      )
        .sort()
        .slice(0, 7);
      const fetchRowsForDates = async (dates: string[], timeoutLabel: string) => {
        const merged = new Map<string, Rich365CrownRow>();
        for (const date of dates) {
          const rows = await this.withTimeout(
            this.fetch365RichCrownRows(date),
            PLAYWRIGHT_365RICH_PATCH_TIMEOUT_MS,
            timeoutLabel
          );
          for (const row of Array.isArray(rows) ? rows : []) {
            const key =
              String(row.sourceMatchId || '').trim() ||
              `${String(row.sourceDate || '').trim()}|${String(row.matchTime || '').trim()}|${this.normalizeMatchPair(row.homeTeam, row.awayTeam)}`;
            if (!key) continue;
            if (!merged.has(key)) merged.set(key, row);
          }
        }
        return Array.from(merged.values());
      };
      const d0TargetDates = baseDates.length > 0 ? baseDates : [this.pickRich365BaseDate(baseMatches)];
      const d0Rows = await fetchRowsForDates(d0TargetDates, 'Playwright 365rich patch timeout');
      if (!Array.isArray(d0Rows) || d0Rows.length === 0) return baseMatches;

      const chosenByMatchId = new Map<string, { row: Rich365CrownRow; detail: Rich365MatchScoreDetail; stage: 'd0' | 'd1' }>();
      const rejectedByMatchId = new Map<string, 'review' | 'reject'>();
      const detailIds = new Set<string>();
      const targetedRuleMap = this.getTargeted365RuleMap();
      const targetedRuleByMatchId = new Map<string, Targeted365Rule>();
      const targetedDetailIds = new Set<string>();
      const applyRows = (rows: Rich365CrownRow[], targets: ExternalMatch[], stage: 'd0' | 'd1') => {
        const byPair = new Map<string, Rich365CrownRow[]>();
        for (const row of rows) {
          const key = this.normalizeMatchPair(row.homeTeam, row.awayTeam);
          if (!key || key === '|') continue;
          if (!byPair.has(key)) byPair.set(key, []);
          byPair.get(key)!.push(row);
        }
        if (byPair.size === 0) {
          return { auto: 0, review: 0, reject: 0 };
        }
        let auto = 0;
        let review = 0;
        let reject = 0;
        for (const match of targets) {
          const key = this.normalizeMatchPair(match.homeTeam, match.awayTeam);
          const strictCandidates = byPair.get(key) || [];
          const looseCandidates =
            strictCandidates.length > 0
              ? strictCandidates
              : rows
                  .filter(
                    (row) =>
                      this.teamNameLikelySame(row.homeTeam, match.homeTeam) &&
                      this.teamNameLikelySame(row.awayTeam, match.awayTeam)
                  )
                  .slice(0, 30);
          const timeWindowCandidates =
            strictCandidates.length > 0 || looseCandidates.length > 0
              ? []
              : rows
                  .filter((row) => {
                    const rowTime = this.normalize365MatchTime(row.matchTime, match.matchTime, row.sourceDate);
                    const diff = this.getMatchMinuteDiff(match.matchTime, rowTime);
                    if (!Number.isFinite(diff) || diff > matcherCfg.timeToleranceMinutes) return false;
                    const matchDate = this.normalizeMatchTime(match.matchTime).slice(0, 10);
                    const rowDate = String(row.sourceDate || '').trim() || rowTime.slice(0, 10);
                    return Boolean(matchDate && rowDate && matchDate === rowDate);
                  })
                  .slice(0, 40);
          const sameDayCandidates =
            strictCandidates.length > 0 || looseCandidates.length > 0 || timeWindowCandidates.length > 0
              ? []
              : rows
                  .filter((row) => {
                    const rowTime = this.normalize365MatchTime(row.matchTime, match.matchTime, row.sourceDate);
                    const matchDate = this.normalizeMatchTime(match.matchTime).slice(0, 10);
                    const rowDate = String(row.sourceDate || '').trim() || rowTime.slice(0, 10);
                    return Boolean(matchDate && rowDate && matchDate === rowDate);
                  })
                  .slice(0, 60);
          const candidates =
            strictCandidates.length > 0
              ? strictCandidates
              : looseCandidates.length > 0
                ? looseCandidates
                : timeWindowCandidates.length > 0
                  ? timeWindowCandidates
                  : sameDayCandidates.length > 0
                    ? sameDayCandidates
                    : rows.slice(0, 80);
          if (candidates.length === 0) continue;
          const ranked = this.pickBest365RowByScore(match, candidates, matcherCfg);
          if (!ranked) continue;
          let decision: 'auto' | 'review' | 'reject' =
            ranked.detail.totalScore >= matcherCfg.autoThreshold
              ? 'auto'
              : ranked.detail.totalScore >= matcherCfg.reviewThreshold
                ? 'review'
                : 'reject';
          // 受控放宽：当时间/联赛强匹配时，允许略低于默认阈值进入自动补强，避免 OU 长期补不上。
          if (decision === 'reject') {
            const relaxedByAlias =
              ranked.detail.aliasScore >= 0.6 &&
              ranked.detail.timeScore >= 0.8 &&
              ranked.detail.totalScore >= 0.5;
            const relaxedByTimeLeague =
              ranked.detail.timeScore >= 0.95 &&
              ranked.detail.leagueScore >= 0.6 &&
              ranked.detail.totalScore >= 0.45;
            if (relaxedByAlias || relaxedByTimeLeague) {
              decision = 'auto';
            }
          }
          if (decision === 'review') {
            review += 1;
            rejectedByMatchId.set(match.id, 'review');
            continue;
          }
          if (decision === 'reject') {
            reject += 1;
            rejectedByMatchId.set(match.id, 'reject');
            continue;
          }
          auto += 1;
          const prev = chosenByMatchId.get(match.id);
          if (
            !prev ||
            ranked.detail.totalScore > prev.detail.totalScore ||
            (Math.abs(ranked.detail.totalScore - prev.detail.totalScore) < 1e-9 &&
              ranked.detail.timeDiffMinutes < prev.detail.timeDiffMinutes)
          ) {
            chosenByMatchId.set(match.id, { row: ranked.row, detail: ranked.detail, stage });
          }
          const existingOu = this.getValidOverUnderOdds(match.crownOverUnderOdds || []);
          const needsMoreData = existingOu.length === 0;
          if (needsMoreData && /^\d+$/.test(String(ranked.row.sourceMatchId || '').trim())) {
            detailIds.add(String(ranked.row.sourceMatchId).trim());
          }
        }
        return { auto, review, reject };
      };

      const d0Result = applyRows(d0Rows, ouMissingTargets, 'd0');
      const unresolvedMatches = ouMissingTargets.filter((match) => !chosenByMatchId.has(match.id));
      let d1Result = { auto: 0, review: 0, reject: 0 };
      const d1TargetDates = Array.from(
        new Set(d0TargetDates.map((d) => this.shiftYmdDate(d, 1)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))
      );
      if (unresolvedMatches.length > 0 && d1TargetDates.length > 0) {
        const d1Rows = await fetchRowsForDates(d1TargetDates, 'Playwright 365rich D+1 patch timeout');
        if (Array.isArray(d1Rows) && d1Rows.length > 0) {
          d1Result = applyRows(d1Rows, unresolvedMatches, 'd1');
        }
      }

      for (const match of ouMissingTargets) {
        const rule = this.getTargeted365RuleForMatch(match, targetedRuleMap);
        if (!rule) continue;
        targetedRuleByMatchId.set(match.id, rule);
        if (/^\d+$/.test(String(rule.scheduleId || '').trim())) {
          targetedDetailIds.add(String(rule.scheduleId).trim());
        }
      }
      console.log(`365rich targeted-detail candidates=${targetedRuleByMatchId.size}`);

      const autoCount = chosenByMatchId.size;
      const reviewCount = Array.from(rejectedByMatchId.values()).filter((x) => x === 'review').length;
      const rejectCount = Array.from(rejectedByMatchId.values()).filter((x) => x === 'reject').length;
      this.lastFetchMeta.rich365_match_auto_count = autoCount;
      this.lastFetchMeta.rich365_match_review_count = reviewCount;
      this.lastFetchMeta.rich365_match_reject_count = rejectCount;
      this.lastFetchMeta.rich365_d0_match_count = d0Result.auto;
      this.lastFetchMeta.rich365_d1_match_count = d1Result.auto;

      const detailIdList = Array.from(new Set([...targetedDetailIds, ...detailIds])).slice(0, 40);
      const detailMap = detailIdList.length
        ? await this.withTimeout(
            this.fetch365RichCrownDetails(detailIdList),
            PLAYWRIGHT_365RICH_PATCH_TIMEOUT_MS,
            'Playwright 365rich detail timeout'
          )
        : {};

      let targetedHit = 0;
      let targetedMiss = 0;
      for (const [matchId, rule] of targetedRuleByMatchId.entries()) {
        const detail = detailMap[String(rule.scheduleId || '').trim()] || {};
        const ouCount = this.getValidOverUnderOdds(detail.overUnderOdds || []).length;
        if (ouCount > 0) targetedHit += 1;
        else targetedMiss += 1;
        console.log(`365rich targeted-detail ${matchId} -> ${rule.scheduleId} ou_count=${ouCount}`);
      }
      if (targetedRuleByMatchId.size > 0) {
        console.log(`365rich targeted-detail hit=${targetedHit} miss=${targetedMiss}`);
      }

      let enrichedCount = 0;
      const merged = baseMatches.map((match) => {
        const chosenEntry = chosenByMatchId.get(match.id);
        const targetedRule = targetedRuleByMatchId.get(match.id) || null;
        if (!chosenEntry && !targetedRule) return match;
        const chosen = chosenEntry?.row;
        const detail = chosen ? detailMap[String(chosen.sourceMatchId || '').trim()] || {} : {};
        const targetedDetail = targetedRule ? detailMap[String(targetedRule.scheduleId || '').trim()] || {} : {};
        // 365rich 让球方向与本系统口径相反，入库前统一翻转一次。
        const existingOu = this.getValidOverUnderOdds(match.crownOverUnderOdds || []);
        const nextOu = [...existingOu];

        const targetedOu = this.getValidOverUnderOdds(targetedDetail.overUnderOdds || []);
        if (targetedOu.length > 0) {
          nextOu.push(...targetedOu);
        } else {
          const detailOu = this.getValidOverUnderOdds(detail.overUnderOdds || []);
          if (detailOu.length > 0) {
            nextOu.push(...detailOu);
          } else if (chosen) {
            const fallbackOu = this.getValidOverUnderOdds(chosen.overUnderOdds || []);
            if (fallbackOu.length > 0) {
              nextOu.push(...fallbackOu);
            } else {
              const ouLine = this.normalizeOuLine(chosen.overUnder?.line);
              const overOdds = Number(chosen.overUnder?.overOdds || 0);
              const underOdds = Number(chosen.overUnder?.underOdds || 0);
              if (ouLine && overOdds > 0 && underOdds > 0) {
                nextOu.push({ line: ouLine, over_odds: overOdds, under_odds: underOdds });
              }
            }
          }
        }

        const normalizedOu = this.getValidOverUnderOdds(nextOu);
        const changed = JSON.stringify(normalizedOu) !== JSON.stringify(existingOu);
        if (!changed) return match;
        enrichedCount += 1;
        return {
          ...match,
          crownOverUnderOdds: normalizedOu.length > 0 ? normalizedOu : match.crownOverUnderOdds,
        };
      });

      if (enrichedCount > 0) {
        this.lastFetchMeta.playwright_fallback_used = true;
      }
      this.lastFetchMeta.rich365_ou_fallback_hit_count = enrichedCount;
      console.log(`rich365 ou fallback matched ${enrichedCount}/${ouMissingTargets.length}`);
      console.log(
        `365rich crown patch enriched ${enrichedCount}/${baseMatches.length} matches (D0 auto=${d0Result.auto}, D+1 auto=${d1Result.auto}, final auto=${autoCount}, review=${reviewCount}, reject=${rejectCount})`
      );
      return merged;
    } catch (err: any) {
      console.warn(`365rich crown patch skipped: ${err?.message || err}`);
      return baseMatches;
    }
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
        homeTeam: base.homeTeam,
        awayTeam: base.awayTeam,
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

  private static async tryPlaywrightCrownPatch(baseMatches: ExternalMatch[], reason: string): Promise<ExternalMatch[]> {
    const targets = baseMatches.filter((match) => this.buildHandicaps(match).length < REQUIRED_CROWN_HANDICAP_COUNT).slice(0, 12);
    if (targets.length === 0) return baseMatches;
    try {
      const dates = Array.from(new Set(targets.map((match) => this.normalizeMatchTime(match.matchTime).slice(0, 10)).filter(Boolean)));
      if (dates.length === 0) return baseMatches;
      const pwRows = await this.withTimeout(
        this.fetchPlaywrightMatchesForDates(dates),
        PLAYWRIGHT_CROWN_PATCH_TIMEOUT_MS,
        'Playwright crown patch timeout'
      );
      if (!Array.isArray(pwRows) || pwRows.length === 0) return baseMatches;
      const byPair = new Map<string, ExternalMatch[]>();
      for (const row of pwRows) {
        const key = `${this.normalizeNameForMatch(row.homeTeam)}|${this.normalizeNameForMatch(row.awayTeam)}`;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key)!.push(row);
      }
      for (const list of byPair.values()) {
        list.sort((a, b) => this.normalizeMatchTime(a.matchTime).localeCompare(this.normalizeMatchTime(b.matchTime)));
      }
      let enriched = 0;
      const merged = baseMatches.map((base) => {
        if (this.buildHandicaps(base).length >= REQUIRED_CROWN_HANDICAP_COUNT) return base;
        const key = `${this.normalizeNameForMatch(base.homeTeam)}|${this.normalizeNameForMatch(base.awayTeam)}`;
        const candidates = byPair.get(key) || [];
        const chosen =
          candidates.find((row) => this.normalizeMatchTime(row.matchTime).slice(0, 16) === this.normalizeMatchTime(base.matchTime).slice(0, 16)) ||
          candidates.find((row) => this.normalizeMatchTime(row.matchTime).slice(0, 10) === this.normalizeMatchTime(base.matchTime).slice(0, 10)) ||
          null;
        if (!chosen) return base;
        const mergedHandicaps = this.getValidCrownHandicaps([
          ...this.getValidCrownHandicaps(base.crownHandicaps || []),
          ...this.getValidCrownHandicaps(chosen.crownHandicaps || []),
          ...this.buildHandicaps(base),
          ...this.buildHandicaps(chosen),
        ]);
        const patched: ExternalMatch = {
          ...base,
          homeTeam: base.homeTeam,
          awayTeam: base.awayTeam,
          crownOdds: this.isValidExternalOdds(base.crownOdds)
            ? base.crownOdds
            : chosen.crownOdds || base.crownOdds,
          crownAsia:
            this.parseOdds(base.crownAsia?.homeWater) > 0 && this.parseOdds(base.crownAsia?.awayWater) > 0
              ? base.crownAsia
              : chosen.crownAsia || base.crownAsia,
          crownHandicaps: mergedHandicaps,
        };
        if ((patched.crownHandicaps || []).length > this.buildHandicaps(base).length) {
          enriched += 1;
        }
        return patched;
      });
      if (enriched > 0) {
        this.lastFetchMeta.playwright_fallback_used = true;
        console.log(`Playwright crown patch enriched ${enriched}/${targets.length} matches (reason=${reason})`);
      }
      return merged;
    } catch (err: any) {
      console.warn(`Playwright crown patch skipped: ${err?.message || err}`);
      return baseMatches;
    }
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

  private static parseSportteryRows(body: string) {
    try {
      const parsed = JSON.parse(String(body || ''));
      const matchInfoList = Array.isArray(parsed?.value?.matchInfoList) ? parsed.value.matchInfoList : [];
      return matchInfoList.flatMap((day: any) => (Array.isArray(day?.subMatchList) ? day.subMatchList : []));
    } catch {
      return [] as any[];
    }
  }

  private static buildSportteryGoalOddsFromTtg(ttg: any) {
    return this.getValidGoalOdds([
      { label: '0球', odds: Number(ttg?.s0 || 0) },
      { label: '1球', odds: Number(ttg?.s1 || 0) },
      { label: '2球', odds: Number(ttg?.s2 || 0) },
      { label: '3球', odds: Number(ttg?.s3 || 0) },
      { label: '4球', odds: Number(ttg?.s4 || 0) },
      { label: '5球', odds: Number(ttg?.s5 || 0) },
      { label: '6球', odds: Number(ttg?.s6 || 0) },
      { label: '7+球', odds: Number(ttg?.s7 || 0) },
    ]);
  }

  private static async fetchSportteryAsPrimaryMatches(): Promise<ExternalMatch[]> {
    const [hadBody, hhadBody, ttgBody] = await Promise.all([
      this.fetchTextWithCheck(SPORTTERY_HAD_URL),
      this.fetchTextWithCheck(SPORTTERY_HHAD_URL),
      this.fetchTextWithCheck(SPORTTERY_TTG_URL),
    ]);

    const hadRows = this.parseSportteryRows(hadBody);
    const hhadRows = this.parseSportteryRows(hhadBody);
    const ttgRows = this.parseSportteryRows(ttgBody);

    const hhadByExact = new Map<string, { odds: ExternalOdds; handicapLine: string }>();
    const hhadByFallback = new Map<string, { odds: ExternalOdds; handicapLine: string }>();
    for (const item of hhadRows) {
      const matchDate = String(item?.matchDate || '').trim();
      const matchNum = String(item?.matchNum || '').trim();
      const matchTime = String(item?.matchTime || '').trim();
      const homeTeam = String(item?.homeTeamAbbName || item?.homeTeamAllName || '').trim();
      const awayTeam = String(item?.awayTeamAbbName || item?.awayTeamAllName || '').trim();
      const odds = this.parseSportteryOdds(item?.hhad);
      const rawLine = String(item?.hhad?.goalLineValue || item?.hhad?.goalLine || '').trim();
      const handicapLine = this.normalizeSignedHandicap(rawLine) || rawLine;
      if (!matchDate || !matchNum || !odds || !handicapLine) continue;
      const payload = { odds, handicapLine };
      const exactKey = `${matchDate}|${matchNum}`;
      hhadByExact.set(exactKey, payload);
      const fallbackKey = this.buildSportteryFallbackKey(`${matchDate} ${matchTime || '00:00:00'}`, homeTeam, awayTeam);
      if (fallbackKey) hhadByFallback.set(fallbackKey, payload);
    }

    const ttgByExact = new Map<string, ExternalGoalOdds[]>();
    const ttgByFallback = new Map<string, ExternalGoalOdds[]>();
    for (const item of ttgRows) {
      const matchDate = String(item?.matchDate || '').trim();
      const matchNum = String(item?.matchNum || '').trim();
      const matchTime = String(item?.matchTime || '').trim();
      const homeTeam = String(item?.homeTeamAbbName || item?.homeTeamAllName || '').trim();
      const awayTeam = String(item?.awayTeamAbbName || item?.awayTeamAllName || '').trim();
      const goalOdds = this.buildSportteryGoalOddsFromTtg(item?.ttg);
      if (!matchDate || !matchNum || goalOdds.length === 0) continue;
      const exactKey = `${matchDate}|${matchNum}`;
      ttgByExact.set(exactKey, goalOdds);
      const fallbackKey = this.buildSportteryTtgFallbackKey(`${matchDate} ${matchTime || '00:00:00'}`, homeTeam, awayTeam);
      if (fallbackKey) ttgByFallback.set(fallbackKey, goalOdds);
    }

    const out = new Map<string, ExternalMatch>();
    const upsertFromRow = (item: any) => {
      const matchDate = String(item?.matchDate || '').trim();
      const matchNum = String(item?.matchNum || '').trim();
      const matchTime = String(item?.matchTime || '').trim();
      const league = String(item?.leagueAbbName || item?.leagueAllName || '').trim();
      const homeTeam = String(item?.homeTeamAbbName || item?.homeTeamAllName || '').trim();
      const awayTeam = String(item?.awayTeamAbbName || item?.awayTeamAllName || '').trim();
      if (!matchDate || !matchNum || !homeTeam || !awayTeam) return;
      const id = `${matchDate}|${matchNum}`;
      const fallbackKey = this.buildSportteryFallbackKey(`${matchDate} ${matchTime || '00:00:00'}`, homeTeam, awayTeam);
      const hadOdds = this.parseSportteryOdds(item?.had);
      const hhad = hhadByExact.get(id) || (fallbackKey ? hhadByFallback.get(fallbackKey) : undefined);
      const goalOdds = ttgByExact.get(id) || (fallbackKey ? ttgByFallback.get(fallbackKey) : undefined) || [];
      const handicapLine = hhad?.handicapLine || '-';
      const regularHandicap = this.normalizeNumericHandicap(handicapLine) || '0';
      out.set(id, {
        id,
        league,
        round: matchNum,
        matchTime: this.normalizeMatchTime(`${matchDate} ${matchTime || '00:00:00'}`),
        homeTeam,
        awayTeam,
        handicap: regularHandicap,
        jingcaiHandicap: handicapLine,
        jingcaiOdds: hadOdds || { win: '-', draw: '-', lose: '-' },
        jingcaiHandicapOdds: hhad?.odds || { win: '-', draw: '-', lose: '-' },
        crownOdds: { win: '-', draw: '-', lose: '-' },
        crownGoalOdds: goalOdds,
        crownAsia: { handicap: '-', homeWater: '-', awayWater: '-' },
      });
    };

    for (const item of hadRows) upsertFromRow(item);
    for (const item of hhadRows) {
      const id = `${String(item?.matchDate || '').trim()}|${String(item?.matchNum || '').trim()}`;
      if (!out.has(id)) upsertFromRow(item);
    }
    for (const item of ttgRows) {
      const id = `${String(item?.matchDate || '').trim()}|${String(item?.matchNum || '').trim()}`;
      if (!out.has(id)) upsertFromRow(item);
    }

    const rows = Array.from(out.values());
    console.log(`Sporttery primary source built ${rows.length} matches`);
    return rows;
  }

  private static async enrichWithLive500CrownOdds(baseMatches: ExternalMatch[]) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    try {
      const dates = Array.from(
        new Set(
          baseMatches
            .map((row) => String(row.id || '').split('|')[0] || this.normalizeMatchTime(row.matchTime).slice(0, 10))
            .filter(Boolean)
        )
      );
      const crownMap = await this.fetchLive500CrownOddsMapFromZqdc(dates);
      let zqdcHit = 0;
      const merged = baseMatches.map((row) => {
        const exact = crownMap.byExact.get(String(row.id || '').trim());
        const byRound = crownMap.byMatchnum.get(String(row.round || '').trim());
        const odds = exact || byRound;
        if (!this.isValidExternalOdds(odds)) return row;
        zqdcHit += 1;
        return { ...row, crownOdds: odds };
      });

      const unresolvedCount = merged.filter((row) => !this.isValidExternalOdds(row.crownOdds)).length;
      let fallbackHit = 0;
      let mergedWithFallback = merged;

      // 无缺口时直接返回，确保不会触发 live.500 兜底请求。
      if (unresolvedCount <= 0) {
        if (zqdcHit > 0) {
          console.log(`live.500 zqdc crown odds matched ${zqdcHit}/${baseMatches.length} matches (zqdc=${zqdcHit}, fallback=0)`);
        }
        return merged;
      }

      // 仅在 zqdc 主抓存在缺口时，才执行 live.500 二级兜底。
      if (unresolvedCount > 0) {
        try {
          const crownFallbackMap = await this.fetchLive500CrownOddsMap(dates);
          mergedWithFallback = merged.map((row) => {
            if (this.isValidExternalOdds(row.crownOdds)) return row;
            const fallbackExact = crownFallbackMap.get(String(row.id || '').trim());
            const fallbackByRound = crownFallbackMap.get(String(row.round || '').trim());
            const fallbackByPair = crownFallbackMap.get(this.buildLive500TeamPairKey(row.matchTime, row.homeTeam, row.awayTeam));
            const fallbackOdds = fallbackExact || fallbackByRound || fallbackByPair;
            if (!this.isValidExternalOdds(fallbackOdds)) return row;
            fallbackHit += 1;
            return { ...row, crownOdds: fallbackOdds };
          });
        } catch (err: any) {
          console.warn(`live.500 crown fallback map fetch failed, keep zqdc result only: ${err?.message || err}`);
        }
      }

      const totalHit = zqdcHit + fallbackHit;
      if (totalHit > 0) {
        console.log(`live.500 zqdc crown odds matched ${totalHit}/${baseMatches.length} matches (zqdc=${zqdcHit}, fallback=${fallbackHit})`);
      }
      return mergedWithFallback;
    } catch (err: any) {
      console.warn(`live.500 zqdc crown odds fetch failed, keep current values: ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static async fetchLive500CrownOddsMapFromZqdc(dates: string[]): Promise<Live500CrownOddsMap> {
    const byExact = new Map<string, ExternalOdds>();
    const byMatchnum = new Map<string, ExternalOdds>();
    const pending: Array<{ key: string; matchnum: string; fid: string }> = [];
    for (const date of dates) {
      if (!date) continue;
      const zqdcDateParam = this.formatLive500ZqdcDateParam(date);
      const html = await this.fetchTextWithCheck(`${LIVE500_ZQDC_URL}?e=${zqdcDateParam}`, 'gb18030');
      const $ = load(html);
      $('tr[data-processname]').each((_, element) => {
        const processName = String($(element).attr('data-processname') || '').trim();
        const processDate = String($(element).attr('data-processdate') || $(element).attr('data-matchdate') || date).trim();
        const fid = String($(element).attr('fid') || $(element).attr('data-fixtureid') || '').trim();
        if (!processName || !processDate) return;
        const values = $(element)
          .find('td.bf_op span')
          .map((__, span) => String($(span).text() || '').trim())
          .get()
          .filter(Boolean);
        if (values.length < 3) {
          if (fid) pending.push({ key: `${processDate}|${processName}`, matchnum: processName, fid });
          return;
        }
        const odds: ExternalOdds = {
          win: values[0],
          draw: values[1],
          lose: values[2],
        };
        if (!this.isValidExternalOdds(odds)) {
          if (fid) pending.push({ key: `${processDate}|${processName}`, matchnum: processName, fid });
          return;
        }
        byExact.set(`${processDate}|${processName}`, odds);
        if (!byMatchnum.has(processName)) byMatchnum.set(processName, odds);
      });
    }
    if (pending.length > 0) {
      const queue = [...pending];
      const workers = new Array(Math.min(LIVE500_CROWN_FETCH_CONCURRENCY, Math.max(1, queue.length))).fill(null).map(async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) return;
          if (byExact.has(item.key)) continue;
          try {
            const odds = await this.fetchLive500CrownOddsByFixture(item.fid);
            if (!this.isValidExternalOdds(odds)) continue;
            byExact.set(item.key, odds!);
            if (!byMatchnum.has(item.matchnum)) byMatchnum.set(item.matchnum, odds!);
          } catch {
            // ignore single fixture failure
          }
        }
      });
      await Promise.all(workers);
    }
    return { byExact, byMatchnum };
  }

  private static formatLive500ZqdcDateParam(input?: string) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (/^\d{6}$/.test(raw)) return raw;
    const normalized = this.normalizeMatchTime(raw);
    const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return raw;
    return `${m[1].slice(2)}${m[2]}${m[3]}`;
  }

  private static async enrichWithTrade500CrownHandicapFallback(baseMatches: ExternalMatch[]) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    try {
      const dates = Array.from(
        new Set(
          baseMatches
            .map((row) => String(row.id || '').split('|')[0] || this.normalizeMatchTime(row.matchTime).slice(0, 10))
            .filter(Boolean)
        )
      );
      const map = await this.fetchTrade500CrownHandicapFallbackMapFromJczq(dates);
      let hit = 0;
      const merged = baseMatches.map((row) => {
        const current = this.buildHandicaps(row);
        if (current.length >= REQUIRED_CROWN_HANDICAP_COUNT) return row;
        const fallback = map.byExact.get(String(row.id || '').trim()) || map.byMatchnum.get(String(row.round || '').trim());
        if (!fallback) return row;
        const mergedHandicaps = this.getValidCrownHandicaps([...current, fallback], row);
        if (mergedHandicaps.length <= current.length) return row;
        hit += 1;
        return { ...row, crownHandicaps: mergedHandicaps };
      });
      if (hit > 0) {
        console.log(`trade.500 jczq crown handicap fallback matched ${hit}/${baseMatches.length} matches`);
      }
      return merged;
    } catch (err: any) {
      console.warn(`trade.500 jczq crown handicap fallback failed, keep current values: ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static async fetchTrade500CrownHandicapFallbackMapFromYazhi(dates: string[]): Promise<Trade500CrownHandicapFallbackMap> {
    const byExact = new Map<string, ExternalHandicap>();
    const byMatchnum = new Map<string, ExternalHandicap>();
    const fixtureByExact = new Map<string, string>();
    const fixtureByMatchnum = new Map<string, string>();
    const normalizedDates = Array.from(new Set((dates || []).map((date) => String(date || '').trim()).filter(Boolean)));

    for (const date of normalizedDates) {
      const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?date=${date}`, 'gb18030');
      const $ = load(html);
      $('tr[data-processname]').each((_, element) => {
        const processName = String($(element).attr('data-processname') || '').trim();
        const processDate = String($(element).attr('data-processdate') || $(element).attr('data-matchdate') || date).trim();
        const fixtureId = String($(element).attr('data-fixtureid') || '').trim();
        if (!processName || !processDate || !fixtureId) return;
        const exactKey = `${processDate}|${processName}`;
        if (!fixtureByExact.has(exactKey)) fixtureByExact.set(exactKey, fixtureId);
        if (!fixtureByMatchnum.has(processName)) fixtureByMatchnum.set(processName, fixtureId);
      });
    }

    const cache = new Map<string, ExternalHandicap | null>();
    for (const [exactKey, fixtureId] of fixtureByExact.entries()) {
      const handicap = await this.fetchTrade500CrownHandicapFromYazhiFixtureWithCache(fixtureId, cache);
      if (!handicap) continue;
      byExact.set(exactKey, handicap);
      const matchnum = exactKey.split('|')[1] || '';
      if (matchnum && !byMatchnum.has(matchnum)) byMatchnum.set(matchnum, handicap);
    }

    for (const [matchnum, fixtureId] of fixtureByMatchnum.entries()) {
      if (byMatchnum.has(matchnum)) continue;
      const handicap = await this.fetchTrade500CrownHandicapFromYazhiFixtureWithCache(fixtureId, cache);
      if (!handicap) continue;
      byMatchnum.set(matchnum, handicap);
    }

    return { byExact, byMatchnum };
  }

  private static async fetchTrade500CrownHandicapFromYazhiFixtureWithCache(
    fixtureId: string,
    cache: Map<string, ExternalHandicap | null>
  ) {
    const fid = String(fixtureId || '').trim();
    if (!fid) return null;
    if (cache.has(fid)) return cache.get(fid) || null;
    try {
      const handicap = await this.fetchTrade500CrownHandicapFromYazhiFixture(fid);
      cache.set(fid, handicap || null);
      // 500 yazhi 存在轻量频控，间隔请求降低 429 触发概率。
      await this.sleep(120);
      return handicap;
    } catch (err: any) {
      console.warn(`trade.500 yazhi handicap fetch failed for fixture ${fid}: ${err?.message || err}`);
      cache.set(fid, null);
      return null;
    }
  }

  private static async fetchTrade500CrownHandicapFromYazhiFixture(fixtureId: string): Promise<ExternalHandicap | null> {
    const fid = String(fixtureId || '').trim();
    if (!fid) return null;
    const html = await this.fetchTextWithCheck(`https://odds.500.com/fenxi/yazhi-${fid}.shtml`, 'gb18030');
    const $ = load(html);
    const row =
      $(`tr#${LIVE500_CROWN_COMPANY_ID}[xls="row"]`).first().length > 0
        ? $(`tr#${LIVE500_CROWN_COMPANY_ID}[xls="row"]`).first()
        : $(`tr#${LIVE500_CROWN_COMPANY_ID}`).first();
    if (!row.length) return null;

    const cells = row
      .find('td')
      .map((_, td) => String($(td).text() || '').replace(/\s+/g, '').trim())
      .get()
      .filter(Boolean);
    if (cells.length < 6) return null;

    const parseTriplet = (homeRaw: string, lineRaw: string, awayRaw: string) => {
      const cleanedHome = String(homeRaw || '').replace(/[\u2191\u2193]/g, '').trim();
      const cleanedAway = String(awayRaw || '').replace(/[\u2191\u2193]/g, '').trim();
      const homeOdds = this.parseOdds(cleanedHome);
      const awayOdds = this.parseOdds(cleanedAway);
      const cleanedLine = String(lineRaw || '')
        .replace(/[\u2191\u2193]/g, '')
        .replace(/[\u5347\u964d]/g, '')
        .trim();
      const handicap = this.normalizeYazhiHandicap(cleanedLine);
      if (!handicap || homeOdds <= 0 || awayOdds <= 0) return null;
      return {
        type: handicap,
        home_odds: homeOdds,
        away_odds: awayOdds,
      } as ExternalHandicap;
    };

    if (cells.length >= 6) {
      const live = parseTriplet(cells[3], cells[4], cells[5]);
      if (live) return live;
    }
    if (cells.length >= 12) {
      const opening = parseTriplet(cells[9], cells[10], cells[11]);
      if (opening) return opening;
    }
    return null;
  }

  private static async enrichWithOdds500CrownMarkets(
    baseMatches: ExternalMatch[],
    options: { suppressAutoUpsert?: boolean } = {}
  ) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    try {
      const dates = Array.from(
        new Set(
          baseMatches
            .map((row) => String(row.id || '').split('|')[0] || this.normalizeMatchTime(row.matchTime).slice(0, 10))
            .filter(Boolean)
        )
      );
      const fixtureMap = await this.fetchLive500FixtureMap(dates);
      if (!options.suppressAutoUpsert) {
        this.autoUpsertAliasFromExactMatches(baseMatches, fixtureMap);
      }
      const yazhiMap = await this.fetchOdds500YazhiJczqMap(dates, fixtureMap);
      const daxiaoMap = await this.fetchOdds500DaxiaoJczqMap(dates, fixtureMap);

      let yazhiHit = 0;
      let daxiaoHit = 0;
      const merged = baseMatches.map((row) => {
        const exactKey = String(row.id || '').trim();
        const roundKey = String(row.round || '').trim();
        const pairKey = this.buildLive500TeamPairKey(row.matchTime, row.homeTeam, row.awayTeam);
        const pairDateKey = this.buildLive500TeamPairDateKey(row.matchTime, row.homeTeam, row.awayTeam);
        const yazhi =
          yazhiMap.byExact.get(exactKey) ||
          yazhiMap.byMatchnum.get(roundKey) ||
          (pairKey ? yazhiMap.byPair.get(pairKey) : undefined) ||
          (pairDateKey ? yazhiMap.byPairDate.get(pairDateKey) : undefined);
        const daxiao =
          daxiaoMap.byExact.get(exactKey) ||
          daxiaoMap.byMatchnum.get(roundKey) ||
          (pairKey ? daxiaoMap.byPair.get(pairKey) : undefined) ||
          (pairDateKey ? daxiaoMap.byPairDate.get(pairDateKey) : undefined);

        const existingH = this.getValidCrownHandicaps(this.buildHandicaps(row), row);
        const existingOu = this.getValidOverUnderOdds(row.crownOverUnderOdds || []);
        const nextH = yazhi ? this.getValidCrownHandicaps([yazhi, ...existingH], row) : existingH;
        const nextOu = daxiao ? this.getValidOverUnderOdds([daxiao, ...existingOu]) : existingOu;

        if (yazhi && JSON.stringify(nextH) !== JSON.stringify(existingH)) yazhiHit += 1;
        if (daxiao && JSON.stringify(nextOu) !== JSON.stringify(existingOu)) daxiaoHit += 1;

        if (
          JSON.stringify(nextH) === JSON.stringify(existingH) &&
          JSON.stringify(nextOu) === JSON.stringify(existingOu)
        ) {
          return row;
        }
        return {
          ...row,
          crownHandicaps: nextH,
          crownOverUnderOdds: nextOu,
        };
      });

      // Direct row fallback: use daxiao_jczq list row by date+round (e.g. 周三010 -> 3010).
      if (Array.isArray((daxiaoMap as any).listEntries) && (daxiaoMap as any).listEntries.length > 0) {
        const listEntries = (daxiaoMap as any).listEntries as Odds500DaxiaoListEntry[];
        for (const row of merged) {
          const currentOu = this.getValidOverUnderOdds(row.crownOverUnderOdds || []);
          if (currentOu.length > 0) continue;
          const rowDate = this.normalizeMatchTime(row.matchTime).slice(0, 10);
          const roundKey = String(row.round || '').trim();
          const candidate = listEntries.find((entry) => {
            if (!entry.round || entry.round !== roundKey) return false;
            const entryDate = this.normalizeMatchTime(entry.matchTime).slice(0, 10);
            if (entryDate !== rowDate) return false;
            return true;
          });
          if (!candidate) continue;
          const nextOu = this.getValidOverUnderOdds([candidate.ou]);
          if (nextOu.length === 0) continue;
          row.crownOverUnderOdds = nextOu;
          daxiaoHit += 1;
          console.warn(
            `[odds500-daxiao-direct-row] matched by date+round: ${row.id} <= ${candidate.round || '-'} ${candidate.homeTeam} vs ${candidate.awayTeam} (${candidate.ou.over_odds}/${candidate.ou.line}/${candidate.ou.under_odds})`
          );
        }
      }

      let finalized = merged;
      const missingOuRows = finalized.filter((row) => this.getValidOverUnderOdds(row.crownOverUnderOdds || []).length === 0);
      if (missingOuRows.length > 0) {
        let directFillCount = 0;
        const patched = await Promise.all(
          finalized.map(async (row) => {
            if (this.getValidOverUnderOdds(row.crownOverUnderOdds || []).length > 0) return row;
            const directOu = await this.fetchOdds500OverUnderByTrade500Fixture(row).catch(() => null);
            if (!directOu) return row;
            const nextOu = this.getValidOverUnderOdds([directOu, ...(row.crownOverUnderOdds || [])]);
            if (nextOu.length === 0) return row;
            directFillCount += 1;
            return {
              ...row,
              crownOverUnderOdds: nextOu,
            };
          })
        );
        if (directFillCount > 0) {
          daxiaoHit += directFillCount;
          finalized = patched;
          console.log(`odds500 daxiao direct fixture fill matched ${directFillCount}/${missingOuRows.length}`);
        }
      }

      this.lastFetchMeta.odds500_yazhi_hit_count = yazhiHit;
      this.lastFetchMeta.odds500_daxiao_hit_count = daxiaoHit;
      console.log(`odds500 yazhi matched ${yazhiHit}/${baseMatches.length}`);
      console.log(`odds500 daxiao matched ${daxiaoHit}/${baseMatches.length}`);
      const stillMissingOuRows = finalized.filter((row) => this.getValidOverUnderOdds(row.crownOverUnderOdds || []).length === 0);
      if (stillMissingOuRows.length > 0) {
        for (const row of stillMissingOuRows) {
          const exactKey = String(row.id || '').trim();
          const roundKey = String(row.round || '').trim();
          const pairKey = this.buildLive500TeamPairKey(row.matchTime, row.homeTeam, row.awayTeam);
          const pairDateKey = this.buildLive500TeamPairDateKey(row.matchTime, row.homeTeam, row.awayTeam);
          const fromExact = daxiaoMap.byExact.has(exactKey);
          const fromRound = daxiaoMap.byMatchnum.has(roundKey);
          const fromPair = pairKey ? daxiaoMap.byPair.has(pairKey) : false;
          const fromPairDate = pairDateKey ? daxiaoMap.byPairDate.has(pairDateKey) : false;
          const directProbe = await this.probeTrade500FixtureForOu(row).catch((err) => `probe_error:${String(err?.message || err || '')}`);
          console.warn(
            `[odds500-daxiao-miss] match=${exactKey} ${row.homeTeam} vs ${row.awayTeam} ` +
              `exact=${fromExact} round=${fromRound} pair=${fromPair} pairDate=${fromPairDate} direct=${directProbe}`
          );
        }
      }
      return finalized;
    } catch (err: any) {
      console.warn(`odds500 markets fallback failed, keep current values: ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static parseOdds500FixtureIdsFromListHtml(html: string, market: 'yazhi' | 'daxiao') {
    const set = new Set<string>();
    const regex = market === 'yazhi' ? /yazhi-(\d+)\.shtml/gi : /daxiao-(\d+)\.shtml/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(String(html || ''))) !== null) {
      const id = String(m[1] || '').trim();
      if (/^\d+$/.test(id)) set.add(id);
    }
    return set;
  }

  private static collectFixtureKeysByFid(fixtureMap: Live500FixtureMap) {
    const byFid = new Map<string, { exactKeys: string[]; matchnums: string[]; pairKeys: string[]; pairDateKeys: string[] }>();
    const touch = (fid: string) => {
      const key = String(fid || '').trim();
      if (!key) return null;
      if (!byFid.has(key)) byFid.set(key, { exactKeys: [], matchnums: [], pairKeys: [], pairDateKeys: [] });
      return byFid.get(key)!;
    };

    for (const [exactKey, fid] of fixtureMap.byExact.entries()) {
      const bucket = touch(fid);
      if (!bucket) continue;
      bucket.exactKeys.push(exactKey);
      const matchnum = String(exactKey.split('|')[1] || '').trim();
      if (matchnum) bucket.matchnums.push(matchnum);
    }
    for (const [pairKey, fid] of fixtureMap.byPair.entries()) {
      const bucket = touch(fid);
      if (!bucket) continue;
      bucket.pairKeys.push(pairKey);
      const parts = pairKey.split('|');
      if (parts.length === 4) {
        const pairDateKey = `${parts[0]}|${parts[2]}|${parts[3]}`;
        bucket.pairDateKeys.push(pairDateKey);
      }
    }
    return byFid;
  }

  private static async collectFixtureKeysByFidFromTrade500Jczq(dates: string[]) {
    const byFid = new Map<string, { exactKeys: string[]; matchnums: string[]; pairKeys: string[]; pairDateKeys: string[] }>();
    const touch = (fid: string) => {
      const key = String(fid || '').trim();
      if (!key) return null;
      if (!byFid.has(key)) byFid.set(key, { exactKeys: [], matchnums: [], pairKeys: [], pairDateKeys: [] });
      return byFid.get(key)!;
    };

    for (const date of dates) {
      if (!date) continue;
      const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?date=${date}`, 'gb18030');
      const $ = load(html);
      $('tr[data-fixtureid][data-processname]').each((_, row) => {
        const fid = String($(row).attr('data-fixtureid') || '').trim();
        const processName = String($(row).attr('data-processname') || '').trim();
        const processDate = String($(row).attr('data-processdate') || $(row).attr('data-matchdate') || date).trim();
        const matchTime = String($(row).attr('data-matchtime') || '').trim();
        if (!fid || !processName || !processDate) return;
        const bucket = touch(fid);
        if (!bucket) return;
        const exactKey = `${processDate}|${processName}`;
        bucket.exactKeys.push(exactKey);
        bucket.matchnums.push(processName);

        const home = String($(row).attr('data-homesxname') || '').trim();
        const away = String($(row).attr('data-awaysxname') || '').trim();
        if (home && away) {
          const normalizedDate = this.normalizeLive500ProcessDate(processDate);
          const normalizedMinute = /^\d{2}:\d{2}$/.test(matchTime) ? matchTime : '';
          const h = this.normalizeNameForMatch(home);
          const a = this.normalizeNameForMatch(away);
          if (normalizedDate && normalizedMinute && h && a) {
            bucket.pairKeys.push(`${normalizedDate}|${normalizedMinute}|${h}|${a}`);
          }
          if (normalizedDate && h && a) bucket.pairDateKeys.push(`${normalizedDate}|${h}|${a}`);
        }
      });
    }
    return byFid;
  }

  private static async fetchOdds500YazhiJczqMap(
    dates: string[],
    fixtureMap?: Live500FixtureMap
  ): Promise<Odds500CrownHandicapMap> {
    const byExact = new Map<string, ExternalHandicap>();
    const byMatchnum = new Map<string, ExternalHandicap>();
    const byPair = new Map<string, ExternalHandicap>();
    const byPairDate = new Map<string, ExternalHandicap>();
    const liveFixtureMap = fixtureMap || (await this.fetchLive500FixtureMap(dates));
    const keysByFid = this.collectFixtureKeysByFid(liveFixtureMap);
    if (keysByFid.size === 0) {
      const fallbackKeys = await this.collectFixtureKeysByFidFromTrade500Jczq(dates).catch(() => new Map());
      if (fallbackKeys.size > 0) {
        for (const [fid, keys] of fallbackKeys.entries()) keysByFid.set(fid, keys);
        console.warn(`odds500 yazhi fallback fixture-map from trade500 enabled, fid=${keysByFid.size}`);
      }
    }

    const listHtml = await this.fetchTextWithCheck('https://odds.500.com/yazhi_jczq.shtml', 'gb18030');
    const listedIds = this.parseOdds500FixtureIdsFromListHtml(listHtml, 'yazhi');
    const embeddedYapanMap = this.parseOdds500EmbeddedYapanList(listHtml);
    const fids = Array.from(keysByFid.keys());
    if (listedIds.size > 0) {
      console.log(`odds500 yazhi list ids=${listedIds.size}, fixture ids=${fids.length}`);
    }
    if (embeddedYapanMap.size > 0) {
      console.log(`odds500 yazhi embedded list parsed ${embeddedYapanMap.size} fixtures`);
    }
    const cache = new Map<string, ExternalHandicap | null>();

    for (const fid of fids) {
      const handicap =
        embeddedYapanMap.get(fid) || (await this.fetchTrade500CrownHandicapFromYazhiFixtureWithCache(fid, cache));
      if (!handicap) continue;
      const keys = keysByFid.get(fid);
      if (!keys) continue;
      for (const key of keys.exactKeys) {
        if (!byExact.has(key)) byExact.set(key, handicap);
      }
      for (const key of keys.matchnums) {
        if (!byMatchnum.has(key)) byMatchnum.set(key, handicap);
      }
      for (const key of keys.pairKeys) {
        if (!byPair.has(key)) byPair.set(key, handicap);
      }
      for (const key of keys.pairDateKeys || []) {
        if (!byPairDate.has(key)) byPairDate.set(key, handicap);
      }
    }

    return { byExact, byMatchnum, byPair, byPairDate };
  }

  private static parseOdds500EmbeddedYapanList(html: string) {
    const out = new Map<string, ExternalHandicap>();
    const text = String(html || '');
    if (!text) return out;
    const match = text.match(/var\s+yapanList\s*=\s*(\{[\s\S]*?\});/i);
    if (!match || !match[1]) return out;

    try {
      const parsed = JSON.parse(match[1]) as Record<string, Record<string, unknown>>;
      for (const [fidRaw, companyMap] of Object.entries(parsed || {})) {
        const fid = String(fidRaw || '').trim();
        if (!fid || !/^\d+$/.test(fid) || !companyMap || typeof companyMap !== 'object') continue;

        const crownRows = (companyMap as Record<string, unknown>)[LIVE500_CROWN_COMPANY_ID];
        if (!Array.isArray(crownRows) || crownRows.length === 0) continue;
        const liveRow = Array.isArray(crownRows[0]) ? (crownRows[0] as unknown[]) : [];
        const openingRow = Array.isArray(crownRows[1]) ? (crownRows[1] as unknown[]) : [];
        const selected = liveRow.length >= 3 ? liveRow : openingRow;
        if (!Array.isArray(selected) || selected.length < 3) continue;

        const homeOdds = this.parseOdds(String(selected[0] || '').trim());
        const handicapType = this.normalizeYazhiHandicap(String(selected[1] || '').trim());
        const awayOdds = this.parseOdds(String(selected[2] || '').trim());
        if (!handicapType || homeOdds <= 0 || awayOdds <= 0) continue;
        out.set(fid, { type: handicapType, home_odds: homeOdds, away_odds: awayOdds });
      }
    } catch (err: any) {
      console.warn(`odds500 yazhi embedded list parse failed: ${err?.message || err}`);
    }

    return out;
  }

  private static async fetchOdds500DaxiaoJczqMap(
    dates: string[],
    fixtureMap?: Live500FixtureMap
  ): Promise<Odds500CrownOverUnderMap & { listEntries?: Odds500DaxiaoListEntry[]; listRowByFid?: Map<string, ExternalOverUnderOdds> }> {
    const byExact = new Map<string, ExternalOverUnderOdds>();
    const byMatchnum = new Map<string, ExternalOverUnderOdds>();
    const byPair = new Map<string, ExternalOverUnderOdds>();
    const byPairDate = new Map<string, ExternalOverUnderOdds>();
    const liveFixtureMap = fixtureMap || (await this.fetchLive500FixtureMap(dates));
    const keysByFid = this.collectFixtureKeysByFid(liveFixtureMap);
    if (keysByFid.size === 0) {
      const fallbackKeys = await this.collectFixtureKeysByFidFromTrade500Jczq(dates).catch(() => new Map());
      if (fallbackKeys.size > 0) {
        for (const [fid, keys] of fallbackKeys.entries()) keysByFid.set(fid, keys);
        console.warn(`odds500 daxiao fallback fixture-map from trade500 enabled, fid=${keysByFid.size}`);
      }
    }

    const listHtml = await this.fetchTextWithCheck('https://odds.500.com/daxiao_jczq.shtml', 'gb18030');
    const listRowMap = this.parseOdds500DaxiaoListRows(listHtml);
    const listEntries = this.parseOdds500DaxiaoListEntries(listHtml);
    const listedIds = this.parseOdds500FixtureIdsFromListHtml(listHtml, 'daxiao');
    const embeddedDaxiaoMap = this.parseOdds500EmbeddedDaxiaoList(listHtml);
    const fids = Array.from(keysByFid.keys());
    if (listedIds.size > 0) {
      console.log(`odds500 daxiao list ids=${listedIds.size}, fixture ids=${fids.length}`);
    }
    if (embeddedDaxiaoMap.size > 0) {
      console.log(`odds500 daxiao embedded list parsed ${embeddedDaxiaoMap.size} fixtures`);
    }
    if (listRowMap.size > 0) {
      console.log(`odds500 daxiao list-row parsed ${listRowMap.size} fixtures`);
    }
    for (const entry of listEntries) {
      const pairKey = this.buildLive500TeamPairKey(entry.matchTime, entry.homeTeam, entry.awayTeam);
      const pairDateKey = this.buildLive500TeamPairDateKey(entry.matchTime, entry.homeTeam, entry.awayTeam);
      if (pairKey && !byPair.has(pairKey)) byPair.set(pairKey, entry.ou);
      if (pairDateKey && !byPairDate.has(pairDateKey)) byPairDate.set(pairDateKey, entry.ou);
    }

    let missNoCrownRow = 0;
    let missRequestFailed = 0;
    for (const fid of fids) {
      const ou =
        listRowMap.get(fid) ||
        embeddedDaxiaoMap.get(fid) ||
        (await this.fetchOdds500OverUnderFromDaxiaoFixtureWithRetry(fid).catch((err) => {
          const errText = String(err?.message || err || '');
          if (errText.includes('no crown row')) missNoCrownRow += 1;
          else missRequestFailed += 1;
          console.warn(`odds500 daxiao fixture ${fid} skipped: ${errText}`);
          return null;
        }));
      if (!ou) continue;
      const keys = keysByFid.get(fid);
      if (!keys) continue;
      for (const key of keys.exactKeys) {
        if (!byExact.has(key)) byExact.set(key, ou);
      }
      for (const key of keys.matchnums) {
        if (!byMatchnum.has(key)) byMatchnum.set(key, ou);
      }
      for (const key of keys.pairKeys) {
        if (!byPair.has(key)) byPair.set(key, ou);
      }
      for (const key of keys.pairDateKeys || []) {
        if (!byPairDate.has(key)) byPairDate.set(key, ou);
      }
      await this.sleep(80);
    }
    if (missNoCrownRow > 0 || missRequestFailed > 0) {
      console.warn(`odds500 daxiao misses: no_crown_row=${missNoCrownRow}, request_failed=${missRequestFailed}`);
    }

    return { byExact, byMatchnum, byPair, byPairDate, listEntries, listRowByFid: listRowMap };
  }

  private static parseOdds500DaxiaoListRows(html: string) {
    const out = new Map<string, ExternalOverUnderOdds>();
    const $ = load(String(html || ''));
    const groups = new Map<string, any[]>();
    $('tr[data-fid]').each((_, tr) => {
      const fid = String($(tr).attr('data-fid') || '').trim();
      if (!fid) return;
      const list = groups.get(fid) || [];
      list.push(tr);
      groups.set(fid, list);
    });
    for (const [fid, rows] of groups.entries()) {
      if (rows.length < 3) continue;
      const row0 = $(rows[0]);
      const row1 = $(rows[1]);
      const row2 = $(rows[2]);
      const overRaw = String(row0.find('td.border_r_c5').first().text() || '').replace(/\s+/g, '').trim();
      const lineRaw = String(row1.find('td.border_r_c5').first().text() || '').replace(/\s+/g, '').trim();
      const underRaw = String(row2.find('td.border_r_c5').first().text() || '').replace(/\s+/g, '').trim();
      const overOdds = this.parseOdds(overRaw.replace(/[\u2191\u2193]/g, ''));
      const underOdds = this.parseOdds(underRaw.replace(/[\u2191\u2193]/g, ''));
      const line = this.normalizeOuLine(
        lineRaw
          .replace(/\(球\)/g, '')
          .replace(/[\u5347\u964d]/g, '')
          .replace(/[\u2191\u2193]/g, '')
      );
      if (!line || overOdds <= 0 || underOdds <= 0) continue;
      out.set(fid, { line, over_odds: overOdds, under_odds: underOdds });
    }
    return out;
  }

  private static parseOdds500DaxiaoListEntries(html: string): Odds500DaxiaoListEntry[] {
    const out: Odds500DaxiaoListEntry[] = [];
    const $ = load(String(html || ''));
    $('tr[data-fid][date-dtime]').each((_, tr) => {
      const fid = String($(tr).attr('data-fid') || '').trim();
      const matchTimeRaw = String($(tr).attr('date-dtime') || '').trim();
      const matchTime = this.normalizeMatchTime(matchTimeRaw);
      if (!fid || !matchTime) return;
      const teamLinks = $(tr).find('a.team_link');
      const homeTeam = String(teamLinks.eq(0).text() || teamLinks.eq(0).attr('title') || '').replace(/\s+/g, '').trim();
      const awayTeam = String(teamLinks.eq(1).text() || teamLinks.eq(1).attr('title') || '').replace(/\s+/g, '').trim();
      if (!homeTeam || !awayTeam) return;
      const firstCellText = String($(tr).find('td').first().text() || '').replace(/\s+/g, '').trim();
      const round = this.normalizeOdds500RoundLabel(firstCellText, matchTime);
      const rows = $(`tr[data-fid="${fid}"]`);
      if (rows.length < 3) return;
      const overRaw = String(rows.eq(0).find('td.border_r_c5').first().text() || '').replace(/\s+/g, '').trim();
      const lineRaw = String(rows.eq(1).find('td.border_r_c5').first().text() || '').replace(/\s+/g, '').trim();
      const underRaw = String(rows.eq(2).find('td.border_r_c5').first().text() || '').replace(/\s+/g, '').trim();
      const overOdds = this.parseOdds(overRaw.replace(/[\u2191\u2193]/g, ''));
      const underOdds = this.parseOdds(underRaw.replace(/[\u2191\u2193]/g, ''));
      const line = this.normalizeOuLine(
        lineRaw
          .replace(/\(球\)/g, '')
          .replace(/[\u5347\u964d]/g, '')
          .replace(/[\u2191\u2193]/g, '')
      );
      if (!line || overOdds <= 0 || underOdds <= 0) return;
      out.push({
        fid,
        matchTime,
        homeTeam,
        awayTeam,
        round,
        ou: { line, over_odds: overOdds, under_odds: underOdds },
      });
    });
    return out;
  }

  private static normalizeOdds500RoundLabel(raw: string, matchTime?: string): string;
  private static normalizeOdds500RoundLabel(raw: string, matchTime = '') {
    const text = String(raw || '').trim();
    const m = text.match(/周([一二三四五六日天])(\d{3})/);
    if (m) {
      const dayMap: Record<string, string> = {
        一: '1',
        二: '2',
        三: '3',
        四: '4',
        五: '5',
        六: '6',
        日: '7',
        天: '7',
      };
      const dayDigit = dayMap[m[1]] || '';
      if (dayDigit) return `${dayDigit}${m[2]}`;
    }
    const mojibakeMatch = text.match(/ÖÜ([Ò»¶þÈýËÄÎåÁùÈÕÌì])(\d{3})/);
    if (mojibakeMatch) {
      const dayMapMojibake: Record<string, string> = {
        'Ò»': '1',
        '¶þ': '2',
        'Èý': '3',
        'ËÄ': '4',
        'Îå': '5',
        'Áù': '6',
        'ÈÕ': '7',
        'Ìì': '7',
      };
      const dayDigit = dayMapMojibake[mojibakeMatch[1]] || '';
      if (dayDigit) return `${dayDigit}${mojibakeMatch[2]}`;
    }
    const tail = text.match(/(\d{3})$/);
    if (!tail) return '';
    const normalizedTime = this.normalizeMatchTime(matchTime || '');
    const dt = normalizedTime ? new Date(normalizedTime.replace(' ', 'T')) : null;
    if (!dt || Number.isNaN(dt.getTime())) return '';
    const jsDay = dt.getDay(); // 0=Sunday
    const dayDigit = jsDay === 0 ? 7 : jsDay;
    return `${dayDigit}${tail[1]}`;
  }

  private static async fetchOdds500OverUnderFromDaxiaoFixtureWithRetry(
    fixtureId: string,
    retry = 2
  ): Promise<ExternalOverUnderOdds | null> {
    let lastErr: any = null;
    for (let i = 0; i <= retry; i++) {
      try {
        return await this.fetchOdds500OverUnderFromDaxiaoFixture(fixtureId);
      } catch (err: any) {
        lastErr = err;
        if (i < retry) await this.sleep(120 * (i + 1));
      }
    }
    throw lastErr || new Error(`daxiao fixture fetch failed: ${fixtureId}`);
  }

  private static parseOdds500EmbeddedDaxiaoList(html: string) {
    const out = new Map<string, ExternalOverUnderOdds>();
    const text = String(html || '');
    if (!text) return out;
    const match = text.match(/var\s+daxiaoList\s*=\s*(\{[\s\S]*?\});/i);
    if (!match || !match[1]) return out;

    try {
      const parsed = JSON.parse(match[1]) as Record<string, Record<string, unknown>>;
      for (const [fidRaw, companyMap] of Object.entries(parsed || {})) {
        const fid = String(fidRaw || '').trim();
        if (!fid || !/^\d+$/.test(fid) || !companyMap || typeof companyMap !== 'object') continue;

        const crownRows = (companyMap as Record<string, unknown>)[LIVE500_CROWN_COMPANY_ID];
        if (!Array.isArray(crownRows) || crownRows.length === 0) continue;
        const liveRow = Array.isArray(crownRows[0]) ? (crownRows[0] as unknown[]) : [];
        const openingRow = Array.isArray(crownRows[1]) ? (crownRows[1] as unknown[]) : [];
        const selected = liveRow.length >= 3 ? liveRow : openingRow;
        if (!Array.isArray(selected) || selected.length < 3) continue;

        const overOdds = this.parseOdds(String(selected[0] || '').trim());
        const line = this.normalizeOuLine(String(selected[1] || '').trim());
        const underOdds = this.parseOdds(String(selected[2] || '').trim());
        if (!line || overOdds <= 0 || underOdds <= 0) continue;
        out.set(fid, { line, over_odds: overOdds, under_odds: underOdds });
      }
    } catch (err: any) {
      console.warn(`odds500 daxiao embedded list parse failed: ${err?.message || err}`);
    }

    return out;
  }

  private static async fetchOdds500OverUnderFromDaxiaoFixture(fixtureId: string): Promise<ExternalOverUnderOdds | null> {
    const fid = String(fixtureId || '').trim();
    if (!fid) return null;
    const html = await this.fetchTextWithCheck(`https://odds.500.com/fenxi/daxiao-${fid}.shtml`, 'gb18030');
    const $ = load(html);
    const row =
      $(`tr#${LIVE500_CROWN_COMPANY_ID}[xls="row"]`).first().length > 0
        ? $(`tr#${LIVE500_CROWN_COMPANY_ID}[xls="row"]`).first()
        : $(`tr#${LIVE500_CROWN_COMPANY_ID}`).first();
    if (!row.length) {
      const ajaxOu = await this.fetchOdds500OverUnderFromDaxiaoAjax(fid);
      if (ajaxOu) return ajaxOu;
      throw new Error(`no crown row for fixture ${fid}`);
    }
    const cells = row
      .find('td')
      .map((_, td) => String($(td).text() || '').replace(/\s+/g, '').trim())
      .get()
      .filter(Boolean);
    if (cells.length < 6) return null;

    const parseTriplet = (overRaw: string, lineRaw: string, underRaw: string) => {
      const overOdds = this.parseOdds(String(overRaw || '').replace(/[\u2191\u2193]/g, '').trim());
      const underOdds = this.parseOdds(String(underRaw || '').replace(/[\u2191\u2193]/g, '').trim());
      const line = this.normalizeOuLine(
        String(lineRaw || '')
          .replace(/[\u2191\u2193]/g, '')
          .replace(/[\u5347\u964d]/g, '')
          .trim()
      );
      if (!line || overOdds <= 0 || underOdds <= 0) return null;
      return { line, over_odds: overOdds, under_odds: underOdds } as ExternalOverUnderOdds;
    };

    const live = parseTriplet(cells[3], cells[4], cells[5]);
    if (live) return live;
    if (cells.length >= 12) {
      const opening = parseTriplet(cells[9], cells[10], cells[11]);
      if (opening) return opening;
    }
    return null;
  }

  private static async fetchOdds500OverUnderFromDaxiaoAjax(fixtureId: string): Promise<ExternalOverUnderOdds | null> {
    const fid = String(fixtureId || '').trim();
    if (!fid) return null;
    const ajaxUrl = `https://odds.500.com/fenxi1/inc/daxiaoajax.php?fid=${encodeURIComponent(fid)}&id=${encodeURIComponent(
      LIVE500_CROWN_COMPANY_ID
    )}&t=${Date.now()}`;
    const text = await this.fetchTextWithCheck(ajaxUrl, 'gb18030');
    const parsed = JSON.parse(String(text || '').trim());
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const latestRowHtml = String(parsed[0] || '').trim();
    if (!latestRowHtml) return null;
    const $ = load(`<table><tbody>${latestRowHtml}</tbody></table>`);
    const cells = $('tr')
      .first()
      .find('td')
      .map((_, td) => String($(td).text() || '').replace(/\s+/g, '').trim())
      .get();
    if (cells.length < 3) return null;

    const overOdds = this.parseOdds(String(cells[0] || '').replace(/[\u2191\u2193]/g, '').trim());
    const line = this.normalizeOuLine(
      String(cells[1] || '')
        .replace(/[\u2191\u2193]/g, '')
        .replace(/[\u5347\u964d]/g, '')
        .trim()
    );
    const underOdds = this.parseOdds(String(cells[2] || '').replace(/[\u2191\u2193]/g, '').trim());
    if (!line || overOdds <= 0 || underOdds <= 0) return null;
    return { line, over_odds: overOdds, under_odds: underOdds };
  }

  private static async fetchOdds500OverUnderByTrade500Fixture(match: ExternalMatch): Promise<ExternalOverUnderOdds | null> {
    const matchDate = this.normalizeMatchTime(match.matchTime).slice(0, 10);
    const round = String(match.round || '').trim();
    if (!matchDate || !round) return null;
    const queryDates = [matchDate, this.shiftDateByDays(matchDate, -1)].filter(Boolean);
    const homeNorm = this.normalizeNameForMatch(match.homeTeam);
    const awayNorm = this.normalizeNameForMatch(match.awayTeam);
    if (!homeNorm || !awayNorm) return null;

    let fixtureId = '';
    type Candidate = { fid: string; score: number; queryDate: string; rowDate: string; rowLeague: string; rowHome: string; rowAway: string };
    let best: Candidate | null = null;
    const targetLeague = this.normalizeNameForMatch(match.league);
    const targetTime = this.normalizeMatchTime(match.matchTime);
    for (const queryDate of queryDates) {
      const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?date=${queryDate}`, 'gb18030');
      const $ = load(html);
      const sameRoundCandidates: string[] = [];
      $('tr[data-fixtureid][data-processname]').each((_, tr) => {
        const processName = String($(tr).attr('data-processname') || '').trim();
        if (processName !== round) return;
        const rowFixtureId = String($(tr).attr('data-fixtureid') || '').trim();
        if (!rowFixtureId) return;
        const rowMatchDate = this.normalizeLive500ProcessDate(String($(tr).attr('data-matchdate') || ''));
        if (rowMatchDate && rowMatchDate !== matchDate) return;
        sameRoundCandidates.push(rowFixtureId);
        if (fixtureId) return;
        const rowHome = this.normalizeNameForMatch(String($(tr).attr('data-homesxname') || ''));
        const rowAway = this.normalizeNameForMatch(String($(tr).attr('data-awaysxname') || ''));
        if (rowHome === homeNorm && rowAway === awayNorm) {
          fixtureId = rowFixtureId;
          return;
        }

        // Relaxed fallback: league + kickoff time + fuzzy team names.
        const rowLeague = this.normalizeNameForMatch(String($(tr).attr('data-simpleleague') || ''));
        const rowMatchTimeRaw = `${rowMatchDate || matchDate} ${String($(tr).attr('data-matchtime') || '00:00')}:00`;
        const rowMatchTime = this.normalizeMatchTime(rowMatchTimeRaw);
        const minuteDiff = this.getMatchMinuteDiff(targetTime, rowMatchTime);
        const leagueMatched = !!targetLeague && !!rowLeague && targetLeague === rowLeague;
        const homeLoose = this.teamNameLikelySame(match.homeTeam, rowHome);
        const awayLoose = this.teamNameLikelySame(match.awayTeam, rowAway);
        let score = 0;
        if (leagueMatched) score += 3;
        if (Number.isFinite(minuteDiff) && minuteDiff <= 30) score += 3;
        else if (Number.isFinite(minuteDiff) && minuteDiff <= 90) score += 2;
        else if (Number.isFinite(minuteDiff) && minuteDiff <= 180) score += 1;
        if (homeLoose && awayLoose) score += 3;
        else if (homeLoose || awayLoose) score += 1;
        if (score >= 5) {
          if (!best || score > best.score) {
            best = {
              fid: rowFixtureId,
              score,
              queryDate,
              rowDate: rowMatchDate || '',
              rowLeague,
              rowHome,
              rowAway,
            };
          }
        }
      });
      if (!fixtureId && sameRoundCandidates.length === 1) {
        fixtureId = sameRoundCandidates[0];
      }
      if (fixtureId) break;
    }
    if (!fixtureId && best) {
      fixtureId = best.fid;
      console.warn(
        `[odds500-daxiao-relaxed] ${match.id} -> fid=${best.fid} score=${best.score} queryDate=${best.queryDate} rowDate=${best.rowDate} rowLeague=${best.rowLeague} row=${best.rowHome} vs ${best.rowAway}`
      );
    }
    if (!fixtureId) return null;
    return this.fetchOdds500OverUnderFromDaxiaoFixtureWithRetry(fixtureId, 2);
  }

  private static async probeTrade500FixtureForOu(match: ExternalMatch): Promise<string> {
    const matchDate = this.normalizeMatchTime(match.matchTime).slice(0, 10);
    const round = String(match.round || '').trim();
    if (!matchDate || !round) return 'invalid_match_date_or_round';
    const queryDates = [matchDate, this.shiftDateByDays(matchDate, -1)].filter(Boolean);
    const homeNorm = this.normalizeNameForMatch(match.homeTeam);
    const awayNorm = this.normalizeNameForMatch(match.awayTeam);
    if (!homeNorm || !awayNorm) return 'invalid_team_name';
    for (const queryDate of queryDates) {
      const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?date=${queryDate}`, 'gb18030');
      const $ = load(html);
      let roundRows = 0;
      let teamMatched = false;
      let fixtureId = '';
      $('tr[data-fixtureid][data-processname]').each((_, tr) => {
        const processName = String($(tr).attr('data-processname') || '').trim();
        if (processName !== round) return;
        const rowMatchDate = this.normalizeLive500ProcessDate(String($(tr).attr('data-matchdate') || ''));
        if (rowMatchDate && rowMatchDate !== matchDate) return;
        roundRows += 1;
        const rowFixtureId = String($(tr).attr('data-fixtureid') || '').trim();
        const rowHome = this.normalizeNameForMatch(String($(tr).attr('data-homesxname') || ''));
        const rowAway = this.normalizeNameForMatch(String($(tr).attr('data-awaysxname') || ''));
        if (rowHome === homeNorm && rowAway === awayNorm) {
          teamMatched = true;
          fixtureId = rowFixtureId;
        } else if (!fixtureId && roundRows === 1) {
          fixtureId = rowFixtureId;
        }
      });
      if (fixtureId) return `date=${queryDate},round_rows=${roundRows},team_matched=${teamMatched},fid=${fixtureId}`;
      if (roundRows > 0) return `date=${queryDate},round_rows=${roundRows},team_matched=false,fid=none`;
    }
    return `no_round_rows(${round})`;
  }

  private static shiftDateByDays(dateText: string, days: number) {
    const m = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const y = Number.parseInt(m[1], 10);
    const mo = Number.parseInt(m[2], 10);
    const d = Number.parseInt(m[3], 10);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (Number.isNaN(dt.getTime())) return '';
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  private static normalizeYazhiHandicap(raw: string) {
    const text = String(raw || '')
      .replace(/[\u2191\u2193]/g, '')
      .replace(/[\u5347\u964d]/g, '')
      .replace(/\s+/g, '')
      .trim();
    if (!text) return '';

    const directNumeric = text.match(/^([+-]?)(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)$/);
    if (directNumeric) {
      const sign = directNumeric[1] || '';
      const value = directNumeric[2];
      return sign ? `${sign}${value}` : value;
    }

    const hasReceive = text.includes('\u53d7');
    const hasGive = text.includes('\u8ba9');
    const normalizedText = text.replace(/[\u53d7\u8ba9]/g, '');
    const map: Record<string, string> = {
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
    const base = map[normalizedText] || '';
    if (!base) return '';
    if (hasReceive) return `+${base}`;
    if (hasGive) return `-${base}`;
    return base;
  }

  private static async enrichWithTrade500CrownOddsFallback(baseMatches: ExternalMatch[]) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    try {
      const crownMap = await this.fetchTrade500CrownMapFromOddsXml();
      let hit = 0;
      const merged = baseMatches.map((row) => {
        if (this.isValidExternalOdds(row.crownOdds)) return row;
        const exact = crownMap.byExact.get(String(row.id || '').trim());
        const byRound = crownMap.byMatchnum.get(String(row.round || '').trim());
        const odds = exact?.crownOdds || byRound?.crownOdds;
        if (!this.isValidExternalOdds(odds)) return row;
        hit += 1;
        return { ...row, crownOdds: odds };
      });
      if (hit > 0) {
        console.log(`trade.500 odds.xml crown odds fallback matched ${hit}/${baseMatches.length} matches`);
      }
      return merged;
    } catch (err: any) {
      console.warn(`trade.500 odds.xml crown odds fallback failed, keep current values: ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static async fetchTrade500CrownHandicapFallbackMapFromJczq(dates: string[]): Promise<Trade500CrownHandicapFallbackMap> {
    const byExact = new Map<string, ExternalHandicap>();
    const byMatchnum = new Map<string, ExternalHandicap>();
    for (const date of dates) {
      if (!date) continue;
      const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?date=${date}`, 'gb18030');
      const $ = load(html);
      $('tr[data-processname]').each((_, element) => {
        const processName = String($(element).attr('data-processname') || '').trim();
        const processDate = String($(element).attr('data-processdate') || $(element).attr('data-matchdate') || date).trim();
        if (!processName || !processDate) return;
        const rawHandicap = String($(element).attr('data-rangqiu') || '').trim();
        const fallbackText = String($(element).find('td.td-rang p.itm-rangA2').first().text() || '').trim();
        const handicapType = this.normalizeSignedHandicap(rawHandicap) || this.normalizeSignedHandicap(fallbackText);
        const homeBtn = $(element).find('.itm-rangB2 [data-value=\"3\"]').first();
        const awayBtn = $(element).find('.itm-rangB2 [data-value=\"0\"]').first();
        const homeType = String(homeBtn.attr('data-type') || '').trim().toLowerCase();
        const awayType = String(awayBtn.attr('data-type') || '').trim().toLowerCase();
        // HGA 失败时使用 trade.500 让球列兜底，优先保障比赛列表的皇冠让球完整性。
        if (!homeType && !awayType) return;
        const homeOdds = this.parseOdds(homeBtn.attr('data-sp') || '');
        const awayOdds = this.parseOdds(awayBtn.attr('data-sp') || '');
        if (!handicapType || homeOdds <= 0 || awayOdds <= 0) return;
        const row: ExternalHandicap = {
          type: handicapType,
          home_odds: homeOdds,
          away_odds: awayOdds,
        };
        byExact.set(`${processDate}|${processName}`, row);
        if (!byMatchnum.has(processName)) byMatchnum.set(processName, row);
      });
    }
    return { byExact, byMatchnum };
  }

  private static async fetchTrade500AsPrimaryMatches(): Promise<ExternalMatch[]> {
    const tradeRows = await this.fetchTrade500MatchesFromXml();
    if (tradeRows.length === 0) {
      return [];
    }
    const hgaConfig = this.getHgaConfig();

    let crownMap = {
      byExact: new Map<string, { crownOdds: ExternalOdds; crownAsia: ExternalAsia }>(),
      byMatchnum: new Map<string, { crownOdds: ExternalOdds; crownAsia: ExternalAsia }>(),
    };
    try {
      crownMap = await this.fetchTrade500CrownMapFromOddsXml();
    } catch (err: any) {
      console.warn(`Trade500 odds.xml enrichment failed, continue with empty crown odds: ${err?.message || err}`);
    }

    let live500CrownMap = new Map<string, ExternalOdds>();
    if (!hgaConfig.enabled) {
      try {
        const dates = Array.from(new Set(tradeRows.map((row) => row.date).filter(Boolean)));
        live500CrownMap = await this.fetchLive500CrownOddsMap(dates);
      } catch (err: any) {
        console.warn(`live.500 crown fallback failed, continue with odds.xml only: ${err?.message || err}`);
      }
    }
    const out: ExternalMatch[] = tradeRows.map((row) => {
      const key = `${row.date}|${row.matchnum}`;
      const crown = crownMap.byExact.get(key) || crownMap.byMatchnum.get(row.matchnum);
      const liveCrown = live500CrownMap.get(key) || live500CrownMap.get(row.matchnum);
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
        crownOdds: this.isValidExternalOdds(liveCrown) ? liveCrown! : crown?.crownOdds || { win: '-', draw: '-', lose: '-' },
        crownAsia: crown?.crownAsia || { handicap: '-', homeWater: '-', awayWater: '-' },
      };
    });

    console.log(`Trade500 primary source built ${out.length} matches`);
    return out;
  }

  private static parseSportteryOdds(raw: any): ExternalOdds | null {
    const win = String(raw?.h || '').trim();
    const draw = String(raw?.d || '').trim();
    const lose = String(raw?.a || '').trim();
    const odds = { win, draw, lose };
    return this.isValidExternalOdds(odds) ? odds : null;
  }

  private static buildSportteryFallbackKey(matchTime?: string, homeTeam?: string, awayTeam?: string) {
    const normalizedTime = this.normalizeMatchTime(matchTime);
    const minute = normalizedTime.slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(minute)) return '';
    const home = this.normalizeNameForMatch(homeTeam);
    const away = this.normalizeNameForMatch(awayTeam);
    if (!home || !away) return '';
    return `${minute}|${home}|${away}`;
  }

  private static async fetchSportteryJingcaiMap() {
    const hadByExact = new Map<string, ExternalOdds>();
    const hadByFallback = new Map<string, ExternalOdds>();
    const hhadByExact = new Map<string, { odds: ExternalOdds; handicapLine: string }>();
    const hhadByFallback = new Map<string, { odds: ExternalOdds; handicapLine: string }>();
    const leagueAbbByExact = new Map<string, string>();
    const leagueAbbByFallback = new Map<string, string>();

    const [hadBody, hhadBody] = await Promise.all([
      this.fetchTextWithCheck(SPORTTERY_HAD_URL),
      this.fetchTextWithCheck(SPORTTERY_HHAD_URL),
    ]);

    const parseRows = (body: string) => {
      try {
        const parsed = JSON.parse(String(body || ''));
        const matchInfoList = Array.isArray(parsed?.value?.matchInfoList) ? parsed.value.matchInfoList : [];
        return matchInfoList.flatMap((day: any) => (Array.isArray(day?.subMatchList) ? day.subMatchList : []));
      } catch {
        return [] as any[];
      }
    };

    const hadRows = parseRows(hadBody);
    for (const item of hadRows) {
      const matchDate = String(item?.matchDate || '').trim();
      const matchNum = String(item?.matchNum || '').trim();
      const matchTime = String(item?.matchTime || '').trim();
      const leagueAbbName = String(item?.leagueAbbName || '').trim();
      const homeTeam = String(item?.homeTeamAbbName || item?.homeTeamAllName || '').trim();
      const awayTeam = String(item?.awayTeamAbbName || item?.awayTeamAllName || '').trim();
      const odds = this.parseSportteryOdds(item?.had);
      if (!matchDate || !matchNum || !odds) continue;
      hadByExact.set(`${matchDate}|${matchNum}`, odds);
      if (leagueAbbName) {
        leagueAbbByExact.set(`${matchDate}|${matchNum}`, leagueAbbName);
      }
      const fallbackKey = this.buildSportteryFallbackKey(`${matchDate} ${matchTime || '00:00:00'}`, homeTeam, awayTeam);
      if (fallbackKey) {
        hadByFallback.set(fallbackKey, odds);
        if (leagueAbbName) leagueAbbByFallback.set(fallbackKey, leagueAbbName);
      }
    }

    const hhadRows = parseRows(hhadBody);
    for (const item of hhadRows) {
      const matchDate = String(item?.matchDate || '').trim();
      const matchNum = String(item?.matchNum || '').trim();
      const matchTime = String(item?.matchTime || '').trim();
      const leagueAbbName = String(item?.leagueAbbName || '').trim();
      const homeTeam = String(item?.homeTeamAbbName || item?.homeTeamAllName || '').trim();
      const awayTeam = String(item?.awayTeamAbbName || item?.awayTeamAllName || '').trim();
      const odds = this.parseSportteryOdds(item?.hhad);
      const rawLine = String(item?.hhad?.goalLineValue || item?.hhad?.goalLine || '').trim();
      const handicapLine = this.normalizeSignedHandicap(rawLine) || rawLine;
      if (!matchDate || !matchNum || !odds || !handicapLine) continue;
      const payload = { odds, handicapLine };
      hhadByExact.set(`${matchDate}|${matchNum}`, payload);
      if (leagueAbbName && !leagueAbbByExact.has(`${matchDate}|${matchNum}`)) {
        leagueAbbByExact.set(`${matchDate}|${matchNum}`, leagueAbbName);
      }
      const fallbackKey = this.buildSportteryFallbackKey(`${matchDate} ${matchTime || '00:00:00'}`, homeTeam, awayTeam);
      if (fallbackKey) {
        hhadByFallback.set(fallbackKey, payload);
        if (leagueAbbName && !leagueAbbByFallback.has(fallbackKey)) {
          leagueAbbByFallback.set(fallbackKey, leagueAbbName);
        }
      }
    }

    return { hadByExact, hadByFallback, hhadByExact, hhadByFallback, leagueAbbByExact, leagueAbbByFallback };
  }

  private static async enrichWithSportteryJingcai(baseMatches: ExternalMatch[]) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    try {
      const map = await this.fetchSportteryJingcaiMap();
      let hadHit = 0;
      let hhadHit = 0;
      const merged = baseMatches.map((match) => {
        const id = String(match.id || '').trim();
        const fallbackKey = this.buildSportteryFallbackKey(match.matchTime, match.homeTeam, match.awayTeam);
        const had = map.hadByExact.get(id) || (fallbackKey ? map.hadByFallback.get(fallbackKey) : undefined);
        const hhad = map.hhadByExact.get(id) || (fallbackKey ? map.hhadByFallback.get(fallbackKey) : undefined);
        const leagueAbb =
          map.leagueAbbByExact.get(id) || (fallbackKey ? map.leagueAbbByFallback.get(fallbackKey) : undefined);
        if (!had && !hhad) return match;

        const next: ExternalMatch = { ...match };
        if (leagueAbb) {
          next.league = leagueAbb;
        }
        if (had && this.isValidExternalOdds(had)) {
          next.jingcaiOdds = had;
          hadHit += 1;
        }
        if (hhad && this.isValidExternalOdds(hhad.odds)) {
          next.jingcaiHandicapOdds = hhad.odds;
          const hhadLine = String(hhad.handicapLine || '').trim();
          const isUnavailable = !hhadLine || hhadLine === '-' || hhadLine === '未开售';
          if (!isUnavailable) {
            next.jingcaiHandicap = hhadLine;
          } else {
            next.jingcaiHandicap = next.jingcaiHandicap || '-';
          }
          hhadHit += 1;
        }
        return next;
      });
      if (hadHit > 0 || hhadHit > 0) {
        console.log(`Sporttery had/hhad matched had=${hadHit}, hhad=${hhadHit}, total=${baseMatches.length}`);
      }
      return merged;
    } catch (err: any) {
      console.warn(`Sporttery had/hhad fetch failed, keep Trade500 jingcai as fallback: ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static async enrichWithSportteryTtg(baseMatches: ExternalMatch[]) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    let merged = baseMatches;
    let hit = 0;
    try {
      const ttgMap = await this.fetchSportteryTtgMap();
      if (ttgMap.byExact.size === 0 && ttgMap.byFallback.size === 0) {
        console.warn('Sporttery TTG returned empty goal map, try trade.500 JQS fallback');
        return this.enrichWithTrade500GoalOddsFallback(baseMatches, 'sporttery-ttg-empty');
      }
      merged = baseMatches.map((match) => {
        const exact = ttgMap.byExact.get(String(match.id || '').trim());
        const fallbackKey = this.buildSportteryTtgFallbackKey(match.matchTime, match.homeTeam, match.awayTeam);
        const fallback = fallbackKey ? ttgMap.byFallback.get(fallbackKey) : undefined;
        const goalOdds = this.getValidGoalOdds(exact || fallback || []);
        if (goalOdds.length === 0) return match;
        hit += 1;
        return { ...match, crownGoalOdds: goalOdds };
      });
      if (hit > 0) {
        console.log(`Sporttery TTG goal odds matched ${hit}/${baseMatches.length} matches`);
      }
    } catch (err: any) {
      console.warn(`Sporttery TTG fetch failed, try trade.500 JQS fallback: ${err?.message || err}`);
      return this.enrichWithTrade500GoalOddsFallback(baseMatches, 'sporttery-ttg-error');
    }
    const missing = merged.filter((match) => this.getValidGoalOdds(match.crownGoalOdds || []).length === 0).length;
    const minHit = Math.ceil(baseMatches.length * 0.8);
    if (hit < minHit || missing > 0) {
      console.warn(`Sporttery TTG goal odds incomplete hit=${hit}/${baseMatches.length}, missing=${missing}; try trade.500 JQS fallback`);
      return this.enrichWithTrade500GoalOddsFallback(merged, 'sporttery-ttg-incomplete');
    }
    return merged;
  }

  private static async enrichWithTrade500GoalOddsFallback(baseMatches: ExternalMatch[], reason: string) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return baseMatches;
    const missingRows = baseMatches.filter((match) => this.getValidGoalOdds(match.crownGoalOdds || []).length === 0);
    if (missingRows.length === 0) return baseMatches;
    try {
      const dates = Array.from(
        new Set(
          baseMatches
            .map((row) => String(row.id || '').split('|')[0] || this.normalizeMatchTime(row.matchTime).slice(0, 10))
            .map((date) => this.normalizeLive500ProcessDate(date))
            .filter(Boolean)
        )
      );
      const goalMap = await this.fetchTrade500GoalOddsMapFromJczq(dates);
      let hit = 0;
      const merged = baseMatches.map((match) => {
        if (this.getValidGoalOdds(match.crownGoalOdds || []).length > 0) return match;
        const exactKey = String(match.id || '').trim();
        const roundKey = String(match.round || '').trim();
        const pairKey = this.buildPairMinuteKey(match.matchTime, match.homeTeam, match.awayTeam);
        const pairDateKey = this.buildPairDateKey(match.matchTime, match.homeTeam, match.awayTeam);
        const goalOdds =
          goalMap.byExact.get(exactKey) ||
          goalMap.byMatchnum.get(roundKey) ||
          goalMap.byPair.get(pairKey) ||
          goalMap.byPairDate.get(pairDateKey) ||
          [];
        const validGoalOdds = this.getValidGoalOdds(goalOdds);
        if (validGoalOdds.length === 0) return match;
        hit += 1;
        return { ...match, crownGoalOdds: validGoalOdds };
      });
      this.lastFetchMeta.trade500_jqs_hit_count += hit;
      console.log(`trade.500 JQS goal odds fallback matched ${hit}/${missingRows.length} missing matches (reason=${reason})`);
      return merged;
    } catch (err: any) {
      console.warn(`trade.500 JQS goal odds fallback failed (${reason}): ${err?.message || err}`);
      return baseMatches;
    }
  }

  private static async fetchTrade500GoalOddsMapFromJczq(dates: string[]): Promise<Trade500GoalOddsFallbackMap> {
    const byExact = new Map<string, ExternalGoalOdds[]>();
    const byMatchnum = new Map<string, ExternalGoalOdds[]>();
    const byPair = new Map<string, ExternalGoalOdds[]>();
    const byPairDate = new Map<string, ExternalGoalOdds[]>();
    for (const date of dates) {
      if (!date) continue;
      const html = await this.fetchTextWithCheck(`https://trade.500.com/jczq/?playid=270&g=2&date=${date}`, 'gb18030');
      const $ = load(html);
      $('tr.bet-tb-tr[data-processname], tr[data-processname]').each((_, element) => {
        const processName = String($(element).attr('data-processname') || '').trim();
        const processDate = this.normalizeLive500ProcessDate(
          String($(element).attr('data-processdate') || $(element).attr('data-matchdate') || date).trim()
        );
        if (!processName || !processDate) return;
        const goalOdds = this.getValidGoalOdds(
          $(element)
            .find('.td-betbtn .betbtn[data-type="jqs"], .betbtn[data-type="jqs"]')
            .map((__, button) => {
              const value = String($(button).attr('data-value') || '').trim();
              const odds = this.parseOdds($(button).attr('data-sp') || '');
              if (!/^[0-7]$/.test(value) || odds <= 0) return null;
              const label = value === '7' ? '7+球' : `${value}球`;
              return { label, odds } as ExternalGoalOdds;
            })
            .get()
            .filter(Boolean) as ExternalGoalOdds[]
        );
        if (goalOdds.length === 0) return;
        const exactKey = `${processDate}|${processName}`;
        byExact.set(exactKey, goalOdds);
        if (!byMatchnum.has(processName)) byMatchnum.set(processName, goalOdds);

        const matchDate = this.normalizeLive500ProcessDate(
          String($(element).attr('data-matchdate') || processDate).trim()
        );
        const matchTime = String($(element).attr('data-matchtime') || '').trim();
        const home = String($(element).attr('data-homesxname') || '').trim();
        const away = String($(element).attr('data-awaysxname') || '').trim();
        const kickoff = matchDate && /^\d{2}:\d{2}$/.test(matchTime) ? `${matchDate} ${matchTime}:00` : '';
        const pairKey = this.buildPairMinuteKey(kickoff, home, away);
        const pairDateKey = this.buildPairDateKey(kickoff || `${matchDate} 00:00:00`, home, away);
        if (pairKey && !byPair.has(pairKey)) byPair.set(pairKey, goalOdds);
        if (pairDateKey && !byPairDate.has(pairDateKey)) byPairDate.set(pairDateKey, goalOdds);
      });
    }
    console.log(`trade.500 JQS goal odds fallback map loaded exact=${byExact.size}, matchnum=${byMatchnum.size}`);
    return { byExact, byMatchnum, byPair, byPairDate };
  }

  private static buildSportteryTtgFallbackKey(matchTime?: string, homeTeam?: string, awayTeam?: string) {
    const normalizedTime = this.normalizeMatchTime(matchTime);
    const minute = normalizedTime.slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(minute)) return '';
    const home = this.normalizeNameForMatch(homeTeam);
    const away = this.normalizeNameForMatch(awayTeam);
    if (!home || !away) return '';
    return `${minute}|${home}|${away}`;
  }

  private static async fetchSportteryTtgMap() {
    const byExact = new Map<string, ExternalGoalOdds[]>();
    const byFallback = new Map<string, ExternalGoalOdds[]>();
    const body = await this.fetchTextWithCheck(SPORTTERY_TTG_URL);
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(body || ''));
    } catch {
      return { byExact, byFallback };
    }
    const matchInfoList = Array.isArray(parsed?.value?.matchInfoList) ? parsed.value.matchInfoList : [];
    for (const day of matchInfoList) {
      const subMatchList = Array.isArray(day?.subMatchList) ? day.subMatchList : [];
      for (const item of subMatchList) {
        const matchDate = String(item?.matchDate || '').trim();
        const matchNum = String(item?.matchNum || '').trim();
        const matchTime = String(item?.matchTime || '').trim();
        const homeTeam = String(item?.homeTeamAbbName || item?.homeTeamAllName || '').trim();
        const awayTeam = String(item?.awayTeamAbbName || item?.awayTeamAllName || '').trim();
        const ttg = item?.ttg || {};
        const goalOdds = this.getValidGoalOdds([
          { label: '0球', odds: Number(ttg?.s0 || 0) },
          { label: '1球', odds: Number(ttg?.s1 || 0) },
          { label: '2球', odds: Number(ttg?.s2 || 0) },
          { label: '3球', odds: Number(ttg?.s3 || 0) },
          { label: '4球', odds: Number(ttg?.s4 || 0) },
          { label: '5球', odds: Number(ttg?.s5 || 0) },
          { label: '6球', odds: Number(ttg?.s6 || 0) },
          { label: '7+球', odds: Number(ttg?.s7 || 0) },
        ]);
        if (!matchDate || !matchNum || goalOdds.length === 0) continue;
        byExact.set(`${matchDate}|${matchNum}`, goalOdds);
        const fallbackKey = this.buildSportteryTtgFallbackKey(`${matchDate} ${matchTime || '00:00:00'}`, homeTeam, awayTeam);
        if (fallbackKey) byFallback.set(fallbackKey, goalOdds);
      }
    }
    return { byExact, byFallback };
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
    const nspfKeySet = new Set(nspfRows.map((row) => `${row.date}|${row.matchnum}`));

    const out: Trade500XmlRow[] = [];
    for (const standard of nspfRows) {
      const key = `${standard.date}|${standard.matchnum}`;
      const handicap = spfMap.get(key);
      const dom = domHandicapMap.byExact.get(key) || domHandicapMap.byMatchnum.get(standard.matchnum);
      const effectiveMatchTime = dom?.matchTime || standard.matchTime || handicap?.matchTime;
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
      (out[out.length - 1] as any).__handicapOdds = handicap?.odds || { win: '-', draw: '-', lose: '-' };
      (out[out.length - 1] as any).__regularHandicap = dom?.regularHandicap || '0';
      (out[out.length - 1] as any).__jingcaiHandicap = dom?.jingcaiHandicap || (handicap ? '-' : '未开售');
    }

    for (const handicap of spfRows) {
      const key = `${handicap.date}|${handicap.matchnum}`;
      if (nspfKeySet.has(key)) continue;
      const dom = domHandicapMap.byExact.get(key) || domHandicapMap.byMatchnum.get(handicap.matchnum);
      out.push({
        date: handicap.date,
        matchnum: handicap.matchnum,
        league: handicap.league,
        homeTeam: handicap.homeTeam,
        awayTeam: handicap.awayTeam,
        matchTime: dom?.matchTime || handicap.matchTime,
        odds: { win: '-', draw: '-', lose: '-' },
      });
      (out[out.length - 1] as any).__handicapOdds = handicap.odds || { win: '-', draw: '-', lose: '-' };
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

          const rangCell = $(element).find('td.td-rang').first();
          const rangTextLines = String(rangCell.text() || '')
            .replace(/\r/g, '')
            .split(/\n+/)
            .map((line) => line.replace(/\s+/g, '').replace(/^单关/u, '').trim())
            .filter(Boolean);
          const signedInCell = (String(rangCell.text() || '').match(/[+-]\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/g) || [])
            .map((s) => s.trim())
            .filter(Boolean);
          const line0 = parts[0] || rangTextLines[0] || '';
          const line1 =
            parts[1] ||
            rangTextLines[1] ||
            signedInCell[0] ||
            String($(element).attr('data-rangqiu') || '').trim() ||
            '-';
          const regular = this.normalizeNumericHandicap(line0 || '0');
          const rawJingcai = line1;
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

  private static async fetchLive500CrownOddsMap(dates: string[]) {
    const fixtureMap = await this.fetchLive500FixtureMap(dates);
    const exactEntries = Array.from(fixtureMap.byExact.entries());
    const pairKeysByFid = new Map<string, string[]>();
    for (const [pairKey, fid] of fixtureMap.byPair.entries()) {
      if (!pairKey || !fid) continue;
      const list = pairKeysByFid.get(fid) || [];
      list.push(pairKey);
      pairKeysByFid.set(fid, list);
    }
    const oddsMap = new Map<string, ExternalOdds>();
    const queue = [...exactEntries];

    const workers = new Array(Math.min(LIVE500_CROWN_FETCH_CONCURRENCY, Math.max(queue.length, 1))).fill(null).map(async () => {
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) return;
        const [key, fid] = current;
        try {
          const odds = await this.fetchLive500CrownOddsByFixture(fid);
          if (!this.isValidExternalOdds(odds)) continue;
          oddsMap.set(key, odds);
          const matchnum = key.split('|')[1] || '';
          if (matchnum && !oddsMap.has(matchnum)) {
            oddsMap.set(matchnum, odds);
          }
          const pairKeys = pairKeysByFid.get(fid) || [];
          for (const pairKey of pairKeys) {
            if (pairKey && !oddsMap.has(pairKey)) {
              oddsMap.set(pairKey, odds);
            }
          }
        } catch (err: any) {
          console.warn(`live.500 crown odds fetch failed for ${key} (${fid}): ${err?.message || err}`);
        }
      }
    });

    await Promise.all(workers);
    console.log(`live.500 crown fallback fetched ${oddsMap.size} mapped odds entries`);
    return oddsMap;
  }

  private static async fetchLive500FixtureMap(dates: string[]): Promise<Live500FixtureMap> {
    const byExact = new Map<string, string>();
    const byMatchnum = new Map<string, string>();
    const byPair = new Map<string, string>();
    const byExactTeams = new Map<string, { home: string; away: string }>();
    const requestDates = Array.from(new Set((dates || []).map((d) => String(d || '').trim()).filter(Boolean)));
    const requestUrls = new Set<string>();
    for (const date of requestDates) {
      const ymd = this.normalizeMatchTime(date).slice(0, 10);
      const yymmdd = this.formatLive500ZqdcDateParam(ymd);
      if (ymd) requestUrls.add(`${LIVE500_JCZQ_URL}?e=${ymd}`);
      if (yymmdd) requestUrls.add(`${LIVE500_JCZQ_URL}?e=${yymmdd}`);
    }
    if (requestUrls.size === 0) {
      requestUrls.add(LIVE500_JCZQ_URL);
    }
    for (const url of requestUrls) {
      const html = await this.fetchTextWithCheck(url, 'gb18030');
      const rowRegex = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
      let match: RegExpExecArray | null;
      while ((match = rowRegex.exec(html)) !== null) {
        const attrsRaw = String(match[1] || '');
        const rowBody = String(match[2] || '');
        const order = this.readHtmlAttr(attrsRaw, 'order');
        const fid = this.readHtmlAttr(attrsRaw, 'fid');
        if (!order || !fid) continue;
        const matchDate = this.normalizeLive500ProcessDate(
          this.readHtmlAttr(attrsRaw, 'data-matchdate') || this.readHtmlAttr(attrsRaw, 'matchdate')
        );
        const processDate = this.normalizeLive500ProcessDate(this.readHtmlAttr(attrsRaw, 'data-processdate'));
        const dateFromUrl = this.normalizeLive500DateFromUrl(url);
        const primaryDate = matchDate || processDate || dateFromUrl;
        if (!primaryDate) continue;
        const exactKey = `${primaryDate}|${order}`;
        byExact.set(exactKey, fid);
        if (matchDate && matchDate !== primaryDate) byExact.set(`${matchDate}|${order}`, fid);
        if (processDate && processDate !== primaryDate) byExact.set(`${processDate}|${order}`, fid);
        if (dateFromUrl && dateFromUrl !== primaryDate) byExact.set(`${dateFromUrl}|${order}`, fid);
        if (!byMatchnum.has(order)) byMatchnum.set(order, fid);

        const gy = this.readHtmlAttr(attrsRaw, 'gy');
        const yy = this.readHtmlAttr(attrsRaw, 'yy');
        const kickOff = this.parseLive500KickOffTime(rowBody, primaryDate);
        const variants = [gy, yy];
        for (const variant of variants) {
          const parsed = this.parseLive500GyPair(variant);
          if (!parsed) continue;
          if (!byExactTeams.has(exactKey) && parsed.home && parsed.away) {
            byExactTeams.set(exactKey, { home: parsed.home, away: parsed.away });
          }
          const pairKey = this.buildLive500TeamPairKey(kickOff, parsed.home, parsed.away);
          if (pairKey && !byPair.has(pairKey)) {
            byPair.set(pairKey, fid);
          }
        }
      }
    }
    return { byExact, byMatchnum, byPair, byExactTeams };
  }

  private static normalizeLive500DateFromUrl(url: string) {
    const raw = String(url || '');
    const m = raw.match(/[?&]e=([^&]+)/i);
    if (!m) return '';
    return this.normalizeLive500ProcessDate(m[1] || '');
  }

  private static normalizeLive500ProcessDate(raw?: string) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    if (/^\d{8}$/.test(text)) {
      const y = text.slice(0, 4);
      const mo = text.slice(4, 6);
      const d = text.slice(6, 8);
      return `${y}-${mo}-${d}`;
    }
    if (/^\d{6}$/.test(text)) {
      const yy = Number.parseInt(text.slice(0, 2), 10);
      const year = yy >= 70 ? 1900 + yy : 2000 + yy;
      const mo = text.slice(2, 4);
      const d = text.slice(4, 6);
      return `${year}-${mo}-${d}`;
    }
    const normalized = this.normalizeMatchTime(text).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
  }

  private static autoUpsertAliasFromExactMatches(baseMatches: ExternalMatch[], fixtureMap: Live500FixtureMap) {
    if (!Array.isArray(baseMatches) || baseMatches.length === 0) return;
    if (!fixtureMap?.byExactTeams || fixtureMap.byExactTeams.size === 0) return;
    let added = 0;
    let skipped = 0;
    for (const match of baseMatches) {
      const key = String(match.id || '').trim();
      if (!key) continue;
      const teams = fixtureMap.byExactTeams.get(key);
      if (!teams) continue;
      const pairs: Array<[string, string]> = [
        [String(match.homeTeam || '').trim(), String(teams.home || '').trim()],
        [String(match.awayTeam || '').trim(), String(teams.away || '').trim()],
      ];
      for (const [jingcaiName, huangguanName] of pairs) {
        const leftNorm = this.normalizeAliasName(jingcaiName);
        const rightNorm = this.normalizeAliasName(huangguanName);
        if (!leftNorm || !rightNorm || leftNorm === rightNorm) {
          skipped += 1;
          continue;
        }
        const result = this.applyPendingHgaAliasSuggestion(jingcaiName, huangguanName);
        if (result.status === 'ok') added += 1;
        else skipped += 1;
      }
    }
    if (added > 0 || skipped > 0) {
      console.log(`alias auto-upsert from live500 exact matches: added=${added}, skipped=${skipped}`);
    }
  }

  private static parseLive500GyPair(raw?: string) {
    const parts = String(raw || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 3) return null;
    return {
      home: parts[1],
      away: parts[2],
    };
  }

  private static readHtmlAttr(attrsRaw: string, attrName: string) {
    const escaped = String(attrName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*([\"'])(.*?)\\1`, 'i');
    return (attrsRaw.match(regex)?.[2] || '').trim();
  }

  private static parseLive500KickOffTime(rowHtml: string, fallbackDate: string) {
    const plain = String(rowHtml || '').replace(/<[^>]+>/g, ' ');
    const mdhm = plain.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    const hhmm = plain.match(/(\d{2}):(\d{2})/);
    const baseDate = this.normalizeMatchTime(fallbackDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return '';
    const year = baseDate.slice(0, 4);
    if (mdhm) {
      const month = mdhm[1];
      const day = mdhm[2];
      const hh = mdhm[3];
      const mm = mdhm[4];
      return `${year}-${month}-${day} ${hh}:${mm}:00`;
    }
    if (hhmm) {
      const hh = hhmm[1];
      const mm = hhmm[2];
      return `${baseDate} ${hh}:${mm}:00`;
    }
    return `${baseDate} 00:00:00`;
  }

  private static async fetchLive500CrownOddsByFixture(fid: string): Promise<ExternalOdds | null> {
    const html = await this.fetchTextWithCheck(`${ODDS500_OUZHI_URL}${fid}.shtml`, 'gb18030');
    const rowPattern = new RegExp(
      `<tr[^>]+id="${LIVE500_CROWN_COMPANY_ID}"[^>]*>[\\s\\S]*?<table[^>]*class="pl_table_data"[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>[\\s\\S]*?<\\/table>`,
      'i'
    );
    const tbody = html.match(rowPattern)?.[1] || '';
    if (!tbody) return null;

    const trMatches = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const targetTr = trMatches[1]?.[1] || trMatches[0]?.[1] || '';
    if (!targetTr) return null;

    const values = [...targetTr.matchAll(/>\s*([0-9]+(?:\.[0-9]+)?)\s*</g)].map((item) => item[1]);
    if (values.length < 3) return null;
    return {
      win: values[0],
      draw: values[1],
      lose: values[2],
    };
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

  private static isValidExternalOdds(odds?: ExternalOdds | null) {
    return this.parseOdds(odds?.win) > 0 && this.parseOdds(odds?.draw) > 0 && this.parseOdds(odds?.lose) > 0;
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
    if (/受/.test(raw)) return `+${base}`;
    if (/让/.test(raw)) return `-${base}`;

    // trade.500 的 data-rangqiu 常见为无显式正号的数值（如 1 / 0.5/1），语义是主队受让（正盘）。
    // 这里显式补成正号，避免后续再靠赔率推断导致盘口符号翻转。
    const first = Number.parseFloat(base.split('/')[0]);
    if (Number.isFinite(first) && first > 0) return `+${base}`;
    return base;
  }

  private static resolveSourceKey(urlOrHost: string): SourceKey {
    const raw = String(urlOrHost || '').toLowerCase();
    if (!raw) return 'other';
    if (raw.includes('hga050.com') || raw.includes('transform_nl.php') || raw.includes('transform.php')) return 'hga';
    if (raw.includes('sporttery.cn')) return 'sporttery';
    if (raw.includes('live.500.com')) return 'live500';
    if (raw.includes('odds.500.com')) return 'odds500';
    if (raw.includes('trade.500.com') || raw.includes('www.500.com') || raw.includes('ews.500.com')) return 'trade500';
    return 'other';
  }

  private static getSourceCircuitMeta(source: SourceKey) {
    return (
      this.sourceFailureMeta.get(source) || {
        failCount: 0,
        openUntilMs: 0,
        lastReason: '',
      }
    );
  }

  private static isInternalSourceThrottleReason(reason: string) {
    const text = String(reason || '');
    return text.startsWith('SOURCE_BUDGET_TIMEOUT:') || text.startsWith('SOURCE_CIRCUIT_OPEN:');
  }

  private static clearSourceFailureMeta(source: SourceKey) {
    this.sourceFailureMeta.set(source, {
      failCount: 0,
      openUntilMs: 0,
      lastReason: '',
    });
  }

  private static isSourceCircuitOpen(source: SourceKey) {
    const meta = this.getSourceCircuitMeta(source);
    return meta.openUntilMs > Date.now();
  }

  private static markSourceFailure(source: SourceKey, reason: string) {
    if (this.isInternalSourceThrottleReason(reason)) {
      return;
    }
    const config = SOURCE_BUDGET_CONFIG[source];
    const prev = this.getSourceCircuitMeta(source);
    const nextFailCount = (prev.failCount || 0) + 1;
    const shouldOpen = nextFailCount >= config.circuitFailThreshold;
    const openUntilMs = shouldOpen ? Date.now() + config.circuitOpenMs : prev.openUntilMs;
    const next = {
      failCount: shouldOpen ? 0 : nextFailCount,
      openUntilMs,
      lastReason: String(reason || '').slice(0, 180),
    };
    this.sourceFailureMeta.set(source, next);
    if (shouldOpen) {
      console.warn(`source circuit opened: ${source}, until=${new Date(openUntilMs).toISOString()}, reason=${next.lastReason}`);
    }
  }

  private static markSourceSuccess(source: SourceKey) {
    const prev = this.getSourceCircuitMeta(source);
    if (prev.failCount === 0 && prev.openUntilMs <= Date.now()) return;
    this.sourceFailureMeta.set(source, {
      failCount: 0,
      openUntilMs: 0,
      lastReason: '',
    });
  }

  private static async acquireSourceBudget(source: SourceKey) {
    const config = SOURCE_BUDGET_CONFIG[source];
    const startedAt = Date.now();
    while (true) {
      const now = Date.now();
      const meta = this.getSourceCircuitMeta(source);
      if (meta.openUntilMs > now) {
        throw new Error(`SOURCE_CIRCUIT_OPEN:${source}:${meta.lastReason || 'cooldown'}`);
      }
      const active = this.sourceActiveCount.get(source) || 0;
      const nextAllowedAt = this.sourceNextAllowedAtMs.get(source) || 0;
      if (active < config.maxConcurrent && now >= nextAllowedAt) {
        this.sourceActiveCount.set(source, active + 1);
        const jitter = Math.floor(Math.random() * Math.max(0, config.jitterMs));
        this.sourceNextAllowedAtMs.set(source, now + config.minIntervalMs + jitter);
        return () => {
          const curr = this.sourceActiveCount.get(source) || 0;
          this.sourceActiveCount.set(source, Math.max(0, curr - 1));
        };
      }
      if (now - startedAt > SOURCE_BUDGET_TIMEOUT_MS) {
        throw new Error(`SOURCE_BUDGET_TIMEOUT:${source}`);
      }
      await this.sleep(50);
    }
  }

  private static async fetchTextWithCheck(url: string, encoding: string = 'utf-8') {
    let lastErr: any = null;
    const cached = HTTP_TEXT_CACHE.get(url);
    const source = this.resolveSourceKey(url);
    const isSportteryApi = /webapi\.sporttery\.cn/i.test(String(url || ''));
    for (let i = 0; i < 3; i++) {
      let releaseBudget: (() => void) | null = null;
      try {
        releaseBudget = await this.acquireSourceBudget(source);
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
          this.markSourceSuccess(source);
          return cached.body;
        }
        if (!response.ok) {
          if (isSportteryApi) {
            const browserText = await this.fetchSportteryTextViaPlaywright(url).catch(() => '');
            if (browserText) {
              HTTP_TEXT_CACHE.set(url, {
                body: browserText,
                etag: response.headers.get('etag') || undefined,
                lastModified: response.headers.get('last-modified') || undefined,
              });
              this.markSourceSuccess(source);
              console.warn(`Sporttery API browser fallback succeeded: status=${response.status} url=${url}`);
              return browserText;
            }
          }
          lastErr = new Error(`request failed: ${response.status} ${url}`);
          this.markSourceFailure(source, `http_${response.status}`);
          if (response.status === 429) {
            await this.sleep(220 + i * 180);
          }
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const text = new TextDecoder(encoding).decode(buffer);
        if (isSportteryApi) {
          const trimmed = String(text || '').trim();
          const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
          // Sporttery intercept pages are often very short/non-JSON; force browser fallback.
          if (!looksLikeJson || trimmed.length < 200) {
            const browserText = await this.fetchSportteryTextViaPlaywright(url).catch(() => '');
            if (browserText) {
              HTTP_TEXT_CACHE.set(url, {
                body: browserText,
                etag: response.headers.get('etag') || undefined,
                lastModified: response.headers.get('last-modified') || undefined,
              });
              this.markSourceSuccess(source);
              console.warn(`Sporttery API browser fallback replaced invalid raw response: len=${trimmed.length} url=${url}`);
              return browserText;
            }
          }
        }
        HTTP_TEXT_CACHE.set(url, {
          body: text,
          etag: response.headers.get('etag') || undefined,
          lastModified: response.headers.get('last-modified') || undefined,
        });
        this.markSourceSuccess(source);
        return text;
      } catch (err: any) {
        lastErr = err;
        this.markSourceFailure(source, String(err?.message || err || 'request_error'));
      } finally {
        if (releaseBudget) releaseBudget();
      }
    }
    throw lastErr || new Error(`request failed: ${url}`);
  }

  private static async fetchSportteryTextViaPlaywright(url: string): Promise<string> {
    const target = String(url || '').trim();
    if (!target) return '';
    const mod = require('./scraper/playwright-scraper-full.cjs');
    if (!mod || typeof mod.fetchRawTextViaBrowser !== 'function') return '';
    const text = await this.withTimeout(
      mod.fetchRawTextViaBrowser(target),
      30000,
      'Sporttery browser fallback timeout'
    );
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    return looksLikeJson ? trimmed : '';
  }

  private static mergeTrade500JingcaiData(legacyMatches: ExternalMatch[], tradeRows: Trade500XmlRow[]) {
    if (legacyMatches.length === 0 || tradeRows.length === 0) {
      return legacyMatches;
    }

    const grouped = new Map<string, Trade500XmlRow[]>();
    const byExactId = new Map<string, Trade500XmlRow[]>();
    for (const item of tradeRows) {
      const key = `${this.normalizeNameForMatch(item.homeTeam)}|${this.normalizeNameForMatch(item.awayTeam)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
      const exactId = `${String(item.date || '').trim()}|${String(item.matchnum || '').trim()}`;
      if (exactId && exactId.includes('|')) {
        if (!byExactId.has(exactId)) byExactId.set(exactId, []);
        byExactId.get(exactId)!.push(item);
      }
    }
    for (const rows of grouped.values()) {
      rows.sort((a, b) => a.matchTime.localeCompare(b.matchTime));
    }
    for (const rows of byExactId.values()) {
      rows.sort((a, b) => a.matchTime.localeCompare(b.matchTime));
    }

    let patchedCount = 0;
    const isUnavailableHandicap = (value?: string) => {
      const text = String(value || '').trim();
      return !text || text === '-' || text === '未开售';
    };
    const merged = legacyMatches.map((legacy) => {
      const key = `${this.normalizeNameForMatch(legacy.homeTeam)}|${this.normalizeNameForMatch(legacy.awayTeam)}`;
      const exactCandidates = byExactId.get(String(legacy.id || '').trim()) || [];
      const candidates = exactCandidates.length > 0 ? exactCandidates : grouped.get(key) || [];
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

      // Trade500 XML 仅提供让球赔率，不稳定提供让球盘口文本。
      // 当盘口文本缺失时，不能用“未开售/0”覆盖已有有效盘口。
      const normalizedRegular = this.normalizeNumericHandicap(regularHandicap);
      const normalizedJc = this.normalizeSignedHandicap(jingcaiHandicap);
      const legacyRegular = this.normalizeNumericHandicap(legacy.handicap);
      const legacyJc = this.normalizeSignedHandicap(legacy.jingcaiHandicap);
      const nextRegular =
        normalizedRegular && normalizedRegular !== '0'
          ? normalizedRegular
          : legacyRegular || normalizedRegular || legacy.handicap || '0';
      const nextJc =
        !isUnavailableHandicap(normalizedJc)
          ? normalizedJc
          : !isUnavailableHandicap(legacyJc)
            ? legacyJc
            : !isUnavailableHandicap(nextRegular)
              ? this.normalizeSignedHandicap(nextRegular) || nextRegular
              : legacy.jingcaiHandicap || '-';

      patchedCount += 1;
      return {
        ...legacy,
        handicap: nextRegular || legacy.handicap || '0',
        jingcaiHandicap: nextJc || legacy.jingcaiHandicap || '-',
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
      return this.getValidCrownHandicaps(match.crownHandicaps, match);
    }

    const rawHandicap = this.resolveHandicapType(match.crownAsia?.handicap, match);
    const homeOdds = this.parseOdds(match.crownAsia?.homeWater);
    const awayOdds = this.parseOdds(match.crownAsia?.awayWater);

    if (!rawHandicap || !homeOdds || !awayOdds) {
      return [];
    }

    return this.getValidCrownHandicaps([
      {
        type: rawHandicap,
        home_odds: homeOdds,
        away_odds: awayOdds,
      },
    ], match);
  }

  private static getValidCrownHandicaps(items: ExternalHandicap[], match?: ExternalMatch) {
    const normalized = items
      .filter((item) => item && item.type && item.home_odds > 0 && item.away_odds > 0)
      .map((item) => ({
        type: this.resolveHandicapType(String(item.type || ''), match) || String(item.type || ''),
        home_odds: Number(item.home_odds),
        away_odds: Number(item.away_odds),
      }));

    const directionAligned = this.alignHandicapDirectionByMatchContext(normalized, match);
    const seen = new Set<string>();
    const seenMirror = new Set<string>();
    const deduped = directionAligned.filter((item) => {
      const key = item.type;
      const mirrorKey = key.replace(/^[+-]/, '');
      // 镜像盘口（如 -0.5 / +0.5）本质同一组，让球仅保留一条，避免重复显示与重复参与计算。
      if (seen.has(key) || seenMirror.has(mirrorKey)) return false;
      seen.add(key);
      seenMirror.add(mirrorKey);
      return true;
    });

    deduped.sort((a, b) => this.getHandicapSortValue(a.type) - this.getHandicapSortValue(b.type));
    return deduped.slice(0, CROWN_HANDICAP_STORE_LIMIT);
  }

  private static alignHandicapDirectionByMatchContext(items: ExternalHandicap[], match?: ExternalMatch) {
    if (!match || !Array.isArray(items) || items.length === 0) return items;
    const expectedSign = this.getExpectedHomeHandicapSign(match);
    if (expectedSign !== '+' && expectedSign !== '-') return items;

    const isStrasbourg = (match.homeTeam || '').includes('斯特拉斯堡') || (match.awayTeam || '').includes('斯特拉斯堡');

    // 增加严格检查：只有当预期方向来源于皇冠自身的胜平负赔率时，才允许进行强制翻转。
    const crownInferred = this.inferHomeHandicapSign(match);
    const isHighConfidence = !!crownInferred;

    if (isStrasbourg) {
      console.log(`[debug-align] Strasbourg match. expectedSign: ${expectedSign}, crownInferred: ${crownInferred}, isHighConfidence: ${isHighConfidence}`);
      console.log(`[debug-align] Items before: ${JSON.stringify(items)}`);
    }

    const normalized = items.map((item) => ({
      ...item,
      type: this.resolveHandicapType(item.type, match) || item.type,
    }));
    const nonZero = normalized.filter((item) => !this.isZeroHandicapType(item.type));
    if (nonZero.length === 0) return normalized;

    const sameDir = nonZero.filter((item) => String(item.type || '').startsWith(expectedSign));
    const oppositeDir = nonZero.filter((item) => String(item.type || '').startsWith(expectedSign === '+' ? '-' : '+'));
    const keep = normalized.filter(
      (item) => this.isZeroHandicapType(item.type) || String(item.type || '').startsWith(expectedSign)
    );

    // 如果已经有符合预期方向的盘口，直接返回（过滤掉不符合方向的杂质）
    if (sameDir.length > 0) return keep;

    // 如果所有非零盘口都与预期方向相反，且我们有高信心（SPF 赔率支持），则进行翻转
    if (oppositeDir.length > 0 && isHighConfidence) {
      return normalized.map((item) => {
        if (this.isZeroHandicapType(item.type)) return item;
        const type = String(item.type || '');
        const flippedType = type.startsWith('-') ? `+${type.slice(1)}` : type.startsWith('+') ? `-${type.slice(1)}` : type;
        return {
          type: flippedType,
          home_odds: item.home_odds,
          away_odds: item.away_odds,
        };
      });
    }

    // 如果没有高信心，或者方向混杂，我们选择尊重原始数据，不进行强制翻转
    return normalized;
  }

  private static getValidGoalOdds(items: ExternalGoalOdds[]) {
    const orderMap = new Map<string, number>(GOAL_LABEL_ORDER.map((label, index) => [label, index]));
    const normalized = (Array.isArray(items) ? items : [])
      .map((item) => ({
        label: String(item?.label || '').trim(),
        odds: Number(item?.odds || 0),
      }))
      .filter((item) => orderMap.has(item.label) && Number.isFinite(item.odds) && item.odds > 0);

    const dedup = new Map<string, ExternalGoalOdds>();
    for (const item of normalized) {
      if (!dedup.has(item.label)) {
        dedup.set(item.label, item);
      }
    }

    return GOAL_LABEL_ORDER
      .map((label) => dedup.get(label))
      .filter((item): item is ExternalGoalOdds => Boolean(item));
  }

  private static normalizeOuLine(value?: string) {
    const text = String(value || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[()（）]/g, '');
    if (!text) return '';
    const first = text.match(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/);
    return first ? first[0] : '';
  }

  private static parseOuLineSortValue(line?: string) {
    const normalized = this.normalizeOuLine(line);
    if (!normalized) return Number.POSITIVE_INFINITY;
    if (normalized.includes('/')) {
      const parts = normalized
        .split('/')
        .map((part) => Number.parseFloat(part))
        .filter((part) => Number.isFinite(part));
      if (parts.length === 2) return (parts[0] + parts[1]) / 2;
    }
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  }

  private static getValidOverUnderOdds(items: ExternalOverUnderOdds[]) {
    const dedup = new Map<string, ExternalOverUnderOdds>();
    for (const item of Array.isArray(items) ? items : []) {
      const line = this.normalizeOuLine(item?.line);
      const overOdds = Number(item?.over_odds || 0);
      const underOdds = Number(item?.under_odds || 0);
      if (!line || !Number.isFinite(overOdds) || !Number.isFinite(underOdds)) continue;
      if (overOdds <= 0 || underOdds <= 0) continue;
      if (dedup.has(line)) continue;
      dedup.set(line, { line, over_odds: overOdds, under_odds: underOdds });
    }
    return Array.from(dedup.values()).sort((a, b) => this.parseOuLineSortValue(a.line) - this.parseOuLineSortValue(b.line));
  }

  private static inferHandicapSignFromRaw(value?: string) {
    if (!value) return '';

    const cleaned = String(value)
      .trim()
      .replace(/\s+/g, '')
      .replace(/[()（）]/g, '')
      .replace(/[\u5347\u964d]$/u, '');

    if (!cleaned) return '';
    if (cleaned.startsWith('+')) return '+';
    if (cleaned.startsWith('-')) return '-';
    if (cleaned.startsWith('\u53d7\u8ba9')) return '+';
    if (cleaned.startsWith('\u53d7')) return '+';
    if (cleaned.startsWith('\u8ba9')) return '-';
    if (cleaned.includes('\u53d7')) return '+';
    return '';
  }

  private static resolveHandicapType(value?: string, match?: ExternalMatch) {
    const normalized = this.normalizeHandicapV2(value);
    if (!normalized) return null;
    if (/^[+-]/.test(normalized)) return normalized;

    const sign =
      this.inferHandicapSignFromRaw(value) ||
      this.inferHandicapSignFromRaw(match?.crownAsia?.handicap) ||
      (match ? this.getExpectedHomeHandicapSign(match) : '') ||
      (match ? this.inferHomeHandicapSign(match) : '');

    return sign ? `${sign}${normalized}` : normalized;
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

  /**
   * If incoming handicap direction flips against current baseline and the line gap is large,
   * treat it as likely wrong-match contamination.
   */
  private static hasSevereHandicapConflict(current: ExternalHandicap[], incoming: ExternalHandicap[], match?: ExternalMatch) {
    const currentMain = this.getValidCrownHandicaps(current || [], match)[0];
    const incomingMain = this.getValidCrownHandicaps(incoming || [], match)[0];
    if (!currentMain || !incomingMain) return false;

    const currentType = this.resolveHandicapType(currentMain.type, match) || currentMain.type;
    const incomingType = this.resolveHandicapType(incomingMain.type, match) || incomingMain.type;
    const currentSort = this.getHandicapSortValue(currentType);
    const incomingSort = this.getHandicapSortValue(incomingType);
    if (!Number.isFinite(currentSort) || !Number.isFinite(incomingSort)) return false;
    if (Math.abs(currentSort) < 1e-6 || Math.abs(incomingSort) < 1e-6) return false;

    const signConflict = Math.sign(currentSort) !== Math.sign(incomingSort);
    const lineGap = Math.abs(currentSort - incomingSort);
    const expectedSign = this.getExpectedHomeHandicapSign(match);
    const incomingSignWrong =
      (expectedSign === '+' && incomingSort < 0) ||
      (expectedSign === '-' && incomingSort > 0);
    if (incomingSignWrong && lineGap >= 0.5) return true;
    return signConflict && lineGap >= 0.75;
  }

  private static isZeroHandicapType(type?: string) {
    const normalized = this.normalizeHandicapV2(type);
    if (!normalized) return false;
    return normalized.replace(/^[+-]/, '') === '0';
  }

  private static inferHomeHandicapSign(match: ExternalMatch) {
    const homeWin = this.parseOdds(match.crownOdds?.win);
    const awayWin = this.parseOdds(match.crownOdds?.lose);
    if (homeWin > 0 && awayWin > 0) {
      return homeWin <= awayWin ? '-' : '+';
    }

    return null;
  }

  private static parseHandicapMagnitude(value?: string): number {
    if (!value) return 0;
    const clean = value.replace(/[+-]/, '');
    if (clean.includes('/')) {
      const parts = clean.split('/');
      return (Number(parts[0]) + Number(parts[1])) / 2;
    }
    return Math.abs(Number(clean));
  }

  private static getExpectedHomeHandicapSign(match?: ExternalMatch) {
    if (!match) return '';

    const isStrasbourg = (match.homeTeam || '').includes('斯特拉斯堡') || (match.awayTeam || '').includes('斯特拉斯堡');

    // 优先 1：使用皇冠自身的胜平负赔率推断让球方向（皇冠数据应保持内部逻辑一致性）
    const crownInferred = this.inferHomeHandicapSign(match);
    if (isStrasbourg) {
      console.log(`[debug-sign] Strasbourg match. crownOdds: ${JSON.stringify(match.crownOdds)}, crownInferred: ${crownInferred}`);
    }
    if (crownInferred) return crownInferred;

    // 优先 2：参考竞彩的让球方向（作为市场共识的补充参考）
    const jcLine = this.normalizeHandicapV2(match.jingcaiHandicap);
    if (isStrasbourg) {
      console.log(`[debug-sign] Strasbourg match. jcLine: ${jcLine}`);
    }
    if (jcLine?.startsWith('+') || jcLine?.startsWith('-')) {
      // 增加安全检查：如果竞彩是深盘（如 -1/+1），而皇冠盘口非常小（如 0.25），
      // 此时竞彩的方向可能并不适用于皇冠（可能存在反向开盘），不应盲目信任。
      const jcAbs = this.parseHandicapMagnitude(jcLine);
      const crownHandicaps = this.buildHandicaps(match);
      const crownMainLine = crownHandicaps[0]?.type;
      const crownAbs = this.parseHandicapMagnitude(crownMainLine);

      if (jcAbs >= 1.0 && crownAbs <= 0.25 && crownAbs > 0) {
        if (isStrasbourg) {
          console.log(`[debug-sign] Strasbourg match. Discrepancy detected: jcAbs=${jcAbs}, crownAbs=${crownAbs}. Ignoring jcLine sign.`);
        }
        return ''; // 强制返回空，不使用竞彩的错误方向
      } else {
        return jcLine[0];
      }
    }

    // 优先 3：参考基础数据的让球方向
    const baseLine = this.normalizeHandicapV2(match.handicap);
    if (baseLine?.startsWith('+') || baseLine?.startsWith('-')) return baseLine[0];

    return '-'; // 默认假设主队为强队
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

  private static async fetchHgaMatches(targetMatches: ExternalMatch[] = []): Promise<HgaMatch[]> {
    const tune = this.getHgaTuningParams().effective;
    const { username, password } = this.getHgaConfig();
    if (!username || !password) {
      throw new Error('HGA 配置缺失');
    }
    let uid = await this.withTimeout(
      this.getHgaUid(username, password),
      tune.login_timeout_ms,
      'HGA login phase timeout'
    );
    if (!uid) throw new Error('HGA login failed');

    const todayResult = await this.withTimeout(
      this.fetchHgaGameListXmlWithRetry(uid, username, password, 'today', ''),
      tune.list_timeout_ms,
      'HGA list phase timeout: today'
    );
    uid = todayResult.uid;
    await this.sleep(160);
    const earlyAllResult = await this.withTimeout(
      this.fetchHgaGameListXmlWithRetry(uid, username, password, 'early', 'all'),
      tune.list_timeout_ms,
      'HGA list phase timeout: early-all'
    );
    uid = earlyAllResult.uid;
    await this.sleep(160);
    const earlyResult = await this.withTimeout(
      this.fetchHgaGameListXmlWithRetry(uid, username, password, 'early', ''),
      tune.list_timeout_ms,
      'HGA list phase timeout: early'
    );
    uid = earlyResult.uid;

    const listXmls = [todayResult.xml, earlyAllResult.xml, earlyResult.xml];

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

    const relevantMatches = targetMatches.length > 0 ? this.selectRelevantHgaMatches(targetMatches, baseMatches) : baseMatches;
    if (relevantMatches.length === 0) return [];

    const enriched = await this.enrichHgaHandicapsV2(uid, username, password, relevantMatches);
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

  private static async fetchHgaGameListXmlWithRetry(
    uid: string,
    username: string,
    password: string,
    showtype: string,
    date: string
  ) {
    let currentUid = uid;
    let xml = await this.fetchHgaGameListXml(currentUid, showtype, date);
    if (this.isHgaDoubleLoginXml(xml)) {
      const nextUid = await this.getHgaUid(username, password, true);
      if (!nextUid) {
        throw new Error(`${HGA_DOUBLE_LOGIN}: relogin failed`);
      }
      currentUid = nextUid;
      await this.sleep(160);
      xml = await this.fetchHgaGameListXml(currentUid, showtype, date);
    }
    return { uid: currentUid, xml };
  }

  private static async getHgaUid(username: string, password: string, force = false) {
    const now = Date.now();
    if (force) {
      this.clearHgaSessionCache();
    }
    if (!force && this.hgaSessionCache) {
      const sameUser = this.hgaSessionCache.username === username && this.hgaSessionCache.password === password;
      const freshEnough = now - this.hgaSessionCache.updatedAtMs < 25 * 60 * 1000;
      if (sameUser && freshEnough && this.hgaSessionCache.uid) {
        return this.hgaSessionCache.uid;
      }
    }
    const uid = await this.hgaLogin(username, password);
    if (uid) {
      this.hgaSessionCache = {
        uid,
        username,
        password,
        updatedAtMs: now,
      };
    } else {
      this.clearHgaSessionCache();
    }
    return uid;
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
      if (this.isHgaCredentialError(String(codeMessage))) {
        throw new Error(
          `${HGA_CREDENTIALS_INVALID}: 检测到 HGA 账号或密码错误，已自动关闭 HGA 抓取，请更新配置后手动重新开启`
        );
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
    const alternateBaseUrl = baseUrl === HGA_BASE_URL ? HGA_ALT_BASE_URL : HGA_BASE_URL;
    const candidateBaseUrls = Array.from(new Set([baseUrl, alternateBaseUrl]));
    for (let i = 0; i < 4; i++) {
      for (const candidateUrl of candidateBaseUrls) {
        let releaseBudget: (() => void) | null = null;
        try {
          releaseBudget = await this.acquireSourceBudget('hga');
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 18000);
          let res: Response;
          try {
            res = await fetch(candidateUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              },
              body: params.toString(),
              signal: controller.signal,
              dispatcher: HGA_HTTP_AGENT as any,
            } as any);
          } finally {
            clearTimeout(timeout);
          }
          if (!res.ok) {
            lastErr = new Error(`HGA request failed: ${res.status}`);
            this.markSourceFailure('hga', `http_${res.status}`);
            if (res.status === 429 || res.status === 503) {
              await this.sleep(200 + i * 180);
            }
            continue;
          }
          this.markSourceSuccess('hga');
          return await res.text();
        } catch (err: any) {
          lastErr = err;
          this.markSourceFailure('hga', String(err?.message || err || 'hga_request_error'));
        } finally {
          if (releaseBudget) releaseBudget();
        }
        await new Promise((resolve) => setTimeout(resolve, 100 + i * 120));
      }
      await new Promise((resolve) => setTimeout(resolve, 140 * (i + 1)));
    }
    throw lastErr || new Error('HGA request failed');
  }

  private static isHgaDoubleLoginXml(xml: string) {
    const text = String(xml || '');
    return text.includes('<msg>doubleLogin</msg>') || text.includes('doubleLogin');
  }

  private static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      const mainType = this.normalizeHgaRType(mainLine, strong, crownOdds.win, crownOdds.lose, true);
      const mainHandicaps: ExternalHandicap[] =
        mainType && mainHome > 0 && mainAway > 0
          ? [{ type: mainType, home_odds: mainHome, away_odds: mainAway }]
          : [];
      const mainOuLine = this.normalizeOuLine(this.extractXmlTag(block, 'RATIO_OUO') || this.extractXmlTag(block, 'RATIO_OUU'));
      // HGA OU 实测口径：IOR_OUC 对应“大”，IOR_OUH 对应“小”
      const mainOuOverOdds = this.parseOdds(this.extractXmlTag(block, 'IOR_OUC'));
      const mainOuUnderOdds = this.parseOdds(this.extractXmlTag(block, 'IOR_OUH'));
      const mainOverUnderOdds = this.getValidOverUnderOdds(
        mainOuLine && mainOuOverOdds > 0 && mainOuUnderOdds > 0
          ? [{ line: mainOuLine, over_odds: mainOuOverOdds, under_odds: mainOuUnderOdds }]
          : []
      );

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
        overUnderOdds: mainOverUnderOdds,
      });
    }
    return games;
  }

  private static async enrichHgaHandicaps(uid: string, username: string, password: string, matches: HgaMatch[]) {
    const concurrency = HGA_OBT_CONCURRENCY;
    let currentUid = uid;
    let reloginPromise: Promise<string | null> | null = null;
    const ensureUid = async (force = false) => {
      if (!force && currentUid) return currentUid;
      if (!reloginPromise) {
        reloginPromise = this.getHgaUid(username, password, true).finally(() => {
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
    const tune = this.getHgaTuningParams().effective;
    const concurrency = tune.obt_concurrency;
    let currentUid = uid;
    let reloginPromise: Promise<string | null> | null = null;
    const ensureUid = async (force = false) => {
      if (!force && currentUid) return currentUid;
      if (!reloginPromise) {
        reloginPromise = this.getHgaUid(username, password, true).finally(() => {
          reloginPromise = null;
        });
      }
      const refreshed = await reloginPromise;
      if (refreshed) currentUid = refreshed;
      return currentUid;
    };

    // `get_game_list` 阶段拿到的 uid 在部分时段对 `get_game_OBT` 会短暂失效，
    // 先主动刷新一次，降低后续明细抓取直接回退到主盘口的概率。
    await ensureUid(true);

    await ensureUid(true);

    const processOneMatch = async (index: number) => {
      const match = matches[index];
      const maxAttempts = this.getHgaSingleMatchRetryBudget(match.ecid, tune.obt_batch_retry);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const activeUid = await ensureUid(attempt > 0);
          if (!activeUid) return false;
          const full = await this.withTimeout(
            this.fetchHgaObtHandicapsWithRetryV2(activeUid, match),
            tune.market_item_timeout_ms,
            `HGA market item timeout:${match.ecid}`
          );
          const currentHandicaps = this.getValidCrownHandicaps(match.handicaps || []);
          const currentOverUnderOdds = this.getValidOverUnderOdds(match.overUnderOdds || []);
          const nextHandicaps = this.mergeHandicapCandidates(full.handicaps || [], currentHandicaps);
          const nextOverUnderOdds = this.getValidOverUnderOdds([...(full.overUnderOdds || []), ...currentOverUnderOdds]);
          if (nextHandicaps.length > 0 || nextOverUnderOdds.length > 0) {
            matches[index] = {
              ...match,
              handicaps: nextHandicaps,
              overUnderOdds: nextOverUnderOdds,
            };
          }
          if (this.isHgaMatchDataSufficient(nextHandicaps, nextOverUnderOdds)) {
            return true;
          }
          return true;
        } catch (err: any) {
          const errText = String(err?.message || err || '');
          if (errText === HGA_SESSION_EXPIRED || errText.includes(HGA_SESSION_EXPIRED)) {
            const refreshedUid = await ensureUid(true);
            if (refreshedUid) {
              try {
                const rescueShowtype: 'today' | 'early' = match.sourceShowtype === 'early' ? 'early' : 'today';
                const rescueIsEarly: 'N' | 'Y' = rescueShowtype === 'early' ? 'Y' : 'N';
                const rescue = await this.withTimeout(
                  this.fetchHgaObtMarkets(refreshedUid, match.ecid, match.strong, rescueShowtype, rescueIsEarly, 'OU|MIX'),
                  tune.market_item_timeout_ms,
                  `HGA market rescue timeout:${match.ecid}`
                );
                const currentHandicaps = this.getValidCrownHandicaps(match.handicaps || []);
                const currentOverUnderOdds = this.getValidOverUnderOdds(match.overUnderOdds || []);
                const nextHandicaps = this.mergeHandicapCandidates(rescue.handicaps || [], currentHandicaps);
                const nextOverUnderOdds = this.getValidOverUnderOdds([...(rescue.overUnderOdds || []), ...currentOverUnderOdds]);
                if (nextHandicaps.length > currentHandicaps.length || nextOverUnderOdds.length > currentOverUnderOdds.length) {
                  matches[index] = {
                    ...match,
                    handicaps: nextHandicaps,
                    overUnderOdds: nextOverUnderOdds,
                  };
                  if (this.isHgaMatchDataSufficient(nextHandicaps, nextOverUnderOdds)) {
                    return true;
                  }
                  return true;
                }
              } catch {
                // rescue failed, continue retries
              }
            }
            continue;
          }
          if (errText.includes('timeout')) {
            continue;
          }
          break;
        }
      }
      return false;
    };

    for (let batchStart = 0; batchStart < matches.length; batchStart += tune.obt_batch_size) {
      const batchEnd = Math.min(matches.length, batchStart + tune.obt_batch_size);
      let pendingIndexes = Array.from({ length: batchEnd - batchStart }, (_, offset) => batchStart + offset);
      let round = 0;
      while (pendingIndexes.length > 0 && round <= tune.obt_batch_retry) {
        let cursor = 0;
        const failedIndexes: number[] = [];
        const workers = new Array(Math.min(concurrency, pendingIndexes.length)).fill(null).map(async () => {
          while (cursor < pendingIndexes.length) {
            const pointer = cursor++;
            const index = pendingIndexes[pointer];
            const ok = await processOneMatch(index);
            if (!ok) failedIndexes.push(index);
          }
        });
        await Promise.all(workers);
        pendingIndexes = Array.from(new Set(failedIndexes));
        if (pendingIndexes.length > 0) {
          round += 1;
          await ensureUid(true);
          await this.sleep(140 * round);
          console.warn(
            `HGA market batch retry ${round}/${tune.obt_batch_retry} for matches ${batchStart + 1}-${batchEnd}, pending=${pendingIndexes.length}`
          );
        }
      }
    }

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
    let bestHandicaps: ExternalHandicap[] = this.getValidCrownHandicaps(match.handicaps || []);
    let bestOverUnderOdds: ExternalOverUnderOdds[] = this.getValidOverUnderOdds(match.overUnderOdds || []);
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
    for (let i = 0; i < 2; i++) {
      try {
        for (const item of route) {
          const primary = await this.fetchHgaObtMarkets(uid, match.ecid, match.strong, item.showtype, item.isEarly, 'OU|MIX');
          let mergedHandicaps = this.getValidCrownHandicaps([...(bestHandicaps || []), ...(primary.handicaps || [])]);
          if (mergedHandicaps.length > bestHandicaps.length) bestHandicaps = mergedHandicaps;
          let mergedOverUnderOdds = this.getValidOverUnderOdds([...(bestOverUnderOdds || []), ...(primary.overUnderOdds || [])]);
          if (mergedOverUnderOdds.length > bestOverUnderOdds.length) bestOverUnderOdds = mergedOverUnderOdds;
          if (this.isHgaMatchDataSufficient(bestHandicaps, bestOverUnderOdds)) {
            return {
              handicaps: bestHandicaps,
              overUnderOdds: bestOverUnderOdds,
            };
          }

          // `OU` 作为次级兜底，只在缺项时再补一轮，避免无效加压导致会话过期。
          if (bestHandicaps.length === 0 || bestOverUnderOdds.length === 0) {
            const fallback = await this.fetchHgaObtMarkets(uid, match.ecid, match.strong, item.showtype, item.isEarly, 'OU');
            mergedHandicaps = this.getValidCrownHandicaps([...(bestHandicaps || []), ...(fallback.handicaps || [])]);
            if (mergedHandicaps.length > bestHandicaps.length) bestHandicaps = mergedHandicaps;
            mergedOverUnderOdds = this.getValidOverUnderOdds([...(bestOverUnderOdds || []), ...(fallback.overUnderOdds || [])]);
            if (mergedOverUnderOdds.length > bestOverUnderOdds.length) bestOverUnderOdds = mergedOverUnderOdds;
            if (this.isHgaMatchDataSufficient(bestHandicaps, bestOverUnderOdds)) {
              return {
                handicaps: bestHandicaps,
                overUnderOdds: bestOverUnderOdds,
              };
            }
          }
        }
      } catch (err: any) {
        if (String(err?.message || err) === HGA_SESSION_EXPIRED) {
          if (bestHandicaps.length > 0 || bestOverUnderOdds.length > 0) {
            return {
              handicaps: bestHandicaps,
              overUnderOdds: bestOverUnderOdds,
            };
          }
          throw err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)));
    }
    return {
      handicaps: bestHandicaps,
      overUnderOdds: bestOverUnderOdds,
    };
  }

  private static async fetchHgaObtHandicaps(
    uid: string,
    ecid: string,
    strong: 'H' | 'C' | '',
    showtype: 'today' | 'early' | 'parlay',
    isEarly: 'N' | 'Y',
    model: 'OU|MIX' | 'OU' = 'OU|MIX'
  ) {
    const markets = await this.fetchHgaObtMarkets(uid, ecid, strong, showtype, isEarly, model);
    return markets.handicaps;
  }

  private static parseHgaObtMarketsXml(xml: string, strong: 'H' | 'C' | '') {
    const lines = [...xml.matchAll(/<RATIO_R>(.*?)<\/RATIO_R>/g)].map((x) => x[1]?.trim() || '');
    const homes = [...xml.matchAll(/<IOR_RH>(.*?)<\/IOR_RH>/g)].map((x) => this.parseOdds(x[1]));
    const aways = [...xml.matchAll(/<IOR_RC>(.*?)<\/IOR_RC>/g)].map((x) => this.parseOdds(x[1]));

    const handicapMaxLen = Math.min(lines.length, homes.length, aways.length);
    const handicaps: ExternalHandicap[] = [];
    const seenHandicap = new Set<string>();
    for (let i = 0; i < handicapMaxLen; i++) {
      const home = homes[i];
      const away = aways[i];
      const type = this.normalizeHgaRType(lines[i], strong, home, away);
      if (!type || home <= 0 || away <= 0) continue;
      const key = `${type}|${home}|${away}`;
      if (seenHandicap.has(key)) continue;
      seenHandicap.add(key);
      handicaps.push({ type, home_odds: home, away_odds: away });
    }

    const overLines = [...xml.matchAll(/<RATIO_OUO>(.*?)<\/RATIO_OUO>/g)].map((x) => this.normalizeOuLine(x[1]));
    const underLines = [...xml.matchAll(/<RATIO_OUU>(.*?)<\/RATIO_OUU>/g)].map((x) => this.normalizeOuLine(x[1]));
    // HGA OU 实测口径：IOR_OUC 对应“大”，IOR_OUH 对应“小”
    const overOdds = [...xml.matchAll(/<IOR_OUC>(.*?)<\/IOR_OUC>/g)].map((x) => this.parseOdds(x[1]));
    const underOdds = [...xml.matchAll(/<IOR_OUH>(.*?)<\/IOR_OUH>/g)].map((x) => this.parseOdds(x[1]));
    const overUnderMaxLen = Math.min(overOdds.length, underOdds.length, Math.max(overLines.length, underLines.length));
    const overUnderOdds: ExternalOverUnderOdds[] = [];
    for (let i = 0; i < overUnderMaxLen; i++) {
      const line = this.normalizeOuLine(overLines[i] || underLines[i] || '');
      const over = overOdds[i];
      const under = underOdds[i];
      if (!line || over <= 0 || under <= 0) continue;
      overUnderOdds.push({
        line,
        over_odds: over,
        under_odds: under,
      });
    }
    return {
      handicaps: this.getValidCrownHandicaps(handicaps),
      overUnderOdds: this.getValidOverUnderOdds(overUnderOdds),
    };
  }

  private static async fetchHgaObtMarkets(
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
      if (isNoDataXml(xml)) {
        return { handicaps: [] as ExternalHandicap[], overUnderOdds: [] as ExternalOverUnderOdds[] };
      }
    }
    return this.parseHgaObtMarketsXml(xml, strong);
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

  private static normalizeHgaRType(
    rawLine: string,
    strong: 'H' | 'C' | '',
    homeOdds?: number,
    awayOdds?: number,
    isSpfOdds = false
  ) {
    const line = this.normalizeHandicapV2(rawLine);
    if (!line) return null;
    if (line.startsWith('+') || line.startsWith('-')) return line;

    let effectiveStrong = strong;

    // 如果 HGA 未提供强队标记（或平手盘），根据赔率推断。
    // 优先使用 SPF 赔率推断，因为 AH 赔率在低水位时可能产生误导。
    if (!effectiveStrong && homeOdds && awayOdds) {
      if (isSpfOdds) {
        effectiveStrong = homeOdds <= awayOdds ? 'H' : 'C';
      } else {
        // 如果只有 AH 赔率，且赔率差距非常大（例如 > 1.3），可以尝试作为次优推断。
        // 但为了安全起见，如果不确定，我们更倾向于在 alignHandicapDirectionByMatchContext 中处理。
        effectiveStrong = homeOdds <= awayOdds ? 'H' : 'C';
      }
    }

    const sign = effectiveStrong === 'C' ? '+' : '-';
    return `${sign}${line}`;
  }

  private static extractXmlTag(block: string, tag: string) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const m = block.match(regex);
    return m ? m[1].trim() : '';
  }

  private static normalizeNameForMatch(name?: string) {
    const lowered = this.normalizeAliasName(name || '');
    const aliased = this.getHgaMappings().teamAliasMap[lowered] || lowered;
    return aliased
      .toLowerCase()
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

  private static normalizeMatchPair(home?: string, away?: string) {
    return `${this.normalizeNameForMatch(home)}|${this.normalizeNameForMatch(away)}`;
  }

  private static buildTargeted365FixtureKey(dateText?: string, home?: string, away?: string) {
    const date = String(dateText || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const homeName = this.normalizeNameForMatch(home);
    const awayName = this.normalizeNameForMatch(away);
    if (!homeName || !awayName) return '';
    return `${date}|${homeName}|${awayName}`;
  }

  private static getTargeted365RuleMap() {
    const map = new Map<string, Targeted365Rule>();
    for (const rule of TARGETED_365_OU_RULES) {
      const key = this.buildTargeted365FixtureKey(rule.date, rule.home, rule.away);
      if (!key) continue;
      if (!map.has(key)) map.set(key, rule);
    }
    return map;
  }

  private static getTargeted365RuleForMatch(match: ExternalMatch, ruleMap?: Map<string, Targeted365Rule>) {
    const date = this.normalizeMatchTime(match.matchTime).slice(0, 10);
    const key = this.buildTargeted365FixtureKey(date, match.homeTeam, match.awayTeam);
    if (!key) return null;
    const source = ruleMap || this.getTargeted365RuleMap();
    return source.get(key) || null;
  }

  private static buildLive500TeamPairKey(matchTime?: string, homeTeam?: string, awayTeam?: string) {
    const normalized = this.normalizeMatchTime(matchTime || '');
    const normalizedDate = normalized.slice(0, 10);
    const normalizedMinute = normalized.slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return '';
    if (!/^\d{2}:\d{2}$/.test(normalizedMinute)) return '';
    const home = this.normalizeNameForMatch(homeTeam);
    const away = this.normalizeNameForMatch(awayTeam);
    if (!home || !away) return '';
    return `${normalizedDate}|${normalizedMinute}|${home}|${away}`;
  }

  private static buildLive500TeamPairDateKey(matchTime?: string, homeTeam?: string, awayTeam?: string) {
    const normalized = this.normalizeMatchTime(matchTime || '');
    const normalizedDate = normalized.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return '';
    const home = this.normalizeNameForMatch(homeTeam);
    const away = this.normalizeNameForMatch(awayTeam);
    if (!home || !away) return '';
    return `${normalizedDate}|${home}|${away}`;
  }

  private static parseMatchTimeToMs(value?: string) {
    const normalized = this.normalizeMatchTime(value);
    const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!m) return Number.NaN;
    const y = Number.parseInt(m[1], 10);
    const mo = Number.parseInt(m[2], 10);
    const d = Number.parseInt(m[3], 10);
    const hh = Number.parseInt(m[4], 10);
    const mm = Number.parseInt(m[5], 10);
    const ts = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
    return Number.isFinite(ts) ? ts : Number.NaN;
  }

  private static getMatchMinuteDiff(oldTime?: string, rowTime?: string) {
    const a = this.parseMatchTimeToMs(oldTime);
    const b = this.parseMatchTimeToMs(rowTime);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    return Math.abs(a - b) / 60000;
  }

  private static getMatchOffsetMinuteDiff(oldTime?: string, rowTime?: string, offsetHours = HGA_ALIAS_TIME_OFFSET_HOURS) {
    const a = this.parseMatchTimeToMs(oldTime);
    const b = this.parseMatchTimeToMs(rowTime);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    const offsetMs = offsetHours * 60 * 60000;
    // 皇冠时间 = 竞彩时间 - 12h, 等价于 (竞彩时间 - 皇冠时间) ≈ 12h
    return Math.abs((a - b) - offsetMs) / 60000;
  }

  private static isHgaTimeAligned(oldTime?: string, rowTime?: string, toleranceMinutes = HGA_TIME_MATCH_TOLERANCE_MINUTES) {
    const directDiff = this.getMatchMinuteDiff(oldTime, rowTime);
    const offsetDiff = this.getMatchOffsetMinuteDiff(oldTime, rowTime);
    return {
      directDiff,
      offsetDiff,
      directAligned: Number.isFinite(directDiff) && directDiff <= toleranceMinutes,
      offsetAligned: Number.isFinite(offsetDiff) && offsetDiff <= toleranceMinutes,
    };
  }

  private static scoreHgaAsianFingerprint(oldMatch: ExternalMatch, row: HgaMatch) {
    const baseHandicaps = this.getValidCrownHandicaps(this.buildHandicaps(oldMatch), oldMatch);
    const hgaHandicaps = this.getValidCrownHandicaps(row.handicaps || []);
    if (baseHandicaps.length === 0 || hgaHandicaps.length === 0) {
      return {
        score: 0,
        bestLineDiff: Number.POSITIVE_INFINITY,
        bestWaterDiff: Number.POSITIVE_INFINITY,
      };
    }
    let bestScore = 0;
    let bestLineDiff = Number.POSITIVE_INFINITY;
    let bestWaterDiff = Number.POSITIVE_INFINITY;
    for (const a of baseHandicaps) {
      const aType = this.resolveHandicapType(a.type, oldMatch) || a.type;
      const aSort = this.getHandicapSortValue(aType);
      if (!Number.isFinite(aSort)) continue;
      for (const b of hgaHandicaps) {
        const bSort = this.getHandicapSortValue(b.type);
        if (!Number.isFinite(bSort)) continue;
        const lineDiff = Math.abs(aSort - bSort);
        const waterDiff = Math.max(Math.abs(a.home_odds - b.home_odds), Math.abs(a.away_odds - b.away_odds));
        const lineScore = lineDiff <= 0.25 ? Math.max(0, 1 - lineDiff / 0.25) : 0;
        const waterScore = waterDiff <= 0.2 ? Math.max(0, 1 - waterDiff / 0.2) : 0;
        const score = lineScore * 0.75 + waterScore * 0.25;
        if (score > bestScore) {
          bestScore = score;
          bestLineDiff = lineDiff;
          bestWaterDiff = waterDiff;
        }
      }
    }
    return {
      score: bestScore,
      bestLineDiff,
      bestWaterDiff,
    };
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
      const timeAligned = this.isHgaTimeAligned(oldTime, rowTime);
      if (timeAligned.directAligned) score += 3;
      else if (timeAligned.offsetAligned) score += 3;
      else if (rowTime.slice(0, 10) === oldDate) score += 1;

      const rowLeague = this.normalizeNameForMatch(row.league);
      if (oldLeague && rowLeague && (oldLeague === rowLeague || oldLeague.includes(rowLeague) || rowLeague.includes(oldLeague))) {
        score += 1;
      }

      const asianFingerprint = this.scoreHgaAsianFingerprint(oldMatch, row);
      if (asianFingerprint.score >= 0.55) score += 5;
      else if (asianFingerprint.score >= 0.35) score += 3;
      else if (asianFingerprint.score > 0) score += 1;

      // 欧赔只保留弱辅助，不再作为主锚点。
      if (oldCrownWin > 0 && oldCrownDraw > 0 && oldCrownLose > 0) {
        const diff =
          Math.abs(oldCrownWin - row.crownOdds.win) +
          Math.abs(oldCrownDraw - row.crownOdds.draw) +
          Math.abs(oldCrownLose - row.crownOdds.lose);
        if (diff <= 0.3) score += 1;
        else if (diff <= 0.7) score += 0.5;
      }

      const hasBasicTimeRelation = timeAligned.directAligned || timeAligned.offsetAligned || rowTime.slice(0, 10) === oldDate;
      const hasPrimaryAnchor =
        (timeAligned.directAligned || timeAligned.offsetAligned) &&
        (asianFingerprint.score >= 0.35 || (homeExact && awayExact));
      const canAccept =
        (score >= 7 && hasPrimaryAnchor) ||
        (score >= 8 && hasBasicTimeRelation);

      if (canAccept && (!best || score > best.score)) {
        best = { row, score };
      }
    }
    return best?.row || null;
  }

  private static selectRelevantHgaMatches(targetMatches: ExternalMatch[], hgaMatches: HgaMatch[]) {
    if (targetMatches.length === 0 || hgaMatches.length === 0) return hgaMatches;

    const byPair = new Map<string, HgaMatch[]>();
    for (const row of hgaMatches) {
      const key = this.normalizeMatchPair(row.homeTeam, row.awayTeam);
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key)!.push(row);
    }
    for (const list of byPair.values()) {
      list.sort((a, b) => a.matchTime.localeCompare(b.matchTime));
    }

    const selected: HgaMatch[] = [];
    const seen = new Set<string>();
    const pendingSuggestions: HgaAliasSuggestion[] = [];
    for (const match of targetMatches) {
      const exactKey = this.normalizeMatchPair(match.homeTeam, match.awayTeam);
      const strictCandidates = byPair.get(exactKey) || [];
      const fallbackCandidates = strictCandidates.length
        ? strictCandidates
        : hgaMatches.filter(
            (row) => this.teamNameLikelySame(row.homeTeam, match.homeTeam) && this.teamNameLikelySame(row.awayTeam, match.awayTeam)
          );
      const chosen = this.pickBestHgaCandidate(match, fallbackCandidates) || this.pickLikelyHgaCandidateByAsian(match, hgaMatches);
      if (!chosen || seen.has(chosen.ecid)) continue;
      if (strictCandidates.length === 0 && fallbackCandidates.length === 0) {
        pendingSuggestions.push(...this.buildAliasSuggestionsFromMatchedPair(match, chosen));
      }
      seen.add(chosen.ecid);
      selected.push(chosen);
    }

    this.appendPendingHgaAliasSuggestions(pendingSuggestions);
    console.log(`HGA candidate narrowing kept ${selected.length}/${hgaMatches.length} matches for ${targetMatches.length} base matches`);
    return selected;
  }

  private static buildAliasSuggestionsFromMatchedPair(match: ExternalMatch, chosen: HgaMatch) {
    const createdAt = formatLocalDbDateTime();
    const out: HgaAliasSuggestion[] = [];
    const pairs: Array<[string | undefined, string | undefined]> = [
      [match.homeTeam, chosen.homeTeam],
      [match.awayTeam, chosen.awayTeam],
    ];
    for (const [jingcaiName, huangguanName] of pairs) {
      const left = String(jingcaiName || '').trim();
      const right = String(huangguanName || '').trim();
      if (!left || !right) continue;
      if (this.normalizeNameForMatch(left) === this.normalizeNameForMatch(right)) continue;
      out.push(this.toCompatAliasSuggestion({
        jingcai_name: left,
        huangguan_name: right,
        source: 'odds_fallback',
        match_id: String(match.id || '').trim(),
        match_time: String(match.matchTime || '').trim(),
        created_at: createdAt,
        match_count: 1,
      }));
    }
    return out;
  }

  private static pickLikelyHgaCandidateByAsian(oldMatch: ExternalMatch, candidates: HgaMatch[]) {
    const oldTime = this.normalizeMatchTime(oldMatch.matchTime);
    const ranked = candidates
      .map((row) => {
        const rowTime = this.normalizeMatchTime(row.matchTime);
        const aligned = this.isHgaTimeAligned(oldTime, rowTime);
        if (!aligned.directAligned && !aligned.offsetAligned) return null;
        const asian = this.scoreHgaAsianFingerprint(oldMatch, row);
        if (asian.score <= 0) return null;
        const timeDiff = Math.min(aligned.directDiff, aligned.offsetDiff);
        return { row, asianScore: asian.score, timeDiff };
      })
      .filter((item): item is { row: HgaMatch; asianScore: number; timeDiff: number } => Boolean(item))
      .sort((a, b) => {
        if (Math.abs(a.asianScore - b.asianScore) > 1e-12) return b.asianScore - a.asianScore;
        return a.timeDiff - b.timeDiff;
      });

    const best = ranked[0];
    const second = ranked[1];
    if (!best) return null;

    const clearlyBest = !second || best.asianScore - second.asianScore >= 0.08;
    if (best.asianScore >= 0.55 && clearlyBest) {
      return best.row;
    }
    return null;
  }

  private static mergeHgaCrownData(legacyMatches: ExternalMatch[], hgaMatches: HgaMatch[]) {
    if (legacyMatches.length === 0) return legacyMatches;
    const byPair = new Map<string, HgaMatch[]>();
    for (const m of hgaMatches) {
      const key = this.normalizeMatchPair(m.homeTeam, m.awayTeam);
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key)!.push(m);
    }
    for (const list of byPair.values()) {
      list.sort((a, b) => a.matchTime.localeCompare(b.matchTime));
    }

    let enriched = 0;
    let hgaOverrideCount = 0;
    const merged = legacyMatches.map((oldMatch) => {
      const key = this.normalizeMatchPair(oldMatch.homeTeam, oldMatch.awayTeam);
      const strictCandidates = byPair.get(key) || [];
      const chosen =
        this.pickBestHgaCandidate(oldMatch, strictCandidates) ||
        this.pickBestHgaCandidate(oldMatch, hgaMatches);
      if (!chosen) return oldMatch;

      const oldHandicaps = this.getValidCrownHandicaps(this.buildHandicaps(oldMatch), oldMatch);
      const chosenHandicaps = this.getValidCrownHandicaps(chosen.handicaps || [], oldMatch);
      const usedLooseMatch = strictCandidates.length === 0;
      if (usedLooseMatch && oldHandicaps.length > 0 && chosenHandicaps.length > 0) {
        if (this.hasSevereHandicapConflict(oldHandicaps, chosenHandicaps, oldMatch)) {
          return oldMatch;
        }
      }

      const patched: ExternalMatch = {
        ...oldMatch,
        homeTeam: oldMatch.homeTeam,
        awayTeam: oldMatch.awayTeam,
        crownOdds: {
          win: chosen.crownOdds.win > 0 ? String(chosen.crownOdds.win) : oldMatch.crownOdds?.win,
          draw: chosen.crownOdds.draw > 0 ? String(chosen.crownOdds.draw) : oldMatch.crownOdds?.draw,
          lose: chosen.crownOdds.lose > 0 ? String(chosen.crownOdds.lose) : oldMatch.crownOdds?.lose,
        },
        // HGA 命中时优先使用 HGA 抓到的让球，避免被旧来源盘口混入后发生正负号错位。
        crownHandicaps:
          this.getValidCrownHandicaps(
            [
              ...chosenHandicaps,
              ...oldHandicaps,
            ],
            oldMatch
          ),
        crownOverUnderOdds: this.getValidOverUnderOdds([
          ...this.getValidOverUnderOdds(chosen.overUnderOdds || []),
          ...this.getValidOverUnderOdds(oldMatch.crownOverUnderOdds || []),
        ]),
      };
      const beforeH = this.getValidCrownHandicaps(this.buildHandicaps(oldMatch), oldMatch);
      const beforeOu = this.getValidOverUnderOdds(oldMatch.crownOverUnderOdds || []);
      const afterH = this.getValidCrownHandicaps(this.buildHandicaps(patched), patched);
      const afterOu = this.getValidOverUnderOdds(patched.crownOverUnderOdds || []);
      if (JSON.stringify(beforeH) !== JSON.stringify(afterH) || JSON.stringify(beforeOu) !== JSON.stringify(afterOu)) {
        hgaOverrideCount += 1;
      }
      if ((patched.crownHandicaps || []).length >= REQUIRED_CROWN_HANDICAP_COUNT) {
        enriched += 1;
        return patched;
      }
      return patched;
    });
    this.lastFetchMeta.hga_override_hit_count = hgaOverrideCount;
    console.log(`hga override ch/cou matched ${hgaOverrideCount}/${legacyMatches.length}`);
    console.log(`HGA gray source enriched crown data for ${enriched}/${legacyMatches.length} matches`);
    return merged;
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

  private static hasValidOddsTriplet(win: any, draw: any, lose: any) {
    const w = Number(win || 0);
    const d = Number(draw || 0);
    const l = Number(lose || 0);
    return Number.isFinite(w) && Number.isFinite(d) && Number.isFinite(l) && w > 0 && d > 0 && l > 0;
  }

  private static parseJsonArray(raw: any) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private static canScanBaseTypeForRow(
    row: any,
    baseType: 'jingcai' | 'crown' | 'hg' | 'goal_hedge'
  ) {
    if (baseType === 'jingcai') {
      return this.hasValidOddsTriplet(row.j_w, row.j_d, row.j_l);
    }
    if (baseType === 'crown') {
      return this.hasValidOddsTriplet(row.c_w, row.c_d, row.c_l);
    }
    if (baseType === 'hg') {
      const handicaps = this.getValidCrownHandicaps(this.parseJsonArray(row.c_h));
      return handicaps.length > 0;
    }
    const goals = this.getValidGoalOdds(this.parseJsonArray(row.c_goal));
    const overUnders = this.getValidOverUnderOdds(this.parseJsonArray(row.c_ou));
    return goals.length > 0 && overUnders.length > 0;
  }

  static async scanOpportunities(userId: number, options?: { force_recalculate?: boolean }) {
    console.log(`[crawler] starting scan for user ${userId} (force=${!!options?.force_recalculate})...`);

    if (options?.force_recalculate) {
      db.prepare('DELETE FROM arbitrage_opportunities WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM parlay_opportunities WHERE user_id = ?').run(userId);
    }
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
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l, c.handicaps as c_h, c.goal_odds as c_goal, c.over_under_odds as c_ou,
             c.rebate_rate as c_r, c.share_rate as c_s
      FROM matches m
      JOIN jingcai_odds j ON m.match_id = j.match_id
      JOIN crown_odds c ON m.match_id = c.match_id
      WHERE m.status = 'upcoming'
    `).all();

    const baseTypesSingle: ('jingcai' | 'crown' | 'hg' | 'goal_hedge')[] = ['jingcai', 'crown', 'hg', 'goal_hedge'];
    const baseTypesParlay: ('jingcai' | 'crown')[] = ['jingcai', 'crown'];
    const matchRows = matches.map((m: any) => ({
      ...m,
      j_r: jcRebate,
      j_s: jcShare,
      c_r: crownRebate,
      c_s: crownShare,
    }));

    for (const baseType of baseTypesSingle) {
      await this.yieldToEventLoop();
      try {
        let skippedCount = 0;
        let producedCount = 0;
        const rowsToInsert: Array<[number, string, string, number, string, number, string]> = [];
        for (const m of matchRows as any) {
          if (!this.canScanBaseTypeForRow(m, baseType)) {
            skippedCount += 1;
            continue;
          }
          const jcOdds = {
            W: m.j_w,
            D: m.j_d,
            L: m.j_l,
            HW: m.j_hw,
            HD: m.j_hd,
            HL: m.j_hl,
            handicapLine: m.jc_handicap,
            rebate: jcRebate,
            share: jcShare,
          };
          const crownOdds = {
            W: m.c_w,
            D: m.c_d,
            L: m.c_l,
            handicaps: m.c_h ? JSON.parse(m.c_h) : [],
            goal_odds: m.c_goal ? JSON.parse(m.c_goal) : [],
            over_under_odds: m.c_ou ? JSON.parse(m.c_ou) : [],
            rebate: crownRebate,
            share: crownShare,
          };

          const opportunities = ArbitrageEngine.findAllOpportunities(10000, jcOdds, crownOdds, baseType);
          if (!Array.isArray(opportunities)) {
            throw new Error(`single(${baseType}) returned non-array result`);
          }
          if (opportunities.length === 0) continue;
          producedCount += 1;

          const best = opportunities[0];
          const jcSide = best.jcSide || 'W';
          rowsToInsert.push([
            userId,
            m.match_id,
            jcSide,
            best.jc_odds || (jcOdds[jcSide as keyof typeof jcOdds] as number),
            JSON.stringify(best),
            best.min_profit_rate,
            baseType
          ]);
        }
        db.transaction(() => {
          db.prepare('DELETE FROM arbitrage_opportunities WHERE user_id = ? AND base_type = ?').run(userId, baseType);
          const insert = db.prepare(`
            INSERT INTO arbitrage_opportunities (user_id, match_id, jingcai_side, jingcai_odds, best_strategy, profit_rate, base_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const row of rowsToInsert) insert.run(...row);
        })();
        console.log(
          `[scanOpportunities] single(${baseType}) user=${userId} total=${matchRows.length} skipped=${skippedCount} produced=${producedCount}`
        );
      } catch (err) {
        console.error(`[scanOpportunities] single(${baseType}) failed for user ${userId}:`, err);
      }

      await this.yieldToEventLoop();
    }

    for (const baseType of baseTypesParlay) {
      await this.yieldToEventLoop();
      try {
        const eligibleRows = (matchRows as any[]).filter((row) => this.canScanBaseTypeForRow(row, baseType));
        const skippedCount = matchRows.length - eligibleRows.length;
        const parlayOpportunities = ArbitrageEngine.findParlayOpportunities(10000, eligibleRows, baseType);
        if (!Array.isArray(parlayOpportunities)) {
          throw new Error(`parlay(${baseType}) returned non-array result`);
        }
        const rowsToInsert = parlayOpportunities.map((p) => [
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
          baseType,
        ] as const);

        await this.yieldToEventLoop();
        db.transaction(() => {
          // Stable ID approach: Update existing or Insert new, then Delete stale
          const existingIds = db.prepare('SELECT id, match_id_1, match_id_2, side_1, side_2 FROM parlay_opportunities WHERE user_id = ? AND base_type = ?')
            .all(userId, baseType) as Array<{ id: number, match_id_1: string, match_id_2: string, side_1: string, side_2: string }>;
          
          const existingMap = new Map<string, number>();
          existingIds.forEach(row => {
            const key = `${row.match_id_1}|${row.match_id_2}|${row.side_1}|${row.side_2}`;
            existingMap.set(key, row.id);
          });

          const activeIds = new Set<number>();
          const upsert = db.prepare(`
            INSERT INTO parlay_opportunities (id, user_id, match_id_1, match_id_2, side_1, side_2, odds_1, odds_2, combined_odds, best_strategy, profit_rate, base_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              odds_1 = excluded.odds_1,
              odds_2 = excluded.odds_2,
              combined_odds = excluded.combined_odds,
              best_strategy = excluded.best_strategy,
              profit_rate = excluded.profit_rate,
              created_at = CURRENT_TIMESTAMP
          `);

          for (const row of rowsToInsert) {
            const [uId, m1, m2, s1, s2, o1, o2, co, strategy, pr, bType] = row;
            const key = `${m1}|${m2}|${s1}|${s2}`;
            const existingId = existingMap.get(key) || null;
            const result = upsert.run(existingId, uId, m1, m2, s1, s2, o1, o2, co, strategy, pr, bType);
            activeIds.add(existingId || (result.lastInsertRowid as number));
          }

          if (activeIds.size > 0) {
            const placeholders = Array.from(activeIds).map(() => '?').join(',');
            db.prepare(`DELETE FROM parlay_opportunities WHERE user_id = ? AND base_type = ? AND id NOT IN (${placeholders})`)
              .run(userId, baseType, ...Array.from(activeIds));
          } else {
            db.prepare('DELETE FROM parlay_opportunities WHERE user_id = ? AND base_type = ?').run(userId, baseType);
          }
        })();
        console.log(
          `[scanOpportunities] parlay(${baseType}) user=${userId} total=${matchRows.length} skipped=${skippedCount} produced=${parlayOpportunities.length}`
        );
      } catch (err) {
        console.error(`[scanOpportunities] parlay(${baseType}) failed for user ${userId}:`, err);
      }
    }

    console.log(`Opportunity scan completed for user ${userId}`);
  }
}
