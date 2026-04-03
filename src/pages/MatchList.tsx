import React, { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import MatchModal from '../components/MatchModal';

const { Title, Text } = Typography;
const responsiveMd: Array<'md'> = ['md'];
const responsiveLg: Array<'lg'> = ['lg'];

type CrownHandicap = {
  type?: string;
  home_odds?: number;
  away_odds?: number;
};

type MatchRow = {
  match_id: string;
  league?: string;
  match_time?: string;
  home_team?: string;
  away_team?: string;
  handicap?: string;
  jc_handicap?: string;
  j_w?: number;
  j_d?: number;
  j_l?: number;
  j_hw?: number;
  j_hd?: number;
  j_hl?: number;
  c_w?: number;
  c_d?: number;
  c_l?: number;
  c_h?: CrownHandicap[] | CrownHandicap | string | null;
};

type RefreshStatus = {
  auto_scan_enabled?: boolean;
  hga_enabled?: boolean;
  interval_seconds: number;
  last_sync_at: string | null;
  next_sync_at: string | null;
  remaining_seconds: number;
  can_refresh: boolean;
};

const oddsColorByResult: Record<'win' | 'draw' | 'lose', string> = {
  win: 'blue',
  draw: 'gold',
  lose: 'red',
};

const formatOdds = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return '-';
  return value.toFixed(2);
};

const formatMatchTime = (value?: string) => {
  if (!value) return '-';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('MM-DD HH:mm') : value;
};

const formatHandicapType = (type?: string) => {
  const text = String(type || '').trim();
  if (!text) return '+0.00';
  const sign = text.startsWith('-') ? '-' : '+';
  const body = text.replace(/^[+-]/, '');
  const parts = body.split('/');
  if (!parts.every((p) => /^(\d+)(\.\d+)?$/.test(p))) return text;
  const formatted = parts.map((p) => Number(p).toFixed(2)).join('/');
  return `${sign}${formatted}`;
};

const oppositeHandicapType = (type?: string) => {
  const formatted = formatHandicapType(type);
  const body = formatted.replace(/^[+-]/, '');
  if (formatted.startsWith('+')) return `-${body}`;
  if (formatted.startsWith('-')) return `+${body}`;
  return `+${body}`;
};

const renderOutcomeTag = (label: string, odds: number | undefined, color: 'win' | 'draw' | 'lose') => {
  const v = formatOdds(odds);
  if (v === '-') return <Text type="secondary">-</Text>;
  return <Tag color={oddsColorByResult[color]}>{`${label} @ ${v}`}</Tag>;
};

const handicapLabelByOutcome = (outcome: 'win' | 'draw' | 'lose', jcHandicap?: string) => {
  const line = formatHandicapType(jcHandicap || '0');
  if (outcome === 'win') return `主胜(${line})`;
  if (outcome === 'draw') return `平(${line})`;
  return `客胜(${oppositeHandicapType(line)})`;
};

const renderJcOutcomeCell = (
  outcome: 'win' | 'draw' | 'lose',
  normalLabel: string,
  normalOdds: number | undefined,
  handicapOdds: number | undefined,
  jcHandicap?: string
) => (
  <Space direction="vertical" size={4}>
    {renderOutcomeTag(normalLabel, normalOdds, outcome)}
    {formatOdds(handicapOdds) !== '-' ? (
      <Tag color={oddsColorByResult[outcome]} variant="filled" style={{ opacity: 0.7 }}>
        {`${handicapLabelByOutcome(outcome, jcHandicap)} @ ${formatOdds(handicapOdds)}`}
      </Tag>
    ) : null}
  </Space>
);

const normalizeCrownHandicaps = (
  input?: CrownHandicap[] | CrownHandicap | string | null,
  limit = 3
): CrownHandicap[] => {
  const toNumber = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const normalizeItem = (item: any): CrownHandicap | null => {
    if (!item || typeof item !== 'object') return null;
    const type = String(item.type ?? item.handicap ?? '').trim();
    const homeOdds = toNumber(item.home_odds ?? item.homeOdds ?? item.homeWater);
    const awayOdds = toNumber(item.away_odds ?? item.awayOdds ?? item.awayWater);
    if (!type || homeOdds <= 0 || awayOdds <= 0) return null;
    return { type, home_odds: homeOdds, away_odds: awayOdds };
  };

  let parsed: any = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return [];
    }
  }

  if (Array.isArray(parsed)) {
    const uniq = new Map<string, CrownHandicap>();
    for (const raw of parsed) {
      const item = normalizeItem(raw);
      if (!item) continue;
      // Deduplicate by normalized handicap line only. Odds may vary across refreshes,
      // but the UI should show one row per handicap type.
      const key = formatHandicapType(item.type);
      if (!uniq.has(key)) uniq.set(key, item);
    }
    return Array.from(uniq.values()).slice(0, Math.max(1, limit));
  }

  const single = normalizeItem(parsed);
  return single ? [single] : [];
};

const formatCrownHandicap = (
  handicaps?: CrownHandicap[] | CrownHandicap | string | null,
  limit = 3
) => {
  const normalized = normalizeCrownHandicaps(handicaps, limit);
  if (normalized.length === 0) return '-';
  return (
    <div style={{ lineHeight: 1.45 }}>
      {normalized.map((item, index) => {
        const homeType = formatHandicapType(item.type);
        const awayType = oppositeHandicapType(homeType);
        return (
          <div key={`${homeType}-${index}`} style={{ marginBottom: 2 }}>
            <div>
              <Text style={{ color: '#000' }}>{`主胜(${homeType})：`}</Text>
              <Text style={{ color: '#1677ff' }}>{formatOdds(item.home_odds)}</Text>
            </div>
            <div>
              <Text style={{ color: '#000' }}>{`客胜(${awayType})：`}</Text>
              <Text style={{ color: '#ff4d4f' }}>{formatOdds(item.away_odds)}</Text>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const isManualMatch = (match: MatchRow) => String(match.match_id || '').startsWith('manual_');

const MatchList: React.FC = () => {
  const { message } = App.useApp();
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingMatch, setEditingMatch] = useState<MatchRow | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const crownHandicapDisplayLimit = refreshStatus?.hga_enabled === true ? 3 : 1;

  const fetchMatches = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/matches');
      setMatches(Array.isArray(res.data) ? res.data : []);
    } catch {
      message.error('获取比赛列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchRefreshStatus = async () => {
    try {
      const res = await axios.get('/api/matches/refresh-status');
      const status = res.data as RefreshStatus;
      setRefreshStatus(status);
      setRemainingSeconds(Math.max(0, Number(status?.remaining_seconds || 0)));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchMatches();
    fetchRefreshStatus();
  }, []);

  useEffect(() => {
    const countdownTimer = window.setInterval(() => {
      setRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    const pollTimer = window.setInterval(() => {
      fetchRefreshStatus();
      fetchMatches();
    }, 15000);
    return () => {
      window.clearInterval(countdownTimer);
      window.clearInterval(pollTimer);
    };
  }, []);

  const handleCreateOrUpdate = async (values: any) => {
    try {
      if (editingMatch?.match_id) {
        await axios.post('/api/matches/update-odds', { ...values, match_id: editingMatch.match_id });
        message.success('比赛已更新');
      } else {
        await axios.post('/api/matches', values);
        message.success('比赛添加成功');
      }
      setIsModalVisible(false);
      setEditingMatch(null);
      fetchMatches();
    } catch {
      message.error(editingMatch ? '比赛更新失败' : '比赛添加失败');
    }
  };

  const handleDelete = async (matchId: string) => {
    try {
      await axios.delete(`/api/matches/${matchId}`);
      message.success('比赛已删除');
      fetchMatches();
    } catch {
      message.error('删除失败');
    }
  };

  const columns = useMemo(
    () => [
      {
        title: '赛事',
        dataIndex: 'league',
        key: 'league',
        width: 86,
        ellipsis: true,
        render: (text: string) => (
          <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
            {text || '-'}
          </Tag>
        ),
      },
      { title: '比赛时间', dataIndex: 'match_time', key: 'match_time', width: 92, render: (value: string) => formatMatchTime(value) },
      { title: '主队', dataIndex: 'home_team', key: 'home_team', width: 104, ellipsis: true, render: (text: string) => text || '-' },
      { title: '客队', dataIndex: 'away_team', key: 'away_team', width: 104, ellipsis: true, render: (text: string) => text || '-' },
      {
        title: '让球',
        key: 'handicap_group',
        width: 92,
        responsive: responsiveMd,
        render: (record: MatchRow) => (
          <div style={{ lineHeight: 1.4 }}>
            <div>{record.handicap || '-'}</div>
            <div>{record.jc_handicap || '-'}</div>
          </div>
        ),
      },
      {
        title: '竞彩胜',
        key: 'j_w_group',
        width: 132,
        render: (record: MatchRow) => renderJcOutcomeCell('win', '主胜', record.j_w, record.j_hw, record.jc_handicap),
      },
      {
        title: '竞彩平',
        key: 'j_d_group',
        width: 132,
        render: (record: MatchRow) => renderJcOutcomeCell('draw', '平', record.j_d, record.j_hd, record.jc_handicap),
      },
      {
        title: '竞彩负',
        key: 'j_l_group',
        width: 132,
        render: (record: MatchRow) => renderJcOutcomeCell('lose', '客胜', record.j_l, record.j_hl, record.jc_handicap),
      },
      {
        title: '皇冠胜',
        dataIndex: 'c_w',
        key: 'c_w',
        width: 110,
        responsive: responsiveLg,
        render: (value: number) => renderOutcomeTag('主胜', value, 'win'),
      },
      {
        title: '皇冠平',
        dataIndex: 'c_d',
        key: 'c_d',
        width: 110,
        responsive: responsiveLg,
        render: (value: number) => renderOutcomeTag('平', value, 'draw'),
      },
      {
        title: '皇冠负',
        dataIndex: 'c_l',
        key: 'c_l',
        width: 110,
        responsive: responsiveLg,
        render: (value: number) => renderOutcomeTag('客胜', value, 'lose'),
      },
      {
        title: '皇冠让球',
        dataIndex: 'c_h',
        key: 'c_h',
        width: 220,
        responsive: responsiveMd,
        render: (value: CrownHandicap[] | CrownHandicap | string | null) => formatCrownHandicap(value, crownHandicapDisplayLimit),
      },
      {
        title: '操作',
        key: 'action',
        width: 90,
        render: (record: MatchRow) =>
          isManualMatch(record) ? (
            <Space size={4}>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditingMatch(record);
                  setIsModalVisible(true);
                }}
              />
              <Popconfirm title="确认删除该比赛？" onConfirm={() => handleDelete(record.match_id)}>
                <Button type="text" danger size="small" icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          ) : (
            <Text type="secondary">-</Text>
          ),
      },
    ],
    [crownHandicapDisplayLimit]
  );

  const countdownText = refreshStatus?.auto_scan_enabled === false
    ? '自动同步已关闭'
    : `${Math.max(0, remainingSeconds ?? refreshStatus?.interval_seconds ?? 0)}秒后同步数据`;

  return (
    <div style={{ maxWidth: 1560, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Title level={3} style={{ margin: 0 }}>{`比赛列表（${matches.length}场）`}</Title>
        <Space>
          <Text type="secondary">{countdownText}</Text>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingMatch(null);
              setIsModalVisible(true);
            }}
          >
            手动添加
          </Button>
        </Space>
      </div>

      <Card className="shadow-sm" styles={{ body: { padding: 10 } }}>
        <Table
          dataSource={matches}
          columns={columns}
          rowKey="match_id"
          loading={loading}
          size="small"
          pagination={{ pageSize: 18, size: 'small' }}
        />
      </Card>

      <MatchModal
        visible={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingMatch(null);
        }}
        onFinish={handleCreateOrUpdate}
        initialValues={editingMatch || undefined}
        title={editingMatch ? '编辑比赛详情' : '手动添加比赛'}
      />
    </div>
  );
};

export default MatchList;
