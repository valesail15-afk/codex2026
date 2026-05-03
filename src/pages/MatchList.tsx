import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App, Card, Space, Table, Tag, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const responsiveMd: Array<'md'> = ['md'];

type CrownHandicap = {
  type?: string;
  home_odds?: number;
  away_odds?: number;
};

type GoalOddsItem = {
  label?: string;
  odds?: number;
};

type OverUnderOddsItem = {
  line?: string;
  over_odds?: number;
  under_odds?: number;
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
  c_goal?: GoalOddsItem[] | string | null;
  c_ou?: OverUnderOddsItem[] | string | null;
};

type RefreshStatus = {
  auto_scan_enabled?: boolean;
  hga_enabled?: boolean;
  crown_fetch_status?: 'success' | 'failed' | string;
  crown_last_fetch_at?: string | null;
  interval_seconds: number;
  last_sync_at: string | null;
  next_sync_at: string | null;
  remaining_seconds: number;
  can_refresh: boolean;
};

type SyncPushPayload = {
  type?: string;
  source?: 'auto_scan' | 'initial_sync';
  has_changes?: boolean;
  changed_count?: number;
  refresh_status?: RefreshStatus;
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

const compactHandicapDisplay = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .split('/')
    .map((part) => {
      const text = String(part || '').trim();
      if (!text) return '';
      const sign = text.startsWith('+') ? '+' : text.startsWith('-') ? '-' : '';
      const body = sign ? text.slice(1) : text;
      const n = Number(body);
      if (!Number.isFinite(n)) return text;
      const normalized = Number.isInteger(n) ? String(n) : String(n).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      return `${sign}${normalized}`;
    })
    .join('/');
};

const formatLeagueShortName = (league?: string) => {
  const raw = String(league || '').trim();
  if (!raw) return '-';
  // 赛事简称优先由后端按体彩 leagueAbbName 写入，这里只做兜底清洗。
  return raw.replace(/\s+/g, '');
};

const formatHandicapType = (type?: string) => {
  const text = String(type || '').trim();
  if (!text) return '+0.00';
  const sign = text.startsWith('-') ? '-' : '+';
  const body = text.replace(/^[+-]/, '');
  const parts = body.split('/');
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return text;
  return `${sign}${parts.map((p) => Number(p).toFixed(2)).join('/')}`;
};

const isUnavailableHandicap = (value?: string) => {
  const text = String(value || '').trim();
  return !text || text === '-' || text === '未开售';
};

const resolveJcHandicapDisplay = (record: MatchRow) => {
  const jc = String(record.jc_handicap || '').trim();
  if (!isUnavailableHandicap(jc)) return jc;
  const fallback = String(record.handicap || '').trim();
  if (!isUnavailableHandicap(fallback)) return fallback;
  return '未开售';
};

const oppositeHandicapType = (type?: string) => {
  const formatted = formatHandicapType(type);
  const body = formatted.replace(/^[+-]/, '');
  if (formatted.startsWith('+')) return `-${body}`;
  if (formatted.startsWith('-')) return `+${body}`;
  return `+${body}`;
};

const normalizeCrownHandicaps = (
  input?: CrownHandicap[] | CrownHandicap | string | null,
  limit = Number.MAX_SAFE_INTEGER
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
      const key = formatHandicapType(item.type);
      if (!uniq.has(key)) uniq.set(key, item);
    }
    return Array.from(uniq.values()).slice(0, Math.max(1, limit));
  }

  const single = normalizeItem(parsed);
  return single ? [single] : [];
};

const normalizeGoalOdds = (input?: GoalOddsItem[] | string | null) => {
  let parsed: any = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [] as GoalOddsItem[];
  return parsed
    .map((item: any) => ({
      label: String(item?.label ?? item?.goal ?? item?.name ?? '').trim(),
      odds: Number(item?.odds ?? item?.value ?? item?.price ?? 0),
    }))
    .filter((item) => item.label && Number.isFinite(item.odds) && item.odds > 0);
};

const normalizeOverUnderOdds = (input?: OverUnderOddsItem[] | string | null) => {
  let parsed: any = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [] as OverUnderOddsItem[];
  return parsed
    .map((item: any) => ({
      line: String(item?.line ?? item?.type ?? item?.handicap ?? '').trim(),
      over_odds: Number(item?.over_odds ?? item?.overOdds ?? item?.big_odds ?? 0),
      under_odds: Number(item?.under_odds ?? item?.underOdds ?? item?.small_odds ?? 0),
    }))
    .filter(
      (item) =>
        item.line &&
        Number.isFinite(item.over_odds) &&
        item.over_odds > 0 &&
        Number.isFinite(item.under_odds) &&
        item.under_odds > 0
    );
};

const renderOddsTag = (label: string, odds: number | undefined, color: 'blue' | 'gold' | 'red') => {
  const v = formatOdds(odds);
  if (v === '-') return <Text type="secondary">-</Text>;
  return (
    <Tag color={color} style={{ marginInlineEnd: 0 }}>
      {`${label} @ ${v}`}
    </Tag>
  );
};

const formatJingcaiOddsBlock = (record: MatchRow) => {
  const rawLine = resolveJcHandicapDisplay(record);
  const hasValidLine = !isUnavailableHandicap(rawLine);
  const line = hasValidLine ? formatHandicapType(rawLine) : '';
  const oppositeLine = hasValidLine ? oppositeHandicapType(line) : '';
  const hasHandicap =
    formatOdds(record.j_hw) !== '-' || formatOdds(record.j_hd) !== '-' || formatOdds(record.j_hl) !== '-';

  return (
    <div style={{ lineHeight: 1.5 }}>
      <div>{renderOddsTag('主胜', record.j_w, 'blue')}</div>
      <div>{renderOddsTag('平', record.j_d, 'gold')}</div>
      <div>{renderOddsTag('客胜', record.j_l, 'red')}</div>
      {hasHandicap ? (
        <>
          <div>{renderOddsTag(hasValidLine ? `主胜(${line})` : '主胜', record.j_hw, 'blue')}</div>
          <div>{renderOddsTag(hasValidLine ? `平(${line})` : '平', record.j_hd, 'gold')}</div>
          <div>{renderOddsTag(hasValidLine ? `客胜(${oppositeLine})` : '客胜', record.j_hl, 'red')}</div>
        </>
      ) : null}
    </div>
  );
};

const formatCrownOddsBlock = (record: MatchRow) => (
  <div style={{ lineHeight: 1.5 }}>
    <div>{renderOddsTag('主胜', record.c_w, 'blue')}</div>
    <div>{renderOddsTag('平', record.c_d, 'gold')}</div>
    <div>{renderOddsTag('客胜', record.c_l, 'red')}</div>
  </div>
);

const formatHandicapAlignBlock = (record: MatchRow) => {
  const hasStandardOdds =
    formatOdds(record.j_w) !== '-' || formatOdds(record.j_d) !== '-' || formatOdds(record.j_l) !== '-';
  const hasJcHandicapOdds =
    formatOdds(record.j_hw) !== '-' || formatOdds(record.j_hd) !== '-' || formatOdds(record.j_hl) !== '-';
  const stdHandicap = hasStandardOdds ? '0' : '未开售';
  const jcHandicap = hasJcHandicapOdds ? String(record.jc_handicap || '').trim() || '-' : '未开售';
  const blank = <span>&nbsp;</span>;
  return (
    <div style={{ lineHeight: 1.5 }}>
      <div>{blank}</div>
      <div>{stdHandicap}</div>
      <div>{blank}</div>
      <div>{blank}</div>
      <div>{hasJcHandicapOdds ? (jcHandicap || '-') : '未开售'}</div>
      <div>{blank}</div>
    </div>
  );
};

const formatHandicapAlignBlockV2 = (record: MatchRow) => {
  const hasStandardOdds =
    formatOdds(record.j_w) !== '-' || formatOdds(record.j_d) !== '-' || formatOdds(record.j_l) !== '-';
  const hasJcHandicapOdds =
    formatOdds(record.j_hw) !== '-' || formatOdds(record.j_hd) !== '-' || formatOdds(record.j_hl) !== '-';
  const stdHandicap = hasStandardOdds ? '0' : '未开售';
  const jcHandicapRaw = resolveJcHandicapDisplay(record);
  const jcHandicap = hasJcHandicapOdds
    ? jcHandicapRaw === '未开售'
      ? '未开售'
      : compactHandicapDisplay(jcHandicapRaw) || '-'
    : '未开售';
  const blank = <span>&nbsp;</span>;
  return (
    <div style={{ lineHeight: 1.5 }}>
      <div>{blank}</div>
      <div>{stdHandicap}</div>
      <div>{blank}</div>
      <div>{blank}</div>
      <div>{jcHandicap}</div>
      <div>{blank}</div>
    </div>
  );
};

const formatCrownHandicap = (handicaps?: CrownHandicap[] | CrownHandicap | string | null, limit = 3) => {
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
              <Text>{`主胜(${homeType}) @ `}</Text>
              <Text style={{ color: '#1677ff' }}>{formatOdds(item.home_odds)}</Text>
            </div>
            <div>
              <Text>{`客胜(${awayType}) @ `}</Text>
              <Text style={{ color: '#ff4d4f' }}>{formatOdds(item.away_odds)}</Text>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const formatGoalOddsBlock = (goalOdds?: GoalOddsItem[] | string | null) => {
  const rows = normalizeGoalOdds(goalOdds);
  if (rows.length === 0) return '-';
  return (
    <div style={{ lineHeight: 1.5 }}>
      {rows.map((item, idx) => (
        <div key={`${item.label}-${idx}`}>
          <Text>{`（${item.label}）`}</Text>
          <Text style={{ color: '#1677ff' }}>{formatOdds(item.odds)}</Text>
        </div>
      ))}
    </div>
  );
};

const formatOverUnderOddsBlock = (ouOdds?: OverUnderOddsItem[] | string | null) => {
  const rows = normalizeOverUnderOdds(ouOdds);
  if (rows.length === 0) return '-';
  return (
    <div style={{ lineHeight: 1.5 }}>
      {rows.map((item, idx) => (
        <div key={`${item.line}-${idx}`} style={{ marginBottom: 2 }}>
          <div>
            <Text>{`（大${item.line}）`}</Text>
            <Text style={{ color: '#1677ff' }}>{formatOdds(item.over_odds)}</Text>
          </div>
          <div>
            <Text>{`（小${item.line}）`}</Text>
            <Text style={{ color: '#ff4d4f' }}>{formatOdds(item.under_odds)}</Text>
          </div>
        </div>
      ))}
    </div>
  );
};

const MatchList: React.FC = () => {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const wsRefreshDebounceRef = useRef<number | null>(null);
  const crownHandicapDisplayLimit = Number.MAX_SAFE_INTEGER;

  // 1. 获取比赛列表
  const { data: matches = [], isLoading: matchesLoading } = useQuery({
    queryKey: ['matches'],
    queryFn: async () => {
      const res = await axios.get('/api/matches');
      return Array.isArray(res.data) ? res.data : [];
    },
  });

  // 2. 获取刷新状态
  const { data: refreshStatus = null } = useQuery({
    queryKey: ['refresh-status'],
    queryFn: async () => {
      const res = await axios.get('/api/matches/refresh-status');
      const status = res.data as RefreshStatus;
      setRemainingSeconds(Math.max(0, Number(status?.remaining_seconds || 0)));
      return status;
    },
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const scheduleMatchesRefresh = () => {
      if (wsRefreshDebounceRef.current) window.clearTimeout(wsRefreshDebounceRef.current);
      wsRefreshDebounceRef.current = window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['matches'] });
      }, 800);
    };

    const connect = () => {
      if (closed) return;
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${wsProtocol}://${window.location.host}/ws/matches`);

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data || '{}') as SyncPushPayload;
          if (payload.type !== 'sync_update' && payload.type !== 'sync_status') return;

          if (payload.refresh_status) {
            queryClient.setQueryData(['refresh-status'], payload.refresh_status);
            setRemainingSeconds(Math.max(0, Number(payload.refresh_status?.remaining_seconds || 0)));
          } else {
            queryClient.invalidateQueries({ queryKey: ['refresh-status'] });
          }

          if (payload.type === 'sync_update' && payload.has_changes) {
            scheduleMatchesRefresh();
          }
        } catch {
          // ignore ws payload parse errors
        }
      };

      socket.onopen = () => {
        queryClient.invalidateQueries({ queryKey: ['refresh-status'] });
      };

      socket.onclose = () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(() => {
          connect();
        }, 3000);
      };

      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          // ignore close error
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (wsRefreshDebounceRef.current) window.clearTimeout(wsRefreshDebounceRef.current);
      try {
        socket?.close();
      } catch {
        // ignore close error
      }
    };
  }, []);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [matches.length, pageSize, currentPage]);

  useEffect(() => {
    const countdownTimer = window.setInterval(() => {
      setRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => {
      window.clearInterval(countdownTimer);
    };
  }, []);

  const columns = useMemo(
    () => [
      {
        title: '赛事',
        dataIndex: 'league',
        key: 'league',
        width: 120,
        ellipsis: true,
        render: (text: string) => (
          <Tag color="volcano" style={{ marginInlineEnd: 0 }} title={text || '-'}>
            {formatLeagueShortName(text)}
          </Tag>
        ),
      },
      { title: '比赛时间', dataIndex: 'match_time', key: 'match_time', width: 120, render: (value: string) => formatMatchTime(value) },
      { title: '主队', dataIndex: 'home_team', key: 'home_team', width: 130, ellipsis: true, render: (text: string) => text || '-' },
      { title: '客队', dataIndex: 'away_team', key: 'away_team', width: 130, ellipsis: true, render: (text: string) => text || '-' },
      {
        title: '让球',
        key: 'handicap_group',
        width: 100,
        responsive: responsiveMd,
        render: (record: MatchRow) => formatHandicapAlignBlockV2(record),
      },
      {
        title: '竞彩',
        key: 'jc_triplet',
        width: 210,
        render: (record: MatchRow) => formatJingcaiOddsBlock(record),
      },
      {
        title: '皇冠',
        key: 'crown_triplet',
        width: 210,
        render: (record: MatchRow) => formatCrownOddsBlock(record),
      },
      {
        title: '皇冠让球',
        dataIndex: 'c_h',
        key: 'c_h',
        width: 250,
        responsive: responsiveMd,
        render: (value: CrownHandicap[] | CrownHandicap | string | null) =>
          formatCrownHandicap(value, crownHandicapDisplayLimit),
      },
      {
        title: '进球',
        dataIndex: 'c_goal',
        key: 'c_goal',
        width: 160,
        render: (value: GoalOddsItem[] | string | null) => formatGoalOddsBlock(value),
      },
      {
        title: '大小球',
        dataIndex: 'c_ou',
        key: 'c_ou',
        width: 210,
        render: (value: OverUnderOddsItem[] | string | null) => formatOverUnderOddsBlock(value),
      },
    ],
    [crownHandicapDisplayLimit]
  );

  const countdownText =
    refreshStatus?.auto_scan_enabled === false
      ? '自动同步已关闭'
      : `（状态：${refreshStatus?.crown_fetch_status === 'success' ? '成功' : '失败'}）皇冠抓取 最近抓取：${
          refreshStatus?.crown_last_fetch_at ? dayjs(refreshStatus.crown_last_fetch_at).format('MM-DD HH:mm:ss') : '-'
        } ${Math.max(0, remainingSeconds ?? refreshStatus?.interval_seconds ?? 0)}秒后同步数据`;

  return (
    <div style={{ maxWidth: 1680, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Title level={3} style={{ margin: 0 }}>{`比赛列表（${matches.length}场）`}</Title>
        <Space>
          <Text type="secondary">{countdownText}</Text>
        </Space>
      </div>

      <Card className="shadow-sm" styles={{ body: { padding: 12 } }}>
        <Table
          className="match-list-table"
          dataSource={matches}
          columns={columns}
          rowKey="match_id"
          loading={matchesLoading}
          size="small"
          tableLayout="fixed"
          scroll={{ x: 'max-content' }}
          pagination={{
            current: currentPage,
            pageSize,
            size: 'small',
            showSizeChanger: true,
            pageSizeOptions: ['50', '100'],
            onShowSizeChange: (_, size) => {
              setPageSize(size);
              setCurrentPage(1);
            },
            onChange: (page, size) => {
              if (size !== pageSize) {
                setPageSize(size);
              }
              setCurrentPage(page);
            },
          }}
        />
      </Card>
    </div>
  );
};

export default MatchList;
