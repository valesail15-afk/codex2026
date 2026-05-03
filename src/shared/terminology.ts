export const TERMS = {
  single: '单场',
  parlay: '二串一',
  hg: 'HG对冲',
  viewPlan: '查看方案',
  win: '主胜',
  draw: '平局',
  lose: '客胜',
  profit: '利润',
  profitRate: '利润率',
  stake: '下注',
  actualStake: '实投',
  payout: '中奖',
  recalcTime: '最近一次重算时间',
  filterHitCount: '当前筛选命中数',
  noData: '暂无符合条件的记录',
} as const;

export type OutcomeCN = typeof TERMS.win | typeof TERMS.draw | typeof TERMS.lose;

export const OUTCOME_CN: ReadonlyArray<OutcomeCN> = [TERMS.win, TERMS.draw, TERMS.lose];

export const SIDE_LABEL: Record<'W' | 'D' | 'L', OutcomeCN> = {
  W: TERMS.win,
  D: TERMS.draw,
  L: TERMS.lose,
};

export const CURRENCY_PREFIX = '¥';

export function currency(value: number) {
  return `${CURRENCY_PREFIX}${Number(value || 0).toFixed(2)}`;
}

export function signedCurrency(value: number) {
  return `${Number(value || 0) >= 0 ? '+' : '-'}${CURRENCY_PREFIX}${Math.abs(Number(value || 0)).toFixed(2)}`;
}

export function percent(value: number, digits = 1) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}
