import React, { useMemo, useState } from 'react';
import { Alert, Button, Form, InputNumber, Modal, Segmented, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { HedgeStrategy } from '../types';
import { getPrimaryStakeAmount, getPrimaryStakePlatform, scaleHedgeStrategy } from '../shared/strategyScale';
import { normalizeCrownTarget } from '../shared/oddsText';

const { Text } = Typography;

const currency = (value: number) => `¥${Number(value || 0).toFixed(2)}`;
const percent = (value: number) => `${(Number(value || 0) * 100).toFixed(3)}%`;
const shareText = (value: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;

type AmountMode = 'stake' | 'actual';

type BetStakeCalculatorModalProps = {
  strategy?: HedgeStrategy | null;
  primaryBetDisplay?: {
    target: string;
    odds?: number;
    oddsDisplay?: string;
  };
  shares?: { jingcai: number; crown: number };
};

type BetRow = {
  key: string;
  platform: string;
  target: string;
  odds?: number;
  oddsDisplay?: string;
  amount: number;
  share: number;
  actualAmount: number;
};

type ProfitRow = {
  key: string;
  outcome: string;
  matchProfit: number;
  rebate: number;
  totalProfit: number;
};

const getPlatformShare = (platform: string, shares: Required<BetStakeCalculatorModalProps>['shares']) =>
  platform.includes('皇冠') ? Number(shares.crown || 0) : Number(shares.jingcai || 0);

const getActualAmount = (amount: number, share: number) => amount / Math.max(1 - Number(share || 0), 0.0001);

const withShareAndActual = (rows: Array<Omit<BetRow, 'share' | 'actualAmount'>>, shares: Required<BetStakeCalculatorModalProps>['shares']): BetRow[] =>
  rows.map((row) => {
    const share = getPlatformShare(row.platform, shares);
    return {
      ...row,
      share,
      actualAmount: getActualAmount(Number(row.amount || 0), share),
    };
  });

const buildBetRows = (
  strategy: HedgeStrategy,
  shares: Required<BetStakeCalculatorModalProps>['shares'],
  primaryBetDisplay?: BetStakeCalculatorModalProps['primaryBetDisplay']
): BetRow[] => {
  const rows: Array<Omit<BetRow, 'share' | 'actualAmount'>> = [];

  if (strategy.hg_base_bet) {
    rows.push({
      key: 'hg_base',
      platform: '皇冠主投',
      target: normalizeCrownTarget(String(strategy.hg_base_bet.type || '')),
      odds: Number(strategy.hg_base_bet.odds || 0),
      amount: Number(strategy.hg_base_bet.amount || 0),
    });
  } else if (strategy.goal_hedge_meta?.goal_picks?.length) {
    strategy.goal_hedge_meta.goal_picks.forEach((item, index) => {
      rows.push({
        key: `goal_${index}`,
        platform: '竞彩',
        target: item.label || item.goal_index || '总进球',
        odds: Number(item.odds || 0),
        amount: Number(item.amount || 0),
      });
    });
  } else {
    const crownAmount = (strategy.crown_bets || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    rows.push({
      key: 'jc',
      platform: '竞彩',
      target: primaryBetDisplay?.target || strategy.jc_label || strategy.name || '主投注',
      odds: Number(primaryBetDisplay?.odds || strategy.jc_odds || 0),
      oddsDisplay: primaryBetDisplay?.oddsDisplay,
      amount: Math.max(0, Number(strategy.user_invest || 0) - crownAmount),
    });
  }

  if (strategy.goal_hedge_meta?.ou_bet) {
    const ou = strategy.goal_hedge_meta.ou_bet;
    rows.push({
      key: 'goal_ou',
      platform: '皇冠',
      target: `${ou.side === 'over' ? '大' : '小'}${ou.line}`,
      odds: Number(ou.odds || 0),
      amount: Number(ou.amount || 0),
    });
  }

  (strategy.crown_bets || []).forEach((item, index) => {
    rows.push({
      key: `crown_${index}`,
      platform: '皇冠',
      target: normalizeCrownTarget(String(item.type || '')),
      odds: Number(item.odds || 0),
      amount: Number(item.amount || 0),
    });
  });

  return withShareAndActual(rows, shares);
};

const buildProfitRows = (strategy: HedgeStrategy): ProfitRow[] => {
  if (strategy.goal_profit_breakdown?.length) {
    return strategy.goal_profit_breakdown.map((item) => ({
      key: `goal_${item.goal}`,
      outcome: item.goal_label || item.goal,
      matchProfit: Number(item.match_profit || 0),
      rebate: Number(item.rebate || 0),
      totalProfit: Number(item.total_profit || 0),
    }));
  }

  return [
    { key: 'win', outcome: '主胜', matchProfit: Number(strategy.match_profits?.win || 0), rebate: Number(strategy.rebates?.win || 0), totalProfit: Number(strategy.profits?.win || 0) },
    { key: 'draw', outcome: '平', matchProfit: Number(strategy.match_profits?.draw || 0), rebate: Number(strategy.rebates?.draw || 0), totalProfit: Number(strategy.profits?.draw || 0) },
    { key: 'lose', outcome: '客胜', matchProfit: Number(strategy.match_profits?.lose || 0), rebate: Number(strategy.rebates?.lose || 0), totalProfit: Number(strategy.profits?.lose || 0) },
  ];
};

const BetStakeCalculatorModal: React.FC<BetStakeCalculatorModalProps> = ({ strategy, primaryBetDisplay, shares }) => {
  const [form] = Form.useForm<{ amount: number }>();
  const [open, setOpen] = useState(false);
  const [amountMode, setAmountMode] = useState<AmountMode>('stake');
  const [calculatedPrimaryStake, setCalculatedPrimaryStake] = useState(0);

  const safeShares = useMemo(
    () => ({
      jingcai: Number(shares?.jingcai || 0),
      crown: Number(shares?.crown || 0),
    }),
    [shares?.crown, shares?.jingcai]
  );

  const primaryStake = useMemo(() => getPrimaryStakeAmount(strategy), [strategy]);
  const primaryPlatform = useMemo(() => getPrimaryStakePlatform(strategy), [strategy]);
  const primaryShare = primaryPlatform === 'crown' ? safeShares.crown : safeShares.jingcai;
  const primaryPlatformText = primaryPlatform === 'crown' ? '皇冠' : '竞彩';
  const toDisplayAmount = (stakeAmount: number, mode: AmountMode) =>
    mode === 'actual' ? getActualAmount(stakeAmount, primaryShare) : stakeAmount;
  const toPrimaryStakeAmount = (amount: number, mode: AmountMode) =>
    mode === 'actual' ? Number(amount || 0) * Math.max(1 - Number(primaryShare || 0), 0.0001) : Number(amount || 0);

  const scaledStrategy = useMemo(() => {
    if (!strategy || calculatedPrimaryStake <= 0) return strategy || null;
    return scaleHedgeStrategy(strategy, calculatedPrimaryStake);
  }, [calculatedPrimaryStake, strategy]);

  const betRows = useMemo(
    () => (scaledStrategy ? buildBetRows(scaledStrategy, safeShares, primaryBetDisplay) : []),
    [primaryBetDisplay, safeShares, scaledStrategy]
  );
  const profitRows = useMemo(() => (scaledStrategy ? buildProfitRows(scaledStrategy) : []), [scaledStrategy]);

  const openModal = () => {
    const initialAmount = primaryStake > 0 ? Number(toDisplayAmount(primaryStake, amountMode).toFixed(2)) : undefined;
    form.setFieldsValue({ amount: initialAmount });
    setCalculatedPrimaryStake(primaryStake);
    setOpen(true);
  };

  const handleModeChange = (value: AmountMode) => {
    const currentAmount = Number(form.getFieldValue('amount'));
    const currentStakeAmount =
      Number.isFinite(currentAmount) && currentAmount > 0
        ? toPrimaryStakeAmount(currentAmount, amountMode)
        : calculatedPrimaryStake || primaryStake;

    setAmountMode(value);
    const displayAmount = currentStakeAmount > 0 ? Number(toDisplayAmount(currentStakeAmount, value).toFixed(2)) : undefined;
    form.setFieldsValue({ amount: displayAmount });
  };

  const handleCalculate = async () => {
    try {
      const values = await form.validateFields();
      setCalculatedPrimaryStake(toPrimaryStakeAmount(Number(values.amount || 0), amountMode));
    } catch {
      // 校验错误由 Ant Design 表单字段展示，这里避免产生未处理 Promise 异常。
    }
  };

  const betColumns: ColumnsType<BetRow> = [
    { title: '平台', dataIndex: 'platform', width: 90 },
    { title: '投注项', dataIndex: 'target' },
    {
      title: '赔率',
      dataIndex: 'odds',
      width: 180,
      render: (value, record) => record.oddsDisplay || (Number(value || 0) > 0 ? Number(value).toFixed(2) : '-'),
    },
    {
      title: '投注金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (value) => <Text strong>{currency(Number(value || 0))}</Text>,
    },
    {
      title: '占比',
      dataIndex: 'share',
      width: 90,
      align: 'right',
      render: (value) => shareText(Number(value || 0)),
    },
    {
      title: '实际投入',
      dataIndex: 'actualAmount',
      width: 120,
      align: 'right',
      render: (value) => <Text strong>{currency(Number(value || 0))}</Text>,
    },
  ];

  const profitColumns: ColumnsType<ProfitRow> = [
    { title: '结果', dataIndex: 'outcome', width: 100 },
    { title: '中奖收益', dataIndex: 'matchProfit', align: 'right', render: (value) => currency(Number(value || 0)) },
    { title: '返水收益', dataIndex: 'rebate', align: 'right', render: (value) => currency(Number(value || 0)) },
    {
      title: '总收益',
      dataIndex: 'totalProfit',
      align: 'right',
      render: (value) => <Text type={Number(value || 0) >= 0 ? 'success' : 'danger'}>{currency(Number(value || 0))}</Text>,
    },
  ];

  return (
    <>
      <Button onClick={openModal} disabled={!strategy || primaryStake <= 0}>
        投注计算
      </Button>
      <Modal
        title="投注计算"
        open={open}
        onCancel={() => setOpen(false)}
        width={820}
        footer={[
          <Button key="close" onClick={() => setOpen(false)}>
            关闭
          </Button>,
          <Button key="calculate" type="primary" onClick={handleCalculate}>
            计算
          </Button>,
        ]}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={
              amountMode === 'actual'
                ? `输入主实际投入后，系统会按${primaryPlatformText}占比 ${shareText(primaryShare)} 先换算为投注金额，再按当前方案比例同步计算。`
                : `输入主投注金额后，系统会按当前方案比例同步计算，并按竞彩/皇冠占比展示实际投入。`
            }
          />
          <Space size={12} wrap>
            <Segmented
              value={amountMode}
              onChange={(value) => handleModeChange(value as AmountMode)}
              options={[
                { label: '投注金额', value: 'stake' },
                { label: '实际投入', value: 'actual' },
              ]}
            />
          </Space>
          <Form form={form} layout="inline">
            <Form.Item
              label={amountMode === 'actual' ? '主实际投入' : '主投注金额'}
              name="amount"
              rules={[
                { required: true, message: amountMode === 'actual' ? '请输入实际投入' : '请输入投注金额' },
                {
                  validator: (_, value) => {
                    const n = Number(value);
                    return Number.isFinite(n) && n > 0
                      ? Promise.resolve()
                      : Promise.reject(new Error(amountMode === 'actual' ? '实际投入必须大于 0' : '投注金额必须大于 0'));
                  },
                },
              ]}
            >
              <InputNumber min={0.01} precision={2} step={100} style={{ width: 180 }} addonAfter="元" />
            </Form.Item>
          </Form>

          {scaledStrategy ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space size={18} wrap>
                <Text>投注合计：<Text strong>{currency(Number(scaledStrategy.user_invest || 0))}</Text></Text>
                <Text>实际投入合计：<Text strong>{currency(Number(scaledStrategy.total_invest || 0))}</Text></Text>
                <Text>最低收益：<Text strong>{currency(Number(scaledStrategy.min_profit || 0))}</Text></Text>
                <Text>最低收益率：<Text strong>{percent(Number(scaledStrategy.min_profit_rate || 0))}</Text></Text>
              </Space>
              <Table size="small" pagination={false} columns={betColumns} dataSource={betRows} />
              <Table size="small" pagination={false} columns={profitColumns} dataSource={profitRows} />
            </Space>
          ) : null}
        </Space>
      </Modal>
    </>
  );
};

export default BetStakeCalculatorModal;
