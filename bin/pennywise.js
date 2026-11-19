#!/usr/bin/env node
'use strict';
/* PennyWise —— 本地记账 CLI（零依赖，数据存 ~/.pennywise/data.json）
   v0.2.0：新增 show/merge/export/review、商家字段、list 筛选、隐私导出 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const VERSION = '0.2.0';
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

/* ---------- 参数解析：值选项 / 布尔开关 / 可多次选项 ---------- */
const VALUE_FLAGS = {
  '-n': 'note', '--note': 'note',
  '-c': 'category', '--category': 'category',
  '-s': 'merchant', '--merchant': 'merchant',
  '-d': 'date', '--date': 'date',
  '-m': 'month', '--month': 'month',
  '--limit': 'limit',
  '-q': 'query', '--query': 'query',
  '-t': 'type', '--cat': 'cat', '--type': 'type',
  '--from': 'from', '--to': 'to',
  '--format': 'format', '--out': 'out',
};
const BOOL_FLAGS = {
  '--no-note': 'noNote', '--no-merchant': 'noMerchant', '--no-id': 'noId',
  '--mask': 'mask', '--force': 'force', '--exclude': 'excludeMode',
};
const MULTI_FLAGS = { '--replace': 'replace', '-r': 'replace' };

function parseArgs(argv) {
  const opts = { _pos: [], replace: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS[a]) {
      if (i + 1 >= argv.length) fail(`选项 ${a} 缺少值`);
      opts[VALUE_FLAGS[a]] = argv[++i];
    } else if (BOOL_FLAGS[a]) {
      opts[BOOL_FLAGS[a]] = true;
    } else if (MULTI_FLAGS[a]) {
      if (i + 1 >= argv.length) fail(`选项 ${a} 缺少值`);
      opts.replace.push(argv[++i]);
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

/* ---------- 通用筛选（list / export 共用） ----------
   支持：-m 月份、--cat 分类、--type 类型、--from/--to 区间、-q 关键词（搜商家+备注+分类） */
function monthOr(opts) {
  const m = opts.month || todayLocal().slice(0, 7);
  if (!validMonth(m)) fail(`月份格式应为 YYYY-MM，收到：${m}`);
  return m;
}
function normalizeType(s) {
  if (s === undefined || s === null || s === '') return undefined;
  const t = String(s).trim().toLowerCase();
  if (t === 'expense' || s === '支出' || s === '支出' || t === 'out') return 'expense';
  if (t === 'income' || s === '收入' || t === 'in') return 'income';
  /* 支付宝「不计收支」/「其他」等中性记录：不算支出也不算收入，跳过不报错 */
  if (/不计收支|中性交易|other|neutral/.test(t)) return 'skip';
  /* 账户互转（小荷包/余额宝 转入转出）：钱只是在自己的账户间搬家 */
  if (t === 'transfer' || s === '互转' || s === '账户互转' || t === 'move') return 'transfer';
  return null;
}
/* 账户互转标记：分类属于自有账户间搬钱的记录，summary 既不计收入也不计支出。
   兼容旧数据（只有 category 没有 transfer 字段）。 */
const TRANSFER_CAT = /^(账户存取)$/;
function isTransfer(e) {
  return Boolean(e) && (e.transfer === true || TRANSFER_CAT.test(String(e.category || '').trim()));
}
function checkFilterDates(opts) {
  if (opts.from && !validDate(opts.from)) fail(`--from 日期格式应为 YYYY-MM-DD，收到：${opts.from}`);
  if (opts.to && !validDate(opts.to)) fail(`--to 日期格式应为 YYYY-MM-DD，收到：${opts.to}`);
  if (opts.month && !validMonth(opts.month)) fail(`月份格式应为 YYYY-MM，收到：${opts.month}`);
}
function filterEntries(es, opts) {
  let out = es.slice();
  if (opts.month) out = out.filter((e) => e.date.startsWith(opts.month));
  if (opts.cat) out = out.filter((e) => (e.category || '') === opts.cat);
  if (opts.type !== undefined) {
    const t = normalizeType(opts.type);
    if (t === 'transfer') {
      out = out.filter(isTransfer);
    } else {
      if (!t || t === 'skip') fail(`--type 应为 expense|income|transfer（或 支出|收入|互转），收到：${opts.type}`);
      out = out.filter((e) => e.type === t && !isTransfer(e));
    }
  }
  if (opts.from) out = out.filter((e) => e.date >= opts.from);
  if (opts.to) out = out.filter((e) => e.date <= opts.to);
  if (opts.query) {
    const q = opts.query.toLowerCase();
    out = out.filter((e) =>
      `${e.merchant || ''} ${e.note || ''} ${e.category || ''}`.toLowerCase().includes(q));
  }
  return out;
}
function sortByRecency(es) {
  return es.sort((a, b) => (`${b.date}${String(b.ts || 0).padStart(15, '0')}`)
    .localeCompare(`${a.date}${String(a.ts || 0).padStart(15, '0')}`));
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
    merchant: opts.merchant || '',
    note: opts.note || '',
    date,
    ts: Date.now(),
  };
  if (TRANSFER_CAT.test(String(category).trim())) entry.transfer = true;
  d.entries.push(entry);
  save(d);
  const sign = type === 'income' ? '+' : '-';
  ok(`${type === 'income' ? '收入' : '支出'} ${sign}${fmt(amount)} [${entry.id.slice(0, 8)}]`
    + ` ${category}${entry.merchant ? ' @' + entry.merchant : ''}${entry.note ? ' · ' + entry.note : ''}`);
}

function displayNote(e) {
  return e.merchant ? `[${e.merchant}] ${e.note || ''}` : (e.note || '');
}

function cmdList(opts) {
  checkFilterDates(opts);
  const limit = Math.max(1, parseInt(opts.limit || '20', 10) || 20);
  const d = load();
  let es = filterEntries(d.entries, opts);
  sortByRecency(es);
  const total = es.length;
  es = es.slice(0, limit);
  if (es.length === 0) {
    console.log(paint('（没有记录）', DIM));
    return;
  }
  console.log(paint('  ID        日期         类型  分类      金额          商家/备注', BOLD));
  for (const e of es) {
    const t = isTransfer(e);
    const sign = e.type === 'income' ? '+' : '-';
    const amt = paint(`${sign}${fmt(e.amount)}`.padStart(12), t ? DIM : (e.type === 'income' ? GREEN : RED));
    const label = t ? '互转' : (e.type === 'income' ? '收入' : '支出');
    console.log(`  ${e.id.slice(0, 8)}  ${e.date}  ${label}    `
      + `${(e.category || '').padEnd(8)}  ${amt}  ${paint(displayNote(e), DIM)}`);
  }
  const extra = [];
  if (opts.month) extra.push(opts.month);
  if (opts.cat) extra.push(`分类=${opts.cat}`);
  if (opts.type) extra.push(`类型=${opts.type}`);
  if (opts.from || opts.to) extra.push(`${opts.from || '…'}~${opts.to || '…'}`);
  if (opts.query) extra.push(`关键词“${opts.query}”`);
  console.log(paint(`\n${total > es.length ? `第 1/${Math.ceil(total / limit)} 页，` : ''}`
    + `显示 ${es.length}/${total} 条${extra.length ? `（${extra.join(' · ')}）` : ''}`
    + ` · 数据文件：${DATA_FILE}`, DIM));
}

function findOne(prefix, d) {
  if (!prefix) fail('用法：pennywise show <ID前缀>');
  const hits = d.entries.filter((e) => e.id.startsWith(prefix));
  if (hits.length === 0) fail(`找不到 ID 前缀为 ${prefix} 的记录`);
  if (hits.length > 1) fail(`前缀 ${prefix} 匹配到 ${hits.length} 条，请多写几位`);
  return hits[0];
}

function cmdShow(opts) {
  const d = load();
  const e = findOne(opts._pos[0], d);
  const rows = [
    ['ID', e.id],
    ['类型', isTransfer(e) ? '账户互转（不计收支）' : (e.type === 'income' ? '收入' : '支出')],
    ['金额', (e.type === 'income' ? '+' : '-') + fmt(e.amount)],
    ['分类', e.category || ''],
    ['商家', e.merchant || '（无）'],
    ['备注', e.note || '（无）'],
    ['日期', e.date],
    ['录入时间', e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : '（未知）'],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) {
    const color = k === '金额' ? (e.type === 'income' ? GREEN : RED) : '';
    console.log(`  ${k.padEnd(w, ' ')}  ${color ? paint(v, color) : v}`);
  }
}

function cmdSummary(opts) {
  const month = opts._pos[0] || todayLocal().slice(0, 7);
  if (!validMonth(month)) fail(`月份格式应为 YYYY-MM，收到：${month}`);
  const d = load();
  const es = d.entries.filter((e) => e.date.startsWith(month));
  const real = es.filter((e) => !isTransfer(e));
  const transfers = es.filter(isTransfer);
  const income = real.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const expense = real.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const net = income - expense;

  console.log(paint(`${month} 汇总`, BOLD));
  console.log(`  收入合计  ${paint(fmt(income), GREEN)}`);
  console.log(`  支出合计  ${paint(fmt(expense), RED)}`);
  console.log(`  结余      ${paint(fmt(net), net >= 0 ? GREEN : RED)}`);
  if (transfers.length) {
    const tin = transfers.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
    const tout = transfers.filter((e) => e.type !== 'income').reduce((s, e) => s + e.amount, 0);
    console.log(paint(`  账户互转  ${transfers.length} 笔 · 转入 ${fmt(tin)} / 转出 ${fmt(tout)}（不计收支）`, DIM));
  }

  const byCat = new Map();
  for (const e of real) {
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
  const e = findOne(prefix, d);
  d.entries = d.entries.filter((x) => x.id !== e.id);
  save(d);
  ok(`已删除 ${e.date} ${fmt(e.amount)} ${e.category}${e.note ? ' · ' + e.note : ''} [${e.id.slice(0, 8)}]`);
}

/* ---------- merge：合并外部账单（pennywise data.json 或裸数组 JSON） ---------- */
function sanitizeEntry(raw, existingIds) {
  if (!raw || typeof raw !== 'object') return { reason: '无效记录' };
  let type = raw.type;
  if (type === '支出') type = 'expense';
  if (type === '收入') type = 'income';
  const norm0 = normalizeType(type);
  /* 支付宝把「小荷包(生活费/零钱/科研金库)」付款的消费标成「不计收支」，
     但这些是真实消费（食堂、奶茶、日用、交通…）。只有分类属于资金搬运的
     （账户存取/退款/转账/信用借还）才真正跳过，其余按支出入账。 */
  const NEUTRAL_SKIP_CAT = /^(账户存取|退款|转账|转账红包|信用借还|收入)$/;
  if (norm0 === 'skip' && /不计收支/.test(String(type || ''))) {
    const cat = String(raw.category || '').trim();
    if (!cat || NEUTRAL_SKIP_CAT.test(cat)) return { skip: true };
    type = 'expense';
  }
  const norm = type === 'expense' ? 'expense' : norm0;
  if (norm === 'skip' || norm === undefined) return { skip: true }; // 中性/缺类型：安静跳过，不算无效
  /* 「交易关闭」= 钱未实际扣/已全额退回，官方统计不计入支出（如押金充值失败） */
  if (/关闭|closed/i.test(String(raw.status || ''))) return { skip: true };
  if (norm) type = norm;
  if (type !== 'expense' && type !== 'income') return { reason: 'type 非法' };
  const amount = Number(cleanAmount(raw.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { reason: '金额非法' };
  const date = String(raw.date || '').trim().slice(0, 10);
  if (!validDate(date)) return { reason: `日期非法（${date}）` };
  let id = typeof raw.id === 'string' && /^[0-9a-f-]{8,}$/.test(raw.id) ? raw.id : crypto.randomUUID();
  if (existingIds.has(id)) id = crypto.randomUUID();   // 撞 ID 就换新的
  existingIds.add(id);
  const category = String(raw.category || (type === 'income' ? '收入' : '其他'));
  const entry = {
    id,
    type,
    amount: Math.round(amount * 100) / 100,
    category,
    merchant: String(raw.merchant || ''),
    note: String(raw.note || ''),
    date,
    ref: String(raw.ref || ''),
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now(),
  };
  /* 自有账户间搬钱（小荷包/余额宝 存取）：标记互转，summary 不计收支 */
  if (TRANSFER_CAT.test(category.trim())) entry.transfer = true;
  return { entry };
}

function cmdMerge(opts) {
  const file = opts._pos[0];
  if (!file) fail('用法：pennywise merge <账单文件.json> [--force]');
  if (!fs.existsSync(file)) fail(`文件不存在：${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`JSON 解析失败：${e.message}`);
  }
  const incoming = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(incoming)) fail('文件里没有找到记录数组（支持 pennywise data.json 或 JSON 数组）');

  const d = load();
  const existingIds = new Set(d.entries.map((e) => e.id));
  const dupKey = (e) => (e.ref ? `REF|${e.ref}` : `${e.date}|${e.type}|${e.amount}|${e.category}|${e.note}|${e.merchant}`);
  const seen = new Set(d.entries.map(dupKey));

  let added = 0, skippedDup = 0, skippedBad = 0, skippedNeutral = 0;
  const badReasons = new Map();
  for (const raw of incoming) {
    const { entry, skip, reason } = sanitizeEntry(raw, existingIds);
    if (skip) { skippedNeutral++; continue; }
    if (!entry) {
      skippedBad++;
      badReasons.set(reason, (badReasons.get(reason) || 0) + 1);
      continue;
    }
    if (!opts.force && seen.has(dupKey(entry))) { skippedDup++; continue; }
    seen.add(dupKey(entry));
    d.entries.push(entry);
    added++;
  }
  save(d);
  ok(`合并完成：新增 ${added} 条${skippedDup ? ` · 跳过重复 ${skippedDup} 条` : ''}`
    + `${skippedNeutral ? ` · 不计收支 ${skippedNeutral} 条` : ''}`
    + `${skippedBad ? ` · 跳过无效 ${skippedBad} 条` : ''}${opts.force ? '（--force 未去重）' : ''}`);
  for (const [r, n] of badReasons) console.log(paint(`    ${r} ×${n}`, DIM));
}

/* ---------- export：导出账单（csv/json），支持筛选、剔除、打码、替换 ---------- */
function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function cmdExport(opts) {
  checkFilterDates(opts);
  const format = (opts.format || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') fail(`--format 应为 csv|json，收到：${opts.format}`);

  const d = load();
  /* --exclude 时 -q/--cat/--type 是「剔除条件」，不能先用来缩小集合：
     基础集只按日期/月份过滤，再从基础集中剔除命中行 */
  const baseOpts = opts.excludeMode
    ? { ...opts, query: undefined, cat: undefined, type: undefined }
    : opts;
  let es = sortByRecency(filterEntries(d.entries, baseOpts));

  /* 模糊剔除：--exclude 时，-q/--cat/--type 命中的行从导出中剔除（其余导出） */
  if (opts.excludeMode) {
    const before = es.length;
    es = es.filter((e) => {
      if (opts.query) {
        const q = opts.query.toLowerCase();
        if (`${e.merchant || ''} ${e.note || ''} ${e.category || ''}`.toLowerCase().includes(q)) return false;
      }
      if (opts.cat && (e.category || '') === opts.cat) return false;
      if (opts.type !== undefined) {
        const t = normalizeType(opts.type);
        if (t && e.type === t) return false;
      }
      return true;
    });
    console.error(paint(`[stderr] 模糊剔除：${before - es.length} 条命中（关键词=${opts.query || '-'} 分类=${opts.cat || '-'}），已从导出中剔除`, DIM));
  }

  /* 替换规则："旧=新"，可多次；作用于备注/商家/分类 */
  const rules = [];
  for (const r of opts.replace || []) {
    const i = r.indexOf('=');
    if (i <= 0) fail(`--replace 格式应为 "旧=新"，收到：${r}`);
    rules.push([r.slice(0, i), r.slice(i + 1)]);
  }
  const applyRules = (s) => {
    let out = s;
    for (const [from, to] of rules) out = out.split(from).join(to);
    return out;
  };
  const mask = (s) => String(s).replace(/./g, '*');

  const rows = es.map((e) => {
    const r = {
      id: opts.noId ? undefined : e.id,
      date: e.date,
      type: e.type,
      category: applyRules(e.category || ''),
      merchant: opts.noMerchant ? undefined : (opts.mask ? mask(e.merchant || '') : applyRules(e.merchant || '')),
      amount: e.amount,
      note: opts.noNote ? undefined : (opts.mask ? mask(e.note || '') : applyRules(e.note || '')),
    };
    if (format === 'json') r.ts = e.ts;
    return r;
  });

  let text;
  if (format === 'json') {
    text = JSON.stringify(rows, null, 2) + '\n';
  } else {
    const cols = ['id', 'date', 'type', 'category', 'merchant', 'amount', 'note']
      .filter((c) => rows.every((r) => r[c] !== undefined) || rows.some((r) => r[c] !== undefined));
    const used = [...new Set(cols)].filter((c) => rows.some((r) => r[c] !== undefined));
    text = used.join(',') + '\n'
      + rows.map((r) => used.map((c) => csvEscape(r[c])).join(',')).join('\n') + '\n';
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, text);
    ok(`已导出 ${rows.length} 条 → ${opts.out}（${format.toUpperCase()}`
      + `${opts.mask ? ' · 已打码' : ''}${opts.noNote ? ' · 已剔除备注' : ''}`
      + `${rules.length ? ` · 替换规则 ${rules.length} 条` : ''}）`);
  } else {
    process.stdout.write(text);
    console.error(paint(`[stderr] 共 ${rows.length} 条（筛选：`
      + [opts.month, opts.cat, opts.type, opts.from && `>=${opts.from}`, opts.to && `<=${opts.to}`, opts.query]
        .filter(Boolean).join(' · ') || '全部' + '）', DIM));
  }
}

/* ---------- ingest：扫描收件箱 ~/.pennywise/inbox/，导入 json/csv/zip 账单 ----------
   成功的文件移入 inbox/processed/，解析失败的移入 inbox/failed/（保留现场）
   ZIP（微信/支付宝/银行账单邮件的标准格式）：用系统 unzip 解出里面的 csv/json/xlsx 再解析；
   密码取 ~/.pennywise/zip-passwords.txt（每行一个，依次尝试）。
   xlsx 是 zip 容器：从中提取 sheet1 的共享字符串 + 行内单元格引用拼成 CSV。 */
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
/* 表头模糊匹配：微信账单是「交易时间/收/支/金额(元)/交易对方」，
   支付宝是「交易创建时间/收/支/金额」，都对齐到 date/type/amount/merchant/note/category */
const CSV_PATTERNS = [
  [/^(交易时间|交易创建时间|交易日期|日期|date|时间)$/, 'date'],
  [/金额|amount/, 'amount'],
  [/^(收\/?支|交易类型|类型|type|收支)$/, 'type'],
  [/^(交易对方|商家|商户|merchant|对方)$/, 'merchant'],
  [/^(备注|note|摘要)$/, 'note'],
  [/^(交易分类|分类|category|类别)$/, 'category'],
  [/^(商品说明|商品|说明)$/, 'note'],
  [/^(交易状态|状态|status)$/, 'status'],
  [/^(交易订单号|订单号|orderid|ref)$/, 'ref'],
];
function mapHeader(h) {
  const n = String(h || '').toLowerCase().replace(/[\s（）()]/g, '');
  for (const [re, field] of CSV_PATTERNS) if (re.test(n)) return field;
  return null;
}
function cleanAmount(s) {
  return String(s ?? '').replace(/[¥￥$,\s]/g, '');
}
function decodeMaybeGbk(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;   // 没有替换符就是干净的 utf8
  try { return new TextDecoder('gbk').decode(buf); } catch (_) { return utf8; }
}
/* 表头映射 + 行对象化（CSV 文本与 xlsx 二维数组共用）：
   表头行不一定是第 1 行（微信/支付宝账单前 N 行是账户说明），
   找第一行能映射出 date+amount 两列的行当表头。 */
function headerMapFromCells(cells) {
  const mapped = cells.map(mapHeader);
  return mapped.includes('date') && mapped.includes('amount') ? mapped : null;
}
const EXCEL_EPOCH = Date.UTC(1899, 11, 30); // Excel 日期序列号起点（含 1900 闰年 bug 偏移）
function excelDateToISO(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return String(v || '');
  const d = new Date(EXCEL_EPOCH + Math.round(n * 86400000));
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function rowsToEntries(rows) {
  let cols = null, headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const hm = headerMapFromCells(rows[i]);
    if (hm) { cols = hm; headerIdx = i; break; }
  }
  if (!cols) throw new Error('表头里找不到日期列和金额列');
  return rows.slice(headerIdx + 1).map((cells) => {
    const o = {};
    cols.forEach((c, i) => { if (c && cells[i] !== undefined) o[c] = String(cells[i]).trim(); });
    if (o.date) {
      o.date = excelDateToISO(String(o.date).trim());
      o.date = o.date.replace(/\//g, '-').slice(0, 10);
    }
    if (o.amount) o.amount = cleanAmount(o.amount);
    /* 微信用 / 表示空值：清掉，避免订单号/商家变成字面 "/" */
    for (const k of Object.keys(o)) if (o[k] === '/') o[k] = '';
    return o;
  });
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV 至少要有表头和一行数据');
  return rowsToEntries(lines.map(splitCsvLine));
}
/* xlsx 是 zip 容器：无需第三方库，直接解析 sharedStrings.xml + sheet1 的行内
   单元格引用拼出二维表。支持字符串(共享表/内联)与数字单元格，导出为 CSV 行。 */
function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}
function matchAll(text, re) {
  const out = []; let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}
function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseXlsx(buf) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-xlsx-'));
  try {
    fs.writeFileSync(path.join(tmp, 'in.xlsx'), buf);
    const r = cp.spawnSync('unzip', ['-o', '-j', path.join(tmp, 'in.xlsx'),
      'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', '-d', tmp],
      { encoding: 'buffer' });
    if (r.status !== 0) throw new Error('xlsx 解压失败（不是标准 xlsx？）');
    /* 按 <si> 块解析：富文本单元格一个 si 里有多个 <t>，必须合并成一个字符串，
       否则索引错位（微信账单 count=690 / uniqueCount=231 就是这种情况） */
    const shared = matchAll(
      fs.readFileSync(path.join(tmp, 'sharedStrings.xml'), 'utf8'),
      /<si>([\s\S]*?)<\/si>/g,
    ).map((m) => matchAll(m[1], /<t[^>]*>([\s\S]*?)<\/t>/g)
      .map((t) => xmlDecode(t[1])).join(''));
    const sheet = fs.readFileSync(path.join(tmp, 'sheet1.xml'), 'utf8');
    const rows = [];
    for (const rowM of matchAll(sheet, /<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      /* 属性必须单独抓：之前把 t="s" 放进可选组，惰性匹配会跳过它，
         导致共享字符串引用没解析、单元格值全是索引号 */
      for (const cM of matchAll(rowM[1], /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cM[1];
        const inner = cM[2] || '';
        const rM = /r="([A-Z]+)(\d+)"/.exec(attrs);
        const tM = /t="(\w+)"/.exec(attrs);
        if (!rM) continue;
        const letters = rM[1];
        const t = tM ? tM[1] : undefined;
        let v = '';
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const isM = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(inner);
        if (t === 's' && vM) v = shared[+vM[1]] ?? '';
        else if (t === 'inlineStr' && isM) v = xmlDecode(isM[1]);
        else if (vM) v = xmlDecode(vM[1]);
        const idx = colLettersToIndex(letters);
        cells[idx] = v;
      }
      rows.push(cells);
    }
    if (!rows.length) throw new Error('xlsx 没有数据行');
    const width = Math.max(...rows.map((r) => r.length));
    return rows.map((r) => {
      const out = [];
      for (let i = 0; i < width; i++) out.push(r[i] === undefined ? '' : r[i]);
      return out;
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }
}
function cmdIngest() {
  const inbox = path.join(DATA_DIR, 'inbox');
  if (!fs.existsSync(inbox)) { console.log(paint('收件箱为空（没有 ~/.pennywise/inbox/）', DIM)); return; }
  const files = fs.readdirSync(inbox).filter((f) => /\.(json|csv|zip)$/i.test(f)).sort();
  if (!files.length) { console.log(paint('收件箱为空（没有待导入账单）', DIM)); return; }
  const procDir = path.join(inbox, 'processed');
  const failDir = path.join(inbox, 'failed');
  fs.mkdirSync(procDir, { recursive: true });
  fs.mkdirSync(failDir, { recursive: true });
  const d = load();
  const existingIds = new Set(d.entries.map((e) => e.id));
  const dupKey = (e) => (e.ref ? `REF|${e.ref}` : `${e.date}|${e.type}|${e.amount}|${e.category}|${e.note}|${e.merchant}`);
  const seen = new Set(d.entries.map(dupKey));
  let totalAdded = 0, totalDup = 0, totalBad = 0, totalSkipped = 0;
  /* ZIP 密码候选：~/.pennywise/zip-passwords.txt 每行一个 */
  const zipPasswords = [''];
  const pwFile = path.join(DATA_DIR, 'zip-passwords.txt');
  if (fs.existsSync(pwFile)) {
    for (const line of fs.readFileSync(pwFile, 'utf8').split(/\r?\n/)) {
      const p = line.trim();
      if (p) zipPasswords.push(p);
    }
  }
  function extractZip(full, f) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-zip-'));
    try {
      for (const pw of zipPasswords) {
        const args = ['-o', '-j'];                     // 覆盖、去掉目录结构
        if (pw) args.push('-P', pw);
        args.push(full, '-d', work);
        const r = cp.spawnSync('unzip', args, { encoding: 'buffer' });
        if (r.status === 0) {
          const members = fs.readdirSync(work).filter((m) => /\.(json|csv|xlsx|xls)$/i.test(m));
          if (!members.length) throw new Error('ZIP 里没有 json/csv/xlsx 账单');
          return members.map((m) => ({
            name: `${f}::${m}`,
            text: /\.(xlsx|xls)$/i.test(m) ? undefined : decodeMaybeGbk(fs.readFileSync(path.join(work, m))),
            buf: /\.(xlsx|xls)$/i.test(m) ? fs.readFileSync(path.join(work, m)) : undefined,
          }));
        }
      }
      throw new Error('unzip 解压失败（密码不对或文件损坏）');
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
  }
  for (const f of files) {
    const full = path.join(inbox, f);
    try {
      let incoming;                                    // [ {name, text} ]，统一成文件形态
      if (/\.zip$/i.test(f)) {
        incoming = extractZip(full, f);
      } else {
        incoming = [{ name: f, text: fs.readFileSync(full, 'utf8') }];
      }
      let added = 0, dup = 0, bad = 0, skipped = 0;
      for (const part of incoming) {
        let rows;
        if (/\.json$/i.test(part.name)) {
          const parsed = JSON.parse(part.text);
          rows = Array.isArray(parsed) ? parsed : parsed.entries;
        } else if (/\.xlsx?$/i.test(part.name)) {
          /* xlsx 需要原始字节（parseXlsx 内部自己解压），返回二维数组直接映射 */
          if (!part.buf) throw new Error('xlsx 缺少原始字节');
          rows = rowsToEntries(parseXlsx(part.buf));
        } else {
          rows = parseCsv(part.text);
        }
        if (!Array.isArray(rows)) throw new Error('文件里没有记录数组');
        for (const raw of rows) {
          const { entry, skip } = sanitizeEntry(raw, existingIds);
          if (skip) { skipped++; continue; }
          if (!entry) { bad++; continue; }
          if (seen.has(dupKey(entry))) { dup++; continue; }
          seen.add(dupKey(entry));
          d.entries.push(entry);
          added++;
        }
      }
      totalAdded += added; totalDup += dup; totalBad += bad; totalSkipped += skipped;
      fs.renameSync(full, path.join(procDir, `${Date.now()}-${f}`));
      ok(`${f}：新增 ${added}${dup ? ` · 重复 ${dup}` : ''}${skipped ? ` · 不计收支 ${skipped}` : ''}${bad ? ` · 无效 ${bad}` : ''}`);
    } catch (err) {
      try { fs.renameSync(full, path.join(failDir, `${Date.now()}-${f}`)); } catch (_) { /* 忽略 */ }
      console.error(paint(`✗ ${f} 处理失败：${err.message}（文件已移入 inbox/failed/）`, RED));
    }
  }
  save(d);
  console.log(paint(`收件箱处理完毕：新增 ${totalAdded} · 重复跳过 ${totalDup} · 不计收支 ${totalSkipped} · 无效跳过 ${totalBad}`, BOLD));
}

/* ---------- 帮助 ---------- */
const HELP = `PennyWise v${VERSION} —— 本地记账 CLI（数据存于 ~/.pennywise/data.json）

用法：pennywise <命令> [参数]

记账
  add <金额> [-n 备注] [-c 分类] [-s 商家] [-d 日期]     记一笔支出
  income <金额> [-n 备注] [-c 分类] [-s 商家] [-d 日期]  记一笔收入
  delete <ID前缀>                                       删除一条记录

查看
  show <ID前缀>                        查看单条完整信息
  list [-m 月] [--cat 分类] [--type 类型] [--from 日期] [--to 日期] [-q 关键词] [--limit N]
                                       筛选查看（-q 搜商家/备注/分类）
  summary [月份]                       月度汇总（默认本月）
  budget [金额 | clear]                查看 / 设置 / 取消月度预算

账单工具
  ingest                               导入收件箱（~/.pennywise/inbox/）里的账单，自动去重、归档
  merge <文件.json> [--force]          合并外部账单（自动按同日期+金额+商家去重）
  export [--format csv|json] [--out 文件]
        [--from 日期] [--to 日期] [-m 月] [--cat 分类] [--type 类型] [-q 关键词]
        [--exclude] [--no-note] [--no-merchant] [--no-id] [--mask] [--replace "旧=新"]...
                                       导出账单；--exclude 时命中的行被剔除（模糊剔除），
                                       --replace 子串替换（模糊），可剔除/打码/替换隐私信息后导出

其他
  help                                 显示本帮助
  version                              显示版本

示例：
  pennywise add 32.5 -n 午饭 -c 餐饮 -s 美团
  pennywise list -q 美团                       # 查某商家的所有消费
  pennywise list --from 2026-11-01 --to 2026-11-15
  pennywise merge ~/old-data.json              # 合并旧账本（自动去重）
  pennywise export --out 11月.csv              # 导出本月 CSV
  # 把微信/支付宝/银行导出的 json|csv 丢进 ~/.pennywise/inbox/，然后：
  pennywise ingest                             # 自动导入收件箱全部账单
  pennywise export --no-note --mask --out share.csv   # 隐私处理后再导出
  pennywise export -q 美团 --replace "美团=某平台" --out safe.json --format json
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
    case 'show': return cmdShow(opts);
    case 'list': return cmdList(opts);
    case 'summary': return cmdSummary(opts);
    case 'budget': return cmdBudget(opts);
    case 'delete': return cmdDelete(opts);
    case 'merge': return cmdMerge(opts);
    case 'ingest': return cmdIngest(opts);
    case 'export': return cmdExport(opts);
    default: fail(`未知命令 ${cmd}（pennywise help 查看用法）`);
  }
}

/* 可导入测试：直接执行时才跑 main（文件被 require 时不产生副作用） */
if (require.main === module) main();
else module.exports = { parseXlsx, rowsToEntries, sanitizeEntry, parseCsv };
