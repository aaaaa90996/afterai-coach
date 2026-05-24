importScripts("./shared.js");

const DEFAULT_SETTINGS = {
  provider: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
  requestTimeoutMs: 60000,
  outputLanguage: "简体中文",
  enableAssessment: false,
  autoRead: false,
  reviewMode: "conversation",
  pageWidgetsHidden: false
};

const STORAGE_KEYS = {
  records: "afterai.records",
  learnedConcepts: "afterai.learnedConcepts"
};

let archiveQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set(Object.assign({}, DEFAULT_SETTINGS, existing));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  routeMessage(message)
    .then((result) => sendResponse(Object.assign({ ok: true }, result)))
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));

  return true;
});

async function routeMessage(message) {
  if (message.type === "AFTERAI_GENERATE_REVIEW") {
    const result = await generateReview(message.conversation);
    return result;
  }

  if (message.type === "AFTERAI_ARCHIVE_CONVERSATION") {
    const record = await enqueueArchive(message.conversation, null);
    return { recordId: record.id };
  }

  if (message.type === "AFTERAI_MARK_CONCEPT_LEARNED") {
    await setConceptLearned(message.concept, message.learned !== false);
    return await getLearningState();
  }

  if (message.type === "AFTERAI_TOGGLE_FAVORITE_CONCEPT") {
    await setConceptFavorite(message.concept, message.favorite !== false);
    return await getLearningState();
  }

  if (message.type === "AFTERAI_DELETE_CONCEPT") {
    await deleteConcept(message.concept);
    return await getLearningState();
  }

  if (message.type === "AFTERAI_DELETE_RECORD") {
    await deleteRecord(message.recordId);
    return await getLearningState();
  }

  if (message.type === "AFTERAI_UPDATE_RECORD_META") {
    await updateRecordMeta(message.recordId, message.patch);
    return await getLearningState();
  }

  if (message.type === "AFTERAI_IMPORT_RECORDS") {
    return await importRecords(message.records);
  }

  if (message.type === "AFTERAI_EXPORT_STUDY_CARDS") {
    const state = await getLearningState();
    return { markdown: AfterAiShared.exportStudyCards(state.records) };
  }

  if (message.type === "AFTERAI_GET_LEARNING_STATE") {
    return await getLearningState();
  }

  if (message.type === "AFTERAI_GET_SETTINGS") {
    return {
      settings: await getSettings()
    };
  }

  throw new Error(`未知消息类型：${message.type}`);
}

async function generateReview(conversation) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("还没有配置 API Key。请打开扩展设置页填写。");
  }
  if (!settings.baseUrl) {
    throw new Error("还没有配置 base_url。请在设置页填写。");
  }
  if (!settings.model) {
    throw new Error("还没有配置模型名称。请在设置页填写模型。");
  }

  const coachPrompt = AfterAiShared.buildCoachPrompt(conversation || {}, {
    includeAssessment: Boolean(settings.enableAssessment),
    outputLanguage: settings.outputLanguage || "简体中文"
  });
  const body = createRequestBody(settings, coachPrompt.messages);
  const requestUrl = buildRequestUrl(settings);
  const timeoutMs = normalizeTimeout(settings.requestTimeoutMs);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: createHeaders(settings),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`API 请求超时：已等待 ${Math.round(timeoutMs / 1000)} 秒。可以调大超时时间或稍后重试。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API 请求失败：${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = readModelContent(settings.provider, data);
  const parsed = AfterAiShared.extractJsonObject(content);
  const review = AfterAiShared.normalizeCoachPayload(parsed);
  const record = await enqueueArchive(conversation, review);
  return { review, recordId: record.id };
}

function enqueueArchive(conversation, review) {
  archiveQueue = archiveQueue.then(() => archiveConversation(conversation, review));
  return archiveQueue;
}

async function archiveConversation(conversation, review) {
  const now = new Date().toISOString();
  const normalized = normalizeConversation(conversation, now);
  const answerId = AfterAiShared.stableId([
    normalized.url,
    normalized.prompt,
    AfterAiShared.summarizeText(normalized.answer, 1200)
  ].join("\n"));
  const id = review ? normalized.conversationId : answerId;

  const store = await chrome.storage.local.get([STORAGE_KEYS.records]);
  const records = Array.isArray(store[STORAGE_KEYS.records]) ? store[STORAGE_KEYS.records] : [];
  const existingIndex = records.findIndex((record) => record.id === id);
  const existing = existingIndex >= 0 ? records[existingIndex] : {};
  const nextRecord = Object.assign({}, existing, normalized, {
    id,
    updatedAt: now,
    review: review || existing.review || null
  });

  if (!nextRecord.createdAt) nextRecord.createdAt = now;
  if (!nextRecord.day) nextRecord.day = AfterAiShared.dayKey(nextRecord.createdAt);

  if (existingIndex >= 0) {
    records[existingIndex] = nextRecord;
  } else {
    records.unshift(nextRecord);
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.records]: records.slice(0, 500)
  });

  return nextRecord;
}

function normalizeConversation(conversation, fallbackTime) {
  const source = conversation || {};
  const url = String(source.url || "");
  const site = siteFromUrl(url);
  const conversationTitle = cleanTitle(source.title, site);
  return {
    url,
    site,
    pageTitle: String(source.title || ""),
    conversationTitle,
    conversationId: AfterAiShared.stableId(`${site}\n${conversationTitle}\n${url.split(/[?#]/)[0]}`),
    prompt: String(source.prompt || "").trim(),
    answer: String(source.answer || "").trim(),
    promptPreview: AfterAiShared.summarizeText(source.prompt, 120) || "未识别到用户问题",
    answerPreview: AfterAiShared.summarizeText(source.answer, 180),
    createdAt: source.createdAt || fallbackTime,
    day: AfterAiShared.dayKey(source.createdAt || fallbackTime),
    taskKind: AfterAiShared.detectTaskKind(source.prompt, source.answer)
  };
}

function cleanTitle(title, site) {
  const value = String(title || "").replace(/\s+-\s+DeepSeek.*$/i, "").replace(/\s+-\s+Kimi.*$/i, "").trim();
  if (value) return value;
  return site || "未命名会话";
}

function siteFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "unknown";
  }
}

async function setConceptLearned(concept, learned) {
  const normalized = AfterAiShared.normalizeConcept(concept || {});
  const store = await chrome.storage.local.get([STORAGE_KEYS.learnedConcepts]);
  const learnedConcepts = store[STORAGE_KEYS.learnedConcepts] || {};

  if (learned) {
    learnedConcepts[normalized.id] = {
      id: normalized.id,
      name: normalized.name,
      learnedAt: new Date().toISOString()
    };
  } else {
    delete learnedConcepts[normalized.id];
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.learnedConcepts]: learnedConcepts
  });
}

async function setConceptFavorite(concept, favorite) {
  const normalized = AfterAiShared.normalizeConcept(concept || {});
  const store = await chrome.storage.local.get(["afterai.favoriteConcepts"]);
  const favoriteConcepts = store["afterai.favoriteConcepts"] || {};

  if (favorite) {
    favoriteConcepts[normalized.id] = {
      id: normalized.id,
      name: normalized.name,
      favoritedAt: new Date().toISOString()
    };
  } else {
    delete favoriteConcepts[normalized.id];
  }

  await chrome.storage.local.set({
    "afterai.favoriteConcepts": favoriteConcepts
  });
}

async function deleteConcept(concept) {
  const normalized = AfterAiShared.normalizeConcept(concept || {});
  const store = await chrome.storage.local.get([STORAGE_KEYS.records, STORAGE_KEYS.learnedConcepts, "afterai.favoriteConcepts"]);
  const records = Array.isArray(store[STORAGE_KEYS.records]) ? store[STORAGE_KEYS.records] : [];
  const learnedConcepts = store[STORAGE_KEYS.learnedConcepts] || {};
  const favoriteConcepts = store["afterai.favoriteConcepts"] || {};

  records.forEach((record) => {
    if (!record.review || !Array.isArray(record.review.concepts)) return;
    record.review.concepts = record.review.concepts.filter((item) => {
      const itemId = AfterAiShared.normalizeConcept(item).id;
      return itemId !== normalized.id;
    });
  });
  delete learnedConcepts[normalized.id];
  delete favoriteConcepts[normalized.id];

  await chrome.storage.local.set({
    [STORAGE_KEYS.records]: records,
    [STORAGE_KEYS.learnedConcepts]: learnedConcepts,
    "afterai.favoriteConcepts": favoriteConcepts
  });
}

async function deleteRecord(recordId) {
  if (!recordId) return;
  const store = await chrome.storage.local.get([STORAGE_KEYS.records]);
  const records = Array.isArray(store[STORAGE_KEYS.records]) ? store[STORAGE_KEYS.records] : [];
  await chrome.storage.local.set({
    [STORAGE_KEYS.records]: records.filter((record) => record.id !== recordId)
  });
}

async function updateRecordMeta(recordId, patch) {
  if (!recordId || !patch || typeof patch !== "object") return;
  const store = await chrome.storage.local.get([STORAGE_KEYS.records]);
  const records = Array.isArray(store[STORAGE_KEYS.records]) ? store[STORAGE_KEYS.records] : [];
  const index = records.findIndex((record) => record.id === recordId);
  if (index < 0) return;

  const current = records[index];
  const next = Object.assign({}, current);
  if (Object.prototype.hasOwnProperty.call(patch, "selfAbilityScore")) {
    next.selfAbilityScore = normalizeScore(patch.selfAbilityScore);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reviewQualityScore")) {
    next.reviewQualityScore = normalizeScore(patch.reviewQualityScore);
  }
  if (Array.isArray(patch.mistakes)) {
    next.mistakes = patch.mistakes.slice(0, 20).map(normalizeMistake);
  }
  if (patch.addMistake) {
    next.mistakes = (next.mistakes || []).concat(normalizeMistake(patch.addMistake)).slice(0, 20);
  }
  next.updatedAt = new Date().toISOString();
  records[index] = next;
  await chrome.storage.local.set({ [STORAGE_KEYS.records]: records });
}

function normalizeScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.round(parsed), 0), 100);
}

function normalizeMistake(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    id: item.id || AfterAiShared.stableId(`${item.title || item.claim || ""}\n${item.note || item.reason || ""}`),
    title: String(item.title || item.claim || "需要复查的问题"),
    note: String(item.note || item.reason || item.suggested_fix || "复查这个点，并写下正确做法。"),
    createdAt: item.createdAt || new Date().toISOString()
  };
}

async function getLearningState() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.records, STORAGE_KEYS.learnedConcepts, "afterai.favoriteConcepts"]);
  const records = Array.isArray(store[STORAGE_KEYS.records]) ? store[STORAGE_KEYS.records] : [];
  const learnedConcepts = store[STORAGE_KEYS.learnedConcepts] || {};
  const favoriteConcepts = store["afterai.favoriteConcepts"] || {};
  return {
    records,
    learnedConcepts,
    favoriteConcepts,
    learningMap: AfterAiShared.buildConversationMap(records, learnedConcepts)
  };
}

async function importRecords(records) {
  const incoming = Array.isArray(records) ? records.map(normalizeImportedRecord).filter(Boolean) : [];
  if (!incoming.length) return { importedCount: 0 };

  const store = await chrome.storage.local.get([STORAGE_KEYS.records]);
  const existing = Array.isArray(store[STORAGE_KEYS.records]) ? store[STORAGE_KEYS.records] : [];
  const byId = new Map(existing.map((record) => [record.id, record]));

  incoming.forEach((record) => {
    byId.set(record.id, Object.assign({}, byId.get(record.id) || {}, record, {
      updatedAt: new Date().toISOString()
    }));
  });

  const merged = Array.from(byId.values()).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  await chrome.storage.local.set({
    [STORAGE_KEYS.records]: merged.slice(0, 500)
  });

  return { importedCount: incoming.length };
}

function normalizeImportedRecord(record) {
  if (!record || typeof record !== "object") return null;
  const now = new Date().toISOString();
  const createdAt = record.createdAt || now;
  const prompt = String(record.prompt || "").trim();
  const answer = String(record.answer || "").trim();
  if (!prompt && !answer && !record.review) return null;

  const url = String(record.url || "local-agent://task");
  const site = String(record.site || siteFromUrl(url) || "local-agent");
  const conversationTitle = String(record.conversationTitle || record.pageTitle || "本地 Agent 任务");
  const conversationId = String(record.conversationId || AfterAiShared.stableId(`${site}\n${conversationTitle}\n${url}`));
  const id = String(record.id || AfterAiShared.stableId(`${conversationId}\n${prompt}\n${AfterAiShared.summarizeText(answer, 1200)}`));

  return {
    id,
    url,
    site,
    pageTitle: String(record.pageTitle || conversationTitle),
    conversationTitle,
    conversationId,
    prompt,
    answer,
    promptPreview: String(record.promptPreview || AfterAiShared.summarizeText(prompt, 120) || "本地 Agent 任务"),
    answerPreview: String(record.answerPreview || AfterAiShared.summarizeText(answer, 180)),
    createdAt,
    updatedAt: record.updatedAt || createdAt,
    day: record.day || AfterAiShared.dayKey(createdAt),
    taskKind: record.taskKind || AfterAiShared.detectTaskKind(prompt, answer),
    selfAbilityScore: typeof record.selfAbilityScore === "number" ? normalizeScore(record.selfAbilityScore) : null,
    reviewQualityScore: typeof record.reviewQualityScore === "number" ? normalizeScore(record.reviewQualityScore) : null,
    mistakes: Array.isArray(record.mistakes) ? record.mistakes.map(normalizeMistake) : [],
    review: record.review ? AfterAiShared.normalizeCoachPayload(record.review) : null
  };
}

function createHeaders(settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings.provider === "gemini") {
    headers["x-goog-api-key"] = settings.apiKey;
    return headers;
  }
  if (settings.provider === "claude") {
    headers["x-api-key"] = settings.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function createRequestBody(settings, messages) {
  if (settings.provider === "gemini") {
    return {
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      })),
      generationConfig: {
        responseMimeType: "application/json"
      }
    };
  }

  if (settings.provider === "claude") {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const userText = messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n");
    return {
      model: settings.model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: userText }]
    };
  }

  if (settings.provider === "cohere") {
    return {
      model: settings.model,
      messages: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      })),
      temperature: 0.2
    };
  }

  return {
    model: settings.model,
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" }
  };
}

function readModelContent(provider, data) {
  if (provider === "gemini") {
    return data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map((part) => part.text || "").join("");
  }

  if (provider === "claude") {
    return data && Array.isArray(data.content) &&
      data.content.map((part) => part && part.text ? part.text : "").join("");
  }

  if (provider === "cohere") {
    if (data && data.message && Array.isArray(data.message.content)) {
      return data.message.content.map((part) => part && part.text ? part.text : "").join("");
    }
    return data && data.text;
  }

  return data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
}

function readableError(error) {
  return error && error.message ? error.message : String(error);
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60000;
  return Math.min(Math.max(parsed, 5000), 300000);
}

async function getSettings() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS).concat(["endpoint"]));
  const settings = Object.assign({}, DEFAULT_SETTINGS, raw);
  settings.baseUrl = String(settings.baseUrl || raw.endpoint || "").trim();
  settings.provider = normalizeProvider(settings.provider);
  return settings;
}

function normalizeProvider(provider) {
  if (["openai", "gemini", "claude", "tgi", "cohere"].includes(provider)) return provider;
  if (["openai-compatible", "deepseek", "dashscope"].includes(provider)) return "openai";
  return "openai";
}

function buildRequestUrl(settings) {
  const original = String(settings.baseUrl || "").trim();
  const baseUrl = original.replace(/\/+$/, "");

  if (settings.provider === "gemini") {
    if (/generateContent(?:\?|$)/.test(baseUrl)) return original;
    return `${baseUrl}/models/${encodeURIComponent(settings.model)}:generateContent`;
  }
  if (settings.provider === "claude") {
    if (/\/v1\/messages(?:\?|$)/.test(baseUrl)) return original;
    return `${baseUrl}/v1/messages`;
  }
  if (settings.provider === "cohere") {
    if (/\/v2\/chat(?:\?|$)/.test(baseUrl)) return original;
    return `${baseUrl}/v2/chat`;
  }
  if (settings.provider === "openai" || settings.provider === "tgi") {
    if (/\/chat\/completions(?:\?|$)/.test(baseUrl)) return original;
    return `${baseUrl}/chat/completions`;
  }
  return original;
}
