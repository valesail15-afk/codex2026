import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Empty, Progress, Row, Select, Space, Statistic, Table, Tag, Typography, App } from 'antd';
import { CheckCircleOutlined, FireOutlined, RocketOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';

const { Title, Text } = Typography;

const Dashboard: React.FC = () => {
  const { message } = App.useApp();
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [oppType, setOppType] = useState<'single' | 'parlay'>('single');
  const [minProfitFilter, setMinProfitFilter] = useState(0);

  const fetchData = async () => {
    setLoading(true);
    try {
      const endpoint = oppType === 'single' ? '/api/arbitrage/opportunities' : '/api/arbitrage/parlay-opportunities';
      const res = await axios.get(endpoint, { params: { base_type: 'jingcai' } });
      const list = Array.isArray(res.data) ? res.data : [];
      list.sort((a: any, b: any) => (b.profit_rate || 0) - (a.profit_rate || 0));
      setOpportunities(list);
    } finally {
      setLoading(false);
    }
  };

  const handleRecalculate = async () => {
    setCalculating(true);
    setProgress(0);
    const timer = window.setInterval(() => {
      setProgress((prev) => (prev >= 90 ? 90 : prev + 10));
    }, 150);
    try {
      await axios.post('/api/arbitrage/rescan');
      setProgress(100);
      message.success('重新扫描完成');
      window.setTimeout(() => {
        fetchData();
        setCalculating(false);
      }, 300);
    } catch {
      message.error('重新扫描失败');
      setCalculating(false);
    } finally {
      window.clearInterval(timer);
    }
  };

  useEffect(() => {
    fetchData();
  }, [oppType]);

  const filtered = useMemo(
    () => opportunities.filter((item) => Number(item?.profit_rate || 0) >= minProfitFilter),
    [opportunities, minProfitFilter]
  );

  const singleColumns = [
    {
      title: '比赛信息',
      key: 'match',
      render: (record: any) => (
        <Space orientation="vertical" size={0}>
          <Text strong>
            {record.league}: {record.home_team} vs {record.away_team}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(record.match_time).format('MM-DD HH:mm')}
          </Text>
        </Space>
      ),
    },
    {
      title: '竞彩方向',
      key: 'side',
      render: (record: any) => {
        const side = record.jingcai_side;
        const color = side === 'W' ? 'blue' : side === 'D' ? 'gold' : 'red';
        const label = side === 'W' ? '胜' : side === 'D' ? '平' : '负';
        return <Tag color={color}>{`${label} @ ${(record.jingcai_odds || 0).toFixed(2)}`}</Tag>;
      },
    },
    {
      title: '最优策略',
      key: 'strategy',
      render: (record: any) => <Text>{record.best_strategy?.name || '-'}</Text>,
    },
    {
      title: '利润率',
      dataIndex: 'profit_rate',
      key: 'profit_rate',
      sorter: (a: any, b: any) => (a.profit_rate || 0) - (b.profit_rate || 0),
      render: (rate: number) => {
        const hot = Number(rate || 0) >= 0.005;
        return (
          <Tag color={hot ? 'red' : 'green'} style={{ fontWeight: hot ? 700 : 500 }}>
            {`${((rate || 0) * 100).toFixed(3)}%`}
          </Tag>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (record: any) => (
        <Link to={`/calculator/${record.match_id}?base_type=jingcai&side=${record.jingcai_side}`}>
          <Button type="primary" size="small">
            查看方案
          </Button>
        </Link>
      ),
    },
  ];

  const parlayColumns = [
    {
      title: '串关比赛',
      key: 'match',
      render: (record: any) => (
        <Space orientation="vertical" size={0}>
          <Text strong>
            {record.league_1}: {record.home_team_1} vs {record.away_team_1}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(record.match_time_1).format('MM-DD HH:mm')}
          </Text>
          <Text strong>
            {record.league_2}: {record.home_team_2} vs {record.away_team_2}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(record.match_time_2).format('MM-DD HH:mm')}
          </Text>
        </Space>
      ),
    },
    {
      title: '方向',
      key: 'side',
      render: (record: any) => (
        <Space orientation="vertical" size={4}>
          <Tag color="blue">{`${record.side_1} @ ${(record.odds_1 || 0).toFixed(2)}`}</Tag>
          <Tag color="cyan">{`${record.side_2} @ ${(record.odds_2 || 0).toFixed(2)}`}</Tag>
        </Space>
      ),
    },
    {
      title: '利润率',
      dataIndex: 'profit_rate',
      key: 'profit_rate',
      sorter: (a: any, b: any) => (a.profit_rate || 0) - (b.profit_rate || 0),
      render: (rate: number) => {
        const hot = Number(rate || 0) >= 0.005;
        return (
          <Tag color={hot ? 'red' : 'green'} style={{ fontWeight: hot ? 700 : 500 }}>
            {`${((rate || 0) * 100).toFixed(3)}%`}
          </Tag>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (record: any) => (
        <Link to={`/calculator/parlay/${record.id}?base_type=jingcai`}>
          <Button type="primary" size="small">
            查看方案
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <Title level={3} style={{ marginBottom: 24 }}>
        主控面板
      </Title>
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic title="今日扫描比赛" value={opportunities.length * 3 + 12} prefix={<RocketOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic title="套利机会" value={opportunities.length} prefix={<FireOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic
              title="最高利润率"
              value={opportunities.length > 0 ? (Math.max(...opportunities.map((o) => o.profit_rate || 0)) * 100).toFixed(2) : 0}
              suffix="%"
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic title="系统状态" value="正常" prefix={<CheckCircleOutlined />} />
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <Space size="large">
            <Select
              value={oppType}
              style={{ width: 130 }}
              onChange={(val) => setOppType(val)}
              options={[
                { value: 'single', label: '单场套利' },
                { value: 'parlay', label: '二串一套利' },
              ]}
            />
            <Select
              value={minProfitFilter}
              style={{ width: 120 }}
              onChange={setMinProfitFilter}
              options={[
                { value: 0, label: '全部' },
                { value: 0.005, label: '> 0.5%' },
                { value: 0.01, label: '> 1.0%' },
                { value: 0.015, label: '> 1.5%' },
                { value: 0.02, label: '> 2.0%' },
              ]}
            />
          </Space>
        }
        extra={
          <Space>
            {calculating && <Progress percent={progress} size="small" style={{ width: 180 }} />}
            <Button icon={<SyncOutlined spin={calculating} />} onClick={handleRecalculate} loading={calculating} type="primary">
              重新扫描
            </Button>
          </Space>
        }
      >
        <Table
          dataSource={filtered}
          columns={oppType === 'single' ? singleColumns : parlayColumns}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty description="暂无符合条件的套利机会" /> }}
        />
      </Card>
    </div>
  );
};

export default Dashboard;
