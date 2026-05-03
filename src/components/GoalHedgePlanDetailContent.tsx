import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Card, Collapse, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import axios from 'axios';
import type { HedgeStrategy } from '../types';
import BetStakeCalculatorModal from './BetStakeCalculatorModal';

const { Title, Text } = Typography;

const cellBorder = '#d9d9d9';
const headerBg = '#f7f8fa';
const highlightBg = '#d97a00';
const highlightText = '#fff';

const currency = (value: number) => `￥${Number(value || 0).toFixed(2)}`;
const signedCurrency = (value: number) => `${Number(value || 0) >= 0 ? '+' : '-'}￥${Math.abs(Number(value || 0)).toFixed(2)}`;
const percent = (value: number) => `${(Number(value || 0) * 100).toFixed(2)}%`;

const normalizeGoalKey = (value: string) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.includes('7+') || text.includes('7＋')) return '7+';
  const m = text.match(/\d+/);
  return m ? m[0] : text;
};

const normalizeOuLineKey = (value: string) =>
  String(value || '')
    .replace(/\s+/g, '')
    .replace(/＋/g, '+')
    .replace(/－/g, '-')
    .replace(/大|小/g, '');

const parseOuLineValue = (value: string) => {
  const normalized = String(value || '')
    .replace(/\s+/g, '')
    .replace(/＋/g, '+')
    .replace(/－/g, '-')
    .trim();
  if (!normalized) return NaN;
  const parts = normalized
    .split('/')
    .map((segment, idx, arr) => {
      if (idx === 0) return Number(segment);
      if (segment.startsWith('+') || segment.startsWith('-')) return Number(segment);
      const baseSign = arr[0].startsWith('-') ? '-' : arr[0].startsWith('+') ? '+' : '';
      return Number(baseSign ? `${baseSign}${segment}` : segment);
    })
    .filter((n) => Number.isFinite(n));
  if (!parts.length) return NaN;
  return parts.reduce((sum, n) => sum + n, 0) / parts.length;
};

const goalKeyToNumber = (goal: string) => {
  const key = normalizeGoalKey(goal);
  if (key === '7+') return 7;
  const n = Number(key);
  return Number.isFinite(n) ? n : NaN;
};

const getOuSettlementScore = (side: 'over' | 'under', lineValue: number, goals: number) =>
  side === 'over' ? goals - lineValue : lineValue - goals;

const getOuReturnCoefficient = (side: 'over' | 'under', lineValue: number, odds: number, goals: number) => {
  const score = getOuSettlementScore(side, lineValue, goals);
  if (score >= 0.5) return 1 + odds;
  if (score === 0.25) return 1 + odds * 0.5;
  if (score === 0) return 1;
  if (score === -0.25) return 0.5;
  return 0;
};

const getOuProfitCoefficient = (side: 'over' | 'under', lineValue: number, odds: number, goals: number) => {
  const score = getOuSettlementScore(side, lineValue, goals);
  if (score >= 0.5) return odds;
  if (score === 0.25) return odds * 0.5;
  return 0;
};

const pickBoundaryRow = (rows: Array<{ row: any; score: number }>, side: 'over' | 'under') => {
  if (!rows.length) return null;
  if (side === 'over') {
    return rows.reduce((best, cur) => (cur.score < best.score ? cur : best), rows[0]).row;
  }
  return rows.reduce((best, cur) => (cur.score < best.score ? cur : best), rows[0]).row;
};

const parseGoalRows = (raw: any) => {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item: any) => {
      const label = String(item?.label || '').trim();
      const odds = Number(item?.odds || 0);
      if (!label || !Number.isFinite(odds) || odds <= 0) return null;
      return { label, odds };
    })
    .filter(Boolean) as Array<{ label: string; odds: number }>;
};

const parseOuRows = (raw: any) => {
  const list = Array.isArray(raw) ? raw : [];
  const rows: Array<{ side: 'over' | 'under'; line: string; odds: number; label: string }> = [];
  for (const item of list) {
    const line = String(item?.line || '').trim();
    const overOdds = Number(item?.over_odds || 0);
    const underOdds = Number(item?.under_odds || 0);
    if (!line) continue;
    if (Number.isFinite(overOdds) && overOdds > 0) {
      rows.push({ side: 'over', line, odds: overOdds, label: `大${line}` });
    }
    if (Number.isFinite(underOdds) && underOdds > 0) {
      rows.push({ side: 'under', line, odds: underOdds, label: `小${line}` });
    }
  }
  return rows;
};

const chunkRows = <T,>(rows: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
};

export interface GoalHedgePlanDetailContentProps {
  matchId?: string;
  initialStrategy?: HedgeStrategy | null;
  showTitle?: boolean;
  onLoaded?: () => void;
}

const GoalHedgePlanDetailContent: React.FC<GoalHedgePlanDetailContentProps> = ({
  matchId,
  initialStrategy = null,
  showTitle = true,
  onLoaded,
}) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [matchInfo, setMatchInfo] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [strategy, setStrategy] = useState<HedgeStrategy | null>(initialStrategy);
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (!matchId) return;
    setLoading(true);
    notifiedRef.current = false;
    (async () => {
      try {
        const [matchRes, settingsRes] = await Promise.all([axios.get(`/api/matches/${matchId}`), axios.get('/api/settings')]);
        setMatchInfo(matchRes.data || null);
        setSettings(settingsRes.data || null);

        if (!initialStrategy) {
          const oppRes = await axios.get('/api/arbitrage/opportunities', { params: { base_type: 'goal_hedge' } });
          const rows = (Array.isArray(oppRes.data) ? oppRes.data : []).filter((item: any) => String(item?.match_id || '') === String(matchId));
          rows.sort((a: any, b: any) => Number(b?.profit_rate || 0) - Number(a?.profit_rate || 0));
          setStrategy(rows[0]?.best_strategy || null);
        }
      } catch {
        message.error('加载进球对冲方案详情失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [initialStrategy, matchId, message]);

  useEffect(() => {
    if (loading || notifiedRef.current) return;
    notifiedRef.current = true;
    onLoaded?.();
  }, [loading, onLoaded]);

  const goalOddsRows = useMemo(() => parseGoalRows(matchInfo?.c_goal), [matchInfo?.c_goal]);
  const ouOddsRows = useMemo(() => parseOuRows(matchInfo?.c_ou), [matchInfo?.c_ou]);

  const goalMatrix = useMemo(() => chunkRows(goalOddsRows, 3), [goalOddsRows]);
  const ouMatrix = useMemo(() => chunkRows(ouOddsRows, 2), [ouOddsRows]);

  const selectedGoalKeys = useMemo(() => {
    const picks = strategy?.goal_hedge_meta?.goal_picks;
    if (!Array.isArray(picks)) return [] as string[];
    return picks.map((item: any) => normalizeGoalKey(String(item?.label || item?.goal_index || '')));
  }, [strategy?.goal_hedge_meta?.goal_picks]);

  const selectedGoalPicks = useMemo(() => {
    const picks = Array.isArray(strategy?.goal_hedge_meta?.goal_picks) ? strategy.goal_hedge_meta.goal_picks : [];
    return picks
      .map((item: any) => ({
        key: normalizeGoalKey(String(item?.label || item?.goal_index || '')),
        label: String(item?.label || item?.goal_index || ''),
        amount: Number(item?.amount || 0),
        odds: Number(item?.odds || 0),
      }))
      .filter((item: any) => item.key)
      .sort((a: any, b: any) => Number(a.key === '7+' ? 7 : a.key) - Number(b.key === '7+' ? 7 : b.key));
  }, [strategy?.goal_hedge_meta?.goal_picks]);

  const selectedOuLine = useMemo(() => normalizeOuLineKey(String(strategy?.goal_hedge_meta?.ou_bet?.line || '')), [strategy?.goal_hedge_meta?.ou_bet?.line]);
  const selectedOuSide = useMemo(() => String(strategy?.goal_hedge_meta?.ou_bet?.side || '').toLowerCase(), [strategy?.goal_hedge_meta?.ou_bet?.side]);
  const jcRebate = Number(settings?.default_jingcai_rebate || 0);
  const jcShare = Number(settings?.default_jingcai_share || 0);
  const crownRebate = Number(settings?.default_crown_rebate || 0);
  const crownShare = Number(settings?.default_crown_share || 0);
  const goalPickMap = useMemo(() => {
    const map = new Map<string, { label: string; amount: number; realAmount: number }>();
    const picks = Array.isArray(strategy?.goal_hedge_meta?.goal_picks) ? strategy.goal_hedge_meta.goal_picks : [];
    picks.forEach((item: any) => {
      const key = normalizeGoalKey(String(item?.label || item?.goal_index || ''));
      const amount = Number(item?.amount || 0);
      if (!key || !Number.isFinite(amount) || amount <= 0) return;
      map.set(key, {
        label: String(item?.label || item?.goal_index || key),
        amount,
        realAmount: amount / Math.max(1 - jcShare, 0.0001),
      });
    });
    return map;
  }, [jcShare, strategy?.goal_hedge_meta?.goal_picks]);

  const breakdownRows = useMemo(() => {
    const list = strategy?.goal_profit_breakdown;
    if (!Array.isArray(list)) return [];
    return list.map((item: any, idx: number) => ({
      key: `scene_${idx}`,
      goal: String(item?.goal || ''),
      goalLabel: String(item?.goal_label || item?.goal || '-'),
      jcReturn: Number(item?.jc_return || 0),
      ouReturn: Number(item?.ou_return || 0),
      stake: Number(item?.stake || 0),
      grossReturn: Number(item?.gross_return || 0),
      matchProfit: Number(item?.match_profit || 0),
      rebate: Number(item?.rebate || 0),
      totalProfit: Number(item?.total_profit || 0),
    }));
  }, [strategy?.goal_profit_breakdown]);

  const breakdownMap = useMemo(() => {
    const map = new Map<string, any>();
    breakdownRows.forEach((row) => map.set(normalizeGoalKey(String(row.goal || row.goalLabel || '')), row));
    return map;
  }, [breakdownRows]);

  const minProfit = Number(strategy?.min_profit || 0);
  const minProfitRate = Number(strategy?.min_profit_rate || 0);
  const userInvest = Number(strategy?.user_invest || 0);
  const totalInvest = Number(strategy?.total_invest || 0);

  const headerRows = Math.max(goalMatrix.length || 1, ouMatrix.length || 1);
  const activeGoalSet = new Set(selectedGoalKeys);
  const ouBetAmount = Number(strategy?.goal_hedge_meta?.ou_bet?.amount || 0);
  const selectedOuLabel = useMemo(() => {
    const side = selectedOuSide === 'over' ? '大' : selectedOuSide === 'under' ? '小' : '';
    const line = String(strategy?.goal_hedge_meta?.ou_bet?.line || '');
    return side && line ? `${side}${line}` : (line || '-');
  }, [selectedOuSide, strategy?.goal_hedge_meta?.ou_bet?.line]);

  const scenarioProfitCards = useMemo(() => {
    if (!breakdownRows.length) return [];
    const row0 = breakdownRows.find((row) => normalizeGoalKey(String(row.goal || row.goalLabel || '')) === '0') || null;
    const row1 = breakdownRows.find((row) => normalizeGoalKey(String(row.goal || row.goalLabel || '')) === '1') || null;
    const row2 = breakdownRows.find((row) => normalizeGoalKey(String(row.goal || row.goalLabel || '')) === '2') || null;
    const row3Plus =
      breakdownRows.find((row) => normalizeGoalKey(String(row.goal || row.goalLabel || '')) === '3') ||
      breakdownRows.find((row) => {
        const g = goalKeyToNumber(String(row.goal || row.goalLabel || ''));
        return Number.isFinite(g) && g >= 3;
      }) ||
      null;

    return [
      { key: '0', title: '0球', row: row0 },
      { key: '1', title: '1球', row: row1 },
      { key: '2', title: '2球', row: row2 },
      { key: '3plus', title: '3+球', row: row3Plus },
    ].filter((item) => Boolean(item.row));
  }, [breakdownRows]);

  const ouCardScene = useMemo(() => {
    if (!breakdownRows.length) return null;
    const lineValue = parseOuLineValue(String(strategy?.goal_hedge_meta?.ou_bet?.line || ''));
    if (Number.isFinite(lineValue) && (selectedOuSide === 'over' || selectedOuSide === 'under')) {
      const fullWinRows = breakdownRows
        .map((row) => {
          const goals = goalKeyToNumber(String(row.goal || row.goalLabel || ''));
          if (!Number.isFinite(goals)) return null;
          const score = selectedOuSide === 'over' ? goals - lineValue : lineValue - goals;
          if (score < 0.5) return null;
          return { row, score };
        })
        .filter(Boolean) as Array<{ row: any; score: number }>;
      if (fullWinRows.length > 0) {
        return fullWinRows.reduce((best, cur) => (cur.score < best.score ? cur : best), fullWinRows[0]).row;
      }
    }
    return breakdownRows.reduce((best, row) => (row.totalProfit > best.totalProfit ? row : best), breakdownRows[0]);
  }, [breakdownRows, selectedOuSide, strategy?.goal_hedge_meta?.ou_bet?.line]);

  const ouOutcomeItems = useMemo(() => {
    const side = selectedOuSide === 'under' ? 'under' : 'over';
    const lineValue = parseOuLineValue(String(strategy?.goal_hedge_meta?.ou_bet?.line || ''));
    if (!Number.isFinite(lineValue) || !breakdownRows.length) {
      return ouCardScene
        ? [
            {
              key: 'ou_single_fallback',
              title: `${selectedOuLabel}（${ouCardScene.goalLabel || '-'})`,
              row: ouCardScene,
            },
          ]
        : [];
    }

    const scored = breakdownRows
      .map((row) => {
        const goals = goalKeyToNumber(String(row.goal || row.goalLabel || ''));
        if (!Number.isFinite(goals)) return null;
        const score = getOuSettlementScore(side, lineValue, goals);
        return { row, score };
      })
      .filter(Boolean) as Array<{ row: any; score: number }>;

    const halfWinRows = scored.filter((x) => Math.abs(x.score - 0.25) < 1e-9);
    const halfLoseRows = scored.filter((x) => Math.abs(x.score + 0.25) < 1e-9);
    const fullRows = scored.filter((x) => x.score >= 0.5);
    const halfWinRow = pickBoundaryRow(halfWinRows, side);
    const halfLoseRow = pickBoundaryRow(halfLoseRows, side);
    const fullRow = pickBoundaryRow(fullRows, side);

    const items: Array<{ key: string; title: string; row: any }> = [];
    if (halfWinRow) {
      items.push({
        key: `ou_half_win_${halfWinRow.goal}`,
        title: `${selectedOuLabel} 半中（${halfWinRow.goalLabel || halfWinRow.goal || '-'}）`,
        row: halfWinRow,
      });
    }
    if (halfLoseRow) {
      items.push({
        key: `ou_half_lose_${halfLoseRow.goal}`,
        title: `${selectedOuLabel} 半输（${halfLoseRow.goalLabel || halfLoseRow.goal || '-'}）`,
        row: halfLoseRow,
      });
    }
    if (fullRow) {
      items.push({
        key: `ou_full_${fullRow.goal}`,
        title: `${selectedOuLabel} 全中（${fullRow.goalLabel || fullRow.goal || '-'}）`,
        row: fullRow,
      });
    }

    if (!items.length && ouCardScene) {
      items.push({
        key: 'ou_single_default',
        title: `${selectedOuLabel}（${ouCardScene.goalLabel || '-'})`,
        row: ouCardScene,
      });
    }
    return items;
  }, [breakdownRows, ouCardScene, selectedOuLabel, selectedOuSide, strategy?.goal_hedge_meta?.ou_bet?.line]);

  const ouPayoutDisplayItems = useMemo(() => {
    if (!ouOutcomeItems.length) {
      return [{ label: '中奖', amount: Number(ouCardScene?.ouReturn || 0) }];
    }
    if (ouOutcomeItems.length === 1) {
      return [{ label: '中奖', amount: Number(ouOutcomeItems[0]?.row?.ouReturn || 0) }];
    }
    return ouOutcomeItems.map((item) => ({
      label: item.title.includes('半中')
        ? '半中（中低盘+退半本金）'
        : item.title.includes('半输')
        ? '半输（退半本金）'
        : item.title.includes('全中')
        ? '全中'
        : '中奖',
      amount: Number(item?.row?.ouReturn || 0),
    }));
  }, [ouCardScene?.ouReturn, ouOutcomeItems]);

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (!strategy || !matchInfo) {
    return <Empty description="暂无可用的进球对冲方案" />;
  }

  return (
    <div>
      {showTitle ? (
        <Title level={4} style={{ marginBottom: 12 }}>
          进球对冲方案：{matchInfo?.home_team || ''} vs {matchInfo?.away_team || ''}
        </Title>
      ) : null}

      <Card
        size="small"
        title="下注方案详情"
        extra={<BetStakeCalculatorModal strategy={strategy} shares={{ jingcai: jcShare, crown: crownShare }} />}
        style={{ marginBottom: 12 }}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', background: '#fff' }}>
            <thead>
              <tr>
                <th style={{ border: `1px solid ${cellBorder}`, background: headerBg, padding: '10px 8px', width: 96 }} />
                <th colSpan={3} style={{ border: `1px solid ${cellBorder}`, background: headerBg, padding: '10px 8px' }}>
                  竞彩（返水：{(jcRebate * 100).toFixed(0)}% ｜ 占比：{(jcShare * 100).toFixed(0)}%）
                </th>
                <th colSpan={2} style={{ border: `1px solid ${cellBorder}`, background: headerBg, padding: '10px 8px' }}>
                  皇冠（返水：{(crownRebate * 100).toFixed(0)}% ｜ 占比：{(crownShare * 100).toFixed(0)}%）
                </th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: headerRows }).map((_, rowIdx) => {
                const goalRow = goalMatrix[rowIdx] || [];
                const ouRow = ouMatrix[rowIdx] || [];
                const labels: Array<'下注' | '中奖'> = ['下注', '中奖'];
                const rowHasGoalBet = goalRow.some((item) => item && goalPickMap.has(normalizeGoalKey(item.label)));
                const rowHasOuBet = ouRow.some(
                  (item) =>
                    item &&
                    selectedOuLine &&
                    selectedOuSide &&
                    selectedOuLine === normalizeOuLineKey(item.line) &&
                    selectedOuSide === item.side
                );
                const rowHasBet = rowHasGoalBet || rowHasOuBet;

                return (
                  <React.Fragment key={`matrix_block_${rowIdx}`}>
                    <tr key={`odds_row_${rowIdx}`}>
                      <td style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px', textAlign: 'center', background: '#fafafa' }}>赔率</td>
                      {Array.from({ length: 3 }).map((__, colIdx) => {
                        const item = goalRow[colIdx];
                        if (!item) return <td key={`goal_odd_empty_${rowIdx}_${colIdx}`} style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px' }} />;
                        const active = activeGoalSet.has(normalizeGoalKey(item.label));
                        return (
                          <td key={`goal_odd_${rowIdx}_${colIdx}`} style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px', textAlign: 'center', background: active ? highlightBg : '#fff', color: active ? highlightText : '#333', fontWeight: active ? 700 : 500 }}>
                            ({item.label}) @{item.odds.toFixed(2)}
                          </td>
                        );
                      })}
                      {Array.from({ length: 2 }).map((__, colIdx) => {
                        const item = ouRow[colIdx];
                        if (!item) return <td key={`ou_odd_empty_${rowIdx}_${colIdx}`} style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px' }} />;
                        const active = selectedOuLine && selectedOuSide && selectedOuLine === normalizeOuLineKey(item.line) && selectedOuSide === item.side;
                        return (
                          <td key={`ou_odd_${rowIdx}_${colIdx}`} style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px', textAlign: 'center', background: active ? highlightBg : '#fff', color: active ? highlightText : '#333', fontWeight: active ? 700 : 500 }}>
                            ({item.label}) @{item.odds.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>

                    {rowHasBet
                      ? labels.map((label) => (
                          <tr key={`info_row_${rowIdx}_${label}`}>
                            <td style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px', textAlign: 'center', background: '#fafafa' }}>{label}</td>
                            {Array.from({ length: 3 }).map((__, colIdx) => {
                              const item = goalRow[colIdx];
                              const picked = item ? goalPickMap.get(normalizeGoalKey(item.label)) : null;
                              const breakdown = item ? breakdownMap.get(normalizeGoalKey(item.label)) : null;
                              const hasContent = Boolean(picked && breakdown);
                              let content: React.ReactNode = null;
                                if (hasContent && picked && breakdown) {
                                  if (label === '下注') {
                                    content = (
                                      <div style={{ lineHeight: 1.5 }}>
                                        <div>{currency(picked.amount)}</div>
                                        <div style={{ color: '#1677ff' }}>实投：{currency(picked.realAmount)}</div>
                                      </div>
                                    );
                                  } else if (label === '中奖') {
                                    content = <div>{currency(Number(breakdown.jcReturn || 0))}</div>;
                                  }
                                }
                              return (
                                <td
                                  key={`info_goal_${rowIdx}_${label}_${colIdx}`}
                                  style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px', textAlign: 'center', background: hasContent ? '#d9f0d8' : '#fff', fontWeight: hasContent ? 600 : 400 }}
                                >
                                  {content}
                                </td>
                              );
                            })}
                            {Array.from({ length: 2 }).map((__, colIdx) => {
                              const item = ouRow[colIdx];
                              const active =
                                item &&
                                selectedOuLine &&
                                selectedOuSide &&
                                selectedOuLine === normalizeOuLineKey(item.line) &&
                                selectedOuSide === item.side;
                              let content: React.ReactNode = null;
                                if (active) {
                                  if (label === '下注') {
                                    content = (
                                      <div style={{ lineHeight: 1.5 }}>
                                        <div>{currency(ouBetAmount)}</div>
                                        <div style={{ color: '#1677ff' }}>实投：{currency(ouBetAmount / Math.max(1 - crownShare, 0.0001))}</div>
                                      </div>
                                    );
                                  } else if (label === '中奖') {
                                    content = (
                                      <div style={{ lineHeight: 1.5 }}>
                                        {ouPayoutDisplayItems.map((x, idx) => (
                                          <div key={`ou_payout_${idx}`}>
                                            {ouPayoutDisplayItems.length > 1 ? `${x.label}：` : ''}
                                            {currency(x.amount)}
                                          </div>
                                        ))}
                                      </div>
                                    );
                                  }
                                }
                              return (
                                <td key={`info_ou_${rowIdx}_${label}_${colIdx}`} style={{ border: `1px solid ${cellBorder}`, padding: '10px 8px', textAlign: 'center', background: active ? '#d9f0d8' : '#fff', fontWeight: active ? 600 : 400 }}>
                                  {content}
                                </td>
                              );
                            })}
                          </tr>
                        ))
                      : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card size="small" title="预期收益分析" style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {scenarioProfitCards.map((scene) => {
            const row = scene.row;
            if (!row) return null;
            const winReturn = Number(row.grossReturn || 0);
            const rebateReturn = Number(row.rebate || 0);
            const totalProfit = Number(row.totalProfit ?? (winReturn + rebateReturn - Number(userInvest || 0)));
            const ouOdds = Number(strategy?.goal_hedge_meta?.ou_bet?.odds || 0);
            return (
              <div key={`goal_profit_card_${scene.key}`} style={{ borderRadius: 8, border: '1px solid #b7eb8f', background: '#f6ffed', padding: '12px 14px' }}>
                <div style={{ marginBottom: 8 }}>
                  <Tag color="blue">{scene.title}</Tag>
                </div>
                {selectedGoalPicks.map((goalPick) => (
                  <div key={`stake_goal_${scene.key}_${goalPick.key}`} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span>竞彩({goalPick.label}) @{Number(goalPick.odds || 0).toFixed(2)}</span>
                    <span style={{ color: '#cf1322' }}>- {currency(Number(goalPick.amount || 0))}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>皇冠({selectedOuLabel}) @{ouOdds.toFixed(2)}</span>
                  <span style={{ color: '#cf1322' }}>- {currency(ouBetAmount)}</span>
                </div>
                <div style={{ borderTop: '1px dashed #c7d8c0', margin: '6px 0 8px' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>中奖收益:</span>
                  <span style={{ color: '#389e0d' }}>{signedCurrency(winReturn)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>返水收益:</span>
                  <span style={{ color: rebateReturn >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(rebateReturn)}</span>
                </div>
                <div style={{ borderTop: '1px dashed #c7d8c0', margin: '6px 0 8px' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span style={{ fontWeight: 700 }}>总收益:</span>
                  <span style={{ fontWeight: 700, color: totalProfit >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(totalProfit)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card size="small" style={{ marginBottom: 12, background: '#f0f5ff' }}>
        <Space size={32} wrap>
          <Text>总投入：{currency(userInvest)}</Text>
          <Text strong style={{ color: '#1677ff' }}>实投总计：{currency(totalInvest)}</Text>
          <Text strong style={{ color: '#cf1322' }}>最低利润率：{percent(minProfitRate)}</Text>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        message="算法说明"
        description="单场下的总利润以最低利润场景衡量回报；卡片中的单条下注展示为该总进球场景下的实际返还（含返水，不含冲分）。"
        style={{ marginBottom: 12 }}
      />

      <Collapse
        items={[
          {
            key: 'scene-breakdown',
            label: '场景明细（0~7+）',
            children: (
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                dataSource={breakdownRows}
                columns={[
                  { title: '场景', dataIndex: 'goalLabel', key: 'goalLabel', width: 90, align: 'center' as const },
                  { title: '本金', dataIndex: 'stake', key: 'stake', align: 'right' as const, render: (v: number) => currency(v) },
                  { title: '中奖返还', dataIndex: 'grossReturn', key: 'grossReturn', align: 'right' as const, render: (v: number) => currency(v) },
                  { title: '净赢亏', dataIndex: 'matchProfit', key: 'matchProfit', align: 'right' as const, render: (v: number) => signedCurrency(v) },
                  { title: '返水', dataIndex: 'rebate', key: 'rebate', align: 'right' as const, render: (v: number) => signedCurrency(v) },
                  {
                    title: '总利润',
                    dataIndex: 'totalProfit',
                    key: 'totalProfit',
                    align: 'right' as const,
                    render: (v: number) => <Text style={{ color: Number(v) > 0 ? '#cf1322' : '#595959', fontWeight: 700 }}>{signedCurrency(v)}</Text>,
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
};

export default GoalHedgePlanDetailContent;
