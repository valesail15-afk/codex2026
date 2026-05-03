import { HedgeStrategy, Handicap, CrownBet } from '../types';
import solver from 'javascript-lp-solver';

type Side = 'W' | 'D' | 'L';
type MarketType = 'normal' | 'handicap';

export class ArbitrageEngine {
  private static readonly EPS = 1e-9;
  private static readonly FINE_BUCKETS: Record<number, number[]> = {
    0: [2, 3, 4],
    1: [1],
    2: [0],
    3: [-1],
    4: [-2, -3, -4],
  };

  private static isFinitePositive(v: number, min = ArbitrageEngine.EPS) {
    return Number.isFinite(v) && v > min;
  }

  static hasAllPositiveParlayCombos(strategy: any, min = 0.01) {
    const combos = strategy?.parlay_combo_details;
    if (!Array.isArray(combos) || combos.length === 0) return false;
    const required = combos.filter((x: any) => x?.need_second_hedge);
    if (required.length === 0) return false;
    return required.every((x: any) => {
      const total = Number(x?.total);
      return Number.isFinite(total) && total > min;
    });
  }

  static hasAllPositiveSingleTotalProfits(strategy: any, min = 0.01) {
    const p = strategy?.profits;
    if (!p) return false;
    const win = Number(p.win);
    const draw = Number(p.draw);
    const lose = Number(p.lose);
    return Number.isFinite(win) && Number.isFinite(draw) && Number.isFinite(lose) && win > min && draw > min && lose > min;
  }

  static hasAllPositiveGoalHedgeProfits(strategy: any, min = 0.01) {
    const rows = strategy?.goal_profit_breakdown;
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return rows.every((row: any) => {
      const total = Number(row?.total_profit);
      return Number.isFinite(total) && total > min;
    });
  }

  static monitorStrategy(strategy: HedgeStrategy, context: string) {
    if (!strategy) return;
    const minProfit = strategy.min_profit;
    const rate = strategy.min_profit_rate;
    if (minProfit < -0.01) {
        console.error(`[ALARM] Negative Profit Detected! Context: ${context}, Profit: ${minProfit.toFixed(2)}, Rate: ${(rate * 100).toFixed(2)}%`);
        // In a real system, this could send a message to a bot (e.g., Feishu/Telegram)
    }
  }

  static parseHandicap(h: string): number {
    if (!h) return 0;
    const s = String(h).replace(/\s+/g, '');
    if (!s) return 0;
    if (s.includes('/')) {
      const raw = s.split('/');
      const firstSign = raw[0].startsWith('-') ? '-' : raw[0].startsWith('+') ? '+' : '';
      const vals = raw
        .map((p, idx) => {
          if (idx === 0) return Number(p);
          if (p.startsWith('+') || p.startsWith('-')) return Number(p);
          if (firstSign) return Number(`${firstSign}${p}`);
          return Number(p);
        })
        .filter((x) => Number.isFinite(x));
      if (vals.length === 0) return 0;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  private static parseBetType(type: string): { kind: 'std' | 'ah'; side: 'home' | 'away' | 'draw'; handicap?: number } {
    const t = String(type || '').replace(/\s+/g, '').trim();
    const upper = t.toUpperCase();

    if (upper === 'STD_HOME') return { kind: 'std', side: 'home' };
    if (upper === 'STD_DRAW') return { kind: 'std', side: 'draw' };
    if (upper === 'STD_AWAY') return { kind: 'std', side: 'away' };

    const ah = upper.match(/^AH_(HOME|DRAW|AWAY)\(([^)]+)\)$/);
    if (ah) {
      return {
        kind: 'ah',
        side: ah[1] === 'HOME' ? 'home' : ah[1] === 'DRAW' ? 'draw' : 'away',
        handicap: this.parseHandicap(ah[2]),
      };
    }

    const m = t.match(/^(.*?)[(（]([^)）]+)[)）]$/);
    if (m) {
      const head = String(m[1] || '').toUpperCase();
      const headRaw = String(m[1] || '');
      const handicap = this.parseHandicap(m[2]);
      if (head.includes('DRAW') || /平/.test(headRaw)) return { kind: 'ah', side: 'draw', handicap };
      if (head.includes('AWAY') || /客/.test(headRaw)) return { kind: 'ah', side: 'away', handicap };
      if (head.includes('HOME') || /主/.test(headRaw)) return { kind: 'ah', side: 'home', handicap };
      return { kind: 'ah', side: 'home', handicap };
    }

    // fallback: detect generic text labels
    if (upper.includes('HOME') || /主/.test(t)) return { kind: 'std', side: 'home' };
    if (upper.includes('DRAW') || /平/.test(t)) return { kind: 'std', side: 'draw' };
    if (upper.includes('AWAY') || /客/.test(t)) return { kind: 'std', side: 'away' };

    return { kind: 'std', side: 'home' };
  }

  static getReturnCoefficient(type: string, odds: number, dg: number): number {
    const bet = this.parseBetType(type);
    if (bet.kind === 'std') {
      if (bet.side === 'home') return dg > 0 ? odds : 0;
      if (bet.side === 'draw') return dg === 0 ? odds : 0;
      return dg < 0 ? odds : 0;
    }

    const score = bet.side === 'home' ? dg + (bet.handicap || 0) : -dg + (bet.handicap || 0);
    // Asian handicap odds are HK style; full win return is principal + odds.
    if (score >= 0.5) return 1 + odds;
    if (score === 0.25) return 1 + odds * 0.5;
    if (score === 0) return 1;
    if (score === -0.25) return 0.5;
    return 0;
  }

  private static getSettlementRatio(type: string, dg: number): number {
    const bet = this.parseBetType(type);
    if (bet.kind === 'std') return 1;
    const score = bet.side === 'home' ? dg + (bet.handicap || 0) : -dg + (bet.handicap || 0);
    if (score >= 0.5 || score <= -0.5) return 1;
    if (score === 0.25 || score === -0.25) return 0.5;
    return 0;
  }

  static getSettlementCoefficients(type: string, odds: number): [{ c: number; r: number }, { c: number; r: number }, { c: number; r: number }] {
    const worst = (dgs: number[]) => {
      const arr = dgs.map((dg) => {
        const ret = this.getReturnCoefficient(type, odds, dg);
        return { c: ret - 1, r: this.getSettlementRatio(type, dg) };
      });
      return arr.reduce((a, b) => (b.c < a.c ? b : a), arr[0]);
    };
    return [worst([1, 2, 3]), worst([0]), worst([-1, -2, -3])];
  }

  static getJingcaiReturn(side: Side, odds: number, dg: number): number {
    if (side === 'W') return dg > 0 ? odds : 0;
    if (side === 'D') return dg === 0 ? odds : 0;
    return dg < 0 ? odds : 0;
  }

  private static getJingcaiSettlementByGoalDiff(side: Side, odds: number, market: MarketType, handicapLine: string | undefined, dg: number) {
    if (market === 'normal') {
      const hit = side === 'W' ? dg > 0 : side === 'D' ? dg === 0 : dg < 0;
      return { c: hit ? odds - 1 : -1, r: 1 };
    }
    const adjusted = dg + this.parseHandicap(handicapLine || '0');
    const outcome: Side = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
    return { c: side === outcome ? odds - 1 : -1, r: 1 };
  }

  private static getCrownOptions(m: any): { type: string; odds: number }[] {
    const options: { type: string; odds: number }[] = [
      { type: 'STD_HOME', odds: Number(m.c_w || 0) },
      { type: 'STD_DRAW', odds: Number(m.c_d || 0) },
      { type: 'STD_AWAY', odds: Number(m.c_l || 0) },
    ];
    const handicaps = m.c_h ? JSON.parse(m.c_h) : [];
    handicaps.forEach((h: any) => {
      const ht = String(h.type || '');
      const awayType = ht.startsWith('+') ? ht.replace('+', '-') : ht.startsWith('-') ? ht.replace('-', '+') : `-${ht}`;
      options.push({ type: `AH_HOME(${ht})`, odds: Number(h.home_odds || 0) });
      options.push({ type: `AH_AWAY(${awayType})`, odds: Number(h.away_odds || 0) });
    });
    return options.filter((o) => this.isFinitePositive(o.odds));
  }

  private static calculateGuaranteedSingleLP(
    A: number,
    jcSide: Side,
    jcOdds: number,
    jcMarket: MarketType,
    jcHandicapLine: string | undefined,
    jcRebate: number,
    jcShare: number,
    crownOptions: { type: string; odds: number }[],
    crownRebate: number,
    crownShare: number,
    baseType: 'jingcai' | 'crown' | 'hg'
  ): HedgeStrategy | null {
    if (!this.isFinitePositive(jcOdds - 1, 1e-6)) return null;
    const C = A;
    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };
    const fineBuckets: Array<{ key: string; dgs: number[] }> = [
      { key: 'hw2p', dgs: this.FINE_BUCKETS[0] || [2, 3, 4] }, // 主胜2+
      { key: 'hw1', dgs: [1] }, // 主胜1球
      { key: 'draw', dgs: [0] }, // 平局
      { key: 'aw1', dgs: [-1] }, // 客胜1球
      { key: 'aw2p', dgs: [-2, -3] }, // 客胜2+
    ];

    fineBuckets.forEach((bucket) => {
      const jcWorst = bucket.dgs
        .map((dg) => {
          const jc = this.getJingcaiSettlementByGoalDiff(jcSide, jcOdds, jcMarket, jcHandicapLine, dg);
          return C * (jc.c + jc.r * jcRebate);
        })
        .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
      model.constraints[`p_${bucket.key}`] = { min: -jcWorst };
    });
    model.constraints.cap = { max: A * 10 };
    model.variables.z = { z: 1, cap: 0 };
    fineBuckets.forEach((bucket) => {
      model.variables.z[`p_${bucket.key}`] = -1;
    });

    crownOptions.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      fineBuckets.forEach((bucket) => {
        const crownWorst = bucket.dgs
          .map((dg) => (this.getReturnCoefficient(opt.type, opt.odds, dg) - 1) + this.getSettlementRatio(opt.type, dg) * crownRebate)
          .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
        v[`p_${bucket.key}`] = crownWorst;
      });
      model.variables[`h_${i}`] = v;
    });

    const solved: any = solver.Solve(model);
    if (!solved?.feasible) return null;

    const crown_bets: CrownBet[] = [];
    crownOptions.forEach((opt, i) => {
      const amt = Number(solved[`h_${i}`] || 0);
      if (this.isFinitePositive(amt, 0.01)) crown_bets.push({ type: opt.type, amount: amt, odds: opt.odds });
    });

    const profitByGoalDiff = (dg: number) => {
      const jc = this.getJingcaiSettlementByGoalDiff(jcSide, jcOdds, jcMarket, jcHandicapLine, dg);
      const jcProfit = C * (jc.c + jc.r * jcRebate);
      let crownProfit = 0;
      for (const b of crown_bets) {
        const ret = this.getReturnCoefficient(b.type, b.odds, dg);
        const settleRatio = this.getSettlementRatio(b.type, dg);
        crownProfit += b.amount * ((ret - 1) + settleRatio * crownRebate);
      }
      return jcProfit + crownProfit;
    };

    if (baseType === 'crown' && crown_bets.length > 0) {
      const maxCrown = Math.max(...crown_bets.map((b) => b.amount));
      if (this.isFinitePositive(maxCrown)) {
        const scale = A / maxCrown;
        crown_bets.forEach((b) => (b.amount *= scale));
      }
    }

    const bucketWorst = fineBuckets.map((bucket) => ({
      dgs: bucket.dgs,
      profit: bucket.dgs.map((dg) => profitByGoalDiff(dg)).reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY),
    }));
    const pW = bucketWorst
      .filter((x) => x.dgs.some((dg) => dg > 0))
      .map((x) => x.profit)
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    const pD = bucketWorst
      .filter((x) => x.dgs.some((dg) => dg === 0))
      .map((x) => x.profit)
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    const pL = bucketWorst
      .filter((x) => x.dgs.some((dg) => dg < 0))
      .map((x) => x.profit)
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    const minProfit = [pW, pD, pL].reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    if (!this.isFinitePositive(minProfit, 0.01)) return null;

    const userInvest = C + crown_bets.reduce((s, b) => s + b.amount, 0);
    const totalInvest = C / Math.max(1 - jcShare, 0.0001) + crown_bets.reduce((s, b) => s + b.amount / Math.max(1 - crownShare, 0.0001), 0);
    if (!this.isFinitePositive(userInvest) || !this.isFinitePositive(totalInvest)) return null;

    const rebateValue = C * jcRebate + crown_bets.reduce((s, b) => s + b.amount * crownRebate, 0);
    return {
      name: `LP对冲(${jcMarket === 'handicap' ? '让球' : '普通'}-${jcSide})`,
      jcSide,
      crown_bets,
      profits: { win: pW, draw: pD, lose: pL },
      match_profits: { win: pW - rebateValue, draw: pD - rebateValue, lose: pL - rebateValue },
      rebate: rebateValue,
      rebates: {
        win: rebateValue,
        draw: rebateValue,
        lose: rebateValue,
      },
      min_profit: minProfit,
      min_profit_rate: minProfit / userInvest,
      total_invest: totalInvest,
      user_invest: userInvest,
    };
  }

  private static calculateGuaranteedSingleLPV2(
    A: number,
    jcSide: Side,
    jcOdds: number,
    jcMarket: MarketType,
    jcHandicapLine: string | undefined,
    jcRebate: number,
    jcShare: number,
    crownOptions: { type: string; odds: number }[],
    crownRebate: number,
    crownShare: number,
    baseType: 'jingcai' | 'crown' | 'hg',
    integerUnit: number = 10000
  ): HedgeStrategy | null {
    if (!this.isFinitePositive(jcOdds - 1, 1e-6)) return null;
    const unit = Math.max(1, Math.round(Number(integerUnit || 10000)));
    const baseJc = Math.max(unit, Math.round(A / unit) * unit);
    const fineBuckets: Array<{ key: string; dgs: number[] }> = [
      { key: 'hw2p', dgs: [2, 3, 4] },
      { key: 'hw1', dgs: [1] },
      { key: 'draw', dgs: [0] },
      { key: 'aw1', dgs: [-1] },
      { key: 'aw2p', dgs: [-2, -3, -4] },
    ];

    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };
    fineBuckets.forEach((bucket) => {
      const jcWorst = bucket.dgs
        .map((dg) => {
          const jc = this.getJingcaiSettlementByGoalDiff(jcSide, jcOdds, jcMarket, jcHandicapLine, dg);
          return baseJc * (jc.c + jc.r * jcRebate);
        })
        .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
      model.constraints[`p_${bucket.key}`] = { min: -jcWorst };
    });
    model.constraints.cap = { max: A * 10 };
    model.variables.z = { z: 1, cap: 0 };
    fineBuckets.forEach((bucket) => {
      model.variables.z[`p_${bucket.key}`] = -1;
    });

    crownOptions.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      fineBuckets.forEach((bucket) => {
        const crownWorst = bucket.dgs
          .map((dg) => (this.getReturnCoefficient(opt.type, opt.odds, dg) - 1) + this.getSettlementRatio(opt.type, dg) * crownRebate)
          .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
        v[`p_${bucket.key}`] = crownWorst;
      });
      model.variables[`h_${i}`] = v;
    });

    const solved: any = solver.Solve(model);
    if (!solved?.feasible) return null;

    const crownBets: CrownBet[] = [];
    crownOptions.forEach((opt, i) => {
      const amt = Number(solved[`h_${i}`] || 0);
      if (this.isFinitePositive(amt, 0.01)) crownBets.push({ type: opt.type, amount: amt, odds: opt.odds });
    });
    if (crownBets.length === 0) return null;

    let jcAmount = baseJc;
    if (baseType === 'crown') {
      const crownTotal = crownBets.reduce((sum, b) => sum + b.amount, 0);
      if (this.isFinitePositive(crownTotal)) {
        const scale = A / crownTotal;
        jcAmount *= scale;
        crownBets.forEach((b) => (b.amount *= scale));
        crownBets.forEach((b) => {
          const rounded = Math.round(b.amount / unit) * unit;
          b.amount = Math.max(unit, rounded);
        });
      }
    }

    const profitByGoalDiff = (dg: number) => {
      const jc = this.getJingcaiSettlementByGoalDiff(jcSide, jcOdds, jcMarket, jcHandicapLine, dg);
      let profit = jcAmount * (jc.c + jc.r * jcRebate);
      for (const b of crownBets) {
        const ret = this.getReturnCoefficient(b.type, b.odds, dg);
        const settleRatio = this.getSettlementRatio(b.type, dg);
        profit += b.amount * ((ret - 1) + settleRatio * crownRebate);
      }
      return profit;
    };

    const bucketWorst = fineBuckets.map((bucket) => ({
      dgs: bucket.dgs,
      profit: bucket.dgs.map((dg) => profitByGoalDiff(dg)).reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY),
    }));
    const pW = bucketWorst
      .filter((x) => x.dgs.some((dg) => dg > 0))
      .map((x) => x.profit)
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    const pD = bucketWorst
      .filter((x) => x.dgs.some((dg) => dg === 0))
      .map((x) => x.profit)
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    const pL = bucketWorst
      .filter((x) => x.dgs.some((dg) => dg < 0))
      .map((x) => x.profit)
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    const minProfit = [pW, pD, pL].reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
    if (!this.isFinitePositive(minProfit, 0.01)) return null;

    const userInvest = jcAmount + crownBets.reduce((s, b) => s + b.amount, 0);
    const totalInvest = jcAmount / Math.max(1 - jcShare, 0.0001) + crownBets.reduce((s, b) => s + b.amount / Math.max(1 - crownShare, 0.0001), 0);
    if (!this.isFinitePositive(userInvest) || !this.isFinitePositive(totalInvest)) return null;

    const rebateValue = jcAmount * jcRebate + crownBets.reduce((s, b) => s + b.amount * crownRebate, 0);
    return {
      name: `LP对冲(${jcMarket === 'handicap' ? '让球' : '普通'}-${jcSide})`,
      jcSide,
      crown_bets: crownBets,
      profits: { win: pW, draw: pD, lose: pL },
      match_profits: { win: pW - rebateValue, draw: pD - rebateValue, lose: pL - rebateValue },
      rebate: rebateValue,
      rebates: { win: rebateValue, draw: rebateValue, lose: rebateValue },
      min_profit: minProfit,
      min_profit_rate: minProfit / userInvest,
      total_invest: totalInvest,
      user_invest: userInvest,
    };
  }

  static findAllOpportunities(
    A: number,
    jcOdds: { W: number; D: number; L: number; HW?: number; HD?: number; HL?: number; handicapLine?: string; rebate: number; share: number },
    crownOdds: {
      W: number;
      D: number;
      L: number;
      handicaps: Handicap[];
      rebate: number;
      share: number;
      goal_odds?: Array<{ label: string; odds: number }>;
      over_under_odds?: Array<{ line: string; over_odds: number; under_odds: number }>;
    },
    baseType: 'jingcai' | 'crown' | 'hg' | 'goal_hedge' = 'jingcai',
    integerUnit: number = 10000
  ): HedgeStrategy[] {
    if (baseType === 'goal_hedge') {
      return this.findAllGoalHedgeOpportunities(
        A,
        crownOdds.goal_odds || [],
        crownOdds.over_under_odds || [],
        Number(jcOdds.rebate || 0),
        Number(jcOdds.share || 0),
        Number(crownOdds.rebate || 0),
        Number(crownOdds.share || 0)
      );
    }
    if (baseType === 'hg') {
      return this.findAllHgOpportunities(A, crownOdds, integerUnit);
    }
    const markets: Array<{ side: Side; odds: number; market: MarketType; label: string }> = [
      { side: 'W', odds: Number(jcOdds.W || 0), market: 'normal', label: '主胜' },
      { side: 'D', odds: Number(jcOdds.D || 0), market: 'normal', label: '平局' },
      { side: 'L', odds: Number(jcOdds.L || 0), market: 'normal', label: '客胜' },
    ];
    if (Number(jcOdds.HW || 0) > 1) markets.push({ side: 'W', odds: Number(jcOdds.HW), market: 'handicap', label: `让胜(${jcOdds.handicapLine || '0'})` });
    if (Number(jcOdds.HD || 0) > 1) markets.push({ side: 'D', odds: Number(jcOdds.HD), market: 'handicap', label: `让平(${jcOdds.handicapLine || '0'})` });
    if (Number(jcOdds.HL || 0) > 1) markets.push({ side: 'L', odds: Number(jcOdds.HL), market: 'handicap', label: `让负(${jcOdds.handicapLine || '0'})` });

    const crownOptions: { type: string; odds: number }[] = [
      { type: 'STD_HOME', odds: Number(crownOdds.W || 0) },
      { type: 'STD_DRAW', odds: Number(crownOdds.D || 0) },
      { type: 'STD_AWAY', odds: Number(crownOdds.L || 0) },
    ];
    (crownOdds.handicaps || []).forEach((h) => {
      const awayType = String(h.type).startsWith('+')
        ? String(h.type).replace('+', '-')
        : String(h.type).startsWith('-')
        ? String(h.type).replace('-', '+')
        : `-${h.type}`;
      crownOptions.push({ type: `AH_HOME(${h.type})`, odds: Number(h.home_odds || 0) });
      crownOptions.push({ type: `AH_AWAY(${awayType})`, odds: Number(h.away_odds || 0) });
    });

    const out: HedgeStrategy[] = [];
    for (const m of markets) {
      const s = this.calculateGuaranteedSingleLPV2(
        A,
        m.side,
        m.odds,
        m.market,
        jcOdds.handicapLine,
        Number(jcOdds.rebate || 0),
        Number(jcOdds.share || 0),
        crownOptions.filter((o) => this.isFinitePositive(o.odds)),
        Number(crownOdds.rebate || 0),
        Number(crownOdds.share || 0),
        baseType,
        integerUnit
      );
      if (!s) continue;
      // Single arbitrage recommendation is based on total profit (including rebates).
      if (!this.hasAllPositiveSingleTotalProfits(s, 0.01)) continue;
      if (!(s.profits.win > 0 && s.profits.draw > 0 && s.profits.lose > 0)) continue;
      s.name = `${m.label} ${s.name}`;
      s.jc_market = m.market;
      s.jc_odds = m.odds;
      s.jc_label = m.label;
      out.push(s);
    }
    return out
      .filter((o) => o.min_profit > 0.01 && o.min_profit_rate > 0.0001)
      .sort((a, b) => {
        if (Math.abs(b.min_profit_rate - a.min_profit_rate) > 1e-12) return b.min_profit_rate - a.min_profit_rate;
        return b.min_profit - a.min_profit;
      });
  }

  private static goalLabelToIndex(labelRaw: string) {
    const s = String(labelRaw || '').trim();
    if (!s) return -1;
    if (s.includes('7+') || s.includes('7＋')) return 7;
    const m = s.match(/\d+/);
    if (!m) return -1;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return -1;
    return n >= 7 ? 7 : n;
  }

  private static parseOuLineValue(lineRaw: string) {
    const normalized = String(lineRaw || '')
      .replace(/\s+/g, '')
      .replace(/＋/g, '+')
      .replace(/－/g, '-')
      .trim();
    if (!normalized) return NaN;
    const parts = normalized
      .split('/')
      .map((segment, index, arr) => {
        if (index === 0) return Number(segment);
        if (segment.startsWith('+') || segment.startsWith('-')) return Number(segment);
        const baseSign = arr[0].startsWith('-') ? '-' : arr[0].startsWith('+') ? '+' : '';
        return Number(baseSign ? `${baseSign}${segment}` : segment);
      })
      .filter((v) => Number.isFinite(v));
    if (!parts.length) return NaN;
    return parts.reduce((sum, v) => sum + v, 0) / parts.length;
  }

  private static normalizeGoalOdds(raw: Array<{ label: string; odds: number }>) {
    const byIndex = new Map<number, { index: number; label: string; odds: number }>();
    for (const item of raw || []) {
      const index = this.goalLabelToIndex(String(item?.label || ''));
      const odds = Number(item?.odds || 0);
      if (index < 0 || !Number.isFinite(odds) || odds <= 0) continue;
      const label = index >= 7 ? '7+球' : `${index}球`;
      const existed = byIndex.get(index);
      if (!existed || odds > existed.odds) {
        byIndex.set(index, { index, label, odds });
      }
    }
    return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
  }

  private static normalizeOverUnderOdds(raw: Array<{ line: string; over_odds: number; under_odds: number }>) {
    const rows: Array<{ line: string; lineValue: number; overOdds: number; underOdds: number }> = [];
    for (const item of raw || []) {
      const lineText = String(item?.line || '').trim();
      const lineValue = this.parseOuLineValue(lineText);
      const overOdds = Number(item?.over_odds || 0);
      const underOdds = Number(item?.under_odds || 0);
      if (!Number.isFinite(lineValue) || !Number.isFinite(overOdds) || overOdds <= 0 || !Number.isFinite(underOdds) || underOdds <= 0) continue;
      rows.push({ line: lineText || String(lineValue), lineValue, overOdds, underOdds });
    }
    rows.sort((a, b) => a.lineValue - b.lineValue);
    const dedup = new Map<string, { line: string; lineValue: number; overOdds: number; underOdds: number }>();
    for (const row of rows) {
      const key = `${row.lineValue.toFixed(3)}_${row.overOdds.toFixed(3)}_${row.underOdds.toFixed(3)}`;
      if (!dedup.has(key)) dedup.set(key, row);
    }
    return Array.from(dedup.values());
  }

  private static getOuSettlementScore(side: 'over' | 'under', lineValue: number, goals: number) {
    return side === 'over' ? goals - lineValue : lineValue - goals;
  }

  private static getOuReturnCoefficient(side: 'over' | 'under', lineValue: number, odds: number, goals: number) {
    const score = this.getOuSettlementScore(side, lineValue, goals);
    // 皇冠中奖收益 = 纯利润 + 退回本金
    if (score >= 0.5) return 1 + odds;
    // 半赢：半注中奖、半注走水（退本金）
    if (score === 0.25) return 1 + odds * 0.5;
    if (score === 0) return 1;
    if (score === -0.25) return 0.5;
    return 0;
  }

  private static getOuSettlementRatio(side: 'over' | 'under', lineValue: number, goals: number) {
    const score = this.getOuSettlementScore(side, lineValue, goals);
    if (score >= 0.5 || score <= -0.5) return 1;
    if (score === 0.25 || score === -0.25) return 0.5;
    return 0;
  }

  private static calculateGoalHedgePlan(
    A: number,
    selectedGoals: Array<{ index: number; label: string; odds: number }>,
    ou: { line: string; lineValue: number; overOdds: number; underOdds: number },
    jcRebate: number,
    jcShare: number,
    crownRebate: number,
    crownShare: number
  ): HedgeStrategy | null {
    if (!selectedGoals.length) return null;
    const goalStates = [0, 1, 2, 3, 4, 5, 6, 7];
    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };
    model.constraints.cap = { max: A };
    goalStates.forEach((goal) => {
      model.constraints[`p_${goal}`] = { min: 0 };
    });
    model.variables.z = { z: 1, cap: 0 };
    goalStates.forEach((goal) => {
      model.variables.z[`p_${goal}`] = -1;
    });

    selectedGoals.forEach((goal, idx) => {
      const varName = `jc_${idx}`;
      const minKey = `jc_min_${idx}`;
      model.constraints[minKey] = { min: 1 };
      const v: any = { z: 0, cap: 1 };
      v[minKey] = 1;
      goalStates.forEach((state) => {
        const hit = state === goal.index;
        const coeff = (hit ? goal.odds : 0) - 1 + jcRebate;
        v[`p_${state}`] = coeff;
      });
      model.variables[varName] = v;
    });

    model.constraints.ou_min = { min: 1 };
    const ouVar: any = { z: 0, cap: 1, ou_min: 1 };
    goalStates.forEach((state) => {
      const goals = state >= 7 ? 7 : state;
      const ret = this.getOuReturnCoefficient('over', ou.lineValue, ou.overOdds, goals);
      const settleRatio = this.getOuSettlementRatio('over', ou.lineValue, goals);
      ouVar[`p_${state}`] = (ret - 1) + settleRatio * crownRebate;
    });
    model.variables.ou = ouVar;

    const solved: any = solver.Solve(model);
    if (!solved?.feasible) return null;

    const round2 = (v: number) => Math.round(Number(v || 0) * 100) / 100;
    let jcPicks = selectedGoals
      .map((goal, idx) => ({ ...goal, amount: round2(Number(solved[`jc_${idx}`] || 0)) }))
      .filter((item) => this.isFinitePositive(item.amount, 0.01));
    let ouAmount = round2(Number(solved.ou || 0));
    if (jcPicks.length !== selectedGoals.length || !this.isFinitePositive(ouAmount, 0.01)) return null;

    const buildBreakdown = (currentJcPicks: Array<{ index: number; label: string; odds: number; amount: number }>, currentOuAmount: number) =>
      goalStates.map((state) => {
      const goals = state >= 7 ? 7 : state;
      const goalLabel = state >= 7 ? '7+球' : `${state}球`;
      const jcStake = currentJcPicks.reduce((sum, item) => sum + item.amount, 0);
      const jcReturn = currentJcPicks.reduce((sum, item) => sum + (item.index === state ? item.amount * item.odds : 0), 0);
      const jcRebateValue = jcStake * jcRebate;
      const ouReturn = currentOuAmount * this.getOuReturnCoefficient('over', ou.lineValue, ou.overOdds, goals);
      const ouSettleRatio = this.getOuSettlementRatio('over', ou.lineValue, goals);
      const ouRebateValue = currentOuAmount * ouSettleRatio * crownRebate;
      const totalStake = jcStake + currentOuAmount;
      const grossReturn = jcReturn + ouReturn;
      const matchProfit = grossReturn - totalStake;
      const rebate = jcRebateValue + ouRebateValue;
      const totalProfit = matchProfit + rebate;
      return {
        goal: state >= 7 ? '7+' : String(state),
        goal_label: goalLabel,
        jc_return: jcReturn,
        ou_return: ouReturn,
        gross_return: grossReturn,
        stake: totalStake,
        match_profit: matchProfit,
        rebate,
        total_profit: totalProfit,
      };
    });

    let breakdown = buildBreakdown(jcPicks, ouAmount);

    const minProfit = breakdown.reduce((min, row) => (row.total_profit < min ? row.total_profit : min), Number.POSITIVE_INFINITY);
    if (!this.isFinitePositive(minProfit, 0.01)) return null;

    const userInvest = jcPicks.reduce((sum, item) => sum + item.amount, 0) + ouAmount;
    const totalInvest =
      jcPicks.reduce((sum, item) => sum + item.amount / Math.max(1 - jcShare, 0.0001), 0) +
      ouAmount / Math.max(1 - crownShare, 0.0001);
    if (!this.isFinitePositive(userInvest) || !this.isFinitePositive(totalInvest)) return null;

    // 二次一致性校验：按两位小数后的真实下注金额必须全场景为正
    breakdown = buildBreakdown(jcPicks, ouAmount);
    const roundedMinProfit = breakdown.reduce((min, row) => (row.total_profit < min ? row.total_profit : min), Number.POSITIVE_INFINITY);
    if (!this.isFinitePositive(roundedMinProfit, 0.01)) return null;
    const maxRebate = Math.max(...breakdown.map((row) => Number(row.rebate || 0)));
    return {
      name: `进球对冲(0-${Math.max(...selectedGoals.map((g) => g.index))} + 大${ou.line})`,
      jcSide: 'D',
      jc_market: 'normal',
      jc_odds: Number(selectedGoals[0]?.odds || 0),
      jc_label: selectedGoals.map((item) => item.label).join('/'),
      crown_bets: [{ type: `OU_OVER(${ou.line})`, amount: ouAmount, odds: ou.overOdds }],
      profits: { win: minProfit, draw: minProfit, lose: minProfit },
      match_profits: { win: minProfit - maxRebate, draw: minProfit - maxRebate, lose: minProfit - maxRebate },
      rebate: maxRebate,
      rebates: { win: maxRebate, draw: maxRebate, lose: maxRebate },
      min_profit: roundedMinProfit,
      min_profit_rate: roundedMinProfit / userInvest,
      total_invest: totalInvest,
      user_invest: userInvest,
      goal_hedge_meta: {
        goal_picks: jcPicks.map((item) => ({
          goal_index: item.index >= 7 ? '7+' : String(item.index),
          label: item.label,
          odds: item.odds,
          amount: item.amount,
        })),
        ou_bet: { side: 'over', line: ou.line, odds: ou.overOdds, amount: ouAmount },
      },
      goal_profit_breakdown: breakdown,
    } as any;
  }

  private static findAllGoalHedgeOpportunities(
    A: number,
    goalOddsRaw: Array<{ label: string; odds: number }>,
    overUnderRaw: Array<{ line: string; over_odds: number; under_odds: number }>,
    jcRebate: number,
    jcShare: number,
    crownRebate: number,
    crownShare: number
  ): HedgeStrategy[] {
    const goalOdds = this.normalizeGoalOdds(goalOddsRaw);
    const overUnders = this.normalizeOverUnderOdds(overUnderRaw);
    if (!goalOdds.length || !overUnders.length) return [];

    const indexToGoal = new Map<number, { index: number; label: string; odds: number }>();
    goalOdds.forEach((row) => indexToGoal.set(row.index, row));

    const out: HedgeStrategy[] = [];
    for (let k = 0; k <= 6; k++) {
      const selectedGoals: Array<{ index: number; label: string; odds: number }> = [];
      for (let idx = 0; idx <= k; idx++) {
        const row = indexToGoal.get(idx);
        if (!row) {
          selectedGoals.length = 0;
          break;
        }
        selectedGoals.push(row);
      }
      if (!selectedGoals.length) continue;
      for (const ou of overUnders) {
        const strategy = this.calculateGoalHedgePlan(A, selectedGoals, ou, jcRebate, jcShare, crownRebate, crownShare);
        if (!strategy) continue;
        if (!this.hasAllPositiveGoalHedgeProfits(strategy, 0.01)) continue;
        out.push(strategy);
      }
    }

    return out
      .filter((item) => this.isFinitePositive(Number(item?.min_profit || 0), 0.01) && this.isFinitePositive(Number(item?.min_profit_rate || 0), 0.0001))
      .sort((a, b) => {
        if (Math.abs(Number(b.min_profit_rate || 0) - Number(a.min_profit_rate || 0)) > 1e-12) return Number(b.min_profit_rate || 0) - Number(a.min_profit_rate || 0);
        return Number(b.min_profit || 0) - Number(a.min_profit || 0);
      });
  }

  private static calculateGuaranteedHgLP(
    A: number,
    base: { type: string; odds: number },
    crownOptions: { type: string; odds: number }[],
    crownRebate: number,
    crownShare: number
  ): HedgeStrategy | null {
    if (!this.isFinitePositive(base.odds, 1e-6)) return null;
    const C = A;
    const fineBuckets: Array<{ key: string; dgs: number[] }> = [
      { key: 'hw2p', dgs: [2, 3, 4] },
      { key: 'hw1', dgs: [1] },
      { key: 'draw', dgs: [0] },
      { key: 'aw1', dgs: [-1] },
      { key: 'aw2p', dgs: [-2, -3, -4] },
    ];

    // HG 口径：标准盘中奖返还系数=odds；让球盘中奖返还系数=1+odds
    const getHgReturnCoefficient = (type: string, odds: number, dg: number) => {
      const bet = this.parseBetType(type);
      if (bet.kind === 'std') {
        if (bet.side === 'home') return dg > 0 ? odds : 0;
        if (bet.side === 'draw') return dg === 0 ? odds : 0;
        return dg < 0 ? odds : 0;
      }
      const score = bet.side === 'home' ? dg + (bet.handicap || 0) : -dg + (bet.handicap || 0);
      if (score >= 0.5) return 1 + odds;
      if (score === 0.25) return 1 + odds * 0.5;
      if (score === 0) return 1;
      if (score === -0.25) return 0.5;
      return 0;
    };

    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };
    fineBuckets.forEach((bucket) => {
      const baseWorst = bucket.dgs
        .map((dg) => (getHgReturnCoefficient(base.type, base.odds, dg) - 1) + this.getSettlementRatio(base.type, dg) * crownRebate)
        .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
      model.constraints[`p_${bucket.key}`] = { min: -C * baseWorst };
    });
    model.constraints.cap = { max: A * 10 };
    model.variables.z = { z: 1, cap: 0 };
    fineBuckets.forEach((bucket) => {
      model.variables.z[`p_${bucket.key}`] = -1;
    });

    // HG 对冲规则：基准注来自皇冠胜平负，对冲注只使用皇冠让球
    const hedgeOptions = crownOptions.filter((opt) => /^AH_/.test(String(opt.type || '')) && this.isFinitePositive(opt.odds));
    hedgeOptions.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      fineBuckets.forEach((bucket) => {
        const crownWorst = bucket.dgs
          .map((dg) => (getHgReturnCoefficient(opt.type, opt.odds, dg) - 1) + this.getSettlementRatio(opt.type, dg) * crownRebate)
          .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
        v[`p_${bucket.key}`] = crownWorst;
      });
      model.variables[`h_${i}`] = v;
    });

    const solved: any = solver.Solve(model);
    if (!solved?.feasible) return null;

    const crown_bets: CrownBet[] = [];
    hedgeOptions.forEach((opt, i) => {
      const amt = Number(solved[`h_${i}`] || 0);
      if (this.isFinitePositive(amt, 0.01)) crown_bets.push({ type: opt.type, amount: amt, odds: opt.odds });
    });
    if (crown_bets.length === 0) return null;

    const profitByGoalDiff = (dg: number) => {
      const baseProfit = C * ((getHgReturnCoefficient(base.type, base.odds, dg) - 1) + this.getSettlementRatio(base.type, dg) * crownRebate);
      let profit = baseProfit;
      for (const b of crown_bets) {
        profit += b.amount * ((getHgReturnCoefficient(b.type, b.odds, dg) - 1) + this.getSettlementRatio(b.type, dg) * crownRebate);
      }
      return profit;
    };

    const minByGoalDiffs = (dgs: number[]) =>
      dgs.map((dg) => profitByGoalDiff(dg)).reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);

    const pW = minByGoalDiffs([1, 2, 3, 4]);
    const pD = profitByGoalDiff(0);
    const pL = minByGoalDiffs([-1, -2, -3, -4]);
    const minProfit = Math.min(pW, pD, pL);
    if (!this.isFinitePositive(minProfit, 0.01)) return null;

    const userInvest = C + crown_bets.reduce((s, b) => s + b.amount, 0);
    const totalInvest = C / Math.max(1 - crownShare, 0.0001) + crown_bets.reduce((s, b) => s + b.amount / Math.max(1 - crownShare, 0.0001), 0);
    if (!this.isFinitePositive(userInvest) || !this.isFinitePositive(totalInvest)) return null;

    const rebateValue = (C + crown_bets.reduce((s, b) => s + b.amount, 0)) * crownRebate;
    return {
      name: `HG对冲(${base.type})`,
      hg_base_bet: { type: base.type, amount: C, odds: base.odds },
      crown_bets,
      profits: { win: pW, draw: pD, lose: pL },
      match_profits: { win: pW - rebateValue, draw: pD - rebateValue, lose: pL - rebateValue },
      rebate: rebateValue,
      rebates: { win: rebateValue, draw: rebateValue, lose: rebateValue },
      min_profit: minProfit,
      min_profit_rate: minProfit / userInvest,
      total_invest: totalInvest,
      user_invest: userInvest,
    };
  }

  private static findAllHgOpportunities(
    A: number,
    crownOdds: { W: number; D: number; L: number; handicaps: Handicap[]; rebate: number; share: number },
    _integerUnit: number = 10000
  ): HedgeStrategy[] {
    const crownOptions: { type: string; odds: number }[] = [
      { type: 'STD_HOME', odds: Number(crownOdds.W || 0) },
      { type: 'STD_DRAW', odds: Number(crownOdds.D || 0) },
      { type: 'STD_AWAY', odds: Number(crownOdds.L || 0) },
    ];
    (crownOdds.handicaps || []).forEach((h) => {
      const awayType = String(h.type).startsWith('+')
        ? String(h.type).replace('+', '-')
        : String(h.type).startsWith('-')
        ? String(h.type).replace('-', '+')
        : `-${h.type}`;
      crownOptions.push({ type: `AH_HOME(${h.type})`, odds: Number(h.home_odds || 0) });
      crownOptions.push({ type: `AH_AWAY(${awayType})`, odds: Number(h.away_odds || 0) });
    });

    const out: HedgeStrategy[] = [];
    // HG 对冲规则：base 只允许皇冠胜平负（STD_*）
    const baseCandidates = crownOptions.filter((o) => /^STD_/.test(String(o.type || '')) && this.isFinitePositive(o.odds));
    for (const base of baseCandidates) {
      const s = this.calculateGuaranteedHgLP(
        A,
        base,
        crownOptions.filter((o) => this.isFinitePositive(o.odds)),
        Number(crownOdds.rebate || 0),
        Number(crownOdds.share || 0)
      );
      if (!s) continue;
      if (!this.hasAllPositiveSingleTotalProfits(s, 0.01)) continue;
      if (!(s.profits.win > 0 && s.profits.draw > 0 && s.profits.lose > 0)) continue;
      out.push(s);
    }
    return out
      .filter((o) => o.min_profit > 0.01 && o.min_profit_rate > 0.0001)
      .sort((a, b) => {
        if (Math.abs(b.min_profit_rate - a.min_profit_rate) > 1e-12) return b.min_profit_rate - a.min_profit_rate;
        return b.min_profit - a.min_profit;
      });
  }

  static calculateGeneralParlayArbitrage(
    A: number,
    m1: any,
    m2: any,
    jcSide1: Side,
    jcSide2: Side,
    jcOdds1: number,
    jcOdds2: number,
    jcRebate: number,
    jcShare: number,
    crownRebate: number,
    crownShare: number,
    baseType: 'jingcai' | 'crown' = 'jingcai'
  ): HedgeStrategy | null {
    const c1 = this.getCrownOptions(m1);
    const c2 = this.getCrownOptions(m2);
    if (c1.length === 0 || c2.length === 0 || !this.isFinitePositive(jcOdds1) || !this.isFinitePositive(jcOdds2)) return null;

    const outcomes: Side[] = ['W', 'D', 'L'];
    const C = A;
    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };

    for (const s1 of outcomes) {
      for (const s2 of outcomes) {
        const key = `p_${s1}_${s2}`;
        const hit = jcSide1 === s1 && jcSide2 === s2;
        const jcReturn = hit ? jcOdds1 * jcOdds2 : 0;
        const jcProfit = C * (jcReturn - 1 + jcRebate);
        model.constraints[key] = { min: -jcProfit };
      }
    }

    model.constraints.cap = { max: A * 20 };
    model.variables.z = { z: 1, cap: 0 };
    for (const s1 of outcomes) {
      for (const s2 of outcomes) {
        model.variables.z[`p_${s1}_${s2}`] = -1;
      }
    }

    c1.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      for (const s1 of outcomes) {
        const idx1 = s1 === 'W' ? 0 : s1 === 'D' ? 1 : 2;
        const sc1 = this.getSettlementCoefficients(opt.type, opt.odds)[idx1];
        for (const s2 of outcomes) {
          v[`p_${s1}_${s2}`] = sc1.c + sc1.r * crownRebate;
        }
      }
      model.variables[`h1_${i}`] = v;
    });

    c2.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      for (const s2 of outcomes) {
        const idx2 = s2 === 'W' ? 0 : s2 === 'D' ? 1 : 2;
        const sc2 = this.getSettlementCoefficients(opt.type, opt.odds)[idx2];
        for (const s1 of outcomes) {
          v[`p_${s1}_${s2}`] = sc2.c + sc2.r * crownRebate;
        }
      }
      model.variables[`h2_${i}`] = v;
    });

    const solved: any = solver.Solve(model);
    if (!solved?.feasible) return null;

    const crown_bets: CrownBet[] = [];
    c1.forEach((opt, i) => {
      const amount = Number(solved[`h1_${i}`] || 0);
      if (this.isFinitePositive(amount, 0.01)) crown_bets.push({ type: opt.type, amount, odds: opt.odds, match_index: 0 });
    });
    c2.forEach((opt, i) => {
      const amount = Number(solved[`h2_${i}`] || 0);
      if (this.isFinitePositive(amount, 0.01)) crown_bets.push({ type: opt.type, amount, odds: opt.odds, match_index: 1 });
    });
    if (crown_bets.length === 0) return null;

    if (baseType === 'crown') {
      const maxCrown = Math.max(...crown_bets.map((b) => b.amount));
      if (this.isFinitePositive(maxCrown)) {
        const scale = A / maxCrown;
        crown_bets.forEach((b) => (b.amount *= scale));
      }
    }

    const evalProfit = (s1: Side, s2: Side) => {
      const hit = jcSide1 === s1 && jcSide2 === s2;
      const jcReturn = hit ? jcOdds1 * jcOdds2 : 0;
      let p = C * (jcReturn - 1 + jcRebate);
      for (const b of crown_bets) {
        const s = b.match_index === 0 ? s1 : s2;
        const idx = s === 'W' ? 0 : s === 'D' ? 1 : 2;
        const sc = this.getSettlementCoefficients(b.type, b.odds)[idx];
        p += b.amount * (sc.c + sc.r * crownRebate);
      }
      return p;
    };

    const allProfits: number[] = [];
    for (const s1 of outcomes) {
      for (const s2 of outcomes) allProfits.push(evalProfit(s1, s2));
    }
    const minProfit = Math.min(...allProfits);
    if (!this.isFinitePositive(minProfit, 0.01)) return null;

    const profits = { win: evalProfit('W', 'W'), draw: evalProfit('D', 'D'), lose: evalProfit('L', 'L') };
    const userInvest = C + crown_bets.reduce((s, b) => s + b.amount, 0);
    const totalInvest = C / Math.max(1 - jcShare, 0.0001) + crown_bets.reduce((s, b) => s + b.amount / Math.max(1 - crownShare, 0.0001), 0);
    const rebateValue = C * jcRebate + crown_bets.reduce((s, b) => s + b.amount * crownRebate, 0);

    return {
      name: `二串一对冲(${jcSide1}x${jcSide2})`,
      jcSide: jcSide1,
      crown_bets,
      profits,
      match_profits: { win: profits.win - rebateValue, draw: profits.draw - rebateValue, lose: profits.lose - rebateValue },
      rebate: rebateValue,
      rebates: { win: rebateValue, draw: rebateValue, lose: rebateValue },
      min_profit: minProfit,
      min_profit_rate: minProfit / userInvest,
      total_invest: totalInvest,
      user_invest: userInvest,
    };
  }

  private static getFineStateWorstReturnByDG(fn: (dg: number) => number, state: 0 | 1 | 2 | 3 | 4): number {
    const vals = (this.FINE_BUCKETS[state] || [0]).map((dg) => fn(dg));
    return vals.reduce((a, b) => (b < a ? b : a), vals[0] ?? 0);
  }

  private static getJingcaiFineReturns(side: Side, odds: number, market: MarketType, handicapLine?: string) {
    const f = (dg: number) => {
      if (market === 'normal') return this.getJingcaiReturn(side, odds, dg);
      const adjusted = dg + this.parseHandicap(handicapLine || '0');
      const outcome: Side = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
      return outcome === side ? odds : 0;
    };
    return [
      this.getFineStateWorstReturnByDG(f, 0),
      this.getFineStateWorstReturnByDG(f, 1),
      this.getFineStateWorstReturnByDG(f, 2),
      this.getFineStateWorstReturnByDG(f, 3),
      this.getFineStateWorstReturnByDG(f, 4),
    ];
  }

  private static getCrownFineReturns(type: string, odds: number) {
    const f = (dg: number) => this.getReturnCoefficient(type, odds, dg);
    return [
      this.getFineStateWorstReturnByDG(f, 0),
      this.getFineStateWorstReturnByDG(f, 1),
      this.getFineStateWorstReturnByDG(f, 2),
      this.getFineStateWorstReturnByDG(f, 3),
      this.getFineStateWorstReturnByDG(f, 4),
    ];
  }

  private static calculateParlayArbitrageFineLP(
    A: number,
    m1: any,
    m2: any,
    jc1: { side: Side; odds: number; market: MarketType; handicapLine?: string },
    jc2: { side: Side; odds: number; market: MarketType; handicapLine?: string },
    _baseType: 'jingcai' | 'crown' = 'jingcai'
  ): HedgeStrategy | null {
    const c1 = this.getCrownOptions(m1);
    const c2 = this.getCrownOptions(m2);
    if (c1.length === 0 || c2.length === 0) return null;

    const outcomes: Side[] = ['W', 'D', 'L'];
    const outcomeGoalDiffs: Record<Side, number[]> = {
      W: [1, 2, 3, 4],
      D: [0],
      L: [-1, -2, -3, -4],
    };
    const outcomeLabel = (side: Side) => (side === 'W' ? 'win' : side === 'D' ? 'draw' : 'lose');
    const C = A;
    const rJcRaw = Number(m1.j_r || 0);
    const rHgRaw = Number(m1.c_r || 0);
    const sJc = Number(m1.j_s || 0);
    const sHg = Number(m1.c_s || 0);
    // Parlay filtering should use the original rebate mode.
    // Share ratios are only used later when converting to actual stake / total invest displays.
    const rJc = rJcRaw;
    const rHg = rHgRaw;

    const minByGoalDiffs = (dgs: number[], fn: (dg: number) => number) =>
      dgs.map((dg) => fn(dg)).reduce((min, v) => (v < min ? v : min), Number.POSITIVE_INFINITY);
    const maxByGoalDiffs = (dgs: number[], fn: (dg: number) => number) =>
      dgs.map((dg) => fn(dg)).reduce((max, v) => (v > max ? v : max), Number.NEGATIVE_INFINITY);
    const minByPairs = (dgs1: number[], dgs2: number[], fn: (dg1: number, dg2: number) => number) => {
      let worst = Number.POSITIVE_INFINITY;
      for (const dg1 of dgs1) {
        for (const dg2 of dgs2) {
          const value = fn(dg1, dg2);
          if (value < worst) worst = value;
        }
      }
      return worst;
    };

    const firstJcHits = (side: Side) => {
      const coeffs = outcomeGoalDiffs[side].map(dg => 
        this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg).c
      );
      return coeffs.some(c => c > this.EPS);
    };

    const firstJcAlwaysMisses = (side: Side) => {
      const coeffs = outcomeGoalDiffs[side].map(dg => 
        this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg).c
      );
      return coeffs.every(c => c < -0.5);
    };

    const parlayProfit = (side1: Side, side2: Side) => {
      let worst = Number.POSITIVE_INFINITY;
      for (const dg1 of outcomeGoalDiffs[side1]) {
        for (const dg2 of outcomeGoalDiffs[side2]) {
          const r1 = this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg1);
          const r2 = this.getJingcaiSettlementByGoalDiff(jc2.side, jc2.odds, jc2.market, jc2.handicapLine, dg2);
          const hit = r1.c > this.EPS && r2.c > this.EPS;
          const ret = hit ? jc1.odds * jc2.odds : 0;
          const val = C * (ret - 1 + rJc);
          if (val < worst) worst = val;
        }
      }
      return worst;
    };
    
    const stopProfit = (side1: Side) => {
      let worst = Number.POSITIVE_INFINITY;
      for (const dg1 of outcomeGoalDiffs[side1]) {
        const r1 = this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg1);
        if (r1.c < -0.5) {
            const val = C * (-1 + rJc);
            if (val < worst) worst = val;
        }
      }
      return worst === Number.POSITIVE_INFINITY ? C * (-1 + rJc) : worst;
    };

    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };
    model.constraints.cap = { max: A * 20 };
    model.variables.z = { z: 1, cap: 0 };

    const requiredKeys: string[] = [];
    for (const s1 of outcomes) {
      if (firstJcHits(s1)) {
        for (const s2 of outcomes) {
          const key = `p_${s1}_${s2}`;
          requiredKeys.push(key);
          model.constraints[key] = { min: -parlayProfit(s1, s2) };
          model.variables.z[key] = -1;
        }
      }
      // 关键：只要该 side 下有任何 dg 导致竞彩挂掉，就必须通过 LP 确保亏损可控
      const coeffs = outcomeGoalDiffs[s1].map(dg => 
        this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg).c
      );
      if (coeffs.some(c => c < -0.5)) {
        const key = `p_${s1}_stop`;
        requiredKeys.push(key);
        model.constraints[key] = { min: -stopProfit(s1) };
        model.variables.z[key] = -1;
      }
    }

    c1.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      for (const s1 of outcomes) {
        const value = minByGoalDiffs(outcomeGoalDiffs[s1], (dg1) => {
          const ret = this.getReturnCoefficient(opt.type, opt.odds, dg1);
          const settleRatio = this.getSettlementRatio(opt.type, dg1);
          return ret - 1 + settleRatio * rHg;
        });
        if (firstJcHits(s1)) {
          for (const s2 of outcomes) {
            const key = `p_${s1}_${s2}`;
            v[key] = value;
          }
        }
        const coeffs = outcomeGoalDiffs[s1].map(dg => 
          this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg).c
        );
        if (coeffs.some(c => c < -0.5)) {
          const key = `p_${s1}_stop`;
          if (v[key] === undefined) v[key] = 0;
          v[key] += value;
        }
      }
      model.variables[`h1_${i}`] = v;
    });

    c2.forEach((opt, i) => {
      const v: any = { z: 0, cap: 1 };
      for (const s1 of outcomes) {
        if (firstJcHits(s1)) {
          for (const s2 of outcomes) {
            const value = minByGoalDiffs(outcomeGoalDiffs[s2], (dg2) => {
              const ret = this.getReturnCoefficient(opt.type, opt.odds, dg2);
              const settleRatio = this.getSettlementRatio(opt.type, dg2);
              return ret - 1 + settleRatio * rHg;
            });
            const key = `p_${s1}_${s2}`;
            v[key] = value;
          }
        }
        const coeffs = outcomeGoalDiffs[s1].map(dg => 
          this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg).c
        );
        if (coeffs.some(c => c < -0.5)) {
          const key = `p_${s1}_stop`;
          v[key] = 0; 
        }
      }
      model.variables[`h2_${i}`] = v;
    });

    const solved: any = solver.Solve(model);
    if (!solved?.feasible) return null;

    const crown_bets: CrownBet[] = [];
    c1.forEach((opt, i) => {
      const amount = Number(solved[`h1_${i}`] || 0);
      if (this.isFinitePositive(amount, 0.01)) crown_bets.push({ type: opt.type, amount, odds: opt.odds, match_index: 0 });
    });
    c2.forEach((opt, i) => {
      const amount = Number(solved[`h2_${i}`] || 0);
      if (this.isFinitePositive(amount, 0.01)) crown_bets.push({ type: opt.type, amount, odds: opt.odds, match_index: 1 });
    });
    if (crown_bets.length === 0) return null;

    const m1Bets = crown_bets.filter((b) => Number(b.match_index) === 0);
    const m2Bets = crown_bets.filter((b) => Number(b.match_index) === 1);

    const firstGrossByOutcome = (s1: Side) =>
      minByGoalDiffs(outcomeGoalDiffs[s1], (dg) =>
        m1Bets.reduce((sum, b) => sum + b.amount * this.getReturnCoefficient(b.type, b.odds, dg), 0)
      );

    const firstProfitByOutcome = (s1: Side) =>
      minByGoalDiffs(outcomeGoalDiffs[s1], (dg) =>
        m1Bets.reduce((sum, b) => {
          const ret = this.getReturnCoefficient(b.type, b.odds, dg);
          const settleRatio = this.getSettlementRatio(b.type, dg);
          return sum + b.amount * (ret - 1 + settleRatio * rHg);
        }, 0)
      );

    const secondProfitByOutcome = (s2: Side) =>
      minByGoalDiffs(outcomeGoalDiffs[s2], (dg) =>
        m2Bets.reduce((sum, b) => {
          const ret = this.getReturnCoefficient(b.type, b.odds, dg);
          const settleRatio = this.getSettlementRatio(b.type, dg);
          return sum + b.amount * (ret - 1 + settleRatio * rHg);
        }, 0)
      );

    const evalTotal = (s1: Side, s2: Side) => {
      let minTotal = Number.POSITIVE_INFINITY;
      for (const dg1 of outcomeGoalDiffs[s1]) {
        const r1 = this.getJingcaiSettlementByGoalDiff(jc1.side, jc1.odds, jc1.market, jc1.handicapLine, dg1);
        const firstHit = r1.c > this.EPS;
        
        const fP = m1Bets.reduce((sum, b) => {
          const ret = this.getReturnCoefficient(b.type, b.odds, dg1);
          const settleRatio = this.getSettlementRatio(b.type, dg1);
          return sum + b.amount * (ret - 1 + settleRatio * rHg);
        }, 0);

        if (firstHit) {
          for (const dg2 of outcomeGoalDiffs[s2]) {
            const r2 = this.getJingcaiSettlementByGoalDiff(jc2.side, jc2.odds, jc2.market, jc2.handicapLine, dg2);
            const parlayHit = r2.c > this.EPS;
            const jcProfit = C * ((parlayHit ? jc1.odds * jc2.odds : 0) - 1 + rJc);
            
            const sP = m2Bets.reduce((sum, b) => {
              const ret = this.getReturnCoefficient(b.type, b.odds, dg2);
              const settleRatio = this.getSettlementRatio(b.type, dg2);
              return sum + b.amount * (ret - 1 + settleRatio * rHg);
            }, 0);
            
            const total = jcProfit + fP + sP;
            if (total < minTotal) minTotal = total;
          }
        } else {
          const jcProfit = C * (-1 + rJc);
          const total = jcProfit + fP;
          if (total < minTotal) minTotal = total;
        }
      }
      return minTotal;
    };

    const comboDetails: Array<{
      key: string;
      first: Side;
      second: Side;
      first_label: string;
      second_label: string;
      total: number;
      match: number;
      rebate: number;
      need_second_hedge: boolean;
      first_crown_hit: boolean;
    }> = [];

    for (const s1 of outcomes) {
      const firstCrownHit = firstGrossByOutcome(s1) > this.EPS;
      const needSecondHedge = firstJcHits(s1);
      for (const s2 of outcomes) {
        const total = evalTotal(s1, s2);
        comboDetails.push({
          key: `${outcomeLabel(s1)}_${outcomeLabel(s2)}`,
          first: s1,
          second: s2,
          first_label: outcomeLabel(s1),
          second_label: outcomeLabel(s2),
          total,
          match: total,
          rebate: 0,
          need_second_hedge: needSecondHedge,
          first_crown_hit: firstCrownHit,
        });
      }
    }

    const minProfit = Math.min(...comboDetails.map((c) => c.total));
    if (!this.isFinitePositive(minProfit, 0.01)) {
        if (minProfit < -0.1) {
            ArbitrageEngine.monitorStrategy({ min_profit: minProfit, min_profit_rate: minProfit / userInvest } as any, `Parlay LP: ${jc1.side}x${jc2.side}`);
        }
        return null;
    }

    const userInvest = C + crown_bets.reduce((s, b) => s + b.amount, 0);
    const totalInvest = C / Math.max(1 - sJc, 0.0001) + crown_bets.reduce((s, b) => s + b.amount / Math.max(1 - sHg, 0.0001), 0);
    const rebateValue = C * rJc + crown_bets.reduce((s, b) => s + b.amount * rHg, 0);

    const match1Profit = (side: Side) =>
      comboDetails.filter((x) => x.first === side).reduce((min, x) => (x.total < min ? x.total : min), Number.POSITIVE_INFINITY);

    const firstHitSides = outcomes.filter((side) => firstJcHits(side));
    const match2Profit = (side: Side) => {
      if (!firstHitSides.length) return Number.POSITIVE_INFINITY;
      return comboDetails
        .filter((x) => x.need_second_hedge && x.second === side)
        .reduce((min, x) => (x.total < min ? x.total : min), Number.POSITIVE_INFINITY);
    };

    return {
      name: `二串一LP(${this.formatParlayLegName(jc1)}x${this.formatParlayLegName(jc2)})`,
      jcSide: jc1.side,
      crown_bets,
      profits: {
        win: match1Profit('W'),
        draw: match1Profit('D'),
        lose: match1Profit('L'),
      },
      match_profits: {
        win: match1Profit('W') - rebateValue,
        draw: match1Profit('D') - rebateValue,
        lose: match1Profit('L') - rebateValue,
      },
      rebate: rebateValue,
      rebates: { win: rebateValue, draw: rebateValue, lose: rebateValue },
      min_profit: minProfit,
      min_profit_rate: minProfit / userInvest,
      total_invest: totalInvest,
      user_invest: userInvest,
      parlay_outcome_details: {
        match1: {
          win: match1Profit('W'),
          draw: match1Profit('D'),
          lose: match1Profit('L'),
        },
        match2: {
          win: match2Profit('W'),
          draw: match2Profit('D'),
          lose: match2Profit('L'),
        },
      },
      parlay_combo_details: comboDetails,
    };
  }

  private static parseHandicaps(raw: any): Handicap[] {
    if (Array.isArray(raw)) return raw as Handicap[];
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Handicap[]) : [];
    } catch {
      return [];
    }
  }

  private static getMatchTimeMs(raw: any): number {
    const ts = new Date(String(raw || '')).getTime();
    return Number.isFinite(ts) ? ts : 0;
  }

  private static formatParlayLegName(selection: { side: Side; market: MarketType }) {
    if (selection.market === 'handicap') {
      return selection.side === 'W' ? '让胜' : selection.side === 'D' ? '让平' : '让负';
    }
    return selection.side === 'W' ? '胜' : selection.side === 'D' ? '平' : '负';
  }

  private static isSecondMatchLateEnough(first: any, second: any, minHours = 5): boolean {
    const t1 = this.getMatchTimeMs(first?.match_time);
    const t2 = this.getMatchTimeMs(second?.match_time);
    if (!t1 || !t2) return false;
    return t2 - t1 >= minHours * 60 * 60 * 1000;
  }

  private static hasSingleArbForSelection(A: number, m: any, selection: { side: Side; market: MarketType; handicapLine?: string }, baseType: 'jingcai' | 'crown') {
    const jcOdds = {
      W: Number(m.j_w || 0),
      D: Number(m.j_d || 0),
      L: Number(m.j_l || 0),
      HW: Number(m.j_hw || 0),
      HD: Number(m.j_hd || 0),
      HL: Number(m.j_hl || 0),
      handicapLine: String(m.j_h || m.jc_handicap || m.handicap || '0'),
      rebate: Number(m.j_r || 0),
      share: Number(m.j_s || 0),
    };
    const crownOdds = {
      W: Number(m.c_w || 0),
      D: Number(m.c_d || 0),
      L: Number(m.c_l || 0),
      handicaps: this.parseHandicaps(m.c_h),
      rebate: Number(m.c_r || 0),
      share: Number(m.c_s || 0),
    };
    const all = this.findAllOpportunities(A, jcOdds, crownOdds, baseType);
    return all.some((x) => x.jcSide === selection.side && x.jc_market === selection.market && this.hasAllPositiveSingleTotalProfits(x, 0.01));
  }

  static findParlayOpportunities(A: number, matches: any[], baseType: 'jingcai' | 'crown' = 'jingcai'): any[] {
    const buildAllSelections = (m: any) => {
      const line = String(m.j_h || m.jc_handicap || m.handicap || '0');
      const arr: Array<{ side: Side; odds: number; market: MarketType; handicapLine?: string; label: string }> = [
        { side: 'W', odds: Number(m.j_w || 0), market: 'normal', label: '主胜' },
        { side: 'D', odds: Number(m.j_d || 0), market: 'normal', label: '平局' },
        { side: 'L', odds: Number(m.j_l || 0), market: 'normal', label: '客胜' },
      ];
      if (Number(m.j_hw || 0) > 1) arr.push({ side: 'W', odds: Number(m.j_hw), market: 'handicap', handicapLine: line, label: `让胜(${line})` });
      if (Number(m.j_hd || 0) > 1) arr.push({ side: 'D', odds: Number(m.j_hd), market: 'handicap', handicapLine: line, label: `让平(${line})` });
      if (Number(m.j_hl || 0) > 1) arr.push({ side: 'L', odds: Number(m.j_hl), market: 'handicap', handicapLine: line, label: `让负(${line})` });
      return arr.filter((x) => this.isFinitePositive(x.odds));
    };

    const buildSingleRecommendedSelections = (m: any) => {
      const jcOdds = {
        W: Number(m.j_w || 0),
        D: Number(m.j_d || 0),
        L: Number(m.j_l || 0),
        HW: Number(m.j_hw || 0),
        HD: Number(m.j_hd || 0),
        HL: Number(m.j_hl || 0),
        handicapLine: String(m.j_h || m.jc_handicap || m.handicap || '0'),
        rebate: Number(m.j_r || 0),
        share: Number(m.j_s || 0),
      };
      const crownOdds = {
        W: Number(m.c_w || 0),
        D: Number(m.c_d || 0),
        L: Number(m.c_l || 0),
        handicaps: this.parseHandicaps(m.c_h),
        rebate: Number(m.c_r || 0),
        share: Number(m.c_s || 0),
      };
      const singles = this.findAllOpportunities(A, jcOdds, crownOdds, baseType);
      return singles
        .filter((s: any) => this.hasAllPositiveSingleTotalProfits(s, 0.01))
        .map((s: any) => ({
          side: s.jcSide as Side,
          odds: Number(s.jc_odds || 0),
          market: (s.jc_market || 'normal') as MarketType,
          handicapLine: s.jc_market === 'handicap' ? String(m.j_h || m.jc_handicap || m.handicap || '0') : undefined,
          label:
            s.jc_label ||
            (s.jc_market === 'handicap'
              ? `${s.jcSide === 'W' ? '让胜' : s.jcSide === 'D' ? '让平' : '让负'}(${String(m.j_h || m.jc_handicap || m.handicap || '0')})`
              : s.jcSide === 'W'
              ? '主胜'
              : s.jcSide === 'D'
              ? '平局'
              : '客胜'),
        }))
        .filter((x: any) => this.isFinitePositive(x.odds));
    };

    const list: any[] = [];
    // Use the full upcoming match pool here. Truncating to the first 20 rows
    // can hide valid parlays that exist later in the schedule.
    const now = Date.now();
    const pool = (matches || []).filter((m) => {
      const startTime = this.getMatchTimeMs(m.match_time);
      // Skip matches that have already started or are about to start in 5 minutes
      if (startTime < now + 5 * 60 * 1000) return false;
      return Number(m.j_w || 0) > 1 || Number(m.j_d || 0) > 1 || Number(m.j_l || 0) > 1;
    });
    const firstLegByMatch = new Map<string, Array<{ side: Side; odds: number; market: MarketType; handicapLine?: string; label: string }>>();
    for (const m of pool) firstLegByMatch.set(String(m.match_id), buildSingleRecommendedSelections(m));

    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        let m1 = pool[i];
        let m2 = pool[j];
        if (!this.isSecondMatchLateEnough(m1, m2, 5)) {
          if (this.isSecondMatchLateEnough(m2, m1, 5)) {
            const tmp = m1;
            m1 = m2;
            m2 = tmp;
          } else {
            continue;
          }
        }
        const jc1 = firstLegByMatch.get(String(m1.match_id)) || [];
        if (!jc1.length) continue;
        const jc2 = buildAllSelections(m2);
        for (const a of jc1) {
          for (const b of jc2) {
            const strategy = this.calculateParlayArbitrageFineLP(
              A,
              m1,
              m2,
              { side: a.side, odds: a.odds, market: a.market, handicapLine: a.handicapLine },
              { side: b.side, odds: b.odds, market: b.market, handicapLine: b.handicapLine },
              baseType
            );
            if (!strategy || strategy.min_profit_rate <= 0) continue;
            list.push({
              match_id_1: m1.match_id,
              match_id_2: m2.match_id,
              side_1: a.label,
              side_2: b.label,
              odds_1: a.odds,
              odds_2: b.odds,
              combined_odds: a.odds * b.odds,
              best_strategy: strategy,
              profit_rate: strategy.min_profit_rate,
              base_type: baseType,
            });
          }
        }
      }
    }
    return list.sort((a, b) => b.profit_rate - a.profit_rate).slice(0, 30);
  }
}

