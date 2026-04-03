import React, { useEffect, useState } from 'react';
import { App, Button, Card, Col, Divider, Form, Input, Row, Space, Typography } from 'antd';
import { ArrowLeftOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const { Title, Text } = Typography;

type HgaAliasRow = {
  trade500_name: string;
  hga_name: string;
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

const HgaTeamAliasSettings: React.FC = () => {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [defaultRows, setDefaultRows] = useState<HgaAliasRow[]>([]);

  useEffect(() => {
    const fetchSettings = async () => {
      const res = await axios.get('/api/settings');
      const data = { ...res.data };
      form.setFieldsValue({
        hga_team_alias_rows: parseHgaAliasMap(data.hga_team_alias_map),
      });
      setDefaultRows(parseHgaAliasMap(data.hga_team_alias_map_default));
    };
    fetchSettings().catch(() => {
      message.error('加载 HGA 球队映射失败');
    });
  }, [form, message]);

  const onSave = async (values: { hga_team_alias_rows?: HgaAliasRow[] }) => {
    setLoading(true);
    try {
      const payload = {
        hga_team_alias_map: JSON.stringify(buildHgaAliasMap(values.hga_team_alias_rows || []), null, 2),
      };
      await axios.post('/api/settings', payload);
      const refreshed = await axios.get('/api/settings');
      const data = { ...refreshed.data };
      form.setFieldsValue({
        hga_team_alias_rows: parseHgaAliasMap(data.hga_team_alias_map),
      });
      setDefaultRows(parseHgaAliasMap(data.hga_team_alias_map_default));
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
            <Text type="secondary">以二级页面集中维护 Trade500 与 HGA 的球队名称映射，保存后抓取链路立即生效。</Text>
          </Space>
        </Space>

        <Card className="shadow-sm">
          <Form form={form} layout="vertical" onFinish={onSave}>
            <Form.Item
              extra="左侧填写 Trade500 队名，右侧填写 HGA 对应队名。恢复默认映射会读取 config/hga-team-alias-map.json。"
            >
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
                <Row gutter={0} style={{ background: '#fafafa', padding: '12px 16px', fontWeight: 600 }}>
                  <Col span={11}>Trade500</Col>
                  <Col span={11}>HGA</Col>
                  <Col span={2} style={{ textAlign: 'right' }}>操作</Col>
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
      </Space>
    </div>
  );
};

export default HgaTeamAliasSettings;
