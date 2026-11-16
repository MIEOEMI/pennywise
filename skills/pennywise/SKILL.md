---
name: pennywise
description: Use when recording expenses or budgets via pennywise CLI.
version: 2.0.0
license: MIT
metadata:
  hermes:
    tags: [pennywise, cli, expense, accounting, npm]
    related_skills: [email/himalaya]
---

## When to Use

- 主人说「记一笔 X 元 …」→ 直接跑 `pennywise add`，不要问、不要先跑 ingest 以外的动作
- 主人说「拉账单/同步账单」→ 跑 `scripts/auto-sync.sh`，把结果一行摘要回给主人
- 主人说「这个月花了多少 / 查一下 X」→ summary/list 直接答；**非必要不主动翻账本**
- 提到 expense/记账/预算/summary 且上下文是个人财务 → 本 skill

# PennyWise（coder 视角）

## 分工铁律（主人 2026-11-16 定）

- **管道全自动**：邮箱拉取(fetch-bills.py)→导入(ingest)由 cron 机器跑，**不需要 coder 每次手动执行**
- **coder 只负责审核和查阅**：一般情况下不审核、非必要不查阅
- 账单文件投递进 inbox 后由机器合并进账本，**不是 coder 手动 merge**
- ingest 失败 / failed/ 目录有文件 / 主人点名要报告时，coder 才介入看

## 自动管道（已配置 cron）

```
cron 每小时 :40 → scripts/auto-sync.sh
  ├─ fetch-bills.py   163 邮箱拉账单邮件（认证前 ID 绕 Unsafe Login）→ ~/.pennywise/inbox/
  └─ pennywise ingest  inbox → data.json（去重；成功文件归档 processed/，坏文件 failed/）
日志：~/.pennywise/auto-sync.log
```

手动触发同一条链：`bash scripts/auto-sync.sh`，然后 `tail -5 ~/.pennywise/auto-sync.log` 看结果。

## 命令速查

| 命令 | 说明 |
|------|------|
| `pennywise add 32.5 -n 午饭 -c 餐饮 -s 美团` | 记支出（-s 商家，-d 日期默认今天） |
| `pennywise income 3000 -n 生活费` | 记收入 |
| `pennywise show <ID前缀>` | 单条详情 |
| `pennywise list [-q 关键词] [--cat] [--type] [--from/--to] [-m 月]` | 筛选查询（-q 搜商家/备注/分类） |
| `pennywise summary [月]` | 月汇总+分类占比+预算 |
| `pennywise budget 2000 / budget clear` | 月度预算 |
| `pennywise export --format csv/json --out 文件 [--no-note] [--mask] [--replace 旧=新]` | 导出（可剔除/打码/替换） |

## 行为要点

- 时区坑：本机 /etc/localtime=UTC，cron 进程北京时间 00:00-08:00 记账会落到前一天 →
  替主人记账一律显式传 `-d`（当天按 Asia/Shanghai 算）
- 测试用 `PENNYWISE_HOME=/tmp/xxx pennywise …`，否则写进真实账本
- 授权码只在 `~/.config/himalaya/config.toml`（600），fetch-bills.py 从那里读，不落第二份
- 安装：`npm install -g github:MIEOEMI/pennywise`（npmjs 公共源不发，主人已定）
