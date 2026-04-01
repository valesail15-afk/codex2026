import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, InputNumber, Radio, Row, Space, Table, Tag, Typography } from 'antd';
import { useParams, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import type { HedgeStrategy } from '../types';
import { normalizeCrownTarget, normalizeParlaySideLabel, parseCrownBetType, parseParlayRawSide, sideToLabel } from '../shared/oddsText';

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
    if (score >= 0.5) return a * o;
    if (score === 0.25) return a * ((o + 1) / 2);
    if (score === 0) return a;
    if (score === -0.25) return a * 0.5;
    return 0;
  }

  const score = pick.side === 'W' ? dg + h : -dg + h;
  if (score >= 0.5) return a * o;
  if (score === 0.25) return a * ((o + 1) / 2);
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
  const parsed = parseCrownBetType(raw);
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

const ParlayCalculator: React.FC = () => {
  const { message } = App.useApp();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [baseType, setBaseType] = useState<'jingcai' | 'crown'>((searchParams.get('base_type') || 'jingcai') as 'jingcai' | 'crown');
  const [loading, setLoading] = useState(false);

  const [record, setRecord] = useState<any>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selected, setSelected] = useState<HedgeStrategy | null>(null);
  const [settingsMeta, setSettingsMeta] = useState({ jcShare: 0, crownShare: 0, jcRebate: 0.13, crownRebate: 0.02 });
  const [tempSecondCrownOdds, setTempSecondCrownOdds] = useState<Record<string, number>>({});

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const detailRes = await axios.get(`/api/arbitrage/parlay-opportunities/${id}`, { params: { base_type: baseType } });
      const detail = detailRes.data;
      setRecord(detail);
      setSelected(detail?.best_strategy || null);

      const settingRes = await axios.get('/api/settings');
        setSettingsMeta({
          jcShare: Number(settingRes.data?.default_jingcai_share || 0),
          crownShare: Number(settingRes.data?.default_crown_share || 0),
          jcRebate: Number(settingRes.data?.default_jingcai_rebate || 0.13),
          crownRebate: Number(settingRes.data?.default_crown_rebate || 0.02),
        });

      const listRes = await axios.get('/api/arbitrage/parlay-opportunities', { params: { base_type: baseType } });
      const list = Array.isArray(listRes.data) ? listRes.data : [];
      const samePair = list
        .filter((x: any) => x.match_id_1 === detail.match_id_1 && x.match_id_2 === detail.match_id_2)
        .sort((a: any, b: any) => (b.profit_rate || 0) - (a.profit_rate || 0));
      setCandidates(samePair.length > 0 ? samePair : [detail]);
    } catch {
      message.error('加载二串一方案失败');
      setRecord(null);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, baseType]);

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
    ? `二串一：${record.home_team_1} vs ${record.away_team_1} × ${record.home_team_2} vs ${record.away_team_2}`
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
        note: '二串一预先买入，赔率固定',
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
          note: isSecond ? '仅在“第一场命中竞彩”时补单' : '第一场先手对冲',
        } as BetRow;
      }) as BetRow[]),
    ];
  }, [selectedStrategy, record, settingsMeta, parsedSides, tempSecondCrownOdds]);

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
      w_w: '第一场主胜 × 第二场主胜',
      w_d: '第一场主胜 × 第二场平',
      w_l: '第一场主胜 × 第二场客胜',
      d_w: '第一场平 × 第二场主胜',
      d_d: '第一场平 × 第二场平',
      d_l: '第一场平 × 第二场客胜',
      l_w: '第一场客胜 × 第二场主胜',
      l_d: '第一场客胜 × 第二场平',
      l_l: '第一场客胜 × 第二场客胜',
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
          const rebate = jcRebate + firstLines.reduce((sum, x: any) => sum + Number(x.rebate || 0), 0) + (needSecondHedge ? secondLines.reduce((sum, x: any) => sum + Number(x.rebate || 0), 0) : 0);
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
  }, [selectedStrategy, record, parsedSides, settingsMeta, tempSecondCrownOdds]);

  const firstStageRows = useMemo(() => {
    const sideOrder: MatchOutcome[] = ['W', 'D', 'L'];
    const titleMap: Record<MatchOutcome, string> = { W: '第一场主胜', D: '第一场平', L: '第一场客胜' };
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

  const secondLegBets = useMemo(() => {
    if (!selectedStrategy) return [] as Array<{ key: string; label: string; odds: number }>;
    const firstCount = (selectedStrategy.crown_bets || []).filter((b: any) => Number(b.match_index) === 0).length;
    return (selectedStrategy.crown_bets || [])
      .filter((b: any) => Number(b.match_index) === 1)
      .map((b: any, idx: number) => {
        const key = `c_${firstCount + idx}`;
        return {
          key,
          label: normalizeCrownTarget(String(b.type || '')),
          odds: Number(tempSecondCrownOdds[key] ?? b.odds ?? 0),
        };
      });
  }, [selectedStrategy, tempSecondCrownOdds]);

  const renderOutcomeCard = (row: any) => {
    const isGreen = row.tone === 'green';
    const isMuted = row.tone === 'muted';
    const borderColor = isMuted ? '#d9d9d9' : isGreen ? '#b7eb8f' : '#91caff';
    const background = isMuted ? '#fafafa' : isGreen ? '#f6ffed' : '#f0f5ff';
    const accentColor = isMuted ? '#8c8c8c' : isGreen ? '#389e0d' : '#1677ff';
    const bodyTextColor = accentColor;
    const metricLabelStyle = { color: accentColor, minWidth: 72 };
    const metricValueStyle = { color: accentColor, minWidth: 96, textAlign: 'right' as const };

    return (
      <Card size="small" style={{ borderColor, background, width: '100%', height: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Tag color={row.total >= 0 ? (isGreen ? 'green' : 'blue') : 'red'}>{row.title}</Tag>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 118 }}>
            {(row.details || []).map((detail: DetailLine, idx: number) => {
              return (
                <div key={`${row.key}_${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <Text style={{ fontSize: 12, color: bodyTextColor }}>{detail.label}</Text>
                  <Text style={{ fontSize: 12, color: bodyTextColor, flexShrink: 0 }}>
                    {detail.statusText} {signedCurrency(detail.amount)}
                  </Text>
                </div>
              );
            })}
          </div>

          {(row.details || []).length > 0 ? <div style={{ borderTop: '1px dashed #d9d9d9' }} /> : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text style={metricLabelStyle}>胜负收益:</Text>
              <Text style={metricValueStyle}>{signedCurrency(row.winLossProfit)}</Text>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text style={metricLabelStyle}>返水收益:</Text>
              <Text style={metricValueStyle}>{signedCurrency(row.rebate)}</Text>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text strong style={metricLabelStyle}>总利润:</Text>
              <Text strong style={metricValueStyle}>{signedCurrency(row.total)}</Text>
            </div>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <Title level={2} style={{ marginBottom: 16 }}>
        {pageTitle}
      </Title>

      <Row gutter={20}>
        <Col xs={24} lg={8}>
          <Card title="下注设置" style={{ marginBottom: 16 }} loading={loading}>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">二串一方向</Text>
              <div style={{ marginTop: 6 }}>
                <Tag color="blue">{normalizeParlaySideLabel(record?.side_1 || '-')}</Tag>
                <Tag color="cyan">{normalizeParlaySideLabel(record?.side_2 || '-')}</Tag>
              </div>
            </div>

            <div>
              <Text type="secondary">整单控制</Text>
              <div style={{ marginTop: 8 }}>
                <Radio.Group value={baseType} onChange={(e) => setBaseType(e.target.value)} style={{ width: '100%' }}>
                  <Radio.Button value="jingcai" style={{ width: '50%', textAlign: 'center' }}>
                    竞彩
                  </Radio.Button>
                  <Radio.Button value="crown" style={{ width: '50%', textAlign: 'center' }}>
                    皇冠
                  </Radio.Button>
                </Radio.Group>
              </div>
            </div>
          </Card>

          <Card title="第2场补单临时赔率" style={{ marginBottom: 16 }}>
            {secondLegBets.length === 0 ? (
              <Empty description="当前策略没有第2场补单项" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }}>
                {secondLegBets.map((item) => (
                  <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <Text style={{ maxWidth: 180 }} ellipsis>
                      {item.label}
                    </Text>
                    <InputNumber
                      min={0}
                      step={0.01}
                      precision={2}
                      value={item.odds}
                      onChange={(v) =>
                        setTempSecondCrownOdds((prev) => ({
                          ...prev,
                          [item.key]: Number(v || 0),
                        }))
                      }
                    />
                  </div>
                ))}
              </Space>
            )}
          </Card>

          <Card title="对冲策略选择">
            <Space direction="vertical" style={{ width: '100%' }}>
              {(candidates || []).map((item: any, idx: number) => (
                <Button
                  key={`${item.id}_${idx}`}
                  className="solid-blue-btn"
                  block
                  type={(selectedStrategy?.name || '') === (item.best_strategy?.name || '') ? 'primary' : 'default'}
                  onClick={() => setSelected(item.best_strategy)}
                >
                  方案{idx + 1} ({((item.profit_rate || 0) * 100).toFixed(2)}%)
                </Button>
              ))}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          {!selectedStrategy ? (
            <Card>
              <Empty description="暂无可用的二串一方案" />
            </Card>
          ) : (
            <Card title="下注方案详情">
              <Table
                dataSource={betRows}
                pagination={false}
                size="small"
                rowKey="key"
                columns={[
                  { title: '平台', dataIndex: 'platform', width: '12%' as const },
                  { title: '下注项', dataIndex: 'target', width: '30%' as const },
                  {
                    title: '赔率',
                    dataIndex: 'odds',
                    width: '18%' as const,
                    render: (_: number, row: BetRow) => String(row.oddsDisplay || Number(row.odds || 0).toFixed(2)),
                  },
                  {
                    title: '下注金额',
                    dataIndex: 'amount',
                    width: '18%' as const,
                    render: (v: number, row: BetRow) => (
                      <Space direction="vertical" size={0}>
                        <Text strong>{currency(v)}</Text>
                        <Text style={{ color: Number(row.share || 0) > 0 ? '#1677ff' : '#999' }}>实投: {currency(row.realAmount)}</Text>
                      </Space>
                    ),
                  },
                  {
                    title: '备注',
                    dataIndex: 'note',
                    width: '22%' as const,
                    render: (v: string) => <Text type="secondary">{v || '-'}</Text>,
                  },
                ]}
                tableLayout="fixed"
              />

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
                  <Text strong>原始最低利润率: {(selectedRate * 100).toFixed(3)}%</Text>
                  <Text strong style={{ color: '#1677ff' }}>当前实投总计: {currency(realInvestTotal)}</Text>
                  <Text strong>条件补单总投入: {currency(conditionalInvest)}</Text>
                  {adjustedMinProfit !== null ? (
                    <Tag color={rateHot(Number(adjustedMinRate || 0)) ? 'red' : 'green'} style={{ fontWeight: 700 }}>
                      临调后最低利润: {signedCurrency(adjustedMinProfit)} ({((adjustedMinRate || 0) * 100).toFixed(3)}%)
                    </Tag>
                  ) : (
                    <Tag>当前无“需要第2场补单”的分支</Tag>
                  )}
                </Space>
              </Card>

              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                message="算法说明"
                description={`当前按新规则展示：第一场先满足单场套利；仅在“第一场命中竞彩”时触发第二场皇冠补单。胜平负映射：${sideToLabel('W')}=${sideToLabel('W')}，${sideToLabel('D')}=${sideToLabel('D')}，${sideToLabel('L')}=${sideToLabel('L')}。`}
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
};

export default ParlayCalculator;
