export type Side = 'W' | 'D' | 'L';

const HOME = '主胜';
const DRAW = '平';
const AWAY = '客胜';

function includesAny(text: string, tokens: string[]) {
  return tokens.some((token) => text.includes(token));
}

function normalizeText(raw: string) {
  return String(raw || '').replace(/\s+/g, '').trim();
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

  const toLabel = (source: string) => {
    if (includesAny(source, ['主胜', '标准胜', '普胜'])) return HOME;
    if (includesAny(source, ['客胜', '标准负', '普负', '负'])) return AWAY;
    if (includesAny(source, ['平', '标准平', '普平'])) return DRAW;
    return '';
  };

  const m = t.match(/^(.*)\(([^)]+)\)$/);
  if (m) {
    const side = toLabel(m[1]);
    if (side) return `${side}(${m[2]})`;
  }

  const side = toLabel(t);
  if (side) return side;
  return t;
}

export function normalizeParlaySideLabel(raw: string) {
  const t = normalizeText(raw);
  if (!t) return '-';

  const handicap = t.match(/\(([^)]+)\)/)?.[1];
  const handicapValue = Number(handicap);
  const isZeroHandicap = Number.isFinite(handicapValue) && Math.abs(handicapValue) < 1e-9;

  if (includesAny(t, ['让胜'])) return handicap ? (isZeroHandicap ? HOME : `${HOME}(${handicap})`) : HOME;
  if (includesAny(t, ['让平'])) return handicap ? (isZeroHandicap ? DRAW : `${DRAW}(${handicap})`) : DRAW;
  if (includesAny(t, ['让负'])) return handicap ? (isZeroHandicap ? AWAY : `${AWAY}(${invertHandicap(handicap)})`) : AWAY;

  if (includesAny(t, ['普胜', '标准胜', '主胜', '胜'])) return HOME;
  if (includesAny(t, ['普平', '标准平', '平'])) return DRAW;
  if (includesAny(t, ['普负', '标准负', '客胜', '负'])) return AWAY;

  return t;
}

export function parseParlayRawSide(raw: string): { side: Side; handicap?: number; isHandicap: boolean } {
  const t = normalizeText(raw);
  const handicapText = t.match(/\(([^)]+)\)/)?.[1];
  const handicap = handicapText !== undefined ? Number(handicapText) : undefined;

  if (includesAny(t, ['让胜'])) return { side: 'W', handicap, isHandicap: true };
  if (includesAny(t, ['让平'])) return { side: 'D', handicap, isHandicap: true };
  if (includesAny(t, ['让负'])) return { side: 'L', handicap, isHandicap: true };

  if (includesAny(t, ['普胜', '标准胜', '主胜', '胜'])) return { side: 'W', handicap: 0, isHandicap: false };
  if (includesAny(t, ['普平', '标准平', '平'])) return { side: 'D', handicap: 0, isHandicap: false };
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

  return { kind: 'std', side: 'home' };
}
