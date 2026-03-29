import React, { useContext, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Divider, Form, InputNumber, Radio, Row, Space, Switch, Typography } from 'antd';
import { SaveOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import axios from 'axios';
import { AuthContext } from '../App';

const { Title, Text } = Typography;

const percentKeys = ['default_jingcai_rebate', 'default_crown_rebate', 'default_jingcai_share', 'default_crown_share'];

const Settings: React.FC = () => {
  const { message } = App.useApp();
  const auth = useContext(AuthContext);
  const user = auth?.user;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const sessionMode = Form.useWatch('session_mode', form) || 'single';

  useEffect(() => {
    const fetchSettings = async () => {
      const res = await axios.get('/api/settings');
      const data = { ...res.data };
      percentKeys.forEach((k) => {
        if (data[k] !== undefined) data[k] = Number(data[k]) * 100;
      });
      form.setFieldsValue({
        auto_scan: false,
        only_complete_matches: true,
        sound_alert: false,
        scan_interval: 180,
        min_profit_alert: 0.5,
        login_lock_short_minutes: 10,
        login_lock_long_minutes: 120,
        session_mode: 'single',
        max_sessions: 1,
        ...data,
      });
    };
    fetchSettings().catch(() => {});
  }, [form]);

  const onSave = async (values: any) => {
    setLoading(true);
    try {
      const payload = { ...values };
      percentKeys.forEach((k) => {
        if (payload[k] !== undefined) payload[k] = Number(payload[k]) / 100;
      });
      await axios.post('/api/settings', payload);
      message.success('系统设置已保存');
    } catch {
      message.error('保存失败');
    } finally {
      setLoading(false);
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
                  <Form.Item label="只显示完整比赛数据" name="only_complete_matches" valuePropName="checked">
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

              <Title level={5}>会话治理</Title>
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
        <Space direction="vertical">
          <Text type="secondary">
            <SafetyCertificateOutlined /> 足球套利系统
          </Text>
        </Space>
      </div>
    </div>
  );
};

export default Settings;
