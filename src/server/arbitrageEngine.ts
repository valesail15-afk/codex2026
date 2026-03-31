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
    if (!Array.isArray(combos) || combos.length < 9) return false;
    return combos.every((x: any) => {
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
    const t = String(type || '').trim();
    if (t.includes('标准胜') || t.includes('鏍囧噯鑳')) return { kind: 'std', side: 'home' };
    if (t.includes('标准平') || t.includes('鏍囧噯骞')) return { kind: 'std', side: 'draw' };
    if (t.includes('标准负') || t.includes('鏍囧噯璐')) return { kind: 'std', side: 'away' };
    const m = t.match(/^(主胜|客胜|涓昏儨|瀹㈣儨)\(([^)]+)\)$/);
    if (m) {
      return {
        kind: 'ah',
        side: m[1] === '主胜' || m[1] === '涓昏儨' ? 'home' : 'away',
        handicap: this.parseHandicap(m[2]),
      };
    }
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
      { type: '标准胜', odds: Number(m.c_w || 0) },
      { type: '标准平', odds: Number(m.c_d || 0) },
      { type: '标准负', odds: Number(m.c_l || 0) },
    ];
    const handicaps = m.c_h ? JSON.parse(m.c_h) : [];
    handicaps.forEach((h: any) => {
      const ht = String(h.type || '');
      const awayType = ht.startsWith('+') ? ht.replace('+', '-') : ht.startsWith('-') ? ht.replace('-', '+') : `-${ht}`;
      options.push({ type: `主胜(${ht})`, odds: Number(h.home_odds || 0) });
      options.push({ type: `客胜(${awayType})`, odds: Number(h.away_odds || 0) });
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
    baseType: 'jingcai' | 'crown'
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

    const pW = profitByGoalDiff(1);
    const pD = profitByGoalDiff(0);
    const pL = profitByGoalDiff(-1);
    const minProfit = fineBuckets
      .map((bucket) => bucket.dgs.map((dg) => profitByGoalDiff(dg)).reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY))
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
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
    baseType: 'jingcai' | 'crown',
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

    const pW = profitByGoalDiff(1);
    const pD = profitByGoalDiff(0);
    const pL = profitByGoalDiff(-1);
    const minProfit = fineBuckets
      .map((bucket) => bucket.dgs.map((dg) => profitByGoalDiff(dg)).reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY))
      .reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
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
    crownOdds: { W: number; D: number; L: number; handicaps: Handicap[]; rebate: number; share: number },
    baseType: 'jingcai' | 'crown' = 'jingcai',
    integerUnit: number = 10000
  ): HedgeStrategy[] {
    const markets: Array<{ side: Side; odds: number; market: MarketType; label: string }> = [
      { side: 'W', odds: Number(jcOdds.W || 0), market: 'normal', label: '普通胜' },
      { side: 'D', odds: Number(jcOdds.D || 0), market: 'normal', label: '普通平' },
      { side: 'L', odds: Number(jcOdds.L || 0), market: 'normal', label: '普通负' },
    ];
    if (Number(jcOdds.HW || 0) > 1) markets.push({ side: 'W', odds: Number(jcOdds.HW), market: 'handicap', label: `让胜(${jcOdds.handicapLine || '0'})` });
    if (Number(jcOdds.HD || 0) > 1) markets.push({ side: 'D', odds: Number(jcOdds.HD), market: 'handicap', label: `让平(${jcOdds.handicapLine || '0'})` });
    if (Number(jcOdds.HL || 0) > 1) markets.push({ side: 'L', odds: Number(jcOdds.HL), market: 'handicap', label: `让负(${jcOdds.handicapLine || '0'})` });

    const crownOptions: { type: string; odds: number }[] = [
      { type: '标准胜', odds: Number(crownOdds.W || 0) },
      { type: '标准平', odds: Number(crownOdds.D || 0) },
      { type: '标准负', odds: Number(crownOdds.L || 0) },
    ];
    (crownOdds.handicaps || []).forEach((h) => {
      const awayType = String(h.type).startsWith('+')
        ? String(h.type).replace('+', '-')
        : String(h.type).startsWith('-')
        ? String(h.type).replace('-', '+')
        : `-${h.type}`;
      crownOptions.push({ type: `主胜(${h.type})`, odds: Number(h.home_odds || 0) });
      crownOptions.push({ type: `客胜(${awayType})`, odds: Number(h.away_odds || 0) });
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

    const C = A;
    const rJc = Number(m1.j_r || 0);
    const rHg = Number(m1.c_r || 0);
    const sJc = Number(m1.j_s || 0);
    const sHg = Number(m1.c_s || 0);

    const jcRet1 = this.getJingcaiFineReturns(jc1.side, jc1.odds, jc1.market, jc1.handicapLine);
    const jcRet2 = this.getJingcaiFineReturns(jc2.side, jc2.odds, jc2.market, jc2.handicapLine);

    const model: any = { optimize: 'z', opType: 'max', constraints: {}, variables: {} };
    for (let ai = 0; ai < 5; ai++) {
      for (let bi = 0; bi < 5; bi++) {
        model.constraints[`p_${ai}_${bi}`] = { min: 0 };
      }
    }
    model.constraints.cap = { max: A * 20 };
    model.variables.z = { z: 1, cap: 0 };
    for (let ai = 0; ai < 5; ai++) {
      for (let bi = 0; bi < 5; bi++) model.variables.z[`p_${ai}_${bi}`] = -1;
    }

    c1.forEach((opt, i) => {
      const ret = this.getCrownFineReturns(opt.type, opt.odds);
      const v: any = { z: 0, cap: 1 };
      for (let ai = 0; ai < 5; ai++) for (let bi = 0; bi < 5; bi++) v[`p_${ai}_${bi}`] = ret[ai] - 1 + rHg;
      model.variables[`h1_${i}`] = v;
    });
    c2.forEach((opt, i) => {
      const ret = this.getCrownFineReturns(opt.type, opt.odds);
      const v: any = { z: 0, cap: 1 };
      for (let ai = 0; ai < 5; ai++) for (let bi = 0; bi < 5; bi++) v[`p_${ai}_${bi}`] = ret[bi] - 1 + rHg;
      model.variables[`h2_${i}`] = v;
    });

    const jcConst: Record<string, number> = {};
    // 二串一规则：两场都中才有返奖；只中一场按未中奖处理（返奖为 0）。
    const parlayReturn = (r1: number, r2: number) => (r1 > 0 && r2 > 0 ? r1 * r2 : 0);
    for (let ai = 0; ai < 5; ai++) {
      for (let bi = 0; bi < 5; bi++) {
        const combo = parlayReturn(jcRet1[ai], jcRet2[bi]);
        jcConst[`p_${ai}_${bi}`] = C * (combo - 1 + rJc);
      }
    }
    Object.keys(jcConst).forEach((k) => (model.constraints[k].min = -jcConst[k]));

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

    const evalProfit = (ai: number, bi: number) => {
      const jc = C * (parlayReturn(jcRet1[ai], jcRet2[bi]) - 1 + rJc);
      let hg = 0;
      for (const b of crown_bets) {
        const idx = b.match_index === 0 ? ai : bi;
        const ret = this.getCrownFineReturns(b.type, b.odds)[idx];
        hg += b.amount * (ret - 1 + rHg);
      }
      return jc + hg;
    };

    const minProfit = Math.min(...Array.from({ length: 5 }, (_, ai) => Array.from({ length: 5 }, (_, bi) => evalProfit(ai, bi))).flat());
    const profits = {
      win: evalProfit(1, 1),
      draw: minProfit,
      lose: evalProfit(3, 3),
    };
    if (!this.isFinitePositive(minProfit, 0.01)) return null;

    const userInvest = C + crown_bets.reduce((s, b) => s + b.amount, 0);
    const totalInvest = C / Math.max(1 - sJc, 0.0001) + crown_bets.reduce((s, b) => s + b.amount / Math.max(1 - sHg, 0.0001), 0);

    const rebateValue = C * rJc + crown_bets.reduce((s, b) => s + b.amount * rHg, 0);
    const scenarioMin = (aIndices: number[], bIndices: number[]) => {
      let worst = Number.POSITIVE_INFINITY;
      for (const ai of aIndices) {
        for (const bi of bIndices) {
          const p = evalProfit(ai, bi);
          if (p < worst) worst = p;
        }
      }
      return worst;
    };
    return {
      name: `二串一LP全覆盖(${jc1.market === 'handicap' ? '让' : '普'}${jc1.side}x${jc2.market === 'handicap' ? '让' : '普'}${jc2.side})`,
      jcSide: jc1.side,
      crown_bets,
      profits,
      match_profits: { win: profits.win - rebateValue, draw: profits.draw - rebateValue, lose: profits.lose - rebateValue },
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
      parlay_outcome_details: {
        match1: {
          win: scenarioMin([0, 1], [0, 1, 2, 3, 4]),
          draw: scenarioMin([2], [0, 1, 2, 3, 4]),
          lose: scenarioMin([3, 4], [0, 1, 2, 3, 4]),
        },
        match2: {
          win: scenarioMin([0, 1, 2, 3, 4], [0, 1]),
          draw: scenarioMin([0, 1, 2, 3, 4], [2]),
          lose: scenarioMin([0, 1, 2, 3, 4], [3, 4]),
        },
      },
    };
  }

  static findParlayOpportunities(A: number, matches: any[], baseType: 'jingcai' | 'crown' = 'jingcai'): any[] {
    const buildJc = (m: any) => {
      const line = String(m.j_h || m.handicap || '0');
      const arr: Array<{ side: Side; odds: number; market: MarketType; handicapLine?: string; label: string }> = [
        { side: 'W', odds: Number(m.j_w || 0), market: 'normal', label: '普胜' },
        { side: 'D', odds: Number(m.j_d || 0), market: 'normal', label: '普平' },
        { side: 'L', odds: Number(m.j_l || 0), market: 'normal', label: '普负' },
      ];
      if (Number(m.j_hw || 0) > 1) arr.push({ side: 'W', odds: Number(m.j_hw), market: 'handicap', handicapLine: line, label: `让胜(${line})` });
      if (Number(m.j_hd || 0) > 1) arr.push({ side: 'D', odds: Number(m.j_hd), market: 'handicap', handicapLine: line, label: `让平(${line})` });
      if (Number(m.j_hl || 0) > 1) arr.push({ side: 'L', odds: Number(m.j_hl), market: 'handicap', handicapLine: line, label: `让负(${line})` });
      return arr;
    };

    const list: any[] = [];
    const pool = (matches || []).filter((m) => Number(m.j_w || 0) > 1 || Number(m.j_d || 0) > 1 || Number(m.j_l || 0) > 1).slice(0, 20);
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const m1 = pool[i];
        const m2 = pool[j];
        const jc1 = buildJc(m1);
        const jc2 = buildJc(m2);
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
            // Parlay recommendations must guarantee all 9 combo totals (including rebates) are positive.
            if (!this.hasAllPositiveParlayCombos(strategy, 0.01)) continue;
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

