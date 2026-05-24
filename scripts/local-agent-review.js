#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const AfterAiShared = require("../src/shared");

const args = parseArgs(process.argv.slice(2));
const cwd = path.resolve(args.cwd || process.cwd());
const task = args.task || path.basename(cwd);
const outputPath = path.resolve(args.output || path.join(cwd, "afterai-agent-review.json"));

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const context = collectContext(cwd, task);
  const conversation = buildConversation(context);
  const review = await maybeGenerateReview(conversation);
  const record = buildRecord(conversation, review);
  const payload = {
    version: 1,
    source: "afterai-local-agent",
    generatedAt: new Date().toISOString(),
    records: [record]
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`已生成：${outputPath}`);
  if (!review) {
    console.log("未检测到 API 环境变量，本次只生成原始任务记录。配置 AFTERAI_API_KEY 等变量后可直接生成知识点复盘。");
  }
}

function collectContext(workdir, taskName) {
  return {
    cwd: workdir,
    task: taskName,
    status: git(["status", "--short"], workdir),
    diffStat: git(["diff", "--stat"], workdir),
    diff: clip(git(["diff", "--", "."], workdir), 16000),
    recentCommits: git(["log", "--oneline", "-5"], workdir),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], workdir).trim()
  };
}

function buildConversation(context) {
  const prompt = [
    "请复盘这个本地 agent/终端任务，把它转化成用户可学习的知识点。",
    `任务：${context.task}`,
    `工作目录：${context.cwd}`,
    `分支：${context.branch || "unknown"}`,
    "",
    "最近提交：",
    context.recentCommits || "无",
    "",
    "工作区状态：",
    context.status || "干净"
  ].join("\n");

  const answer = [
    "本地 agent 任务上下文：",
    "",
    "Diff 统计：",
    context.diffStat || "无未提交 diff",
    "",
    "Diff 摘要：",
    context.diff || "无未提交 diff。可以结合最近提交复盘本次任务。"
  ].join("\n");

  return {
    url: `local-agent://${os.hostname()}/${encodeURIComponent(context.cwd)}`,
    title: context.task,
    prompt,
    answer,
    site: "local-agent",
    conversationTitle: context.task,
    conversationId: AfterAiShared.stableId(`local-agent\n${context.cwd}\n${context.task}`)
  };
}

async function maybeGenerateReview(conversation) {
  const settings = readEnvSettings();
  if (!settings.apiKey || !settings.baseUrl || !settings.model) return null;

  const coachPrompt = AfterAiShared.buildCoachPrompt(conversation, {
    includeAssessment: envBool("AFTERAI_ENABLE_ASSESSMENT"),
    outputLanguage: process.env.AFTERAI_OUTPUT_LANGUAGE || "简体中文"
  });
  const response = await fetch(buildRequestUrl(settings), {
    method: "POST",
    headers: createHeaders(settings),
    body: JSON.stringify(createRequestBody(settings, coachPrompt.messages))
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API 请求失败：${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return AfterAiShared.normalizeCoachPayload(AfterAiShared.extractJsonObject(readModelContent(settings.provider, data)));
}

function buildRecord(conversation, review) {
  const now = new Date().toISOString();
  const id = AfterAiShared.stableId(`${conversation.conversationId}\n${AfterAiShared.summarizeText(conversation.answer, 1200)}`);
  return {
    id,
    url: conversation.url,
    site: conversation.site,
    pageTitle: conversation.title,
    conversationTitle: conversation.conversationTitle,
    conversationId: conversation.conversationId,
    prompt: conversation.prompt,
    answer: conversation.answer,
    promptPreview: AfterAiShared.summarizeText(conversation.prompt, 120),
    answerPreview: AfterAiShared.summarizeText(conversation.answer, 180),
    createdAt: now,
    updatedAt: now,
    day: AfterAiShared.dayKey(now),
    taskKind: "code",
    review
  };
}

function readEnvSettings() {
  return {
    provider: normalizeProvider(process.env.AFTERAI_PROVIDER || "openai"),
    baseUrl: String(process.env.AFTERAI_BASE_URL || "").trim(),
    model: String(process.env.AFTERAI_MODEL || "").trim(),
    apiKey: String(process.env.AFTERAI_API_KEY || "").trim()
  };
}

function createHeaders(settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings.provider === "gemini") {
    headers["x-goog-api-key"] = settings.apiKey;
  } else if (settings.provider === "claude") {
    headers["x-api-key"] = settings.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

function createRequestBody(settings, messages) {
  if (settings.provider === "gemini") {
    return {
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      })),
      generationConfig: { responseMimeType: "application/json" }
    };
  }
  if (settings.provider === "claude") {
    return {
      model: settings.model,
      max_tokens: 2000,
      system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
      messages: [{ role: "user", content: messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n") }]
    };
  }
  if (settings.provider === "cohere") {
    return {
      model: settings.model,
      messages: messages.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content })),
      temperature: 0.2
    };
  }
  return { model: settings.model, messages, temperature: 0.2, response_format: { type: "json_object" } };
}

function readModelContent(provider, data) {
  if (provider === "gemini") {
    return data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts.map((part) => part.text || "").join("");
  }
  if (provider === "claude") {
    return data && Array.isArray(data.content) && data.content.map((part) => part && part.text ? part.text : "").join("");
  }
  if (provider === "cohere") {
    return data && data.message && Array.isArray(data.message.content)
      ? data.message.content.map((part) => part && part.text ? part.text : "").join("")
      : data && data.text;
  }
  return data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

function buildRequestUrl(settings) {
  const original = settings.baseUrl;
  const baseUrl = original.replace(/\/+$/, "");
  if (settings.provider === "gemini") return /generateContent(?:\?|$)/.test(baseUrl) ? original : `${baseUrl}/models/${encodeURIComponent(settings.model)}:generateContent`;
  if (settings.provider === "claude") return /\/v1\/messages(?:\?|$)/.test(baseUrl) ? original : `${baseUrl}/v1/messages`;
  if (settings.provider === "cohere") return /\/v2\/chat(?:\?|$)/.test(baseUrl) ? original : `${baseUrl}/v2/chat`;
  return /\/chat\/completions(?:\?|$)/.test(baseUrl) ? original : `${baseUrl}/chat/completions`;
}

function normalizeProvider(provider) {
  if (["openai", "gemini", "claude", "tgi", "cohere"].includes(provider)) return provider;
  return "openai";
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (item === "--task") parsed.task = values[++index];
    else if (item === "--cwd") parsed.cwd = values[++index];
    else if (item === "--output") parsed.output = values[++index];
    else if (item === "--help") {
      console.log("用法：node scripts/local-agent-review.js --task \"修复插件\" --cwd D:\\\\project --output review.json");
      process.exit(0);
    }
  }
  return parsed;
}

function git(args, workdir) {
  try {
    return execFileSync("git", args, { cwd: workdir, encoding: "utf8", maxBuffer: 1024 * 1024 * 8 }).trim();
  } catch (_) {
    return "";
  }
}

function clip(text, limit) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.floor(limit * 0.65))}\n\n[...本地 diff 已裁剪...]\n\n${value.slice(-Math.floor(limit * 0.25))}`;
}

function envBool(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ""));
}
