import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Radio, Row, Space, Table, Tag, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useParams, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { HedgeStrategy } from '../types';

const { Title, Text } = Typography;

type Side = 'W' | 'D' | 'L';
type Market = 'normal' | 'handicap';
type BaseType = 'jingcai' | 'crown';

const currency = (n: number) => `¥${Number(n || 0).toFixed(2)}`;
const rateHot = (r: number) => Number(r || 0) >= 0.005;

const invertHandicap = (line: string) => {
  const s = String(line || '0').trim();
  if (!s) return '0';
  if (s.startsWith('+')) return `-${s.slice(1)}`;
  if (s.startsWith('-')) return `+${s.slice(1)}`;
  return `-${s}`;
};

const parseHandicap = (h: string): number => {
  const s = String(h || '').replace(/\s+/g, '');
  if (!s) return 0;
  if (!s.includes('/')) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const parts = s.split('/');
  const firstSign = parts[0].startsWith('-') ? '-' : parts[0].startsWith('+') ? '+' : '';
  const vals = parts
    .map((p, idx) => {
      if (idx === 0) return Number(p);
      if (p.startsWith('+') || p.startsWith('-')) return Number(p);
      if (firstSign) return Number(`${firstSign}${p}`);
      return Number(p);
    })
    .filter((x) => Number.isFinite(x));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

const normalizeCrownTarget = (raw: string) => {
  const t = String(raw || '').trim();
  if (!t) return t;
  if (t.includes('标准胜')) return '主胜';
  if (t.includes('标准平')) return '平';
  if (t.includes('标准负')) return '客胜';
  return t;
};

const getPushRefundRatio = (type: string, dg: number) => {
  const t = String(type || '').trim();
  if (t.includes('标准胜') || t.includes('标准平') || t.includes('标准负')) return 0;
  const m = t.match(/^(主胜|客胜)\(([^)]+)\)$/);
  if (!m) return 0;
  const isHome = m[1] === '主胜';
  const handicap = parseHandicap(m[2]);
  const score = isHome ? dg + handicap : -dg + handicap;
  if (score === 0) return 1;
  if (score === 0.25 || score === -0.25) return 0.5;
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
    const awayLine = invertHandicap(line);
    const list: Array<{ value: string; label: string; side: Side; market: Market; odds: number }> = [
      { value: 'normal_W', label: `主胜 (${matchInfo.j_w || '-'})`, side: 'W', market: 'normal', odds: Number(matchInfo.j_w || 0) },
      { value: 'normal_D', label: `平 (${matchInfo.j_d || '-'})`, side: 'D', market: 'normal', odds: Number(matchInfo.j_d || 0) },
      { value: 'normal_L', label: `客胜 (${matchInfo.j_l || '-'})`, side: 'L', market: 'normal', odds: Number(matchInfo.j_l || 0) },
    ];
    if (Number(matchInfo.j_hw || 0) > 1) list.push({ value: 'handicap_W', label: `${line}主胜 (${matchInfo.j_hw})`, side: 'W', market: 'handicap', odds: Number(matchInfo.j_hw || 0) });
    if (Number(matchInfo.j_hd || 0) > 1) list.push({ value: 'handicap_D', label: `${line}平 (${matchInfo.j_hd})`, side: 'D', market: 'handicap', odds: Number(matchInfo.j_hd || 0) });
    if (Number(matchInfo.j_hl || 0) > 1) list.push({ value: 'handicap_L', label: `${awayLine}客胜 (${matchInfo.j_hl})`, side: 'L', market: 'handicap', odds: Number(matchInfo.j_hl || 0) });
    return list;
  }, [matchInfo]);

  const calculateSingle = async (pick: string, baseType: BaseType, integerUnit: number) => {
    if (!matchId || !pick) return [];
    const [market, side] = String(pick).split('_') as [Market, Side];
    const res = await axios.post('/api/arbitrage/calculate', {
      match_id: matchId,
      jingcai_side: side,
      jingcai_market: market,
      jingcai_amount: integerUnit,
      base_type: baseType,
      integer_unit: integerUnit,
    });
    const list = (res.data || []).filter((s: HedgeStrategy) => s?.profits?.win > 0 && s?.profits?.draw > 0 && s?.profits?.lose > 0);
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

  const jcAmount = (s: HedgeStrategy) => {
    const crown = (s.crown_bets || []).reduce((sum, b) => sum + Number(b.amount || 0), 0);
    return Math.max(0, Number(s.user_invest || 0) - crown);
  };

  const currentJcOdds = (s: HedgeStrategy) => {
    const picked = jcOptions.find((x) => x.value === selectedPick);
    if (picked && picked.odds > 0) return picked.odds;
    return Number(s.jc_odds || 0);
  };

  const betRows = useMemo(() => {
    if (!selected) return [];
    const jcAmt = jcAmount(selected);
    return [
      {
        key: 'jc',
        platform: '竞彩',
        target: jcOptions.find((x) => x.value === selectedPick)?.label?.replace(/\s*\([\d.]+\)\s*$/, '') || '竞彩',
        amount: jcAmt,
        share: settingsShare.jc,
        realAmount: jcAmt / Math.max(1 - settingsShare.jc, 0.0001),
        odds: currentJcOdds(selected),
      },
      ...(selected.crown_bets || []).map((b, i) => {
        const amt = Number(b.amount || 0);
        return {
          key: `c_${i}`,
          platform: '皇冠',
          target: normalizeCrownTarget(b.type),
          amount: amt,
          share: settingsShare.crown,
          realAmount: amt / Math.max(1 - settingsShare.crown, 0.0001),
          odds: Number(b.odds || 0),
        };
      }),
    ];
  }, [selected, settingsShare, selectedPick, jcOptions]);

  const realInvestTotal = useMemo(() => betRows.reduce((sum, row: any) => sum + Number(row.realAmount || 0), 0), [betRows]);

  const outcomeRows = useMemo(() => {
    if (!selected) return [];
    const crownBets = selected.crown_bets || [];
    const calcPushRefund = (dg: number) =>
      crownBets.reduce((sum, b) => sum + Number(b.amount || 0) * getPushRefundRatio(String(b.type || ''), dg), 0);
    return [
      { key: 'win', title: '主队胜', profit: selected.profits.win, match: selected.match_profits.win, rebate: selected.rebates.win, pushRefund: calcPushRefund(1), tagColor: 'blue' },
      { key: 'draw', title: '平局', profit: selected.profits.draw, match: selected.match_profits.draw, rebate: selected.rebates.draw, pushRefund: calcPushRefund(0), tagColor: 'gold' },
      { key: 'lose', title: '客队胜', profit: selected.profits.lose, match: selected.match_profits.lose, rebate: selected.rebates.lose, pushRefund: calcPushRefund(-1), tagColor: 'red' },
    ];
  }, [selected]);

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
              <Form.Item name="jc_pick" label="竞彩">
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
              <Form.Item name="integer_unit" label="选择倍数">
                <Radio.Group className="solid-blue-radio" style={{ width: '100%' }}>
                  <Radio.Button value={1000} style={{ width: '33.33%', textAlign: 'center' }}>
                    一千
                  </Radio.Button>
                  <Radio.Button value={10000} style={{ width: '33.33%', textAlign: 'center' }}>
                    一万
                  </Radio.Button>
                  <Radio.Button value={100000} style={{ width: '33.33%', textAlign: 'center' }}>
                    十万
                  </Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Form>
          </Card>

          <Card title="对冲策略选择">
            <Space direction="vertical" style={{ width: '100%' }}>
              {(strategies || []).map((s, idx) => (
                <Button key={`${s.name}_${idx}`} className="solid-blue-btn" block type={selected?.name === s.name ? 'primary' : 'default'} onClick={() => setSelected(s)}>
                  {s.name} ({((s.min_profit_rate || 0) * 100).toFixed(2)}%)
                </Button>
              ))}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          {!selected ? (
            <Card>
              <Empty description="暂无可用的保底盈利方案" />
            </Card>
          ) : (
            <Card title="下注方案详情">
              <Table
                dataSource={betRows}
                pagination={false}
                size="small"
                rowKey="key"
                columns={[
                  { title: '平台', dataIndex: 'platform', width: '20%' as any },
                  { title: '下注项', dataIndex: 'target', width: '20%' as any },
                  { title: '赔率', dataIndex: 'odds', width: '20%' as any, render: (v: number) => Number(v || 0).toFixed(2) },
                  { title: '占比', dataIndex: 'share', width: '20%' as any, render: (v: number) => `${(Number(v || 0) * 100).toFixed(1)}%` },
                  {
                    title: '下注金额',
                    dataIndex: 'amount',
                    width: '20%' as any,
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
                  预期收益分析 <Text type="secondary" style={{ fontSize: 14 }}>（显示各结果下的最低保证利润）</Text>
                </Title>
                <Row gutter={12}>
                  {outcomeRows.map((r) => (
                    <Col span={8} key={r.key} style={{ display: 'flex' }}>
                      <Card size="small" style={{ borderColor: '#b7eb8f', background: '#f6ffed', width: '100%', height: '100%' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                          <div style={{ textAlign: 'center', marginBottom: 8 }}>
                            <Tag color={r.tagColor}>{r.title}</Tag>
                          </div>
                          <div style={{ textAlign: 'center', fontSize: 30, color: '#52c41a', fontWeight: 700 }}>
                            {currency(Number(realInvestTotal || 0) + Number(r.profit || 0))}
                          </div>
                          <div style={{ borderTop: '1px solid #e8e8e8', margin: '10px 0' }} />
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <Text>胜负收益:</Text>
                            <Text style={{ color: r.match >= 0 ? '#389e0d' : '#cf1322' }}>{currency(r.match)}</Text>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <Text>返水收益:</Text>
                            <Text style={{ color: '#389e0d' }}>{currency(r.rebate)}</Text>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', visibility: Number(r.pushRefund || 0) > 0.01 ? 'visible' : 'hidden' }}>
                            <Text>走水退回:</Text>
                            <Text style={{ color: '#389e0d' }}>{currency(r.pushRefund)}</Text>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
                            <Text strong>总利润:</Text>
                            <Text strong style={{ color: '#389e0d' }}>{currency(r.profit)}</Text>
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
                message="结算规则说明"
                description={
                  <div>
                    <div>走水规则：0、1、2 等整数盘口支持全额退款（走水），走水部分不计算返水。</div>
                    <div>复合盘口：如 0/0.5、0.5/1 等，按 50% 拆分结算，可能出现赢一半或输一半。</div>
                    <div>保守计算：分析结果按最差比分路径计算，确保任一结果下都是保底利润。</div>
                  </div>
                }
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
};

export default Calculator;
