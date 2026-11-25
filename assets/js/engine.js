/* 给痛苦一个名字 · 本地识别引擎
 * 说明：这不是模型，而是可解释的规则层——信号词匹配、线索抽取、候选打分与兜底。
 * 线上主路径是服务端 /api/identify（检索候选池 + 模型排序 + 追问）；
 * 本文件在断网、未配置 Key 或模型异常时接管（见 app.js 的 fallbackLocal），
 * 同时定义固定追问顺序（CHAT_ORDER）、答案写入与候选落地逻辑。
 */
window.Engine = (function () {
  const D = window.PAIN_DATA;
  const conceptById = {};
  D.concepts.forEach(function (c) { conceptById[c.id] = c; });

  const EMOTIONS = [
    '难受', '难过', '焦虑', '不安', '害怕', '恐惧', '委屈', '生气', '愤怒', '愧疚',
    '自责', '失落', '孤独', '空虚', '崩溃', '绝望', '心慌', '烦躁', '麻木', '羞耻',
    '嫉妒', '无助', '疲惫', '压抑', '想念', '不舍', '后悔', '恐慌', '紧张', '伤心',
    '低落', '沮丧', '无力', '烦', '担心', '慌', '着急', '舍不得', '心酸'
  ];

  const BEHAVIOR_WORDS = [
    '看手机', '翻聊天记录', '反复看', '发消息', '删了又写', '追问', '不敢问', '忍住',
    '装作', '喝醉', '哭', '睡不着', '失眠', '找他', '道歉', '解释', '试探', '确认',
    '等他', '盯着', '刷他', '翻照片', '假装', '冷战', '摔门', '走开', '沉默', '不敢说', '不敢提'
  ];

  const BODY_WORDS = [
    '胸口', '心口', '心跳', '发抖', '头疼', '头痛', '胃', '吃不下', '没胃口',
    '睡不着', '失眠', '喘不过', '没力气', '手抖', '恶心'
  ];

  const NEED_WORDS = [
    { words: ['安全感', '安心'], label: '安全感' },
    { words: ['在乎', '重视', '被看见'], label: '被在乎、被看见' },
    { words: ['答案', '说清楚', '明确', '确定'], label: '一个明确的答案' },
    { words: ['尊重', '边界'], label: '被尊重、有边界' },
    { words: ['陪', '陪伴'], label: '陪伴' },
    { words: ['休息', '喘息', '安静'], label: '喘息的空间' },
    { words: ['爱', '喜欢'], label: '被爱、被选择' }
  ];

  const CONTEXT_RULES = [
    { words: ['回消息', '没回', '不回', '回我', '聊天记录', '不理我', '不回我'], label: '亲密互动' },
    { words: ['分手', '前任', '被甩', '分开', '结束了'], label: '关系结束' },
    { words: ['暧昧', '算什么', '没名分', '不清不楚'], label: '关系状态模糊' },
    { words: ['男朋友', '女朋友', '男友', '女友', '对象', '伴侣', '老公', '老婆', '交往', '在一起'], label: '恋爱关系' },
    { words: ['异地', '异国'], label: '异地关系' },
    { words: ['相亲', '约会', '追求', '喜欢的人', '暗恋'], label: '还未确定的关系' },
    { words: ['复合', '和好'], label: '关系反复' }
  ];

  const FEEDBACK_LABEL = {
    done: '完成了，感觉还不错',
    tried: '试了，但没有想象中容易',
    later: '暂时不想做'
  };

  function unique(arr) {
    const seen = {};
    return arr.filter(function (x) {
      if (seen[x]) return false;
      seen[x] = true;
      return true;
    });
  }

  // 去掉互相包含的命中词，避免「难受 / 很难受」被算成两条独立线索
  function prune(words) {
    const sorted = words.slice().sort(function (a, b) { return b.length - a.length; });
    const kept = [];
    sorted.forEach(function (w) {
      const covered = kept.some(function (k) { return k.indexOf(w) > -1; });
      if (!covered) kept.push(w);
    });
    return kept;
  }

  function splitSentences(text) {
    return String(text)
      .split(/[。！？!?；;\n\r]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function findSentence(text, word) {
    const list = splitSentences(text);
    for (let i = 0; i < list.length; i++) {
      if (list[i].indexOf(word) > -1) return list[i];
    }
    return '';
  }

  function clip(text, n) {
    const t = String(text || '').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function extract(text) {
    const raw = String(text || '');
    const sentences = splitSentences(raw);

    const emotions = unique(EMOTIONS.filter(function (w) { return raw.indexOf(w) > -1; }));

    const thoughts = sentences.filter(function (s) {
      return /觉得|认为|担心|怀疑|是不是|会不会|可能|以为|怕|感觉/.test(s);
    }).slice(0, 4).map(function (s) { return clip(s, 60); });

    const behaviors = unique(prune(BEHAVIOR_WORDS.filter(function (w) {
      return raw.indexOf(w) > -1;
    })));

    const context = [];
    CONTEXT_RULES.forEach(function (rule) {
      if (rule.words.some(function (w) { return raw.indexOf(w) > -1; })) context.push(rule.label);
    });

    const body = unique(BODY_WORDS.filter(function (w) { return raw.indexOf(w) > -1; }));

    const needs = [];
    NEED_WORDS.forEach(function (n) {
      if (n.words.some(function (w) { return raw.indexOf(w) > -1; })) needs.push(n.label);
    });

    return {
      sentences: sentences,
      emotions: emotions,
      thoughts: thoughts,
      behaviors: behaviors,
      context: unique(context),
      body: body,
      needs: unique(needs)
    };
  }

  function scoreConcept(concept, text) {
    let score = 0;
    let wordCount = 0;
    const hits = [];
    (concept.signals || []).forEach(function (sig) {
      const found = prune(sig.words.filter(function (w) { return text.indexOf(w) > -1; }));
      if (found.length) {
        score += sig.w + Math.min(found.length - 1, 2) * 0.5;
        wordCount += found.length;
        hits.push({
          label: sig.label,
          words: unique(found),
          sentence: findSentence(text, found[0])
        });
      }
    });
    return { concept: concept, score: score, wordCount: wordCount, hits: hits };
  }

  function missingFields(profile) {
    const missing = [];
    if (!profile.context.length) missing.push('context');
    if (!profile.behaviors.length) missing.push('behavior');
    if (!profile.thoughts.length) missing.push('thought');
    if (!profile.emotions.length) missing.push('emotion');
    if (!profile.body.length) missing.push('body');
    if (!profile.needs.length) missing.push('need');
    return missing;
  }

  function questionsFor(record) {
    if (!record) return [];
    if (record.status === 'identified' || record.followUpDone || record.skippedFollowUp) return [];
    if (record.aiQuestions && record.aiQuestions.length) {
      return record.aiQuestions.slice(0, 3).map(function (text, i) {
        return { key: 'ai' + i, text: text };
      });
    }
    return record.missing.slice(0, 3).map(function (key) {
      return { key: key, text: D.questions[key] };
    });
  }

  function analyze(text) {
    const profile = extract(text);
    const scored = D.concepts.map(function (c) { return scoreConcept(c, text); })
      .sort(function (a, b) { return b.score - a.score; });

    const top = scored[0];
    const second = scored[1];
    const hasBase = profile.context.length > 0 || profile.emotions.length > 0 ||
      profile.behaviors.length > 0 || profile.thoughts.length > 0;

    let status;
    if (!top || top.score < 2.5 || top.wordCount < 2 || !hasBase) status = 'insufficient_information';
    else if (top.score < 3.5 || top.wordCount < 2) status = 'uncertain';
    else status = 'identified';

    const diff = (second && top) ? top.score - second.score : 9;
    let confidence = '有限';
    if (top && top.score >= 5.5 && diff >= 1.5) confidence = '较高';
    else if (top && top.score >= 3.5 && diff >= 0.8) confidence = '中等';

    return {
      text: text,
      profile: profile,
      scored: scored,
      top: top,
      second: second,
      status: status,
      confidence: confidence,
      diff: diff,
      hasBase: hasBase
    };
  }

  function buildRecord(raw, answers) {
    answers = answers || [];
    const combined = [raw].concat(answers).join('\n');
    const m = analyze(combined);
    const profile = m.profile;
    const scored = m.scored;
    const top = m.top;
    const second = m.second;
    const status = m.status;
    const diff = m.diff;
    const confidence = m.confidence;

    let primary = null;
    let related = [];
    if (status !== 'insufficient_information') {
      primary = {
        conceptId: top.concept.id,
        score: top.score,
        wordCount: top.wordCount,
        hits: top.hits
      };
      related = scored.slice(1).filter(function (r) {
        const enough = r.score >= 3 || (r.score >= 2 && r.hits.length >= 2);
        return enough && r.score >= top.score * 0.5;
      }).slice(0, 2).map(function (r) {
        return { conceptId: r.concept.id, score: r.score, sentence: r.hits[0] ? r.hits[0].sentence : '' };
      });
    }

    const notes = [];
    if (second && second.score >= 3 && diff < 0.8 && status !== 'insufficient_information') {
      notes.push('你描述里的线索也与「' + second.concept.name + '」有重叠，这两个概念有时会同时出现。');
    }
    if (status === 'uncertain') {
      notes.push('目前的线索还不够集中，所以这更像一个方向，而不是结论。');
    }
    if (status === 'insufficient_information') {
      notes.push('当前的信息还不足以在概念库里找到可靠对应，我不会勉强给你一个名字。');
    }
    if (primary) notes.push(conceptById[primary.conceptId].limits);

    return {
      id: 'pr_' + Date.now().toString(36),
      createdAt: Date.now(),
      raw: raw,
      answers: answers,
      combined: combined,
      profile: profile,
      status: status,
      primary: primary,
      related: related,
      confidence: confidence,
      uncertainty: notes,
      missing: missingFields(profile),
      followUpDone: answers.length > 0,
      skippedFollowUp: false
    };
  }

  /* ---------- 对话式识别：逐题追问 + 候选概念 ---------- */

  const CHAT_ORDER = ['context', 'emotion', 'thought', 'behavior', 'body', 'expression', 'need'];
  const CHAT_LIMIT = 7;

  function combineText(raw, answers) {
    const parts = [String(raw || '')];
    (answers || []).forEach(function (a) {
      if (a && a.text) parts.push(a.text);
    });
    return parts.join('\n');
  }

  function chatQuestion(key) {
    const meta = (D.chatQuestions && D.chatQuestions[key]) || null;
    if (!meta) return null;
    return { key: key, text: meta.text, options: (meta.options || []).slice(0, 3) };
  }

  function buildDraft(raw) {
    const profile = extract(raw);
    return {
      id: 'pr_' + Date.now().toString(36),
      createdAt: Date.now(),
      raw: raw,
      answers: [],
      combined: raw,
      profile: profile,
      status: 'collecting',
      primary: null,
      related: [],
      confidence: '',
      uncertainty: [],
      missing: missingFields(profile),
      followUpDone: false,
      skippedFollowUp: false,
      candidates: null,
      chatDone: false,
      confirmed: false
    };
  }

  function nextQuestion(record) {
    if (!record || record.chatDone) return null;
    const answers = record.answers || [];
    if (answers.length >= CHAT_LIMIT) return null;

    const m = analyze(combineText(record.raw, answers));
    if (answers.length >= 4 && m.top && m.top.score >= 5.5 && m.diff >= 1.5) return null;

    const asked = {};
    answers.forEach(function (a) { asked[a.key] = true; });
    for (let i = 0; i < CHAT_ORDER.length; i++) {
      if (!asked[CHAT_ORDER[i]]) return chatQuestion(CHAT_ORDER[i]);
    }
    return null;
  }

  function addAnswer(record, key, text, skipped, question) {
    record.answers = (record.answers || []).slice();
    record.answers.push({
      key: key,
      text: String(text || '').trim(),
      skipped: !!skipped,
      question: question || ''
    });
    record.combined = combineText(record.raw, record.answers);
    record.profile = extract(record.combined);
    record.missing = missingFields(record.profile);
    return record;
  }

  /* ---------- 模型识别：追加追问与候选 ---------- */

  function setAiFollowUps(record, questions) {
    record.aiQuestions = (questions || []).slice(0, 2).map(function (q) {
      return { text: q.text || '', options: (q.options || []).slice(0, 3) };
    });
    record.aiAsked = 0;
    record.status = record.aiQuestions.length ? 'followup' : 'thinking';
    return record;
  }

  function currentAiQuestion(record) {
    const list = record.aiQuestions || [];
    const index = record.aiAsked || 0;
    return list[index] || null;
  }

  function addAiAnswer(record, text, skipped, question) {
    const index = record.aiAsked || 0;
    addAnswer(record, 'ai' + index, text, skipped, question);
    record.aiAsked = index + 1;
    return record;
  }

  function applyAiCandidates(record, list, confidence, note) {
    record.candidates = (list || []).slice(0, 4);
    record.aiConfidence = confidence || '有限';
    record.aiNote = note || '';
    record.status = record.candidates.length ? 'awaiting_choice' : 'insufficient_information';
    record.followUpDone = true;
    record.chatDone = true;
    return record;
  }

  function candidates(record, limit) {
    if (!record) return [];
    const m = analyze(combineText(record.raw, record.answers));
    const ranked = m.scored.filter(function (r) { return r.score >= 2.4 && r.hits.length > 0; });
    if (!ranked.length) return [];
    // 线索总量太少时宁可给不出名字，也不硬套
    const totalWords = ranked.reduce(function (n, r) { return n + r.wordCount; }, 0);
    if (totalWords < 2 || ranked[0].score < 2.8) return [];
    const topScore = ranked[0].score;
    return ranked
      .filter(function (r) { return r.score >= Math.max(2.4, topScore * 0.45); })
      .slice(0, limit || 4)
      .map(function (r) {
        return {
          conceptId: r.concept.id,
          name: r.concept.name,
          plain: r.concept.plain,
          scene: (r.concept.indicators || [])[0] || '',
          reason: r.hits[0] ? r.hits[0].label : ''
        };
      });
  }

  function refreshRecord(record) {
    const m = analyze(combineText(record.raw, record.answers));
    record.profile = m.profile;
    record.combined = m.text;
    record.missing = missingFields(m.profile);
    record.candidates = candidates(record);
    record.status = record.candidates.length ? 'awaiting_choice' : 'insufficient_information';
    return record;
  }

  function finishChat(record) {
    record.followUpDone = true;
    record.chatDone = true;
    record.confirmed = false;
    return refreshRecord(record);
  }

  function continueRecord(record, text) {
    record.raw = String(record.raw || '') + '\n' + String(text || '').trim();
    record.chatDone = true;
    record.confirmed = false;
    return refreshRecord(record);
  }

  function chooseConcept(record, conceptId) {
    const concept = conceptById[conceptId];
    if (!concept) return record;

    const m = analyze(combineText(record.raw, record.answers));
    const scored = scoreConcept(concept, m.text);
    const rivals = m.scored.filter(function (r) {
      return r.concept.id !== conceptId && r.score >= 2.4;
    });
    const gap = scored.score - (rivals[0] ? rivals[0].score : 0);

    const notes = [];
    if (rivals[0] && rivals[0].score >= 3 && gap < 1.2) {
      notes.push('你描述里的线索也与「' + rivals[0].concept.name + '」有重叠，这两个概念有时会同时出现。');
    }
    if (scored.score < 3.5 && !record.aiConfidence) {
      notes.push('目前的线索还不够集中，所以这更像一个方向，而不是结论。');
    }
    notes.push(concept.limits);

    const candidate = (record.candidates || []).find(function (c) { return c.conceptId === conceptId; });
    const hits = scored.hits.length
      ? scored.hits
      : (candidate && candidate.reason ? [{ label: candidate.reason, words: [], sentence: '' }] : []);

    const status = record.aiConfidence === '较高'
      ? 'identified'
      : (scored.score >= 3.5 && scored.wordCount >= 2 ? 'identified' : 'uncertain');

    const next = Object.assign({}, record, {
      status: status,
      primary: {
        conceptId: conceptId,
        score: scored.score,
        wordCount: scored.wordCount,
        hits: hits
      },
      related: rivals.slice(0, 2).map(function (r) {
        return { conceptId: r.concept.id, score: r.score, sentence: r.hits[0] ? r.hits[0].sentence : '' };
      }),
      confidence: record.aiConfidence ||
        (scored.score >= 5.5 && gap >= 1.2 ? '较高' : (scored.score >= 3.5 ? '中等' : '有限')),
      uncertainty: notes,
      profile: m.profile,
      combined: m.text,
      missing: missingFields(m.profile),
      followUpDone: true,
      chatDone: true,
      confirmed: true
    });
    return next;
  }

  function buildLinks(concept, profile, text) {
    const out = [];
    const rules = (concept.links && concept.links.behavior) || [];
    rules.forEach(function (rule) {
      const hit = rule.words.find(function (w) { return text.indexOf(w) > -1; });
      if (hit && out.length < 2) {
        out.push({
          fact: findSentence(text, hit) || hit,
          interpretation: rule.text,
          certainty: 'hypothesis'
        });
      }
    });
    if (out.length < 2 && profile.thoughts.length && concept.links.thought) {
      const thought = profile.thoughts[0];
      const duplicated = out.some(function (o) {
        return o.fact.indexOf(thought) > -1 || thought.indexOf(o.fact) > -1;
      });
      if (!duplicated) {
        out.push({
          fact: thought,
          interpretation: concept.links.thought,
          certainty: 'hypothesis'
        });
      }
    }
    if (profile.emotions.length && concept.links.emotion) {
      out.push({
        fact: '你用了这些词描述感受：' + profile.emotions.slice(0, 4).join('、'),
        interpretation: concept.links.emotion,
        certainty: 'hypothesis'
      });
    }
    if (out.length < 2 && profile.needs.length) {
      out.push({
        fact: '你似乎希望：' + profile.needs.join('、'),
        interpretation: '这更像是从你的描述里推测出的需要，而不是你明确说过的目标。',
        certainty: 'guess'
      });
    }
    return out.slice(0, 4);
  }

  function missingLabels(record) {
    const map = {
      context: '这件事发生的具体关系与时间背景',
      behavior: '你当时的具体反应',
      thought: '当时出现的具体想法',
      emotion: '更具体的情绪词',
      body: '身体上的反应',
      need: '你希望被满足的需要'
    };
    return record.missing.map(function (k) { return map[k]; }).filter(Boolean);
  }

  function buildReport(record, depth, originsText) {
    const concept = record.primary ? conceptById[record.primary.conceptId] : null;
    const profile = record.profile;
    const origins = (originsText || '').trim();
    const report = {
      createdAt: Date.now(),
      depth: depth,
      status: record.status,
      conceptId: concept ? concept.id : null,
      origins: {
        provided: origins.length > 0,
        text: origins,
        paragraph: '',
        questions: D.originsQuestions
      },
      explain: [],
      mechanism: [],
      cycle: [],
      links: [],
      facts: [],
      hypotheses: [],
      unknowns: [],
      summary: '',
      sources: [],
      limits: '',
      transition: ''
    };

    if (concept) {
      report.explain = concept.explanation.slice();
      report.mechanism = concept.mechanism.slice();
      report.cycle = concept.cycle.slice();
      report.links = buildLinks(concept, profile, record.combined);

      report.facts = unique([]
        .concat(profile.thoughts.slice(0, 1))
        .concat(profile.behaviors.slice(0, 2))
        .concat(profile.emotions.length ? ['你用了这些词描述感受：' + profile.emotions.join('、')] : [])
      ).slice(0, 4);

      report.hypotheses = report.links.map(function (l) { return l.interpretation; });
      report.unknowns = missingLabels(record)
        .concat(['对方当时的想法和感受，从这里无法得知。']);
      report.summary =
        '把这些放在一起看，你正在经历的，可能不只是「' + clip(record.raw, 26) + '」这一件事，' +
        '而是一个可以被命名的模式：' + concept.plain + '。' + concept.summary +
        '它不是你的性格判决，更像一套曾经帮你撑住不确定的方式，现在开始需要换一种用法。';
      report.sources = concept.sources;
      report.limits = concept.limits;
      report.transition =
        '理解到这里，已经足够。接下来不是要你改变什么，而是看看有没有一两个方向，' +
        '是你愿意为自己试一次的。你可以只看看，也可以暂时什么都不选。';

      if (origins && concept.origins) {
        report.origins.paragraph =
          '你提到：' + clip(origins, 80) + '。' + concept.origins +
          '需要说明的是，这只是基于理论的待探索假设，不能替代你对自己的判断，也不是在说过去一定发生了什么。';
      } else if (origins) {
        report.origins.paragraph =
          '你提到：' + clip(origins, 80) + '。这段经历可能与现在的感受有关，' +
          '但在没有更多信息时，我不会把它当成确定的原因。它更像是你自己可以继续对照的一条线索。';
      } else {
        report.origins.paragraph =
          '你选择了探索形成因素，但还没有提供更早的经历。这里不会替你补上——' +
          '童年、家庭或过去的关系，只有你自己说出来，才可能被讨论。' +
          '如果你愿意，可以回到上一步补充；不补充也完全可以。';
      }
    } else {
      report.explain = [
        '你写下的这些，我还没有足够的依据把它对应到概念库里某个具体概念。与其给你一个听起来专业的名字，我更愿意先诚实地说明这一点。',
        '这不代表你的感受不重要，也不代表它不够严重。只说明目前的描述里，还缺少能支撑一个可靠命名的线索。'
      ];
      report.links = profile.sentences.slice(0, 3).map(function (s) {
        return {
          fact: clip(s, 60),
          interpretation: '这是你明确写下的内容。我们先把它保留在这里，不急着解释它属于什么。',
          certainty: 'fact'
        };
      });
      report.facts = profile.sentences.slice(0, 3).map(function (s) { return clip(s, 60); });
      report.hypotheses = [];
      report.unknowns = missingLabels(record).concat(['对方当时的想法，从这里无法得知。']);
      report.summary =
        '现在的状态更像是一团还没有被分开的感受，而不是一个可以被命名的模式。' +
        '你可以继续补充，也可以先不做任何判断——先照顾好今天，本身就是一件成立的事。';
      report.transition = '如果你愿意，可以先从很小的事情开始。这些不是任务，只是几个可能的落脚点。';
      report.origins.paragraph = origins
        ? '你提到：' + clip(origins, 80) + '。在没有可靠命名的前提下，我不会用这段经历去反推任何结论。'
        : '在还没有可靠命名时，探索更早的经历容易变成猜测，所以这里先留空。';
    }

    return report;
  }

  function directionsFor(record) {
    const concept = record && record.primary ? conceptById[record.primary.conceptId] : null;
    const ids = concept ? concept.directions : ['d_general', 'd_grounding', 'd_expression'];
    return ids.map(function (id) { return D.directions[id]; }).filter(Boolean).slice(0, 3);
  }

  function buildMilestone(logs, direction) {
    if (!logs || !logs.length) return null;
    const done = logs.filter(function (l) { return l.feedback === 'done'; }).length;
    const tried = logs.filter(function (l) { return l.feedback === 'tried'; }).length;
    const later = logs.filter(function (l) { return l.feedback === 'later'; }).length;
    const reflection = logs.filter(function (l) { return l.reflection; }).pop();

    let title = '第一次为自己做了一个小尝试';
    if (done > 0) title = '第一次把注意力放回自己身上';
    else if (tried > 0) title = '第一次试着用新的方式回应';

    const parts = [];
    parts.push(formatDate(logs[0].createdAt) + '，你为「' + (direction ? direction.title : '自己') + '」留下了 ' + logs.length + ' 条记录。');
    if (done) parts.push('其中 ' + done + ' 次，你完成了自己选的那件小事。');
    if (tried) parts.push('还有 ' + tried + ' 次，你试着做了，但发现并不容易——这也是很重要的信息。');
    if (later) parts.push('有 ' + later + ' 次，你选择了暂时不做，这也是一种对自己状态的了解。');
    if (reflection) parts.push('你写下：「' + clip(reflection.reflection, 70) + '」');
    parts.push('这不是完成率的证明，而是你开始注意到自己的一种方式。');

    return {
      id: 'ms_' + Date.now().toString(36),
      createdAt: Date.now(),
      title: title,
      description: parts.join(''),
      evidenceLogIds: logs.map(function (l) { return l.id; }),
      status: 'pending_user_confirmation'
    };
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function detectCrisis(text) {
    const raw = String(text || '');
    return D.crisis.keywords.some(function (k) { return raw.indexOf(k) > -1; });
  }

  return {
    conceptById: conceptById,
    extract: extract,
    buildRecord: buildRecord,
    buildDraft: buildDraft,
    chatQuestion: chatQuestion,
    chatLimit: CHAT_LIMIT,
    nextQuestion: nextQuestion,
    addAnswer: addAnswer,
    setAiFollowUps: setAiFollowUps,
    currentAiQuestion: currentAiQuestion,
    addAiAnswer: addAiAnswer,
    applyAiCandidates: applyAiCandidates,
    candidates: candidates,
    analyze: analyze,
    finishChat: finishChat,
    continueRecord: continueRecord,
    chooseConcept: chooseConcept,
    combineText: combineText,
    questionsFor: questionsFor,
    missingFields: missingFields,
    missingLabels: missingLabels,
    buildReport: buildReport,
    directionsFor: directionsFor,
    buildMilestone: buildMilestone,
    detectCrisis: detectCrisis,
    feedbackLabel: FEEDBACK_LABEL,
    clip: clip,
    formatDate: formatDate,
    hasLibrary: function () { return D.concepts.length > 0; }
  };
})();
