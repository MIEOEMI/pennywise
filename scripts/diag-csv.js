#!/usr/bin/env node
'use strict';
/* diag-csv.js —— 对真实账单 CSV 逐列测试表头映射和类型归一化，定位 ingest 无效行根因 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const ZIP = process.argv[2];
if (!ZIP) { console.error('用法: node diag-csv.js <zip文件>'); process.exit(1); }

/* --- 复制 pennywise.js 里的映射逻辑 --- */
const CSV_PATTERNS = [
  [/^(交易时间|交易创建时间|交易日期|日期|date|时间)$/, 'date'],
  [/金额|amount/, 'amount'],
  [/^(收\/?支|交易类型|类型|type|收支)$/, 'type'],
  [/交易对方|商家|merchant|对方/, 'merchant'],
  [/^(备注|note|摘要)$/, 'note'],
  [/^(交易分类|分类|category|类别)$/, 'category'],
  [/^(商品说明|商品|说明)$/, 'note'],
];
function mapHeader(h) {
  const n = String(h || '').toLowerCase().replace(/[\s（）()]/g, '');
  for (const [re, field] of CSV_PATTERNS) if (re.test(n)) return field;
  return null;
}
function normalizeType(s) {
  if (s === undefined || s === null || s === '') return undefined;
  const t = String(s).trim().toLowerCase();
  if (t === 'expense' || s === '支出' || t === 'out') return 'expense';
  if (t === 'income' || s === '收入' || t === 'in') return 'income';
  if (/不计收支|中性交易|other|neutral/.test(t)) return 'skip';
  return null;
}
function splitCsvLine(line) {
  const cells = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
function decodeMaybeGbk(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch (_) { return utf8; }
}

/* --- 解压 --- */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-diag-'));
const r = cp.spawnSync('unzip', ['-o', '-j', ZIP, '-d', work], { encoding: 'buffer' });
console.log('unzip rc =', r.status);
const members = fs.readdirSync(work).filter((m) => /\.(json|csv)$/i.test(m));
console.log('members:', members);

for (const m of members) {
  const text = decodeMaybeGbk(fs.readFileSync(path.join(work, m)));
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  console.log(`\n=== ${m} | 总行数 ${lines.length} ===`);
  /* 找表头行 */
  let headerIdx = -1, cols = null;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const c = splitCsvLine(lines[i]).map(mapHeader);
    if (c.includes('date') && c.includes('amount')) { headerIdx = i; cols = c; break; }
  }
  console.log('headerIdx =', headerIdx);
  if (headerIdx < 0) { console.log('!!! 找不到表头'); continue; }
  console.log('表头原文:', splitCsvLine(lines[headerIdx]).join(' | '));
  console.log('映射结果:', cols.join(' | '));
  /* 逐行统计 */
  let skip = 0, ok = 0, badType = 0, badAmt = 0, badDate = 0;
  const typeSamples = new Map();
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitCsvLine(line);
    const o = {};
    cols.forEach((c, i) => { if (c && cells[i] !== undefined) o[c] = String(cells[i]).trim(); });
    const t = normalizeType(o.type);
    if (t === 'skip') { skip++; continue; }
    if (!t) { badType++; const k = o.type || '(空)'; typeSamples.set(k, (typeSamples.get(k) || 0) + 1); continue; }
    const amt = Number(String(o.amount ?? '').replace(/[¥￥$,]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) { badAmt++; console.log('  坏金额:', JSON.stringify(o.amount), o.date); continue; }
    const date = String(o.date || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { badDate++; console.log('  坏日期:', JSON.stringify(o.date)); continue; }
    ok++;
  }
  console.log(`结果: OK ${ok} · skip(不计收支) ${skip} · 坏类型 ${badType} · 坏金额 ${badAmt} · 坏日期 ${badDate}`);
  if (typeSamples.size) console.log('坏类型样本:', [...typeSamples.entries()].map(([k, n]) => `${k}×${n}`).join(', '));
}
fs.rmSync(work, { recursive: true, force: true });
