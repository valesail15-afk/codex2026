import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Card, Col, Empty, Form, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import axios from 'axios';
import type { HedgeStrategy } from '../types';
import { invertHandicap, normalizeCrownTarget, parseHandicap } from '../shared/oddsText';
import { parseCrownBetTypeCompat } from '../shared/crownBetTypeCompat';
import { matrixTableStyle, matrixWrapStyle, MATRIX_UI } from '../shared/matrixUi';
import { OUTCOME_CN, TERMS, currency, signedCurrency } from '../shared/terminology';
import BetStakeCalculatorModal from './BetStakeCalculatorModal';

const { Title, Text } = Typography;

type Side = 'W' | 'D' | 'L';
type Market = 'normal' | 'handicap';
type BaseType = 'jingcai' | 'crown';

const rateHot = (r: number) => Number(r || 0) >= 0.005;
const summaryBlue = '#1677ff';
const EPS = 1e-6;

const parseCrownHandicapRows = (raw: any) => {
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

const formatPercent = (value: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;

const isUnavailableHandicapLine = (value: any) => {
  const text = String(value || '').trim();
  return !text || text === '-' || text === '未开售';
};

const resolveJcHandicapLine = (record: any) => {
  const jc = String(record?.jc_handicap || record?.j_h || '').trim();
  if (!isUnavailableHandicapLine(jc)) return jc;
  const fallback = String(record?.handicap || '').trim();
  if (!isUnavailableHandicapLine(fallback)) return fallback;
  return '0';
};

const formatJcSideLabel = (side: Side, market: Market, line: string) => {
  if (market === 'normal') {
    if (side === 'W') return '主胜';
    if (side === 'D') return '平局';
    return '客胜';
  }
  if (side === 'W') return `主胜(${line})`;
  if (side === 'D') return `平局(${line})`;
  return `客胜(${invertHandicap(line)})`;
};

const getCrownGrossReturn = (type: string, odds: number, amount: number, dg: number): number => {
  const o = Number(odds || 0);
  const a = Number(amount || 0);
  if (a <= 0 || o <= 0) return 0;

  const bet = parseCrownBetTypeCompat(type);
  const side: Side = bet.side === 'home' ? 'W' : bet.side === 'draw' ? 'D' : 'L';

  if (bet.kind === 'std') {
    const hit = side === 'W' ? dg > 0 : side === 'D' ? dg === 0 : dg < 0;
    return hit ? a * o : 0;
  }

  if (side === 'D') {
    const score = Number(bet.handicap || 0) - Math.abs(dg);
    if (score >= 0.5) return a * (1 + o);
    if (score === 0.25) return a * (1 + o / 2);
    if (score === 0) return a;
    if (score === -0.25) return a * 0.5;
    return 0;
  }

  const score = side === 'W' ? dg + Number(bet.handicap || 0) : -dg + Number(bet.handicap || 0);
  if (score >= 0.5) return a * (1 + o);
  if (score === 0.25) return a * (1 + o / 2);
  if (score === 0) return a;
  if (score === -0.25) return a * 0.5;
  return 0;
};

export interface SinglePlanDetailContentProps {
  matchId?: string;
  initialBaseType?: BaseType;
  showTitle?: boolean;
  onLoaded?: () => void;
}

const SinglePlanDetailContent: React.FC<SinglePlanDetailContentProps> = ({
  matchId,
  initialBaseType = 'jingcai',
  showTitle = true,
  onLoaded,
}) => {
  const { message } = App.useApp();
  const [form] = Form.useForm();

  const [loading, setLoading] = useState(false);
  const [matchInfo, setMatchInfo] = useState<any>(null);
  const [settingsMeta, setSettingsMeta] = useState({ jcShare: 0, crownShare: 0, jcRebate: 0.13, crownRebate: 0.02 });
  const [strategies, setStrategies] = useState<HedgeStrategy[]>([]);
  const [selected, setSelected] = useState<HedgeStrategy | null>(null);
  const [optionMeta, setOptionMeta] = useState<Record<string, { hasPlan: boolean; bestRate: number; list: HedgeStrategy[] }>>({});
  const [baseTypeAvailability, setBaseTypeAvailability] = useState<Record<BaseType, boolean>>({ jingcai: true, crown: true });
  const loadedNotifiedRef = useRef(false);

  const initialUnit = 10000;

  const jcOptions = useMemo(() => {
    if (!matchInfo) return [];
    const line = resolveJcHandicapLine(matchInfo);
    const list: Array<{ value: string; label: string; betLabel: string; side: Side; market: Market; odds: number }> = [
      { value: 'normal_W', label: `${formatJcSideLabel('W', 'normal', line)} ${matchInfo.j_w || '-'}`, betLabel: formatJcSideLabel('W', 'normal', line), side: 'W', market: 'normal', odds: Number(matchInfo.j_w || 0) },
      { value: 'normal_D', label: `${formatJcSideLabel('D', 'normal', line)} ${matchInfo.j_d || '-'}`, betLabel: formatJcSideLabel('D', 'normal', line), side: 'D', market: 'normal', odds: Number(matchInfo.j_d || 0) },
      { value: 'normal_L', label: `${formatJcSideLabel('L', 'normal', line)} ${matchInfo.j_l || '-'}`, betLabel: formatJcSideLabel('L', 'normal', line), side: 'L', market: 'normal', odds: Number(matchInfo.j_l || 0) },
    ];
    if (Number(matchInfo.j_hw || 0) > 1) list.push({ value: 'handicap_W', label: `${formatJcSideLabel('W', 'handicap', line)} ${matchInfo.j_hw}`, betLabel: formatJcSideLabel('W', 'handicap', line), side: 'W', market: 'handicap', odds: Number(matchInfo.j_hw || 0) });
    if (Number(matchInfo.j_hd || 0) > 1) list.push({ value: 'handicap_D', label: `${formatJcSideLabel('D', 'handicap', line)} ${matchInfo.j_hd}`, betLabel: formatJcSideLabel('D', 'handicap', line), side: 'D', market: 'handicap', odds: Number(matchInfo.j_hd || 0) });
    if (Number(matchInfo.j_hl || 0) > 1) list.push({ value: 'handicap_L', label: `${formatJcSideLabel('L', 'handicap', line)} ${matchInfo.j_hl}`, betLabel: formatJcSideLabel('L', 'handicap', line), side: 'L', market: 'handicap', odds: Number(matchInfo.j_hl || 0) });
    return list;
  }, [matchInfo]);

  const calculateSingle = async (pick: string, baseType: BaseType, integerUnit: number) => {
    if (!matchId || !pick) return [] as HedgeStrategy[];
    const [market, side] = String(pick).split('_') as [Market, Side];
    const res = await axios.post('/api/arbitrage/calculate', {
      match_id: matchId,
      jingcai_side: side,
      jingcai_market: market,
      jingcai_amount: integerUnit,
      base_type: baseType,
      integer_unit: integerUnit,
    });
    const list = (Array.isArray(res.data) ? res.data : []).filter((s: HedgeStrategy) => {
      return Number(s?.profits?.win || 0) > 0.01 && Number(s?.profits?.draw || 0) > 0.01 && Number(s?.profits?.lose || 0) > 0.01;
    });
    list.sort((a: HedgeStrategy, b: HedgeStrategy) => (b.min_profit_rate || 0) - (a.min_profit_rate || 0));
    return list;
  };

  const detectBaseTypeAvailability = async (
    currentBaseType: BaseType,
    integerUnit: number,
    currentEntries?: ReadonlyArray<readonly [string, { hasPlan: boolean; bestRate: number; list: HedgeStrategy[] }]>
  ) => {
    const summarize = (entries: ReadonlyArray<readonly [string, { hasPlan: boolean; bestRate: number; list: HedgeStrategy[] }]>) =>
      entries.some(([, meta]) => meta.hasPlan);

    const currentHasPlan = currentEntries ? summarize(currentEntries) : false;
    const otherBaseType: BaseType = currentBaseType === 'jingcai' ? 'crown' : 'jingcai';

    const otherEntries = await Promise.all(
      jcOptions.map(async (opt) => {
        try {
          const list = await calculateSingle(opt.value, otherBaseType, integerUnit);
          return [opt.value, { hasPlan: list.length > 0, bestRate: Number(list[0]?.min_profit_rate || 0), list }] as const;
        } catch {
          return [opt.value, { hasPlan: false, bestRate: 0, list: [] as HedgeStrategy[] }] as const;
        }
      })
    );

    return {
      jingcai: currentBaseType === 'jingcai' ? currentHasPlan : summarize(otherEntries),
      crown: currentBaseType === 'crown' ? currentHasPlan : summarize(otherEntries),
    } satisfies Record<BaseType, boolean>;
  };

  const refreshAllOptions = async (baseType: BaseType, integerUnit: number) => {
    if (!matchId || jcOptions.length === 0) return;
    setLoading(true);
    try {
      const entries = await Promise.all(
        jcOptions.map(async (opt) => {
          try {
            const list = await calculateSingle(opt.value, baseType, integerUnit);
            return [opt.value, { hasPlan: list.length > 0, bestRate: Number(list[0]?.min_profit_rate || 0), list }] as const;
          } catch {
            return [opt.value, { hasPlan: false, bestRate: 0, list: [] as HedgeStrategy[] }] as const;
          }
        })
      );

      const meta = Object.fromEntries(entries);
      setOptionMeta(meta);
      setBaseTypeAvailability(await detectBaseTypeAvailability(baseType, integerUnit, entries));

      const best = entries
        .filter(([, v]) => v.hasPlan)
        .sort((a, b) => b[1].bestRate - a[1].bestRate)[0];

      if (!best) {
        form.setFieldValue('jc_pick', undefined);
        setStrategies([]);
        setSelected(null);
        return;
      }

      const bestPick = best[0];
      const bestList = best[1].list;
      form.setFieldValue('jc_pick', bestPick);
      setStrategies(bestList);
      setSelected(bestList[0] || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!matchId) return;
    loadedNotifiedRef.current = false;
    (async () => {
      const [matchRes, settingRes] = await Promise.all([axios.get(`/api/matches/${matchId}`), axios.get('/api/settings')]);
      setMatchInfo(matchRes.data);
      setSettingsMeta({
        jcShare: Number(settingRes.data?.default_jingcai_share || 0),
        crownShare: Number(settingRes.data?.default_crown_share || 0),
        jcRebate: Number(settingRes.data?.default_jingcai_rebate || 0.13),
        crownRebate: Number(settingRes.data?.default_crown_rebate || 0.02),
      });
      form.setFieldsValue({ base_type: initialBaseType, integer_unit: initialUnit });
    })().catch(() => {
      message.error('加载比赛信息失败');
    });
  }, [form, initialBaseType, matchId, message, onLoaded]);

  useEffect(() => {
    if (!matchInfo || loadedNotifiedRef.current) return;
    loadedNotifiedRef.current = true;
    onLoaded?.();
  }, [matchInfo, onLoaded]);

  useEffect(() => {
    if (!matchInfo || jcOptions.length === 0) return;
    const bt = (form.getFieldValue('base_type') || initialBaseType) as BaseType;
    const unit = Number(form.getFieldValue('integer_unit') || initialUnit);
    refreshAllOptions(bt, unit).catch(() => {});
  }, [form, initialBaseType, jcOptions.length, matchInfo]);

  const handleValuesChange = async (
    changed: { jc_pick?: string; base_type?: BaseType; integer_unit?: number },
    all: { jc_pick?: string; base_type?: BaseType; integer_unit?: number }
  ) => {
    const baseType = (all.base_type || initialBaseType) as BaseType;
    const integerUnit = Number(all.integer_unit || initialUnit);

    if (changed.base_type === 'crown' && !baseTypeAvailability.crown) {
      form.setFieldValue('base_type', 'jingcai');
      message.warning('当前没有可用的皇冠整单方案，已切回竞彩');
      await refreshAllOptions('jingcai', integerUnit);
      return;
    }

    if (changed.base_type !== undefined || changed.integer_unit !== undefined) {
      await refreshAllOptions(baseType, integerUnit);
      return;
    }

    if (!all.jc_pick) {
      await refreshAllOptions(baseType, integerUnit);
      return;
    }

    const list = await calculateSingle(all.jc_pick, baseType, integerUnit);
    setStrategies(list);
    setSelected(list[0] || null);
  };

  const selectedPick = Form.useWatch('jc_pick', form);

  const currentPickedOption = useMemo(() => {
    const byForm = jcOptions.find((x) => x.value === selectedPick);
    if (byForm) return byForm;
    if (!selected) return undefined;

    const market = (selected.jc_market || 'normal') as Market;
    const side = (selected.jcSide || 'W') as Side;
    const byStrategy = jcOptions.find((x) => x.market === market && x.side === side);
    if (byStrategy) return byStrategy;

    const jcOdds = Number(selected.jc_odds || 0);
    if (jcOdds > 0) {
      return jcOptions.find((x) => Math.abs(Number(x.odds || 0) - jcOdds) < 0.0001);
    }

    return undefined;
  }, [jcOptions, selected, selectedPick]);

  const getJcAmount = (s: HedgeStrategy) => {
    const crown = (s.crown_bets || []).reduce((sum, b) => sum + Number(b.amount || 0), 0);
    return Math.max(0, Number(s.user_invest || 0) - crown);
  };

  const getCurrentJcOdds = (s: HedgeStrategy) => {
    if (currentPickedOption && currentPickedOption.odds > 0) return currentPickedOption.odds;
    return Number(s.jc_odds || 0);
  };

  const betRows = useMemo(() => {
    if (!selected) return [];
    const jcAmt = getJcAmount(selected);
    return [
      {
        key: 'jc',
        platform: '竞彩',
        target: currentPickedOption?.betLabel || '竞彩',
        odds: getCurrentJcOdds(selected),
        amount: jcAmt,
        share: settingsMeta.jcShare,
        realAmount: jcAmt / Math.max(1 - settingsMeta.jcShare, 0.0001),
      },
      ...((selected.crown_bets || []).map((b, i) => {
        const amt = Number(b.amount || 0);
        return {
          key: `c_${i}`,
          platform: '皇冠',
          target: normalizeCrownTarget(String(b.type || '')),
          odds: Number(b.odds || 0),
          amount: amt,
          share: settingsMeta.crownShare,
          realAmount: amt / Math.max(1 - settingsMeta.crownShare, 0.0001),
        };
      }) as any[]),
    ];
  }, [currentPickedOption, selected, settingsMeta]);

  const realInvestTotal = useMemo(() => betRows.reduce((sum, row: any) => sum + Number(row.realAmount || 0), 0), [betRows]);

  const outcomeRows = useMemo(() => {
    if (!selected) return [] as any[];

    const picked = currentPickedOption;
    const jcSide = (picked?.side || selected.jcSide || 'W') as Side;
    const jcMarket = (picked?.market || selected.jc_market || 'normal') as Market;
    const jcLine = resolveJcHandicapLine(matchInfo);
    const jcOdds = getCurrentJcOdds(selected);
    const crownBets = selected.crown_bets || [];
    const invest = Number(selected.user_invest || 0);

    const jcHit = (dg: number) => {
      if (jcMarket === 'normal') return jcSide === 'W' ? dg > 0 : jcSide === 'D' ? dg === 0 : dg < 0;
      const adjusted = dg + parseHandicap(jcLine);
      const outcome: Side = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
      return outcome === jcSide;
    };

    const classifyCrownOutcomeStatus = (
      parsed: ReturnType<typeof parseCrownBetTypeCompat>,
      ret: number,
      amount: number,
      odds: number
    ): 'win' | 'half_win' | 'push' | 'half_lose' | 'lose' => {
      if (ret <= EPS) return 'lose';
      if (parsed.kind !== 'ah') return 'win';
      if (Math.abs(ret - amount) <= EPS) return 'push';
      if (ret < amount - EPS) return 'half_lose';
      if (ret > amount + EPS && ret < amount * (1 + odds) - EPS) return 'half_win';
      return 'win';
    };

    const statusLabel = (status: 'win' | 'half_win' | 'push' | 'half_lose' | 'lose') => {
      if (status === 'win') return '中';
      if (status === 'half_win') return '赢半';
      if (status === 'push') return '走水';
      if (status === 'half_lose') return '输半';
      return '亏完';
    };

    const formatGoalDiff = (dg: number) => {
      if (dg > 0) return `主胜净胜${dg}球`;
      if (dg < 0) return `客胜净胜${Math.abs(dg)}球`;
      return '平局';
    };

    const outcomeDiffs: Record<'win' | 'draw' | 'lose', number[]> = {
      win: [1, 2, 3, 4],
      draw: [0],
      lose: [-1, -2, -3, -4],
    };

    const buildRow = (key: 'win' | 'draw' | 'lose', title: string, color: string) => {
      const dgs = outcomeDiffs[key];
      const jcStake = Number(getJcAmount(selected) || 0);
      const stakeLines: Array<{ text: string; amount: number }> = [
        {
          text: `竞彩: ${picked?.betLabel || '竞彩'} @ ${Number(jcOdds || 0).toFixed(2)}`,
          amount: -jcStake,
        },
      ];
      crownBets.forEach((b) => {
        const amount = Number(b.amount || 0);
        const odds = Number(b.odds || 0);
        const target = normalizeCrownTarget(String(b.type || ''));
        stakeLines.push({
          text: `皇冠: ${target} @ ${odds.toFixed(2)}`,
          amount: -amount,
        });
      });

      const buildScenario = (dg: number, cardKey: string, cardTitle: string) => {
        const jcReturn = jcHit(dg) ? jcStake * Number(jcOdds || 0) : 0;
        const crownDetails = crownBets.map((b, idx) => {
          const amount = Number(b.amount || 0);
          const odds = Number(b.odds || 0);
          const parsed = parseCrownBetTypeCompat(String(b.type || ''));
          const ret = getCrownGrossReturn(String(b.type || ''), odds, amount, dg);
          const status = classifyCrownOutcomeStatus(parsed, ret, amount, odds);
          return {
            key: `c_${idx}`,
            text: `皇冠: ${normalizeCrownTarget(String(b.type || ''))}`,
            hit: status === 'win' || status === 'half_win',
            status,
            statusText: statusLabel(status),
            amount: ret,
            settleRatio: status === 'half_win' || status === 'half_lose' ? 0.5 : status === 'push' ? 0 : 1,
          };
        });

        const crownReturn = crownDetails.reduce((sum, x) => sum + Number(x.amount || 0), 0);
        const matchByDetails = jcReturn + crownReturn - invest;
        const scenarioRebate =
          jcStake * Number(settingsMeta.jcRebate || 0) +
          crownDetails.reduce((sum, x) => sum + Number(crownBets[Number(String(x.key).replace('c_', ''))]?.amount || 0) * Number(x.settleRatio || 0) * Number(settingsMeta.crownRebate || 0), 0);

        const details = [
          ...(jcReturn > EPS
            ? [
                {
                  key: 'jc',
                  text: `竞彩: ${picked?.betLabel || '竞彩'}`,
                  hit: true,
                  statusText: '中',
                  amount: jcReturn,
                },
              ]
            : []),
          ...crownDetails.filter((d) => d.status === 'win' || d.status === 'half_win'),
        ];

        return {
          key: cardKey,
          title: cardTitle,
          color,
          stakeLines,
          details,
          match: matchByDetails,
          rebate: scenarioRebate,
          total: matchByDetails + scenarioRebate,
        };
      };

      if (dgs.length <= 1) {
        const dg = dgs[0];
        return [buildScenario(dg, `${key}_${dg}`, title)];
      }

      const signatureByDg = new Map<number, string>();
      for (const dg of dgs) {
        const jcSig = jcHit(dg) ? 'jc:hit' : 'jc:miss';
        const crownSig = crownBets
          .map((b) => {
            const parsed = parseCrownBetTypeCompat(String(b.type || ''));
            const ret = getCrownGrossReturn(String(b.type || ''), Number(b.odds || 0), Number(b.amount || 0), dg);
            const status = classifyCrownOutcomeStatus(parsed, ret, Number(b.amount || 0), Number(b.odds || 0));
            return `${String(b.type || '')}:${status}`;
          })
          .join('|');
        signatureByDg.set(dg, `${jcSig}|${crownSig}`);
      }

      const groups = new Map<string, number[]>();
      for (const dg of dgs) {
        const sig = signatureByDg.get(dg) || `dg:${dg}`;
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig)!.push(dg);
      }

      const cards = Array.from(groups.values()).map((group, idx) => {
        const representative = group[0];
        const suffix =
          group.length === 1
            ? `（${formatGoalDiff(group[0])}）`
            : `（${group.map((x) => formatGoalDiff(x)).join(' / ')}）`;
        return buildScenario(representative, `${key}_${idx}_${representative}`, `${title}${suffix}`);
      });

      return cards;
    };

    return [
      ...buildRow('win', '主胜', 'blue'),
      ...buildRow('draw', '平局', 'gold'),
      ...buildRow('lose', '客胜', 'red'),
    ];
  }, [currentPickedOption, matchInfo, selected, settingsMeta.crownRebate, settingsMeta.jcRebate]);

  const summaryMatrix = useMemo(() => {
    if (!selected || !matchInfo) return null;

    type SummaryLine = {
      text: string;
      color?: string;
    };

    type SummaryCell = {
      oddsLabel: string;
      highlighted: boolean;
      stakeLines: SummaryLine[];
      payoutLines: SummaryLine[];
      profitLines: SummaryLine[];
      coveredSides: Side[];
    };

    const createCell = (oddsLabel: string): SummaryCell => ({
      oddsLabel,
      highlighted: false,
      stakeLines: [],
      payoutLines: [],
      profitLines: [],
      coveredSides: [],
    });

    const appendLine = (cell: SummaryCell, key: 'stakeLines' | 'payoutLines' | 'profitLines', value: SummaryLine, unique = false) => {
      if (!value?.text) return;
      if (unique && cell[key].some((item) => item.text === value.text)) return;
      cell[key].push(value);
    };

    const appendCurrencyLine = (
      cell: SummaryCell,
      key: 'stakeLines' | 'payoutLines' | 'profitLines',
      amount: number,
      color?: string,
      unique = false,
      prefix = ''
    ) => {
      const text = `${prefix}${currency(amount)}`;
      appendLine(cell, key, { text, color }, unique);
    };

    const appendSignedLine = (
      cell: SummaryCell,
      key: 'stakeLines' | 'payoutLines' | 'profitLines',
      amount: number,
      color?: string,
      unique = false,
      prefix = ''
    ) => {
      const text = `${prefix}${signedCurrency(amount)}`;
      appendLine(cell, key, { text, color }, unique);
    };

    const sideOrder: Side[] = ['W', 'D', 'L'];
    const diffBySide: Record<Side, number> = { W: 1, D: 0, L: -1 };
    const mergeCoveredSides = (cell: SummaryCell, covered: Side[]) => {
      const union = new Set<Side>([...cell.coveredSides, ...covered]);
      cell.coveredSides = sideOrder.filter((side) => union.has(side));
    };

    const getJcCoveredSides = (market: Market, side: Side, handicapLine: string) =>
      sideOrder.filter((actualSide) => {
        const dg = diffBySide[actualSide];
        if (market === 'normal') {
          return side === 'W' ? dg > 0 : side === 'D' ? dg === 0 : dg < 0;
        }
        const adjusted = dg + parseHandicap(handicapLine);
        const outcome: Side = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : 'D';
        return outcome === side;
      });

    const getCrownCoveredSides = (betType: string, odds: number, amount: number) =>
      sideOrder.filter((actualSide) => getCrownGrossReturn(betType, odds, amount, diffBySide[actualSide]) > 0);

    const cloneLinesToCoveredCells = (
      cells: Record<Side, SummaryCell>,
      sourceSide: Side,
      coveredSides: Side[],
      keys: Array<'payoutLines' | 'profitLines'>
    ) => {
      const source = cells[sourceSide];
      coveredSides.forEach((coveredSide) => {
        if (coveredSide === sourceSide) return;
        const target = cells[coveredSide];
        keys.forEach((key) => {
          source[key].forEach((line) => appendLine(target, key, line, true));
        });
      });
    };

    const line = resolveJcHandicapLine(matchInfo);
    const picked = currentPickedOption;
    const pickSideOutcome = (prefix: 'win' | 'draw' | 'lose') => {
      const rows = outcomeRows.filter((row) => String(row?.key || '').startsWith(prefix));
      if (rows.length === 0) return null;
      return { total: Math.min(...rows.map((row) => Number(row?.total || 0))) };
    };
    const outcomeMap: Record<Side, { total: number } | null> = {
      W: pickSideOutcome('win'),
      D: pickSideOutcome('draw'),
      L: pickSideOutcome('lose'),
    };

    const standard = {
      jc: {
        W: createCell(`主胜 @ ${Number(matchInfo.j_w || 0).toFixed(2)}`),
        D: createCell(`平局 @ ${Number(matchInfo.j_d || 0).toFixed(2)}`),
        L: createCell(`客胜 @ ${Number(matchInfo.j_l || 0).toFixed(2)}`),
      } as Record<Side, SummaryCell>,
      crown: {
        W: createCell(`主胜 @ ${Number(matchInfo.c_w || 0).toFixed(2)}`),
        D: createCell(`平局 @ ${Number(matchInfo.c_d || 0).toFixed(2)}`),
        L: createCell(`客胜 @ ${Number(matchInfo.c_l || 0).toFixed(2)}`),
      } as Record<Side, SummaryCell>,
    };

    const crownHandicapRows = parseCrownHandicapRows(matchInfo.c_h);
    const crownAhBets = (selected.crown_bets || [])
      .map((bet) => {
        const normalized = normalizeCrownTarget(String(bet.type || ''));
        const parsed = parseCrownBetTypeCompat(normalized);
        if (parsed.kind !== 'ah') return null;
        const side: Side = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
        return {
          side,
          target: normalized,
          odds: Number(bet.odds || 0),
        };
      })
      .filter(Boolean) as Array<{ side: Side; target: string; odds: number }>;
    const preferredHandicapBet = crownAhBets[0] || null;
    const preferredLine = preferredHandicapBet
      ? String(preferredHandicapBet.target || '').match(/\(([^)]+)\)/)?.[1] || ''
      : '';
    const preferredCrownHandicap =
      crownHandicapRows.find((row) => String(row?.type || row?.handicap || '').trim() === preferredLine) || crownHandicapRows[0] || null;
    const crownHandicapLine = String(preferredCrownHandicap?.type || preferredCrownHandicap?.handicap || '').trim();
    const getSelectedAhOddsLabel = (side: Side) => {
      const bets = crownAhBets.filter((item) => item.side === side && item.target);
      if (bets.length === 0) return '';
      return bets.map((item) => `${item.target} @ ${Number(item.odds || 0).toFixed(2)}`).join(' | ');
    };

    const handicap = {
      jc: {
        W: createCell(`主胜(${line}) @ ${Number(matchInfo.j_hw || 0).toFixed(2)}`),
        D: createCell(`平局(${line}) @ ${Number(matchInfo.j_hd || 0).toFixed(2)}`),
        L: createCell(`客胜(${invertHandicap(line)}) @ ${Number(matchInfo.j_hl || 0).toFixed(2)}`),
      } as Record<Side, SummaryCell>,
      crown: {
        W: createCell(
          getSelectedAhOddsLabel('W') ||
            (crownHandicapLine
              ? `主胜(${crownHandicapLine}) @ ${Number(preferredCrownHandicap?.home_odds ?? preferredCrownHandicap?.homeOdds ?? preferredCrownHandicap?.homeWater ?? 0).toFixed(2)}`
              : '')
        ),
        D: createCell('-'),
        L: createCell(
          getSelectedAhOddsLabel('L') ||
            (crownHandicapLine
              ? `客胜(${invertHandicap(crownHandicapLine)}) @ ${Number(preferredCrownHandicap?.away_odds ?? preferredCrownHandicap?.awayOdds ?? preferredCrownHandicap?.awayWater ?? 0).toFixed(2)}`
              : '')
        ),
      } as Record<Side, SummaryCell>,
    };

    if (picked) {
      const jcSection = picked.market === 'handicap' ? handicap.jc : standard.jc;
      const jcCell = jcSection[picked.side];
      jcCell.highlighted = true;
      const coveredSides = getJcCoveredSides(picked.market, picked.side, line);
      mergeCoveredSides(jcCell, coveredSides);
      appendCurrencyLine(jcCell, 'stakeLines', getJcAmount(selected), '#222');
      appendCurrencyLine(jcCell, 'stakeLines', betRows.find((row: any) => row.key === 'jc')?.realAmount || 0, summaryBlue, false, '实投: ');
      appendCurrencyLine(jcCell, 'payoutLines', getJcAmount(selected) * getCurrentJcOdds(selected), '#222');
      appendSignedLine(jcCell, 'profitLines', Number(outcomeMap[picked.side]?.total || 0), summaryBlue, true);
      cloneLinesToCoveredCells(jcSection, picked.side, coveredSides, ['payoutLines', 'profitLines']);
    }

    (selected.crown_bets || []).forEach((bet) => {
      const normalized = normalizeCrownTarget(String(bet.type || ''));
      const parsed = parseCrownBetTypeCompat(normalized);
      const side: Side = parsed.side === 'home' ? 'W' : parsed.side === 'draw' ? 'D' : 'L';
      const targetSection = parsed.kind === 'ah' ? handicap.crown : standard.crown;
      const cell = targetSection[side];
      cell.highlighted = true;
      const amount = Number(bet.amount || 0);
      const odds = Number(bet.odds || 0);
      const betRow = betRows.find((row: any) => row.platform === '皇冠' && row.target === normalized && Number(row.amount || 0) === amount);
      appendCurrencyLine(cell, 'stakeLines', amount, '#222');
      appendCurrencyLine(cell, 'stakeLines', Number(betRow?.realAmount || 0), summaryBlue, false, '实投: ');
      const grossIfWin = parsed.kind === 'ah' ? amount * (1 + odds) : amount * odds;
      appendCurrencyLine(cell, 'payoutLines', grossIfWin, '#222');
      const coveredSides = getCrownCoveredSides(normalized, odds, amount);
      mergeCoveredSides(cell, coveredSides);
      appendSignedLine(cell, 'profitLines', Number(outcomeMap[side]?.total || 0), summaryBlue, true);
      if (parsed.kind === 'std') {
        cloneLinesToCoveredCells(targetSection, side, coveredSides, ['payoutLines', 'profitLines']);
      }
    });

    return {
      jcShare: Number(betRows.find((row: any) => row.platform === '竞彩')?.share || 0),
      crownShare: Number(betRows.find((row: any) => row.platform === '皇冠')?.share || settingsMeta.crownShare || 0),
      jcRebate: Number(settingsMeta.jcRebate || 0),
      crownRebate: Number(settingsMeta.crownRebate || 0),
      standard,
      handicap,
    };
  }, [betRows, currentPickedOption, matchInfo, outcomeRows, selected, settingsMeta.crownShare, settingsMeta.jcRebate, settingsMeta.crownRebate]);

  const title = matchInfo ? `单场方案：${matchInfo.home_team} vs ${matchInfo.away_team}` : '单场下注方案';

  return (
    <div style={showTitle ? { maxWidth: 1320, margin: '0 auto' } : undefined}>
      {showTitle ? (
        <Title level={1} style={{ marginBottom: 20, fontSize: 32, lineHeight: 1.2 }}>
          {title}
        </Title>
      ) : null}
      <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
        {!selected ? (
          <Card>
            <Empty description="暂无可用的单场方案" />
          </Card>
        ) : (
          <Card
            title="下注方案详情"
            extra={
              <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'nowrap' }}>
                <BetStakeCalculatorModal strategy={selected} shares={{ jingcai: settingsMeta.jcShare, crown: settingsMeta.crownShare }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 210 }}>
                  <div style={{ fontSize: 13, color: '#595959', whiteSpace: 'nowrap' }}>整单控制</div>
                  <Form.Item name="base_type" style={{ marginBottom: 0, flex: 1 }}>
                    <Select
                      options={[
                        { value: 'jingcai', label: '竞彩' },
                        { value: 'crown', label: '皇冠', disabled: !baseTypeAvailability.crown },
                      ]}
                    />
                  </Form.Item>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 210 }}>
                  <div style={{ fontSize: 13, color: '#595959', whiteSpace: 'nowrap' }}>投注单位</div>
                  <Form.Item name="integer_unit" style={{ marginBottom: 0, flex: 1 }}>
                    <Select
                      options={[
                        { value: 1000, label: '1000' },
                        { value: 10000, label: '10000' },
                        { value: 100000, label: '100000' },
                      ]}
                    />
                  </Form.Item>
                </div>
              </div>
            }
          >
            {summaryMatrix ? (
              <div style={{ marginBottom: 18, ...matrixWrapStyle }} className="matrix-responsive-wrap">
                <table style={matrixTableStyle} className="matrix-responsive-table">
                  <thead>
                    <tr>
                      <th style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', width: 74 }} />
                      <th colSpan={3} style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                        {`竞彩（返水: ${formatPercent(summaryMatrix.jcRebate)} | 占比: ${formatPercent(summaryMatrix.jcShare)}）`}
                      </th>
                      <th colSpan={3} style={{ border: '1px solid #d9d9d9', background: '#f7f8fa', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                        {`皇冠（返水: ${formatPercent(summaryMatrix.crownRebate)} | 占比: ${formatPercent(summaryMatrix.crownShare)}）`}
                      </th>
                    </tr>
                    <tr>
                      <th style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px' }} />
                      {(['\u80dc', '\u5e73', '\u8d1f'] as const).map((label) => (
                        <th key={`jc_head_${label}`} style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                          {label}
                        </th>
                      ))}
                      {(['\u80dc', '\u5e73', '\u8d1f'] as const).map((label) => (
                        <th key={`crown_head_${label}`} style={{ border: '1px solid #d9d9d9', background: '#fcfcfd', padding: '10px 8px', textAlign: 'center', fontWeight: 700 }}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: '赔率', key: 'oddsLabel', section: 'standard' },
                      { label: TERMS.stake, key: 'stakeLines', section: 'standard' },
                      { label: TERMS.payout, key: 'payoutLines', section: 'standard' },
                      { label: '赔率', key: 'oddsLabel', section: 'handicap' },
                      { label: TERMS.stake, key: 'stakeLines', section: 'handicap' },
                      { label: TERMS.payout, key: 'payoutLines', section: 'handicap' },
                    ].map((row, rowIndex) => {
                      const rowKey = row.key as 'oddsLabel' | 'stakeLines' | 'payoutLines';
                      const section = row.section === 'standard' ? summaryMatrix.standard : summaryMatrix.handicap;
                      const renderCell = (cell: any, cellKey: string, colSpan = 1) => {
                        const lines =
                          rowKey === 'oddsLabel'
                            ? [{ text: cell.oddsLabel && cell.oddsLabel !== ' @ 0.00' ? cell.oddsLabel : cell.oddsLabel || '' }]
                            : cell[rowKey];
                        const hasCoverage = rowKey !== 'oddsLabel' && Array.isArray(lines) && lines.length > 0;
                        const background =
                          rowKey === 'oddsLabel'
                            ? cell.highlighted
                              ? '#e88700'
                              : '#fff'
                            : hasCoverage
                            ? '#e7f7de'
                            : '#fff';
                        const color =
                          rowKey === 'oddsLabel'
                            ? cell.highlighted
                              ? '#fff'
                              : '#222'
                            : '#222';
                        return (
                          <td
                            key={cellKey}
                            colSpan={colSpan}
                            style={{
                              border: '1px solid #d9d9d9',
                              padding: '8px 10px',
                              textAlign: 'center',
                              verticalAlign: 'middle',
                              background,
                              color,
                              fontWeight: rowKey === 'oddsLabel' && cell.highlighted ? 700 : 500,
                              minWidth: 118,
                            }}
                          >
                            {lines && lines.length > 0 && lines[0] ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {lines.map((lineItem: any, index: number) => (
                                  <div key={`${cellKey}_${index}`} style={{ color: lineItem?.color || color }}>
                                    {lineItem?.text || ''}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </td>
                        );
                      };

                      const renderPlatformCells = (cells: Record<Side, any>, prefix: string) =>
                        (['W', 'D', 'L'] as Side[]).map((side) => renderCell(cells[side], `${prefix}_${side}_${rowIndex}`));

                      return (
                        <tr key={`${row.section}_${row.label}_${rowIndex}`}>
                          <td style={{ border: '1px solid #d9d9d9', padding: '8px 10px', textAlign: 'center', background: '#fafafa', fontWeight: 600 }}>
                            {row.label}
                          </td>
                          {renderPlatformCells(section.jc, 'jc')}
                          {renderPlatformCells(section.crown, 'crown')}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div style={{ marginTop: 20 }}>
              <Title level={3} style={{ marginBottom: 8 }}>
                {'预期收益分析 '}<Text type="secondary" style={{ fontSize: 14 }}>{'（展示主胜/平/客胜三种结果）'}</Text>
              </Title>
              <Row gutter={12}>
                {outcomeRows.map((r) => (
                  <Col xs={24} md={12} lg={8} key={r.key} style={{ display: 'flex' }}>
                    <Card size="small" style={{ borderColor: '#b7eb8f', background: '#f6ffed', width: '100%', height: '100%' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div style={{ textAlign: 'center', marginBottom: 8 }}>
                          <Tag color={r.color}>{r.title}</Tag>
                        </div>
                        <div style={{ borderTop: '1px solid #e8e8e8', margin: '10px 0' }} />

                        {(r.stakeLines || []).map((d: any, idx: number) => (
                          <div key={`${r.key}_stake_${idx}`} style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <Text style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.text}</Text>
                            <Text style={{ fontSize: 12, color: '#cf1322', flexShrink: 0 }}>{signedCurrency(d.amount)}</Text>
                          </div>
                        ))}
                        {(r.stakeLines || []).length > 0 ? <div style={{ borderTop: '1px dashed #d9d9d9', margin: '8px 0' }} /> : null}

                        {(r.details || [])
                          .filter((d: any) => {
                            const status = String(d?.status || '').toLowerCase();
                            const text = String(d?.statusText || '');
                            if (status === 'push' || status === 'half_lose' || status === 'lose') return false;
                            if (text === '走水' || text === '输半' || text === '不中') return false;
                            return true;
                          })
                          .map((d: any, idx: number) => (
                          <div key={`${r.key}_${idx}`} style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                            <Text style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.text}</Text>
                            <Text style={{ fontSize: 12, color: Number(d.amount || 0) >= 0 ? '#389e0d' : '#cf1322', flexShrink: 0 }}>
                              {d.statusText || (d.hit ? '中' : '不中')} {signedCurrency(d.amount)}
                            </Text>
                          </div>
                        ))}

                        {(r.details || [])
                          .filter((d: any) => {
                            const status = String(d?.status || '').toLowerCase();
                            const text = String(d?.statusText || '');
                            if (status === 'push' || status === 'half_lose' || status === 'lose') return false;
                            if (text === '走水' || text === '输半' || text === '不中') return false;
                            return true;
                          }).length > 0 ? <div style={{ borderTop: '1px dashed #d9d9d9', margin: '8px 0' }} /> : null}

                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Text>胜负收益:</Text>
                          <Text style={{ color: Number(r.match || 0) >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(r.match)}</Text>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Text>返水收益:</Text>
                          <Text style={{ color: '#389e0d' }}>{signedCurrency(r.rebate)}</Text>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
                          <Text strong>总利润:</Text>
                          <Text strong style={{ color: Number(r.total || 0) >= 0 ? '#389e0d' : '#cf1322' }}>{signedCurrency(r.total)}</Text>
                        </div>
                      </div>
                    </Card>
                  </Col>
                ))}
              </Row>
            </div>

            <Card size="small" style={{ marginTop: 16, background: '#f0f5ff', borderColor: '#d6e4ff' }}>
              <Space size={24} wrap>
                <Text strong>总投入: {currency(selected.user_invest)}</Text>
                <Text strong style={{ color: '#1677ff' }}>实投总计: {currency(realInvestTotal)}</Text>
                <Tag color={rateHot(selected.min_profit_rate) ? 'red' : 'green'} style={{ fontWeight: 700 }}>
                  最低利润率: {((selected.min_profit_rate || 0) * 100).toFixed(3)}%
                </Tag>
              </Space>
            </Card>

            <Alert
              style={{ marginTop: 16 }}
              type="info"
              showIcon
              icon={<InfoCircleOutlined />}
              message="算法说明"
              description="单场卡片的总利润、最低利润率与后端引擎保持同口径；卡片中的每条下注展示的是该结果下的实际返还额（中为返还，不中为0）。"
            />
          </Card>
        )}
      </Form>
    </div>
  );
};

export default SinglePlanDetailContent;
