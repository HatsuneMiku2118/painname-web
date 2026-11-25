#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
对当前识别/报告接口跑评测，输出 eval/results.json 与 eval/report.md。

前置：
  1. 服务已启动且配置了模型：npm start
  2. 已有 eval/matching.jsonl（必填）与 eval/scenarios.jsonl（可选）

用法：
  python eval/run_eval.py
  python eval/run_eval.py --api http://127.0.0.1:8123 --limit 10

指标：
  - 概念匹配：top1 / top3 / MRR（正例），拒答率与误报（负例）
  - 候选规范：候选数是否 ≤4、是否为空
  - 报告契约：结构完整、长度、禁用词、疑似虚构引用
"""
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVAL = ROOT / "eval"
BASE = os.environ.get("EVAL_API", "http://127.0.0.1:8123")
for i, arg in enumerate(sys.argv):
    if arg == "--api" and i + 1 < len(sys.argv):
        BASE = sys.argv[i + 1].rstrip("/")

LIMIT = None
for i, arg in enumerate(sys.argv):
    if arg == "--limit" and i + 1 < len(sys.argv):
        LIMIT = int(sys.argv[i + 1])

REPORT_CONCEPTS = [
    "rumination",
    "attachment_anxiety",
    "self_blame",
    "breakup_identity",
    "emotional_granularity",
    "demand_withdraw",
]

BANNED = ["抑郁症", "焦虑症", "人格障碍", "确诊", "诊断", "你就是", "你属于"]
CITATION = re.compile(r"\(\d{4}\)|et al\.|\[\d+\]")

FIXED_QUESTIONS = [
    "这件事，发生在什么样的关系里？",
    "如果给那时的感受起个名字，你会叫它什么？",
    "当时脑子里第一个冒出来的念头是什么？",
    "那段时间你做了什么，或者特别想做什么？",
    "身体上有什么反应吗？",
    "如果有一个愿望能被满足，你最希望得到什么？",
]


def post(path, payload, timeout=60):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = json.loads(res.read().decode("utf-8"))
        return body, time.time() - started, None
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "ignore")[:200]
        return None, time.time() - started, f"HTTP {err.code}: {detail}"
    except Exception as err:
        return None, time.time() - started, str(err)


def load_jsonl(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def eval_matching(items):
    rows = []
    for item in items:
        body, seconds, err = post("/api/identify", {
            "raw": item["text"],
            "answers": [],
            "askedQuestions": [],
            "followUpRounds": 1,
        })
        ids = []
        if body and body.get("ok"):
            ids = [c.get("conceptId") for c in body.get("candidates") or []]
        rows.append({
            "id": item["id"],
            "gold": item["gold"],
            "expect": item["expect"],
            "candidates": ids,
            "seconds": round(seconds, 2),
            "error": err,
        })
    return rows


def summarize(rows):
    pos = [r for r in rows if r["expect"] == "match" and not r["error"]]
    neg = [r for r in rows if r["expect"] == "none" and not r["error"]]
    errors = [r for r in rows if r["error"]]

    top1 = sum(1 for r in pos if r["candidates"][:1] == [r["gold"]])
    top3 = sum(1 for r in pos if r["gold"] in r["candidates"][:3])
    mrr = 0.0
    for r in pos:
        if r["gold"] in r["candidates"]:
            mrr += 1.0 / (r["candidates"].index(r["gold"]) + 1)
    refusal = sum(1 for r in neg if not r["candidates"])
    false_pos = [r for r in neg if r["candidates"]]

    counts = [len(r["candidates"]) for r in rows if not r["error"]]
    latencies = sorted(r["seconds"] for r in rows if not r["error"])

    def pct(n, d):
        return round(n / d * 100, 1) if d else 0.0

    def group(prefixes):
        picked = [r for r in neg if r["id"][0] in prefixes]
        if not picked:
            return {"n": 0, "refusal": 0, "refusal_rate": 0.0}
        ok = sum(1 for r in picked if not r["candidates"])
        return {"n": len(picked), "refusal": ok, "refusal_rate": pct(ok, len(picked))}

    return {
        "total": len(rows),
        "errors": len(errors),
        "positives": len(pos),
        "negatives": len(neg),
        "top1": top1,
        "top3": top3,
        "top1_rate": pct(top1, len(pos)),
        "top3_rate": pct(top3, len(pos)),
        "mrr": round(mrr / len(pos), 3) if pos else 0,
        "refusal": refusal,
        "refusal_rate": pct(refusal, len(neg)),
        "false_positive": len(false_pos),
        "false_positive_rate": pct(len(false_pos), len(neg)),
        "hard_negative": group("hk"),
        "corpus_negative": group("cx"),
        "simple_negative": group("n"),
        "avg_candidates": round(statistics.mean(counts), 2) if counts else 0,
        "max_candidates": max(counts) if counts else 0,
        "over4": sum(1 for c in counts if c > 4),
        "latency_p50": latencies[len(latencies) // 2] if latencies else 0,
        "latency_p90": latencies[int(len(latencies) * 0.9) - 1] if latencies else 0,
    }


def eval_followups(items):
    rows = []
    for item in items:
        body, seconds, err = post("/api/identify", {
            "raw": item["raw"],
            "answers": item.get("answers") or [],
            "askedQuestions": FIXED_QUESTIONS,
            "followUpRounds": 0,
        })
        count = 0
        if body and body.get("ok"):
            count = len(body.get("followUps") or [])
        rows.append({
            "id": item["id"],
            "should_ask": bool(item.get("should_ask")),
            "asked": count > 0,
            "count": count,
            "seconds": round(seconds, 2),
            "error": err,
        })
    return rows


def summarize_followups(rows):
    ok_rows = [r for r in rows if not r["error"]]
    should = [r for r in ok_rows if r["should_ask"]]
    should_not = [r for r in ok_rows if not r["should_ask"]]
    recall = sum(1 for r in should if r["asked"])
    false_ask = sum(1 for r in should_not if r["asked"])

    def pct(n, d):
        return round(n / d * 100, 1) if d else 0.0

    return {
        "total": len(rows),
        "errors": len(rows) - len(ok_rows),
        "should_n": len(should),
        "no_n": len(should_not),
        "recall": recall,
        "recall_rate": pct(recall, len(should)),
        "false": false_ask,
        "false_rate": pct(false_ask, len(should_not)),
    }


def eval_reports(matching):
    by_concept = {}
    for item in matching:
        if item["expect"] == "match" and item["gold"] not in by_concept:
            by_concept[item["gold"]] = item["text"]

    rows = []
    for cid in REPORT_CONCEPTS:
        raw = by_concept.get(cid) or "我最近在关系里经常感到不安，想弄清楚自己怎么了。"
        body, seconds, err = post("/api/report", {
            "conceptId": cid,
            "raw": raw,
            "answers": [],
            "profile": {"context": ["恋爱关系"], "emotions": ["不安"], "thoughts": [], "behaviors": [], "body": [], "needs": []},
            "depth": "present",
            "originsText": "",
        }, timeout=90)

        report = (body or {}).get("report") or {}
        text = " ".join(
            (report.get("explanation") or [])
            + (report.get("mechanism") or [])
            + [report.get("summary") or ""]
        )
        rows.append({
            "conceptId": cid,
            "ok": bool(body and body.get("ok")),
            "error": err,
            "explanation": len(report.get("explanation") or []),
            "mechanism": len(report.get("mechanism") or []),
            "cycle": len(report.get("cycle") or []),
            "links": len(report.get("links") or []),
            "summary_chars": len(report.get("summary") or ""),
            "banned_hits": [w for w in BANNED if w in text],
            "citation_hits": CITATION.findall(text)[:3],
            "seconds": round(seconds, 2),
        })
    return rows


def coverage():
    path = ROOT / "data" / "concepts.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for c in data.get("concepts", []):
        signals = c.get("signals") or []
        words = sum(len(s.get("words") or []) for s in signals)
        out.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "signals": len(signals),
            "words": words,
            "review_status": c.get("review_status") or "pending_review",
        })
    return out


def md_table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        lines.append("| " + " | ".join(str(x) for x in r) + " |")
    return "\n".join(lines)


def main():
    matching = load_jsonl(EVAL / "matching.jsonl")
    scenarios = load_jsonl(EVAL / "scenarios.jsonl")
    followups = load_jsonl(EVAL / "followup.jsonl")
    if LIMIT:
        matching = matching[:LIMIT]

    if not matching:
        print("  找不到 eval/matching.jsonl")
        return

    print("")
    print(f"  评测目标：{BASE}")
    print(f"  匹配集 {len(matching)} 条" + (f"，场景语料 {len(scenarios)} 条" if scenarios else ""))
    print("  ------------------------------------")

    t0 = time.time()
    rows = eval_matching(matching)
    s = summarize(rows)
    print(f"  匹配完成：用时 {round(time.time() - t0)}s，错误 {s['errors']} 条")

    reports = eval_reports(matching)
    print(f"  报告契约：{len(reports)} 条")

    fu_rows = eval_followups(followups) if followups else []
    fu = summarize_followups(fu_rows) if fu_rows else None
    if fu:
        print(f"  追问触发：应问 {fu['recall']}/{fu['should_n']}，误触发 {fu['false']}/{fu['no_n']}")
    print("")

    result = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "api": BASE,
        "matching": s,
        "details": rows,
        "reports": reports,
        "followups": {"summary": fu, "details": fu_rows} if fu else None,
        "coverage": coverage(),
        "scenarios": {
            "total": len(scenarios),
            "translated": sum(1 for x in scenarios if x.get("text_zh")),
            "by_source": {},
        },
    }
    for sc in scenarios:
        key = sc.get("source", "unknown")
        result["scenarios"]["by_source"][key] = result["scenarios"]["by_source"].get(key, 0) + 1

    (EVAL / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- Markdown 报告 ----
    misses = [r for r in rows if r["expect"] == "match" and r["gold"] not in r["candidates"][:3]]
    fps = [r for r in rows if r["expect"] == "none" and r["candidates"]]
    report_issues = [
        r for r in reports
        if not r["ok"] or r["explanation"] < 2 or r["mechanism"] < 1 or r["cycle"] < 3
        or r["banned_hits"] or r["citation_hits"]
    ]
    thin = [c for c in result["coverage"] if c["signals"] < 2]

    md = []
    md.append("# 识别与报告基线评测")
    md.append("")
    md.append(f"- 生成时间：{result['generated_at']}")
    md.append(f"- 接口：{BASE}")
    md.append(f"- 匹配集：{len(rows)} 条（正例 {s['positives']} / 负例 {s['negatives']}）")
    md.append("")
    md.append("## 一、核心指标")
    md.append("")
    md.append(md_table(["指标", "数值"], [
        ["Top-1 命中率", f"{s['top1_rate']}%（{s['top1']}/{s['positives']}）"],
        ["Top-3 命中率", f"{s['top3_rate']}%（{s['top3']}/{s['positives']}）"],
        ["MRR", s["mrr"]],
        ["负例正确拒答率", f"{s['refusal_rate']}%（{s['refusal']}/{s['negatives']}）"],
        ["负例误报率", f"{s['false_positive_rate']}%（{s['false_positive']}/{s['negatives']}）"],
        ["平均候选数", s["avg_candidates"]],
        ["候选数 >4 的次数", s["over4"]],
        ["延迟 P50 / P90", f"{s['latency_p50']}s / {s['latency_p90']}s"],
        ["追问触发（应问）", f"{fu['recall_rate']}%（{fu['recall']}/{fu['should_n']}）" if fu else "未测"],
        ["追问误触发（不应问）", f"{fu['false_rate']}%（{fu['false']}/{fu['no_n']}）" if fu else "未测"],
        ["接口错误", s["errors"]],
    ]))
    md.append("")
    md.append("## 二、Top-3 未命中")
    md.append("")
    if misses:
        md.append(md_table(["用例", "期望概念", "实际候选"], [
            [r["id"], r["gold"], "、".join(r["candidates"]) or "（空）"] for r in misses
        ]))
    else:
        md.append("无。")
    md.append("")
    md.append("## 三、负例分类")
    md.append("")
    md.append(md_table(["负例类型", "条数", "正确拒答"], [
        ["简单负例（明显无关）", s["simple_negative"]["n"], f"{s['simple_negative']['refusal_rate']}%"],
        ["难负例（情绪相似但缺模式）", s["hard_negative"]["n"], f"{s['hard_negative']['refusal_rate']}%"],
        ["语料负例（真实情绪文本）", s["corpus_negative"]["n"], f"{s['corpus_negative']['refusal_rate']}%"],
    ]))
    md.append("")
    md.append("## 四、负例误报")
    md.append("")
    if fps:
        md.append(md_table(["用例", "实际候选"], [
            [r["id"], "、".join(r["candidates"])] for r in fps
        ]))
    else:
        md.append("无。")
    md.append("")
    md.append("## 五、报告契约")
    md.append("")
    md.append(md_table(["概念", "解释段", "机制段", "循环步", "依据条", "总结字数", "禁用词", "疑似引用"], [
        [r["conceptId"], r["explanation"], r["mechanism"], r["cycle"], r["links"], r["summary_chars"],
         "、".join(r["banned_hits"]) or "—", "、".join(r["citation_hits"]) or "—"]
        for r in reports
    ]))
    md.append("")
    md.append(f"异常报告：{len(report_issues)} 条。")
    md.append("")
    md.append("## 六、概念库覆盖")
    md.append("")
    md.append(md_table(["概念", "信号组", "关键词数", "审核状态"], [
        [c["name"], c["signals"], c["words"], c["review_status"]] for c in result["coverage"]
    ]))
    md.append("")
    if thin:
        md.append("信号组不足 2 组的条目：" + "、".join(c["name"] for c in thin))
    else:
        md.append("所有条目均至少有 2 组信号。")
    md.append("")
    md.append("## 七、场景语料")
    md.append("")
    md.append(f"共 {result['scenarios']['total']} 条，翻译成功 {result['scenarios']['translated']} 条。")
    md.append("")
    md.append(md_table(["来源", "条数"], [[k, v] for k, v in result["scenarios"]["by_source"].items()]))
    md.append("")
    md.append("> 场景语料由模型翻译，标记 needs_review，用于扩展用例与覆盖检查，当前不参与打分。")
    md.append("")
    md.append("## 八、结论")
    md.append("")
    md.append(f"- 概念匹配 Top-3 为 {s['top3_rate']}%，Top-1 为 {s['top1_rate']}%。")
    md.append(f"- 负例误报 {s['false_positive']} 条，说明对概念库外议题的拒答能力{'尚可' if s['false_positive'] == 0 else '仍需加强'}。")
    md.append(f"- 报告结构异常 {len(report_issues)} 条，禁用词与疑似引用需逐条人工确认。")
    if fu:
        md.append(f"- 追问触发 {fu['recall_rate']}%，误触发 {fu['false_rate']}%（信息充足时不应再问）。")
    md.append("")

    (EVAL / "report.md").write_text("\n".join(md), encoding="utf-8")

    print("  已写入 eval/results.json 与 eval/report.md")
    print(f"  Top-1 {s['top1_rate']}%｜Top-3 {s['top3_rate']}%｜拒答 {s['refusal_rate']}%｜误报 {s['false_positive']}/{s['negatives']}")
    print("")


if __name__ == "__main__":
    main()
