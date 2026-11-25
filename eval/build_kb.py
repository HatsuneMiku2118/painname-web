#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把预训练资料导入本地知识库 eval/kb.sqlite（只读语料，不改动源文件）。

来源（默认路径可用环境变量覆盖）：
  PRETRAIN_DATA  C:\\Users\\HatsuneMiku\\Desktop\\预训练\\数据集
  PRETRAIN_PAPER C:\\Users\\HatsuneMiku\\Desktop\\预训练\\论文

用法：
  python eval/build_kb.py           重建 eval/kb.sqlite
  python eval/build_kb.py --stats   只打印现有库的统计

说明：
  - 数据集只导入小规模、可核对的原表；不做清洗性改动。
  - 论文用 pypdf 抽取纯文本，按页存储，便于后续做检索或引用核对。
  - 重复执行会先删除并重建 eval/kb.sqlite。
"""
import csv
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "eval" / "kb.sqlite"
DATA_DIR = Path(os.environ.get("PRETRAIN_DATA", r"C:\Users\HatsuneMiku\Desktop\预训练\数据集"))
PAPER_DIR = Path(os.environ.get("PRETRAIN_PAPER", r"C:\Users\HatsuneMiku\Desktop\预训练\论文"))


def table_exists(conn, name):
    cur = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,))
    return cur.fetchone() is not None


def create_schema(conn):
    conn.executescript(
        """
        DROP TABLE IF EXISTS goemotions;
        DROP TABLE IF EXISTS emobank;
        DROP TABLE IF EXISTS meld;
        DROP TABLE IF EXISTS cpm;
        DROP TABLE IF EXISTS papers;
        DROP TABLE IF EXISTS emotion_labels;

        CREATE TABLE goemotions (
          id TEXT,
          split TEXT,
          text TEXT,
          labels TEXT
        );
        CREATE TABLE emobank (
          id TEXT,
          split TEXT,
          v REAL,
          a REAL,
          d REAL,
          text TEXT
        );
        CREATE TABLE meld (
          sr INTEGER,
          split TEXT,
          utterance TEXT,
          speaker TEXT,
          emotion TEXT,
          sentiment TEXT,
          dialogue_id INTEGER,
          utterance_id INTEGER
        );
        CREATE TABLE cpm (
          corpus TEXT,
          row_id TEXT,
          text TEXT,
          cognitive REAL,
          neurophysiological REAL,
          motivational REAL,
          motor_expression REAL,
          subjective_feeling REAL,
          labels TEXT
        );
        CREATE TABLE papers (
          name TEXT PRIMARY KEY,
          pages INTEGER,
          chars INTEGER,
          text TEXT
        );
        CREATE TABLE emotion_labels (
          idx INTEGER PRIMARY KEY,
          name TEXT
        );
        """
    )


def load_goemotions(conn):
    base = DATA_DIR / "GoEmotions"
    labels_path = base / "emotions.txt"
    if not labels_path.exists():
        print("  跳过 GoEmotions：找不到 emotions.txt")
        return 0

    names = [line.strip() for line in labels_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    conn.executemany(
        "INSERT INTO emotion_labels(idx, name) VALUES (?, ?)",
        [(i, n) for i, n in enumerate(names)],
    )

    total = 0
    for split in ("train", "dev", "test"):
        path = base / f"{split}.tsv"
        if not path.exists():
            continue
        with open(path, "r", encoding="utf-8", newline="") as f:
            rows = []
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                text, label_ids, rid = parts[0], parts[1], parts[2]
                rows.append((rid, split, text, label_ids))
            conn.executemany("INSERT INTO goemotions(id, split, text, labels) VALUES (?, ?, ?, ?)", rows)
            total += len(rows)
    print(f"  GoEmotions：{total} 条，情绪标签 {len(names)} 个")
    return total


def load_emobank(conn):
    path = DATA_DIR / "EmoBank" / "emobank.csv"
    if not path.exists():
        print("  跳过 EmoBank：找不到 emobank.csv")
        return 0
    rows = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            try:
                rows.append((
                    r.get("id", ""),
                    r.get("split", ""),
                    float(r.get("V") or 0),
                    float(r.get("A") or 0),
                    float(r.get("D") or 0),
                    r.get("text", ""),
                ))
            except ValueError:
                continue
    conn.executemany("INSERT INTO emobank(id, split, v, a, d, text) VALUES (?, ?, ?, ?, ?, ?)", rows)
    print(f"  EmoBank：{len(rows)} 条（V/A/D 连续维度）")
    return len(rows)


def load_meld(conn):
    base = DATA_DIR / "MELD"
    total = 0
    rows = []
    for split in ("train", "dev", "test"):
        path = base / f"{split}_sent_emo.csv"
        if not path.exists():
            continue
        with open(path, "r", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                try:
                    rows.append((
                        int(r.get("Sr No.") or 0),
                        split,
                        r.get("Utterance", ""),
                        r.get("Speaker", ""),
                        r.get("Emotion", ""),
                        r.get("Sentiment", ""),
                        int(r.get("Dialogue_ID") or 0),
                        int(r.get("Utterance_ID") or 0),
                    ))
                except ValueError:
                    continue
    conn.executemany(
        "INSERT INTO meld(sr, split, utterance, speaker, emotion, sentiment, dialogue_id, utterance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    total = len(rows)
    print(f"  MELD：{total} 条（对话句 + 情绪/情感）")
    return total


def load_cpm(conn):
    base = DATA_DIR / "Emotion Component Process Model" / "CaselHeindlKlinger-CPM-Emotion2021"
    files = [
        ("reman", base / "reman_corpus_fully_annotated.csv"),
        ("tec", base / "tec_corpus_fully_annotated.csv"),
    ]
    total = 0
    for corpus, path in files:
        if not path.exists():
            continue
        rows = []
        with open(path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for r in reader:
                text = (r.get("Text") or "").strip()
                if not text:
                    continue
                def num(key):
                    try:
                        return float(r.get(key) or 0)
                    except ValueError:
                        return 0.0
                rows.append((
                    corpus,
                    (r.get("ID") or "").strip(),
                    text,
                    num("Cognitive"),
                    num("Neurophysiological"),
                    num("Motivational"),
                    num("Motor Expression"),
                    num(" Subjective Feeling") or num("Subjective Feeling"),
                    (r.get("[other, neutral, anger, disgust, joy, sadness, fear, surprise, trust, anticipation]") or "").strip(),
                ))
        conn.executemany(
            "INSERT INTO cpm(corpus, row_id, text, cognitive, neurophysiological, motivational, motor_expression, subjective_feeling, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        print(f"  CPM-{corpus}：{len(rows)} 条（五成分 + 10 类标签）")
        total += len(rows)
    return total


def load_papers(conn):
    if not PAPER_DIR.exists():
        print("  跳过论文：找不到论文目录")
        return 0
    try:
        from pypdf import PdfReader
    except ImportError:
        print("  跳过论文：未安装 pypdf（pip install pypdf）")
        return 0

    rows = []
    for path in sorted(PAPER_DIR.glob("*.pdf")):
        try:
            reader = PdfReader(str(path))
            pages = [page.extract_text() or "" for page in reader.pages]
            text = "\n\n".join(pages)
            rows.append((path.name, len(pages), len(text), text))
            print(f"  {path.name}：{len(pages)} 页，{len(text)} 字符")
        except Exception as err:
            print(f"  {path.name}：解析失败（{err}）")
    conn.executemany("INSERT INTO papers(name, pages, chars, text) VALUES (?, ?, ?, ?)", rows)
    return len(rows)


def stats():
    if not OUT.exists():
        print("  eval/kb.sqlite 不存在，请先执行 python eval/build_kb.py")
        return
    conn = sqlite3.connect(OUT)
    tables = ["goemotions", "emobank", "meld", "cpm", "papers", "emotion_labels"]
    print("")
    print("  eval/kb.sqlite")
    print("  ------------------------------------")
    for t in tables:
        if not table_exists(conn, t):
            continue
        n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t:<16} {n}")
    if table_exists(conn, "cpm"):
        for corpus, n in conn.execute("SELECT corpus, COUNT(*) FROM cpm GROUP BY corpus"):
            print(f"  cpm/{corpus:<12} {n}")
    conn.close()
    print("")


def main():
    if "--stats" in sys.argv:
        stats()
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()
    conn = sqlite3.connect(OUT)
    create_schema(conn)

    print("")
    print("  导入知识库 → " + str(OUT.relative_to(ROOT)))
    print("  ------------------------------------")
    counts = {
        "goemotions": load_goemotions(conn),
        "emobank": load_emobank(conn),
        "meld": load_meld(conn),
        "cpm": load_cpm(conn),
        "papers": load_papers(conn),
    }
    conn.commit()
    conn.close()

    print("  ------------------------------------")
    print("  合计 " + json.dumps(counts, ensure_ascii=False))
    print("")


if __name__ == "__main__":
    main()
