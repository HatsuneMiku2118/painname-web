/* 给痛苦一个名字 · 本地静态服务 + 模型代理（零依赖）
 *
 * 作用：
 *   1. 托管当前目录的静态站点（也可直接用 python -m http.server，只是没有模型能力）
 *   2. 把浏览器请求转发到 OpenAI 兼容接口，避免把 API Key 放进前端代码
 *
 * 启动（PowerShell）：
 *   $env:LLM_API_KEY="你的智谱 Key"
 *   node server.mjs
 *   浏览器打开 http://127.0.0.1:8123
 *
 * 可选环境变量：
 *   LLM_BASE_URL  默认 https://open.bigmodel.cn/api/paas/v4
 *   LLM_MODEL     默认 glm-4-flash
 *   PORT          默认 8123（云端由平台注入）
 *   HOST          默认 127.0.0.1（云端设为 0.0.0.0）
 */
import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = (process.env.LLM_API_KEY || process.env.ZHIPU_API_KEY || '').trim();
const BASE_URL = (process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'glm-4-flash';
const LIBRARY_PATH = path.join(ROOT, 'data', 'concepts.json');
const LIBRARY_REL = 'data/concepts.json';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------- 概念库：服务端读取（模型只能看到这里的内容） ---------- */

let libraryCache = { mtimeMs: 0, data: null };

function loadLibrary() {
  let info;
  try {
    info = statSync(LIBRARY_PATH);
  } catch (err) {
    return null;
  }
  if (!libraryCache.data || info.mtimeMs !== libraryCache.mtimeMs) {
    libraryCache = {
      mtimeMs: info.mtimeMs,
      data: JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'))
    };
  }
  return { ...libraryCache.data, _mtime: info.mtimeMs };
}

function usableConcepts(lib) {
  return ((lib && lib.concepts) || []).filter(function (c) {
    return c && c.id && c.review_status !== 'rejected';
  });
}

function findConcept(lib, id) {
  return usableConcepts(lib).find(function (c) { return c.id === id; }) || null;
}

/* ---------- 提示词与输出规整 ---------- */

const SYSTEM_REPORT = [
  '你是一个基于心理学概念的理解报告撰写者。你只解释已经匹配到的概念，不重新访谈，不做诊断。',
  '',
  '必须遵守：',
  '1. 只能使用给定的概念定义与机制，不引入新的概念名。',
  '2. 不虚构文献、作者、研究或数据；来源由系统另外展示，你不要输出引用。',
  '3. 不把一般理论机制断言为该用户的确定成因，使用「可能」「一种解释是」这类措辞。',
  '4. 不推断用户未提供的童年、家庭、创伤或人格类型。',
  '5. 用户自愿补充的早年经历，只能作为待探索的假设，不能写成事实。',
  '6. 不替用户或对方下结论，不评价谁对谁错。',
  '7. 用日常语言，克制、具体，避免教材式堆砌与空洞安慰。',
  '',
  '只输出严格的 JSON，不要 markdown 代码块，不要任何额外文字。JSON 结构：',
  '{',
  '  "concept_explanation": ["2 段，解释这个概念是什么、一般出现在什么情境"],',
  '  "mechanism": ["2 段，解释可能形成或维持它的机制"],',
  '  "cycle": ["3 到 5 步，描述这个循环如何发生"],',
  '  "links": [{"fact": "用户明确说过的内容", "interpretation": "基于理论的可能解释", "certainty": "fact" | "hypothesis" | "guess"}],',
  '  "summary": "一段个性化总结，150 字以内",',
  '  "origins_note": "仅当用户提供了早年经历时，写 2 到 3 句谨慎的待探索说明；否则为空字符串"',
  '}'
].join('\n');

const DEPTH_TEXT = {
  present: '理解当下：只分析当前的情绪、认知、行为和关系互动',
  origins: '探索形成因素：在用户自愿提供的信息范围内，谨慎讨论更早经历的可能影响',
  combined: '两者结合：先理解当下，再谨慎讨论形成因素'
};

function clipText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function listOf(value, max, limit) {
  if (!Array.isArray(value)) return [];
  return value.map(function (v) { return clipText(v, max); })
    .filter(Boolean)
    .slice(0, limit || 8);
}

function joinList(value, sep) {
  const list = listOf(value, 400, 12);
  return list.length ? list.join(sep) : '未提供';
}

function buildReportPrompt(concept, payload) {
  const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
  const answers = Array.isArray(payload.answers)
    ? payload.answers
        .map(function (a) {
          if (typeof a === 'string') return clipText(a, 400);
          if (a && typeof a === 'object' && !a.skipped) return clipText(a.text, 400);
          return '';
        })
        .filter(Boolean)
        .slice(0, 10)
    : [];

  return [
    '【概念库条目】（由服务端按 id 从概念库读取，禁止改写或替换）',
    'id：' + concept.id,
    '名称：' + concept.name + '（' + concept.plain + '）',
    '学科：' + (concept.discipline || '未标注'),
    '定义：' + concept.definition,
    '解释要点：' + (concept.explanation || []).join(' '),
    '可能机制：' + (concept.mechanism || []).join(' '),
    '典型循环：' + (concept.cycle || []).join(' → '),
    '不适用情境：' + (concept.nonApplicable || []).join('；'),
    '证据局限：' + (concept.limits || '未标注'),
    '',
    '【用户档案】（用户明确提供的内容）',
    '原始描述：' + clipText(payload.raw, 4000),
    '补充回答：' + (answers.length ? answers.join('；') : '无'),
    '情境：' + joinList(profile.context, '、'),
    '情绪：' + joinList(profile.emotions, '、'),
    '想法：' + joinList(profile.thoughts, '；'),
    '行为：' + joinList(profile.behaviors, '、'),
    '身体反应：' + joinList(profile.body, '、'),
    '可能的需要（推测）：' + joinList(profile.needs, '、'),
    '',
    '【探索深度】' + (DEPTH_TEXT[payload.depth] || DEPTH_TEXT.present),
    '【用户自愿补充的早年经历】' +
      (clipText(payload.originsText, 1200) || '未提供'),
    '',
    '请按 system 中约定的 JSON 结构输出。如果用户没有提供早年经历，不要推断，origins_note 返回空字符串。'
  ].join('\n');
}

function extractJSON(content) {
  let text = String(content).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no_json');
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeLinks(value) {
  const allowed = { fact: 'fact', hypothesis: 'hypothesis', guess: 'guess' };
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).map(function (item) {
    if (!item || typeof item !== 'object') return null;
    const fact = clipText(item.fact, 120);
    const interpretation = clipText(item.interpretation, 260);
    if (!fact || !interpretation) return null;
    return {
      fact: fact,
      interpretation: interpretation,
      certainty: allowed[item.certainty] || 'hypothesis'
    };
  }).filter(Boolean);
}

function normalizeReport(data) {
  return {
    explanation: listOf(data.concept_explanation, 600, 4),
    mechanism: listOf(data.mechanism, 600, 4),
    cycle: listOf(data.cycle, 120, 6),
    links: normalizeLinks(data.links),
    summary: clipText(data.summary, 500),
    originsNote: clipText(data.origins_note, 600)
  };
}

/**
 * 模型偶尔少给段数。缺失的部分用概念库里的原文补齐，
 * 保证「解释 ≥2 段 / 机制 ≥1 段 / 循环 ≥3 步」，补的是库内容而不是新生成的文字。
 */
function fillFromConcept(report, concept) {
  const explanation = report.explanation.slice();
  (concept.explanation || []).forEach(function (p) {
    if (explanation.length < 2 && explanation.indexOf(p) === -1) explanation.push(p);
  });

  let mechanism = report.mechanism.slice();
  if (!mechanism.length && (concept.mechanism || []).length) {
    mechanism = concept.mechanism.slice(0, 2);
  }

  let cycle = report.cycle.slice();
  if (cycle.length < 3 && (concept.cycle || []).length >= 3) {
    cycle = concept.cycle.slice();
  }

  return {
    explanation: explanation,
    mechanism: mechanism,
    cycle: cycle,
    links: report.links,
    summary: report.summary,
    originsNote: report.originsNote
  };
}

async function callModel(messages, maxTokens) {
  const upstream = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      messages: messages,
      stream: false,
      temperature: 0.3,
      max_tokens: maxTokens || 2200
    }),
    signal: AbortSignal.timeout(45000)
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    const err = new Error('upstream_' + upstream.status);
    err.body = text.slice(0, 400);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('upstream_not_json');
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
  if (!content) throw new Error('empty_content');
  return content;
}

/* ---------- 接口：概念库统计 ---------- */

function handleLibraryStats(res) {
  const lib = loadLibrary();
  if (!lib) {
    sendJSON(res, 503, { ok: false, error: '概念库未找到：' + LIBRARY_REL });
    return;
  }
  const counts = { approved: 0, pending_review: 0, rejected: 0 };
  (lib.concepts || []).forEach(function (c) {
    const key = c.review_status || 'pending_review';
    if (counts[key] === undefined) counts[key] = 0;
    counts[key] += 1;
  });
  sendJSON(res, 200, {
    ok: true,
    source: LIBRARY_REL,
    updatedAt: new Date(lib._mtime).toISOString(),
    total: (lib.concepts || []).length,
    usable: usableConcepts(lib).length,
    byReviewStatus: counts,
    concepts: usableConcepts(lib).map(function (c) {
      return { id: c.id, name: c.name, review_status: c.review_status || 'pending_review' };
    })
  });
}

/* ---------- 接口：识别（检索候选 + 模型排序 + 至多 2 个追加追问） ---------- */

const SYSTEM_IDENTIFY = [
  '你是一个情感痛苦的识别助手。你的任务是把用户的描述与给定的候选概念对照，挑出最贴合的几个方向；',
  '这不是诊断，也不是治疗，不要给用户贴人格标签。',
  '',
  '必须遵守：',
  '1. 只能从【候选概念】里选择 id，绝对不能编造概念、也不能引入候选之外的术语。',
  '2. 不做临床诊断，不把一次反应说成固定人格或依恋类型。',
  '3. 不虚构文献、作者、研究或数据。',
  '4. 只依据用户明确说过的内容判断。信息足够、且确实存在符合的概念库模式时，给出 3 到 4 个候选，按贴合程度从强到弱排列；',
  '   如果内容不属于概念库的议题（例如日常琐事、躯体不适、第三方事件、已经解决的冲突），即使信息完整也必须返回空数组，不要为凑数给候选。',
  '5. 如果线索不足以选出任何候选，candidates 返回空数组，并在 note 里说明还缺什么。',
  '6. 不要重复【已经问过的问题】；不要问“你感觉怎么样”这类泛泛的问题。',
  '',
  '【是否需要追问】先清点已知信息，四项分别是：',
  '  A 具体事件或互动：谁做了什么、发生了什么；',
  '  B 明确的情绪词：不安、委屈、生气、空、难受等；',
  '  C 具体行为或身体反应：看手机、追问、失眠、心口发紧等；',
  '  D 一段明确的关系：恋爱、暧昧、刚分手、同事、家人等。',
  '命中 3 项及以上：信息已经足够，必须直接给候选，follow_up_questions 返回空数组。',
  '命中 2 项及以下：可以追问，最多 2 个；每个问题只针对缺失的那一项，能问 1 个就不要问 2 个。',
  '',
  '示例：',
  '  「我总觉得不对劲」→ 只有 B，追问。',
  '  「分开之后我过得还行吧」→ 只有 B 和 D，追问。',
  '  「我总觉得是我有问题」→ 只有 B 和 A 的心理内容，缺事件，追问。',
  '  「他回消息慢我就一直看手机、睡不着」→ A/B/C/D 齐全，不追问，直接给候选。',
  '  「我跟他最近有点怪，说不上来」→ 只有 D，追问。',
  '',
  '注意：追问不是为了确认你已经判断出的概念；如果四项齐全，即使仍有两个候选，也不要问，用 note 说明不确定性即可。',
  '四项齐全且确实符合概念库议题时，请给满 3 到 4 个候选，并在 reason 里说明它与前一个候选的区别；用户需要能横向比较。',
  '反例（必须返回空数组）：',
  '  「堵车堵了一个小时，烦死了，到家就好了」→ 日常烦躁，无反复模式。',
  '  「我对海鲜过敏，吃了会起疹子」→ 躯体反应，不是情绪议题。',
  '  「朋友失恋了，我陪她聊了一晚上」→ 第三人称，非用户自身痛苦。',
  '  「他迟到半小时，道歉了我们就去吃饭了」→ 冲突已解决。',
  '',
  '只输出严格的 JSON，不要 markdown 代码块，不要任何额外文字。JSON 结构：',
  '{',
  '  "candidates": [{"id": "候选概念 id", "reason": "依据用户原话的线索，15 到 35 字"}],',
  '  "follow_up_questions": [{"question": "一句提问", "options": ["选项一", "选项二", "选项三"]}],',
  '  "confidence": "较高" | "中等" | "有限",',
  '  "note": "一句关于匹配不确定性的说明，没有就空字符串"',
  '}'
].join('\n');

function scoreConcept(concept, text) {
  let score = 0;
  let words = 0;
  (concept.signals || []).forEach(function (sig) {
    const found = (sig.words || []).filter(function (w) {
      return w && text.indexOf(w) > -1;
    });
    if (found.length) {
      score += (sig.w || 1) + Math.min(found.length - 1, 2) * 0.5;
      words += found.length;
    }
  });
  return { concept: concept, score: score, words: words };
}

function retrieveConcepts(lib, text, limit) {
  const scored = usableConcepts(lib)
    .map(function (c) { return scoreConcept(c, text); })
    .sort(function (a, b) { return b.score - a.score; });
  const hit = scored.filter(function (r) { return r.score > 0; });
  const pool = hit.length >= 3 ? hit : scored;
  return pool.slice(0, limit).map(function (r) { return r.concept; });
}

function buildIdentifyPrompt(pool, payload, round) {
  const answers = Array.isArray(payload.answers)
    ? payload.answers.map(function (a) {
        if (typeof a === 'string') return { text: clipText(a, 300), skipped: false };
        if (a && typeof a === 'object') return { text: clipText(a.text, 300), skipped: !!a.skipped };
        return null;
      }).filter(function (a) { return a && a.text; }).slice(0, 12)
    : [];

  const asked = Array.isArray(payload.askedQuestions)
    ? payload.askedQuestions.map(function (q) { return clipText(q, 80); }).filter(Boolean).slice(0, 12)
    : [];

  const candidateText = pool.map(function (c) {
    return [
      '- id: ' + c.id,
      '  名称：' + c.name + '（' + c.plain + '）',
      '  定义：' + c.definition,
      '  典型表现：' + (c.indicators || []).join('；'),
      '  不适用：' + (c.nonApplicable || []).join('；')
    ].join('\n');
  }).join('\n');

  return [
    '【候选概念】（只能从这里选）',
    candidateText,
    '',
    '【用户最初描述】',
    clipText(payload.raw, 3000),
    '',
    '【已收集的回答】',
    answers.length
      ? answers.map(function (a, i) { return (i + 1) + '. ' + (a.skipped ? '（已跳过）' : a.text); }).join('\n')
      : '无',
    '',
    '【已经问过的问题】',
    asked.length ? asked.join('\n') : '无',
    '',
    '【已追加追问轮次】' + round,
    round >= 1
      ? '已经追问过一轮：不要再提出新的问题，follow_up_questions 必须返回空数组。'
      : '如果还需要补充信息，最多提出 2 个针对性问题。',
    '',
    '请按 system 中约定的 JSON 结构输出。'
  ].join('\n');
}

/* ---------- 追问闸门：四项信息清点 ---------- */

const INFO_PATTERNS = {
  A: /(那天|昨天|前天|最近|每次|当时|后来|因为|的时候|吵架|分手|回消息|见面|约会|冷战|说好)/,
  B: /(难受|难过|委屈|生气|愤怒|害怕|恐惧|焦虑|不安|心慌|失落|失望|空|孤独|烦|累|疲惫|愧疚|自责|羞耻|嫉妒|无助|崩溃|麻木|压抑)/,
  C: /(看手机|翻聊天|反复看|发消息|追问|道歉|忍着|忍住|装作|假装|失眠|睡不着|吃不下|心口|胸口|心里堵|堵得慌|发抖|哭)/,
  D: /(他|她|对象|男朋友|女朋友|男友|女友|前任|老公|老婆|伴侣|喜欢的人|暗恋|分手|分开|暧昧|在一起|交往|恋爱|异地|相亲|约会)/
};

/**
 * A 只看用户最初描述（追问回答里出现"最近"不代表有具体事件）；
 * B/C/D 看描述 + 回答的合并文本。
 */
function assessInformation(rawText, fullText) {
  const hit = {
    A: INFO_PATTERNS.A.test(rawText) || rawText.length >= 40,
    B: INFO_PATTERNS.B.test(fullText),
    C: INFO_PATTERNS.C.test(fullText),
    D: INFO_PATTERNS.D.test(fullText)
  };
  const missing = ['A', 'B', 'C', 'D'].filter(function (key) { return !hit[key]; });
  return { score: 4 - missing.length, missing: missing, hit: hit };
}

const FALLBACK_QUESTIONS = {
  A: {
    text: '能具体说说最近发生了什么吗？哪怕只是一个小场景。',
    options: ['他几天没回我消息', '我们吵了一架', '他突然变得很冷淡']
  },
  D: {
    text: '这段关系对你来说是什么？',
    options: ['正在交往', '暧昧、还没确定', '已经分开了']
  },
  B: {
    text: '那时候最主要的感受是什么？',
    options: ['不安、心慌', '委屈、难受', '空、提不起劲']
  },
  C: {
    text: '当时你做了什么，或者身体有什么反应？',
    options: ['一直看手机', '想问又没问', '睡不着、心口发紧']
  }
};

function fallbackQuestions(missing) {
  return missing.slice(0, 2).map(function (key) {
    return { text: FALLBACK_QUESTIONS[key].text, options: FALLBACK_QUESTIONS[key].options.slice(0, 3) };
  });
}

const PLACEHOLDER_OPTION = /^(选项\s*[一二三四1-4]|[A-D]|比如|例如|其他|其它|以上|都不是)/;

function cleanOptions(value) {
  return listOf(value, 16, 3).filter(function (opt) {
    return !PLACEHOLDER_OPTION.test(opt);
  });
}

function normalizeIdentify(data, pool, round) {  const allowed = new Set(pool.map(function (c) { return c.id; }));
  const seen = new Set();
  const candidates = [];

  (Array.isArray(data.candidates) ? data.candidates : []).forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    const id = clipText(item.id, 64);
    if (!id || !allowed.has(id) || seen.has(id)) return;
    const concept = pool.find(function (c) { return c.id === id; });
    if (!concept) return;
    seen.add(id);
    candidates.push({
      conceptId: id,
      name: concept.name,
      plain: concept.plain,
      scene: (concept.indicators || [])[0] || '',
      reason: clipText(item.reason, 120)
    });
  });

  const followUps = [];
  if (round < 1) {
    (Array.isArray(data.follow_up_questions) ? data.follow_up_questions : []).forEach(function (item) {
      if (followUps.length >= 2) return;
      if (!item || typeof item !== 'object') return;
      const text = clipText(item.question, 80);
      if (!text) return;
      const options = cleanOptions(item.options);
      // 选项是占位词或不足两个，交给服务端兜底问题，避免前端出现「选项一」
      if (options.length < 2) return;
      followUps.push({ text: text, options: options });
    });
  }

  const confidence = ['较高', '中等', '有限'].indexOf(data.confidence) > -1 ? data.confidence : '有限';

  return {
    candidates: candidates.slice(0, 4),
    followUps: followUps,
    confidence: confidence,
    note: clipText(data.note, 160)
  };
}

/**
 * 模型偶尔只给 1–2 个候选，但产品需要 3–4 个方向供比较。
 * 从检索池按顺序补齐，理由用概念的一句话说明，避免编造匹配依据。
 */
function padCandidates(candidates, pool, target) {
  const list = candidates.slice();
  const seen = new Set(list.map(function (c) { return c.conceptId; }));
  pool.forEach(function (c) {
    if (list.length >= target || seen.has(c.id)) return;
    seen.add(c.id);
    list.push({
      conceptId: c.id,
      name: c.name,
      plain: c.plain,
      scene: (c.indicators || [])[0] || '',
      reason: '与你的描述有一部分相似：' + c.plain
    });
  });
  return list;
}

async function handleIdentify(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    return;
  }

  const lib = loadLibrary();
  if (!lib) {
    sendJSON(res, 503, { ok: false, error: '概念库未找到：' + LIBRARY_REL });
    return;
  }

  const raw = clipText(payload.raw, 3000);
  if (raw.length < 2) {
    sendJSON(res, 400, { ok: false, error: 'raw 太短' });
    return;
  }

  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  const combined = [raw]
    .concat(answers.map(function (a) {
      if (typeof a === 'string') return a;
      return a && typeof a === 'object' && !a.skipped ? (a.text || '') : '';
    }))
    .join('\n');

  const pool = retrieveConcepts(lib, combined, 8);
  if (!pool.length) {
    sendJSON(res, 200, { ok: true, candidates: [], followUps: [], confidence: '有限', note: '概念库为空', meta: { retrieved: [] } });
    return;
  }

  if (!API_KEY) {
    sendJSON(res, 503, { ok: false, error: '未配置 LLM_API_KEY' });
    return;
  }

  const round = Math.max(0, Math.min(1, Number(payload.followUpRounds) || 0));

  try {
    const content = await callModel([
      { role: 'system', content: SYSTEM_IDENTIFY },
      { role: 'user', content: buildIdentifyPrompt(pool, payload, round) }
    ], 900);

    const result = normalizeIdentify(extractJSON(content), pool, round);

    // 四项信息清点：足够则不再追问；不足且模型没问，则补一个针对性问题
    const gate = assessInformation(raw, combined);
    if (round >= 1 || gate.score >= 3) {
      result.followUps = [];
    } else if (!result.followUps.length) {
      result.followUps = fallbackQuestions(gate.missing);
    }

    // 产品要求信息足够时展示 3–4 个候选；模型给少了就从检索池按顺序补齐
    if (gate.score >= 3 && result.candidates.length > 0 && result.candidates.length < 3) {
      result.candidates = padCandidates(result.candidates, pool, 3);
    }

    sendJSON(res, 200, {
      ok: true,
      candidates: result.candidates,
      followUps: result.followUps,
      confidence: result.confidence,
      note: result.note,
      meta: {
        model: MODEL,
        source: LIBRARY_REL,
        retrieved: pool.map(function (c) { return c.id; }),
        round: round
      }
    });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? '模型响应超时' : '识别失败';
    sendJSON(res, 502, {
      ok: false,
      error: reason,
      detail: err && err.message ? String(err.message) : ''
    });
  }
}

/* ---------- 接口：生成理解报告（服务端读取概念） ---------- */

async function handleReport(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    return;
  }

  const lib = loadLibrary();
  if (!lib) {
    sendJSON(res, 503, { ok: false, error: '概念库未找到：' + LIBRARY_REL });
    return;
  }

  const conceptId = clipText(payload.conceptId, 64);
  if (!conceptId) {
    sendJSON(res, 400, { ok: false, error: '缺少 conceptId' });
    return;
  }

  const concept = findConcept(lib, conceptId);
  if (!concept) {
    sendJSON(res, 400, {
      ok: false,
      error: 'concept_not_found',
      message: '概念库里没有这个 id，或该条目已驳回',
      conceptId: conceptId
    });
    return;
  }

  if (!API_KEY) {
    sendJSON(res, 503, { ok: false, error: '未配置 LLM_API_KEY' });
    return;
  }

  try {
    const content = await callModel([
      { role: 'system', content: SYSTEM_REPORT },
      { role: 'user', content: buildReportPrompt(concept, payload) }
    ], 2200);

    sendJSON(res, 200, {
      ok: true,
      concept: {
        id: concept.id,
        name: concept.name,
        review_status: concept.review_status || 'pending_review'
      },
      report: fillFromConcept(normalizeReport(extractJSON(content)), concept),
      meta: { model: MODEL, source: LIBRARY_REL, libraryUpdatedAt: new Date(lib._mtime).toISOString() }
    });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? '模型响应超时' : '模型生成失败';
    sendJSON(res, 502, {
      ok: false,
      error: reason,
      detail: err && err.message ? String(err.message) : '',
      upstream: err && err.body ? err.body : ''
    });
  }
}

/* ---------- 接口：把用户场景与所选概念对应起来（板块二第 4 页） ---------- */

const SYSTEM_INTERPRET = [
  '你是「给痛苦一个名字」的理解助手。用户已经选定一个概念，并描述了一段具体经历。',
  '你的任务是把这段经历与概念对应起来，帮助用户确认或修正理解。这不是诊断。',
  '',
  '必须遵守：',
  '1. 只能使用给定概念的定义与指标，不引入新的概念名或理论。',
  '2. 只使用用户明确说过的内容；不推断对方的动机、童年、家庭或人格。',
  '3. 明确区分三类内容：用户说过的事实、基于概念的可能解释、目前无法确定的。',
  '4. 概念只部分贴合或信息不足时，要在 caveat 里直接说明，不要硬套。',
  '5. 用日常语言，克制、具体，每句不超过 60 字。',
  '',
  '只输出严格 JSON，不要 markdown，不要额外文字：',
  '{',
  '  "facts": ["用户明确说过的事实，最多 4 条"],',
  '  "matches": [{"fact": "对应的事实", "interpretation": "与概念的相似之处，可能/相似这类措辞", "certainty": "fact" | "hypothesis"}],',
  '  "unknown": ["仅凭目前描述无法确定的，最多 3 条"],',
  '  "caveat": "概念不完全贴合或信息不足时的说明，没有就空字符串"',
  '}'
].join('\n');

function buildInterpretPrompt(concept, payload) {
  const answers = Array.isArray(payload.answers)
    ? payload.answers.map(function (a) {
        if (typeof a === 'string') return clipText(a, 300);
        return a && typeof a === 'object' && !a.skipped ? clipText(a.text, 300) : '';
      }).filter(Boolean).slice(0, 10)
    : [];
  const scene = Array.isArray(payload.sceneAnswers)
    ? payload.sceneAnswers.map(function (s) {
        if (!s || typeof s !== 'object') return '';
        const q = clipText(s.question, 120);
        const a = s.skipped ? '（跳过）' : clipText(s.text, 400);
        return a ? '问：' + q + '\n答：' + a : '';
      }).filter(Boolean).slice(0, 6)
    : [];

  return [
    '【概念】',
    'id：' + concept.id,
    '名称：' + concept.name + '（' + concept.plain + '）',
    '定义：' + concept.definition,
    '典型表现：' + (concept.indicators || []).join('；'),
    '不适用：' + (concept.nonApplicable || []).join('；'),
    '',
    '【用户最初描述】',
    clipText(payload.raw, 2000),
    '',
    '【板块一已收集的回答】',
    answers.length ? answers.join('；') : '无',
    '',
    '【本次具体场景】',
    scene.length ? scene.join('\n') : '无',
    '',
    '【用户的修正】',
    clipText(payload.correction, 600) || '无',
    '',
    '请按 system 约定的 JSON 结构输出。'
  ].join('\n');
}

function normalizeInterpret(data) {
  const matches = Array.isArray(data.matches)
    ? data.matches.slice(0, 5).map(function (m) {
        if (!m || typeof m !== 'object') return null;
        const fact = clipText(m.fact, 120);
        const interpretation = clipText(m.interpretation, 200);
        if (!fact || !interpretation) return null;
        return {
          fact: fact,
          interpretation: interpretation,
          certainty: m.certainty === 'fact' ? 'fact' : 'hypothesis'
        };
      }).filter(Boolean)
    : [];
  return {
    facts: listOf(data.facts, 140, 4),
    matches: matches,
    unknown: listOf(data.unknown, 140, 3),
    caveat: clipText(data.caveat, 300)
  };
}

async function handleInterpret(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    return;
  }

  const lib = loadLibrary();
  if (!lib) {
    sendJSON(res, 503, { ok: false, error: '概念库未找到：' + LIBRARY_REL });
    return;
  }
  const concept = findConcept(lib, clipText(payload.conceptId, 64));
  if (!concept) {
    sendJSON(res, 400, { ok: false, error: 'concept_not_found' });
    return;
  }
  if (!API_KEY) {
    sendJSON(res, 503, { ok: false, error: '未配置 LLM_API_KEY' });
    return;
  }

  try {
    const content = await callModel([
      { role: 'system', content: SYSTEM_INTERPRET },
      { role: 'user', content: buildInterpretPrompt(concept, payload) }
    ], 900);
    sendJSON(res, 200, {
      ok: true,
      concept: { id: concept.id, name: concept.name },
      interpretation: normalizeInterpret(extractJSON(content)),
      meta: { model: MODEL, source: LIBRARY_REL }
    });
  } catch (err) {
    sendJSON(res, 502, {
      ok: false,
      error: err && err.name === 'TimeoutError' ? '模型响应超时' : '模型生成失败',
      detail: err && err.message ? String(err.message) : ''
    });
  }
}

async function handleChat(req, res) {
  if (!API_KEY) {
    sendJSON(res, 503, {
      error: '未配置 LLM_API_KEY。请在启动前设置环境变量，例如：$env:LLM_API_KEY="..."；未配置时前端会自动使用本地规则引擎。'
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    return;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || !messages.length) {
    sendJSON(res, 400, { error: '缺少 messages' });
    return;
  }

  const upstreamBody = JSON.stringify({
    model: MODEL,
    messages,
    stream: false,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
    max_tokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : 1600
  });

  try {
    const upstream = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + API_KEY
      },
      body: upstreamBody,
      signal: AbortSignal.timeout(45000)
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(text);
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? '模型响应超时' : '无法连接模型服务';
    sendJSON(res, 502, { error: reason });
  }
}

async function handleStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (err) {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // data/ 是服务端数据源，不通过静态目录对外提供
  if (pathname === '/data' || pathname.indexOf('/data/') === 0) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }

  const safe = path.normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = path.resolve(ROOT, safe);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache'
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    const lib = loadLibrary();
    sendJSON(res, 200, {
      ok: true,
      configured: !!API_KEY,
      model: MODEL,
      library: lib
        ? { source: LIBRARY_REL, total: (lib.concepts || []).length, usable: usableConcepts(lib).length }
        : { source: LIBRARY_REL, missing: true }
    });
    return;
  }

  if (pathname === '/api/concepts/stats') {
    if (req.method !== 'GET') {
      sendJSON(res, 405, { ok: false, error: '只支持 GET' });
      return;
    }
    handleLibraryStats(res);
    return;
  }

  if (pathname === '/api/identify') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { ok: false, error: '只支持 POST' });
      return;
    }
    await handleIdentify(req, res);
    return;
  }

  if (pathname === '/api/report') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { ok: false, error: '只支持 POST' });
      return;
    }
    await handleReport(req, res);
    return;
  }

  if (pathname === '/api/interpret') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { ok: false, error: '只支持 POST' });
      return;
    }
    await handleInterpret(req, res);
    return;
  }

  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { error: '只支持 POST' });
      return;
    }
    await handleChat(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  await handleStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  给痛苦一个名字 · 服务已启动');
  console.log('  ' + (HOST === '0.0.0.0' ? '监听 0.0.0.0' : 'http://127.0.0.1') + ':' + PORT);
  console.log('  模型：' + MODEL + (API_KEY ? '（已配置，走真实模型）' : '（未配置 Key，使用本地规则引擎）'));
  if (!API_KEY) {
    console.log('  启用模型：$env:LLM_API_KEY="你的 Key"; node server.mjs');
  }
  console.log('');
});
