# 数据源抓取注意事项（Trade500 + HGA）

> 更新时间：2026-03-28  
> 适用项目：`D:\afk`

## 1. 总体原则
- 先抓 Trade500（主链路），再用 HGA 做皇冠赔率/让球补强。
- 当 HGA 数据不完整时，不回退到旧抓取逻辑；按当前系统规则仅保留符合完整度要求的数据。
- 所有请求必须带浏览器 `User-Agent`，并启用重试与超时控制。

## 1.1 全项目统一抓取间隔建议
- 推荐统一抓取间隔：**90 秒**。
- 最小允许间隔：**60 秒**。
- 比赛列表“同步采集数据”按钮必须遵循该间隔：
  - 点击时主动执行一次抓取；
  - 若距离上次抓取未到间隔，按钮禁用并显示倒计时，不允许再次触发。

## 2. Trade500 数据源要求

### 2.1 主链路 URL（固定）
- 竞彩胜平负：`https://trade.500.com/static/public/jczq/newxml/pl/pl_nspf_2.xml`
- 竞彩让球胜平负：`https://trade.500.com/static/public/jczq/newxml/pl/pl_spf_2.xml`
- 皇冠赔率补强（odds.xml，按 host 兜底）：
  - `https://www.500.com/static/public/jczq/xml/odds/odds.xml`
  - `https://trade.500.com/static/public/jczq/xml/odds/odds.xml`
  - `https://ews.500.com/static/public/jczq/xml/odds/odds.xml`

### 2.2 抓取频率建议
- `pl_nspf_2.xml` / `pl_spf_2.xml`：建议 **30-60 秒** 一次。
- `odds.xml`：建议 **60 秒** 一次（该文件有 `max-age=60` 特征）。
- 全量“同步采集数据”按钮触发时：允许立刻强制抓取一次。

### 2.3 必须执行的校验
- 新鲜度校验：日期与当前日期偏差超过 2 天视为陈旧，直接丢弃。
- 304 处理：命中 `ETag/Last-Modified` 返回 304 时，必须复用本地缓存正文，不可按空数据处理。
- `matchnum` 对齐：优先 `date|matchnum`，失败再按 `matchnum` 兜底匹配。

## 3. HGA 数据源要求

### 3.1 接口与登录要求
- 登录接口：`transform_nl.php`（`chk_login`）拿 `uid` 后才能抓业务数据。
- 业务接口：
  - `get_game_list`（today/early）
  - `get_game_OBT`（让球盘口）
- 兜底接口：当 `transform_nl.php` 无有效数据时，再尝试 `transform.php`。

### 3.2 路由规则（必须）
- `sourceShowtype=today` 的比赛：先 `today`，再 `early`，再 `parlay`。
- `sourceShowtype=early` 的比赛：先 `early`，再 `today`，再 `parlay`。
- 同场多次请求结果要合并去重，不只取单次返回。

### 3.3 抓取频率建议
- `get_game_list`：建议 **60 秒** 一次。
- `get_game_OBT`：建议单场 **60-90 秒** 一次，避免过于密集请求。
- 并发建议：单轮 OBT 并发控制在 **3**（当前代码已按该级别设计）。

### 3.4 失败识别与恢复
- `CheckEMNU`：视为会话失效，必须重登后重试。
- `<code>noData</code>` 或 `VariableStandard`：按无盘口处理，继续后续兜底链路。
- 网络失败（超时/连接中断）：按退避重试处理，不可立即判死。

### 3.5 完整度要求
- 皇冠让球按当前业务规则要求：每场目标为 **3 组**。
- 若源端未返回足够盘口，保留“源端不完整”判定，不伪造盘口。

## 4. 现在线路执行顺序（项目内）
1. 抓 Trade500 XML 主数据（竞彩基础盘 + 让球盘）。
2. 抓 Trade500 odds.xml 做皇冠赔率补强（多 host + 新鲜度校验）。
3. 抓 HGA 列表与 OBT，对皇冠让球做补强（含会话恢复与路由兜底）。
4. 对结果做完整度过滤后再入库。

## 5. 运维建议
- 每天首次启动后先执行一次手动“同步采集数据”，确认两个源可达。
- 若短时间连续出现 HGA 超时，优先检查网络出口与目标站点连通性，再看账号会话状态。
- 对抓取日志建议至少保留 7 天，用于复盘“无数据窗口”和源端波动。
