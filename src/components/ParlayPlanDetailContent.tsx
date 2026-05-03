import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Card, Col, Empty, InputNumber, Row, Select, Space, Tag, Typography } from 'antd';
import axios from 'axios';
import type { HedgeStrategy } from '../types';
import { normalizeCrownTarget, normalizeParlaySideLabel, parseParlayRawSide, sideToLabel } from '../shared/oddsText';
import { parseCrownBetTypeCompat } from '../shared/crownBetTypeCompat';
import BetStakeCalculatorModal from './BetStakeCalculatorModal';

const { Title, Text } = Typography;

type MatchOutcome = 'W' | 'D' | 'L';

type BetRow = {
  key: string;
  platform: string;
  target: string;
  odds: number;
  oddsDisplay: string;
  amount: number;
  share: number;
  realAmount: number;
  note?: string;
};

type DetailLine = {
  label: string;
  statusText: string;
  hit: boolean;
  amount: number;
  tone: 'green' | 'blue' | 'muted';
};

const currency = (n: number) => `¥${Number(n || 0).toFixed(2)}`;
const signedCurrency = (n: number) => `${Number(n || 0) >= 0 ? '+' : '-'}¥${Math.abs(Number(n || 0)).toFixed(2)}`;
const rateHot = (r: number) => Number(r || 0) >= 0.005;

const outcomeGoalDiffs: Record<MatchOutcome, number[]> = {
  W: [1, 2, 3, 4],
  D: [0],
  L: [-1, -2, -3, -4],
};

const calcGrossReturnByGoalDiff = (
  pick: { side: MatchOutcome; handicap?: number; isStandard: boolean },
  dg: number,
  amount: number,
  odds: number
) => {
  const a = Number(amount || 0);
  const o = Number(odds || 0);
  if (a <= 0 || o <= 0) return 0;

  if (pick.isStandard) {
    const hit = pick.side === 'W' ? dg > 0 : pick.side === 'D' ? dg === 0 : dg < 0;
    return hit ? a * o : 0;
  }

  const h = Number(pick.handicap || 0);

  if (pick.side === 'D') {
    const score = h - Math.abs(dg);
    if (score >= 0.5) return a * (1 + o);
    if (score === 0.25) return a * (1 + o / 2);
    if (score === 0) return a;
    if (score === -0.25) return a * 0.5;
    return 0;
  }

  const score = pick.side === 'W' ? dg + h : -dg + h;
  if (score >= 0.5) return a * (1 + o);
  if (score === 0.25) return a * (1 + o / 2);
  if (score === 0) return a;
  if (score === -0.25) return a * 0.5;
  return 0;
};

const calcSettleRatioByGoalDiff = (
  pick: { side: MatchOutcome; handicap?: number; isStandard: boolean },
  dg: number
) => {
  if (pick.isStandard) return 1;
  const h = Number(pick.handicap || 0);

  if (pick.side === 'D') {
    const score = h - Math.abs(dg);
    if (score >= 0.5 || score <= -0.5) return 1;
    if (score === 0.25 || score === -0.25) return 0.5;
    return 0;
  }

  const score = pick.side === 'W' ? dg + h : -dg + h;
  if (score >= 0.5 || score <= -0.5) return 1;
  if (score === 0.25 || score === -0.25) return 0.5;
  return 0;
};

const parseCrownBetSide = (raw: string): { side: MatchOutcome; handicap?: number; isStandard: boolean } => {
  const parsed = parseCrownBetTypeCompat(raw);
  const side: MatchOutcome = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
  return { side, handicap: parsed.handicap, isStandard: parsed.kind === 'std' };
};

const isJcPickHitByGoalDiff = (
  pick: { side: MatchOutcome; handicap?: number; isHandicap: boolean },
  dg: number
) => {
  if (!pick.isHandicap) return pick.side === 'W' ? dg > 0 : pick.side === 'D' ? dg === 0 : dg < 0;
  const h = Number(pick.handicap || 0);
  const adjusted = dg + h;
  const outcome: MatchOutcome = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
  return outcome === pick.side;
};

export interface ParlayPlanDetailContentProps {
  id?: string;
  initialBaseType?: 'jingcai' | 'crown';
  showTitle?: boolean;
  onLoaded?: () => void;
}

const ParlayPlanDetailContent: React.FC<ParlayPlanDetailContentProps> = ({
  id,
  initialBaseType = 'jingcai',
  showTitle = true,
  onLoaded,
}) => {
  const { message } = App.useApp();
  const [baseType, setBaseType] = useState<'jingcai' | 'crown'>(initialBaseType);
  const [baseTypeAvailability, setBaseTypeAvailability] = useState<Record<'jingcai' | 'crown', boolean>>({ jingcai: true, crown: true });
  const [loading, setLoading] = useState(false);

  const [record, setRecord] = useState<any>(null);
  const [selected, setSelected] = useState<HedgeStrategy | null>(null);
  const [settingsMeta, setSettingsMeta] = useState({ jcShare: 0, crownShare: 0, jcRebate: 0.13, crownRebate: 0.02 });
  const [tempSecondCrownOdds, setTempSecondCrownOdds] = useState<Record<string, number>>({});
  const loadedNotifiedRef = React.useRef(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [detailRes, settingRes] = await Promise.all([
        axios.get(`/api/arbitrage/parlay-opportunities/${id}`, { params: { base_type: baseType } }),
        axios.get('/api/settings'),
      ]);

      const availability = {
        jingcai: baseType === 'jingcai' ? Boolean(detailRes.data?.best_strategy) : false,
        crown: baseType === 'crown' ? Boolean(detailRes.data?.best_strategy) : false,
      };
      setBaseTypeAvailability(availability);

      const detail = detailRes.data;
      setRecord(detail);
      setSelected(detail?.best_strategy || null);

      setSettingsMeta({
        jcShare: Number(settingRes.data?.default_jingcai_share || 0),
        crownShare: Number(settingRes.data?.default_crown_share || 0),
        jcRebate: Number(settingRes.data?.default_jingcai_rebate || 0.13),
        crownRebate: Number(settingRes.data?.default_crown_rebate || 0.02),
      });

    } catch (err: any) {
      if (err.response?.status === 404) {
        message.warning('该二串一方案已过期，请刷新列表获取最新机会');
      } else {
        message.error(`加载二串一方案失败: ${err.response?.data?.error || err.message}`);
      }
      setRecord(null);
      setSelected(null);
      if (!loadedNotifiedRef.current) {
        loadedNotifiedRef.current = true;
        onLoaded?.();
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setBaseType(initialBaseType);
    loadedNotifiedRef.current = false;
  }, [initialBaseType]);

  useEffect(() => {
    load();
  }, [id, baseType]);

  useEffect(() => {
    if (!record || loadedNotifiedRef.current) return;
    loadedNotifiedRef.current = true;
    onLoaded?.();
  }, [record, onLoaded]);

  const selectedRate = Number(selected?.min_profit_rate || record?.profit_rate || 0);
  const selectedStrategy = selected || record?.best_strategy || null;

  useEffect(() => {
    if (!selectedStrategy) {
      setTempSecondCrownOdds({});
      return;
    }
    const next: Record<string, number> = {};
    (selectedStrategy.crown_bets || []).forEach((b: any, idx: number) => {
      if (Number(b.match_index) === 1) {
        next[`c_${idx}`] = Number(b.odds || 0);
      }
    });
    setTempSecondCrownOdds(next);
  }, [selectedStrategy]);

  const pageTitle = record
    ? `二串一方案：${record.home_team_1} vs ${record.away_team_1} × ${record.home_team_2} vs ${record.away_team_2}`
    : '二串一方案详情';

  const parsedSides = useMemo(() => {
    const side1 = parseParlayRawSide(String(record?.side_1 || ''));
    const side2 = parseParlayRawSide(String(record?.side_2 || ''));

    const normalOddsByMatch = [
      { W: Number(record?.j1_w || 0), D: Number(record?.j1_d || 0), L: Number(record?.j1_l || 0) },
      { W: Number(record?.j2_w || 0), D: Number(record?.j2_d || 0), L: Number(record?.j2_l || 0) },
    ];

    const normalizedSingleOdd = (
      rawOdd: number,
      sideMeta: { side: MatchOutcome; handicap?: number; isHandicap: boolean },
      matchIndex: 0 | 1
    ) => {
      const h = Number(sideMeta.handicap);
      const isZero = Number.isFinite(h) && Math.abs(h) < 1e-9;
      if (sideMeta.isHandicap && isZero) {
        const candidate = Number(normalOddsByMatch[matchIndex][sideMeta.side] || 0);
        if (candidate > 0) return candidate;
      }
      return rawOdd;
    };

    const jcOdds1 = normalizedSingleOdd(Number(record?.odds_1 || 0), side1, 0);
    const jcOdds2 = normalizedSingleOdd(Number(record?.odds_2 || 0), side2, 1);

    return { side1, side2, jcOdds1, jcOdds2 };
  }, [record]);

  const betRows = useMemo<BetRow[]>(() => {
    if (!selectedStrategy) return [];

    const crownAmount = (selectedStrategy.crown_bets || []).reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const jcAmount = Math.max(0, Number(selectedStrategy.user_invest || 0) - crownAmount);

    const combinedOdds = parsedSides.jcOdds1 > 0 && parsedSides.jcOdds2 > 0
      ? parsedSides.jcOdds1 * parsedSides.jcOdds2
      : Number(record?.combined_odds || 0);

    const jcTarget = `${normalizeParlaySideLabel(record?.side_1 || '-')} × ${normalizeParlaySideLabel(record?.side_2 || '-')}`;

    return [
      {
        key: 'jc',
        platform: '竞彩',
        target: jcTarget,
        odds: combinedOdds,
        oddsDisplay:
          parsedSides.jcOdds1 > 0 && parsedSides.jcOdds2 > 0
            ? `${parsedSides.jcOdds1.toFixed(2)} × ${parsedSides.jcOdds2.toFixed(2)} = ${combinedOdds.toFixed(2)}`
            : '-',
        amount: jcAmount,
        share: settingsMeta.jcShare,
        realAmount: jcAmount / Math.max(1 - settingsMeta.jcShare, 0.0001),
        note: '先下注竞彩二串一',
      },
      ...((selectedStrategy.crown_bets || []).map((b: any, idx: number) => {
        const amount = Number(b.amount || 0);
        const isSecond = Number(b.match_index) === 1;
        const rowKey = `c_${idx}`;
        const tempOdds = isSecond ? Number(tempSecondCrownOdds[rowKey] ?? b.odds ?? 0) : Number(b.odds || 0);
        const matchLabel = isSecond ? '第二场' : '第一场';
        return {
          key: rowKey,
          platform: '皇冠',
          target: `${matchLabel} ${normalizeCrownTarget(String(b.type || ''))}`,
          odds: tempOdds,
          oddsDisplay: tempOdds.toFixed(2),
          amount,
          share: settingsMeta.crownShare,
          realAmount: amount / Math.max(1 - settingsMeta.crownShare, 0.0001),
          note: isSecond ? '第一场命中竞彩后补单' : '第一场同步补单',
        } as BetRow;
      }) as BetRow[]),
    ];
  }, [parsedSides, record, selectedStrategy, settingsMeta, tempSecondCrownOdds]);

  const parlayPrimaryBetDisplay = useMemo(() => {
    if (!record) return undefined;
    const combinedOdds = parsedSides.jcOdds1 > 0 && parsedSides.jcOdds2 > 0
      ? parsedSides.jcOdds1 * parsedSides.jcOdds2
      : Number(record?.combined_odds || 0);

    return {
      target: `${normalizeParlaySideLabel(record?.side_1 || '-')} × ${normalizeParlaySideLabel(record?.side_2 || '-')}`,
      odds: combinedOdds,
      oddsDisplay:
        parsedSides.jcOdds1 > 0 && parsedSides.jcOdds2 > 0
          ? `${parsedSides.jcOdds1.toFixed(2)} × ${parsedSides.jcOdds2.toFixed(2)} = ${combinedOdds.toFixed(2)}`
          : combinedOdds > 0
          ? combinedOdds.toFixed(2)
          : '-',
    };
  }, [parsedSides, record]);

  const outcomeRows = useMemo(() => {
    if (!selectedStrategy || !record) return [] as any[];

    const crownBets = selectedStrategy.crown_bets || [];
    const firstCrownBets = crownBets.filter((b: any) => Number(b.match_index) === 0);
    const secondCrownBets = crownBets.filter((b: any) => Number(b.match_index) === 1);

    const crownAmount = crownBets.reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const jcAmount = Math.max(0, Number(selectedStrategy.user_invest || 0) - crownAmount);

    const firstStake = firstCrownBets.reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const secondStake = secondCrownBets.reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const jcRebateRate = Number(record?.j_r ?? settingsMeta.jcRebate ?? 0);
    const crownRebateRate = Number(record?.c_r ?? settingsMeta.crownRebate ?? 0);

    const titleMap: Record<string, string> = {
      w_w: '第一场主胜 + 第二场主胜',
      w_d: '第一场主胜 + 第二场平局',
      w_l: '第一场主胜 + 第二场客胜',
      d_w: '第一场平局 + 第二场主胜',
      d_d: '第一场平局 + 第二场平局',
      d_l: '第一场平局 + 第二场客胜',
      l_w: '第一场客胜 + 第二场主胜',
      l_d: '第一场客胜 + 第二场平局',
      l_l: '第一场客胜 + 第二场客胜',
    };

    const keys = ['w_w', 'w_d', 'w_l', 'd_w', 'd_d', 'd_l', 'l_w', 'l_d', 'l_l'];

    return keys.map((key) => {
      const [a, b] = key.split('_');
      const s1 = a.toUpperCase() as MatchOutcome;
      const s2 = b.toUpperCase() as MatchOutcome;
      let worstScenario: any = null;
      for (const dg1 of outcomeGoalDiffs[s1]) {
        for (const dg2 of outcomeGoalDiffs[s2]) {
          const firstJcHit = isJcPickHitByGoalDiff(parsedSides.side1, dg1);
          const secondJcHit = isJcPickHitByGoalDiff(parsedSides.side2, dg2);
          const jcHit = firstJcHit && secondJcHit;
          const jcReturn = jcHit ? jcAmount * Math.max(parsedSides.jcOdds1 * parsedSides.jcOdds2, 0) : 0;
          const jcRebate = jcAmount * jcRebateRate;

          const firstLines = firstCrownBets.map((item: any) => {
            const parsed = parseCrownBetSide(String(item.type || ''));
            const amount = Number(item.amount || 0);
            const odds = Number(item.odds || 0);
            const ret = calcGrossReturnByGoalDiff(parsed, dg1, amount, odds);
            const settleRatio = calcSettleRatioByGoalDiff(parsed, dg1);
            return {
              label: `第一场皇冠：${normalizeCrownTarget(String(item.type || ''))}`,
              statusText: ret > 0 ? '中' : '不中',
              hit: ret > 0,
              amount: ret,
              tone: 'blue' as const,
              rebate: amount * settleRatio * crownRebateRate,
            };
          });

          const needSecondHedge = firstJcHit;
          const secondLines = needSecondHedge
            ? secondCrownBets.map((item: any, idx: number) => {
                const parsed = parseCrownBetSide(String(item.type || ''));
                const amount = Number(item.amount || 0);
                const rowKey = `c_${firstCrownBets.length + idx}`;
                const odds = Number(tempSecondCrownOdds[rowKey] ?? item.odds ?? 0);
                const ret = calcGrossReturnByGoalDiff(parsed, dg2, amount, odds);
                const settleRatio = calcSettleRatioByGoalDiff(parsed, dg2);
                return {
                  label: `第二场皇冠：${normalizeCrownTarget(String(item.type || ''))}`,
                  statusText: ret > 0 ? '中' : '不中',
                  hit: ret > 0,
                  amount: ret,
                  tone: 'green' as const,
                  rebate: amount * settleRatio * crownRebateRate,
                };
              })
            : [];

          const details: DetailLine[] = [
            {
              label: `竞彩二串一：${normalizeParlaySideLabel(record.side_1)} × ${normalizeParlaySideLabel(record.side_2)}`,
              statusText: jcHit ? '中' : '不中',
              hit: jcHit,
              amount: jcReturn,
              tone: needSecondHedge ? 'muted' : 'blue',
            },
            ...(firstLines as unknown as DetailLine[]),
            ...(secondLines as unknown as DetailLine[]),
          ];

          const gross = details.reduce((sum, x) => sum + Number(x.amount || 0), 0);
          const invest = jcAmount + firstStake + (needSecondHedge ? secondStake : 0);
          const rebate =
            jcRebate +
            firstLines.reduce((sum, x: any) => sum + Number(x.rebate || 0), 0) +
            (needSecondHedge ? secondLines.reduce((sum, x: any) => sum + Number(x.rebate || 0), 0) : 0);
          const winLossProfit = gross - invest;
          const total = winLossProfit + rebate;

          const scenario = {
            details,
            gross,
            invest,
            rebate,
            winLossProfit,
            total,
            firstJcHit,
          };
          if (!worstScenario || total < worstScenario.total) worstScenario = scenario;
        }
      }

      return {
        key,
        title: titleMap[key],
        details: worstScenario?.details || [],
        match: Number(worstScenario?.gross || 0),
        invest: Number(worstScenario?.invest || 0),
        winLossProfit: Number(worstScenario?.winLossProfit || 0),
        rebate: Number(worstScenario?.rebate || 0),
        total: Number(worstScenario?.total || 0),
        requiredScenario: Boolean(worstScenario?.firstJcHit),
        firstJcHit: Boolean(worstScenario?.firstJcHit),
        first: s1,
        second: s2,
      };
    });
  }, [parsedSides, record, selectedStrategy, settingsMeta, tempSecondCrownOdds]);

  const firstStageRows = useMemo(() => {
    const sideOrder: MatchOutcome[] = ['W', 'D', 'L'];
    const titleMap: Record<MatchOutcome, string> = { W: '第一场主胜', D: '第一场平局', L: '第一场客胜' };
    return sideOrder.map((side) => {
      const rows = outcomeRows.filter((r: any) => r.first === side);
      if (!rows.length) {
        return { key: `first_${side}`, title: titleMap[side], total: 0, match: 0, rebate: 0, winLossProfit: 0, details: [] as DetailLine[], tone: 'blue' as const };
      }
      const worst = rows.reduce((min: any, r: any) => (r.total < min.total ? r : min), rows[0]);
      return {
        key: `first_${side}`,
        title: titleMap[side],
        total: Number(worst.total || 0),
        match: Number(worst.match || 0),
        winLossProfit: Number(worst.winLossProfit || 0),
        rebate: Number(worst.rebate || 0),
        details: worst.details || [],
        tone: worst.firstJcHit ? ('muted' as const) : ('blue' as const),
      };
    });
  }, [outcomeRows]);

  const secondStageRows = useMemo(() => {
    const sideOrder: MatchOutcome[] = ['W', 'D', 'L'];
    const titleMap: Record<MatchOutcome, string> = { W: '第二场主胜', D: '第二场平', L: '第二场客胜' };
    return sideOrder.map((side) => {
      const rows = outcomeRows.filter((r: any) => r.requiredScenario && r.second === side);
      if (!rows.length) {
        return { key: `second_${side}`, title: titleMap[side], total: 0, match: 0, rebate: 0, winLossProfit: 0, details: [] as DetailLine[], tone: 'green' as const };
      }
      const row = rows.reduce((min: any, r: any) => (r.total < min.total ? r : min), rows[0]);
      return {
        key: `second_${side}`,
        title: titleMap[side],
        total: Number(row.total || 0),
        match: Number(row.match || 0),
        winLossProfit: Number(row.winLossProfit || 0),
        rebate: Number(row.rebate || 0),
        details: row.details || [],
        tone: 'green' as const,
      };
    });
  }, [outcomeRows]);

  const adjustedMinProfit = useMemo(() => {
    if (secondStageRows.length === 0) return null;
    return secondStageRows.reduce((min, row) => (row.total < min ? row.total : min), Number.POSITIVE_INFINITY);
  }, [secondStageRows]);

  const realInvestTotal = useMemo(() => betRows.reduce((sum, row) => sum + Number(row.realAmount || 0), 0), [betRows]);

  const conditionalInvest = useMemo(() => {
    if (!selectedStrategy) return 0;
    const first = (selectedStrategy.crown_bets || [])
      .filter((b: any) => Number(b.match_index) === 0)
      .reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const second = (selectedStrategy.crown_bets || [])
      .filter((b: any) => Number(b.match_index) === 1)
      .reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const allCrown = first + second;
    const jc = Math.max(0, Number(selectedStrategy.user_invest || 0) - allCrown);
    return jc + first + second;
  }, [selectedStrategy]);

  const adjustedMinRate = useMemo(() => {
    if (adjustedMinProfit === null || conditionalInvest <= 0) return null;
    return adjustedMinProfit / conditionalInvest;
  }, [adjustedMinProfit, conditionalInvest]);

  const summarySections = useMemo(() => {
    if (!record || !selectedStrategy) return [];

    type SummaryLine = {
      text: string;
      color?: string;
    };

    type SummaryCell = {
      oddsLabel: string;
      highlighted: boolean;
      tint?: 'jc' | 'crown';
      stakeLines: SummaryLine[];
      payoutLines: SummaryLine[];
      profitLines: SummaryLine[];
      oddsEditors: Array<{
        key: string;
        label: string;
        value: number;
      }>;
    };

    type SummarySection = {
      key: string;
      matchInfo: {
        league: string;
        home: string;
        away: string;
        time: string;
      };
      jc: Record<MatchOutcome, SummaryCell>;
      crown: Record<MatchOutcome, SummaryCell>;
    };

    const createCell = (oddsLabel = '-'): SummaryCell => ({
      oddsLabel,
      highlighted: false,
      stakeLines: [],
      payoutLines: [],
      profitLines: [],
      oddsEditors: [],
    });

    const createPlatformCells = () => ({
      W: createCell('-'),
      D: createCell('-'),
      L: createCell('-'),
    });

    const appendLine = (
      cell: SummaryCell,
      key: 'stakeLines' | 'payoutLines' | 'profitLines',
      text: string,
      color?: string
    ) => {
      if (!text) return;
      if (cell[key].some((item) => item.text === text)) return;
      cell[key].push({ text, color });
    };

    const appendCurrency = (
      cell: SummaryCell,
      key: 'stakeLines' | 'payoutLines' | 'profitLines',
      amount: number,
      color?: string,
      prefix = ''
    ) => {
      if (!Number.isFinite(amount) || amount <= 0) return;
      appendLine(cell, key, `${prefix}${currency(amount)}`, color);
    };

    const sideOrder: MatchOutcome[] = ['W', 'D', 'L'];
    const diffBySide: Record<MatchOutcome, number> = { W: 1, D: 0, L: -1 };

    const getJcCoveredSides = (sideMeta: { side: MatchOutcome; handicap?: number; isHandicap: boolean }) =>
      sideOrder.filter((actualSide) => isJcPickHitByGoalDiff(sideMeta, diffBySide[actualSide]));

    const getCrownCoveredSides = (betType: string, odds: number, amount: number) =>
      sideOrder.filter((actualSide) => calcGrossReturnByGoalDiff(parseCrownBetSide(betType), diffBySide[actualSide], amount, odds) > 0);

    const sections: SummarySection[] = [
      {
        key: 'match_1',
        matchInfo: {
          league: String(record.league_1 || '-'),
          home: String(record.home_team_1 || '-'),
          away: String(record.away_team_1 || '-'),
          time: String(record.match_time_1 || '-'),
        },
        jc: createPlatformCells(),
        crown: createPlatformCells(),
      },
      {
        key: 'match_2',
        matchInfo: {
          league: String(record.league_2 || '-'),
          home: String(record.home_team_2 || '-'),
          away: String(record.away_team_2 || '-'),
          time: String(record.match_time_2 || '-'),
        },
        jc: createPlatformCells(),
        crown: createPlatformCells(),
      },
    ];

    const matchMeta = [
      {
        sideMeta: parsedSides.side1,
        sideLabel: normalizeParlaySideLabel(record.side_1 || '-'),
        jcOdds: parsedSides.jcOdds1,
        jcStandard: {
          W: { label: '主胜', odds: Number(record.j1_w || 0) },
          D: { label: '平', odds: Number(record.j1_d || 0) },
          L: { label: '客胜', odds: Number(record.j1_l || 0) },
        },
        jcHandicap: {
          W: { label: String(record?.match_1_matrix?.jc?.handicap?.W?.label || ''), odds: Number(record?.match_1_matrix?.jc?.handicap?.W?.odds || 0) },
          D: { label: String(record?.match_1_matrix?.jc?.handicap?.D?.label || ''), odds: Number(record?.match_1_matrix?.jc?.handicap?.D?.odds || 0) },
          L: { label: String(record?.match_1_matrix?.jc?.handicap?.L?.label || ''), odds: Number(record?.match_1_matrix?.jc?.handicap?.L?.odds || 0) },
        },
        crownStandard: {
          W: { label: String(record?.match_1_matrix?.crown?.standard?.W?.label || '主胜'), odds: Number(record?.match_1_matrix?.crown?.standard?.W?.odds || record.c1_w || 0) },
          D: { label: String(record?.match_1_matrix?.crown?.standard?.D?.label || '平'), odds: Number(record?.match_1_matrix?.crown?.standard?.D?.odds || record.c1_d || 0) },
          L: { label: String(record?.match_1_matrix?.crown?.standard?.L?.label || '客胜'), odds: Number(record?.match_1_matrix?.crown?.standard?.L?.odds || record.c1_l || 0) },
        },
        crownHandicap: {
          W: { label: String(record?.match_1_matrix?.crown?.handicap?.cells?.W?.label || ''), odds: Number(record?.match_1_matrix?.crown?.handicap?.cells?.W?.odds || 0) },
          D: { label: String(record?.match_1_matrix?.crown?.handicap?.cells?.D?.label || ''), odds: Number(record?.match_1_matrix?.crown?.handicap?.cells?.D?.odds || 0) },
          L: { label: String(record?.match_1_matrix?.crown?.handicap?.cells?.L?.label || ''), odds: Number(record?.match_1_matrix?.crown?.handicap?.cells?.L?.odds || 0) },
        },
      },
      {
        sideMeta: parsedSides.side2,
        sideLabel: normalizeParlaySideLabel(record.side_2 || '-'),
        jcOdds: parsedSides.jcOdds2,
        jcStandard: {
          W: { label: '主胜', odds: Number(record.j2_w || 0) },
          D: { label: '平', odds: Number(record.j2_d || 0) },
          L: { label: '客胜', odds: Number(record.j2_l || 0) },
        },
        jcHandicap: {
          W: { label: String(record?.match_2_matrix?.jc?.handicap?.W?.label || ''), odds: Number(record?.match_2_matrix?.jc?.handicap?.W?.odds || 0) },
          D: { label: String(record?.match_2_matrix?.jc?.handicap?.D?.label || ''), odds: Number(record?.match_2_matrix?.jc?.handicap?.D?.odds || 0) },
          L: { label: String(record?.match_2_matrix?.jc?.handicap?.L?.label || ''), odds: Number(record?.match_2_matrix?.jc?.handicap?.L?.odds || 0) },
        },
        crownStandard: {
          W: { label: String(record?.match_2_matrix?.crown?.standard?.W?.label || '主胜'), odds: Number(record?.match_2_matrix?.crown?.standard?.W?.odds || record.c2_w || 0) },
          D: { label: String(record?.match_2_matrix?.crown?.standard?.D?.label || '平'), odds: Number(record?.match_2_matrix?.crown?.standard?.D?.odds || record.c2_d || 0) },
          L: { label: String(record?.match_2_matrix?.crown?.standard?.L?.label || '客胜'), odds: Number(record?.match_2_matrix?.crown?.standard?.L?.odds || record.c2_l || 0) },
        },
        crownHandicap: {
          W: { label: String(record?.match_2_matrix?.crown?.handicap?.cells?.W?.label || ''), odds: Number(record?.match_2_matrix?.crown?.handicap?.cells?.W?.odds || 0) },
          D: { label: String(record?.match_2_matrix?.crown?.handicap?.cells?.D?.label || ''), odds: Number(record?.match_2_matrix?.crown?.handicap?.cells?.D?.odds || 0) },
          L: { label: String(record?.match_2_matrix?.crown?.handicap?.cells?.L?.label || ''), odds: Number(record?.match_2_matrix?.crown?.handicap?.cells?.L?.odds || 0) },
        },
      },
    ] as const;

    const jcRow = betRows.find((row) => row.key === 'jc');
    const firstCrownCount = (selectedStrategy.crown_bets || []).filter((b: any) => Number(b.match_index) === 0).length;

    matchMeta.forEach((meta, index) => {
      const section = sections[index];
      const jcPool = meta.sideMeta.isHandicap ? meta.jcHandicap : meta.jcStandard;
      sideOrder.forEach((side) => {
        const source = jcPool[side];
        section.jc[side].oddsLabel = source.odds > 0 ? `${source.label} @ ${source.odds.toFixed(2)}` : '-';
      });

      const selectedJcCell = section.jc[meta.sideMeta.side];
      selectedJcCell.oddsLabel = `${meta.sideLabel} @ ${Number(meta.jcOdds || 0).toFixed(2)}`;
      selectedJcCell.highlighted = true;
      selectedJcCell.tint = 'jc';

      const coveredJcSides = getJcCoveredSides(meta.sideMeta);
      coveredJcSides.forEach((side) => {
        section.jc[side].tint = 'jc';
      });

      if (jcRow) {
        appendCurrency(selectedJcCell, 'stakeLines', Number(jcRow.amount || 0), '#222');
        appendCurrency(selectedJcCell, 'stakeLines', Number(jcRow.realAmount || 0), '#1677ff', '实投: ');
      }

      const stageRow = (index === 0 ? firstStageRows : secondStageRows).find((row: any) => row.title.includes(sideToLabel(meta.sideMeta.side)));
      coveredJcSides.forEach((side) => {
        if (!stageRow) return;
        appendCurrency(section.jc[side], 'payoutLines', Number(stageRow.match || 0), '#222');
        appendLine(section.jc[side], 'profitLines', signedCurrency(Number(stageRow.total || 0)), '#1677ff');
      });
    });

    (selectedStrategy.crown_bets || []).forEach((bet: any, idx: number) => {
      const matchIndex = Number(bet.match_index) === 1 ? 1 : 0;
      const meta = matchMeta[matchIndex];
      const section = sections[matchIndex];
      const parsed = parseCrownBetTypeCompat(normalizeCrownTarget(String(bet.type || '')));
      const side: MatchOutcome = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
      const crownPool = parsed.kind === 'ah' ? meta.crownHandicap : meta.crownStandard;

      sideOrder.forEach((orderSide) => {
        const source = crownPool[orderSide];
        if (source.odds > 0 && section.crown[orderSide].oddsLabel === '-') {
          section.crown[orderSide].oddsLabel = `${source.label} @ ${source.odds.toFixed(2)}`;
        }
      });

      const rowKey = matchIndex === 1 ? `c_${firstCrownCount + (idx - firstCrownCount)}` : `c_${idx}`;
      const displayOdds = matchIndex === 1 ? Number(tempSecondCrownOdds[rowKey] ?? bet.odds ?? 0) : Number(bet.odds || 0);
      const target = normalizeCrownTarget(String(bet.type || '-'));
      const crownCell = section.crown[side];
      crownCell.oddsLabel = `${target} @ ${displayOdds.toFixed(2)}`;
      crownCell.highlighted = true;
      crownCell.tint = 'crown';
      if (matchIndex === 1) {
        crownCell.oddsEditors.push({
          key: rowKey,
          label: target,
          value: displayOdds,
        });
      }

      const amount = Number(bet.amount || 0);
      appendCurrency(crownCell, 'stakeLines', amount, '#222');
      appendCurrency(crownCell, 'stakeLines', amount / Math.max(1 - settingsMeta.crownShare, 0.0001), '#1677ff', '实投: ');

      const coveredCrownSides = getCrownCoveredSides(String(bet.type || ''), displayOdds, amount);
      coveredCrownSides.forEach((coveredSide) => {
        section.crown[coveredSide].tint = 'crown';
      });

      const stageRow = (matchIndex === 0 ? firstStageRows : secondStageRows).find((row: any) => row.title.includes(sideToLabel(side)));
      const payoutAmount = (stageRow?.details || [])
        .filter((detail: any) => String(detail.label || '').includes(target))
        .reduce((sum: number, detail: any) => sum + Number(detail.amount || 0), 0);

      coveredCrownSides.forEach((coveredSide) => {
        appendCurrency(section.crown[coveredSide], 'payoutLines', payoutAmount, '#222');
        if (stageRow) {
          appendLine(section.crown[coveredSide], 'profitLines', signedCurrency(Number(stageRow.total || 0)), '#1677ff');
        }
      });
    });

    return sections;
  }, [betRows, firstStageRows, parsedSides, record, secondStageRows, selectedStrategy, settingsMeta.crownShare, tempSecondCrownOdds]);

  const renderOutcomeCard = (row: any) => {
    const isGreen = row.tone === 'green';
    const isMuted = row.tone === 'muted';
    const borderColor = isMuted ? '#d9d9d9' : isGreen ? '#b7eb8f' : '#91caff';
    const background = isMuted ? '#fafafa' : isGreen ? '#f6ffed' : '#f0f5ff';
    const accentColor = isMuted ? '#8c8c8c' : isGreen ? '#389e0d' : '#1677ff';
    const metricLabelStyle = { color: accentColor, minWidth: 72 };
    const metricValueStyle = { color: accentColor, minWidth: 96, textAlign: 'right' as const };

    return (
      <Card size="small" style={{ borderColor, background, width: '100%', height: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Tag color={row.total >= 0 ? (isGreen ? 'green' : 'blue') : 'red'}>{row.title}</Tag>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 118 }}>
            {(row.details || []).map((detail: DetailLine, idx: number) => (
              <div key={`${row.key}_${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <Text style={{ fontSize: 12, color: accentColor }}>{detail.label}</Text>
                <Text style={{ fontSize: 12, color: accentColor, flexShrink: 0 }}>
                  {detail.statusText} {signedCurrency(detail.amount)}
                </Text>
              </div>
            ))}
          </div>

          {(row.details || []).length > 0 ? <div style={{ borderTop: '1px dashed #d9d9d9' }} /> : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text style={metricLabelStyle}>中奖收益:</Text>
              <Text style={metricValueStyle}>{signedCurrency(row.winLossProfit)}</Text>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text style={metricLabelStyle}>返水收益:</Text>
              <Text style={metricValueStyle}>{signedCurrency(row.rebate)}</Text>
            </div>
            <div style={{ borderTop: '1px dashed #d9d9d9', margin: '8px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text strong style={metricLabelStyle}>总收益:</Text>
              <Text strong style={metricValueStyle}>{signedCurrency(row.total)}</Text>
            </div>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div style={showTitle ? { maxWidth: 1320, margin: '0 auto' } : undefined}>
      {showTitle ? (
        <Title level={1} style={{ marginBottom: 20, fontSize: 32, lineHeight: 1.2 }}>
          {record ? `二串一方案：${record.home_team_1} vs ${record.away_team_1} × ${record.home_team_2} vs ${record.away_team_2}` : pageTitle}
        </Title>
      ) : null}
      {!selectedStrategy ? (
        <Card>
          <Empty description="暂无可用的二串一方案" />
        </Card>
      ) : (
        <Card
          title="下注方案详情"
          extra={
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <BetStakeCalculatorModal
                strategy={selectedStrategy}
                primaryBetDisplay={parlayPrimaryBetDisplay}
                shares={{ jingcai: settingsMeta.jcShare, crown: settingsMeta.crownShare }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 220 }}>
                <div style={{ fontSize: 13, color: '#595959', whiteSpace: 'nowrap' }}>基准平台</div>
                <Select
                  value={baseType}
                  onChange={(value) => setBaseType(value)}
                  style={{ width: 140 }}
                  options={[
                    { value: 'jingcai', label: '竞彩' },
                    { value: 'crown', label: '皇冠', disabled: !baseTypeAvailability.crown },
                  ]}
                />
              </div>
            </div>
          }
        >
          {summarySections.length > 0 ? (
            <div style={{ marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {summarySections.map((section) => (
                <div key={section.key} style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', background: '#fff' }}>
                    <thead>
                      <tr>
                        <th style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', width: 180, textAlign: 'center', fontWeight: 700 }}>
                          比赛信息
                        </th>
                        <th style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', width: 82 }} />
                        <th colSpan={3} style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                          {`竞彩（返水: ${(settingsMeta.jcRebate * 100).toFixed(1)}% ｜ 占比: ${(settingsMeta.jcShare * 100).toFixed(1)}%）`}
                        </th>
                        <th colSpan={3} style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                          {`皇冠（返水: ${(settingsMeta.crownRebate * 100).toFixed(1)}% ｜ 占比: ${(settingsMeta.crownShare * 100).toFixed(1)}%）`}
                        </th>
                      </tr>
                      <tr>
                        <th style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px' }} />
                        <th style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px' }} />
                        {(['胜', '平', '负'] as const).map((label) => (
                          <th key={`jc_head_${section.key}_${label}`} style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                            {label}
                          </th>
                        ))}
                        {(['胜', '平', '负'] as const).map((label) => (
                          <th key={`crown_head_${section.key}_${label}`} style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label: '赔率', key: 'oddsLabel', group: 'standard' },
                        { label: '下注', key: 'stakeLines', group: 'standard' },
                        { label: '中奖', key: 'payoutLines', group: 'standard' },
                        { label: '利润', key: 'profitLines', group: 'standard' },
                      ].map((row, rowIndex) => {
                        const rowKey = row.key as 'oddsLabel' | 'stakeLines' | 'payoutLines' | 'profitLines';
                        const useSecondLegCoverageTint = section.key === 'match_2' && rowKey !== 'oddsLabel';
                        const renderCell = (cell: any, key: string) => {
                          const lines =
                            rowKey === 'oddsLabel'
                              ? [{ text: cell.oddsLabel && cell.oddsLabel !== ' @ 0.00' ? cell.oddsLabel : cell.oddsLabel || '' }]
                              : cell[rowKey];
                          const background =
                            rowKey === 'oddsLabel'
                              ? cell.highlighted
                                ? '#e88700'
                                : '#fff'
                              : cell.tint === 'jc'
                              ? '#e7f7de'
                              : cell.tint === 'crown'
                              ? useSecondLegCoverageTint
                                ? '#e7f7de'
                                : '#dff1fb'
                              : '#fff';
                          const color = rowKey === 'oddsLabel' && cell.highlighted ? '#fff' : '#222';
                          return (
                            <td
                              key={key}
                              style={{
                                border: '1px solid #d9d9d9',
                                padding: '8px 10px',
                                textAlign: 'center',
                                verticalAlign: 'middle',
                                background,
                                color,
                                fontWeight: rowKey === 'oddsLabel' && cell.highlighted ? 700 : 500,
                                minWidth: 118,
                              }}
                            >
                              {lines && lines.length > 0 && lines[0] ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {lines.map((lineItem: any, index: number) => (
                                    <div key={`${key}_${index}`} style={{ color: lineItem?.color || color }}>
                                      {lineItem?.text || ''}
                                    </div>
                                  ))}
                                  {rowKey === 'oddsLabel' && section.key === 'match_2' && cell.oddsEditors?.length > 0 ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, alignItems: 'center' }}>
                                      {cell.oddsEditors.map((editor: any) => (
                                        <div
                                          key={`${key}_${editor.key}`}
                                          style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: 4,
                                            alignItems: 'center',
                                            width: '100%',
                                          }}
                                        >
                                          {cell.oddsEditors.length > 1 ? (
                                            <Text
                                              style={{
                                                fontSize: 12,
                                                color: cell.highlighted ? '#fff' : '#595959',
                                                maxWidth: '100%',
                                              }}
                                              ellipsis
                                            >
                                              {editor.label}
                                            </Text>
                                          ) : null}
                                          <InputNumber
                                            min={0}
                                            step={0.01}
                                            precision={2}
                                            value={editor.value}
                                            size="small"
                                            style={{ width: '100%', maxWidth: 112 }}
                                            onChange={(v) =>
                                              setTempSecondCrownOdds((prev) => ({
                                                ...prev,
                                                [editor.key]: Number(v || 0),
                                              }))
                                            }
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </td>
                          );
                        };

                        const jcSource = section.jc;
                        const crownSource = section.crown;

                        return (
                          <tr key={`${section.key}_${row.group}_${row.label}_${rowIndex}`}>
                            {rowIndex === 0 ? (
                              <td
                                rowSpan={4}
                                style={{
                                  border: '1px solid #d9d9d9',
                                  padding: '8px 10px',
                                  textAlign: 'center',
                                  background: '#fff',
                                  verticalAlign: 'middle',
                                  lineHeight: 1.8,
                                }}
                              >
                                <div>{section.matchInfo.league}</div>
                                <div style={{ color: '#1677ff' }}>{section.matchInfo.home}</div>
                                <div>VS</div>
                                <div style={{ color: '#1677ff' }}>{section.matchInfo.away}</div>
                                <div>{section.matchInfo.time}</div>
                              </td>
                            ) : null}
                            <td style={{ border: '1px solid #d9d9d9', padding: '8px 10px', textAlign: 'center', background: '#fafafa', fontWeight: 600 }}>
                              {row.label}
                            </td>
                            {renderCell(jcSource.W, `${section.key}_jc_w_${rowIndex}`)}
                            {renderCell(jcSource.D, `${section.key}_jc_d_${rowIndex}`)}
                            {renderCell(jcSource.L, `${section.key}_jc_l_${rowIndex}`)}
                            {renderCell(crownSource.W, `${section.key}_crown_w_${rowIndex}`)}
                            {renderCell(crownSource.D, `${section.key}_crown_d_${rowIndex}`)}
                            {renderCell(crownSource.L, `${section.key}_crown_l_${rowIndex}`)}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ) : null}

              <div style={{ marginTop: 20 }}>
                <Title level={3} style={{ marginBottom: 8 }}>
                  预期收益分析 <Text type="secondary" style={{ fontSize: 14 }}>第一场 3 张卡片 + 第二场 3 张卡片</Text>
                </Title>

                <Title level={5} style={{ marginBottom: 8 }}>第一场三种赛果</Title>
                <Row gutter={12} style={{ marginBottom: 16 }}>
                  {firstStageRows.map((row) => (
                    <Col xs={24} md={12} lg={8} key={row.key} style={{ display: 'flex' }}>
                      {renderOutcomeCard(row)}
                    </Col>
                  ))}
                </Row>

                <Title level={5} style={{ marginBottom: 8 }}>第二场三种赛果（按第一场命中竞彩后补单）</Title>
                <Row gutter={12}>
                  {secondStageRows.map((row) => (
                    <Col xs={24} md={12} lg={8} key={row.key} style={{ display: 'flex' }}>
                      {renderOutcomeCard(row)}
                    </Col>
                  ))}
                </Row>
              </div>

              <Card size="small" style={{ marginTop: 16, background: '#f0f5ff', borderColor: '#d6e4ff' }}>
                <Space size={24} wrap>
                  <Text strong>总投入: {currency(Number(selectedStrategy.user_invest || 0))}</Text>
                  <Text strong style={{ color: '#1677ff' }}>实投金额: {currency(realInvestTotal)}</Text>
                  <Text strong>条件总投入: {currency(conditionalInvest)}</Text>
                  {adjustedMinProfit !== null ? (
                    <Tag color={rateHot(Number(adjustedMinRate || 0)) ? 'red' : 'green'} style={{ fontWeight: 700 }}>
                      最差利润: {signedCurrency(adjustedMinProfit)} ({((adjustedMinRate || 0) * 100).toFixed(3)}%)
                    </Tag>
                  ) : (
                    <Tag>当前方案没有第二场补单</Tag>
                  )}
                </Space>
              </Card>

              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                message="说明"
                description={`第一场先结算第一场结果；若第一场命中竞彩，再进入第二场补单校验。第二场卡片按主胜=${sideToLabel('W')}、平=${sideToLabel('D')}、客胜=${sideToLabel('L')} 展示。`}
              />
        </Card>
      )}
    </div>
  );
};

export default ParlayPlanDetailContent;
