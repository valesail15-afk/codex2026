/**
 * ?????? - ????
 */

export interface Match {
  id: number;
  match_id: string;
  league: string;
  round?: string;
  handicap?: string;
  jingcai_handicap?: string;
  home_team: string;
  away_team: string;
  match_time: string;
  status: 'upcoming' | 'live' | 'finished';
  created_at: string;
  updated_at: string;
}

export interface JingcaiOdds {
  match_id: string;
  win_odds: number;
  draw_odds: number;
  lose_odds: number;
  handicap_win_odds?: number;
  handicap_draw_odds?: number;
  handicap_lose_odds?: number;
  rebate_rate: number;
  share_rate: number;
  updated_at: string;
}

export interface Handicap {
  type: string; // ?? "+0.00", "-0.5"
  home_odds: number;
  away_odds: number;
}

export interface CrownOdds {
  match_id: string;
  win_odds: number;
  draw_odds: number;
  lose_odds: number;
  handicaps: Handicap[];
  rebate_rate: number;
  share_rate: number;
  updated_at: string;
}

export interface ArbitrageOpportunity {
  id: number;
  match_id: string;
  match?: Match;
  jingcai_side: 'W' | 'D' | 'L';
  jingcai_odds: number;
  best_strategy: HedgeStrategy;
  profit_rate: number;
  created_at: string;
}

export interface HedgeStrategy {
  name: string;
  jcSide?: 'W' | 'D' | 'L';
  jc_market?: 'normal' | 'handicap';
  jc_odds?: number;
  jc_label?: string;
  hg_base_bet?: CrownBet;
  crown_bets: CrownBet[];
  profits: {
    win: number;
    draw: number;
    lose: number;
  };
  match_profits: {
    win: number;
    draw: number;
    lose: number;
  };
  rebate: number;
  rebates: {
    win: number;
    draw: number;
    lose: number;
  };
  min_profit: number;
  min_profit_rate: number;
  total_invest: number;
  user_invest: number;
  parlay_outcome_details?: {
    match1: {
      win: number;
      draw: number;
      lose: number;
    };
    match2: {
      win: number;
      draw: number;
      lose: number;
    };
  };
  parlay_combo_details?: Array<{
    key: string;
    first: 'W' | 'D' | 'L';
    second: 'W' | 'D' | 'L';
    first_label: string;
    second_label: string;
    total: number;
    match: number;
    rebate: number;
    need_second_hedge?: boolean;
    first_crown_hit?: boolean;
  }>;
}

export interface CrownBet {
  type: string;
  amount: number;
  odds: number;
  match_index?: number; // 0 for match 1, 1 for match 2
}

export interface BetRecord {
  id: number;
  arbitrage_id: number;
  jingcai_amount: number;
  crown_bets_detail: string; // JSON string
  total_invest: number;
  expected_profit: number;
  actual_result?: string;
  actual_profit?: number;
  created_at: string;
}
