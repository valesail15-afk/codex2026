import React, { useEffect, useState } from 'react';
import { Table, Button, Card, Typography, Space, Modal, Form, Input, Select, Tag, Popconfirm, App, DatePicker } from 'antd';
import { UserAddOutlined, EditOutlined, DeleteOutlined, HistoryOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import { AuthContext } from '../App';

const { Title } = Typography;

interface User {
  id: number;
  username: string;
  role: 'Admin' | 'User';
  package_name?: string;
  expires_at?: string | null;
  status: 'normal' | 'expired' | 'locked';
  login_fail_count: number;
  lock_until?: string | null;
  last_login_at?: string | null;
}

interface Log {
  id: number;
  username: string;
  action: string;
  content: string;
  created_at: string;
}

const USERNAME_MAX_LEN = 24;
const PACKAGE_OPTIONS = ['基础套餐'];

const UserManagement: React.FC = () => {
  const { message } = App.useApp();
  const auth = React.useContext(AuthContext);
  const currentUser = auth?.user;
  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [logsModalVisible, setLogsModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/admin/users');
      setUsers(response.data || []);
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async () => {
    const response = await axios.get('/api/admin/logs');
    setLogs(response.data || []);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (!modalVisible) return;
    if (editingUser) {
      form.setFieldsValue({
        username: editingUser.username,
        role: editingUser.role,
        package_name: editingUser.package_name || PACKAGE_OPTIONS[0],
        expires_at: editingUser.expires_at ? dayjs(editingUser.expires_at) : dayjs().add(30, 'day'),
        status: editingUser.status || 'normal',
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        role: 'User',
        package_name: PACKAGE_OPTIONS[0],
        expires_at: dayjs().add(30, 'day'),
        status: 'normal',
      });
    }
  }, [modalVisible, editingUser, form]);

  const handleSave = async (values: any) => {
    const payload = {
      ...values,
      expires_at: values.expires_at ? values.expires_at.toISOString() : null,
      max_duration: 0,
    };
    if (editingUser) {
      await axios.put(`/api/admin/users/${editingUser.id}`, payload);
      message.success('用户已更新');
    } else {
      await axios.post('/api/admin/users', payload);
      message.success('用户已创建');
    }
    setModalVisible(false);
    fetchUsers();
  };

  const doAction = async (api: string, successText: string, body?: any) => {
    await axios.post(api, body || {});
    message.success(successText);
    fetchUsers();
  };

  const openSessions = async (user: User) => {
    const response = await axios.get(`/api/admin/users/${user.id}/sessions`);
    setSessions(response.data || []);
    setSessionUser(user);
    setSessionModalOpen(true);
  };

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 150,
      render: (v: string) => (
        <div
          style={{
            maxWidth: 136,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={v}
        >
          {v}
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 84,
      render: (role: string) => <Tag color={role === 'Admin' ? 'gold' : 'blue'}>{role}</Tag>,
    },
    { title: '套餐', dataIndex: 'package_name', key: 'package_name', width: 100 },
    { title: '到期时间', dataIndex: 'expires_at', key: 'expires_at', width: 104, render: (v: string) => (v ? dayjs(v).format('YY-MM-DD') : '-') },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (s: string) => {
        const color = s === 'normal' ? 'green' : s === 'expired' ? 'orange' : 'red';
        const text = s === 'normal' ? '正常' : s === 'expired' ? '到期' : '锁定';
        return <Tag color={color}>{text}</Tag>;
      },
    },
    {
      title: '登录失败',
      key: 'login_fail_count',
      width: 88,
      render: (_: any, record: User) => `${record.login_fail_count || 0}次`,
    },
    { title: '最后登录', dataIndex: 'last_login_at', key: 'last_login_at', width: 126, render: (v: string) => (v ? dayjs(v).format('YY-MM-DD HH:mm') : '-') },
    {
      title: '操作',
      key: 'action',
      width: 420,
      render: (_: any, record: User) => (
        <Space wrap size={[4, 4]}>
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditingUser(record); setModalVisible(true); }}>
            编辑
          </Button>
          <Button size="small" onClick={() => doAction(`/api/admin/users/${record.id}/renew`, '续费成功', { extend_days: 30 })}>
            续费30天
          </Button>
          <Button size="small" onClick={() => doAction(`/api/admin/users/${record.id}/renew`, '延长成功', { extend_days: 7 })}>
            延长7天
          </Button>
          <Button size="small" onClick={() => doAction(`/api/admin/users/${record.id}/unlock`, '管理员解锁成功')}>
            管理解锁
          </Button>
          <Button size="small" onClick={() => doAction(`/api/admin/users/${record.id}/force-logout`, '已强制下线')}>
            强制下线
          </Button>
          <Button size="small" onClick={() => openSessions(record)}>
            在线会话
          </Button>
          <Button
            size="small"
            onClick={() => {
              setPasswordUser(record);
              setPasswordModalOpen(true);
              pwdForm.resetFields();
            }}
          >
            重置密码
          </Button>
          {record.status !== 'locked' ? (
            <Button size="small" danger disabled={record.id === currentUser?.id} onClick={() => doAction(`/api/admin/users/${record.id}/freeze`, '已冻结')}>
              冻结
            </Button>
          ) : (
            <Button size="small" onClick={() => doAction(`/api/admin/users/${record.id}/unfreeze`, '已解冻')}>
              解冻
            </Button>
          )}
          <Popconfirm
            title="确定删除该用户吗？"
            disabled={record.id === currentUser?.id}
            onConfirm={async () => {
              await axios.delete(`/api/admin/users/${record.id}`);
              message.success('已删除');
              fetchUsers();
            }}
          >
            <Button size="small" icon={<DeleteOutlined />} danger disabled={record.id === currentUser?.id}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1480, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}>
          用户管理
        </Title>
        <Space>
          <Button
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => {
              fetchLogs();
              setLogsModalVisible(true);
            }}
          >
            操作日志
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<UserAddOutlined />}
            onClick={() => {
              setEditingUser(null);
              setModalVisible(true);
            }}
          >
            新增用户
          </Button>
        </Space>
      </div>

      <Card className="shadow-sm">
        <Table dataSource={users} columns={columns as any} rowKey="id" loading={loading} pagination={{ pageSize: 12, size: 'small' }} />
      </Card>

      <Modal title={editingUser ? '编辑用户' : '新增用户'} open={modalVisible} onCancel={() => setModalVisible(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { max: USERNAME_MAX_LEN, message: `用户名最多 ${USERNAME_MAX_LEN} 个字符` },
            ]}
          >
            <Input disabled={!!editingUser} maxLength={USERNAME_MAX_LEN} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: !editingUser, message: '请输入密码' }]}>
            <Input.Password placeholder={editingUser ? '留空表示不修改' : '请输入密码'} />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="User">普通用户</Select.Option>
              <Select.Option value="Admin">管理员</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="package_name" label="套餐" rules={[{ required: true, message: '请选择套餐' }]}>
            <Select options={PACKAGE_OPTIONS.map((p) => ({ label: p, value: p }))} />
          </Form.Item>
          <Form.Item name="expires_at" label="到期时间" rules={[{ required: true, message: '请选择到期时间' }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="normal">正常</Select.Option>
              <Select.Option value="expired">到期</Select.Option>
              <Select.Option value="locked">锁定</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>
              提交
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`重置密码 - ${passwordUser?.username || ''}`}
        open={passwordModalOpen}
        onCancel={() => setPasswordModalOpen(false)}
        onOk={async () => {
          const values = await pwdForm.validateFields();
          if (!passwordUser) return;
          await axios.post(`/api/admin/users/${passwordUser.id}/reset-password`, { password: values.password });
          message.success('密码已重置并强制下线');
          setPasswordModalOpen(false);
        }}
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 6, message: '至少 6 位' }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="操作日志" open={logsModalVisible} onCancel={() => setLogsModalVisible(false)} width={900} footer={null} destroyOnHidden>
        <Table
          dataSource={logs}
          rowKey="id"
          pagination={{ pageSize: 12 }}
          columns={[
            { title: '时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
            { title: '用户', dataIndex: 'username' },
            { title: '操作', dataIndex: 'action' },
            { title: '内容', dataIndex: 'content' },
          ]}
        />
      </Modal>

      <Modal title={`在线会话 - ${sessionUser?.username || ''}`} open={sessionModalOpen} onCancel={() => setSessionModalOpen(false)} width={1000} footer={null}>
        <Table
          rowKey="session_id"
          dataSource={sessions}
          pagination={false}
          columns={[
            { title: '会话ID', dataIndex: 'session_id', render: (v: string) => String(v).slice(0, 10) + '...' },
            {
              title: '设备',
              dataIndex: 'device_id',
              width: 280,
              render: (v: string) => (
                <div
                  style={{
                    maxWidth: 260,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={String(v || '-')}
                >
                  {v || '-'}
                </div>
              ),
            },
            { title: 'IP', dataIndex: 'ip' },
            { title: '最近活跃', dataIndex: 'last_activity_at', render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-') },
            { title: '状态', dataIndex: 'is_active', render: (v: number) => <Tag color={v ? 'green' : 'default'}>{v ? '在线' : '离线'}</Tag> },
            {
              title: '操作',
              render: (_: any, row: any) => (
                <Button
                  size="small"
                  disabled={!row.is_active}
                  onClick={async () => {
                    if (!sessionUser) return;
                    await axios.post(`/api/admin/users/${sessionUser.id}/sessions/${row.session_id}/kick`);
                    message.success('会话已踢下线');
                    openSessions(sessionUser);
                  }}
                >
                  踢下线
                </Button>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
};

export default UserManagement;

