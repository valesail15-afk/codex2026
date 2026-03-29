import React, { useState, useEffect } from 'react';
import { Table, Card, Typography, Statistic, Row, Col, Tag, Space, Empty, Popconfirm, Button, App } from 'antd';
import { HistoryOutlined, PayCircleOutlined, RiseOutlined, DeleteOutlined } from '@ant-design/icons';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import axios from 'axios';

const { Title, Text } = Typography;

interface BetRecord {
  id: number;
  home_team: string;
  away_team: string;
  league: string;
  jingcai_side: string;
  jingcai_amount: number;
  total_invest: number;
  expected_profit: number;
  created_at: string;
}

const History: React.FC = () => {
  const { message } = App.useApp();
  const [records, setRecords] = useState<BetRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/history');
      setRecords(response.data);
    } catch (error) {
      console.error('Fetch records failed:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, []);

  const handleDelete = async (id: number) => {
    try {
      await axios.delete(`/api/history/${id}`);
      message.success('删除成功');
      fetchRecords();
    } catch (error) {
      console.error('Delete record failed:', error);
    }
  };

  const totalInvest = Array.isArray(records) ? records.reduce((sum, r) => sum + r.total_invest, 0) : 0;
  const totalProfit = Array.isArray(records) ? records.reduce((sum, r) => sum + r.expected_profit, 0) : 0;
  const avgRate = Array.isArray(records) && records.length > 0 ? (totalProfit / totalInvest) * 100 : 0;

  const chartData = Array.isArray(records) ? records.slice().reverse().map(r => ({
    name: new Date(r.created_at).toLocaleDateString(),
    profit: r.expected_profit
  })) : [];

  const columns = [
    { title: '日期', dataIndex: 'created_at', key: 'created_at', render: (date: string) => new Date(date).toLocaleString() },
    { title: '比赛', key: 'match', render: (record: BetRecord) => <Text strong>{record.home_team} vs {record.away_team}</Text> },
    { title: '联赛', dataIndex: 'league', key: 'league' },
    { title: '投入金额', dataIndex: 'total_invest', key: 'total_invest', render: (val: number) => `¥${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    { title: '预期利润', dataIndex: 'expected_profit', key: 'expected_profit', render: (val: number) => <Text type="success">¥{val.toFixed(2)}</Text> },
    { title: '利润率', key: 'rate', render: (record: BetRecord) => `${((record.expected_profit / record.total_invest) * 100).toFixed(2)}%` },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: BetRecord) => (
        <Popconfirm title="确定删除这条记录吗？" onConfirm={() => handleDelete(record.id)}>
          <Button type="link" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      )
    }
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <Title level={3} style={{ marginBottom: 24 }}>历史下注记录</Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card className="shadow-sm">
            <Statistic title="累计投入" value={totalInvest} precision={2} prefix={<PayCircleOutlined />} suffix="元" />
          </Card>
        </Col>
        <Col span={8}>
          <Card className="shadow-sm">
            <Statistic title="累计预期利润" value={totalProfit} precision={2} prefix={<RiseOutlined />} styles={{ content: { color: '#3f8600' } }} suffix="元" />
          </Card>
        </Col>
        <Col span={8}>
          <Card className="shadow-sm">
            <Statistic title="平均利润率" value={avgRate} precision={2} suffix="%" />
          </Card>
        </Col>
      </Row>

      <Card title="利润趋势图" style={{ marginBottom: 24 }} className="shadow-sm">
        <ResponsiveContainer width="100%" height={300} minWidth={320}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="profit" stroke="#1890ff" strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card title="详细记录列表" className="shadow-sm">
        <Table dataSource={Array.isArray(records) ? records : []} columns={columns} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />
      </Card>
    </div>
  );
};

export default History;
