import React from 'react';
import { Empty, Typography } from 'antd';

const Placeholder: React.FC<{ title: string }> = ({ title }) => (
  <div style={{ padding: 48, textAlign: 'center' }}>
    <Typography.Title level={3}>{title}</Typography.Title>
    <Empty description="该页面正在开发中，敬请期待..." />
  </div>
);

export const MatchList = () => <Placeholder title="比赛列表" />;
export const History = () => <Placeholder title="历史记录" />;
export const Settings = () => <Placeholder title="系统设置" />;

export default Placeholder;
