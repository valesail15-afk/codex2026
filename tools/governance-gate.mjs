#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const notes = [];

function run(cmd, args, title) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', cwd: root });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    failures.push(`❌ ${title}\n${out || '(no output)'}`);
  } else {
    console.log(`✅ ${title}`);
  }
}

function runTextIntegrityWithBaseline() {
  const r = spawnSync('node', ['tools/check-text-integrity.mjs', '.', '--deep'], {
    stdio: 'pipe',
    encoding: 'utf8',
    cwd: root,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const counts = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/\[([^\]]+)\]/);
    if (!m) continue;
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }

  const baselineFile = path.join(root, 'tools', 'governance-baseline.json');
  let baseline = {};
  if (existsSync(baselineFile)) {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  }

  const keys = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  const exceeded = [];
  for (const k of keys) {
    const current = Number(counts[k] || 0);
    const maxAllowed = Number(baseline[k] || 0);
    if (current > maxAllowed) {
      exceeded.push(`${k}: current=${current}, baseline=${maxAllowed}`);
    }
  }

  if (exceeded.length > 0) {
    failures.push(`❌ 文本完整性检查（超出基线）\n${exceeded.join('\n')}\n\n原始输出:\n${out.trim() || '(no output)'}`);
  } else {
    console.log('✅ 文本完整性检查（未超出基线）');
    if (r.status !== 0) {
      notes.push('ℹ️ 存在历史文本问题，但未新增（已由基线兜底）');
    }
  }
}

function checkFileContains(file, regex, title) {
  const full = path.join(root, file);
  if (!existsSync(full)) {
    failures.push(`❌ ${title}\nmissing file: ${file}`);
    return;
  }
  const text = readFileSync(full, 'utf8');
  if (!regex.test(text)) {
    failures.push(`❌ ${title}\nfile: ${file}\nexpect regex: ${regex}`);
  } else {
    console.log(`✅ ${title}`);
  }
}

function scanMojibake() {
  const files = [
    'src/pages/Dashboard.tsx',
    'src/components/SinglePlanDetailContent.tsx',
    'src/components/ParlayPlanDetailContent.tsx',
    'src/components/HgPlanDetailContent.tsx',
    'src/server/arbitrageEngine.ts',
    'src/shared/oddsText.ts',
    'server.ts',
  ];
  const badPattern =
    /(\uFFFD|涓昏儨|鐨囧啝|绔炲僵|鏁存暟|鎶曟敞|涓嬫敞|涓|鍒╂鼎|棰勬湡|鍐犺|瀹炴姇|鏆傛棤|\?\?\?)/;
  for (const f of files) {
    const full = path.join(root, f);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (badPattern.test(text)) {
      failures.push(`❌ 乱码守门\nfile: ${f}\nmatched mojibake/placeholder pattern`);
    }
  }
  if (!failures.some((x) => x.includes('乱码守门'))) {
    console.log('✅ 乱码守门');
  }
}

console.log('== Governance Gate ==');
runTextIntegrityWithBaseline();
run('node', [path.join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], 'TypeScript 静态检查');
checkFileContains(
  'src/pages/Dashboard.tsx',
  /detailModal\.type === 'hg'[\s\S]*<HgPlanDetailContent/,
  'HG 弹窗与单场/二串一隔离'
);
checkFileContains(
  'src/server/arbitrageEngine.ts',
  /baseCandidates\s*=\s*crownOptions\.filter\(\(o\)\s*=>\s*\/\^STD_\/\.test/,
  'HG 基准注只允许皇冠胜平负'
);
checkFileContains(
  'src/server/arbitrageEngine.ts',
  /hedgeOptions\s*=\s*crownOptions\.filter\(\(opt\)\s*=>\s*\/\^AH_\/\.test/,
  'HG 对冲注只允许皇冠让球'
);
checkFileContains(
  'src/components/HgPlanDetailContent.tsx',
  /bet\.kind === 'ah' \? amount \* \(1 \+ odds\) : amount \* odds/,
  'HG 中奖金额口径（让球=本金*(1+赔率)）'
);
scanMojibake();

if (failures.length > 0) {
  console.error('\n== Gate Failed ==');
  for (const f of failures) {
    console.error(`\n${f}`);
  }
  process.exit(1);
}

if (notes.length > 0) {
  console.log('\n== Notes ==');
  for (const n of notes) {
    console.log(n);
  }
}

console.log('\n✅ All governance gates passed.');
