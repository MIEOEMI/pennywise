#!/usr/bin/env bash
# auto-sync.sh —— PennyWise 账单自动同步：邮箱拉取 → ingest 导入，全自动无人工
# 设计为 cron 定时调用；日志追加到 ~/.pennywise/auto-sync.log
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/.pennywise/auto-sync.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
{
  echo "[$(ts)] === auto-sync 开始 ==="
  python3 "$DIR/fetch-bills.py" 2>&1
  rc1=$?
  pennywise ingest 2>&1
  rc2=$?
  echo "[$(ts)] fetch rc=$rc1 ingest rc=$rc2 === 结束 ==="
} >> "$LOG" 2>&1
