const assert = require("node:assert/strict");
const {
  buildCoachPrompt,
  buildConversationMap,
  buildLearningMap,
  clipText,
  dayKey,
  detectTaskKind,
  extractJsonObject,
  normalizeCoachPayload,
  normalizeAssessment,
  stableId
} = require("../src/shared");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("clipText keeps short text unchanged", () => {
  assert.equal(clipText(" hello\n\nworld ", 100), "hello\n\nworld");
});

test("clipText preserves beginning and end when clipping", () => {
  const input = "A".repeat(80) + "MIDDLE" + "Z".repeat(80);
  const output = clipText(input, 100);
  assert.match(output, /^A+/);
  assert.match(output, /Z+$/);
  assert.match(output, /已裁剪/);
  assert.ok(output.length > 100, "marker text is allowed to make clipped output slightly longer");
});

test("detectTaskKind recognizes common work types", () => {
  assert.equal(detectTaskKind("帮我写一个 Chrome 插件", ""), "code");
  assert.equal(detectTaskKind("帮我做一个 PPT 汇报", ""), "slides");
  assert.equal(detectTaskKind("帮我润色这封邮件", ""), "writing");
  assert.equal(detectTaskKind("分析一下这个想法", ""), "general");
});

test("buildCoachPrompt creates strict JSON coaching instruction", () => {
  const prompt = buildCoachPrompt({ prompt: "写代码", answer: "```js\nconsole.log(1)\n```" });
  assert.equal(prompt.taskKind, "code");
  assert.equal(prompt.messages.length, 2);
  assert.match(prompt.messages[0].content, /严格 JSON/);
  assert.match(prompt.messages[1].content, /concepts/);
  assert.match(prompt.messages[1].content, /how_to_learn/);
});

test("extractJsonObject parses pure and fenced-ish responses", () => {
  assert.deepEqual(extractJsonObject('{"title":"x"}'), { title: "x" });
  assert.deepEqual(extractJsonObject('好的：\n{"title":"x"}\n完成'), { title: "x" });
});

test("normalizeCoachPayload bounds variable-length arrays", () => {
  const payload = normalizeCoachPayload({
    title: "x",
    what_was_done: [1, 2, 3, 4, 5],
    ai_steps: [1, 2, 3, 4, 5, 6, 7],
    concepts: [1, 2, 3, 4, 5, 6],
    quiz: [1, 2, 3, 4]
  });
  assert.equal(payload.what_was_done.length, 4);
  assert.equal(payload.ai_steps.length, 6);
  assert.equal(payload.concepts.length, 5);
  assert.equal(payload.quiz.length, 3);
  assert.equal(payload.concepts[0].how_to_learn, "选一个相关的小例子，自己复做一遍。");
});

test("normalizeAssessment bounds verdicts and checks", () => {
  const assessment = normalizeAssessment({
    verdict: "risky",
    summary: "有明显风险",
    checks: [
      { claim: "A", judgment: "wrong", reason: "不成立", suggested_fix: "改成 B" },
      { claim: "B", judgment: "???", reason: "无法确认" }
    ],
    caveat: "需要外部资料"
  });

  assert.equal(assessment.verdict, "risky");
  assert.equal(assessment.checks[0].judgment, "wrong");
  assert.equal(assessment.checks[1].judgment, "unknown");
});

test("stableId is deterministic", () => {
  assert.equal(stableId("DOM 监听"), stableId("dom 监听"));
});

test("dayKey formats local dates", () => {
  assert.equal(dayKey("2026-05-23T10:00:00"), "2026-05-23");
});

test("buildLearningMap groups concepts by day and learned state", () => {
  const conceptId = stableId("组件状态");
  const map = buildLearningMap([
    {
      id: "r1",
      day: "2026-05-23",
      prompt: "写一个组件",
      review: {
        title: "组件复盘",
        concepts: [{ name: "组件状态", level: "today", how_to_learn: "改一个状态变量" }]
      }
    }
  ], { [conceptId]: { learnedAt: "2026-05-23T12:00:00" } });

  assert.equal(map.length, 1);
  assert.equal(map[0].learnedCount, 1);
  assert.equal(map[0].pendingCount, 0);
  assert.equal(map[0].concepts[0].learned, true);
});

test("buildLearningMap deduplicates repeated concepts and increments count", () => {
  const map = buildLearningMap([
    {
      id: "r1",
      day: "2026-05-23",
      prompt: "写一个组件",
      review: {
        title: "组件复盘",
        concepts: [{ name: "DOM 监听", level: "today", how_to_learn: "改一个观察器" }]
      }
    },
    {
      id: "r2",
      day: "2026-05-23",
      prompt: "写一个插件",
      review: {
        title: "插件复盘",
        concepts: [{ name: "dom 监听", level: "practice", how_to_learn: "再写一次" }]
      }
    }
  ], {});

  assert.equal(map[0].concepts.length, 1);
  assert.equal(map[0].concepts[0].occurrenceCount, 2);
  assert.equal(map[0].pendingCount, 1);
});

test("buildConversationMap groups records into sessions", () => {
  const map = buildConversationMap([
    {
      id: "r1",
      day: "2026-05-23",
      site: "chat.deepseek.com",
      pageTitle: "高斯公式讲解",
      conversationId: "s1",
      conversationTitle: "高斯公式讲解",
      prompt: "第一问",
      review: { concepts: [{ name: "高斯公式", level: "today" }] }
    },
    {
      id: "r2",
      day: "2026-05-23",
      site: "chat.deepseek.com",
      pageTitle: "高斯公式讲解",
      conversationId: "s1",
      conversationTitle: "高斯公式讲解",
      prompt: "第二问",
      review: { concepts: [{ name: "散度定理", level: "practice" }] }
    }
  ], {});

  assert.equal(map[0].sessions.length, 1);
  assert.equal(map[0].sessions[0].records.length, 2);
  assert.equal(map[0].sessions[0].concepts.length, 2);
});
