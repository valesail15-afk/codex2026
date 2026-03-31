# 文本完整性防污染方案

## 目标
- 防止中文乱码（mojibake）再次进入仓库。
- 防止不同编辑器/系统导致的编码和换行污染。

## 已落地护栏
- `.editorconfig`
  - 强制 `UTF-8`、`LF`、结尾换行、去尾随空格。
- `.gitattributes`
  - 对源码文本统一 `LF`，降低跨平台污染概率。
- `tools/check-text-integrity.mjs`
  - `core` 模式（默认）检测：
    - `U+FFFD` 替换字符
    - `UTF-8 BOM`
  - `deep` 模式（`--deep`）额外检测常见乱码特征串

## 使用方式
在项目根目录执行：

```bash
node tools/check-text-integrity.mjs
node tools/check-text-integrity.mjs --deep
```

返回码说明：
- `0`：通过
- `1`：发现污染（会列出文件、行号和片段）

## 扫描范围说明
- 默认忽略目录：`node_modules`、`dist`、`.git`、`.gstack`
- 默认忽略文件：`PROJECT_DOC.md`（历史文档可能含遗留编码污染，不作为构建阻断项）
- `deep` 模式对少量“兼容历史脏数据”的映射文件做白名单放行，避免误报

## 建议流程
1. 每次提交前先运行 `node tools/check-text-integrity.mjs`。
2. 若报错，优先修复命中行，再提交。
3. 抓取脚本中尽量保留中文+英文双关键字匹配，避免页面文案变化导致误判。
