#!/usr/bin/env python3
"""fetch-bills.py —— 从 163 邮箱拉取账单邮件，把账单文件放进 PennyWise 收件箱。

163 邮箱要求在 IMAP 认证【前】发送 RFC 2971 ID 命令，否则 SELECT 报
"Unsafe Login"。himalaya 的 imap.id.auto 是认证后才发，时序不符，
所以本脚本用 Python 标准库 imaplib 自行处理（零第三方依赖）。

用法：
  python3 fetch-bills.py            # 拉取并投递账单附件/正文到 ~/.pennywise/inbox/
  python3 fetch-bills.py --dry-run  # 只看发现什么，不动 inbox

筛选规则（from 或 subject 命中其一即可）：
  from: bank@163.com, bill@163.com（可自行追加）
  subject 含: 账单 / 对账单 / 交易明细 / 流水 / bill / statement

处理策略：
  - 邮件有附件（csv/json/xlsx）→ 存附件进 inbox
  - 无附件但正文含 CSV 表头（日期,金额 等）→ 正文存成 <msgid>.csv
  - 处理过的邮件标 \\Seen 防止重复投递；账单文件名加 msgid 前缀防覆盖
"""
import email
import imaplib
import os
import re
import sys
import time
from email.header import decode_header
from email.utils import parseaddr

sys_exit = sys.exit


def read_pw_from_himalaya_config():
    """从 himalaya 配置读 IMAP 授权码（单点管理，不落第二份明文）。"""
    cfg = os.path.join(HOME, ".config", "himalaya", "config.toml")
    try:
        with open(cfg, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    m = re.search(r'imap\.sasl\.login\.password\.raw\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else None

HOME = os.path.expanduser("~")
INBOX_DIR = os.path.join(HOME, ".pennywise", "inbox")
SEEN_LOG = os.path.join(HOME, ".pennywise", "fetch-bills.log")

FROM_FILTERS = ("bank@163.com", "bill@163.com")
SUBJECT_KEYWORDS = ("账单", "对账单", "交易明细", "流水", "bill", "statement")
BILL_EXTS = (".csv", ".json", ".xlsx", ".xls")

# 账单正文常见 CSV 表头片段（无附件时据此判断正文即账单）
CSV_HEADER_HINTS = ("日期", "金额", "交易时间", "交易金额", "date", "amount")


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line)
    try:
        os.makedirs(os.path.dirname(SEEN_LOG), exist_ok=True)
        with open(SEEN_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def dec(s):
    """RFC2047 解码邮件头。"""
    if not s:
        return ""
    out = ""
    for part, enc in decode_header(s):
        if isinstance(part, bytes):
            out += part.decode(enc or "utf-8", "replace")
        else:
            out += part
    return out


def read_account_from_himalaya_config():
    """从 himalaya 配置读 IMAP 用户名+授权码（单点管理，不落第二份明文）。"""
    cfg = os.path.join(HOME, ".config", "himalaya", "config.toml")
    try:
        with open(cfg, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None, None
    mu = re.search(r'imap\.sasl\.login\.username\s*=\s*"([^"]+)"', text)
    mp = re.search(r'imap\.sasl\.login\.password\.raw\s*=\s*"([^"]+)"', text)
    return (mu.group(1) if mu else None, mp.group(1) if mp else None)


def authorize_163():
    """登录 163 IMAP：认证前先发 ID（163 硬要求），返回已登录连接。"""
    user, authcode = read_account_from_himalaya_config()
    if not user or not authcode:
        sys_exit("拿不到账号/授权码：~/.config/himalaya/config.toml 缺 imap.sasl.login 配置")
    m = imaplib.IMAP4_SSL("imap.163.com", 993)
    typ, _ = m.xatom(
        "ID",
        '("name" "pennywise-fetcher" "version" "1.0" "vendor" "MIEOEMI")',
    )
    if typ != "OK":
        raise RuntimeError(f"163 要求认证前发 ID 命令，服务器拒绝：{typ}")
    typ, data = m.login(user, authcode)
    if typ != "OK":
        raise RuntimeError(f"登录失败：{data}")
    return m


def parts_of(msg):
    """展平 MIME 树，返回 (part, charset) 列表。"""
    out = []

    def walk(p):
        if p.is_multipart():
            for sp in p.get_payload():
                walk(sp)
        else:
            out.append(p)

    walk(msg)
    return out


def pick_payloads(msg):
    """从一封信里提取：账单附件列表 + 可能是账单的正文字节。"""
    atts = []
    body_csv = None
    for p in parts_of(msg):
        fn = dec(p.get_filename())
        if fn and fn.lower().endswith(BILL_EXTS):
            blob = p.get_payload(decode=True)
            if blob:
                atts.append((fn, blob))
            continue
        ctype = (p.get_content_type() or "").lower()
        if ctype in ("text/plain", "text/csv", "application/csv") and body_csv is None:
            blob = p.get_payload(decode=True)
            if not blob:
                continue
            charset = p.get_content_charset() or "utf-8"
            text = blob.decode(charset, "replace")
            low = text[:2000].lower()
            if any(h.lower() in low for h in CSV_HEADER_HINTS) and (
                "," in text or "\t" in text
            ):
                body_csv = text
    return atts, body_csv


def safe_name(name, msgid):
    base = re.sub(r'[\\/:*?"<>|\s]+', "_", name)[:80]
    return f"{msgid}-{base}"


def main():
    dry = "--dry-run" in sys.argv
    os.makedirs(INBOX_DIR, exist_ok=True)

    # 已处理过的邮件不再重复投递（记录 IMAP UID）
    processed = set()
    if os.path.exists(SEEN_LOG):
        with open(SEEN_LOG, encoding="utf-8") as f:
            processed = {ln.split("uid=")[-1].strip() for ln in f if "uid=" in ln}

    pw = read_pw_from_himalaya_config()
    if not pw:
        sys_exit("拿不到授权码：~/.config/himalaya/config.toml 里没有 imap.sasl.login.password.raw")
    del pw  # 仅确认存在，不在日志/输出中出现

    m = authorize_163()
    m.select("INBOX", readonly=True)
    typ, data = m.uid("search", None, "ALL")
    uids = data[0].split()
    log(f"INBOX 共 {len(uids)} 封，已处理 {len(processed)} 封，开始筛选…")

    delivered = 0
    for raw_uid in reversed(uids):  # 新邮件优先
        uid = raw_uid.decode()
        if uid in processed:
            continue
        typ, msg_data = m.uid("fetch", raw_uid, "(RFC822)")
        if typ != "OK" or not msg_data or msg_data[0] is None:
            continue
        msg = email.message_from_bytes(msg_data[0][1])

        sender = parseaddr(dec(msg.get("From", "")))[1].lower()
        subject = dec(msg.get("Subject", ""))
        subj_hit = any(k in subject.lower() for k in SUBJECT_KEYWORDS)
        from_hit = sender.endswith(FROM_FILTERS) or sender in FROM_FILTERS
        if not (subj_hit or from_hit):
            continue

        atts, body_csv = pick_payloads(msg)
        if not atts and not body_csv:
            continue  # 关键词命中但没有账单内容，不动它

        log(f"命中：uid={uid} from={sender} subj={subject!r}")
        if dry:
            continue

        ok_flag = False
        for fn, blob in atts:
            target = os.path.join(INBOX_DIR, safe_name(fn, uid))
            with open(target, "wb") as f:
                f.write(blob)
            log(f"  附件 → {target} ({len(blob)} bytes)")
            ok_flag = True
        if body_csv:
            target = os.path.join(INBOX_DIR, f"{uid}-body.csv")
            with open(target, "w", encoding="utf-8") as f:
                f.write(body_csv)
            log(f"  正文 → {target} ({len(body_csv)} chars)")
            ok_flag = True

        if ok_flag:
            # 标已读，防下次重复处理（只标记，不删邮件）
            try:
                m.uid("store", raw_uid, "+FLAGS", "(\\Seen)")
            except imaplib.IMAP4.error as e:
                log(f"  ⚠ 标记已读失败：{e}")
            with open(SEEN_LOG, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} uid={uid} delivered\n")
            delivered += 1

    m.logout()
    log(f"完成：投递 {delivered} 封 → {INBOX_DIR}")


if __name__ == "__main__":
    main()
