#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 eval/kb.sqlite 抽样，翻译成中文，生成评测场景语料 eval/scenarios.jsonl。

用法：
  1. 先启动本地服务（需要模型）：npm start
  2. python eval/build_scenarios.py
     python eval/build_scenarios.py --no-translate   只抽样，不翻译

说明：
  - 抽样是确定性的（固定步长），重复执行结果一致。
  - 翻译由本地 /api/chat 完成，结果标记 translated_by，需人工抽查。
  - 原始英文与标签会保留，便于回溯到源数据集。
"""
import json
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "eval" / "kb.sqlite"
OUT = ROOT / "eval" / "scenarios.jsonl"
BASE = os.environ.get("EVAL_API", "http://127.0.0.1:8123")

PLAN = {"meld": 24, "goemotions": 24, "emobank": 12, "cpm": 12}


def chat(messages, max_tokens=1600):
    payload = json.dumps({"messages": messages, "max_tokens": max_tokens}).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as res:
        body = json.loads(res.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"]


def sample(conn):
    items = []

    # MELD：对话中非中性情绪的句子，优先带关系语境
    rows = conn.execute(
        """
        SELECT utterer, emotion, dialogue_id FROM (
          SELECT utterance AS utterer, emotion, dialogue_id,
                 ROW_NUMBER() OVER (PARTITION BY emotion ORDER BY dialogue_id, utterance_id) AS rn
          FROM meld
          WHERE LENGTH(utterance) BETWEEN 25 AND 160
            AND emotion <> 'neutral'
        ) WHERE rn <= 3
        ORDER BY emotion, rn
        """
    ).fetchall()
    for text, emotion, dialogue_id in rows[: PLAN["meld"]]:
        items.append({
            "source": "MELD",
            "text_en": text,
            "gold": {"emotion": emotion, "dialogue_id": dialogue_id},
        })

    # GoEmotions：每个情绪标签取 1 条，覆盖尽可能多的标签
    rows = conn.execute(
        """
        SELECT text, labels FROM goemotions
        WHERE split = 'train' AND labels <> ''
          AND LENGTH(text) BETWEEN 25 AND 160
        LIMIT 8000
        """
    ).fetchall()
    label_names = dict(conn.execute("SELECT idx, name FROM emotion_labels").fetchall())
    by_label = {}
    for text, labels in rows:
        for part in labels.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                idx = int(part)
            except ValueError:
                continue
            if idx not in by_label:
                by_label[idx] = text
    for idx in sorted(by_label):
        if len(by_label) and len([i for i in items if i["source"] == "GoEmotions"]) >= PLAN["goemotions"]:
            break
        name = label_names.get(idx, "")
        if not name:
            continue
        items.append({"source": "GoEmotions", "text_en": by_label[idx], "gold": {"emotion": name}})

    # EmoBank：按 V/A/D 分层抽样（高唤醒 / 低愉悦 / 中间值）
    rows = conn.execute(
        """
        SELECT text, v, a, d FROM emobank
        WHERE split = 'train' AND LENGTH(text) BETWEEN 25 AND 140
        ORDER BY (a - v) DESC
        """
    ).fetchall()
    if rows:
        step = max(1, len(rows) // PLAN["emobank"])
        picked = rows[::step][: PLAN["emobank"]]
        for text, v, a, d in picked:
            items.append({
                "source": "EmoBank",
                "text_en": text,
                "gold": {"valence": round(v, 1), "arousal": round(a, 1), "dominance": round(d, 1)},
            })

    # CPM：取五成分标注齐全的句子
    rows = conn.execute(
        """
        SELECT corpus, text, cognitive, neurophysiological, motivational, motor_expression, subjective_feeling
        FROM cpm
        WHERE LENGTH(text) BETWEEN 40 AND 200
        ORDER BY (cognitive + neurophysiological + motivational + motor_expression + subjective_feeling) DESC
        """
    ).fetchall()
    if rows:
        step = max(1, len(rows) // PLAN["cpm"])
        picked = rows[::step][: PLAN["cpm"]]
        for corpus, text, cog, neu, mot, motor, feel in picked:
            items.append({
                "source": "CPM/" + corpus,
                "text_en": text,
                "gold": {
                    "cognitive": cog,
                    "neurophysiological": neu,
                    "motivational": mot,
                    "motor_expression": motor,
                    "subjective_feeling": feel,
                },
            })

    return items


def parse_array(text):
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start: end + 1])
    except json.JSONDecodeError:
        return None


def translate(items, batch=8):
    done = []
    for i in range(0, len(items), batch):
        chunk = items[i: i + batch]
        lines = "\n".join(f"{n + 1}. {it['text_en']}" for n, it in enumerate(chunk))
        prompt = (
            "把下面每条英文翻译成自然、口语化的简体中文，保留第一人称和情绪语气，不要添加解释或心理学术语。\n"
            "只输出一个 JSON 数组，元素是字符串，数量与输入完全一致，顺序一一对应。\n\n" + lines
        )
        try:
            content = chat([{"role": "user", "content": prompt}], 1600)
            arr = parse_array(content)
            if not arr or len(arr) != len(chunk):
                raise ValueError("翻译条数不一致")
            for it, zh in zip(chunk, arr):
                it["text_zh"] = str(zh).strip()
                it["translated_by"] = "glm-4-flash"
                it["needs_review"] = True
        except Exception as err:
            print(f"    第 {i // batch + 1} 批翻译失败：{err}")
            for it in chunk:
                it["text_zh"] = ""
                it["translated_by"] = ""
                it["needs_review"] = True
        done.extend(chunk)
        print(f"    已处理 {len(done)} / {len(items)}")
    return done


def main():
    if not KB.exists():
        print("  找不到 eval/kb.sqlite，请先执行 python eval/build_kb.py")
        return

    conn = sqlite3.connect(KB)
    items = sample(conn)
    conn.close()

    print("")
    print(f"  抽样 {len(items)} 条场景")
    if "--no-translate" not in sys.argv:
        items = translate(items)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        for i, it in enumerate(items, 1):
            it["id"] = f"sc_{i:03d}"
            f.write(json.dumps(it, ensure_ascii=False) + "\n")

    ok = sum(1 for it in items if it.get("text_zh"))
    print("  ------------------------------------")
    print(f"  已写入 eval/scenarios.jsonl：{len(items)} 条，其中翻译成功 {ok} 条")
    print("")


if __name__ == "__main__":
    main()
