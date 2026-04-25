import React, { useContext, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Col, Empty, InputNumber, Modal, Pagination, Progress, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from 'antd';
import { CheckCircleOutlined, FireOutlined, RocketOutlined, ThunderboltOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { invertHandicap, normalizeCrownTarget } from '../shared/oddsText';
import { parseCrownBetTypeCompat } from '../shared/crownBetTypeCompat';
import { AuthContext } from '../App';
import SinglePlanDetailContent from '../components/SinglePlanDetailContent';
import ParlayPlanDetailContent from '../components/ParlayPlanDetailContent';
import HgPlanDetailContent from '../components/HgPlanDetailContent';
import GoalHedgePlanDetailContent from '../components/GoalHedgePlanDetailContent';

const { Title, Text } = Typography;

type OppType = 'single' | 'parlay' | 'hg' | 'goal_hedge';
type SingleBaseType = 'jingcai' | 'crown';
type ParlayBaseType = 'jingcai' | 'crown';

type ArbitrageSettings = {
  default_jingcai_rebate: number;
  default_crown_rebate: number;
  default_jingcai_share: number;
  default_crown_share: number;
};

type MatrixCell = {
  key: string;
  label: string;
  odds: number;
};

const PAGE_SIZE = 10;

const tableBorder = '#d9d9d9';
const headerBg = '#f7f8fa';
const highlightBg = '#e88700';
const highlightText = '#fff';
const zebraBg = '#f5f5f5';
const teamText = '#2f54eb';
const profitRateText = '#ff4d4f';

const toOdds = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const parseHandicapRows = (raw: any) => {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
};

const buildHighlightKeys = (record: any) => {
  if (Array.isArray(record?.highlight_keys) && record.highlight_keys.length > 0) {
    return record.highlight_keys;
  }
  const keys = new Set<string>();
  const isHg = String(record?.base_type || '').toLowerCase() === 'hg';
  if (!isHg) {
    const side = String(record?.best_strategy?.jcSide || '').trim();
    const market = String(record?.best_strategy?.jc_market || 'normal').trim();
    if (side === 'W' || side === 'D' || side === 'L') {
      keys.add(market === 'handicap' ? `jc_handicap_${side}` : `jc_standard_${side}`);
    }
  }

  const crownBets = [
    ...(record?.best_strategy?.hg_base_bet?.type ? [record.best_strategy.hg_base_bet] : []),
    ...(record?.best_strategy?.crown_bets || []),
  ];
  for (const bet of crownBets) {
    const normalized = normalizeCrownTarget(String(bet?.type || ''));
    const parsed = parseCrownBetTypeCompat(normalized);
    const sideKey = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
    const handicapLine = normalized.match(/\(([^)]+)\)/)?.[1];
    keys.add(handicapLine ? `crown_ah_${handicapLine}_${sideKey}` : `crown_standard_${sideKey}`);
  }
  return Array.from(keys);
};

const normalizeSingleMatrixRecord = (record: any) => {
  const handicapLine = String(record?.jc_handicap || record?.j_h || '0').trim() || '0';
  const pickCell = (preferred: any, fallback: MatrixCell) => {
    if (preferred && Number(preferred.odds || 0) > 0) return preferred;
    return fallback;
  };

  const fallbackJcMatrix = {
    standard: {
      W: { key: 'jc_standard_W', label: '主胜', odds: toOdds(record?.j_w) },
      D: { key: 'jc_standard_D', label: '平', odds: toOdds(record?.j_d) },
      L: { key: 'jc_standard_L', label: '客胜', odds: toOdds(record?.j_l) },
    },
    handicap: {
      W: { key: 'jc_handicap_W', label: `主胜(${handicapLine})`, odds: toOdds(record?.j_hw) },
      D: { key: 'jc_handicap_D', label: `平(${handicapLine})`, odds: toOdds(record?.j_hd) },
      L: { key: 'jc_handicap_L', label: `客胜(${invertHandicap(handicapLine)})`, odds: toOdds(record?.j_hl) },
    },
  };

  const fallbackCrownMatrix = {
    standard: {
      W: { key: 'crown_standard_W', label: '主胜', odds: toOdds(record?.c_w) },
      D: { key: 'crown_standard_D', label: '平', odds: toOdds(record?.c_d) },
      L: { key: 'crown_standard_L', label: '客胜', odds: toOdds(record?.c_l) },
    },
    handicapRows: parseHandicapRows(record?.c_h)
      .map((item: any) => {
        const line = String(item?.type || item?.handicap || '').trim();
        if (!line) return null;
        return {
          line,
          cells: {
            W: { key: `crown_ah_${line}_W`, label: `主胜(${line})`, odds: toOdds(item?.home_odds ?? item?.homeOdds ?? item?.homeWater) },
            D: null,
            L: { key: `crown_ah_${line}_L`, label: `客胜(${invertHandicap(line)})`, odds: toOdds(item?.away_odds ?? item?.awayOdds ?? item?.awayWater) },
          },
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => {
        const aNum = Math.abs(Number.parseFloat(String(a.line).replace('+', '')));
        const bNum = Math.abs(Number.parseFloat(String(b.line).replace('+', '')));
        if (aNum !== bNum) return aNum - bNum;
        return String(a.line).localeCompare(String(b.line), 'zh-CN');
      })
      .slice(0, 3),
  };

  const jcMatrix = {
    standard: {
      W: pickCell(record?.jc_matrix?.standard?.W, fallbackJcMatrix.standard.W),
      D: pickCell(record?.jc_matrix?.standard?.D, fallbackJcMatrix.standard.D),
      L: pickCell(record?.jc_matrix?.standard?.L, fallbackJcMatrix.standard.L),
    },
    handicap: {
      W: pickCell(record?.jc_matrix?.handicap?.W, fallbackJcMatrix.handicap.W),
      D: pickCell(record?.jc_matrix?.handicap?.D, fallbackJcMatrix.handicap.D),
      L: pickCell(record?.jc_matrix?.handicap?.L, fallbackJcMatrix.handicap.L),
    },
  };

  const crownMatrix = {
    standard: {
      W: pickCell(record?.crown_matrix?.standard?.W, fallbackCrownMatrix.standard.W),
      D: pickCell(record?.crown_matrix?.standard?.D, fallbackCrownMatrix.standard.D),
      L: pickCell(record?.crown_matrix?.standard?.L, fallbackCrownMatrix.standard.L),
    },
    handicapRows:
      Array.isArray(record?.crown_matrix?.handicapRows) && record.crown_matrix.handicapRows.length > 0
        ? record.crown_matrix.handicapRows
            .map((row: any, index: number) => ({
              line: row?.line || fallbackCrownMatrix.handicapRows[index]?.line || '',
              cells: {
                W: pickCell(row?.cells?.W, fallbackCrownMatrix.handicapRows[index]?.cells?.W || null),
                D: row?.cells?.D || fallbackCrownMatrix.handicapRows[index]?.cells?.D || null,
                L: pickCell(row?.cells?.L, fallbackCrownMatrix.handicapRows[index]?.cells?.L || null),
              },
            }))
            .filter((row: any) => row.line)
        : fallbackCrownMatrix.handicapRows,
  };

  return {
    ...record,
    jc_matrix: jcMatrix,
    crown_matrix: crownMatrix,
    highlight_keys: buildHighlightKeys(record),
  };
};

const formatMatrixCell = (cell?: MatrixCell | null) => {
  if (!cell || Number(cell.odds || 0) <= 0) return '-';
  return `${cell.label} @ ${Number(cell.odds).toFixed(2)}`;
};

const normalizeGoalKey = (value: string) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.includes('7+') || text.includes('7＋')) return '7+';
  const m = text.match(/\d+/);
  return m ? m[0] : text;
};

const normalizeOuLineKey = (value: string) =>
  String(value || '')
    .replace(/\s+/g, '')
    .replace(/＋/g, '+')
    .replace(/－/g, '-')
    .replace(/大|小/g, '');

const parseGoalRows = (raw: any) => {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item: any) => {
      const label = String(item?.label || '').trim();
      const odds = Number(item?.odds || 0);
      if (!label || !Number.isFinite(odds) || odds <= 0) return null;
      return { label, odds };
    })
    .filter(Boolean) as Array<{ label: string; odds: number }>;
};

const parseOuRows = (raw: any) => {
  const list = Array.isArray(raw) ? raw : [];
  const rows: Array<{ side: 'over' | 'under'; line: string; odds: number; label: string }> = [];
  for (const item of list) {
    const line = String(item?.line || '').trim();
    const overOdds = Number(item?.over_odds || 0);
    const underOdds = Number(item?.under_odds || 0);
    if (!line) continue;
    if (Number.isFinite(overOdds) && overOdds > 0) {
      rows.push({ side: 'over', line, odds: overOdds, label: `大${line}` });
    }
    if (Number.isFinite(underOdds) && underOdds > 0) {
      rows.push({ side: 'under', line, odds: underOdds, label: `小${line}` });
    }
  }
  return rows;
};

const chunkRows = <T,>(rows: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
};

const buildParlayFallbackCrownHandicap = (prefix: string, raw: any) => {
  const firstRow = parseHandicapRows(raw)
    .map((item: any) => {
      const line = String(item?.type || item?.handicap || '').trim();
      if (!line) return null;
      return {
        line,
        cells: {
          W: { key: `${prefix}_crown_ah_${line}_W`, label: `主胜(${line})`, odds: toOdds(item?.home_odds ?? item?.homeOdds ?? item?.homeWater) },
          D: null,
          L: { key: `${prefix}_crown_ah_${line}_L`, label: `客胜(${invertHandicap(line)})`, odds: toOdds(item?.away_odds ?? item?.awayOdds ?? item?.awayWater) },
        },
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      const aNum = Math.abs(Number.parseFloat(String(a.line).replace('+', '')));
      const bNum = Math.abs(Number.parseFloat(String(b.line).replace('+', '')));
      if (aNum !== bNum) return aNum - bNum;
      return String(a.line).localeCompare(String(b.line), 'zh-CN');
    })[0];

  return firstRow || { line: '', cells: { W: null, D: null, L: null } };
};

const normalizeParlayMatrixRecord = (record: any) => {
  const pickCell = (preferred: any, fallback: MatrixCell | null) => {
    if (preferred && Number(preferred.odds || 0) > 0) return preferred;
    return fallback;
  };

  const buildFallback = (prefix: string, match: any, rawCrownHandicaps: any) => {
    const handicapLine = String(match?.jc_handicap || '0').trim() || '0';
    const crownHandicap = buildParlayFallbackCrownHandicap(prefix, rawCrownHandicaps);
    return {
      jc: {
        standard: {
          W: { key: `${prefix}_jc_standard_W`, label: '主胜', odds: toOdds(match?.j_w) },
          D: { key: `${prefix}_jc_standard_D`, label: '平', odds: toOdds(match?.j_d) },
          L: { key: `${prefix}_jc_standard_L`, label: '客胜', odds: toOdds(match?.j_l) },
        },
        handicap: {
          W: { key: `${prefix}_jc_handicap_W`, label: `主胜(${handicapLine})`, odds: toOdds(match?.j_hw) },
          D: { key: `${prefix}_jc_handicap_D`, label: `平(${handicapLine})`, odds: toOdds(match?.j_hd) },
          L: { key: `${prefix}_jc_handicap_L`, label: `客胜(${invertHandicap(handicapLine)})`, odds: toOdds(match?.j_hl) },
        },
      },
      crown: {
        standard: {
          W: { key: `${prefix}_crown_standard_W`, label: '主胜', odds: toOdds(match?.c_w) },
          D: { key: `${prefix}_crown_standard_D`, label: '平', odds: toOdds(match?.c_d) },
          L: { key: `${prefix}_crown_standard_L`, label: '客胜', odds: toOdds(match?.c_l) },
        },
        handicap: crownHandicap,
      },
    };
  };

  const match1Fallback = buildFallback(
    'm1',
    {
      jc_handicap: record?.jc_handicap_1,
      j_w: record?.j1_w,
      j_d: record?.j1_d,
      j_l: record?.j1_l,
      j_hw: record?.j1_hw,
      j_hd: record?.j1_hd,
      j_hl: record?.j1_hl,
      c_w: record?.c1_w,
      c_d: record?.c1_d,
      c_l: record?.c1_l,
    },
    record?.c1_h
  );
  const match2Fallback = buildFallback(
    'm2',
    {
      jc_handicap: record?.jc_handicap_2,
      j_w: record?.j2_w,
      j_d: record?.j2_d,
      j_l: record?.j2_l,
      j_hw: record?.j2_hw,
      j_hd: record?.j2_hd,
      j_hl: record?.j2_hl,
      c_w: record?.c2_w,
      c_d: record?.c2_d,
      c_l: record?.c2_l,
    },
    record?.c2_h
  );

  return {
    ...record,
    match_1_matrix: {
      jc: {
        standard: {
          W: pickCell(record?.match_1_matrix?.jc?.standard?.W, match1Fallback.jc.standard.W),
          D: pickCell(record?.match_1_matrix?.jc?.standard?.D, match1Fallback.jc.standard.D),
          L: pickCell(record?.match_1_matrix?.jc?.standard?.L, match1Fallback.jc.standard.L),
        },
        handicap: {
          W: pickCell(record?.match_1_matrix?.jc?.handicap?.W, match1Fallback.jc.handicap.W),
          D: pickCell(record?.match_1_matrix?.jc?.handicap?.D, match1Fallback.jc.handicap.D),
          L: pickCell(record?.match_1_matrix?.jc?.handicap?.L, match1Fallback.jc.handicap.L),
        },
      },
      crown: {
        standard: {
          W: pickCell(record?.match_1_matrix?.crown?.standard?.W, match1Fallback.crown.standard.W),
          D: pickCell(record?.match_1_matrix?.crown?.standard?.D, match1Fallback.crown.standard.D),
          L: pickCell(record?.match_1_matrix?.crown?.standard?.L, match1Fallback.crown.standard.L),
        },
        handicap: {
          line: record?.match_1_matrix?.crown?.handicap?.line || match1Fallback.crown.handicap.line,
          cells: {
            W: pickCell(record?.match_1_matrix?.crown?.handicap?.cells?.W, match1Fallback.crown.handicap.cells.W),
            D: pickCell(record?.match_1_matrix?.crown?.handicap?.cells?.D, match1Fallback.crown.handicap.cells.D),
            L: pickCell(record?.match_1_matrix?.crown?.handicap?.cells?.L, match1Fallback.crown.handicap.cells.L),
          },
        },
      },
      highlight_keys: Array.isArray(record?.match_1_matrix?.highlight_keys) ? record.match_1_matrix.highlight_keys : [],
    },
    match_2_matrix: {
      jc: {
        standard: {
          W: pickCell(record?.match_2_matrix?.jc?.standard?.W, match2Fallback.jc.standard.W),
          D: pickCell(record?.match_2_matrix?.jc?.standard?.D, match2Fallback.jc.standard.D),
          L: pickCell(record?.match_2_matrix?.jc?.standard?.L, match2Fallback.jc.standard.L),
        },
        handicap: {
          W: pickCell(record?.match_2_matrix?.jc?.handicap?.W, match2Fallback.jc.handicap.W),
          D: pickCell(record?.match_2_matrix?.jc?.handicap?.D, match2Fallback.jc.handicap.D),
          L: pickCell(record?.match_2_matrix?.jc?.handicap?.L, match2Fallback.jc.handicap.L),
        },
      },
      crown: {
        standard: {
          W: pickCell(record?.match_2_matrix?.crown?.standard?.W, match2Fallback.crown.standard.W),
          D: pickCell(record?.match_2_matrix?.crown?.standard?.D, match2Fallback.crown.standard.D),
          L: pickCell(record?.match_2_matrix?.crown?.standard?.L, match2Fallback.crown.standard.L),
        },
        handicap: {
          line: record?.match_2_matrix?.crown?.handicap?.line || match2Fallback.crown.handicap.line,
          cells: {
            W: pickCell(record?.match_2_matrix?.crown?.handicap?.cells?.W, match2Fallback.crown.handicap.cells.W),
            D: pickCell(record?.match_2_matrix?.crown?.handicap?.cells?.D, match2Fallback.crown.handicap.cells.D),
            L: pickCell(record?.match_2_matrix?.crown?.handicap?.cells?.L, match2Fallback.crown.handicap.cells.L),
          },
        },
      },
      highlight_keys: Array.isArray(record?.match_2_matrix?.highlight_keys) ? record.match_2_matrix.highlight_keys : [],
    },
  };
};

const Dashboard: React.FC = () => {
  const { message } = App.useApp();
  const auth = useContext(AuthContext);
  const isAdmin = auth?.user?.role === 'Admin';

  const [opportunitiesByType, setOpportunitiesByType] = useState<Record<OppType, any[]>>({
    single: [],
    parlay: [],
    hg: [],
    goal_hedge: [],
  });
  const [scrapeHealth, setScrapeHealth] = useState<{ stats: any; rows: any[] } | null>(null);
  const [scrapeHealthError, setScrapeHealthError] = useState('');
  const [loadingByType, setLoadingByType] = useState<Record<OppType, boolean>>({
    single: true,
    parlay: true,
    hg: true,
    goal_hedge: true,
  });
  const [calculating, setCalculating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [oppType, setOppType] = useState<OppType>('single');
  const [singleBaseType, setSingleBaseType] = useState<SingleBaseType>('jingcai');
  const [parlayBaseType, setParlayBaseType] = useState<ParlayBaseType>('jingcai');
  const [minProfitFilter, setMinProfitFilter] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [detailModal, setDetailModal] = useState<{ open: boolean; type: OppType; record: any | null }>({
    open: false,
    type: 'single',
    record: null,
  });
  const [arbitrageSettings, setArbitrageSettings] = useState<ArbitrageSettings>({
    default_jingcai_rebate: 0.13,
    default_crown_rebate: 0.02,
    default_jingcai_share: 0,
    default_crown_share: 0,
  });
  const [arbitrageSettingsLoading, setArbitrageSettingsLoading] = useState(false);
  const [savingArbitrageSettings, setSavingArbitrageSettings] = useState(false);

  const fetchArbitrageSettings = async () => {
    setArbitrageSettingsLoading(true);
    try {
      let data: any;
      try {
        const res = await axios.get('/api/arbitrage/settings');
        data = res.data;
      } catch {
        const fallbackRes = await axios.get('/api/settings');
        data = fallbackRes.data;
      }
      setArbitrageSettings({
        default_jingcai_rebate: Number(data?.default_jingcai_rebate ?? 0.13),
        default_crown_rebate: Number(data?.default_crown_rebate ?? 0.02),
        default_jingcai_share: Number(data?.default_jingcai_share ?? 0),
        default_crown_share: Number(data?.default_crown_share ?? 0),
      });
    } catch {
      message.error('加载套利参数失败');
    } finally {
      setArbitrageSettingsLoading(false);
    }
  };

  const fetchData = async (targetType: OppType = oppType) => {
    setLoadingByType((prev) => ({ ...prev, [targetType]: true }));
    try {
      const endpoint = targetType === 'parlay' ? '/api/arbitrage/parlay-opportunities' : '/api/arbitrage/opportunities';
      const baseType =
        targetType === 'hg'
          ? 'hg'
          : targetType === 'goal_hedge'
          ? 'goal_hedge'
          : targetType === 'parlay'
          ? parlayBaseType
          : singleBaseType;
      const res = await axios.get(endpoint, { params: { base_type: baseType } });
      const list = Array.isArray(res.data) ? res.data : [];
      list.sort((a: any, b: any) => (b.profit_rate || 0) - (a.profit_rate || 0));
      setOpportunitiesByType((prev) => ({ ...prev, [targetType]: list }));

      if (isAdmin) {
        try {
          const health = await axios.get('/api/admin/scrape-health', { params: { limit: 10 } });
          setScrapeHealth(health.data || null);
          setScrapeHealthError('');
        } catch {
          setScrapeHealth(null);
          setScrapeHealthError('抓取健康数据加载失败');
        }
      } else {
        setScrapeHealth(null);
        setScrapeHealthError('');
      }
    } finally {
      setLoadingByType((prev) => ({ ...prev, [targetType]: false }));
    }
  };

  const handleSaveArbitrageSettings = async () => {
    Modal.confirm({
      title: '保存参数并重算？',
      content: '保存后会立即重新扫描并更新当前列表。',
      okText: '保存并重算',
      cancelText: '取消',
      onOk: async () => {
        setSavingArbitrageSettings(true);
        setCalculating(true);
        setProgress(0);
        const timer = window.setInterval(() => {
          setProgress((prev) => (prev >= 90 ? 90 : prev + 10));
        }, 150);
        try {
          try {
            await axios.post('/api/arbitrage/settings', arbitrageSettings);
          } catch {
            await axios.post('/api/settings', arbitrageSettings);
          }
          await axios.post('/api/arbitrage/rescan');
          setProgress(100);
          message.success('参数已保存并完成重算');
          await fetchData(oppType);
        } catch {
          message.error('保存或重算失败，请重试');
        } finally {
          window.clearInterval(timer);
          setCalculating(false);
          setSavingArbitrageSettings(false);
        }
      },
    });
  };

  useEffect(() => {
    fetchData(oppType);
  }, [oppType, singleBaseType, parlayBaseType, isAdmin]);

  useEffect(() => {
    fetchArbitrageSettings();
  }, [isAdmin]);

  useEffect(() => {
    setCurrentPage(1);
  }, [oppType, minProfitFilter]);

  const opportunities = opportunitiesByType[oppType] || [];
  const loading = loadingByType[oppType];

  const filtered = useMemo(
    () => opportunities.filter((item) => Number(item?.profit_rate || 0) >= minProfitFilter),
    [opportunities, minProfitFilter]
  );

  const singleFiltered = useMemo(() => {
    if (oppType !== 'single' && oppType !== 'hg' && oppType !== 'goal_hedge') return [] as any[];
    const byMatch = new Map<string, any>();
    for (const item of filtered) {
      const matchId = String(item?.match_id || '');
      if (!matchId) continue;
      const existing = byMatch.get(matchId);
      if (!existing || Number(item?.profit_rate || 0) > Number(existing?.profit_rate || 0)) {
        byMatch.set(matchId, item);
      }
    }
    return Array.from(byMatch.values()).sort((a: any, b: any) => Number(b?.profit_rate || 0) - Number(a?.profit_rate || 0));
  }, [filtered, oppType]);

  const currentDisplayRecords = oppType === 'parlay' ? filtered : singleFiltered;

  const pagedSingleRecords = useMemo(() => {
    if (oppType !== 'single' && oppType !== 'hg' && oppType !== 'goal_hedge') return [];
    const start = (currentPage - 1) * PAGE_SIZE;
    return singleFiltered.slice(start, start + PAGE_SIZE).map(normalizeSingleMatrixRecord);
  }, [currentPage, oppType, singleFiltered]);

  const pagedParlayRecords = useMemo(() => {
    if (oppType !== 'parlay') return [];
    const start = (currentPage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE).map(normalizeParlayMatrixRecord);
  }, [currentPage, filtered, oppType]);

  const openDetailModal = (type: OppType, record: any) => {
    setDetailModal({ open: true, type, record });
  };

  const closeDetailModal = () => {
    setDetailModal({ open: false, type: detailModal.type, record: null });
  };

  const renderMatrixCell = (highlightKeys: string[], cell?: MatrixCell | null, baseBg = '#fff') => {
    const active = Boolean(cell?.key && Array.isArray(highlightKeys) && highlightKeys.includes(cell.key) && Number(cell?.odds || 0) > 0);
    return (
      <td
        key={cell?.key || 'empty'}
        style={{
          border: `1px solid ${tableBorder}`,
          padding: '8px 8px',
          textAlign: 'center',
          background: active ? highlightBg : baseBg,
          color: active ? highlightText : '#222',
          fontSize: 13,
          fontWeight: active ? 700 : 500,
          minWidth: 132,
          whiteSpace: 'normal',
          overflow: 'visible',
          textOverflow: 'clip',
          wordBreak: 'break-word',
          lineHeight: 1.4,
        }}
      >
        {formatMatrixCell(cell)}
      </td>
    );
  };

  const renderSingleMatrix = () => {
    const isHgList = oppType === 'hg';
    if (loading) {
      return (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      );
    }

    if (pagedSingleRecords.length === 0) {
      return <Empty description="暂无符合条件的记录" />;
    }

    return (
      <>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', background: '#fff' }}>
            <thead>
              <tr>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 190 }}>比赛信息</th>
                <th colSpan={3} style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px' }}>{isHgList ? '皇冠' : '竞彩'}</th>
                <th colSpan={3} style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px' }}>{isHgList ? '皇冠让球' : '皇冠'}</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 96 }}>利润</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 92 }}>利润率</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedSingleRecords.map((record: any, recordIndex: number) => {
                const crownRows = Array.isArray(record?.crown_matrix?.handicapRows) ? record.crown_matrix.handicapRows : [];
                const handicapRowCount = Math.max(crownRows.length, 1);
                const totalRowSpan = isHgList ? 1 + handicapRowCount : 2 + handicapRowCount;
                const blockBg = recordIndex % 2 === 1 ? zebraBg : '#fff';
                const headBg = recordIndex % 2 === 1 ? '#efefef' : '#fcfcfd';

                if (isHgList) {
                  return (
                    <React.Fragment key={record.id}>
                      <tr>
                        <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, lineHeight: 1.55, background: blockBg }}>
                          <div>{record.league}</div>
                          <div style={{ color: teamText }}>{record.home_team}</div>
                          <div>vs</div>
                          <div style={{ color: teamText }}>{record.away_team}</div>
                          <div style={{ color: '#555' }}>{dayjs(record.match_time).format('MM-DD HH:mm')}</div>
                        </td>
                        {['胜', '平', '负'].map((label) => (
                          <td key={`hg_head_left_${record.id}_${label}`} style={{ border: `1px solid ${tableBorder}`, background: headBg, padding: '8px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
                            {label}
                          </td>
                        ))}
                        {['胜', '平', '负'].map((label) => (
                          <td key={`hg_head_right_${record.id}_${label}`} style={{ border: `1px solid ${tableBorder}`, background: headBg, padding: '8px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
                            {label}
                          </td>
                        ))}
                        <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, background: blockBg }}>
                          {Number(record.best_strategy?.min_profit || 0).toFixed(2)}
                        </td>
                        <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, color: profitRateText, background: blockBg }}>
                          {`${((record.profit_rate || 0) * 100).toFixed(2)}%`}
                        </td>
                        <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', background: blockBg }}>
                          <Button type="primary" size="small" onClick={() => openDetailModal('hg', record)} style={{ background: '#1677ff', color: '#fff', borderColor: '#1677ff' }}>
                            查看方案
                          </Button>
                        </td>
                      </tr>
                      {Array.from({ length: handicapRowCount }).map((_, index) => {
                        const crownRow = crownRows[index];
                        const leftCells = index === 0 ? [record?.crown_matrix?.standard?.W, record?.crown_matrix?.standard?.D, record?.crown_matrix?.standard?.L] : [null, null, null];
                        const rightCells = crownRow ? [crownRow.cells?.W || null, crownRow.cells?.D || null, crownRow.cells?.L || null] : [null, null, null];
                        return (
                          <tr key={`${record.id}_hg_line_${index}`}>
                            {leftCells.map((cell, cellIndex) => (
                              <React.Fragment key={`hg_left_${record.id}_${index}_${cellIndex}`}>{renderMatrixCell(record.highlight_keys, cell as MatrixCell | null, blockBg)}</React.Fragment>
                            ))}
                            {rightCells.map((cell, cellIndex) => (
                              <React.Fragment key={`hg_right_${record.id}_${index}_${cellIndex}`}>{renderMatrixCell(record.highlight_keys, cell as MatrixCell | null, blockBg)}</React.Fragment>
                            ))}
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                }

                return (
                  <React.Fragment key={record.id}>
                    <tr>
                      <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, lineHeight: 1.55, background: blockBg }}>
                        <div>{record.league}</div>
                        <div style={{ color: teamText }}>{record.home_team}</div>
                        <div>vs</div>
                        <div style={{ color: teamText }}>{record.away_team}</div>
                        <div style={{ color: '#555' }}>{dayjs(record.match_time).format('MM-DD HH:mm')}</div>
                      </td>
                      {['胜', '平', '负'].map((label) => (
                        <td key={`jc_head_${label}`} style={{ border: `1px solid ${tableBorder}`, background: headBg, padding: '8px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
                          {label}
                        </td>
                      ))}
                      {['胜', '平', '负'].map((label) => (
                        <td key={`crown_head_${label}`} style={{ border: `1px solid ${tableBorder}`, background: headBg, padding: '8px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
                          {label}
                        </td>
                      ))}
                      <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, background: blockBg }}>
                        {Number(record.best_strategy?.min_profit || 0).toFixed(2)}
                      </td>
                      <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, color: profitRateText, background: blockBg }}>
                        {`${((record.profit_rate || 0) * 100).toFixed(2)}%`}
                      </td>
                      <td rowSpan={totalRowSpan} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', background: blockBg }}>
                        <Button type="primary" size="small" onClick={() => openDetailModal('single', record)} style={{ background: '#1677ff', color: '#fff', borderColor: '#1677ff' }}>
                          查看方案
                        </Button>
                      </td>
                    </tr>
                    <tr>
                      {renderMatrixCell(record.highlight_keys, record?.jc_matrix?.standard?.W, blockBg)}
                      {renderMatrixCell(record.highlight_keys, record?.jc_matrix?.standard?.D, blockBg)}
                      {renderMatrixCell(record.highlight_keys, record?.jc_matrix?.standard?.L, blockBg)}
                      {renderMatrixCell(record.highlight_keys, record?.crown_matrix?.standard?.W, blockBg)}
                      {renderMatrixCell(record.highlight_keys, record?.crown_matrix?.standard?.D, blockBg)}
                      {renderMatrixCell(record.highlight_keys, record?.crown_matrix?.standard?.L, blockBg)}
                    </tr>
                    {Array.from({ length: handicapRowCount }).map((_, index) => {
                      const jcHandicapCells = index === 0 ? [record?.jc_matrix?.handicap?.W, record?.jc_matrix?.handicap?.D, record?.jc_matrix?.handicap?.L] : [null, null, null];
                      const crownRow = crownRows[index];
                      const crownHandicapCells = crownRow ? [crownRow.cells?.W || null, crownRow.cells?.D || null, crownRow.cells?.L || null] : [null, null, null];
                      return (
                        <tr key={`${record.id}_handicap_${index}`}>
                          {jcHandicapCells.map((cell, cellIndex) => (
                            <React.Fragment key={`jc_${record.id}_${index}_${cellIndex}`}>{renderMatrixCell(record.highlight_keys, cell as MatrixCell | null, blockBg)}</React.Fragment>
                          ))}
                          {crownHandicapCells.map((cell, cellIndex) => (
                            <React.Fragment key={`crown_${record.id}_${index}_${cellIndex}`}>{renderMatrixCell(record.highlight_keys, cell as MatrixCell | null, blockBg)}</React.Fragment>
                          ))}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Pagination
            current={currentPage}
            pageSize={PAGE_SIZE}
            total={singleFiltered.length}
            onChange={setCurrentPage}
            showSizeChanger={false}
          />
        </div>
      </>
    );
  };

  const renderGoalHedgeMatrix = () => {
    if (loading) {
      return (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      );
    }

    if (pagedSingleRecords.length === 0) {
      return <Empty description="暂无符合条件的进球对冲机会" />;
    }

    return (
      <>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', background: '#fff' }}>
            <thead>
              <tr>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 190 }}>比赛信息</th>
                <th colSpan={3} style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px' }}>竞彩</th>
                <th colSpan={2} style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px' }}>皇冠</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 96 }}>利润</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 92 }}>利润率</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedSingleRecords.map((record: any, recordIndex: number) => {
                const goals = parseGoalRows(record?.c_goal);
                const ouRows = parseOuRows(record?.c_ou);
                const goalMatrix = chunkRows(goals, 3);
                const ouMatrix = chunkRows(ouRows, 2);
                const rowCount = Math.max(goalMatrix.length || 1, ouMatrix.length || 1);
                const blockBg = recordIndex % 2 === 1 ? zebraBg : '#fff';
                const selectedGoalKeys = Array.isArray(record?.best_strategy?.goal_hedge_meta?.goal_picks)
                  ? record.best_strategy.goal_hedge_meta.goal_picks.map((item: any) => normalizeGoalKey(String(item?.label || item?.goal_index || '')))
                  : [];
                const selectedOuLine = normalizeOuLineKey(String(record?.best_strategy?.goal_hedge_meta?.ou_bet?.line || ''));
                const selectedOuSide = String(record?.best_strategy?.goal_hedge_meta?.ou_bet?.side || '').toLowerCase();

                return (
                  <React.Fragment key={record.id}>
                    {Array.from({ length: rowCount }).map((_, rowIdx) => {
                      const goalRow = goalMatrix[rowIdx] || [];
                      const ouRow = ouMatrix[rowIdx] || [];
                      return (
                        <tr key={`${record.id}_goal_hedge_${rowIdx}`}>
                          {rowIdx === 0 ? (
                            <td
                              rowSpan={rowCount}
                              style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, lineHeight: 1.55, background: blockBg }}
                            >
                              <div>{record.league}</div>
                              <div style={{ color: teamText }}>{record.home_team}</div>
                              <div>vs</div>
                              <div style={{ color: teamText }}>{record.away_team}</div>
                              <div style={{ color: '#555' }}>{dayjs(record.match_time).format('MM-DD HH:mm')}</div>
                            </td>
                          ) : null}

                          {Array.from({ length: 3 }).map((_, colIdx) => {
                            const item = goalRow[colIdx];
                            if (!item) {
                              return <td key={`${record.id}_goal_empty_${rowIdx}_${colIdx}`} style={{ border: `1px solid ${tableBorder}`, padding: '8px 8px', background: blockBg }} />;
                            }
                            const active = selectedGoalKeys.includes(normalizeGoalKey(item.label));
                            return (
                              <td
                                key={`${record.id}_goal_${rowIdx}_${colIdx}`}
                                style={{
                                  border: `1px solid ${tableBorder}`,
                                  padding: '8px 8px',
                                  textAlign: 'center',
                                  background: active ? highlightBg : blockBg,
                                  color: active ? highlightText : '#222',
                                  fontSize: 13,
                                  fontWeight: active ? 700 : 500,
                                }}
                              >
                                ({item.label}) @{Number(item.odds).toFixed(2)}
                              </td>
                            );
                          })}

                          {Array.from({ length: 2 }).map((_, colIdx) => {
                            const item = ouRow[colIdx];
                            if (!item) {
                              return <td key={`${record.id}_ou_empty_${rowIdx}_${colIdx}`} style={{ border: `1px solid ${tableBorder}`, padding: '8px 8px', background: blockBg }} />;
                            }
                            const active =
                              selectedOuLine &&
                              selectedOuSide &&
                              selectedOuLine === normalizeOuLineKey(item.line) &&
                              selectedOuSide === item.side;
                            return (
                              <td
                                key={`${record.id}_ou_${rowIdx}_${colIdx}`}
                                style={{
                                  border: `1px solid ${tableBorder}`,
                                  padding: '8px 8px',
                                  textAlign: 'center',
                                  background: active ? highlightBg : blockBg,
                                  color: active ? highlightText : '#222',
                                  fontSize: 13,
                                  fontWeight: active ? 700 : 500,
                                }}
                              >
                                ({item.label}) @{Number(item.odds).toFixed(2)}
                              </td>
                            );
                          })}

                          {rowIdx === 0 ? (
                            <>
                              <td rowSpan={rowCount} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, background: blockBg }}>
                                {Number(record.best_strategy?.min_profit || 0).toFixed(2)}
                              </td>
                              <td rowSpan={rowCount} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, color: profitRateText, background: blockBg }}>
                                {`${((record.profit_rate || 0) * 100).toFixed(2)}%`}
                              </td>
                              <td rowSpan={rowCount} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', background: blockBg }}>
                                <Button type="primary" size="small" onClick={() => openDetailModal('goal_hedge', record)} style={{ background: '#1677ff', color: '#fff', borderColor: '#1677ff' }}>
                                  查看方案
                                </Button>
                              </td>
                            </>
                          ) : null}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Pagination current={currentPage} pageSize={PAGE_SIZE} total={singleFiltered.length} onChange={setCurrentPage} showSizeChanger={false} />
        </div>
      </>
    );
  };

  const renderParlayBlock = (
    record: any,
    matchIndex: 1 | 2,
    info: { league: string; home: string; away: string; matchTime: string },
    matrix: any,
    blockBg: string,
    headBg: string
  ) => {
    const activeKeys = Array.isArray(matrix?.highlight_keys) ? matrix.highlight_keys : [];
    const crownHandicapCells = matrix?.crown?.handicap?.cells || { W: null, D: null, L: null };

    return (
      <React.Fragment key={`${record.id}_match_${matchIndex}`}>
        <tr>
          <td
            rowSpan={3}
            style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, lineHeight: 1.5, background: blockBg }}
          >
            <div>{info.league}</div>
            <div style={{ color: teamText, textDecoration: 'underline' }}>{info.home}</div>
            <div>vs</div>
            <div style={{ color: teamText, textDecoration: 'underline' }}>{info.away}</div>
            <div style={{ color: '#555' }}>{dayjs(info.matchTime).format('YYYY-MM-DD HH:mm')}</div>
          </td>
          {['胜', '平', '负'].map((label) => (
            <td key={`${record.id}_${matchIndex}_jc_head_${label}`} style={{ border: `1px solid ${tableBorder}`, background: headBg, padding: '8px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
              {label}
            </td>
          ))}
          {['胜', '平', '负'].map((label) => (
            <td key={`${record.id}_${matchIndex}_crown_head_${label}`} style={{ border: `1px solid ${tableBorder}`, background: headBg, padding: '8px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
              {label}
            </td>
          ))}
          {matchIndex === 1 ? (
            <>
              <td rowSpan={6} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, background: blockBg }}>
                {Number(record.best_strategy?.min_profit || record.profit || 0).toFixed(2)}
              </td>
              <td rowSpan={6} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 15, fontWeight: 600, color: profitRateText, background: blockBg }}>
                {`${((record.profit_rate || 0) * 100).toFixed(2)}%`}
              </td>
              <td rowSpan={6} style={{ border: `1px solid ${tableBorder}`, padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', background: blockBg }}>
                <Button type="primary" size="small" onClick={() => openDetailModal('parlay', record)} style={{ background: '#1677ff', color: '#fff', borderColor: '#1677ff' }}>
                  查看方案
                </Button>
              </td>
            </>
          ) : null}
        </tr>
        <tr>
          {renderMatrixCell(activeKeys, matrix?.jc?.standard?.W, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.jc?.standard?.D, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.jc?.standard?.L, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.crown?.standard?.W, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.crown?.standard?.D, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.crown?.standard?.L, blockBg)}
        </tr>
        <tr>
          {renderMatrixCell(activeKeys, matrix?.jc?.handicap?.W, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.jc?.handicap?.D, blockBg)}
          {renderMatrixCell(activeKeys, matrix?.jc?.handicap?.L, blockBg)}
          {renderMatrixCell(activeKeys, crownHandicapCells.W, blockBg)}
          {renderMatrixCell(activeKeys, crownHandicapCells.D, blockBg)}
          {renderMatrixCell(activeKeys, crownHandicapCells.L, blockBg)}
        </tr>
      </React.Fragment>
    );
  };

  const renderParlayMatrix = () => {
    if (loading) {
      return (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      );
    }

    if (pagedParlayRecords.length === 0) {
      return <Empty description="暂无符合条件的套利机会" />;
    }

    return (
      <>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', background: '#fff' }}>
            <thead>
              <tr>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 170 }}>比赛信息</th>
                <th colSpan={3} style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px' }}>竞彩</th>
                <th colSpan={3} style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px' }}>皇冠</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 96 }}>利润</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 92 }}>利润率</th>
                <th style={{ border: `1px solid ${tableBorder}`, background: headerBg, padding: '14px 10px', width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedParlayRecords.map((record: any, recordIndex: number) => {
                const blockBg = recordIndex % 2 === 1 ? zebraBg : '#fff';
                const headBg = recordIndex % 2 === 1 ? '#efefef' : '#fcfcfd';
                return (
                <React.Fragment key={record.id}>
                  {renderParlayBlock(
                    record,
                    1,
                    {
                      league: record.league_1,
                      home: record.home_team_1,
                      away: record.away_team_1,
                      matchTime: record.match_time_1,
                    },
                    record.match_1_matrix,
                    blockBg,
                    headBg
                  )}
                  {renderParlayBlock(
                    record,
                    2,
                    {
                      league: record.league_2,
                      home: record.home_team_2,
                      away: record.away_team_2,
                      matchTime: record.match_time_2,
                    },
                    record.match_2_matrix,
                    blockBg,
                    headBg
                  )}
                </React.Fragment>
              )})}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Pagination current={currentPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setCurrentPage} showSizeChanger={false} />
        </div>
      </>
    );
  };

  const modalTitle =
    detailModal.type === 'parlay'
      ? `二串一方案：${detailModal.record?.home_team_1 || ''} vs ${detailModal.record?.away_team_1 || ''} × ${detailModal.record?.home_team_2 || ''} vs ${detailModal.record?.away_team_2 || ''}`
      : `${detailModal.type === 'hg' ? 'HG对冲方案' : detailModal.type === 'goal_hedge' ? '进球对冲方案' : '单场方案'}：${detailModal.record?.home_team || ''} vs ${detailModal.record?.away_team || ''}`;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <Title level={3} style={{ marginBottom: 24 }}>
        主控面板
      </Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic title="今日扫描比赛" value={opportunities.length * 3 + 12} prefix={<RocketOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic title="套利机会" value={currentDisplayRecords.length} prefix={<FireOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic
              title="最高利润率"
              value={currentDisplayRecords.length > 0 ? (Math.max(...currentDisplayRecords.map((o) => o.profit_rate || 0)) * 100).toFixed(2) : 0}
              suffix="%"
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card variant="borderless">
            <Statistic title="系统状态" value="正常" prefix={<CheckCircleOutlined />} />
          </Card>
        </Col>
      </Row>

      {
        <Card
          title="套利参数（返水 / 占比）"
          extra={
            <Space>
              {calculating && <Progress percent={progress} size="small" style={{ width: 180 }} />}
              <Button
                type="primary"
                onClick={handleSaveArbitrageSettings}
                loading={savingArbitrageSettings}
                disabled={arbitrageSettingsLoading}
              >
                保存并重算
              </Button>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Row gutter={[16, 16]} align="middle">
            <Col xs={24} sm={12} md={6}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Text style={{ whiteSpace: 'nowrap' }}>竞彩返水（%）</Text>
                <InputNumber
                style={{ flex: 1 }}
                min={0}
                max={100}
                precision={2}
                value={Number((arbitrageSettings.default_jingcai_rebate * 100).toFixed(2))}
                disabled={arbitrageSettingsLoading || savingArbitrageSettings}
                onChange={(value) =>
                  setArbitrageSettings((prev) => ({
                    ...prev,
                    default_jingcai_rebate: Number(value || 0) / 100,
                  }))
                }
              />
              </div>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Text style={{ whiteSpace: 'nowrap' }}>皇冠返水（%）</Text>
                <InputNumber
                style={{ flex: 1 }}
                min={0}
                max={100}
                precision={2}
                value={Number((arbitrageSettings.default_crown_rebate * 100).toFixed(2))}
                disabled={arbitrageSettingsLoading || savingArbitrageSettings}
                onChange={(value) =>
                  setArbitrageSettings((prev) => ({
                    ...prev,
                    default_crown_rebate: Number(value || 0) / 100,
                  }))
                }
              />
              </div>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Text style={{ whiteSpace: 'nowrap' }}>竞彩占比（%）</Text>
                <InputNumber
                style={{ flex: 1 }}
                min={0}
                max={100}
                precision={1}
                value={Number((arbitrageSettings.default_jingcai_share * 100).toFixed(1))}
                disabled={arbitrageSettingsLoading || savingArbitrageSettings}
                onChange={(value) =>
                  setArbitrageSettings((prev) => ({
                    ...prev,
                    default_jingcai_share: Number(value || 0) / 100,
                  }))
                }
              />
              </div>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Text style={{ whiteSpace: 'nowrap' }}>皇冠占比（%）</Text>
                <InputNumber
                style={{ flex: 1 }}
                min={0}
                max={100}
                precision={1}
                value={Number((arbitrageSettings.default_crown_share * 100).toFixed(1))}
                disabled={arbitrageSettingsLoading || savingArbitrageSettings}
                onChange={(value) =>
                  setArbitrageSettings((prev) => ({
                    ...prev,
                    default_crown_share: Number(value || 0) / 100,
                  }))
                }
              />
              </div>
            </Col>
          </Row>
        </Card>
      }

      <Card
        title={
          <Space size="large">
            <Select
              value={oppType}
              style={{ width: 130 }}
              onChange={(val) => setOppType(val)}
              options={[
                { value: 'single', label: '单场' },
                { value: 'hg', label: 'HG对冲' },
                { value: 'goal_hedge', label: '进球对冲' },
                { value: 'parlay', label: '二串一' },
              ]}
            />
            {oppType === 'single' ? (
              <Select
                value={singleBaseType}
                style={{ width: 120 }}
                onChange={(val) => setSingleBaseType(val)}
                options={[
                  { value: 'jingcai', label: '竞彩口径' },
                  { value: 'crown', label: '皇冠口径' },
                ]}
              />
            ) : null}
            <Select
              value={minProfitFilter}
              style={{ width: 120 }}
              onChange={setMinProfitFilter}
              options={[
                { value: 0, label: '全部' },
                { value: 0.005, label: '> 0.5%' },
                { value: 0.01, label: '> 1.0%' },
                { value: 0.015, label: '> 1.5%' },
                { value: 0.02, label: '> 2.0%' },
              ]}
            />
          </Space>
        }
      >
        {oppType === 'single' || oppType === 'hg' ? (
          renderSingleMatrix()
        ) : oppType === 'goal_hedge' ? (
          renderGoalHedgeMatrix()
        ) : (
          renderParlayMatrix()
        )}
      </Card>

      {isAdmin ? (
        <Card title="抓取健康趋势（最近10轮）" style={{ marginTop: 16 }}>
          {scrapeHealth && Array.isArray(scrapeHealth.rows) && scrapeHealth.rows.length > 0 ? (
            <>
              <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                <Col span={6}>
                  <Statistic title="成功轮次" value={`${scrapeHealth.stats?.success || 0}/${scrapeHealth.stats?.total || 0}`} />
                </Col>
                <Col span={6}>
                  <Statistic title="跳过轮次" value={scrapeHealth.stats?.skipped || 0} />
                </Col>
                <Col span={6}>
                  <Statistic title="Playwright兜底次数" value={scrapeHealth.stats?.playwright_used || 0} />
                </Col>
                <Col span={6}>
                  <Statistic title="平均耗时" value={scrapeHealth.stats?.avg_duration_ms || 0} suffix="ms" />
                </Col>
              </Row>
              <Table
                size="small"
                pagination={false}
                rowKey="id"
                dataSource={scrapeHealth.rows}
                columns={[
                  { title: '时间', dataIndex: 'created_at', key: 'created_at', render: (v: string) => dayjs(v).format('MM-DD HH:mm:ss') },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    key: 'status',
                    render: (v: string) => <Tag color={v === 'ok' || v === 'unchanged' ? 'green' : 'red'}>{v}</Tag>,
                  },
                  { title: '场次', key: 'counts', render: (_: any, r: any) => `${r.synced_total}/${r.filtered_total}/${r.fetched_total}` },
                  {
                    title: 'HGA',
                    dataIndex: 'hga_status',
                    key: 'hga_status',
                    render: (v: string) => <Tag color={v === 'ok' ? 'green' : 'red'}>{v || '-'}</Tag>,
                  },
                  { title: '兜底', dataIndex: 'playwright_fallback_used', key: 'playwright_fallback_used', render: (v: number) => (v ? '是' : '否') },
                  { title: '耗时', dataIndex: 'duration_ms', key: 'duration_ms', render: (v: number) => `${v || 0}ms` },
                ]}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                场次列：同步入库/过滤后/原始抓取
              </Text>
            </>
          ) : (
            <Empty description={scrapeHealthError || '暂无抓取健康数据，点击“重新扫描”后会产生记录'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>
      ) : null}

      <Modal
        title={<span style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>{modalTitle}</span>}
        open={detailModal.open}
        onCancel={closeDetailModal}
        footer={null}
        width={1360}
        destroyOnHidden
        styles={{ body: { maxHeight: '80vh', overflowY: 'auto', paddingTop: 12 } }}
      >
        {detailModal.record ? (
          detailModal.type === 'parlay' ? (
            <ParlayPlanDetailContent id={String(detailModal.record.id)} initialBaseType={parlayBaseType} showTitle={false} />
          ) : detailModal.type === 'hg' ? (
            <HgPlanDetailContent matchId={detailModal.record.match_id} initialStrategy={detailModal.record?.best_strategy || null} showTitle={false} />
          ) : detailModal.type === 'goal_hedge' ? (
            <GoalHedgePlanDetailContent
              matchId={detailModal.record.match_id}
              initialStrategy={detailModal.record?.best_strategy || null}
              showTitle={false}
            />
          ) : (
            <SinglePlanDetailContent
              matchId={detailModal.record.match_id}
              initialBaseType={singleBaseType}
              showTitle={false}
            />
          )
        ) : null}
      </Modal>
    </div>
  );
};

export default Dashboard;

