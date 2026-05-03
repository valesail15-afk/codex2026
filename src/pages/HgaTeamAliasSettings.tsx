import React, { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Space, Table, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const { Title, Text } = Typography;

const MIN_ALIAS_COL_WIDTH = 128;
const ORDER_COL_WIDTH = 72;
const ACTION_COL_WIDTH = 112;
const EDITOR_MAX_WIDTH = 1320;
const MAX_ALIAS_COLUMN_COUNT = Math.max(
  2,
  Math.floor((EDITOR_MAX_WIDTH - ORDER_COL_WIDTH - ACTION_COL_WIDTH) / MIN_ALIAS_COL_WIDTH)
);
const MAX_EXTRA_COLUMNS = Math.max(0, MAX_ALIAS_COLUMN_COUNT - 2);

type HgaAliasRow = {
  group_id?: string;
  jingcai_name: string;
  huangguan_name: string;
  extra_aliases?: string[];
};

type HgaAliasSuggestion = {
  jingcai_name: string;
  huangguan_name: string;
  trade500_name?: string;
  hga_name?: string;
  source?: string;
  match_id?: string;
  match_time?: string;
  created_at?: string;
  match_count?: number;
};

type HgaAliasGroup = {
  group_id: string;
  canonical: string;
  aliases: string[];
};

function parseHgaAliasMap(raw: unknown): HgaAliasRow[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([jingcaiName, huangguanName]) => ({
      jingcai_name: String(jingcaiName || '').trim(),
      huangguan_name: String(huangguanName || '').trim(),
      extra_aliases: [],
    }));
  } catch {
    return [];
  }
}

function parseTableRows(raw: unknown): HgaAliasRow[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => ({
      group_id: String(item?.group_id || '').trim() || `group_${index + 1}`,
      jingcai_name: String(item?.jingcai_name || item?.trade500_name || '').trim(),
      huangguan_name: String(item?.huangguan_name || item?.hga_name || '').trim(),
      extra_aliases: Array.isArray(item?.extra_aliases)
        ? item.extra_aliases.map((alias: unknown) => String(alias || '').trim())
        : [],
    }));
  } catch {
    return [];
  }
}

function normalizeRows(rows: HgaAliasRow[]) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    group_id: String(row?.group_id || '').trim() || `group_${Date.now()}_${index}`,
    jingcai_name: String(row?.jingcai_name || (row as any)?.trade500_name || '').trim(),
    huangguan_name: String(row?.huangguan_name || (row as any)?.hga_name || '').trim(),
    extra_aliases: Array.isArray(row?.extra_aliases) ? row.extra_aliases.map((alias) => String(alias || '').trim()) : [],
  }));
}

function getAllAliasesInRow(row: HgaAliasRow) {
  return [
    String(row?.jingcai_name || '').trim(),
    String(row?.huangguan_name || '').trim(),
    ...(Array.isArray(row?.extra_aliases) ? row.extra_aliases.map((item) => String(item || '').trim()) : []),
  ].filter(Boolean);
}

function buildGroupsFromRows(rows: HgaAliasRow[]): HgaAliasGroup[] {
  return normalizeRows(rows)
    .map((row) => {
      const aliases = getAllAliasesInRow(row);
      if (aliases.length === 0) return null;
      return {
        group_id: row.group_id!,
        canonical: String(row.jingcai_name || '').trim() || aliases[0],
        aliases,
      } as HgaAliasGroup;
    })
    .filter((item): item is HgaAliasGroup => Boolean(item));
}

const HgaTeamAliasSettings: React.FC = () => {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pendingSuggestions, setPendingSuggestions] = useState<HgaAliasSuggestion[]>([]);
  const [extraColumnCount, setExtraColumnCount] = useState(0);
  const autoApplyThreshold = Form.useWatch('hga_team_alias_auto_apply_threshold', form) || 3;

  const aliasColumnCount = 2 + extraColumnCount;
  const gridTemplateColumns = useMemo(
    () => `${ORDER_COL_WIDTH}px repeat(${aliasColumnCount}, minmax(${MIN_ALIAS_COL_WIDTH}px, 1fr)) ${ACTION_COL_WIDTH}px`,
    [aliasColumnCount]
  );

  const refreshSettings = async () => {
    const res = await axios.get('/api/settings');
    const data = { ...res.data };
    const tableRows = parseTableRows(data.hga_team_alias_table_rows);
    const mapRows = parseHgaAliasMap(data.hga_team_alias_map);
    const nextRows = tableRows.length > 0 ? tableRows : mapRows;
    const normalized = normalizeRows(nextRows);
    form.setFieldsValue({
      hga_team_alias_rows: normalized,
      hga_team_alias_auto_apply_threshold: Number(data.hga_team_alias_auto_apply_threshold || 3),
    });
    setExtraColumnCount(
      Math.min(
        MAX_EXTRA_COLUMNS,
        normalized.reduce((max, row) => Math.max(max, Array.isArray(row.extra_aliases) ? row.extra_aliases.length : 0), 0)
      )
    );

    let pending: HgaAliasSuggestion[] = [];
    try {
      const parsed = JSON.parse(String(data.hga_team_alias_pending_suggestions || '[]'));
      pending = (Array.isArray(parsed) ? parsed : []).map((item: any) => ({
        ...item,
        jingcai_name: String(item?.jingcai_name || item?.trade500_name || '').trim(),
        huangguan_name: String(item?.huangguan_name || item?.hga_name || '').trim(),
      }));
    } catch {
      pending = [];
    }
    setPendingSuggestions(pending);
  };

  useEffect(() => {
    refreshSettings().catch(() => {
      message.error('加载球队别名映射失败');
    });
  }, [form, message]);

  const onAddColumn = () => {
    if (extraColumnCount >= MAX_EXTRA_COLUMNS) {
      message.warning(`已达到最大新增列数（${MAX_EXTRA_COLUMNS}）`);
      return;
    }
    setExtraColumnCount((prev) => prev + 1);
  };

  const onSave = async (values: { hga_team_alias_rows?: HgaAliasRow[]; hga_team_alias_auto_apply_threshold?: number }) => {
    setLoading(true);
    try {
      const normalizedRows = normalizeRows(values.hga_team_alias_rows || [])
        .map((row) => ({ ...row, extra_aliases: row.extra_aliases.slice(0, extraColumnCount) }))
        .filter((row) => getAllAliasesInRow(row).length > 0);
      const groups = buildGroupsFromRows(normalizedRows);
      await axios.post('/api/settings/hga/alias-groups', {
        groups,
        hga_team_alias_auto_apply_threshold: Math.max(1, Math.min(10, Number(values.hga_team_alias_auto_apply_threshold || 3))),
      });
      await axios.post('/api/settings', {
        hga_team_alias_table_rows: JSON.stringify(normalizedRows),
      });
      await refreshSettings();
      message.success('球队别名映射已保存');
    } catch (err: any) {
      const msg = String(err?.response?.data?.message || err?.message || '保存失败');
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const onApplySuggestion = async (row: HgaAliasSuggestion) => {
    setLoading(true);
    try {
      await axios.post('/api/settings/hga/alias-suggestions/apply', {
        jingcai_name: row.jingcai_name,
        huangguan_name: row.huangguan_name,
      });
      await refreshSettings();
      message.success('已加入映射');
    } catch (err: any) {
      message.error(String(err?.response?.data?.message || err?.message || '应用映射建议失败'));
    } finally {
      setLoading(false);
    }
  };

  const onDismissSuggestion = async (row: HgaAliasSuggestion) => {
    setLoading(true);
    try {
      await axios.post('/api/settings/hga/alias-suggestions/dismiss', {
        jingcai_name: row.jingcai_name,
        huangguan_name: row.huangguan_name,
      });
      await refreshSettings();
      message.success('已忽略该映射建议');
    } catch {
      message.error('忽略映射建议失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: EDITOR_MAX_WIDTH, margin: '0 auto' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space direction="vertical" size={4}>
          <Button type="link" icon={<ArrowLeftOutlined />} style={{ paddingInline: 0 }} onClick={() => navigate('/settings')}>
            返回系统设置
          </Button>
          <Title level={3} style={{ margin: 0 }}>
            球队别名映射
          </Title>
          <Text type="secondary">第一列固定竞彩队名；第二列开始都是外部来源别名（365rich、皇冠等）。单行只填一个值视为无效。</Text>
        </Space>

        <Card className="shadow-sm">
          <Form form={form} layout="vertical" onFinish={onSave}>
            <Form.Item name="hga_team_alias_auto_apply_threshold" hidden>
              <InputNumber min={1} max={10} />
            </Form.Item>

            <Form.Item extra={`最多可新增 ${MAX_EXTRA_COLUMNS} 列别名，当前已新增 ${extraColumnCount} 列。`}>
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns,
                    gap: 12,
                    alignItems: 'center',
                    background: '#fafafa',
                    padding: '12px 16px',
                    fontWeight: 600,
                  }}
                >
                  <div>序号</div>
                  <div>竞彩</div>
                  <div>外部别名1</div>
                  {Array.from({ length: extraColumnCount }).map((_, idx) => (
                    <div key={`extra-col-header-${idx}`}>外部别名{idx + 2}</div>
                  ))}
                  <div style={{ textAlign: 'center' }}>
                    <Space size={4}>
                      <span>操作</span>
                      <Button
                        size="small"
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={onAddColumn}
                        title="新增别名列"
                        disabled={extraColumnCount >= MAX_EXTRA_COLUMNS}
                      />
                    </Space>
                  </div>
                </div>

                <div style={{ padding: 16, overflowX: 'auto' }}>
                  <Form.List
                    name="hga_team_alias_rows"
                    rules={[
                      {
                        validator: async (_, value: HgaAliasRow[] = []) => {
                          const invalid = value.find((row) => getAllAliasesInRow(row).length === 1);
                          if (invalid) throw new Error('每行至少填写两个别名（竞彩 + 任意外部别名），单值行无效');
                        },
                      },
                    ]}
                  >
                    {(fields, { add, remove }, { errors }) => (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        {fields.map((field, index) => (
                          <div
                            key={field.key}
                            style={{
                              display: 'grid',
                              gridTemplateColumns,
                              gap: 12,
                              alignItems: 'center',
                              minWidth: ORDER_COL_WIDTH + ACTION_COL_WIDTH + aliasColumnCount * MIN_ALIAS_COL_WIDTH,
                            }}
                          >
                            <div>
                              <Text type="secondary">{index + 1}</Text>
                              <Form.Item {...field} name={[field.name, 'group_id']} hidden>
                                <Input />
                              </Form.Item>
                            </div>
                            <Form.Item {...field} name={[field.name, 'jingcai_name']} style={{ marginBottom: 0 }}>
                              <Input placeholder="竞彩队名" />
                            </Form.Item>
                            <Form.Item {...field} name={[field.name, 'huangguan_name']} style={{ marginBottom: 0 }}>
                              <Input placeholder="外部别名（如 365rich/皇冠）" />
                            </Form.Item>
                            {Array.from({ length: extraColumnCount }).map((_, aliasIdx) => (
                              <Form.Item
                                key={`${field.key}-extra-${aliasIdx}`}
                                {...field}
                                name={[field.name, 'extra_aliases', aliasIdx]}
                                style={{ marginBottom: 0 }}
                              >
                                <Input placeholder={`外部别名${aliasIdx + 2}`} />
                              </Form.Item>
                            ))}
                            <div style={{ textAlign: 'center' }}>
                              <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} title="删除行" />
                            </div>
                          </div>
                        ))}
                        <Button
                          type="dashed"
                          block
                          icon={<PlusOutlined />}
                          onClick={() => add({ jingcai_name: '', huangguan_name: '', extra_aliases: Array(extraColumnCount).fill('') })}
                        >
                          底部新增一行
                        </Button>
                        <Form.ErrorList errors={errors} />
                      </Space>
                    )}
                  </Form.List>
                </div>
              </div>
            </Form.Item>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="primary" icon={<SaveOutlined />} loading={loading} htmlType="submit">
                保存
              </Button>
            </div>
          </Form>
        </Card>

        <Card
          title={`待确认映射建议（${pendingSuggestions.length}）`}
          extra={
            <Space size={10} align="center">
              <Text type="secondary">自动加入阈值</Text>
              <InputNumber
                min={1}
                max={10}
                value={autoApplyThreshold}
                onChange={(value) =>
                  form.setFieldValue('hga_team_alias_auto_apply_threshold', Math.max(1, Math.min(10, Number(value || 3))))
                }
                style={{ width: 88 }}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={loading} onClick={() => form.submit()}>
                保存
              </Button>
            </Space>
          }
        >
          <Table<HgaAliasSuggestion>
            rowKey={(row) => `${row.jingcai_name}-${row.huangguan_name}`}
            pagination={false}
            locale={{ emptyText: '当前没有待确认映射建议' }}
            dataSource={pendingSuggestions}
            columns={[
              {
                title: '竞彩',
                dataIndex: 'jingcai_name',
                key: 'jingcai_name',
              },
              {
                title: '外部队名',
                dataIndex: 'huangguan_name',
                key: 'huangguan_name',
              },
              {
                title: '命中次数',
                dataIndex: 'match_count',
                key: 'match_count',
                width: 100,
              },
              {
                title: '来源',
                key: 'source',
                render: () => <Tag color="blue">时间+亚赔指纹</Tag>,
              },
              {
                title: '最近命中比赛',
                key: 'match',
                render: (_, row) => (
                  <Space direction="vertical" size={0}>
                    <Text>{row.match_id || '-'}</Text>
                    <Text type="secondary">{row.match_time || '-'}</Text>
                  </Space>
                ),
              },
              {
                title: '操作',
                key: 'action',
                render: (_, row) => (
                  <Space>
                    <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => onApplySuggestion(row)} loading={loading}>
                      加入映射
                    </Button>
                    <Button size="small" icon={<CloseOutlined />} onClick={() => onDismissSuggestion(row)} loading={loading}>
                      忽略
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Space>
    </div>
  );
};

export default HgaTeamAliasSettings;
