import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Card, Col, Empty, Row, Space, Tag, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import axios from 'axios';
import { invertHandicap, normalizeCrownTarget, parseCrownBetType } from '../shared/oddsText';
import type { CrownBet, HedgeStrategy } from '../types';

const { Title, Text } = Typography;

type OutcomeSide = 'W' | 'D' | 'L';
type ProfitKey = 'win' | 'draw' | 'lose';

const EPS = 1e-9;

const sideLabel = (side: OutcomeSide) => {
  if (side === 'W') return '主胜';
  if (side === 'D') return '平';
  return '客胜';
};

const currency = (n: number) => `¥${Number(n || 0).toFixed(2)}`;
const signedCurrency = (n: number) => `${Number(n || 0) >= 0 ? '+' : '-'}¥${Math.abs(Number(n || 0)).toFixed(2)}`;
const pct = (n: number, digit = 1) => `${(Number(n || 0) * 100).toFixed(digit)}%`;

const parseRows = (raw: any) => {
  if (!raw) return [] as any[];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const sideToProfitKey = (side: OutcomeSide): ProfitKey => {
  if (side === 'W') return 'win';
  if (side === 'D') return 'draw';
  return 'lose';
};

const outcomeTitle = (side: OutcomeSide) => sideLabel(side);

const almostEq = (a: number, b: number) => Math.abs(a - b) < EPS;

const getReturnCoefficient = (type: string, odds: number, outcome: OutcomeSide) => {
  const bet = parseCrownBetType(type);
  const dg = outcome === 'W' ? 1 : outcome === 'D' ? 0 : -1;
  if (bet.kind === 'std') {
    if (bet.side === 'home') return outcome === 'W' ? odds : 0;
    if (bet.side === 'draw') return outcome === 'D' ? odds : 0;
    return outcome === 'L' ? odds : 0;
  }

  const h = Number(bet.handicap || 0);
  const score = bet.side === 'home' ? dg + h : -dg + h;
  if (score >= 0.5) return 1 + odds;
  if (almostEq(score, 0.25)) return 1 + odds * 0.5;
  if (almostEq(score, 0)) return 1;
  if (almostEq(score, -0.25)) return 0.5;
  return 0;
};

const getCoverage = (type: string, odds: number, amount: number) => {
  const result: Record<OutcomeSide, number> = { W: 0, D: 0, L: 0 };
  (['W', 'D', 'L'] as OutcomeSide[]).forEach((side) => {
    result[side] = amount * getReturnCoefficient(type, odds, side);
  });
  return result;
};

type BetRow = {
  key: string;
  platform: '皇冠' | '皇冠让球';
  type: string;
  target: string;
  odds: number;
  amount: number;
  realAmount: number;
  selectedSide: OutcomeSide;
};

type MatrixGroup = {
  key: string;
  baseBet: BetRow | null;
  hedgeBet: BetRow | null;
  ahLine: string;
  ahHomeOdds: number;
  ahAwayOdds: number;
};

export interface HgPlanDetailContentProps {
  matchId?: string;
  initialStrategy?: HedgeStrategy | null;
  showTitle?: boolean;
}

const HgPlanDetailContent: React.FC<HgPlanDetailContentProps> = ({ matchId, initialStrategy = null, showTitle = true }) => {
  const { message } = App.useApp();
  const [matchInfo, setMatchInfo] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [strategy, setStrategy] = useState<HedgeStrategy | null>(initialStrategy);

  useEffect(() => {
    if (!matchId) return;
    (async () => {
      try {
        const [matchRes, settingRes] = await Promise.all([axios.get(`/api/matches/${matchId}`), axios.get('/api/settings')]);
        setMatchInfo(matchRes.data);
        setSettings(settingRes.data || {});
      } catch {
        message.error('加载 HG 方案详情失败');
      }
    })();
  }, [matchId, message]);

  useEffect(() => {
    if (!matchId || initialStrategy) return;
    (async () => {
      try {
        const res = await axios.get('/api/arbitrage/opportunities', { params: { base_type: 'hg' } });
        const list = (Array.isArray(res.data) ? res.data : []).filter((item: any) => String(item?.match_id || '') === String(matchId));
        list.sort((a: any, b: any) => Number(b?.profit_rate || 0) - Number(a?.profit_rate || 0));
        setStrategy(list[0]?.best_strategy || null);
      } catch {
        setStrategy(null);
      }
    })();
  }, [initialStrategy, matchId]);

  const crownShare = Number(settings?.default_crown_share ?? matchInfo?.c_s ?? 0);
  const crownRebate = Number(settings?.default_crown_rebate ?? matchInfo?.c_r ?? 0.02);

  const allBets = useMemo(() => {
    if (!strategy) return [] as BetRow[];
    const rows: BetRow[] = [];
    const toRow = (bet: CrownBet, platform: '皇冠' | '皇冠让球', key: string): BetRow | null => {
      const amount = Number(bet.amount || 0);
      const odds = Number(bet.odds || 0);
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(odds) || odds <= 0) return null;
      const parsed = parseCrownBetType(String(bet.type || ''));
      const selectedSide: OutcomeSide = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
      return {
        key,
        platform,
        type: String(bet.type || ''),
        target: normalizeCrownTarget(String(bet.type || '')),
        odds,
        amount,
        realAmount: amount / Math.max(1 - crownShare, 0.0001),
        selectedSide,
      };
    };

    const base = (strategy as any)?.hg_base_bet as CrownBet | undefined;
    if (base) {
      const row = toRow(base, '皇冠', 'base');
      if (row) rows.push(row);
    }

    (strategy.crown_bets || []).forEach((bet: CrownBet, index: number) => {
      const row = toRow(bet, '皇冠让球', `hedge_${index}`);
      if (row) rows.push(row);
    });

    return rows;
  }, [crownShare, strategy]);

  const standardBaseBet = useMemo(() => allBets.find((b) => b.platform === '皇冠') || null, [allBets]);
  const hedgeBets = useMemo(() => allBets.filter((b) => b.platform === '皇冠让球'), [allBets]);

  const handicapRows = parseRows(matchInfo?.c_h);

  const resolveAhRow = (bet: BetRow | null) => {
    if (!bet) return { line: '', homeOdds: 0, awayOdds: 0 };
    const lineRaw = String(bet.type || '').match(/\(([^)]+)\)/)?.[1] || '';
    if (!lineRaw) return { line: '', homeOdds: 0, awayOdds: 0 };
    const candidates = [lineRaw, invertHandicap(lineRaw)];
    const found = handicapRows.find((h: any) => candidates.includes(String(h?.type || '').trim()));
    if (!found) return { line: lineRaw, homeOdds: 0, awayOdds: 0 };
    return {
      line: String(found?.type || lineRaw),
      homeOdds: Number(found?.home_odds || 0),
      awayOdds: Number(found?.away_odds || 0),
    };
  };

  const matrixGroups = useMemo(() => {
    const groups: MatrixGroup[] = [];
    if (standardBaseBet && hedgeBets.length > 0) {
      const first = hedgeBets[0];
      const ah = resolveAhRow(first);
      groups.push({
        key: 'group_0',
        baseBet: standardBaseBet,
        hedgeBet: first,
        ahLine: ah.line,
        ahHomeOdds: ah.homeOdds,
        ahAwayOdds: ah.awayOdds,
      });
      hedgeBets.slice(1).forEach((bet, idx) => {
        const row = resolveAhRow(bet);
        groups.push({
          key: `group_${idx + 1}`,
          baseBet: null,
          hedgeBet: bet,
          ahLine: row.line,
          ahHomeOdds: row.homeOdds,
          ahAwayOdds: row.awayOdds,
        });
      });
      return groups;
    }

    if (standardBaseBet) {
      groups.push({ key: 'group_0', baseBet: standardBaseBet, hedgeBet: null, ahLine: '', ahHomeOdds: 0, ahAwayOdds: 0 });
      return groups;
    }

    hedgeBets.forEach((bet, idx) => {
      const row = resolveAhRow(bet);
      groups.push({ key: `group_${idx}`, baseBet: null, hedgeBet: bet, ahLine: row.line, ahHomeOdds: row.homeOdds, ahAwayOdds: row.awayOdds });
    });
    return groups;
  }, [hedgeBets, standardBaseBet, handicapRows]);

  const outcomeRows = useMemo(() => {
    if (!strategy) return [] as any[];
    const bets = allBets;

    return (['W', 'D', 'L'] as OutcomeSide[]).map((side) => {
      const key = sideToProfitKey(side);
      const details = bets.map((bet) => {
        const payout = getCoverage(bet.type, bet.odds, bet.amount)[side] || 0;
        return {
          text: `${bet.platform}: ${bet.target}`,
          hit: payout > EPS,
          amount: payout,
        };
      });
      const total = Number(strategy.profits?.[key] || 0);
      const match = Number(strategy.match_profits?.[key] || 0);
      const rebate = Number(strategy.rebates?.[key] || strategy.rebate || total - match || 0);
      return {
        key: side,
        title: outcomeTitle(side),
        color: side === 'W' ? 'blue' : side === 'D' ? 'gold' : 'red',
        details,
        match,
        rebate,
        total,
      };
    });
  }, [allBets, strategy]);

  const totalRealInvest = useMemo(() => allBets.reduce((sum, bet) => sum + Number(bet.realAmount || 0), 0), [allBets]);

  const headerLeft = `皇冠（返水: ${pct(crownRebate, 1)} ｜ 占比: ${pct(crownShare, 1)}）`;
  const headerRight = `皇冠让球（返水: ${pct(crownRebate, 1)} ｜ 占比: ${pct(crownShare, 1)}）`;

  const title = matchInfo ? `HG对冲方案: ${matchInfo.home_team} vs ${matchInfo.away_team}` : 'HG对冲方案';

  const renderValueCell = (value: React.ReactNode, opts?: { active?: boolean; winCover?: boolean; emphasize?: boolean }) => {
    const active = Boolean(opts?.active);
    const winCover = Boolean(opts?.winCover);
    return (
      <td
        style={{
          border: '1px solid #d9d9d9',
          padding: '8px 10px',
          textAlign: 'center',
          background: active ? '#e88700' : winCover ? '#d9f2d9' : '#fff',
          color: active ? '#fff' : '#222',
          fontWeight: active || opts?.emphasize ? 700 : 500,
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          minHeight: 46,
        }}
      >
        {value}
      </td>
    );
  };

  const renderAmountBlock = (amount?: number, real?: number) => {
    if (!amount || amount <= 0) return null;
    return (
      <div>
        <div>{currency(amount)}</div>
        <div style={{ color: '#1677ff' }}>实投: {currency(real || 0)}</div>
      </div>
    );
  };

  const renderGroup = (group: MatrixGroup, index: number) => {
    const base = group.baseBet;
    const hedge = group.hedgeBet;

    const baseCoverage = base ? getCoverage(base.type, base.odds, base.amount) : { W: 0, D: 0, L: 0 };
    const hedgeCoverage = hedge ? getCoverage(hedge.type, hedge.odds, hedge.amount) : { W: 0, D: 0, L: 0 };

    const baseSide = base?.selectedSide;
    const hedgeSide = hedge?.selectedSide;

    const ahLine = group.ahLine || '-';

    return (
      <React.Fragment key={group.key}>
        <tr>
          <td style={{ border: '1px solid #d9d9d9', padding: '8px 10px', textAlign: 'center', background: '#fafafa', fontWeight: 600 }}>赔率</td>
          {renderValueCell(base ? `主胜 @ ${Number(matchInfo?.c_w || 0).toFixed(2)}` : '', { active: baseSide === 'W' })}
          {renderValueCell(base ? `平 @ ${Number(matchInfo?.c_d || 0).toFixed(2)}` : '', { active: baseSide === 'D' })}
          {renderValueCell(base ? `客胜 @ ${Number(matchInfo?.c_l || 0).toFixed(2)}` : '', { active: baseSide === 'L' })}

          {renderValueCell(hedge ? `主胜(${ahLine}) @ ${Number(group.ahHomeOdds || 0).toFixed(2)}` : '', { active: hedgeSide === 'W' })}
          {renderValueCell(hedge ? '-' : '')}
          {renderValueCell(hedge ? `客胜(${invertHandicap(ahLine)}) @ ${Number(group.ahAwayOdds || 0).toFixed(2)}` : '', { active: hedgeSide === 'L' })}
        </tr>

        <tr>
          <td style={{ border: '1px solid #d9d9d9', padding: '8px 10px', textAlign: 'center', background: '#fafafa', fontWeight: 600 }}>下注</td>
          {renderValueCell(baseSide === 'W' ? renderAmountBlock(base?.amount, base?.realAmount) : null, { winCover: baseSide === 'W' })}
          {renderValueCell(baseSide === 'D' ? renderAmountBlock(base?.amount, base?.realAmount) : null, { winCover: baseSide === 'D' })}
          {renderValueCell(baseSide === 'L' ? renderAmountBlock(base?.amount, base?.realAmount) : null, { winCover: baseSide === 'L' })}

          {renderValueCell(hedgeSide === 'W' ? renderAmountBlock(hedge?.amount, hedge?.realAmount) : null, { winCover: hedgeSide === 'W' })}
          {renderValueCell(null)}
          {renderValueCell(hedgeSide === 'L' ? renderAmountBlock(hedge?.amount, hedge?.realAmount) : null, { winCover: hedgeSide === 'L' })}
        </tr>

        <tr>
          <td style={{ border: '1px solid #d9d9d9', padding: '8px 10px', textAlign: 'center', background: '#fafafa', fontWeight: 600 }}>中奖</td>
          {( ['W','D','L'] as OutcomeSide[] ).map((side) => renderValueCell(baseCoverage[side] > EPS ? currency(baseCoverage[side]) : null, { winCover: baseCoverage[side] > EPS }))}
          {( ['W','D','L'] as OutcomeSide[] ).map((side) => renderValueCell(hedgeCoverage[side] > EPS ? currency(hedgeCoverage[side]) : null, { winCover: hedgeCoverage[side] > EPS }))}
        </tr>

        <tr>
          <td style={{ border: '1px solid #d9d9d9', padding: '8px 10px', textAlign: 'center', background: '#fafafa', fontWeight: 600 }}>利润</td>
          {( ['W','D','L'] as OutcomeSide[] ).map((side) => {
            const v = Number(strategy?.profits?.[sideToProfitKey(side)] || 0);
            return renderValueCell(baseCoverage[side] > EPS ? <span style={{ color: '#1677ff' }}>{signedCurrency(v)}</span> : null, {
              winCover: baseCoverage[side] > EPS,
            });
          })}
          {( ['W','D','L'] as OutcomeSide[] ).map((side) => {
            const v = Number(strategy?.profits?.[sideToProfitKey(side)] || 0);
            return renderValueCell(hedgeCoverage[side] > EPS ? <span style={{ color: '#1677ff' }}>{signedCurrency(v)}</span> : null, {
              winCover: hedgeCoverage[side] > EPS,
            });
          })}
        </tr>

        {index < matrixGroups.length - 1 ? (
          <tr>
            <td colSpan={7} style={{ border: 'none', height: 8, background: '#fff' }} />
          </tr>
        ) : null}
      </React.Fragment>
    );
  };

  if (!strategy) {
    return (
      <Card>
        <Empty description="暂无可用的 HG 对冲方案" />
      </Card>
    );
  }

  return (
    <div style={showTitle ? { maxWidth: 1320, margin: '0 auto' } : undefined}>
      {showTitle ? (
        <Title level={1} style={{ marginBottom: 20, fontSize: 32, lineHeight: 1.2 }}>
          {title}
        </Title>
      ) : null}

      <Card title="下注方案详情">
        <div style={{ overflowX: 'auto', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', width: 84 }} />
                <th colSpan={3} style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px' }}>{headerLeft}</th>
                <th colSpan={3} style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px' }}>{headerRight}</th>
              </tr>
              <tr>
                <th style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px' }} />
                {(['胜', '平', '负'] as const).map((t) => (
                  <th key={`std_${t}`} style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px' }}>{t}</th>
                ))}
                {(['胜', '平', '负'] as const).map((t) => (
                  <th key={`ah_${t}`} style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px' }}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>{matrixGroups.map((group, idx) => renderGroup(group, idx))}</tbody>
          </table>
        </div>

        <div style={{ marginTop: 20 }}>
          <Title level={3} style={{ marginBottom: 8 }}>
            预期收益分析 <Text type="secondary" style={{ fontSize: 14 }}>（展示主胜/平/客胜三种结果）</Text>
          </Title>
          <Row gutter={12}>
            {outcomeRows.map((r) => (
              <Col xs={24} md={12} lg={8} key={r.key} style={{ display: 'flex' }}>
                <Card size="small" style={{ borderColor: '#b7eb8f', background: '#f6ffed', width: '100%', height: '100%' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <div style={{ textAlign: 'center', marginBottom: 8 }}>
                      <Tag color={r.color}>{r.title}</Tag>
                    </div>
                    <div style={{ borderTop: '1px solid #e8e8e8', margin: '10px 0' }} />

                    {(r.details || []).map((d: any, idx: number) => (
                      <div key={`${r.key}_${idx}`} style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <Text style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.text}</Text>
                        <Text style={{ fontSize: 12, color: Number(d.amount || 0) > 0 ? '#389e0d' : '#389e0d', flexShrink: 0 }}>
                          {d.hit ? '中' : '不中'} {signedCurrency(d.amount)}
                        </Text>
                      </div>
                    ))}

                    {(r.details || []).length > 0 ? <div style={{ borderTop: '1px dashed #d9d9d9', margin: '8px 0' }} /> : null}

                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text>胜负收益:</Text>
                      <Text style={{ color: Number(r.match || 0) >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(r.match)}</Text>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text>返水收益:</Text>
                      <Text style={{ color: '#389e0d' }}>{signedCurrency(r.rebate)}</Text>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
                      <Text strong>总利润</Text>
                      <Text strong style={{ color: Number(r.total || 0) >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(r.total)}</Text>
                    </div>
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        </div>

        <Card size="small" style={{ marginTop: 16, background: '#f0f5ff', borderColor: '#d6e4ff' }}>
          <Space size={24} wrap>
            <Text strong>总投入: {currency(Number(strategy.user_invest || 0))}</Text>
            <Text strong style={{ color: '#1677ff' }}>实投总计: {currency(totalRealInvest)}</Text>
            <Tag color={Number(strategy.min_profit_rate || 0) > 0.05 ? 'red' : 'green'} style={{ fontWeight: 700 }}>
              最低利润率: {pct(Number(strategy.min_profit_rate || 0), 3)}
            </Tag>
          </Space>
        </Card>

        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          message="算法说明"
          description="HG 对冲按同一场比赛的皇冠胜平负作为基准注，再用皇冠让球进行覆盖；让球中奖返还按 本金 × 返还系数（全赢=1+赔率，走盘=1，输半=0.5，不中=0）计算。"
        />
      </Card>
    </div>
  );
};

export default HgPlanDetailContent;
