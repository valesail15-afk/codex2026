#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';

const includeExt = new Set(['.ts', '.tsx', '.js', '.cjs', '.json', '.md', '.css', '.html']);

const mojibakeFragments = [
  '锛歚',
  '姣旇',
  '鍒楄',
  '绔炲僵',
  '鐨囧啝',
  '鎿嶄綔',
  '缂栬緫',
  '鍒犻櫎',
  '鍚屾',
  '鑾峰彇',
  '娣诲姞',
  '澶辫触',
  '纭',
  '???',
];

const terminologyRules = [
  { bad: '盈利率', good: '利润率' },
  { bad: '命中金额', good: '中奖' },
  { bad: '实际投注', good: '实投' },
];

const coreFilesForTerms = new Set([
  'src/pages/Dashboard.tsx',
  'src/components/SinglePlanDetailContent.tsx',
  'src/components/ParlayPlanDetailContent.tsx',
  'src/components/HgPlanDetailContent.tsx',
  'src/shared/oddsText.ts',
]);

const findings = [];

function runGit(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}

function getStagedFiles() {
  const output = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB']);
  return output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTrackable(file) {
  const ext = path.extname(file).toLowerCase();
  return includeExt.has(ext);
}

function collectAddedLines(file) {
  const diff = runGit(['diff', '--cached', '-U0', '--', file]);
  const out = [];
  let newLine = 0;
  for (const rawLine of diff.split(/\r?\n/)) {
    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1] || 0);
      continue;
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      out.push({ lineNo: newLine, text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue;
    }
    if (rawLine.startsWith(' ')) {
      newLine += 1;
    }
  }
  return out;
}

function hasMojibake(line) {
  if (line.includes('\uFFFD')) return true;
  for (const token of mojibakeFragments) {
    if (token && line.includes(token)) return true;
  }
  if (/(锟|锛|鈥|�)/.test(line)) return true;
  return false;
}

function checkBomInIndexBlob(file) {
  const blob = runGit(['show', `:${file}`], 'buffer');
  return blob.length >= 3 && blob[0] === 0xef && blob[1] === 0xbb && blob[2] === 0xbf;
}

function pushFinding(file, line, issue, detail) {
  findings.push({ file, line, issue, detail });
}

const stagedFiles = getStagedFiles().filter(isTrackable);

for (const file of stagedFiles) {
  if (checkBomInIndexBlob(file)) {
    pushFinding(file, 1, 'BOM', '文件包含 UTF-8 BOM');
  }

  const addedLines = collectAddedLines(file);
  for (const { lineNo, text } of addedLines) {
    if (hasMojibake(text)) {
      pushFinding(file, lineNo, 'Mojibake', text);
      continue;
    }

    if (coreFilesForTerms.has(file)) {
      for (const rule of terminologyRules) {
        if (text.includes(rule.bad)) {
          pushFinding(file, lineNo, 'Term', `请使用“${rule.good}”，不要使用“${rule.bad}”`);
        }
      }
    }
  }
}

if (findings.length === 0) {
  console.log('OK: staged 变更未检测到乱码或术语污染');
  process.exit(0);
}

console.error(`发现 ${findings.length} 处 staged 文本完整性问题`);
for (const item of findings) {
  const msg = item.detail.length > 180 ? `${item.detail.slice(0, 180)}...` : item.detail;
  console.error(`${item.file}:${item.line} [${item.issue}] ${msg}`);
}
process.exit(1);
