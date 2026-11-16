# PennyWise 💰

本地记账 CLI：零依赖、数据存本地 JSON、一条命令记账。支持账单合并、隐私导出、
邮箱自动收账单。

## 安装

任选其一（不需要 npmjs.com 账号，GitHub 即正式渠道）：

```bash
# ① 直接从 GitHub 安装（npm 或 pnpm 均可）
npm install -g github:MIEOEMI/pennywise
pnpm add -g github:MIEOEMI/pennywise

# ② 从 tarball 安装（npm pack 产物）
npm install -g ./pennywise-0.2.0.tgz

# ③ 从源码目录安装
git clone https://github.com/MIEOEMI/pennywise && cd pennywise
npm install -g .
```

要求 Node ≥ 18。

## 快速上手

```bash
pennywise add 32.5 -n 午饭 -c 餐饮 -s 美团   # 记支出（-s 商家）
pennywise income 3000 -n 生活费              # 记收入
pennywise budget 2000                        # 设月度预算
pennywise summary                            # 本月汇总
pennywise list -q 美团                       # 按商家/关键词筛选
pennywise delete a1b2c3d4                    # 删除一条
pennywise help                               # 全部命令
```

## 命令一览

| 命令 | 说明 |
|---|---|
| `add <金额> [-n 备注] [-c 分类] [-s 商家] [-d 日期]` | 记支出 |
| `income <金额> [-n 备注] [-c 分类] [-s 商家] [-d 日期]` | 记收入 |
| `show <ID前缀>` | 查看单条完整信息（含录入时间） |
| `list [-m 月] [--cat 分类] [--type 类型] [--from 日期] [--to 日期] [-q 关键词] [--limit N]` | 筛选查看，`-q` 搜商家/备注/分类 |
| `summary [月份]` | 月度汇总：收支合计、分类占比条形图、预算进度 |
| `budget [金额 \| clear]` | 查看 / 设置 / 取消月度预算 |
| `delete <ID前缀>` | 删除记录（前缀必须唯一） |
| `merge <账单.json>` | 合并外部账本（pennywise data.json 或 JSON 数组），同日期+金额+商家自动去重；`--force` 不去重 |
| `export [--format csv\|json] [--out 文件]` | 导出账单，支持与 list 相同的筛选 |
| `ingest` | 扫描 `~/.pennywise/inbox/` 导入新账单（JSON/CSV），成功归档 `processed/`、坏文件进 `failed/` |

### 隐私导出（剔除 / 打码 / 替换）

```bash
pennywise export --out all.csv                        # 全量 CSV
pennywise export --no-note --no-id --mask --out safe.csv   # 剔除备注/ID，商家打码
pennywise export -q 美团 --replace "美团=某平台" --out share.json --format json
```

- `--no-note` / `--no-merchant` / `--no-id`：剔除对应字段
- `--mask`：商家与备注打码为 `**`
- `--replace "旧=新"`：可重复多次，作用于商家/备注/分类

## 邮箱自动收账单

`scripts/fetch-bills.py`（零第三方依赖，Python ≥ 3.8）从 163 邮箱拉取账单邮件，
把附件（csv/json/xls）或正文 CSV 投进 `~/.pennywise/inbox/`，再由
`pennywise ingest` 入账：

```bash
python3 scripts/fetch-bills.py --dry-run   # 先看能发现什么，不动收件箱
python3 scripts/fetch-bills.py             # 拉取 → inbox
pennywise ingest                           # 入账 + 归档
```

- 邮箱账号/授权码从 `~/.config/himalaya/config.toml` 读取（单点管理）
- 163 要求 IMAP 认证前发 RFC 2971 ID，脚本已内置处理（himalaya v2 的
  `imap.id.auto` 时序不符，故用标准库 imaplib 实现）
- 筛选规则在脚本头部 `FROM_FILTERS` / `SUBJECT_KEYWORDS`，可自行追加
- 处理过的邮件标已读 + UID 日志（`~/.pennywise/fetch-bills.log`），不会重复投递

## 数据与隐私

- 数据文件：`~/.pennywise/data.json`，纯本地，无任何网络请求（收账单时才连邮箱）
- 环境变量 `PENNYWISE_HOME` 可重定向数据目录（测试 / 多套账本）
- 数据文件损坏时自动备份为 `data.json.corrupt-<时间戳>`，从空数据继续，不丢备份
- 写入为原子替换（tmp + rename），中断不会留半个文件

## 审核

CLI 不内置「AI 审核」——月度分析由 AI 助手直接读账本完成：
对它说「审一下这个月账单」即可（大额、疑似重复扣款、分类偏科、预算外推、
结余率等）。

## License

MIT
