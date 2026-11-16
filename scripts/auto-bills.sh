#!/usr/bin/env bash
# auto-bills.sh —— 账单管道全自动：邮箱拉取 → pennywise ingest 导入
# 由 cron 定时调用（见 skill pennywise「自动管道」节）。日志追加到 ~/.pennywise/auto-bills.log
set -u
LOG="$HOME/.pennywise/auto-bills.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(ts)] === auto-bills start ===" >> "$LOG"

# 1) 邮箱拉取（fetch-bills.py 自带：163 认证前 ID、筛选、投递 inbox、防重投）
if python3 /home/agent/workspace/pennywise/scripts/fetch-bills.py >> "$LOG" 2>&1; then
  echo "[$(ts)] fetch OK" >> "$LOG"
else
  echo "[$(ts)] fetch FAILED (rc=$?)" >> "$LOG"
fi

# 2) 收件箱 → 账本（去重、归档 processed/failed）
if pennywise ingest >> "$LOG" 2>&1; then
  echo "[$(ts)] ingest OK" >> "$LOG"
else
  echo "[$(ts)] ingest FAILED (rc=$?)" >> "$LOG"
fi
echo "[$(ts)] === done ===" >> "$LOG"
