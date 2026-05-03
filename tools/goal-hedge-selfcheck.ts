import db from '../src/server/db.ts';
import { ArbitrageEngine } from '../src/server/arbitrageEngine.ts';
import { CrawlerService } from '../src/server/crawler.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function approxEqual(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function parseGoalToNumber(goal: string, goalLabel: string) {
  const raw = String(goal || '').trim();
  if (raw.includes('7+')) return 7;
  const nRaw = Number(raw);
  if (Number.isFinite(nRaw)) return Math.min(7, Math.max(0, Math.floor(nRaw)));

  const label = String(goalLabel || '');
  if (label.includes('7+')) return 7;
  const matched = label.match(/(\d+)/);
  if (!matched) return 0;
  const n = Number(matched[1]);
  return Number.isFinite(n) ? Math.min(7, Math.max(0, n)) : 0;
}

function parseOuLine(lineRaw: string) {
  const text = String(lineRaw || '').replace(/\s+/g, '').trim();
  if (!text.includes('/')) {
    const n = Number(text);
    return Number.isFinite(n) ? n : NaN;
  }
  const parts = text
    .split('/')
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
  if (!parts.length) return NaN;
  return parts.reduce((sum, n) => sum + n, 0) / parts.length;
}

function getOuReturnCoefficient(lineValue: number, odds: number, goals: number) {
  const score = goals - lineValue;
  if (score >= 0.5) return 1 + odds;
  if (score === 0.25) return 1 + odds * 0.5;
  if (score === 0) return 1;
  if (score === -0.25) return 0.5;
  return 0;
}

function buildSyntheticGoalOdds() {
  return [
    { label: '0球', odds: 40 },
    { label: '1球', odds: 30 },
    { label: '2球', odds: 22 },
    { label: '3球', odds: 8 },
    { label: '4球', odds: 8 },
    { label: '5球', odds: 8 },
    { label: '6球', odds: 8 },
    { label: '7+球', odds: 8 },
  ];
}

function testOuCase(line: string, overOdds: number) {
  const jcOdds = { W: 0, D: 0, L: 0, rebate: 0.12, share: 0 };
  const crownOdds = {
    W: 0,
    D: 0,
    L: 0,
    handicaps: [],
    rebate: 0.02,
    share: 0,
    goal_odds: buildSyntheticGoalOdds(),
    over_under_odds: [{ line, over_odds: overOdds, under_odds: 1.6 }],
  };
  const list = ArbitrageEngine.findAllOpportunities(10000, jcOdds as any, crownOdds as any, 'goal_hedge', 10000);
  assert(list.length > 0, `synthetic case line=${line} should produce at least 1 plan`);
  const best = list[0] as any;
  const ou = best?.goal_hedge_meta?.ou_bet;
  const breakdown = best?.goal_profit_breakdown;
  assert(ou && Number(ou.amount) > 0, `line=${line} should contain ou bet amount`);
  assert(Array.isArray(breakdown) && breakdown.length === 8, `line=${line} should output 8 goal scenes`);

  const lineValue = parseOuLine(String(ou.line || line));
  assert(Number.isFinite(lineValue), `line=${line} parsed lineValue must be finite`);
  const ouAmount = Number(ou.amount || 0);
  const pickedOdds = Number(ou.odds || overOdds);

  for (const row of breakdown as any[]) {
    const goals = parseGoalToNumber(String(row.goal || ''), String(row.goal_label || ''));
    const expectedOuReturn = ouAmount * getOuReturnCoefficient(lineValue, pickedOdds, goals);
    assert(approxEqual(Number(row.ou_return || 0), expectedOuReturn, 1e-4), `line=${line} ou_return mismatch at goals=${goals}`);
    assert(
      approxEqual(Number(row.total_profit || 0), Number(row.match_profit || 0) + Number(row.rebate || 0), 1e-4),
      `line=${line} total_profit != match_profit + rebate at goals=${goals}`
    );
    assert(
      approxEqual(Number(row.gross_return || 0), Number(row.stake || 0) + Number(row.match_profit || 0), 1e-4),
      `line=${line} gross_return != stake + match_profit at goals=${goals}`
    );
    assert(Number(row.total_profit || 0) > 0, `line=${line} total_profit should be positive at goals=${goals}`);
  }
  console.log(`[OK] synthetic OU case line=${line}, odds=${overOdds}`);
}

async function runLiveScanCheck() {
  const user = db.prepare("SELECT id, username FROM users WHERE role = 'User' ORDER BY id ASC LIMIT 1").get() as
    | { id: number; username: string }
    | undefined;
  if (!user?.id) {
    console.log('[SKIP] no user found for live scan check');
    return;
  }
  await CrawlerService.scanOpportunities(Number(user.id));
  const grouped = db
    .prepare(
      `SELECT base_type, COUNT(*) as count FROM arbitrage_opportunities WHERE user_id = ? GROUP BY base_type ORDER BY base_type`
    )
    .all(user.id) as Array<{ base_type: string; count: number }>;
  const allowed = new Set(['jingcai', 'crown', 'hg', 'goal_hedge']);
  grouped.forEach((row) => {
    assert(allowed.has(String(row.base_type)), `unexpected base_type found: ${row.base_type}`);
  });
  console.log('[OK] scan base_type distribution:', grouped.map((x) => `${x.base_type}:${x.count}`).join(', '));

  const bestGoalHedge = db
    .prepare(
      `SELECT match_id, profit_rate, best_strategy
       FROM arbitrage_opportunities
       WHERE user_id = ? AND base_type = 'goal_hedge'
       ORDER BY profit_rate DESC
       LIMIT 1`
    )
    .get(user.id) as { match_id: string; profit_rate: number; best_strategy: string } | undefined;

  if (!bestGoalHedge) {
    console.log('[INFO] live scan has no goal_hedge opportunity currently (this can happen when market odds are not arbitrageable)');
    return;
  }

  const strategy = JSON.parse(bestGoalHedge.best_strategy || '{}');
  const breakdown = Array.isArray(strategy?.goal_profit_breakdown) ? strategy.goal_profit_breakdown : [];
  assert(breakdown.length === 8, 'live strategy must include 8 goal scenes');
  const minTotal = Math.min(...breakdown.map((row: any) => Number(row.total_profit || 0)));
  assert(Number.isFinite(minTotal) && minTotal > 0, 'live strategy min total profit must be positive');
  console.log(
    `[OK] live goal_hedge sample match=${bestGoalHedge.match_id}, rate=${Number(bestGoalHedge.profit_rate || 0).toFixed(6)}, min_total=${minTotal.toFixed(2)}`
  );
}

async function main() {
  console.log('== Goal Hedge Selfcheck ==');
  testOuCase('2', 2.4);
  testOuCase('2.5', 2.2);
  testOuCase('2/2.5', 2.3);
  await runLiveScanCheck();
  console.log('ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('SELF-CHECK FAILED:', err?.message || err);
  process.exit(1);
});
