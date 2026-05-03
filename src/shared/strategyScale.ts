import type { HedgeStrategy } from '../types';

type ProfitKey = 'win' | 'draw' | 'lose';
export type StakePlatform = 'jingcai' | 'crown';

const profitKeys: ProfitKey[] = ['win', 'draw', 'lose'];

const toNumber = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const scaleNumber = (value: unknown, ratio: number) => toNumber(value) * ratio;

const scaleProfitMap = <T extends Partial<Record<ProfitKey, number>> | undefined>(value: T, ratio: number): T => {
  if (!value) return value;
  return profitKeys.reduce(
    (acc, key) => ({
      ...acc,
      [key]: scaleNumber(value[key], ratio),
    }),
    { ...value }
  ) as T;
};

export const getPrimaryStakeAmount = (strategy?: HedgeStrategy | null) => {
  if (!strategy) return 0;

  const hgBaseAmount = toNumber(strategy.hg_base_bet?.amount);
  if (hgBaseAmount > 0) return hgBaseAmount;

  const goalPickAmount = Array.isArray(strategy.goal_hedge_meta?.goal_picks)
    ? strategy.goal_hedge_meta.goal_picks.reduce((sum, item) => sum + toNumber(item.amount), 0)
    : 0;
  if (goalPickAmount > 0) return goalPickAmount;

  const crownAmount = Array.isArray(strategy.crown_bets)
    ? strategy.crown_bets.reduce((sum, item) => sum + toNumber(item.amount), 0)
    : 0;
  return Math.max(0, toNumber(strategy.user_invest) - crownAmount);
};

export const getPrimaryStakePlatform = (strategy?: HedgeStrategy | null): StakePlatform => {
  if (!strategy) return 'jingcai';
  if (strategy.hg_base_bet) return 'crown';
  if (Array.isArray(strategy.goal_hedge_meta?.goal_picks) && strategy.goal_hedge_meta.goal_picks.length > 0) return 'jingcai';
  return 'jingcai';
};

export const scaleHedgeStrategy = (strategy: HedgeStrategy, primaryStakeAmount: number): HedgeStrategy => {
  const currentPrimaryStake = getPrimaryStakeAmount(strategy);
  const targetPrimaryStake = toNumber(primaryStakeAmount);

  if (currentPrimaryStake <= 0 || targetPrimaryStake <= 0) {
    return strategy;
  }

  const ratio = targetPrimaryStake / currentPrimaryStake;
  const userInvest = scaleNumber(strategy.user_invest, ratio);
  const minProfit = scaleNumber(strategy.min_profit, ratio);

  return {
    ...strategy,
    hg_base_bet: strategy.hg_base_bet
      ? {
          ...strategy.hg_base_bet,
          amount: scaleNumber(strategy.hg_base_bet.amount, ratio),
        }
      : strategy.hg_base_bet,
    crown_bets: (strategy.crown_bets || []).map((bet) => ({
      ...bet,
      amount: scaleNumber(bet.amount, ratio),
    })),
    profits: scaleProfitMap(strategy.profits, ratio),
    match_profits: scaleProfitMap(strategy.match_profits, ratio),
    rebate: scaleNumber(strategy.rebate, ratio),
    rebates: scaleProfitMap(strategy.rebates, ratio),
    min_profit: minProfit,
    min_profit_rate: userInvest > 0 ? minProfit / userInvest : strategy.min_profit_rate,
    total_invest: scaleNumber(strategy.total_invest, ratio),
    user_invest: userInvest,
    parlay_outcome_details: strategy.parlay_outcome_details
      ? {
          match1: scaleProfitMap(strategy.parlay_outcome_details.match1, ratio),
          match2: scaleProfitMap(strategy.parlay_outcome_details.match2, ratio),
        }
      : strategy.parlay_outcome_details,
    parlay_combo_details: strategy.parlay_combo_details?.map((item) => ({
      ...item,
      total: scaleNumber(item.total, ratio),
      match: scaleNumber(item.match, ratio),
      rebate: scaleNumber(item.rebate, ratio),
    })),
    goal_hedge_meta: strategy.goal_hedge_meta
      ? {
          ...strategy.goal_hedge_meta,
          goal_picks: strategy.goal_hedge_meta.goal_picks.map((item) => ({
            ...item,
            amount: scaleNumber(item.amount, ratio),
          })),
          ou_bet: {
            ...strategy.goal_hedge_meta.ou_bet,
            amount: scaleNumber(strategy.goal_hedge_meta.ou_bet.amount, ratio),
          },
        }
      : strategy.goal_hedge_meta,
    goal_profit_breakdown: strategy.goal_profit_breakdown?.map((item) => ({
      ...item,
      jc_return: scaleNumber(item.jc_return, ratio),
      ou_return: scaleNumber(item.ou_return, ratio),
      gross_return: scaleNumber(item.gross_return, ratio),
      stake: scaleNumber(item.stake, ratio),
      match_profit: scaleNumber(item.match_profit, ratio),
      rebate: scaleNumber(item.rebate, ratio),
      total_profit: scaleNumber(item.total_profit, ratio),
    })),
  };
};
