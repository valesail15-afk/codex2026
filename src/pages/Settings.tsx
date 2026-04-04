import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Col, Divider, Form, Input, InputNumber, Radio, Row, Space, Switch, Tag, Typography } from 'antd';
import { SaveOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import axios from 'axios';
import { AuthContext } from '../App';
import { useNavigate } from 'react-router-dom';

const { Title, Text } = Typography;

const percentKeys = ['default_jingcai_rebate', 'default_crown_rebate', 'default_jingcai_share', 'default_crown_share'];
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
const Settings: React.FC = () => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const auth = useContext(AuthContext);
  const user = auth?.user;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testingHga, setTestingHga] = useState(false);
  const [defaultHgaAliasRows, setDefaultHgaAliasRows] = useState<HgaAliasRow[]>([]);
  const [hgaMeta, setHgaMeta] = useState({
    status: 'unknown',
    statusMessage: '',
    passwordConfigured: false,
  });
  const sessionMode = Form.useWatch('session_mode', form) || 'single';
  const hgaTeamAliasRows = Form.useWatch('hga_team_alias_rows', form) || [];
  const hgaStatusMeta = useMemo(() => {
    const map: Record<string, { color: string; label: string }> = {
      ok: { color: 'green', label: '登录正常' },
      disabled: { color: 'default', label: '已关闭' },
      locked: { color: 'red', label: '账号锁定' },
      timeout: { color: 'orange', label: '登录超时' },
      failed: { color: 'red', label: '连接或认证失败' },
      missing: { color: 'gold', label: '待配置' },
      empty: { color: 'gold', label: '空数据' },
      unknown: { color: 'blue', label: '未检测' },
    };
    return map[hgaMeta.status] || map.unknown;
  }, [hgaMeta.status]);
  const hgaAlertType = useMemo(() => {
    if (hgaMeta.status === 'ok') return 'success' as const;
    if (hgaMeta.status === 'disabled' || hgaMeta.status === 'unknown') return 'info' as const;
    if (hgaMeta.status === 'missing') return 'warning' as const;
    return 'error' as const;
  }, [hgaMeta.status]);

  useEffect(() => {
    const fetchSettings = async () => {
      const res = await axios.get('/api/settings');
      const data = { ...res.data };
      percentKeys.forEach((k) => {
        if (data[k] !== undefined) data[k] = Number(data[k]) * 100;
      });
      form.setFieldsValue({
        auto_scan: false,
        sound_alert: false,
        scan_interval: 180,
        min_profit_alert: 0.5,
        login_lock_short_minutes: 10,
        login_lock_long_minutes: 120,
        session_mode: 'single',
        max_sessions: 1,
        hga_enabled: false,
        hga_username: '',
        hga_password_configured: false,
        hga_status: 'unknown',
        hga_status_message: '',
        hga_team_alias_rows: parseHgaAliasMap(data.hga_team_alias_map),
        ...data,
      });
      setDefaultHgaAliasRows(parseHgaAliasMap(data.hga_team_alias_map_default));
      setHgaMeta({
        status: String(data.hga_status || 'unknown'),
        statusMessage: String(data.hga_status_message || ''),
        passwordConfigured: Boolean(data.hga_password_configured),
      });
    };
    fetchSettings().catch(() => {});
  }, [form]);

  const onSave = async (values: any) => {
    setLoading(true);
    try {
      const payload = { ...values };
      payload.hga_team_alias_map = JSON.stringify(buildHgaAliasMap(values.hga_team_alias_rows || []), null, 2);
      delete payload.hga_team_alias_rows;
      percentKeys.forEach((k) => {
        if (payload[k] !== undefined) payload[k] = Number(payload[k]) / 100;
      });
      delete payload.hga_status;
      delete payload.hga_status_message;
      delete payload.hga_password_configured;
      delete payload.hga_blocked_until;
      await axios.post('/api/settings', payload);
      const refreshed = await axios.get('/api/settings');
      const data = { ...refreshed.data };
      percentKeys.forEach((k) => {
        if (data[k] !== undefined) data[k] = Number(data[k]) * 100;
      });
      form.setFieldsValue({
        hga_team_alias_rows: parseHgaAliasMap(data.hga_team_alias_map),
        ...data,
      });
      setDefaultHgaAliasRows(parseHgaAliasMap(data.hga_team_alias_map_default));
      setHgaMeta({
        status: String(data.hga_status || 'unknown'),
        statusMessage: String(data.hga_status_message || ''),
        passwordConfigured: Boolean(data.hga_password_configured),
      });
      message.success('系统设置已保存');
    } catch {
      message.error('保存失败');
    } finally {
      setLoading(false);
    }
  };

  const onTestHgaLogin = async () => {
    setTestingHga(true);
    try {
      const username = String(form.getFieldValue('hga_username') || '').trim();
      const rawPassword = String(form.getFieldValue('hga_password') || '').trim();
      const payload: Record<string, string> = {};
      if (username) payload.hga_username = username;
      if (rawPassword) payload.hga_password = rawPassword;
      const res = await axios.post('/api/settings/hga/test-login', payload);
      const nextStatus = String(res.data?.status || 'unknown');
      const nextMessage = String(res.data?.message || '');
      setHgaMeta((prev) => ({
        ...prev,
        status: nextStatus,
        statusMessage: nextMessage,
      }));
      if (nextStatus === 'ok') {
        message.success(nextMessage || 'HGA 登录测试成功');
      } else if (nextStatus === 'locked') {
        message.warning(nextMessage || '测试失败：HGA 账号已锁定');
      } else if (nextStatus === 'missing') {
        message.warning(nextMessage || '测试失败：请先填写 HGA 账号和密码');
      } else {
        message.error(nextMessage || '测试失败：HGA 登录测试未通过');
      }
    } catch (err: any) {
      const errMessage = String(err?.response?.data?.message || err?.message || '测试失败：HGA 登录测试未通过');
      setHgaMeta((prev) => ({
        ...prev,
        status: 'failed',
        statusMessage: errMessage,
      }));
      message.error(errMessage);
    } finally {
      setTestingHga(false);
    }
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <Title level={3} style={{ marginBottom: 24 }}>
        系统设置
      </Title>

      <Alert
        title="风险提示"
        description="本系统用于赔率分析与对冲计算，实际下单前请再次核对平台实时赔率。"
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Card className="shadow-sm">
        <Form form={form} layout="vertical" onFinish={onSave}>
          <Title level={5}>默认返水与占比</Title>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="竞彩默认返水 (%)" name="default_jingcai_rebate" rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="皇冠默认返水 (%)" name="default_crown_rebate" rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="竞彩占比 (%)" name="default_jingcai_share" rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="皇冠占比 (%)" name="default_crown_share" rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider />

          {user?.role === 'Admin' && (
            <>
              <Title level={5}>数据同步</Title>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label="自动同步" name="auto_scan" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="同步间隔 (秒)" name="scan_interval" rules={[{ required: true }]}>
                    <InputNumber min={60} max={3600} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Divider />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <Title level={5} style={{ margin: 0 }}>
                  HGA 抓取配置
                </Title>
                <Form.Item name="hga_enabled" valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                </Form.Item>
              </div>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label="HGA 登录账号" name="hga_username">
                    <Input placeholder="请输入 HGA 登录账号" autoComplete="off" />
                  </Form.Item>
                  <Form.Item label="HGA 登录密码" name="hga_password" extra="当前保存的密码会直接显示，并可直接编辑。">
                    <Input placeholder="请输入 HGA 登录密码" autoComplete="off" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={
                      <Space size={8}>
                        <span>HGA 当前状态</span>
                        <Button size="small" loading={testingHga} onClick={onTestHgaLogin}>
                          测试
                        </Button>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Tag color={hgaStatusMeta.color} style={{ width: 'fit-content', marginInlineEnd: 0 }}>
                        {`HGA 状态：${hgaStatusMeta.label}`}
                      </Tag>
                      <Alert
                        type={hgaAlertType}
                        showIcon
                        title={hgaMeta.statusMessage || '暂无状态信息'}
                      />
                    </Space>
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col xs={24}>
                  <Form.Item
                    label={
                      <Space size={8}>
                        <span>HGA 球队别名映射</span>
                        <Button size="small" onClick={() => navigate('/settings/hga-team-aliases')}>
                          进入编辑
                        </Button>
                      </Space>
                    }
                    extra="映射维护已拆到独立二级页面，便于集中查看、编辑和恢复默认映射。"
                  >
                    <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 16, background: '#fafafa' }}>
                      <Space direction="vertical" size={6}>
                        <Text>当前映射条数：{hgaTeamAliasRows.length}</Text>
                        <Text type="secondary">文件默认条数：{defaultHgaAliasRows.length}</Text>
                      </Space>
                    </div>
                  </Form.Item>
                </Col>
              </Row>

              <Divider />

              <Title level={5}>登录安全</Title>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label="失败 5 次短锁（分钟）" name="login_lock_short_minutes" rules={[{ required: true }]}>
                    <InputNumber min={1} max={1440} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="失败 10 次长锁（分钟）" name="login_lock_long_minutes" rules={[{ required: true }]}>
                    <InputNumber min={1} max={10080} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Title level={5}>会话管理</Title>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label="会话模式" name="session_mode" rules={[{ required: true }]}>
                    <Radio.Group>
                      <Radio value="single">单设备登录</Radio>
                      <Radio value="multi">多设备上限</Radio>
                    </Radio.Group>
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="多设备上限" name="max_sessions" rules={[{ required: true }]}>
                    <InputNumber min={1} max={10} disabled={sessionMode !== 'multi'} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
              <Divider />
            </>
          )}

          <Title level={5}>提醒</Title>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="声音提醒" name="sound_alert" valuePropName="checked">
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="提醒利润阈值 (%)" name="min_profit_alert" rules={[{ required: true }]}>
                <InputNumber min={0} max={10} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <div style={{ marginTop: 36, textAlign: 'right' }}>
            <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={loading}>
              保存设置
            </Button>
          </div>
        </Form>
      </Card>

      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <Space orientation="vertical">
          <Text type="secondary">
            <SafetyCertificateOutlined /> 红单神器
          </Text>
        </Space>
      </div>
    </div>
  );
};

export default Settings;
