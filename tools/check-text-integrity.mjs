#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const root = path.resolve(process.argv[2] || process.cwd());
const deepMode = process.argv.includes('--deep');
const strictTerms = process.argv.includes('--strict-terms');

const includeExt = new Set(['.ts', '.tsx', '.js', '.cjs', '.json', '.md', '.css', '.html']);
const skipDirs = new Set(['node_modules', 'dist', '.git', '.gstack']);
const skipFiles = new Set(['PROJECT_DOC.md']);

const mojibakeTokens = ['�', '???', '娑撴', '鐎广', '閺', '鍒╂鼎鐜?/th'];

const terminologyRules = [
  { bad: '盈利率', good: '利润率' },
  { bad: '命中金额', good: '中奖' },
  { bad: '实际投注', good: '实投' },
];

const coreFilesForTerms = [
  'src/pages/Dashboard.tsx',
  'src/components/SinglePlanDetailContent.tsx',
  'src/components/ParlayPlanDetailContent.tsx',
  'src/components/HgPlanDetailContent.tsx',
  'src/shared/oddsText.ts',
];

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (skipFiles.has(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!includeExt.has(ext)) continue;
    if (!deepMode && !isCoreSource(full)) continue;
    scanFile(full);
  }
}

function isCoreSource(full) {
  const rel = path.relative(root, full).replace(/\\/g, '/');
  return rel === 'server.ts' || rel.startsWith('src/') || rel.startsWith('tools/');
}

function pushFinding(file, line, issue, sample) {
  findings.push({ file, line, issue, sample: sample.length > 180 ? `${sample.slice(0, 180)}...` : sample });
}

function scanFile(file) {
  const buf = fs.readFileSync(file);
  const rel = path.relative(root, file).replace(/\\/g, '/');

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    pushFinding(file, 1, 'BOM', '文件包含 UTF-8 BOM');
  }

  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('\uFFFD')) {
      pushFinding(file, i + 1, 'U+FFFD', line);
    }

    if (deepMode) {
      for (const token of mojibakeTokens) {
        if (token && line.includes(token)) {
          pushFinding(file, i + 1, 'Mojibake', line);
          break;
        }
      }
    }

    if (strictTerms && coreFilesForTerms.includes(rel)) {
      for (const rule of terminologyRules) {
        if (line.includes(rule.bad)) {
          pushFinding(file, i + 1, 'Term', `请使用“${rule.good}”，不要使用“${rule.bad}”`);
        }
      }
    }
  }
}

const rootStat = fs.statSync(root);
if (rootStat.isFile()) {
  const ext = path.extname(root).toLowerCase();
  if (includeExt.has(ext)) {
    scanFile(root);
  }
} else {
  walk(root);
}

if (findings.length === 0) {
  console.log(`OK: 未检测到文本污染（模式: ${deepMode ? 'deep' : 'core'}${strictTerms ? '+terms' : ''}）`);
  process.exit(0);
}

console.error(`发现 ${findings.length} 处文本完整性问题`);
for (const f of findings) {
  console.error(`${path.relative(root, f.file)}:${f.line} [${f.issue}] ${f.sample}`);
}
process.exit(1);
