import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, Layout, App } from 'antd';
import { UserOutlined, LockOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

const { Title, Text } = Typography;
const { Content } = Layout;

const Login: React.FC<{ onLoginSuccess: () => Promise<void> }> = ({ onLoginSuccess }) => {
  const { message, modal } = App.useApp();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const onFinish = async (values: any) => {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      const data = await response.json();
      if (response.ok) {
        message.success('登录成功');
        await onLoginSuccess();
        navigate('/');
        return;
      }

      if (data.code === 'ACCOUNT_EXPIRED' || data.code === 'DURATION_EXCEEDED') {
        modal.error({
          title: '账号已到期',
          icon: <ExclamationCircleOutlined />,
          content: '当前账号套餐已到期，请联系管理员续费后再登录。',
          okText: '知道了',
        });
      } else if (data.code === 'ACCOUNT_LOCKED') {
        modal.error({
          title: '账号已锁定',
          icon: <ExclamationCircleOutlined />,
          content: '账号因安全策略被锁定，请稍后重试或联系管理员解锁。',
          okText: '知道了',
        });
      } else {
        message.error(data.error || '登录失败');
      }
    } catch (error) {
      console.error('Login error:', error);
      message.error('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout style={{ minHeight: '100vh', background: '#f0f2f5' }}>
      <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <Card style={{ width: 400, borderRadius: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <Title level={2} style={{ margin: 0 }}>红单神器</Title>
            <Text type="secondary">请输入账号密码登录</Text>
          </div>
          <Form name="login" onFinish={onFinish} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                登录
              </Button>
            </Form.Item>
          </Form>
          <div style={{ textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              请联系管理员获取账号信息
            </Text>
          </div>
        </Card>
      </Content>
    </Layout>
  );
};

export default Login;

