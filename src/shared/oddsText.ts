export type Side = 'W' | 'D' | 'L';

const HOME = '主胜';
const DRAW = '平';
const AWAY = '客胜';

const HOME_TOKENS = ['主胜', 'home', 'homewin', 'std_w', 'standard_w', '涓昏儨'];
const DRAW_TOKENS = ['平', 'draw', 'std_d', 'standard_d', '骞?'];
const AWAY_TOKENS = ['客胜', 'away', 'awaywin', 'std_l', 'standard_l', '瀹㈣儨'];

const HANDICAP_WIN_TOKENS = ['让胜', '璁╄儨'];
const HANDICAP_DRAW_TOKENS = ['让平', '璁╁钩'];
const HANDICAP_LOSE_TOKENS = ['让负', '璁╄礋'];

function normalizeText(raw: string) {
  return String(raw || '').replace(/\s+/g, '').trim();
}

function includesAny(text: string, tokens: string[]) {
  const lower = normalizeText(text).toLowerCase();
  return tokens.some((token) => lower.includes(String(token).toLowerCase()));
}

function detectSide(text: string): 'home' | 'draw' | 'away' | null {
  if (includesAny(text, HOME_TOKENS)) return 'home';
  if (includesAny(text, DRAW_TOKENS)) return 'draw';
  if (includesAny(text, AWAY_TOKENS)) return 'away';
  return null;
}

export function sideToLabel(side: Side) {
  if (side === 'W') return HOME;
  if (side === 'D') return DRAW;
  return AWAY;
}

export function invertHandicap(line: string) {
  const s = String(line || '0').trim();
  if (!s) return '0';
  if (s.startsWith('+')) return `-${s.slice(1)}`;
  if (s.startsWith('-')) return `+${s.slice(1)}`;
  return `-${s}`;
}

export function parseHandicap(h: string): number {
  const s = normalizeText(h);
  if (!s) return 0;
  if (!s.includes('/')) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  const parts = s.split('/');
  const sign = parts[0].startsWith('-') ? '-' : parts[0].startsWith('+') ? '+' : '';
  const values = parts
    .map((part, index) => {
      if (index === 0) return Number(part);
      if (part.startsWith('+') || part.startsWith('-')) return Number(part);
      if (sign) return Number(`${sign}${part}`);
      return Number(part);
    })
    .filter((value) => Number.isFinite(value));

  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function normalizeCrownTarget(raw: string) {
  const t = normalizeText(raw);
  if (!t) return '';

  const m = t.match(/^(.*)\(([^)]+)\)$/);
  if (m) {
    const side = detectSide(m[1]);
    if (side === 'home') return `${HOME}(${m[2]})`;
    if (side === 'draw') return `${DRAW}(${m[2]})`;
    if (side === 'away') return `${AWAY}(${m[2]})`;
  }

  const side = detectSide(t);
  if (side === 'home') return HOME;
  if (side === 'draw') return DRAW;
  if (side === 'away') return AWAY;
  return t;
}

export function normalizeParlaySideLabel(raw: string) {
  const t = normalizeText(raw);
  if (!t) return '-';

  const handicap = t.match(/\(([^)]+)\)/)?.[1];
  const handicapValue = Number(handicap);
  const isZeroHandicap = Number.isFinite(handicapValue) && Math.abs(handicapValue) < 1e-9;

  if (includesAny(t, HANDICAP_WIN_TOKENS)) return handicap ? (isZeroHandicap ? HOME : `${HOME}(${handicap})`) : HOME;
  if (includesAny(t, HANDICAP_DRAW_TOKENS)) return handicap ? (isZeroHandicap ? DRAW : `${DRAW}(${handicap})`) : DRAW;
  if (includesAny(t, HANDICAP_LOSE_TOKENS)) return handicap ? (isZeroHandicap ? AWAY : `${AWAY}(${invertHandicap(handicap)})`) : AWAY;

  const side = detectSide(t);
  if (side === 'home') return HOME;
  if (side === 'draw') return DRAW;
  if (side === 'away') return AWAY;
  return t;
}

export function parseParlayRawSide(raw: string): { side: Side; handicap?: number; isHandicap: boolean } {
  const t = normalizeText(raw);
  const handicapText = t.match(/\(([^)]+)\)/)?.[1];
  const handicap = handicapText !== undefined ? Number(handicapText) : undefined;

  if (includesAny(t, HANDICAP_WIN_TOKENS)) return { side: 'W', handicap, isHandicap: true };
  if (includesAny(t, HANDICAP_DRAW_TOKENS)) return { side: 'D', handicap, isHandicap: true };
  if (includesAny(t, HANDICAP_LOSE_TOKENS)) return { side: 'L', handicap, isHandicap: true };

  const side = detectSide(t);
  if (side === 'home') return { side: 'W', handicap: 0, isHandicap: false };
  if (side === 'draw') return { side: 'D', handicap: 0, isHandicap: false };
  return { side: 'L', handicap: 0, isHandicap: false };
}

export function parseCrownBetType(raw: string): { kind: 'std' | 'ah'; side: 'home' | 'away' | 'draw'; handicap?: number } {
  const normalized = normalizeCrownTarget(raw);
  if (normalized === HOME) return { kind: 'std', side: 'home' };
  if (normalized === DRAW) return { kind: 'std', side: 'draw' };
  if (normalized === AWAY) return { kind: 'std', side: 'away' };

  const m = normalized.match(/^(主胜|平|客胜)\(([^)]+)\)$/);
  if (m) {
    return {
      kind: 'ah',
      side: m[1] === HOME ? 'home' : m[1] === DRAW ? 'draw' : 'away',
      handicap: parseHandicap(m[2]),
    };
  }

  const side = detectSide(normalized);
  if (side === 'draw') return { kind: 'std', side: 'draw' };
  if (side === 'away') return { kind: 'std', side: 'away' };
  return { kind: 'std', side: 'home' };
}
