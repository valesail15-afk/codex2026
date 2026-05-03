import Database from 'better-sqlite3';
import { ArbitrageEngine } from '../src/server/arbitrageEngine';
import type { HedgeStrategy, CrownBet } from '../src/types';

const db = new Database('arbitrage.db');

type Side = 'W' | 'D' | 'L';
const OUTCOME_DGS: Record<Side, number[]> = {
  W: [1, 2, 3, 4],
  D: [0],
  L: [-1, -2, -3, -4],
};

function parseHandicap(line?: string): number {
  return ArbitrageEngine.parseHandicap(line || '0');
}

function jcReturn(side: Side, market: 'normal' | 'handicap', odds: number, handicapLine: string | undefined, dg: number): number {
  if (market === 'normal') {
    const hit = side === 'W' ? dg > 0 : side === 'D' ? dg === 0 : dg < 0;
    return hit ? odds : 0;
  }
  const adj = dg + parseHandicap(handicapLine || '0');
  const outcome: Side = adj > 0 ? 'W' : adj < 0 ? 'L' : 'D';
  return outcome === side ? odds : 0;
}

function crownReturn(type: string, odds: number, dg: number): { ret: number; settleRatio: number } {
  const ret = ArbitrageEngine.getReturnCoefficient(type, odds, dg);
  // Manual implementation of getSettlementRatio logic to avoid private access
  const t = String(type || '').replace(/\s+/g, '').trim().toUpperCase();
  let settleRatio = 1;
  
  if (t.startsWith('AH_')) {
    const ah = t.match(/^AH_(HOME|DRAW|AWAY)\(([^)]+)\)$/);
    if (ah) {
        const side = ah[1] === 'HOME' ? 'home' : ah[1] === 'DRAW' ? 'draw' : 'away';
        const handicap = ArbitrageEngine.parseHandicap(ah[2]);
        const score = side === 'home' ? dg + handicap : -dg + handicap;
        if (score >= 0.5 || score <= -0.5) settleRatio = 1;
        else if (score === 0.25 || score === -0.25) settleRatio = 0.5;
        else settleRatio = 0;
    }
  }
  return { ret, settleRatio };
}

async function auditParlays() {
  console.log('--- 开始二串一方案全面审计 ---');
  
  const parlays = db.prepare("SELECT * FROM parlay_opportunities").all() as any[];
  console.log(`总计发现 ${parlays.length} 个二串一方案`);

  const auditResults: any[] = [];

  for (const p of parlays) {
    const strategy = JSON.parse(p.best_strategy) as HedgeStrategy;
    const jcAmount = 10000; 
    const jcRebate = 0.13; 
    const crownRebate = 0.02;

    const outcomes: Side[] = ['W', 'D', 'L'];
    let minCalcProfit = Number.POSITIVE_INFINITY;
    let worstCombo = '';

    const pick1 = { 
        side: p.side_1.includes('让胜') ? 'W' : p.side_1.includes('让平') ? 'D' : p.side_1.includes('让负') ? 'L' : (p.side_1.includes('胜') ? 'W' : p.side_1.includes('平') ? 'D' : 'L'), 
        market: p.side_1.includes('让') ? 'handicap' : 'normal', 
        odds: p.odds_1, 
        handicapLine: p.side_1.match(/\(([^)]+)\)/)?.[1] 
    };
    const pick2 = { 
        side: p.side_2.includes('让胜') ? 'W' : p.side_2.includes('让平') ? 'D' : p.side_2.includes('让负') ? 'L' : (p.side_2.includes('胜') ? 'W' : p.side_2.includes('平') ? 'D' : 'L'), 
        market: p.side_2.includes('让') ? 'handicap' : 'normal', 
        odds: p.odds_2, 
        handicapLine: p.side_2.match(/\(([^)]+)\)/)?.[1] 
    };

    const requiredKeys: string[] = [];
    for (const s1 of outcomes) {
      const isHit = OUTCOME_DGS[s1].some(dg1 => 
        jcReturn(pick1.side as Side, pick1.market as any, pick1.odds, pick1.handicapLine, dg1) > 0
      );
      const isMiss = OUTCOME_DGS[s1].some(dg1 => 
        jcReturn(pick1.side as Side, pick1.market as any, pick1.odds, pick1.handicapLine, dg1) === 0
      );

      for (const s2 of outcomes) {
        let worstTotal = Number.POSITIVE_INFINITY;
        
        for (const dg1 of OUTCOME_DGS[s1]) {
          const r1 = jcReturn(pick1.side as Side, pick1.market as any, pick1.odds, pick1.handicapLine, dg1);
          const firstHit = r1 > 0;
          
          if (firstHit) {
            let worstForDg1 = Number.POSITIVE_INFINITY;
            for (const dg2 of OUTCOME_DGS[s2]) {
              const r2 = jcReturn(pick2.side as Side, pick2.market as any, pick2.odds, pick2.handicapLine, dg2);
              const parlayHit = r2 > 0;
              
              // 竞彩收益
              let total = jcAmount * ((parlayHit ? pick1.odds * pick2.odds : 0) - 1 + jcRebate);
              
              // 皇冠收益
              for (const b of strategy.crown_bets) {
                const dg = b.match_index === 0 ? dg1 : dg2;
                const c = crownReturn(b.type, b.odds, dg);
                // 修复：如果 A = 10000 且 strategy 是以 10000 为基准生成的，则不需要缩放
                const scaledCrownAmount = b.amount; 
                total += scaledCrownAmount * ((c.ret - 1) + c.settleRatio * crownRebate);
              }
              if (total < worstForDg1) worstForDg1 = total;
            }
            if (worstForDg1 < worstTotal) worstTotal = worstForDg1;
          } else {
            // 第一场挂了，第二场不产生任何收益/支出（不加第二场对冲单）
            let total = jcAmount * (-1 + jcRebate);
            for (const b of strategy.crown_bets) {
                if (b.match_index === 0) {
                    const c = crownReturn(b.type, b.odds, dg1);
                    const scaledCrownAmount = b.amount;
                    total += scaledCrownAmount * ((c.ret - 1) + c.settleRatio * crownRebate);
                }
            }
            if (total < worstTotal) worstTotal = total;
          }
        }
        
        // 审计逻辑
        if (isHit) {
            if (worstTotal < minCalcProfit) {
                minCalcProfit = worstTotal;
                worstCombo = `${s1}-${s2}`;
            }
        }
        if (isMiss && s2 === 'W') {
             if (worstTotal < minCalcProfit) {
                 minCalcProfit = worstTotal;
                 worstCombo = `${s1}-STOP`;
             }
        }
      }
    }

    // 修复：reported 也不需要缩放，因为 A = 10000 就是基准
    const reportedMinProfit = strategy.min_profit;
    const diff = Math.abs(reportedMinProfit - minCalcProfit);

    if (minCalcProfit < -0.1 || diff > 1.0) {
        auditResults.push({
            id: p.id,
            name: `${p.side_1} x ${p.side_2}`,
            reported: reportedMinProfit.toFixed(2),
            calculated: minCalcProfit.toFixed(2),
            diff: diff.toFixed(2),
            worstCombo
        });
    }
  }

  console.log('\n--- 审计结果 ---');
  if (auditResults.length === 0) {
    console.log('✅ 未发现亏损或计算偏差方案。');
  } else {
    console.log(`发现 ${auditResults.length} 个异常方案：`);
    console.table(auditResults);
  }
}

auditParlays().catch(console.error);
