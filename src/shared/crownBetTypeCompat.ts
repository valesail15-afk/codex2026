import { normalizeCrownTarget, parseHandicap } from './oddsText';

type ParsedCrownBetType = { kind: 'std' | 'ah'; side: 'home' | 'away' | 'draw'; handicap?: number };

function detectSide(text: string): 'home' | 'away' | 'draw' | null {
  const raw = String(text || '').replace(/\s+/g, '');
  const upper = raw.toUpperCase();
  if (
    upper.includes('HOME') ||
    upper.includes('STD_W') ||
    upper.includes('STANDARD_W') ||
    /主|让胜/.test(raw)
  ) {
    return 'home';
  }
  if (
    upper.includes('DRAW') ||
    upper.includes('STD_D') ||
    upper.includes('STANDARD_D') ||
    /平|让平/.test(raw)
  ) {
    return 'draw';
  }
  if (
    upper.includes('AWAY') ||
    upper.includes('STD_L') ||
    upper.includes('STANDARD_L') ||
    /客|让负/.test(raw)
  ) {
    return 'away';
  }
  return null;
}

export function parseCrownBetTypeCompat(raw: string): ParsedCrownBetType {
  const source = String(raw || '').replace(/\s+/g, '');
  const upper = source.toUpperCase();

  if (upper === 'STD_HOME') return { kind: 'std', side: 'home' };
  if (upper === 'STD_DRAW') return { kind: 'std', side: 'draw' };
  if (upper === 'STD_AWAY') return { kind: 'std', side: 'away' };

  const ah = upper.match(/^AH_(HOME|DRAW|AWAY)\(([^)]+)\)$/);
  if (ah) {
    return {
      kind: 'ah',
      side: ah[1] === 'HOME' ? 'home' : ah[1] === 'DRAW' ? 'draw' : 'away',
      handicap: parseHandicap(ah[2]),
    };
  }

  const normalized = normalizeCrownTarget(source);
  const ahText = normalized.match(/^(.*)[(（]([^)）]+)[)）]$/);
  if (ahText) {
    const side = detectSide(ahText[1]);
    if (side) {
      return { kind: 'ah', side, handicap: parseHandicap(ahText[2]) };
    }
  }

  const stdSide = detectSide(normalized) || detectSide(source);
  if (stdSide) return { kind: 'std', side: stdSide };
  return { kind: 'std', side: 'home' };
}

