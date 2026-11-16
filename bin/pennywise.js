#!/usr/bin/env node
'use strict';
/* PennyWise —— 本地记账 CLI（零依赖，数据存 ~/.pennywise/data.json） */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const VERSION = '0.1.0';
const DATA_DIR = process.env.PENNYWISE_HOME || path.join(os.homedir(), '.pennywise');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* ---------- 终端配色（非 TTY 自动关闭，方便管道解析） ---------- */
const tty = process.stdout.isTTY;
const paint = (s, c) => (tty ? c + s + '\x1b[0m' : s);
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function fail(msg) {
  console.error(paint(`✗ ${msg}`, RED));
  process.exit(1);
}
function ok(msg) {
  console.log(paint(`✓ ${msg}`, GREEN));
}

/* ---------- 数据层：JSON 文件 + 原子写（tmp + rename） ---------- */
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(d.entries)) d.entries = [];
    return d;
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], budget: null };
    const bak = `${DATA_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, bak); } catch (_) { /* 备份失败也继续 */ }
    console.error(paint(`⚠ ${DATA_FILE} 解析失败，已备份到 ${bak}，本次从空数据开始`, YELLOW));
    return { entries: [], budget: null };
  }
}
function save(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- 小工具 ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const fmt = (n) => `¥${n.toFixed(2)}`;

function parseAmount(s, what = '金额') {
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) fail(`${what}必须是大于 0 的数字，收到：${s}`);
  return Math.round(v * 100) / 100;
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return !Number.isNaN(d.getTime())
    && `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === s;
}
function validMonth(s) {
  return /^\d{4}-\d{2}$/.test(s) && validDate(`${s}-01`);
}

function parseArgs(argv) {
  const flags = {
    '-n': 'note', '--note': 'note',
    '-c': 'category', '--category': 'category',
    '-d': 'date', '--date': 'date',
    '-m': 'month', '--month': 'month',
    '--limit': 'limit',
  };
  const opts = { _pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) {
      if (i + 1 >= argv.length) fail(`选项 ${a} 缺少值`);
      opts[flags[a]] = argv[++i];
    } else if (a.length > 1 && a[0] === '-') {
      fail(`未知选项 ${a}（pennywise help 查看用法）`);
    } else {
      opts._pos.push(a);
    }
  }
  return opts;
}

function dateOr(opts) {
  if (opts.date === undefined) return todayLocal();
  if (!validDate(opts.date)) fail(`日期格式应为 YYYY-MM-DD，收到：${opts.date}`);
  return opts.date;
}

/* ---------- 命令实现 ---------- */
function cmdAdd(type, opts) {
  const amount = parseAmount(opts._pos[0]);
  const category = opts.category || (type === 'income' ? '收入' : '其他');
  const date = dateOr(opts);
  const d = load();
  const entry = {
    id: crypto.randomUUID(),
    type, amount, category,
    note: opts.note || '',
    date,
    ts: Date.now(),
  };
  d.entries.push(entry);
  save(d);
  const sign = type === 'income' ? '+' : '-';
  ok(`${type === 'income' ? '收入' : '支出'} ${sign}${fmt(amount)} [${entry.id.slice(0, 8)}]`
    + ` ${category}${entry.note ? ' · ' + entry.note : ''}`);
}

function cmdList(opts) {
  if (opts.month && !validMonth(opts.month)) fail(`月份格式应为 YYYY-MM，收到：${opts.month}`);
  const limit = Math.max(1, parseInt(opts.limit || '20', 10) || 20);
  const d = load();
  let es = d.entries.slice();
  if (opts.month) es = es.filter((e) => e.date.startsWith(opts.month));
  es.sort((a, b) => (`${b.date}${String(b.ts).padStart(15, '0')}`)
    .localeCompare(`${a.date}${String(a.ts).padStart(15, '0')}`));
  es = es.slice(0, limit);
  if (es.length === 0) {
    console.log(paint('（没有记录）', DIM));
    return;
  }
  console.log(paint('  ID        日期         类型  分类      金额          备注', BOLD));
  for (const e of es) {
    const sign = e.type === 'income' ? '+' : '-';
    const amt = paint(`${sign}${fmt(e.amount)}`.padStart(12), e.type === 'income' ? GREEN : RED);
    console.log(`  ${e.id.slice(0, 8)}  ${e.date}  ${e.type === 'income' ? '收入' : '支出'}    `
      + `${(e.category || '').padEnd(8)}  ${amt}  ${paint(e.note || '', DIM)}`);
  }
  console.log(paint(`\n共 ${es.length} 条${opts.month ? `（${opts.month}）` : ''} · 数据文件：${DATA_FILE}`, DIM));
}

function cmdSummary(opts) {
  const month = opts._pos[0] || todayLocal().slice(0, 7);
  if (!validMonth(month)) fail(`月份格式应为 YYYY-MM，收到：${month}`);
  const d = load();
  const es = d.entries.filter((e) => e.date.startsWith(month));
  const income = es.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const expense = es.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const net = income - expense;

  console.log(paint(`${month} 汇总`, BOLD));
  console.log(`  收入合计  ${paint(fmt(income), GREEN)}`);
  console.log(`  支出合计  ${paint(fmt(expense), RED)}`);
  console.log(`  结余      ${paint(fmt(net), net >= 0 ? GREEN : RED)}`);

  const byCat = new Map();
  for (const e of es) {
    if (e.type === 'expense') byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
  }
  if (byCat.size) {
    console.log(`\n  支出分类：`);
    for (const [cat, sum] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = expense > 0 ? (sum / expense) * 100 : 0;
      const bar = paint('█'.repeat(Math.round(pct / 5)).padEnd(20, '░'), BLUE);
      console.log(`    ${(cat || '').padEnd(8)} ${fmt(sum).padStart(11)}  ${bar} ${pct.toFixed(1)}%`);
    }
  }

  if (d.budget) {
    const left = d.budget.amount - expense;
    const pct = Math.round((expense / d.budget.amount) * 100);
    if (left >= 0) {
      console.log(`\n  预算 ${fmt(d.budget.amount)} · 已用 ${pct}% · 剩余 ${paint(fmt(left), GREEN)}`);
    } else {
      console.log(`\n  ${paint(`⚠ 超出预算 ${fmt(-left)}（预算 ${fmt(d.budget.amount)}，已用 ${fmt(expense)}）`, RED)}`);
    }
  } else {
    console.log(paint('\n  提示：pennywise budget 2000 可设置月度预算', DIM));
  }
}

function cmdBudget(opts) {
  const d = load();
  if (opts._pos.length === 0) {
    if (d.budget) console.log(`月度预算：${fmt(d.budget.amount)}（pennywise budget clear 取消）`);
    else console.log('未设置预算（pennywise budget 2000 设置）');
    return;
  }
  const arg = opts._pos[0];
  if (arg === 'clear') {
    d.budget = null;
    save(d);
    ok('已取消预算');
    return;
  }
  const amount = parseAmount(arg, '预算金额');
  d.budget = { amount };
  save(d);
  ok(`月度预算设为 ${fmt(amount)}`);
}

function cmdDelete(opts) {
  const prefix = opts._pos[0];
  if (!prefix) fail('用法：pennywise delete <ID前缀>');
  const d = load();
  const hits = d.entries.filter((e) => e.id.startsWith(prefix));
  if (hits.length === 0) fail(`找不到 ID 前缀为 ${prefix} 的记录`);
  if (hits.length > 1) fail(`前缀 ${prefix} 匹配到 ${hits.length} 条，请多写几位`);
  const e = hits[0];
  d.entries = d.entries.filter((x) => x.id !== e.id);
  save(d);
  ok(`已删除 ${e.date} ${fmt(e.amount)} ${e.category}${e.note ? ' · ' + e.note : ''} [${e.id.slice(0, 8)}]`);
}

/* ---------- 帮助 ---------- */
const HELP = `PennyWise v${VERSION} —— 本地记账 CLI（数据存于 ~/.pennywise/data.json）

用法：pennywise <命令> [参数]

  add <金额> [-n 备注] [-c 分类] [-d 日期]     记一笔支出
  income <金额> [-n 备注] [-c 分类] [-d 日期]  记一笔收入
  list [-m 月份] [--limit N]                  查看记录（默认最近 20 条）
  summary [月份]                              月度汇总（默认本月）
  budget [金额 | clear]                       查看 / 设置 / 取消月度预算
  delete <ID前缀>                             删除一条记录
  help                                        显示本帮助
  version                                     显示版本

示例：
  pennywise add 32.5 -n 午饭 -c 餐饮
  pennywise income 3000 -n 生活费
  pennywise add 128 -c 娱乐 -d 2026-11-01
  pennywise budget 2000
  pennywise summary 2026-11
  pennywise list --limit 5
`;

/* ---------- 入口 ---------- */
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  if (cmd === 'version' || cmd === '-v' || cmd === '--version') {
    console.log(VERSION);
    return;
  }
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'add': return cmdAdd('expense', opts);
    case 'income': return cmdAdd('income', opts);
    case 'list': return cmdList(opts);
    case 'summary': return cmdSummary(opts);
    case 'budget': return cmdBudget(opts);
    case 'delete': return cmdDelete(opts);
    default: fail(`未知命令 ${cmd}（pennywise help 查看用法）`);
  }
}

main();
