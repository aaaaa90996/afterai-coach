(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AfterAiShared = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULT_LIMITS = {
    prompt: 6000,
    answer: 10000
  };

  const TASK_KIND_LABELS = {
    code: "代码任务",
    slides: "PPT/演示任务",
    writing: "写作任务",
    general: "通用任务"
  };

  const LEVEL_LABELS = {
    today: "今天学",
    practice: "练几次",
    later: "以后学"
  };

  function clipText(text, maxLength) {
    const normalized = String(text || "").replace(/\n{4,}/g, "\n\n\n").trim();
    if (normalized.length <= maxLength) return normalized;

    const headLength = Math.max(20, Math.floor(maxLength * 0.55));
    const tailLength = Math.max(20, Math.floor(maxLength * 0.25));
    return [
      normalized.slice(0, headLength).trimEnd(),
      "\n\n[...中间内容已裁剪，插件保留了开头和结尾以节省 token...]\n\n",
      normalized.slice(normalized.length - tailLength).trimStart()
    ].join("");
  }

  function detectTaskKind(prompt, answer) {
    const text = `${prompt || ""}\n${answer || ""}`.toLowerCase();
    if (/```|function |class |#include|import |const |let |var |def |public static|cmake|api|bug|报错|代码|插件|extension/.test(text)) {
      return "code";
    }
    if (/ppt|powerpoint|slide|deck|演示|幻灯片|汇报|路演/.test(text)) {
      return "slides";
    }
    if (/文章|文案|邮件|报告|改写|润色|写作|copywriting|essay|blog/.test(text)) {
      return "writing";
    }
    return "general";
  }

  function buildCoachPrompt(conversation, options) {
    const limits = Object.assign({}, DEFAULT_LIMITS, options && options.limits);
    const taskKind = (options && options.taskKind) || detectTaskKind(conversation.prompt, conversation.answer);
    const includeAssessment = Boolean(options && options.includeAssessment);
    const outputLanguage = String(options && options.outputLanguage ? options.outputLanguage : "简体中文");
    const clippedPrompt = clipText(conversation.prompt, limits.prompt);
    const clippedAnswer = clipText(conversation.answer, limits.answer);

    return {
      taskKind,
      messages: [
        {
          role: "system",
          content: [
            "你是一个温和但具体的 AI 学习私教。",
            "用户刚用 AI 完成了一个任务，但希望把结果转化成自己的能力。",
            "你的目标不是夸奖，也不是泛泛总结，而是拆解 AI 的工作步骤、背后的知识点、用户下一步最小练习。",
            "必须输出严格 JSON，不要 Markdown，不要代码围栏。"
          ].join("")
        },
        {
          role: "user",
          content: [
            `任务类型：${TASK_KIND_LABELS[taskKind] || TASK_KIND_LABELS.general}`,
            `输出语言：${outputLanguage}`,
            "",
            "请基于下面最后一轮用户请求和 AI 回答，生成学习复盘。",
            "",
            "JSON schema:",
            "{",
            '  "title": "一句话标题",',
            '  "what_was_done": ["完成了什么，2-4条"],',
            '  "ai_steps": [{"step": "AI做了什么", "why": "为什么这样做"}],',
            '  "concepts": [{"name": "知识点", "level": "today|practice|later", "why_it_matters": "为什么重要", "how_to_learn": "具体怎么学，给一个小步骤"}],',
            '  "practice": {"timebox": "10分钟", "task": "用户可以亲手练的一小步", "success_check": "如何判断做对了"},',
            '  "quiz": [{"question": "微测试问题", "answer": "参考答案"}],',
            '  "next_time_try": "下次让用户先自己尝试的一小块",',
            '  "encouragement": "一句克制、具体、有力量的话"' + (includeAssessment ? "," : ""),
            includeAssessment ? '  "assessment": {"verdict": "reliable|mixed|risky|unknown", "summary": "对 AI 回答可靠性的简短判断", "checks": [{"claim": "需要检查的说法", "judgment": "supported|questionable|wrong|unknown", "reason": "判断原因", "suggested_fix": "如果有问题，如何修正"}], "caveat": "客观限制"}' : "",
            "}",
            "",
            "要求：",
            "- concepts 最多 5 个，必须按 today/practice/later 分层，每个都要给 how_to_learn。",
            "- ai_steps 最多 6 个。",
            "- quiz 2-3 题。",
            "- 除 JSON 字段名外，所有面向用户的内容都必须使用指定输出语言。",
            "- 练习必须小到今天能完成。",
            "- 如果回答里有大量代码，只解释关键决策，不逐行复述。",
            includeAssessment ? "- assessment 要客观挑错，不要默认相信 AI；不能确认时写 unknown，并说明需要用户查证什么。" : "",
            "",
            "用户请求：",
            clippedPrompt,
            "",
            "AI 回答：",
            clippedAnswer
          ].filter(Boolean).join("\n")
        }
      ]
    };
  }

  function extractJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("LLM 返回为空。");

    try {
      return JSON.parse(raw);
    } catch (_) {
      const first = raw.indexOf("{");
      const last = raw.lastIndexOf("}");
      if (first === -1 || last === -1 || last <= first) {
        throw new Error("没有找到可解析的 JSON 对象。");
      }
      return JSON.parse(raw.slice(first, last + 1));
    }
  }

  function normalizeCoachPayload(payload) {
    return {
      title: String(payload.title || "这次任务的学习复盘"),
      what_was_done: Array.isArray(payload.what_was_done) ? payload.what_was_done.slice(0, 4) : [],
      ai_steps: Array.isArray(payload.ai_steps) ? payload.ai_steps.slice(0, 6) : [],
      concepts: Array.isArray(payload.concepts) ? payload.concepts.slice(0, 5).map(normalizeConcept) : [],
      practice: payload.practice && typeof payload.practice === "object" ? payload.practice : {},
      quiz: Array.isArray(payload.quiz) ? payload.quiz.slice(0, 3) : [],
      next_time_try: String(payload.next_time_try || ""),
      encouragement: String(payload.encouragement || ""),
      assessment: normalizeAssessment(payload.assessment)
    };
  }

  function normalizeAssessment(assessment) {
    if (!assessment || typeof assessment !== "object") return null;
    const verdicts = ["reliable", "mixed", "risky", "unknown"];
    const judgments = ["supported", "questionable", "wrong", "unknown"];
    return {
      verdict: verdicts.includes(assessment.verdict) ? assessment.verdict : "unknown",
      summary: String(assessment.summary || ""),
      checks: Array.isArray(assessment.checks) ? assessment.checks.slice(0, 6).map((item) => ({
        claim: String(item && item.claim ? item.claim : ""),
        judgment: judgments.includes(item && item.judgment) ? item.judgment : "unknown",
        reason: String(item && item.reason ? item.reason : ""),
        suggested_fix: String(item && item.suggested_fix ? item.suggested_fix : "")
      })) : [],
      caveat: String(assessment.caveat || "")
    };
  }

  function normalizeConcept(concept) {
    const level = ["today", "practice", "later"].includes(concept && concept.level) ? concept.level : "practice";
    return {
      id: concept && concept.id ? String(concept.id) : stableId(String(concept && concept.name ? concept.name : "知识点")),
      name: String(concept && concept.name ? concept.name : "知识点"),
      level,
      levelLabel: LEVEL_LABELS[level],
      why_it_matters: String(concept && concept.why_it_matters ? concept.why_it_matters : ""),
      how_to_learn: String(concept && concept.how_to_learn ? concept.how_to_learn : "选一个相关的小例子，自己复做一遍。")
    };
  }

  function stableId(text) {
    let hash = 2166136261;
    const value = String(text || "").trim().toLowerCase();
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `aic_${(hash >>> 0).toString(36)}`;
  }

  function dayKey(dateLike) {
    const date = dateLike ? new Date(dateLike) : new Date();
    if (Number.isNaN(date.getTime())) return dayKey();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function summarizeText(text, limit) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
  }

  function buildLearningMap(records, learnedConcepts) {
    const learned = learnedConcepts || {};
    const days = new Map();

    (Array.isArray(records) ? records : []).forEach((record) => {
      const key = record.day || dayKey(record.createdAt);
      if (!days.has(key)) {
        days.set(key, {
          day: key,
          records: [],
          concepts: [],
          learnedCount: 0,
          pendingCount: 0
        });
      }

      const bucket = days.get(key);
      bucket.records.push(record);

      const concepts = record.review && Array.isArray(record.review.concepts) ? record.review.concepts : [];
      concepts.forEach((concept) => {
        const normalized = normalizeConcept(concept);
        const conceptId = normalized.id || stableId(normalized.name);
        const isLearned = Boolean(learned[conceptId]);
        const recordTitle = record.review && record.review.title ? record.review.title : summarizeText(record.prompt, 48);
        const existing = bucket.concepts.find((item) => item.id === conceptId);
        if (existing) {
          existing.occurrenceCount += 1;
          if (!existing.recordIds.includes(record.id)) existing.recordIds.push(record.id);
          if (!existing.recordTitles.includes(recordTitle)) existing.recordTitles.push(recordTitle);
        } else {
          bucket.concepts.push(Object.assign({}, normalized, {
            id: conceptId,
            recordId: record.id,
            recordIds: [record.id],
            recordTitle,
            recordTitles: [recordTitle],
            learned: isLearned,
            occurrenceCount: 1
          }));
          if (isLearned) bucket.learnedCount += 1;
          else bucket.pendingCount += 1;
        }
      });
    });

    return Array.from(days.values()).sort((a, b) => b.day.localeCompare(a.day));
  }

  function buildConversationMap(records, learnedConcepts) {
    const days = buildLearningMap(records, learnedConcepts);
    const sourceRecords = Array.isArray(records) ? records : [];

    days.forEach((day) => {
      const sessions = new Map();
      day.records.forEach((record) => {
        const sessionId = record.conversationId || stableId(`${record.site || ""}\n${record.pageTitle || ""}\n${record.url || ""}`);
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            id: sessionId,
            site: record.site || "unknown",
            title: record.conversationTitle || record.pageTitle || record.site || "未命名会话",
            url: record.url || "",
            records: [],
            concepts: [],
            learnedCount: 0,
            pendingCount: 0
          });
        }
        sessions.get(sessionId).records.push(record);
      });

      day.concepts.forEach((concept) => {
        const record = sourceRecords.find((item) => item.id === concept.recordId) || {};
        const sessionId = record.conversationId || stableId(`${record.site || ""}\n${record.pageTitle || ""}\n${record.url || ""}`);
        const session = sessions.get(sessionId);
        if (!session) return;

        const existing = session.concepts.find((item) => item.id === concept.id);
        if (existing) {
          existing.occurrenceCount += concept.occurrenceCount || 1;
          (concept.recordIds || [concept.recordId]).forEach((id) => {
            if (id && !existing.recordIds.includes(id)) existing.recordIds.push(id);
          });
        } else {
          session.concepts.push(Object.assign({}, concept));
          if (concept.learned) session.learnedCount += 1;
          else session.pendingCount += 1;
        }
      });

      day.sessions = Array.from(sessions.values()).sort((a, b) => {
        const newestA = a.records[0] && a.records[0].createdAt ? a.records[0].createdAt : "";
        const newestB = b.records[0] && b.records[0].createdAt ? b.records[0].createdAt : "";
        return newestB.localeCompare(newestA);
      });
    });

    return days;
  }

  return {
    DEFAULT_LIMITS,
    LEVEL_LABELS,
    TASK_KIND_LABELS,
    buildConversationMap,
    buildLearningMap,
    buildCoachPrompt,
    clipText,
    dayKey,
    detectTaskKind,
    extractJsonObject,
    normalizeCoachPayload,
    normalizeConcept,
    normalizeAssessment,
    stableId,
    summarizeText
  };
});
