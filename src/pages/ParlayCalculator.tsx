import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Radio, Row, Space, Table, Tag, Typography } from 'antd';
import { useParams, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import type { HedgeStrategy } from '../types';
import {
  normalizeCrownTarget,
  normalizeParlaySideLabel,
  parseCrownBetType,
  parseParlayRawSide,
  sideToLabel,
} from '../shared/oddsText';

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
};

type DetailLine = {
  text: string;
  hit: boolean;
  amount: number;
};

const currency = (n: number) => `¥${Number(n || 0).toFixed(2)}`;
const signedCurrency = (n: number) => `${Number(n || 0) >= 0 ? '+' : '-'}¥${Math.abs(Number(n || 0)).toFixed(2)}`;
const rateHot = (r: number) => Number(r || 0) >= 0.005;

const outcomeToGoalDiff = (actual: MatchOutcome) => (actual === 'W' ? 1 : actual === 'D' ? 0 : -1);

const calcGrossReturnByActual = (
  pick: { side: MatchOutcome; handicap?: number; isStandard: boolean },
  actual: MatchOutcome,
  amount: number,
  odds: number
) => {
  const a = Number(amount || 0);
  const o = Number(odds || 0);
  if (a <= 0 || o <= 0) return 0;

  if (pick.isStandard) return pick.side === actual ? a * o : 0;

  const dg = outcomeToGoalDiff(actual);
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

const parseCrownBetSide = (raw: string): { side: MatchOutcome; handicap?: number; isStandard: boolean } => {
  const parsed = parseCrownBetType(raw);
  const side: MatchOutcome = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
  return { side, handicap: parsed.handicap, isStandard: parsed.kind === 'std' };
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
  const [settingsShare, setSettingsShare] = useState({ jc: 0, crown: 0 });

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const detailRes = await axios.get(`/api/arbitrage/parlay-opportunities/${id}`, { params: { base_type: baseType } });
      const detail = detailRes.data;
      setRecord(detail);
      setSelected(detail?.best_strategy || null);

      const settingRes = await axios.get('/api/settings');
      setSettingsShare({
        jc: Number(settingRes.data?.default_jingcai_share || 0),
        crown: Number(settingRes.data?.default_crown_share || 0),
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

  const pageTitle = record
    ? `二串一：${record.home_team_1} vs ${record.away_team_1} × ${record.home_team_2} vs ${record.away_team_2}`
    : '二串一下注方案';

  const betRows = useMemo<BetRow[]>(() => {
    if (!selectedStrategy) return [];

    const crownAmount = (selectedStrategy.crown_bets || []).reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0);
    const jcAmount = Math.max(0, Number(selectedStrategy.user_invest || 0) - crownAmount);

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

    const odds1 = normalizedSingleOdd(Number(record?.odds_1 || 0), side1, 0);
    const odds2 = normalizedSingleOdd(Number(record?.odds_2 || 0), side2, 1);
    const combinedOdds = odds1 > 0 && odds2 > 0 ? odds1 * odds2 : Number(record?.combined_odds || 0);

    const jcTarget = `${normalizeParlaySideLabel(record?.side_1 || '-')} × ${normalizeParlaySideLabel(record?.side_2 || '-')}`;

    return [
      {
        key: 'jc',
        platform: '竞彩',
        target: jcTarget,
        odds: combinedOdds,
        oddsDisplay: odds1 > 0 && odds2 > 0 ? `${odds1.toFixed(2)}*${odds2.toFixed(2)}=${combinedOdds.toFixed(2)}` : '-',
        amount: jcAmount,
        share: settingsShare.jc,
        realAmount: jcAmount / Math.max(1 - settingsShare.jc, 0.0001),
      },
      ...((selectedStrategy.crown_bets || []).map((b: any, idx: number) => {
        const amount = Number(b.amount || 0);
        const matchLabel = Number(b.match_index) === 0 ? '第1场' : '第2场';
        return {
          key: `c_${idx}`,
          platform: '皇冠',
          target: `${matchLabel} ${normalizeCrownTarget(String(b.type || ''))}`,
          odds: Number(b.odds || 0),
          oddsDisplay: Number(b.odds || 0).toFixed(2),
          amount,
          share: settingsShare.crown,
          realAmount: amount / Math.max(1 - settingsShare.crown, 0.0001),
        };
      }) as BetRow[]),
    ];
  }, [selectedStrategy, record, settingsShare]);

  const realInvestTotal = useMemo(() => betRows.reduce((sum, row) => sum + Number(row.realAmount || 0), 0), [betRows]);

  const comboDetailMap = useMemo(() => {
    if (!selectedStrategy || !record) return {} as Record<string, DetailLine[]>;

    const crownBets = selectedStrategy.crown_bets || [];
    const jcAmount = Math.max(0, Number(selectedStrategy.user_invest || 0) - crownBets.reduce((sum: number, b: any) => sum + Number(b.amount || 0), 0));

    const side1Meta = parseParlayRawSide(String(record.side_1 || ''));
    const side2Meta = parseParlayRawSide(String(record.side_2 || ''));

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

    const jcOdds1 = normalizedSingleOdd(Number(record?.odds_1 || 0), side1Meta, 0);
    const jcOdds2 = normalizedSingleOdd(Number(record?.odds_2 || 0), side2Meta, 1);

    const settleBySide = (pick: { side: MatchOutcome; handicap?: number; isHandicap: boolean }, actual: MatchOutcome) => {
      if (!pick.isHandicap) return actual === pick.side;
      const dg = outcomeToGoalDiff(actual);
      const h = Number(pick.handicap || 0);
      const adjusted = dg + h;
      const outcome: MatchOutcome = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
      return outcome === pick.side;
    };

    const keys = ['w_w', 'w_d', 'w_l', 'd_w', 'd_d', 'd_l', 'l_w', 'l_d', 'l_l'];
    const map: Record<string, DetailLine[]> = {};

    for (const key of keys) {
      const [a, b] = key.split('_');
      const s1 = a.toUpperCase() as MatchOutcome;
      const s2 = b.toUpperCase() as MatchOutcome;

      const jcHit = settleBySide(side1Meta, s1) && settleBySide(side2Meta, s2);
      const jcAmountReturn = jcHit ? jcAmount * Math.max(jcOdds1 * jcOdds2, 0) : 0;
      const lines: DetailLine[] = [
        {
          text: `竞彩：${normalizeParlaySideLabel(record.side_1)} × ${normalizeParlaySideLabel(record.side_2)}`,
          hit: jcHit,
          amount: jcAmountReturn,
        },
      ];

      for (const bItem of crownBets) {
        const parsed = parseCrownBetSide(String(bItem.type || ''));
        const actualSide = Number(bItem.match_index) === 0 ? s1 : s2;
        const amount = Number(bItem.amount || 0);
        const odds = Number(bItem.odds || 0);
        const ret = calcGrossReturnByActual(parsed, actualSide, amount, odds);
        lines.push({
          text: `皇冠：第${Number(bItem.match_index) === 0 ? 1 : 2}场 ${normalizeCrownTarget(String(bItem.type || ''))}`,
          hit: ret > 0,
          amount: ret,
        });
      }

      map[key] = lines;
      map[key.toUpperCase()] = lines;
    }

    return map;
  }, [selectedStrategy, record]);

  const outcomeRows = useMemo(() => {
    if (!selectedStrategy) return [] as any[];

    const comboKeys = ['w_w', 'w_d', 'w_l', 'd_w', 'd_d', 'd_l', 'l_w', 'l_d', 'l_l'];
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

    const rebateByKey: Record<string, number> = {};
    if (Array.isArray(selectedStrategy.parlay_combo_details)) {
      selectedStrategy.parlay_combo_details.forEach((item) => {
        const k = String(item.key || '').toLowerCase();
        rebateByKey[k] = Number(item.rebate || 0);
      });
    }

    const userInvest = Number(selectedStrategy.user_invest || 0);
    const defaultRebate = Number(selectedStrategy.rebate || selectedStrategy.rebates?.win || 0);

    return comboKeys.map((key) => {
      const details = comboDetailMap[key] || comboDetailMap[key.toUpperCase()] || [];
      const match = details.reduce((sum, detail) => sum + Number(detail.amount || 0), 0);
      const rebate = rebateByKey[key] ?? defaultRebate;
      const total = match + rebate - userInvest;
      return {
        key,
        title: titleMap[key],
        details,
        match,
        rebate,
        total,
      };
    });
  }, [selectedStrategy, comboDetailMap]);

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
                  { title: '平台', dataIndex: 'platform', width: '18%' as const },
                  { title: '下注项', dataIndex: 'target', width: '30%' as const },
                  {
                    title: '赔率',
                    dataIndex: 'odds',
                    width: '20%' as const,
                    render: (_: number, row: BetRow) => String(row.oddsDisplay || Number(row.odds || 0).toFixed(2)),
                  },
                  {
                    title: '占比',
                    dataIndex: 'share',
                    width: '12%' as const,
                    render: (v: number) => `${(Number(v || 0) * 100).toFixed(1)}%`,
                  },
                  {
                    title: '下注金额',
                    dataIndex: 'amount',
                    width: '20%' as const,
                    render: (v: number, row: BetRow) => (
                      <Space direction="vertical" size={0}>
                        <Text strong>{currency(v)}</Text>
                        <Text style={{ color: Number(row.share || 0) > 0 ? '#1677ff' : '#999' }}>实投: {currency(row.realAmount)}</Text>
                      </Space>
                    ),
                  },
                ]}
                tableLayout="fixed"
              />

              <div style={{ marginTop: 20 }}>
                <Title level={3} style={{ marginBottom: 8 }}>
                  预期收益分析 <Text type="secondary" style={{ fontSize: 14 }}>（展示两场比赛胜平负 3×3 全组合）</Text>
                </Title>
                <Row gutter={12}>
                  {outcomeRows.map((row) => (
                    <Col xs={24} md={12} lg={8} key={row.key} style={{ display: 'flex' }}>
                      <Card size="small" style={{ borderColor: '#b7eb8f', background: '#f6ffed', width: '100%', height: '100%' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
                          <div style={{ textAlign: 'center' }}>
                            <Tag color={row.total >= 0 ? 'green' : 'red'}>{row.title}</Tag>
                          </div>

                          <div style={{ borderTop: '1px solid #e8e8e8' }} />

                          {(row.details || []).map((detail: DetailLine, idx: number) => (
                            <div
                              key={`${row.key}_${idx}`}
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                            >
                              <Text style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail.text}</Text>
                              <Text style={{ fontSize: 12, color: '#389e0d', flexShrink: 0 }}>
                                {detail.hit ? '中' : '不中'} {signedCurrency(detail.amount)}
                              </Text>
                            </div>
                          ))}

                          {(row.details || []).length > 0 ? <div style={{ borderTop: '1px dashed #d9d9d9' }} /> : null}

                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <Text>胜负收益:</Text>
                            <Text style={{ color: row.match >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(row.match)}</Text>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <Text>返水收益:</Text>
                            <Text style={{ color: row.rebate >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(row.rebate)}</Text>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
                            <Text strong>总利润:</Text>
                            <Text strong style={{ color: row.total >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(row.total)}</Text>
                          </div>
                        </div>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </div>

              <Card size="small" style={{ marginTop: 16, background: '#f0f5ff', borderColor: '#d6e4ff' }}>
                <Space size={24}>
                  <Text strong>总投入: {currency(selectedStrategy.user_invest || 0)}</Text>
                  <Text strong style={{ color: '#1677ff' }}>实投总计: {currency(realInvestTotal)}</Text>
                  <Tag color={rateHot(selectedRate) ? 'red' : 'green'} style={{ fontWeight: 700 }}>
                    最低利润率: {(selectedRate * 100).toFixed(3)}%
                  </Tag>
                </Space>
              </Card>

              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                message="算法说明"
                description={`当前展示为两场胜平负 3×3 全组合，并逐条展示下注项在每种结果下的中/不中及对应收益。默认胜平负映射：${sideToLabel(
                  'W'
                )}=${sideToLabel('W')}，${sideToLabel('D')}=${sideToLabel('D')}，${sideToLabel('L')}=${sideToLabel('L')}。`}
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
};

export default ParlayCalculator;
