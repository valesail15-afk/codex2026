import React, { useState, useEffect, Component, ErrorInfo, ReactNode, createContext, useContext, useRef, useCallback } from 'react';
import { Layout, Menu, App as AntApp, ConfigProvider, theme, Result, Button as AntButton, Spin, Space, Typography, Dropdown, Tag, Modal } from 'antd';
import {
  DashboardOutlined,
  UnorderedListOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  TeamOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom';
import axios from 'axios';
import Dashboard from './pages/Dashboard';
import MatchList from './pages/MatchList';
import Calculator from './pages/Calculator';
import ParlayCalculator from './pages/ParlayCalculator';
import Settings from './pages/Settings';
import Login from './pages/Login';
import UserManagement from './pages/UserManagement';

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

interface User {
  id: number;
  username: string;
  role: 'Admin' | 'User';
  package_name?: string;
  expires_at?: string | null;
  status?: 'normal' | 'expired' | 'locked';
  max_duration: number;
  used_duration: number;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  remainingSeconds: number | null;
  setRemainingSeconds: (seconds: number | null) => void;
}

export const AuthContext = createContext<AuthContextType | null>(null);

const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};

const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { notification, modal } = AntApp.useApp();
  const isExpiredModalShown = useRef(false);
  const authChannel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    authChannel.current = new BroadcastChannel('auth_channel');
    authChannel.current.onmessage = (event) => {
      if (event.data.type === 'logout') {
        setUser(null);
        if (location.pathname !== '/login') {
          navigate('/login');
        }
      } else if (event.data.type === 'expired') {
        setRemainingSeconds(0);
      }
    };
    return () => {
      authChannel.current?.close();
    };
  }, [navigate, location.pathname]);

  const fetchUser = useCallback(async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/auth/me');
      setUser(response.data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setUser(null);
      navigate('/login');
    }
  }, [navigate]);

  useEffect(() => {
    if (location.pathname === '/login') {
      setLoading(false);
      return;
    }
    fetchUser();
  }, [fetchUser, location.pathname]);

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          if (location.pathname !== '/login') {
            logout();
            authChannel.current?.postMessage({ type: 'logout' });
          }
          return Promise.reject(error);
        }
        if (error.response?.status === 403) {
          if (user?.role === 'User' && (error.response?.data?.code === 'DURATION_EXCEEDED' || error.response?.data?.code === 'ACCOUNT_EXPIRED')) {
            setRemainingSeconds(0);
            authChannel.current?.postMessage({ type: 'expired' });
          } else if (user?.role === 'User' && error.response?.data?.code === 'ACCOUNT_LOCKED') {
            modal.error({
              title: '账号已锁定',
              content: '账号因安全策略被锁定，请联系管理员解锁后重试。',
              okText: '重新登录',
              onOk: () => {
                logout();
                authChannel.current?.postMessage({ type: 'logout' });
              },
            });
          } else {
            notification.error({
              message: '访问受限',
              description: error.response?.data?.error || '您没有权限执行此操作',
            });
          }
          return Promise.reject(error);
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, [user, logout, notification, modal, location.pathname]);

  useEffect(() => {
    if (user && user.role === 'User') {
      if (user.expires_at) {
        const remaining = Math.max(0, Math.floor((new Date(user.expires_at).getTime() - Date.now()) / 1000));
        setRemainingSeconds(remaining);
      } else {
        setRemainingSeconds(null);
      }
      isExpiredModalShown.current = false;
    } else {
      setRemainingSeconds(null);
    }
  }, [user]);

  useEffect(() => {
    if (remainingSeconds === 0 && user && user.role === 'User' && !isExpiredModalShown.current) {
      if (location.pathname === '/login') return;
      isExpiredModalShown.current = true;
      modal.warning({
        title: '使用时长已到期',
        content: '您的账号使用时长已到期，请联系管理员续费。',
        okText: '重新登录',
        onOk: () => {
          logout();
          authChannel.current?.postMessage({ type: 'logout' });
        },
      });
    }
  }, [remainingSeconds, user, logout, modal, location.pathname]);

  useEffect(() => {
    if (user && user.role === 'User') {
      const heartbeat = setInterval(async () => {
        try {
          const res = await axios.post('/api/auth/heartbeat');
          if (res.data.status === 'expired') {
            setRemainingSeconds(0);
          } else if (res.data.remaining !== undefined) {
            setRemainingSeconds(res.data.remaining);
          }
        } catch (err) {
          console.error('Heartbeat failed:', err);
        }
      }, 60000);
      return () => clearInterval(heartbeat);
    }
  }, [user]);

  useEffect(() => {
    if (remainingSeconds !== null && remainingSeconds > 0) {
      const timer = setInterval(() => {
        setRemainingSeconds((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [remainingSeconds]);

  const login = async () => {
    await fetchUser();
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, remainingSeconds, setRemainingSeconds }}>
      {children}
    </AuthContext.Provider>
  );
};

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Result
            status="error"
            title="应用运行出错"
            subTitle={this.state.error?.message || '未知错误'}
            extra={[
              <AntButton type="primary" key="reload" onClick={() => window.location.reload()}>
                刷新页面
              </AntButton>,
            ]}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const { user, logout, remainingSeconds } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: <Link to="/">主控面板</Link> },
    { key: '/matches', icon: <UnorderedListOutlined />, label: <Link to="/matches">比赛列表</Link> },
    { key: '/settings', icon: <SettingOutlined />, label: <Link to="/settings">系统设置</Link> },
    ...(user?.role === 'Admin'
      ? [{ key: '/admin/users', icon: <TeamOutlined />, label: <Link to="/admin/users">用户管理</Link> }]
      : []),
  ];

  const userMenu = {
    items: [
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: '退出登录',
        onClick: logout,
      },
    ],
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={(value) => setCollapsed(value)} theme="dark">
        <div
          style={{
            height: 64,
            margin: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 18,
            fontWeight: 'bold',
          }}
        >
          {collapsed ? '⚽' : '足球套利系统'}
        </div>
        <Menu theme="dark" selectedKeys={[location.pathname]} mode="inline" items={menuItems} />
      </Sider>
      <Layout>
        <Header
          style={{
            padding: '0 24px',
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}
        >
          <Dropdown menu={userMenu} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              {remainingSeconds !== null && (
                <Tag icon={<ClockCircleOutlined />} color="processing" style={{ marginRight: 8 }}>
                  剩余时间: {formatTime(remainingSeconds)}
                </Tag>
              )}
              <UserOutlined style={{ fontSize: 18 }} />
              <Text strong>{user?.username}</Text>
              <Tag color={user?.role === 'Admin' ? 'gold' : 'blue'}>{user?.role}</Tag>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ margin: '24px 16px', padding: 24, background: '#f5f7fa', minHeight: 280, borderRadius: 8 }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
};

const ProtectedRoute: React.FC<{ children: React.ReactNode; adminOnly?: boolean }> = ({ children, adminOnly }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (adminOnly && user.role !== 'Admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1890ff',
          borderRadius: 8,
        },
      }}
    >
      <AntApp>
        <Router>
          <AuthProvider>
            <ErrorBoundary>
              <Routes>
                <Route
                  path="/login"
                  element={
                    <AuthContext.Consumer>
                      {(auth) => (auth?.user ? <Navigate to="/" replace /> : <Login onLoginSuccess={async () => auth && (await auth.login())} />)}
                    </AuthContext.Consumer>
                  }
                />
                <Route
                  path="/*"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <Routes>
                          <Route path="/" element={<Dashboard />} />
                          <Route path="/matches" element={<MatchList />} />
                          <Route path="/calculator" element={<Calculator />} />
                          <Route path="/calculator/:matchId" element={<Calculator />} />
                          <Route path="/calculator/parlay/:id" element={<ParlayCalculator />} />
                          <Route path="/settings" element={<Settings />} />
                          <Route
                            path="/admin/users"
                            element={
                              <ProtectedRoute adminOnly>
                                <UserManagement />
                              </ProtectedRoute>
                            }
                          />
                        </Routes>
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </ErrorBoundary>
          </AuthProvider>
        </Router>
      </AntApp>
    </ConfigProvider>
  );
}
