#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const root = path.resolve(process.argv[2] || process.cwd());
const deepMode = process.argv.includes('--deep');
const includeExt = new Set(['.ts', '.tsx', '.js', '.cjs', '.json', '.md', '.css', '.html']);
const skipDirs = new Set(['node_modules', 'dist', '.git', '.gstack']);
const skipFiles = new Set(['PROJECT_DOC.md']);
const deepMojibakeAllowFiles = new Set([
  'src/pages/Calculator.tsx',
  'src/pages/ParlayCalculator.tsx',
  'src/server/arbitrageEngine.ts',
]);
const mojibakeTokens = [
  '鏍囧噯',
  '涓昏儨',
  '瀹㈣儨',
  '鍔犺浇',
  '绔炲僵',
  '鐨囧啝',
  '宸查殣钘',
  '鏄剧ず',
  '灞曞紑',
  '鏇村',
  '闁哄秴娲',
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
  return rel === 'server.ts' || rel.startsWith('src/');
}

function scanFile(file) {
  const buf = fs.readFileSync(file);
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    findings.push({ file, line: 1, issue: 'BOM', sample: '文件包含 UTF-8 BOM' });
  }
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('\uFFFD')) {
      findings.push({ file, line: i + 1, issue: 'U+FFFD', sample: trim(line) });
    }
    if (deepMode && !deepMojibakeAllowFiles.has(rel)) {
      for (const token of mojibakeTokens) {
        if (line.includes(token)) {
          findings.push({ file, line: i + 1, issue: 'Mojibake', sample: trim(line) });
          break;
        }
      }
    }
  }
}

function trim(s) {
  return s.length > 180 ? `${s.slice(0, 180)}...` : s;
}

walk(root);

if (findings.length === 0) {
  console.log(`OK: 未检测到文本污染（模式: ${deepMode ? 'deep' : 'core'}）`);
  process.exit(0);
}

console.error(`发现 ${findings.length} 处文本完整性问题:`);
for (const f of findings) {
  console.error(`${path.relative(root, f.file)}:${f.line} [${f.issue}] ${f.sample}`);
}
process.exit(1);
