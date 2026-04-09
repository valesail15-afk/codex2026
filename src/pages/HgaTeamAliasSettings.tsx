import React, { useEffect, useState } from 'react';
import { App, Button, Card, Col, Divider, Form, Input, InputNumber, Row, Space, Table, Tag, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CloseOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const { Title, Text } = Typography;

type HgaAliasRow = {
  trade500_name: string;
  hga_name: string;
};

type HgaAliasSuggestion = {
  trade500_name: string;
  hga_name: string;
  source?: string;
  match_id?: string;
  match_time?: string;
  created_at?: string;
  match_count?: number;
};

function parseHgaAliasMap(raw: unknown): HgaAliasRow[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([trade500_name, hga_name]) => ({
      trade500_name: String(trade500_name || '').trim(),
      hga_name: String(hga_name || '').trim(),
    }));
  } catch {
    return [];
  }
}

function buildHgaAliasMap(rows: HgaAliasRow[] = []) {
  return rows.reduce<Record<string, string>>((acc, row) => {
    const trade500Name = String(row?.trade500_name || '').trim();
    const hgaName = String(row?.hga_name || '').trim();
    if (!trade500Name || !hgaName) return acc;
    acc[trade500Name] = hgaName;
    return acc;
  }, {});
}

function parseHgaAliasSuggestions(raw: unknown): HgaAliasSuggestion[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        trade500_name: String(item?.trade500_name || '').trim(),
        hga_name: String(item?.hga_name || '').trim(),
        source: String(item?.source || '').trim(),
        match_id: String(item?.match_id || '').trim(),
        match_time: String(item?.match_time || '').trim(),
        created_at: String(item?.created_at || '').trim(),
        match_count: Number(item?.match_count || 0) || 0,
      }))
      .filter((item) => item.trade500_name && item.hga_name);
  } catch {
    return [];
  }
}

const HgaTeamAliasSettings: React.FC = () => {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [defaultRows, setDefaultRows] = useState<HgaAliasRow[]>([]);
  const [pendingSuggestions, setPendingSuggestions] = useState<HgaAliasSuggestion[]>([]);

  const refreshSettings = async () => {
    const res = await axios.get('/api/settings');
    const data = { ...res.data };
    form.setFieldsValue({
      hga_team_alias_rows: parseHgaAliasMap(data.hga_team_alias_map),
      hga_team_alias_auto_apply_threshold: Number(data.hga_team_alias_auto_apply_threshold || 3),
    });
    setDefaultRows(parseHgaAliasMap(data.hga_team_alias_map_default));
    setPendingSuggestions(parseHgaAliasSuggestions(data.hga_team_alias_pending_suggestions));
  };

  useEffect(() => {
    refreshSettings().catch(() => {
      message.error('加载 HGA 球队映射失败');
    });
  }, [form, message]);

  const onSave = async (values: { hga_team_alias_rows?: HgaAliasRow[]; hga_team_alias_auto_apply_threshold?: number }) => {
    setLoading(true);
    try {
      const payload = {
        hga_team_alias_map: JSON.stringify(buildHgaAliasMap(values.hga_team_alias_rows || []), null, 2),
        hga_team_alias_auto_apply_threshold: Math.max(1, Math.min(10, Number(values.hga_team_alias_auto_apply_threshold || 3))),
      };
      await axios.post('/api/settings', payload);
      await refreshSettings();
      message.success('HGA 球队映射已保存');
    } catch {
      message.error('保存 HGA 球队映射失败');
    } finally {
      setLoading(false);
    }
  };

  const onResetDefault = () => {
    form.setFieldValue('hga_team_alias_rows', defaultRows);
    message.success('已恢复为文件默认映射');
  };

  const onApplySuggestion = async (row: HgaAliasSuggestion) => {
    setLoading(true);
    try {
      await axios.post('/api/settings/hga/alias-suggestions/apply', row);
      await refreshSettings();
      message.success('已将建议加入球队别名映射');
    } catch {
      message.error('应用映射建议失败');
    } finally {
      setLoading(false);
    }
  };

  const onDismissSuggestion = async (row: HgaAliasSuggestion) => {
    setLoading(true);
    try {
      await axios.post('/api/settings/hga/alias-suggestions/dismiss', row);
      await refreshSettings();
      message.success('已忽略该映射建议');
    } catch {
      message.error('忽略映射建议失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space direction="vertical" size={4}>
            <Button type="link" icon={<ArrowLeftOutlined />} style={{ paddingInline: 0 }} onClick={() => navigate('/settings')}>
              返回系统设置
            </Button>
            <Title level={3} style={{ margin: 0 }}>
              HGA 球队别名映射
            </Title>
            <Text type="secondary">这里维护 Trade500 与 HGA 的球队别名。匹配成功的兜底建议也会汇总到本页。</Text>
          </Space>
        </Space>

        <Card className="shadow-sm">
          <Form form={form} layout="vertical" onFinish={onSave}>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item
                  label="自动加入阈值"
                  name="hga_team_alias_auto_apply_threshold"
                  extra="同一组 Trade500/HGA 队名被“时间 + 欧赔”兜底命中达到该次数后，会自动加入正式映射。"
                >
                  <InputNumber min={1} max={10} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item extra="左侧填写 Trade500 队名，右侧填写 HGA 对应队名。当前匹配逻辑会按双向等价别名处理。">
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
                <Row gutter={0} style={{ background: '#fafafa', padding: '12px 16px', fontWeight: 600 }}>
                  <Col span={11}>Trade500</Col>
                  <Col span={11}>HGA</Col>
                  <Col span={2} style={{ textAlign: 'right' }}>
                    操作
                  </Col>
                </Row>
                <div style={{ padding: 16 }}>
                  <Form.List
                    name="hga_team_alias_rows"
                    rules={[
                      {
                        validator: async (_, rows: HgaAliasRow[] = []) => {
                          const invalidRow = rows.find((row) => {
                            const left = String(row?.trade500_name || '').trim();
                            const right = String(row?.hga_name || '').trim();
                            return (left && !right) || (!left && right);
                          });
                          if (invalidRow) throw new Error('映射行需要同时填写 Trade500 和 HGA 队名');
                        },
                      },
                    ]}
                  >
                    {(fields, { add, remove }, { errors }) => (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        {fields.map((field) => (
                          <Row gutter={12} key={field.key} align="middle">
                            <Col span={11}>
                              <Form.Item {...field} name={[field.name, 'trade500_name']} style={{ marginBottom: 0 }}>
                                <Input placeholder="Trade500 队名" />
                              </Form.Item>
                            </Col>
                            <Col span={11}>
                              <Form.Item {...field} name={[field.name, 'hga_name']} style={{ marginBottom: 0 }}>
                                <Input placeholder="HGA 队名" />
                              </Form.Item>
                            </Col>
                            <Col span={2} style={{ textAlign: 'right' }}>
                              <Button danger type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} />
                            </Col>
                          </Row>
                        ))}
                        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ trade500_name: '', hga_name: '' })}>
                          添加映射
                        </Button>
                        <Form.ErrorList errors={errors} />
                      </Space>
                    )}
                  </Form.List>
                </div>
              </div>
            </Form.Item>

            <Divider />

            <Space style={{ justifyContent: 'space-between', width: '100%' }}>
              <Button icon={<ReloadOutlined />} onClick={onResetDefault} disabled={defaultRows.length === 0}>
                恢复默认映射
              </Button>
              <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={loading}>
                保存映射
              </Button>
            </Space>
          </Form>
        </Card>

        <Card title={`待确认映射建议（${pendingSuggestions.length}）`} extra={<Text type="secondary">来自时间 + 欧赔兜底命中的保守建议</Text>}>
          <Table<HgaAliasSuggestion>
            rowKey={(row) => `${row.trade500_name}-${row.hga_name}`}
            pagination={false}
            locale={{ emptyText: '当前没有待确认的自动映射建议' }}
            dataSource={pendingSuggestions}
            columns={[
              {
                title: 'Trade500',
                dataIndex: 'trade500_name',
                key: 'trade500_name',
              },
              {
                title: 'HGA',
                dataIndex: 'hga_name',
                key: 'hga_name',
              },
              {
                title: '命中次数',
                dataIndex: 'match_count',
                key: 'match_count',
                width: 100,
              },
              {
                title: '来源',
                key: 'source',
                render: () => <Tag color="blue">时间+欧赔兜底</Tag>,
              },
              {
                title: '最近命中比赛',
                key: 'match',
                render: (_, row) => (
                  <Space direction="vertical" size={0}>
                    <Text>{row.match_id || '-'}</Text>
                    <Text type="secondary">{row.match_time || '-'}</Text>
                  </Space>
                ),
              },
              {
                title: '操作',
                key: 'action',
                render: (_, row) => (
                  <Space>
                    <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => onApplySuggestion(row)} loading={loading}>
                      加入映射
                    </Button>
                    <Button size="small" icon={<CloseOutlined />} onClick={() => onDismissSuggestion(row)} loading={loading}>
                      忽略
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Space>
    </div>
  );
};

export default HgaTeamAliasSettings;
