#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
离线覆盖分析：把四个数据集的标签体系与现有概念库做对照，输出 eval/coverage.md。

用法：
  python eval/coverage.py

不调用模型，只读 eval/kb.sqlite 与 data/concepts.json。
"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "eval" / "kb.sqlite"
CONCEPTS = ROOT / "data" / "concepts.json"
OUT = ROOT / "eval" / "coverage.md"

# GoEmotions 标签 → 中文线索词（用于判断概念库里是否出现过这类情绪）
LABEL_CUES = {
    "admiration": ["钦佩", "敬佩", "佩服"],
    "amusement": ["好笑", "有趣", "逗"],
    "anger": ["生气", "愤怒", "火大"],
    "annoyance": ["烦", "恼", "不耐烦"],
    "approval": ["认可", "赞同", "支持"],
    "caring": ["关心", "在乎", "照顾"],
    "confusion": ["困惑", "不解", "搞不懂"],
    "curiosity": ["好奇", "想知道"],
    "desire": ["想要", "渴望", "期待"],
    "disappointment": ["失望", "落空"],
    "disapproval": ["不认同", "反对", "不赞成"],
    "disgust": ["厌恶", "反感", "恶心"],
    "embarrassment": ["尴尬", "难为情", "丢脸"],
    "excitement": ["兴奋", "激动"],
    "fear": ["害怕", "恐惧", "怕"],
    "gratitude": ["感激", "感谢"],
    "grief": ["悲伤", "哀伤", "丧失"],
    "joy": ["开心", "高兴", "快乐"],
    "love": ["爱", "喜欢"],
    "nervousness": ["紧张", "不安", "心慌"],
    "optimism": ["乐观", "有希望"],
    "pride": ["骄傲", "自豪"],
    "realization": ["意识到", "发现"],
    "relief": ["释然", "松一口气", "轻松"],
    "remorse": ["懊悔", "后悔", "愧疚"],
    "sadness": ["难过", "伤心", "低落"],
    "surprise": ["惊讶", "意外", "没想到"],
    "neutral": ["平静", "中性"],
}

# 未在概念库字面出现、但有明确承接者的标签
LABEL_TO_CONCEPT = {
    "disappointment": ("counterfactual_regret", "期待落空后的改写"),
    "remorse": ("counterfactual_regret", "后悔与反事实"),
    "embarrassment": ("shame", "羞耻体验"),
    "sadness": ("（多个概念）", "不建独立构念，避免与抑郁混淆"),
}

# 不建概念的标签：正向情绪或缺少痛苦模式
NOT_A_CONCEPT = {
    "admiration", "amusement", "approval", "curiosity", "disapproval",
    "disgust", "excitement", "gratitude", "joy", "optimism",
    "pride", "realization", "relief", "surprise", "neutral",
}

# CPM 五成分 → 产品里对应的追问维度
CPM_MAP = [
    ("Cognitive", "想法 / 评价", "thought"),
    ("Neurophysiological", "身体反应", "body"),
    ("Motivational", "行为倾向 / 想做什么", "behavior"),
    ("Motor Expression", "表情与表达", "expression"),
    ("Subjective Feeling", "情绪命名", "emotion"),
]


def corpus_text(concepts):
    parts = []
    for c in concepts:
        parts.append(c.get("definition", ""))
        parts.append(c.get("plain", ""))
        parts.extend(c.get("indicators") or [])
        parts.extend(c.get("applicable") or [])
        for sig in c.get("signals") or []:
            parts.extend(sig.get("words") or [])
    return "\n".join(parts)


def main():
    if not KB.exists() or not CONCEPTS.exists():
        print("  缺少 eval/kb.sqlite 或 data/concepts.json")
        return

    data = json.loads(CONCEPTS.read_text(encoding="utf-8"))
    concepts = data.get("concepts", [])
    text = corpus_text(concepts)

    conn = sqlite3.connect(KB)
    labels = [r[0] for r in conn.execute("SELECT name FROM emotion_labels ORDER BY idx")]
    counts = {
        "goemotions": conn.execute("SELECT COUNT(*) FROM goemotions").fetchone()[0],
        "emobank": conn.execute("SELECT COUNT(*) FROM emobank").fetchone()[0],
        "meld": conn.execute("SELECT COUNT(*) FROM meld").fetchone()[0],
        "cpm": conn.execute("SELECT COUNT(*) FROM cpm").fetchone()[0],
    }
    papers = conn.execute("SELECT name, pages, chars FROM papers ORDER BY name").fetchall()
    conn.close()

    rows = []
    covered = 0
    for name in labels:
        cues = LABEL_CUES.get(name, [])
        hit = [w for w in cues if w in text]
        if hit:
            covered += 1
            status = "直接覆盖（" + "、".join(hit) + "）"
        elif name in LABEL_TO_CONCEPT:
            concept, why = LABEL_TO_CONCEPT[name]
            covered += 1
            status = "由 " + concept + " 承接（" + why + "）"
        elif name in NOT_A_CONCEPT:
            status = "不建概念（非痛苦模式）"
        else:
            status = "未覆盖"
        rows.append((name, "、".join(cues) or "—", status))

    md = []
    md.append("# 资料覆盖分析")
    md.append("")
    md.append("用于回答一个问题：这批英文资料，能补上概念库的哪些缺口。")
    md.append("")
    md.append("## 一、知识库规模")
    md.append("")
    md.append("| 数据源 | 条数 |")
    md.append("|---|---|")
    md.append(f"| GoEmotions | {counts['goemotions']} |")
    md.append(f"| EmoBank | {counts['emobank']} |")
    md.append(f"| MELD | {counts['meld']} |")
    md.append(f"| CPM（reman + tec） | {counts['cpm']} |")
    md.append("")
    md.append("## 二、情绪标签覆盖")
    md.append("")
    md.append(f"GoEmotions 共 {len(labels)} 类：概念库直接出现中文线索的，或有明确承接概念的，合计 {covered} 类（{round(covered / len(labels) * 100, 1)}%）。")
    md.append("")
    md.append("| 标签 | 中文线索词 | 在概念库中的状态 |")
    md.append("|---|---|---|")
    for name, cues, status in rows:
        md.append(f"| {name} | {cues} | {status} |")
    md.append("")
    md.append("> 覆盖判断基于关键词字面匹配，只用于提示缺口，不代表语义完备。")
    md.append("")
    md.append("## 三、CPM 五成分与追问维度")
    md.append("")
    md.append("| CPM 成分 | 含义 | 现有追问 |")
    md.append("|---|---|---|")
    for comp, meaning, ask in CPM_MAP:
        md.append(f"| {comp} | {meaning} | {ask} |")
    md.append("")
    md.append("CPM 的五个成分现在都有对应追问：认知→想法、神经生理→身体、动机→行为、运动表达→表情与语气、主观感受→情绪命名。")
    md.append("")
    md.append("## 四、论文语料")
    md.append("")
    md.append("| 论文 | 页数 | 字符数 |")
    md.append("|---|---|---|")
    for name, pages, chars in papers:
        md.append(f"| {name} | {pages} | {chars} |")
    md.append("")
    md.append("六篇论文全文已存于 `papers` 表，可用于抽取定义、实验设置与结论，作为概念条目的可追溯依据。")
    md.append("")

    OUT.write_text("\n".join(md), encoding="utf-8")
    print("")
    print(f"  已写入 eval/coverage.md：情绪标签 {len(labels)} 类，覆盖 {covered} 类")
    print("")


if __name__ == "__main__":
    main()
