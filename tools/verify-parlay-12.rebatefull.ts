/* eslint-disable no-console */

type Side = 'W' | 'D' | 'L';
type Market = 'normal' | 'handicap';
type TeamSide = 'home' | 'away' | 'draw';

type JcPick = {
  side: Side;
  market: Market;
  odds: number;
  handicapLine?: string;
};

type CrownBet = {
  match: 1 | 2;
  kind: 'std' | 'ah';
  side: TeamSide;
  odds: number;
  handicap?: string;
  amount: number;
};

type Scheme = {
  id: number;
  name: string;
  jcRebate: number;
  crownRebate: number;
  jcAmount: number;
  pick1: JcPick;
  pick2: JcPick;
  firstBets: CrownBet[];
  secondBets: CrownBet[];
};

const OUTCOME_DGS: Record<Side, number[]> = {
  W: [1, 2, 3, 4],
  D: [0],
  L: [-1, -2, -3, -4],
};

const SIDE_LABEL: Record<Side, string> = { W: '主胜', D: '平', L: '客胜' };

function parseHandicap(line?: string): number {
  const s = String(line || '0').trim().replace(/\s+/g, '');
  if (!s) return 0;
  if (!s.includes('/')) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const parts = s.split('/');
  const sign = parts[0].startsWith('-') ? '-' : parts[0].startsWith('+') ? '+' : '';
  const vals = parts
    .map((p, i) => {
      if (i === 0) return Number(p);
      if (p.startsWith('+') || p.startsWith('-')) return Number(p);
      return sign ? Number(`${sign}${p}`) : Number(p);
    })
    .filter((x) => Number.isFinite(x));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function jcReturn(pick: JcPick, dg: number): number {
  if (pick.market === 'normal') {
    const hit = pick.side === 'W' ? dg > 0 : pick.side === 'D' ? dg === 0 : dg < 0;
    return hit ? pick.odds : 0;
  }
  const adj = dg + parseHandicap(pick.handicapLine || '0');
  const outcome: Side = adj > 0 ? 'W' : adj < 0 ? 'L' : 'D';
  return outcome === pick.side ? pick.odds : 0;
}

function crownReturn(bet: CrownBet, dg: number): { ret: number; settleRatio: number } {
  if (bet.kind === 'std') {
    const hit = bet.side === 'home' ? dg > 0 : bet.side === 'draw' ? dg === 0 : dg < 0;
    return { ret: hit ? bet.odds : 0, settleRatio: hit ? 1 : 0 };
  }
  const h = parseHandicap(bet.handicap || '0');
  const score = bet.side === 'home' ? dg + h : -dg + h;
  if (score >= 0.5) return { ret: 1 + bet.odds, settleRatio: 1 };
  if (score === 0.25) return { ret: 1 + bet.odds * 0.5, settleRatio: 0.5 };
  if (score === 0) return { ret: 1, settleRatio: 0 };
  if (score === -0.25) return { ret: 0.5, settleRatio: 0.5 };
  return { ret: 0, settleRatio: 1 };
}

function firstCrownHitForSide(s: Scheme, side: Side): boolean {
  const dgs = OUTCOME_DGS[side];
  let worstGross = Number.POSITIVE_INFINITY;
  for (const dg of dgs) {
    const gross = s.firstBets.reduce((sum, b) => sum + b.amount * crownReturn(b, dg).ret, 0);
    if (gross < worstGross) worstGross = gross;
  }
  return worstGross > 1e-9;
}

function needSecondHedge(s: Scheme, side1: Side): boolean {
  // User workflow rule:
  // Step-2 is triggered when match-1 Jingcai leg is hit.
  // We do not require full 9-grid positivity; only evaluate branches that enter step-2.
  return side1 === s.pick1.side;
}

function comboWorstProfit(s: Scheme, side1: Side, side2: Side): number {
  const dgs1 = OUTCOME_DGS[side1];
  const dgs2 = OUTCOME_DGS[side2];
  const useSecond = needSecondHedge(s, side1);
  let worst = Number.POSITIVE_INFINITY;

  for (const dg1 of dgs1) {
    for (const dg2 of dgs2) {
      const r1 = jcReturn(s.pick1, dg1);
      const r2 = jcReturn(s.pick2, dg2);
      const parlayRet = r1 > 0 && r2 > 0 ? r1 * r2 : 0;

      let total = s.jcAmount * (parlayRet - 1 + s.jcRebate);

      for (const b of s.firstBets) {
        const c = crownReturn(b, dg1);
        total += b.amount * ((c.ret - 1) + s.crownRebate);
      }

      if (useSecond) {
        for (const b of s.secondBets) {
          const c = crownReturn(b, dg2);
          total += b.amount * ((c.ret - 1) + s.crownRebate);
        }
      }

      if (total < worst) worst = total;
    }
  }

  return worst;
}

function evaluate(s: Scheme) {
  const sides: Side[] = ['W', 'D', 'L'];
  const details: Array<{ key: string; side1: Side; side2: Side; profit: number; required: boolean }> = [];
  for (const s1 of sides) {
    for (const s2 of sides) {
      details.push({
        key: `${s1}-${s2}`,
        side1: s1,
        side2: s2,
        profit: comboWorstProfit(s, s1, s2),
        required: needSecondHedge(s, s1),
      });
    }
  }

  const required = details.filter((x) => x.required);
  const minRequired = required.reduce((m, x) => (x.profit < m.profit ? x : m), required[0]);
  const minAll = details.reduce((m, x) => (x.profit < m.profit ? x : m), details[0]);
  return {
    id: s.id,
    name: s.name,
    allPositiveRequired: required.every((x) => x.profit > 0.01),
    minRequired,
    minAll,
    details,
  };
}

const schemes: Scheme[] = [
  {
    id: 1,
    name: '方案1',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 1.87 },
    pick2: { side: 'L', market: 'normal', odds: 3.1 },
    firstBets: [{ match: 1, kind: 'ah', side: 'away', odds: 1.97, handicap: '+0.5', amount: 4538 }],
    secondBets: [
      { match: 2, kind: 'ah', side: 'home', odds: 1.83, handicap: '0', amount: 15877 },
      { match: 2, kind: 'std', side: 'draw', odds: 2.85, amount: 4708 },
    ],
  },
  {
    id: 2,
    name: '方案2',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 3.0 },
    pick2: { side: 'L', market: 'normal', odds: 3.1 },
    firstBets: [
      { match: 1, kind: 'ah', side: 'away', odds: 2.13, handicap: '-0/0.5', amount: 6719 },
      { match: 1, kind: 'std', side: 'draw', odds: 3.3, amount: 3318 },
    ],
    secondBets: [
      { match: 2, kind: 'ah', side: 'home', odds: 1.83, handicap: '0', amount: 25471 },
      { match: 2, kind: 'std', side: 'draw', odds: 2.85, amount: 7552 },
    ],
  },
  {
    id: 3,
    name: '方案3',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'handicap', odds: 1.81, handicapLine: '+1' },
    pick2: { side: 'L', market: 'normal', odds: 3.1 },
    firstBets: [{ match: 1, kind: 'std', side: 'away', odds: 2.03, amount: 4259 }],
    secondBets: [
      { match: 2, kind: 'ah', side: 'home', odds: 1.83, handicap: '0', amount: 15368 },
      { match: 2, kind: 'std', side: 'draw', odds: 2.85, amount: 4557 },
    ],
  },
  {
    id: 4,
    name: '方案4',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 3.0 },
    pick2: { side: 'W', market: 'normal', odds: 1.87 },
    firstBets: [
      { match: 1, kind: 'ah', side: 'away', odds: 1.79, handicap: '0', amount: 7944 },
      { match: 1, kind: 'std', side: 'draw', odds: 3.3, amount: 1931 },
    ],
    secondBets: [{ match: 2, kind: 'ah', side: 'away', odds: 1.97, handicap: '+0.5', amount: 14244 }],
  },
  {
    id: 5,
    name: '方案5',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 3.0 },
    pick2: { side: 'W', market: 'handicap', odds: 1.81, handicapLine: '+1' },
    firstBets: [
      { match: 1, kind: 'ah', side: 'away', odds: 1.79, handicap: '0', amount: 7917 },
      { match: 1, kind: 'std', side: 'draw', odds: 3.3, amount: 1925 },
    ],
    secondBets: [{ match: 2, kind: 'std', side: 'away', odds: 2.03, amount: 13369 }],
  },
  {
    id: 6,
    name: '方案6',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'handicap', odds: 1.81, handicapLine: '+1' },
    pick2: { side: 'L', market: 'normal', odds: 3.1 },
    firstBets: [{ match: 1, kind: 'std', side: 'away', odds: 2.03, amount: 4259 }],
    secondBets: [
      { match: 2, kind: 'ah', side: 'home', odds: 1.83, handicap: '0', amount: 15368 },
      { match: 2, kind: 'std', side: 'draw', odds: 2.85, amount: 4557 },
    ],
  },
  {
    id: 7,
    name: '方案7',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 3.0 },
    pick2: { side: 'L', market: 'handicap', odds: 1.48, handicapLine: '-1' },
    firstBets: [
      { match: 1, kind: 'ah', side: 'away', odds: 1.79, handicap: '0', amount: 7826 },
      { match: 1, kind: 'std', side: 'draw', odds: 3.3, amount: 1903 },
    ],
    secondBets: [{ match: 2, kind: 'ah', side: 'home', odds: 2.61, handicap: '-0.5', amount: 8454 }],
  },
  {
    id: 8,
    name: '方案8',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'handicap', odds: 1.81, handicapLine: '+1' },
    pick2: { side: 'W', market: 'normal', odds: 1.87 },
    firstBets: [{ match: 1, kind: 'std', side: 'away', odds: 2.03, amount: 4212 }],
    secondBets: [{ match: 2, kind: 'ah', side: 'away', odds: 1.97, handicap: '+0.5', amount: 8594 }],
  },
  {
    id: 9,
    name: '方案9',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 3.85 },
    pick2: { side: 'W', market: 'normal', odds: 1.87 },
    firstBets: [
      { match: 1, kind: 'ah', side: 'away', odds: 1.48, handicap: '0', amount: 12406 },
      { match: 1, kind: 'std', side: 'draw', odds: 3.45, amount: 1752 },
    ],
    secondBets: [{ match: 2, kind: 'ah', side: 'away', odds: 1.97, handicap: '+0.5', amount: 18280 }],
  },
  {
    id: 10,
    name: '方案10',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'normal', odds: 1.87 },
    pick2: { side: 'L', market: 'handicap', odds: 1.48, handicapLine: '-1' },
    firstBets: [{ match: 1, kind: 'ah', side: 'away', odds: 1.97, handicap: '+0.5', amount: 4421 }],
    secondBets: [{ match: 2, kind: 'ah', side: 'home', odds: 2.61, handicap: '-0.5', amount: 5270 }],
  },
  {
    id: 11,
    name: '方案11',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'L', market: 'normal', odds: 3.7 },
    pick2: { side: 'W', market: 'normal', odds: 1.87 },
    firstBets: [
      { match: 1, kind: 'ah', side: 'home', odds: 1.8, handicap: '-0.25', amount: 9741 },
      { match: 1, kind: 'std', side: 'draw', odds: 3.4, amount: 3707 },
    ],
    secondBets: [{ match: 2, kind: 'ah', side: 'away', odds: 1.97, handicap: '+0.5', amount: 17568 }],
  },
  {
    id: 12,
    name: '方案12',
    jcRebate: 0.14,
    crownRebate: 0.026,
    jcAmount: 5000,
    pick1: { side: 'W', market: 'handicap', odds: 1.81, handicapLine: '+1' },
    pick2: { side: 'L', market: 'handicap', odds: 1.48, handicapLine: '-1' },
    firstBets: [{ match: 1, kind: 'std', side: 'away', odds: 2.03, amount: 4149 }],
    secondBets: [{ match: 2, kind: 'ah', side: 'home', odds: 2.61, handicap: '-0.5', amount: 5101 }],
  },
];

const results = schemes.map(evaluate);

console.log('| 方案 | 触发二阶段后9宫格全正 | 最差组合(触发路径) | 最差利润 | 全9格最差 |');
console.log('|---|---:|---|---:|---:|');
for (const r of results) {
  const key = `${SIDE_LABEL[r.minRequired.side1]}-${SIDE_LABEL[r.minRequired.side2]}`;
  const allKey = `${SIDE_LABEL[r.minAll.side1]}-${SIDE_LABEL[r.minAll.side2]}`;
  console.log(`| ${r.name} | ${r.allPositiveRequired ? '是' : '否'} | ${key} | ${r.minRequired.profit.toFixed(2)} | ${allKey} ${r.minAll.profit.toFixed(2)} |`);
}

const failed = results.filter((x) => !x.allPositiveRequired);
if (failed.length > 0) {
  console.log('\nFAIL_SCHEMES=' + failed.map((x) => x.name).join(','));
  process.exit(2);
}

console.log('\nALL_REQUIRED_COMBOS_POSITIVE');

