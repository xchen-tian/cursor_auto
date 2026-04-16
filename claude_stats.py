#!/usr/bin/env python3
"""
Claude Code 本地 session 统计工具
扫描 ~/.claude/projects/ 下所有项目的 JSONL session 文件，
统计 cost、token 用量、tool 使用、对话轮次等。

用法:
    python3 claude_stats.py                    # 全部项目汇总
    python3 claude_stats.py -p cursor_auto     # 按关键词过滤项目
    python3 claude_stats.py -s                 # 显示每个 session 明细
    python3 claude_stats.py --json             # JSON 输出
    python3 claude_stats.py --since 2026-04-01 # 只统计某日期之后
"""

import json
import os
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

# ── Anthropic 定价 (USD per million tokens) ──────────────────────────
# https://docs.anthropic.com/en/docs/about-claude/pricing
PRICING = {
    "claude-opus-4-6":   {"input": 15.0,  "output": 75.0,  "cache_write": 18.75,  "cache_read": 1.50},
    "claude-opus-4-5-20250620": {"input": 15.0, "output": 75.0, "cache_write": 18.75, "cache_read": 1.50},
    "claude-sonnet-4-6": {"input": 3.0,   "output": 15.0,  "cache_write": 3.75,   "cache_read": 0.30},
    "claude-sonnet-4-5-20250514": {"input": 3.0, "output": 15.0, "cache_write": 3.75, "cache_read": 0.30},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.0, "cache_write": 1.0, "cache_read": 0.08},
    # 旧版 fallback
    "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0, "cache_write": 3.75, "cache_read": 0.30},
    "claude-3-5-haiku-20241022":  {"input": 0.80, "output": 4.0, "cache_write": 1.0, "cache_read": 0.08},
}
# 未知模型 fallback (用 sonnet 价格)
DEFAULT_PRICING = {"input": 3.0, "output": 15.0, "cache_write": 3.75, "cache_read": 0.30}


def get_pricing(model: str) -> dict:
    if model in PRICING:
        return PRICING[model]
    # 模糊匹配: "opus" -> opus pricing, "haiku" -> haiku pricing
    ml = model.lower()
    if "opus" in ml:
        return PRICING["claude-opus-4-6"]
    if "haiku" in ml:
        return PRICING["claude-haiku-4-5-20251001"]
    if "sonnet" in ml:
        return PRICING["claude-sonnet-4-6"]
    return DEFAULT_PRICING


def calc_cost(model: str, usage: dict) -> float:
    """根据 token 用量和模型定价计算 USD 费用"""
    p = get_pricing(model)
    input_tok = usage.get("input_tokens", 0) or 0
    output_tok = usage.get("output_tokens", 0) or 0
    cache_write_tok = usage.get("cache_creation_input_tokens", 0) or 0
    cache_read_tok = usage.get("cache_read_input_tokens", 0) or 0

    cost = (
        input_tok * p["input"] / 1_000_000
        + output_tok * p["output"] / 1_000_000
        + cache_write_tok * p["cache_write"] / 1_000_000
        + cache_read_tok * p["cache_read"] / 1_000_000
    )
    return cost


def parse_timestamp(ts: str) -> datetime | None:
    if not ts:
        return None
    try:
        # "2026-03-23T13:13:29.980Z"
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def parse_session(filepath: Path, since: datetime | None = None) -> dict | None:
    """解析一个 session JSONL 文件，返回统计数据"""
    session_id = filepath.stem
    stats = {
        "session_id": session_id,
        "file": str(filepath),
        "file_size_bytes": filepath.stat().st_size,
        "title": None,
        "summary": None,
        "models": defaultdict(int),     # model -> assistant_msg_count
        "tokens": {
            "input": 0,
            "output": 0,
            "cache_write": 0,
            "cache_read": 0,
        },
        "cost_usd": 0.0,
        "user_messages": 0,
        "assistant_messages": 0,
        "tool_uses": defaultdict(int),  # tool_name -> count
        "entrypoint": None,
        "version": None,
        "git_branch": None,
        "cwd": None,
        "first_timestamp": None,
        "last_timestamp": None,
        "duration_seconds": 0,
        "record_count": 0,
        "is_sidechain": False,
    }

    first_ts = None
    last_ts = None
    seen_uuids = set()  # 去重 (有些记录会重复出现)

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                stats["record_count"] += 1
                rtype = rec.get("type", "")
                ts = parse_timestamp(rec.get("timestamp", ""))

                if ts:
                    if first_ts is None or ts < first_ts:
                        first_ts = ts
                    if last_ts is None or ts > last_ts:
                        last_ts = ts

                # 元数据 (取第一个 user 记录的)
                if rtype == "user" and not stats["entrypoint"]:
                    stats["entrypoint"] = rec.get("entrypoint")
                    stats["version"] = rec.get("version")
                    stats["git_branch"] = rec.get("gitBranch")
                    stats["cwd"] = rec.get("cwd")

                if rtype == "ai-title":
                    stats["title"] = rec.get("aiTitle")

                if rtype == "summary":
                    stats["summary"] = rec.get("summary")

                if rtype == "user":
                    uuid = rec.get("uuid")
                    if uuid and uuid not in seen_uuids:
                        seen_uuids.add(uuid)
                        # 不统计 isMeta 消息
                        if not rec.get("isMeta"):
                            stats["user_messages"] += 1

                if rtype == "assistant":
                    msg = rec.get("message", {})
                    model = msg.get("model", "")
                    uuid = rec.get("uuid")

                    # 跳过 synthetic (compaction summary)
                    if model == "<synthetic>":
                        continue

                    # 去重
                    if uuid and uuid in seen_uuids:
                        continue
                    if uuid:
                        seen_uuids.add(uuid)

                    if rec.get("isSidechain"):
                        stats["is_sidechain"] = True

                    stats["assistant_messages"] += 1
                    if model:
                        stats["models"][model] += 1

                    usage = msg.get("usage", {})
                    stats["tokens"]["input"] += usage.get("input_tokens", 0) or 0
                    stats["tokens"]["output"] += usage.get("output_tokens", 0) or 0
                    stats["tokens"]["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
                    stats["tokens"]["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
                    stats["cost_usd"] += calc_cost(model, usage)

                    # 统计 tool_use
                    content = msg.get("content", [])
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "tool_use":
                                tool_name = block.get("name", "unknown")
                                stats["tool_uses"][tool_name] += 1

    except Exception as e:
        print(f"  Warning: failed to parse {filepath}: {e}", file=sys.stderr)
        return None

    if first_ts:
        stats["first_timestamp"] = first_ts.isoformat()
    if last_ts:
        stats["last_timestamp"] = last_ts.isoformat()
    if first_ts and last_ts:
        stats["duration_seconds"] = (last_ts - first_ts).total_seconds()

    # 如果设置了 since 过滤
    if since and last_ts and last_ts < since:
        return None

    # 转换 defaultdict -> dict for JSON serialization
    stats["models"] = dict(stats["models"])
    stats["tool_uses"] = dict(stats["tool_uses"])

    return stats


def scan_projects(claude_dir: Path, project_filter: str | None = None, since: datetime | None = None) -> list[dict]:
    """扫描所有项目，返回 project 级别的统计"""
    projects_dir = claude_dir / "projects"
    if not projects_dir.exists():
        print(f"Error: {projects_dir} not found", file=sys.stderr)
        sys.exit(1)

    projects = []
    for proj_dir in sorted(projects_dir.iterdir()):
        if not proj_dir.is_dir():
            continue

        proj_name = proj_dir.name
        # 还原可读路径: 从 session 的 cwd 字段获取真实路径
        readable_path = proj_name  # fallback

        if project_filter and project_filter.lower() not in proj_name.lower():
            continue

        jsonl_files = sorted(proj_dir.glob("*.jsonl"))
        if not jsonl_files:
            continue

        sessions = []
        for jf in jsonl_files:
            s = parse_session(jf, since=since)
            if s:
                sessions.append(s)

        if not sessions:
            continue

        # 从 session 的 cwd 字段还原真实路径
        for s in sessions:
            if s.get("cwd"):
                readable_path = s["cwd"]
                break

        # 汇总 project 级别
        proj_stats = {
            "project_dir": proj_name,
            "readable_path": readable_path,
            "session_count": len(sessions),
            "total_cost_usd": sum(s["cost_usd"] for s in sessions),
            "total_tokens": {
                "input": sum(s["tokens"]["input"] for s in sessions),
                "output": sum(s["tokens"]["output"] for s in sessions),
                "cache_write": sum(s["tokens"]["cache_write"] for s in sessions),
                "cache_read": sum(s["tokens"]["cache_read"] for s in sessions),
            },
            "total_user_messages": sum(s["user_messages"] for s in sessions),
            "total_assistant_messages": sum(s["assistant_messages"] for s in sessions),
            "models": defaultdict(int),
            "tool_uses": defaultdict(int),
            "first_timestamp": min((s["first_timestamp"] for s in sessions if s["first_timestamp"]), default=None),
            "last_timestamp": max((s["last_timestamp"] for s in sessions if s["last_timestamp"]), default=None),
            "sessions": sessions,
        }

        for s in sessions:
            for m, c in s["models"].items():
                proj_stats["models"][m] += c
            for t, c in s["tool_uses"].items():
                proj_stats["tool_uses"][t] += c

        proj_stats["models"] = dict(proj_stats["models"])
        proj_stats["tool_uses"] = dict(proj_stats["tool_uses"])
        projects.append(proj_stats)

    return projects


# ── 格式化输出 ────────────────────────────────────────────────────────

def fmt_cost(usd: float) -> str:
    if usd < 0.01:
        return f"${usd:.4f}"
    return f"${usd:.2f}"


def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.0f}m"
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    return f"{h}h{m}m"


def fmt_date(iso: str | None) -> str:
    if not iso:
        return "-"
    try:
        dt = datetime.fromisoformat(iso)
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso[:16]


def print_divider(char="─", width=100):
    print(char * width)


def print_session_table(sessions: list[dict]):
    """打印 session 明细表"""
    # 按时间排序
    sessions = sorted(sessions, key=lambda s: s["first_timestamp"] or "")

    header = f"{'#':>3}  {'Title':<40} {'Model':<18} {'Cost':>8} {'In':>7} {'Out':>7} {'CW':>7} {'CR':>7} {'Msgs':>5} {'Tools':>5} {'Duration':>8} {'Date':<16}"
    print(header)
    print_divider("─", len(header))

    for i, s in enumerate(sessions, 1):
        title = s["title"] or s["summary"] or s["session_id"][:12]
        if len(title) > 38:
            title = title[:36] + ".."

        # 主要模型
        main_model = "-"
        if s["models"]:
            main_model = max(s["models"], key=s["models"].get)
            main_model = main_model.replace("claude-", "").replace("-20250620", "").replace("-20250514", "").replace("-20251001", "")
            if len(main_model) > 16:
                main_model = main_model[:16]

        total_tools = sum(s["tool_uses"].values())
        msgs = s["user_messages"]

        print(
            f"{i:>3}  {title:<40} {main_model:<18} {fmt_cost(s['cost_usd']):>8} "
            f"{fmt_tokens(s['tokens']['input']):>7} {fmt_tokens(s['tokens']['output']):>7} "
            f"{fmt_tokens(s['tokens']['cache_write']):>7} {fmt_tokens(s['tokens']['cache_read']):>7} "
            f"{msgs:>5} {total_tools:>5} {fmt_duration(s['duration_seconds']):>8} {fmt_date(s['first_timestamp']):<16}"
        )


def make_bar(value: float, max_value: float, max_width: int = 40) -> str:
    """生成等比例柱状图"""
    if max_value <= 0:
        return ""
    width = int(value / max_value * max_width)
    return "█" * max(1, width) if value > 0 else ""


def print_tool_breakdown(tool_uses: dict):
    """打印 tool 使用分布"""
    if not tool_uses:
        return
    sorted_tools = sorted(tool_uses.items(), key=lambda x: -x[1])
    total = sum(v for _, v in sorted_tools)
    max_count = sorted_tools[0][1] if sorted_tools else 1
    print(f"\n  Tool 使用 (共 {total} 次):")
    for name, count in sorted_tools:
        pct = count / total * 100
        bar = make_bar(count, max_count)
        print(f"    {name:<25} {count:>5}  ({pct:>5.1f}%)  {bar}")


def print_model_breakdown(models: dict):
    """打印模型使用分布"""
    if not models:
        return
    sorted_models = sorted(models.items(), key=lambda x: -x[1])
    total = sum(v for _, v in sorted_models)
    print(f"\n  Model 分布 (共 {total} 次 assistant 回复):")
    for name, count in sorted_models:
        pct = count / total * 100
        short = name.replace("claude-", "")
        print(f"    {short:<35} {count:>5}  ({pct:>5.1f}%)")


def print_report(projects: list[dict], show_sessions: bool = False):
    """打印完整报告"""
    if not projects:
        print("没有找到任何 session 数据。")
        return

    grand_cost = 0.0
    grand_tokens = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    grand_sessions = 0
    grand_user_msgs = 0
    grand_assistant_msgs = 0
    grand_models = defaultdict(int)
    grand_tools = defaultdict(int)

    for proj in projects:
        print()
        print_divider("═")
        print(f"  Project: {proj['readable_path']}")
        print(f"  Sessions: {proj['session_count']}    "
              f"Cost: {fmt_cost(proj['total_cost_usd'])}    "
              f"Messages: {proj['total_user_messages']} user / {proj['total_assistant_messages']} assistant")
        print(f"  Tokens:  in={fmt_tokens(proj['total_tokens']['input'])}  "
              f"out={fmt_tokens(proj['total_tokens']['output'])}  "
              f"cache_write={fmt_tokens(proj['total_tokens']['cache_write'])}  "
              f"cache_read={fmt_tokens(proj['total_tokens']['cache_read'])}")
        print(f"  Period:  {fmt_date(proj['first_timestamp'])} ~ {fmt_date(proj['last_timestamp'])}")
        print_divider("═")

        if show_sessions:
            print()
            print_session_table(proj["sessions"])

        print_model_breakdown(proj["models"])
        print_tool_breakdown(proj["tool_uses"])

        # 累计
        grand_cost += proj["total_cost_usd"]
        grand_sessions += proj["session_count"]
        grand_user_msgs += proj["total_user_messages"]
        grand_assistant_msgs += proj["total_assistant_messages"]
        for k in grand_tokens:
            grand_tokens[k] += proj["total_tokens"][k]
        for m, c in proj["models"].items():
            grand_models[m] += c
        for t, c in proj["tool_uses"].items():
            grand_tools[t] += c

    # 总览
    print()
    print()
    print_divider("━")
    print("  GRAND TOTAL")
    print_divider("━")
    print(f"  Projects:  {len(projects)}")
    print(f"  Sessions:  {grand_sessions}")
    print(f"  Messages:  {grand_user_msgs} user / {grand_assistant_msgs} assistant")
    print(f"  Tokens:    in={fmt_tokens(grand_tokens['input'])}  "
          f"out={fmt_tokens(grand_tokens['output'])}  "
          f"cache_write={fmt_tokens(grand_tokens['cache_write'])}  "
          f"cache_read={fmt_tokens(grand_tokens['cache_read'])}")

    total_all = sum(grand_tokens.values())
    print(f"  Total tokens: {fmt_tokens(total_all)}")
    print(f"  Total cost:   {fmt_cost(grand_cost)}")
    print_divider("━")

    print_model_breakdown(dict(grand_models))
    print_tool_breakdown(dict(grand_tools))

    # 每日费用分析
    print_daily_cost(projects)
    print()


def print_daily_cost(projects: list[dict]):
    """按天统计费用"""
    daily = defaultdict(float)
    for proj in projects:
        for s in proj["sessions"]:
            if s["first_timestamp"]:
                day = s["first_timestamp"][:10]
                daily[day] += s["cost_usd"]

    if not daily:
        return

    max_cost = max(daily.values())
    print(f"\n  每日费用:")
    for day in sorted(daily):
        cost = daily[day]
        bar = make_bar(cost, max_cost)
        print(f"    {day}  {fmt_cost(cost):>10}  {bar}")


def main():
    parser = argparse.ArgumentParser(description="Claude Code 本地 session 统计工具")
    parser.add_argument("-p", "--project", help="按关键词过滤项目名")
    parser.add_argument("-s", "--sessions", action="store_true", help="显示每个 session 明细")
    parser.add_argument("--since", help="只统计此日期之后的 session (YYYY-MM-DD)")
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式")
    parser.add_argument("--claude-dir", default=os.path.expanduser("~/.claude"),
                        help="Claude 配置目录 (默认 ~/.claude)")
    args = parser.parse_args()

    since = None
    if args.since:
        since = datetime.fromisoformat(args.since + "T00:00:00+00:00")

    claude_dir = Path(args.claude_dir)
    projects = scan_projects(claude_dir, project_filter=args.project, since=since)

    if args.json:
        print(json.dumps(projects, indent=2, ensure_ascii=False, default=str))
    else:
        print_report(projects, show_sessions=args.sessions)


if __name__ == "__main__":
    main()
