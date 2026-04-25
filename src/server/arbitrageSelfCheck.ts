import path from 'path';
import Database from 'better-sqlite3';
import { ArbitrageEngine } from './arbitrageEngine';
import type { HedgeStrategy } from '../types';

const db = new Database(path.resolve(process.cwd(), 'arbitrage.db'), { readonly: true });
const EPS = 1e-6;

function almostEqual(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

function isFiniteNumber(v: number): boolean {
  return Number.isFinite(v);
}

function validateStrategy(strategy: HedgeStrategy, scene: string): string[] {
  const errors: string[] = [];
  const states: Array<keyof HedgeStrategy['profits']> = ['win', 'draw', 'lose'];

  for (const state of states) {
    const p = strategy.profits[state];
    const mp = strategy.match_profits[state];
    const rb = strategy.rebates[state];
    if (!isFiniteNumber(p) || !isFiniteNumber(mp) || !isFiniteNumber(rb)) {
      errors.push(`${scene}: ${state} has non-finite value`);
      continue;
    }
    if (!almostEqual(p, mp + rb, 1e-3)) {
      errors.push(`${scene}: ${state} totalProfit != matchProfit + rebate`);
    }
  }

  const minProfit = Math.min(strategy.profits.win, strategy.profits.draw, strategy.profits.lose);
  if (!almostEqual(minProfit, strategy.min_profit, 1e-3)) {
    errors.push(`${scene}: min_profit mismatch`);
  }

  if (!isFiniteNumber(strategy.total_invest) || strategy.total_invest <= 0) {
    errors.push(`${scene}: invalid total_invest`);
  } else {
    const calcRate = strategy.min_profit / strategy.total_invest;
    if (!almostEqual(calcRate, strategy.min_profit_rate, 1e-6)) {
      errors.push(`${scene}: min_profit_rate mismatch`);
    }
  }

  if (!isFiniteNumber(strategy.user_invest) || strategy.user_invest <= 0) {
    errors.push(`${scene}: invalid user_invest`);
  }
  if (!isFiniteNumber(strategy.rebate)) {
    errors.push(`${scene}: invalid rebate`);
  }
  return errors;
}

function runSingleChecks(sampleLimit = 30): string[] {
  const rows = db
    .prepare(
      `
      SELECT m.match_id, m.jingcai_handicap as jc_handicap,
             j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
             j.handicap_win_odds as j_hw, j.handicap_draw_odds as j_hd, j.handicap_lose_odds as j_hl,
             j.rebate_rate as j_r, j.share_rate as j_s,
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l,
             c.handicaps as c_h, c.rebate_rate as c_r, c.share_rate as c_s
      FROM matches m
      JOIN jingcai_odds j ON m.match_id = j.match_id
      JOIN crown_odds c ON m.match_id = c.match_id
      ORDER BY m.match_time ASC
      LIMIT ?
      `
    )
    .all(sampleLimit) as any[];

  const errors: string[] = [];
  const baseTypes: Array<'jingcai' | 'crown' | 'hg' | 'goal_hedge'> = ['jingcai', 'crown', 'hg', 'goal_hedge'];

  for (const row of rows) {
    const jcOdds = {
      W: Number(row.j_w),
      D: Number(row.j_d),
      L: Number(row.j_l),
      HW: Number(row.j_hw),
      HD: Number(row.j_hd),
      HL: Number(row.j_hl),
      handicapLine: row.jc_handicap || '0',
      rebate: Number(row.j_r || 0.13),
      share: Number(row.j_s || 0),
    };
    const crownOdds = {
      W: Number(row.c_w),
      D: Number(row.c_d),
      L: Number(row.c_l),
      handicaps: row.c_h ? JSON.parse(row.c_h) : [],
      rebate: Number(row.c_r || 0.02),
      share: Number(row.c_s || 0),
    };

    for (const baseType of baseTypes) {
      const list = ArbitrageEngine.findAllOpportunities(10000, jcOdds, crownOdds, baseType);
      for (let i = 0; i < list.length; i++) {
        errors.push(...validateStrategy(list[i], `single:${row.match_id}:${baseType}:${i}`));
      }
    }
  }
  return errors;
}

function runParlayChecks(sampleLimit = 20): string[] {
  const rows = db
    .prepare(
      `
      SELECT m.match_id,
             j.win_odds as j_w, j.draw_odds as j_d, j.lose_odds as j_l,
             j.rebate_rate as j_r, j.share_rate as j_s,
             c.win_odds as c_w, c.draw_odds as c_d, c.lose_odds as c_l,
             c.handicaps as c_h, c.rebate_rate as c_r, c.share_rate as c_s
      FROM matches m
      JOIN jingcai_odds j ON m.match_id = j.match_id
      JOIN crown_odds c ON m.match_id = c.match_id
      ORDER BY m.match_time ASC
      LIMIT ?
      `
    )
    .all(sampleLimit) as any[];

  const matches = rows.map((r) => ({
    match_id: r.match_id,
    j_w: Number(r.j_w),
    j_d: Number(r.j_d),
    j_l: Number(r.j_l),
    c_w: Number(r.c_w),
    c_d: Number(r.c_d),
    c_l: Number(r.c_l),
    c_h: r.c_h || '[]',
    j_r: Number(r.j_r || 0.13),
    j_s: Number(r.j_s || 0),
    c_r: Number(r.c_r || 0.02),
    c_s: Number(r.c_s || 0),
  }));

  const errors: string[] = [];
  const baseTypes: Array<'jingcai' | 'crown'> = ['jingcai', 'crown'];
  for (const baseType of baseTypes) {
    const list = ArbitrageEngine.findParlayOpportunities(10000, matches, baseType);
    for (let i = 0; i < list.length; i++) {
      errors.push(...validateStrategy(list[i].best_strategy, `parlay:${baseType}:${i}`));
    }
  }
  return errors;
}

function runRandomStress(rounds = 400): string[] {
  const errors: string[] = [];
  const sides: Array<'W' | 'D' | 'L'> = ['W', 'D', 'L'];

  for (let i = 0; i < rounds; i++) {
    const m1 = {
      c_w: 1.2 + Math.random() * 2.4,
      c_d: 2.2 + Math.random() * 2.8,
      c_l: 1.2 + Math.random() * 2.4,
      c_h: JSON.stringify([{ type: '-0.5', home_odds: 1.6 + Math.random() * 1.8, away_odds: 1.6 + Math.random() * 1.8 }]),
    };
    const m2 = {
      c_w: 1.2 + Math.random() * 2.4,
      c_d: 2.2 + Math.random() * 2.8,
      c_l: 1.2 + Math.random() * 2.4,
      c_h: JSON.stringify([{ type: '-0.5', home_odds: 1.6 + Math.random() * 1.8, away_odds: 1.6 + Math.random() * 1.8 }]),
    };
    const s1 = sides[i % 3];
    const s2 = sides[(i + 1) % 3];
    const jcOdds1 = 1.3 + Math.random() * 2.5;
    const jcOdds2 = 1.3 + Math.random() * 2.5;

    const strategy = ArbitrageEngine.calculateGeneralParlayArbitrage(
      10000,
      m1,
      m2,
      s1,
      s2,
      jcOdds1,
      jcOdds2,
      0.13,
      0,
      0.02,
      0,
      i % 2 === 0 ? 'jingcai' : 'crown'
    );
    if (strategy) {
      errors.push(...validateStrategy(strategy, `stress:${i}`));
    }
  }
  return errors;
}

function runCrownHandicapScenarioChecks(): string[] {
  const errors: string[] = [];
  const ruleCases = [
    { type: '主胜(-0.5)', odds: 0.96, dg: 2, expectNet: 96 },
    { type: '主胜(-0.5)', odds: 0.96, dg: 0, expectNet: -100 },
    { type: '主胜(-1)', odds: 0.9, dg: 2, expectNet: 90 },
    { type: '主胜(-1)', odds: 0.9, dg: 1, expectNet: 0 },
    { type: '主胜(-0.5/1)', odds: 0.92, dg: 2, expectNet: 92 },
    { type: '主胜(-0.5/1)', odds: 0.92, dg: 1, expectNet: 46 },
  ];
  for (const c of ruleCases) {
    const ret = ArbitrageEngine.getReturnCoefficient(c.type, c.odds, c.dg);
    const net = (ret - 1) * 100;
    if (!almostEqual(net, c.expectNet, 1e-6)) {
      errors.push(`rule-case mismatch: type=${c.type} dg=${c.dg} net=${net} expect=${c.expectNet}`);
    }
  }

  // 覆盖“客胜+1/+2/+3”在主胜净胜1~4球下的命中/走水/亏完规则，避免单场验证遗漏皇冠让球分支
  const ahCoverageCases = [
    {
      type: 'AH_AWAY(+1)',
      expected: { 1: 'push', 2: 'lose', 3: 'lose', 4: 'lose' } as Record<number, 'win' | 'push' | 'lose'>,
    },
    {
      type: 'AH_AWAY(+2)',
      expected: { 1: 'win', 2: 'push', 3: 'lose', 4: 'lose' } as Record<number, 'win' | 'push' | 'lose'>,
    },
    {
      type: 'AH_AWAY(+3)',
      expected: { 1: 'win', 2: 'win', 3: 'push', 4: 'lose' } as Record<number, 'win' | 'push' | 'lose'>,
    },
  ];

  const classify = (coeff: number) => {
    if (!Number.isFinite(coeff) || coeff <= EPS) return 'lose' as const;
    if (almostEqual(coeff, 1, 1e-9)) return 'push' as const;
    return 'win' as const;
  };

  for (const scene of ahCoverageCases) {
    for (const dg of [1, 2, 3, 4]) {
      const coeff = ArbitrageEngine.getReturnCoefficient(scene.type, 1, dg);
      const actual = classify(coeff);
      const expected = scene.expected[dg];
      if (actual !== expected) {
        errors.push(`ah-coverage mismatch: type=${scene.type} dg=${dg} actual=${actual} expected=${expected} coeff=${coeff}`);
      }
    }
  }

  const fullWinReturn = ArbitrageEngine.getReturnCoefficient('主胜(-1/1.5)', 0.87, 2);
  if (!almostEqual(fullWinReturn, 1.87, 1e-9)) {
    errors.push(`scenario:return: expected full-win return 1.87 but got ${fullWinReturn}`);
  }

  const halfLoseReturn = ArbitrageEngine.getReturnCoefficient('主胜(-1/1.5)', 0.87, 1);
  if (!almostEqual(halfLoseReturn, 0.5, 1e-9)) {
    errors.push(`scenario:return: expected half-lose return 0.5 but got ${halfLoseReturn}`);
  }

  const awayFullWinReturn = ArbitrageEngine.getReturnCoefficient('客胜(+1/1.5)', 0.74, 0);
  if (!almostEqual(awayFullWinReturn, 1.74, 1e-9)) {
    errors.push(`scenario:return: expected away full-win return 1.74 but got ${awayFullWinReturn}`);
  }

  const settleHome = ArbitrageEngine.getSettlementCoefficients('主胜(-1/1.5)', 0.87);
  if (!almostEqual(settleHome[0].c, -0.5, 1e-9) || !almostEqual(settleHome[0].r, 0.5, 1e-9)) {
    errors.push(`scenario:settle: expected 主胜(-1/1.5) worst-home-win coeff to be c=-0.5,r=0.5`);
  }

  const rebateShareScenes = [
    { jcRebate: 0.13, jcShare: 0, crownRebate: 0.02, crownShare: 0 },
    { jcRebate: 0.15, jcShare: 0.1, crownRebate: 0.03, crownShare: 0.08 },
    { jcRebate: 0.1, jcShare: 0.2, crownRebate: 0.025, crownShare: 0.12 },
  ];

  for (let i = 0; i < rebateShareScenes.length; i++) {
    const scene = rebateShareScenes[i];
    const jcOdds = {
      W: 2.95,
      D: 3.35,
      L: 2.85,
      HW: 1.95,
      HD: 3.45,
      HL: 3.25,
      handicapLine: '-1',
      rebate: scene.jcRebate,
      share: scene.jcShare,
    };
    const crownOdds = {
      // Force LP to use handicap-only options so we can verify皇冠让球 truly participates.
      W: 0,
      D: 0,
      L: 0,
      handicaps: [
        { type: '-1/1.5', home_odds: 0.87, away_odds: 0.74 },
        { type: '-0.5', home_odds: 1.01, away_odds: 0.87 },
        { type: '+0/0.5', home_odds: 0.94, away_odds: 0.92 },
      ],
      rebate: scene.crownRebate,
      share: scene.crownShare,
    };

    const strategies = ArbitrageEngine.findAllOpportunities(10000, jcOdds, crownOdds, 'jingcai');
    for (let idx = 0; idx < strategies.length; idx++) {
      errors.push(...validateStrategy(strategies[idx], `scenario:${i}:strategy:${idx}`));
    }

    if (strategies.length > 0) {
      const hasNonHandicapBet = strategies.some((s) =>
        s.crown_bets.some((b) => {
          const type = String(b.type || '');
          return !type.startsWith('AH_HOME(') && !type.startsWith('AH_AWAY(');
        })
      );
      if (hasNonHandicapBet) {
        errors.push(`scenario:${i}: generated non-handicap crown bet unexpectedly`);
      }
    }
  }

  return errors;
}

function main() {
  const errors = [
    ...runSingleChecks(),
    ...runParlayChecks(),
    ...runRandomStress(),
    ...runCrownHandicapScenarioChecks(),
  ];

  if (errors.length > 0) {
    console.log(`CHECK_FAILED total=${errors.length}`);
    errors.slice(0, 80).forEach((e) => console.log(e));
    process.exit(1);
  }

  console.log('CHECK_OK all strategy outputs are numerically consistent.');
}

main();
