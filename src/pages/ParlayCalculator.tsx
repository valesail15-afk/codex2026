import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Radio, Row, Space, Table, Tag, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useParams, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { HedgeStrategy } from '../types';

const { Title, Text } = Typography;
const currency = (n: number) => `¥${Number(n || 0).toFixed(2)}`;
const rateHot = (r: number) => Number(r || 0) >= 0.005;

const normalizeCrownTarget = (raw: string) => {
  const t = String(raw || '').trim();
  if (!t) return t;
  if (t.includes('标准胜')) return '主胜';
  if (t.includes('标准平')) return '平';
  if (t.includes('标准负')) return '客胜';
  return t;
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
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id, baseType]);

  const selectedRate = Number(selected?.min_profit_rate || record?.profit_rate || 0);
  const selectedStrategy = selected || record?.best_strategy || null;

  const title = record
    ? `（二串一）${record.home_team_1} vs ${record.away_team_1} × ${record.home_team_2} vs ${record.away_team_2}`
    : '二串一下注方案';

  const betRows = useMemo(() => {
    if (!selectedStrategy) return [];
    const jcAmount = Math.max(
      0,
      Number(selectedStrategy.user_invest || 0) - (selectedStrategy.crown_bets || []).reduce((s: number, b: any) => s + Number(b.amount || 0), 0)
    );
    return [
      {
        key: 'jc',
        platform: '竞彩',
        target: `${record?.side_1 || '-'} × ${record?.side_2 || '-'}`,
        odds: Number(record?.combined_odds || 0),
        amount: jcAmount,
        share: settingsShare.jc,
        realAmount: jcAmount / Math.max(1 - settingsShare.jc, 0.0001),
      },
      ...((selectedStrategy.crown_bets || []).map((b: any, idx: number) => {
        const amount = Number(b.amount || 0);
        const matchLabel = b.match_index === 1 ? '第2场' : '第1场';
        return {
          key: `c_${idx}`,
          platform: '皇冠',
          target: `${matchLabel} ${normalizeCrownTarget(String(b.type || ''))}`,
          odds: Number(b.odds || 0),
          amount,
          share: settingsShare.crown,
          realAmount: amount / Math.max(1 - settingsShare.crown, 0.0001),
        };
      }) as any[]),
    ];
  }, [selectedStrategy, record, settingsShare]);

  const realInvestTotal = useMemo(() => betRows.reduce((sum, row: any) => sum + Number(row.realAmount || 0), 0), [betRows]);

  const outcomeRows = useMemo(() => {
    if (!selectedStrategy) return [];
    const details = selectedStrategy.parlay_outcome_details;
    if (details) {
      return [
        { key: 'm1_win', title: '第一场主胜', total: details.match1.win, match: details.match1.win - selectedStrategy.rebates.win, rebate: selectedStrategy.rebates.win, color: 'blue' },
        { key: 'm1_draw', title: '第一场平局', total: details.match1.draw, match: details.match1.draw - selectedStrategy.rebates.draw, rebate: selectedStrategy.rebates.draw, color: 'gold' },
        { key: 'm1_lose', title: '第一场客胜', total: details.match1.lose, match: details.match1.lose - selectedStrategy.rebates.lose, rebate: selectedStrategy.rebates.lose, color: 'red' },
        { key: 'm2_win', title: '第二场主胜', total: details.match2.win, match: details.match2.win - selectedStrategy.rebates.win, rebate: selectedStrategy.rebates.win, color: 'blue' },
        { key: 'm2_draw', title: '第二场平局', total: details.match2.draw, match: details.match2.draw - selectedStrategy.rebates.draw, rebate: selectedStrategy.rebates.draw, color: 'gold' },
        { key: 'm2_lose', title: '第二场客胜', total: details.match2.lose, match: details.match2.lose - selectedStrategy.rebates.lose, rebate: selectedStrategy.rebates.lose, color: 'red' },
      ];
    }
    return [
      { key: 'm1_win_fallback', title: '第一场主胜', total: selectedStrategy.profits.win, match: selectedStrategy.match_profits.win, rebate: selectedStrategy.rebates.win, color: 'blue' },
      { key: 'm1_draw_fallback', title: '第一场平局', total: selectedStrategy.profits.draw, match: selectedStrategy.match_profits.draw, rebate: selectedStrategy.rebates.draw, color: 'gold' },
      { key: 'm1_lose_fallback', title: '第一场客胜', total: selectedStrategy.profits.lose, match: selectedStrategy.match_profits.lose, rebate: selectedStrategy.rebates.lose, color: 'red' },
      { key: 'm2_win_fallback', title: '第二场主胜', total: selectedStrategy.profits.win, match: selectedStrategy.match_profits.win, rebate: selectedStrategy.rebates.win, color: 'blue' },
      { key: 'm2_draw_fallback', title: '第二场平局', total: selectedStrategy.profits.draw, match: selectedStrategy.match_profits.draw, rebate: selectedStrategy.rebates.draw, color: 'gold' },
      { key: 'm2_lose_fallback', title: '第二场客胜', total: selectedStrategy.profits.lose, match: selectedStrategy.match_profits.lose, rebate: selectedStrategy.rebates.lose, color: 'red' },
    ];
  }, [selectedStrategy]);

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto' }}>
      <Title level={2} style={{ marginBottom: 16 }}>
        {title}
      </Title>
      <Row gutter={20}>
        <Col xs={24} lg={8}>
          <Card title="下注设置" style={{ marginBottom: 16 }} loading={loading}>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">二串一方向</Text>
              <div style={{ marginTop: 6 }}>
                <Tag color="blue">{record?.side_1 || '-'}</Tag>
                <Tag color="cyan">{record?.side_2 || '-'}</Tag>
              </div>
            </div>
            <div>
              <Text type="secondary">整数控制</Text>
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
                <Button key={`${item.id}_${idx}`} className="solid-blue-btn" block type={(selectedStrategy?.name || '') === (item.best_strategy?.name || '') ? 'primary' : 'default'} onClick={() => setSelected(item.best_strategy)}>
                  {(item.best_strategy?.name || '策略')} ({((item.profit_rate || 0) * 100).toFixed(2)}%)
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
                            <Tag color={r.color}>{r.title}</Tag>
                          </div>
                          <div style={{ textAlign: 'center', fontSize: 30, color: '#52c41a', fontWeight: 700 }}>
                            {currency(Number(realInvestTotal || 0) + Number(r.total || 0))}
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
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
                            <Text strong>总利润:</Text>
                            <Text strong style={{ color: '#389e0d' }}>{currency(r.total)}</Text>
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
                icon={<InfoCircleOutlined />}
                message="结算规则说明"
                description={
                  <div>
                    <div>二串一结算以两场组合结果为基础，任一场偏离目标方向将触发皇冠对冲单承担风险。</div>
                    <div>亚盘按走水/赢半/输半规则拆分结算，系统按最差结算路径计算保底利润。</div>
                    <div>最终方案已将返水与分成纳入计算，确保展示利润与策略计算一致。</div>
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

export default ParlayCalculator;
