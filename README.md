# PennyWise 💰

本地记账 CLI：零依赖、数据存本地 JSON、一条命令记账。

## 安装

任选其一（都不需要 npmjs.com 账号）：

```bash
# ① 直接从 GitHub 安装
npm install -g github:MIEOEMI/pennywise

# ② 从 tarball 安装（Release 附件或 npm pack 产物）
npm install -g ./pennywise-0.1.0.tgz

# ③ 从源码目录安装
git clone https://github.com/MIEOEMI/pennywise && cd pennywise
npm install -g .
```

要求 Node ≥ 18。

## 快速上手

```bash
pennywise add 32.5 -n 午饭 -c 餐饮     # 记支出
pennywise income 3000 -n 生活费        # 记收入
pennywise budget 2000                  # 设月度预算
pennywise summary                      # 本月汇总
pennywise list --limit 5               # 最近 5 条
pennywise delete a1b2c3d4              # 删除一条
pennywise help                         # 全部命令
```

## 命令一览

| 命令 | 说明 |
|---|---|
| `add <金额> [-n 备注] [-c 分类] [-d YYYY-MM-DD]` | 记支出（日期默认今天，分类默认「其他」） |
| `income <金额> [-n 备注] [-c 分类] [-d 日期]` | 记收入 |
| `list [-m YYYY-MM] [--limit N]` | 查记录（默认最近 20 条） |
| `summary [YYYY-MM]` | 月度汇总：收支合计、分类占比、预算状态 |
| `budget [金额 \| clear]` | 查看 / 设置 / 取消月度预算 |
| `delete <ID前缀>` | 删除记录（前缀必须唯一） |

## 数据与隐私

- 数据文件：`~/.pennywise/data.json`，纯本地，无任何网络请求
- 环境变量 `PENNYWISE_HOME` 可重定向数据目录（测试 / 多套账本）
- 数据文件损坏时自动备份为 `data.json.corrupt-<时间戳>`，并从空数据继续，不会丢备份

## License

MIT
