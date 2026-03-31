import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Radio, Row, Space, Table, Tag, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useParams, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import type { HedgeStrategy } from '../types';
import { invertHandicap, normalizeCrownTarget, parseCrownBetType, parseHandicap } from '../shared/oddsText';

const { Title, Text } = Typography;

type Side = 'W' | 'D' | 'L';
type Market = 'normal' | 'handicap';
type BaseType = 'jingcai' | 'crown';

const currency = (n: number) => `¥${Number(n || 0).toFixed(2)}`;
const signedCurrency = (n: number) => `${Number(n || 0) >= 0 ? '+' : '-'}¥${Math.abs(Number(n || 0)).toFixed(2)}`;
const rateHot = (r: number) => Number(r || 0) >= 0.005;

const formatJcSideLabel = (side: Side, market: Market, line: string) => {
  if (market === 'normal') {
    if (side === 'W') return '主胜';
    if (side === 'D') return '平';
    return '客胜';
  }
  if (side === 'W') return `主胜(${line})`;
  if (side === 'D') return `平(${line})`;
  return `客胜(${invertHandicap(line)})`;
};

const getCrownGrossReturn = (type: string, odds: number, amount: number, dg: number): number => {
  const o = Number(odds || 0);
  const a = Number(amount || 0);
  if (a <= 0 || o <= 0) return 0;

  const bet = parseCrownBetType(type);
  const side: Side = bet.side === 'home' ? 'W' : bet.side === 'draw' ? 'D' : 'L';

  if (bet.kind === 'std') {
    const hit = side === 'W' ? dg > 0 : side === 'D' ? dg === 0 : dg < 0;
    return hit ? a * o : 0;
  }

  if (side === 'D') {
    const score = Number(bet.handicap || 0) - Math.abs(dg);
    if (score >= 0.5) return a * (1 + o);
    if (score === 0.25) return a * (1 + o / 2);
    if (score === 0) return a;
    if (score === -0.25) return a * 0.5;
    return 0;
  }

  const score = side === 'W' ? dg + Number(bet.handicap || 0) : -dg + Number(bet.handicap || 0);
  if (score >= 0.5) return a * (1 + o);
  if (score === 0.25) return a * (1 + o / 2);
  if (score === 0) return a;
  if (score === -0.25) return a * 0.5;
  return 0;
};

const Calculator: React.FC = () => {
  const { message } = App.useApp();
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();
  const [form] = Form.useForm();

  const [loading, setLoading] = useState(false);
  const [matchInfo, setMatchInfo] = useState<any>(null);
  const [settingsShare, setSettingsShare] = useState({ jc: 0, crown: 0 });
  const [strategies, setStrategies] = useState<HedgeStrategy[]>([]);
  const [selected, setSelected] = useState<HedgeStrategy | null>(null);
  const [optionMeta, setOptionMeta] = useState<Record<string, { hasPlan: boolean; bestRate: number; list: HedgeStrategy[] }>>({});

  const initialBaseType = (searchParams.get('base_type') || 'jingcai') as BaseType;
  const initialUnit = 10000;

  const jcOptions = useMemo(() => {
    if (!matchInfo) return [];
    const line = String(matchInfo.jc_handicap || matchInfo.j_h || '0').trim() || '0';
    const list: Array<{ value: string; label: string; betLabel: string; side: Side; market: Market; odds: number }> = [
      { value: 'normal_W', label: `${formatJcSideLabel('W', 'normal', line)} ${matchInfo.j_w || '-'}`, betLabel: formatJcSideLabel('W', 'normal', line), side: 'W', market: 'normal', odds: Number(matchInfo.j_w || 0) },
      { value: 'normal_D', label: `${formatJcSideLabel('D', 'normal', line)} ${matchInfo.j_d || '-'}`, betLabel: formatJcSideLabel('D', 'normal', line), side: 'D', market: 'normal', odds: Number(matchInfo.j_d || 0) },
      { value: 'normal_L', label: `${formatJcSideLabel('L', 'normal', line)} ${matchInfo.j_l || '-'}`, betLabel: formatJcSideLabel('L', 'normal', line), side: 'L', market: 'normal', odds: Number(matchInfo.j_l || 0) },
    ];
    if (Number(matchInfo.j_hw || 0) > 1) list.push({ value: 'handicap_W', label: `${formatJcSideLabel('W', 'handicap', line)} ${matchInfo.j_hw}`, betLabel: formatJcSideLabel('W', 'handicap', line), side: 'W', market: 'handicap', odds: Number(matchInfo.j_hw || 0) });
    if (Number(matchInfo.j_hd || 0) > 1) list.push({ value: 'handicap_D', label: `${formatJcSideLabel('D', 'handicap', line)} ${matchInfo.j_hd}`, betLabel: formatJcSideLabel('D', 'handicap', line), side: 'D', market: 'handicap', odds: Number(matchInfo.j_hd || 0) });
    if (Number(matchInfo.j_hl || 0) > 1) list.push({ value: 'handicap_L', label: `${formatJcSideLabel('L', 'handicap', line)} ${matchInfo.j_hl}`, betLabel: formatJcSideLabel('L', 'handicap', line), side: 'L', market: 'handicap', odds: Number(matchInfo.j_hl || 0) });
    return list;
  }, [matchInfo]);

  const calculateSingle = async (pick: string, baseType: BaseType, integerUnit: number) => {
    if (!matchId || !pick) return [] as HedgeStrategy[];
    const [market, side] = String(pick).split('_') as [Market, Side];
    const res = await axios.post('/api/arbitrage/calculate', {
      match_id: matchId,
      jingcai_side: side,
      jingcai_market: market,
      jingcai_amount: integerUnit,
      base_type: baseType,
      integer_unit: integerUnit,
    });
    const list = (Array.isArray(res.data) ? res.data : []).filter((s: HedgeStrategy) => {
      return Number(s?.profits?.win || 0) > 0.01 && Number(s?.profits?.draw || 0) > 0.01 && Number(s?.profits?.lose || 0) > 0.01;
    });
    list.sort((a: HedgeStrategy, b: HedgeStrategy) => (b.min_profit_rate || 0) - (a.min_profit_rate || 0));
    return list;
  };

  const refreshAllOptions = async (baseType: BaseType, integerUnit: number) => {
    if (!matchId || jcOptions.length === 0) return;
    setLoading(true);
    try {
      const entries = await Promise.all(
        jcOptions.map(async (opt) => {
          try {
            const list = await calculateSingle(opt.value, baseType, integerUnit);
            return [opt.value, { hasPlan: list.length > 0, bestRate: Number(list[0]?.min_profit_rate || 0), list }] as const;
          } catch {
            return [opt.value, { hasPlan: false, bestRate: 0, list: [] as HedgeStrategy[] }] as const;
          }
        })
      );

      const meta = Object.fromEntries(entries);
      setOptionMeta(meta);

      const best = entries
        .filter(([, v]) => v.hasPlan)
        .sort((a, b) => b[1].bestRate - a[1].bestRate)[0];

      if (!best) {
        form.setFieldValue('jc_pick', undefined);
        setStrategies([]);
        setSelected(null);
        return;
      }

      const bestPick = best[0];
      const bestList = best[1].list;
      form.setFieldValue('jc_pick', bestPick);
      setStrategies(bestList);
      setSelected(bestList[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!matchId) return;
    (async () => {
      const [matchRes, settingRes] = await Promise.all([axios.get(`/api/matches/${matchId}`), axios.get('/api/settings')]);
      setMatchInfo(matchRes.data);
      setSettingsShare({
        jc: Number(settingRes.data?.default_jingcai_share || 0),
        crown: Number(settingRes.data?.default_crown_share || 0),
      });
      form.setFieldsValue({ base_type: initialBaseType, integer_unit: initialUnit });
    })().catch(() => {
      message.error('加载比赛信息失败');
    });
  }, [matchId]);

  useEffect(() => {
    if (!matchInfo || jcOptions.length === 0) return;
    const bt = (form.getFieldValue('base_type') || initialBaseType) as BaseType;
    const unit = Number(form.getFieldValue('integer_unit') || initialUnit);
    refreshAllOptions(bt, unit).catch(() => {});
  }, [matchInfo, jcOptions.length]);

  const handleValuesChange = async (
    changed: { jc_pick?: string; base_type?: BaseType; integer_unit?: number },
    all: { jc_pick?: string; base_type?: BaseType; integer_unit?: number }
  ) => {
    const baseType = (all.base_type || initialBaseType) as BaseType;
    const integerUnit = Number(all.integer_unit || initialUnit);

    if (changed.base_type !== undefined || changed.integer_unit !== undefined) {
      await refreshAllOptions(baseType, integerUnit);
      return;
    }

    if (!all.jc_pick) {
      await refreshAllOptions(baseType, integerUnit);
      return;
    }

    const list = await calculateSingle(all.jc_pick, baseType, integerUnit);
    setStrategies(list);
    setSelected(list[0] || null);
  };

  const selectedPick = Form.useWatch('jc_pick', form);

  const getJcAmount = (s: HedgeStrategy) => {
    const crown = (s.crown_bets || []).reduce((sum, b) => sum + Number(b.amount || 0), 0);
    return Math.max(0, Number(s.user_invest || 0) - crown);
  };

  const getCurrentJcOdds = (s: HedgeStrategy) => {
    const picked = jcOptions.find((x) => x.value === selectedPick);
    if (picked && picked.odds > 0) return picked.odds;
    return Number(s.jc_odds || 0);
  };

  const betRows = useMemo(() => {
    if (!selected) return [];
    const jcAmt = getJcAmount(selected);
    return [
      {
        key: 'jc',
        platform: '竞彩',
        target: jcOptions.find((x) => x.value === selectedPick)?.betLabel || '竞彩',
        odds: getCurrentJcOdds(selected),
        amount: jcAmt,
        share: settingsShare.jc,
        realAmount: jcAmt / Math.max(1 - settingsShare.jc, 0.0001),
      },
      ...((selected.crown_bets || []).map((b, i) => {
        const amt = Number(b.amount || 0);
        return {
          key: `c_${i}`,
          platform: '皇冠',
          target: normalizeCrownTarget(String(b.type || '')),
          odds: Number(b.odds || 0),
          amount: amt,
          share: settingsShare.crown,
          realAmount: amt / Math.max(1 - settingsShare.crown, 0.0001),
        };
      }) as any[]),
    ];
  }, [selected, settingsShare, selectedPick, jcOptions]);

  const realInvestTotal = useMemo(() => betRows.reduce((sum, row: any) => sum + Number(row.realAmount || 0), 0), [betRows]);

  const outcomeRows = useMemo(() => {
    if (!selected) return [] as any[];

    const picked = jcOptions.find((x) => x.value === selectedPick);
    const jcSide = (picked?.side || selected.jcSide || 'W') as Side;
    const jcMarket = (picked?.market || selected.jc_market || 'normal') as Market;
    const jcLine = String(matchInfo?.jc_handicap || matchInfo?.j_h || '0');
    const jcOdds = getCurrentJcOdds(selected);
    const crownBets = selected.crown_bets || [];
    const invest = Number(selected.user_invest || 0);

    const jcHit = (dg: number) => {
      if (jcMarket === 'normal') return jcSide === 'W' ? dg > 0 : jcSide === 'D' ? dg === 0 : dg < 0;
      const adjusted = dg + parseHandicap(jcLine);
      const outcome: Side = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
      return outcome === jcSide;
    };

    const buildRow = (key: 'win' | 'draw' | 'lose', dg: number, title: string, color: string) => {
      const jcStake = Number(getJcAmount(selected) || 0);
      const jcReturn = jcHit(dg) ? jcStake * Number(jcOdds || 0) : 0;

      const crownDetails = crownBets.map((b, idx) => {
        const amount = Number(b.amount || 0);
        const odds = Number(b.odds || 0);
        const ret = getCrownGrossReturn(String(b.type || ''), odds, amount, dg);
        return {
          key: `c_${idx}`,
          text: `皇冠：${normalizeCrownTarget(String(b.type || ''))}`,
          hit: ret > 0,
          amount: ret,
        };
      });

      const crownReturn = crownDetails.reduce((sum, x) => sum + Number(x.amount || 0), 0);
      const matchByDetails = jcReturn + crownReturn - invest;
      const rebateByKey =
        key === 'win' ? Number(selected.rebates?.win || 0) : key === 'draw' ? Number(selected.rebates?.draw || 0) : Number(selected.rebates?.lose || 0);
      const matchByStrategy =
        key === 'win'
          ? Number(selected.match_profits?.win || 0)
          : key === 'draw'
          ? Number(selected.match_profits?.draw || 0)
          : Number(selected.match_profits?.lose || 0);
      const totalByStrategy =
        key === 'win' ? Number(selected.profits?.win || 0) : key === 'draw' ? Number(selected.profits?.draw || 0) : Number(selected.profits?.lose || 0);

      const details = [
        {
          key: 'jc',
          text: `竞彩：${picked?.betLabel || '竞彩'}`,
          hit: jcReturn > 0,
          amount: jcReturn,
        },
        ...crownDetails,
      ];

      return {
        key,
        title,
        color,
        details,
        match: Number.isFinite(matchByStrategy) ? matchByStrategy : matchByDetails,
        rebate: Number.isFinite(rebateByKey) ? rebateByKey : Number(selected.rebate || 0),
        total: Number.isFinite(totalByStrategy) ? totalByStrategy : matchByDetails + rebateByKey,
      };
    };

    return [
      buildRow('win', 1, '主胜', 'blue'),
      buildRow('draw', 0, '平', 'gold'),
      buildRow('lose', -1, '客胜', 'red'),
    ];
  }, [selected, jcOptions, selectedPick, matchInfo]);

  const title = matchInfo ? `（单场）${matchInfo.home_team} vs ${matchInfo.away_team}` : '单场下注方案';

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <Title level={2} style={{ marginBottom: 16 }}>
        {title}
      </Title>

      <Row gutter={20}>
        <Col xs={24} lg={8}>
          <Card title="下注设置" style={{ marginBottom: 16 }} loading={loading}>
            <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
              <Form.Item name="jc_pick" label="竞彩选项">
                <Radio.Group className="solid-blue-radio" style={{ width: '100%', display: 'grid', gap: 8 }}>
                  {jcOptions.map((opt) => {
                    const disabled = optionMeta[opt.value]?.hasPlan === false;
                    return (
                      <Radio.Button
                        key={opt.value}
                        value={opt.value}
                        disabled={disabled}
                        style={{ width: '100%', textAlign: 'center', borderRadius: 8, ...(disabled ? { background: '#f5f5f5', color: '#999', borderColor: '#d9d9d9' } : {}) }}
                      >
                        {opt.label}
                      </Radio.Button>
                    );
                  })}
                </Radio.Group>
              </Form.Item>

              <Form.Item name="base_type" label="整数控制">
                <Radio.Group className="solid-blue-radio" style={{ width: '100%' }}>
                  <Radio.Button value="jingcai" style={{ width: '50%', textAlign: 'center' }}>
                    竞彩
                  </Radio.Button>
                  <Radio.Button value="crown" style={{ width: '50%', textAlign: 'center' }}>
                    皇冠
                  </Radio.Button>
                </Radio.Group>
              </Form.Item>

              <Form.Item name="integer_unit" label="投注单位">
                <Radio.Group className="solid-blue-radio" style={{ width: '100%' }}>
                  <Radio.Button value={1000} style={{ width: '33.33%', textAlign: 'center' }}>
                    1000
                  </Radio.Button>
                  <Radio.Button value={10000} style={{ width: '33.33%', textAlign: 'center' }}>
                    10000
                  </Radio.Button>
                  <Radio.Button value={100000} style={{ width: '33.33%', textAlign: 'center' }}>
                    100000
                  </Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Form>
          </Card>

          <Card title="对冲策略选择">
            <Space direction="vertical" style={{ width: '100%' }}>
              {(strategies || []).map((s, idx) => (
                <Button key={`${s.name}_${idx}`} className="solid-blue-btn" block type={selected?.name === s.name ? 'primary' : 'default'} onClick={() => setSelected(s)}>
                  方案{idx + 1} ({((s.min_profit_rate || 0) * 100).toFixed(2)}%)
                </Button>
              ))}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          {!selected ? (
            <Card>
              <Empty description="暂无可用的单场方案" />
            </Card>
          ) : (
            <Card title="下注方案详情">
              <Table
                dataSource={betRows}
                pagination={false}
                size="small"
                rowKey="key"
                columns={[
                  { title: '平台', dataIndex: 'platform', width: '20%' as const },
                  { title: '下注项', dataIndex: 'target', width: '20%' as const },
                  { title: '赔率', dataIndex: 'odds', width: '20%' as const, render: (v: number) => Number(v || 0).toFixed(2) },
                  { title: '占比', dataIndex: 'share', width: '20%' as const, render: (v: number) => `${(Number(v || 0) * 100).toFixed(1)}%` },
                  {
                    title: '下注金额',
                    dataIndex: 'amount',
                    width: '20%' as const,
                    render: (v: number, row: any) => (
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
                              <Text style={{ fontSize: 12, color: Number(d.amount || 0) >= 0 ? '#389e0d' : '#cf1322', flexShrink: 0 }}>
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
                            <Text strong>总利润:</Text>
                            <Text strong style={{ color: Number(r.total || 0) >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(r.total)}</Text>
                          </div>
                        </div>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </div>

              <Card size="small" style={{ marginTop: 16, background: '#f0f5ff', borderColor: '#d6e4ff' }}>
                <Space size={24}>
                  <Text strong>总投入: {currency(selected.user_invest)}</Text>
                  <Text strong style={{ color: '#1677ff' }}>实投总计: {currency(realInvestTotal)}</Text>
                  <Tag color={rateHot(selected.min_profit_rate) ? 'red' : 'green'} style={{ fontWeight: 700 }}>
                    最低利润率: {((selected.min_profit_rate || 0) * 100).toFixed(3)}%
                  </Tag>
                </Space>
              </Card>

              <Alert
                style={{ marginTop: 16 }}
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
                message="算法说明"
                description="单场卡片的总利润、最低利润率与后端引擎保持同口径；卡片中的每条下注展示的是该结果下的实际返还额（中为返还，不中为0）。"
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
};

export default Calculator;
