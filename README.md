<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/9088df55-6e16-4315-bc98-d95c0d8415be

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 数据源运维

### 抓取方案（已同步到项目）
- 主链路：Trade500 XML（`pl_nspf_2.xml` + `pl_spf_2.xml`）。
- 补强链路：Trade500 `odds.xml`（多 host 兜底）+ HGA（`get_game_list` / `get_game_OBT`）。
- HGA 会话失效（如 `CheckEMNU`）会自动重登并重试。
- `odds.xml` 与抓取请求统一使用浏览器 `User-Agent`，并带重试与超时控制。
- Trade500 启用新鲜度校验，陈旧日期数据会被拦截，避免旧数据污染。

### 建议抓取间隔（全项目统一）
- 建议值：**90 秒**。
- 最小值：**60 秒**（不建议再低）。
- 系统设置 `scan_interval` 也按该规则约束（后端最小 60 秒）。

### 手动“同步采集数据”按钮规则
- 按钮点击会主动触发一次完整抓取流程。
- 但必须满足与上次抓取的最小间隔要求：
  - 未到间隔时按钮禁用，并显示倒计时。
  - 后端也会强校验，未到间隔返回 429，防止绕过前端限制。
