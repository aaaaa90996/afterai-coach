(function () {
  const PANEL_CLASS = "afterai-coach-panel";
  const BUTTON_CLASS = "afterai-coach-button";
  const STATE = {
    busy: false,
    observer: null,
    scanTimer: null,
    autoReadIds: new Set(),
    autoConversationIds: new Set(),
    conversationReviewTimers: new Map(),
    stableTimers: new WeakMap(),
    toast: null,
    pageWidgetsHidden: false
  };

  boot();

  function boot() {
    installObserver();
    installMessageBridge();
    installSettingsListener();
    loadPageWidgetPreference();
    scheduleScan();
  }

  async function loadPageWidgetPreference() {
    const settings = await getSettings();
    STATE.pageWidgetsHidden = Boolean(settings.pageWidgetsHidden);
    if (STATE.pageWidgetsHidden) {
      removePageWidgets();
    } else {
      installFallbackDock();
    }
  }

  function installSettingsListener() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.pageWidgetsHidden) return;
      STATE.pageWidgetsHidden = Boolean(changes.pageWidgetsHidden.newValue);
      if (STATE.pageWidgetsHidden) {
        removePageWidgets();
      } else {
        installFallbackDock();
      }
    });
  }

  function installMessageBridge() {
    if (window.__afterAiCoachBridgeInstalled) return;
    window.__afterAiCoachBridgeInstalled = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "AFTERAI_PAGE_DIAGNOSTIC") return false;
      const messages = findAssistantMessages();
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        assistantCount: messages.length,
        dockVisible: Boolean(document.querySelector(".afterai-fallback-dock")),
        bodyTextLength: getVisibleText(document.body).length,
        sample: messages[0] ? getVisibleText(messages[0]).slice(0, 240) : ""
      });
      return true;
    });
  }

  function installObserver() {
    if (STATE.observer) return;
    STATE.observer = new MutationObserver(scheduleScan);
    STATE.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function scheduleScan() {
    window.clearTimeout(STATE.scanTimer);
    STATE.scanTimer = window.setTimeout(scanMessages, 800);
  }

  function scanMessages() {
    findAssistantMessages().forEach((message) => {
      if (!message || message.querySelector(`.${BUTTON_CLASS}`)) return;
      injectButton(message);
    });
  }

  function findAssistantMessages() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"][data-testid*="assistant"]',
      '[data-testid*="assistant"]',
      "message-content",
      '[id^="model-response-message-content"]',
      ".model-response-text",
      "model-response",
      '[class*="model-response"]',
      '[class*="font-claude-message"]',
      '[class*="claude"] [class*="message"]',
      '[class*="response-content"]',
      '[class*="message-content"]',
      '[class*="message_text_content"]',
      ".flow-markdown-body",
      ".ds-markdown",
      ".markdown",
      ".markdown-body",
      ".markdown-content",
      ".prose",
      '[class*="segment-content"]',
      '[class*="markdown"]',
      '[class*="assistant"]',
      '[class*="bot"]',
      '[class*="answer"]',
      '[class*="response"]',
      '[class*="ds-markdown"]',
      "article"
    ];

    const candidates = [];
    selectors.forEach((selector, priority) => {
      queryAll(selector).forEach((node) => {
        const text = getVisibleText(node);
        if (isCapturableCandidate(node, text)) {
          candidates.push({ node, textLength: text.length, priority });
        }
      });
    });

    if (!candidates.length) {
      findLargeTextBlocks().forEach((node) => {
        candidates.push({ node, textLength: getVisibleText(node).length, priority: selectors.length + 10 });
      });
    }

    return selectBestMessageNodes(candidates);
  }

  function isCapturableCandidate(node, text) {
    if (!node || !text || text.length <= 120) return false;
    if (text.length > 30000) return false;
    if (node.closest(`.${PANEL_CLASS}`) || node.closest(".afterai-coach-actions")) return false;
    if (node.matches && node.matches("html, body")) return false;
    if (node.matches && node.matches("main, [role='main']") && text.length > 1500) return false;
    if (isThinkingOrStreamingNode(node, text)) return false;
    if (/^(复制|重新生成|分享|点赞|点踩|\s)+$/.test(text)) return false;
    return true;
  }

  function isThinkingOrStreamingNode(node, text) {
    const label = [
      node.id || "",
      node.className || "",
      node.getAttribute && node.getAttribute("aria-label") || "",
      node.getAttribute && node.getAttribute("data-testid") || "",
      node.getAttribute && node.getAttribute("data-state") || ""
    ].join(" ").toLowerCase();
    if (/thinking|reasoning|thought|streaming|loading|pending|generating|spinner|skeleton/.test(label)) return true;
    if (node.closest && node.closest("[aria-busy='true'], [data-is-streaming='true'], [data-streaming='true']")) return true;
    if (/^(思考中|正在思考|正在生成|thinking|reasoning|generating)/i.test(text.trim())) return true;
    return false;
  }

  function selectBestMessageNodes(candidates) {
    const unique = [];
    candidates.forEach((candidate) => {
      if (!unique.some((item) => item.node === candidate.node)) unique.push(candidate);
    });

    const filtered = unique.filter((candidate) => {
      return !unique.some((other) => {
        if (other.node === candidate.node) return false;
        if (!candidate.node.contains(other.node)) return false;
        if (!isBetterNestedCandidate(candidate, other)) return false;
        return true;
      });
    });

    return filtered
      .sort((a, b) => documentPositionSort(a.node, b.node))
      .map((candidate) => candidate.node);
  }

  function isBetterNestedCandidate(parent, child) {
    if (child.priority < parent.priority) return true;
    if (child.textLength >= parent.textLength * 0.55) return true;
    if (parent.textLength - child.textLength < 600) return true;
    return false;
  }

  function documentPositionSort(a, b) {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function findLargeTextBlocks() {
    const blocks = queryAll("main div, main section, main article, [role='main'] div, [role='main'] section, model-response, message-content")
      .filter((node) => {
        if (node.closest(`.${PANEL_CLASS}`) || node.closest(".afterai-coach-actions")) return false;
        const text = getVisibleText(node);
        if (text.length < 180 || text.length > 12000) return false;
        const childText = Array.from(node.children || []).reduce((total, child) => total + getVisibleText(child).length, 0);
        return childText < text.length * 1.45;
      });

    return blocks.slice(-6);
  }

  function dedupeNodes(nodes) {
    return nodes.filter((node, index) => {
      if (nodes.indexOf(node) !== index) return false;
      if (node.matches && node.matches(".ds-markdown, .markdown, .markdown-body, .prose, message-content, [class*='segment-content'], [class*='model-response']")) return true;
      return !nodes.some((other) => other !== node && other.contains(node));
    });
  }

  function injectButton(message) {
    const actions = document.createElement("div");
    actions.className = "afterai-coach-actions";

    const button = document.createElement("button");
    button.className = BUTTON_CLASS;
    button.type = "button";
    button.textContent = "复盘";
    button.title = "把这轮 AI 回答拆成学习步骤、知识点和微练习";

    button.addEventListener("click", async () => {
      if (STATE.busy) return;
      await generateReview(message, button);
    });

    actions.appendChild(button);
    message.appendChild(actions);
    scheduleStableProcessing(message, button);
  }

  function scheduleStableProcessing(message, button) {
    const existing = STATE.stableTimers.get(message);
    if (existing) window.clearTimeout(existing);

    const firstText = getMessageTextWithoutCoachUi(message);
    const timer = window.setTimeout(async () => {
      const latestText = getMessageTextWithoutCoachUi(message);
      if (latestText !== firstText) {
        scheduleStableProcessing(message, button);
        return;
      }
      await archiveDetectedConversation(message);
      await maybeAutoRead(message, button);
    }, 4200);
    STATE.stableTimers.set(message, timer);
  }

  function installFallbackDock() {
    if (STATE.pageWidgetsHidden) return;
    if (document.querySelector(".afterai-fallback-dock")) return;
    const dock = document.createElement("aside");
    dock.className = "afterai-fallback-dock";

    const capture = document.createElement("button");
    capture.type = "button";
    capture.textContent = "保存最后回答";
    capture.title = "当页面没有显示复盘按钮时，尝试捕获页面最后一段 AI 回答";
    capture.addEventListener("click", async () => {
      const target = findLastCapturableBlock();
      if (!target) {
        showToast("没有找到可保存的回答。");
        return;
      }
      await archiveDetectedConversation(target);
      if (!target.querySelector(`.${BUTTON_CLASS}`)) injectButton(target);
    });

    const map = document.createElement("button");
    map.type = "button";
    map.textContent = "学习地图";
    map.addEventListener("click", () => {
      window.open(chrome.runtime.getURL("src/dashboard.html"), "_blank");
    });

    dock.append(capture, map);
    document.documentElement.appendChild(dock);
  }

  function removePageWidgets() {
    document.querySelectorAll(".afterai-fallback-dock, .afterai-coach-toast").forEach((node) => node.remove());
    STATE.toast = null;
  }

  function findLastCapturableBlock() {
    const messages = findAssistantMessages();
    if (messages.length) return messages[messages.length - 1];
    const blocks = findLargeTextBlocks();
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  async function archiveDetectedConversation(message) {
    const conversation = collectConversation(message);
    if (!conversation.answer || conversation.answer.length < 80) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "AFTERAI_ARCHIVE_CONVERSATION",
        conversation
      });
      if (response && response.ok) {
        showToast("已保存到学习地图。", { autoClose: 2200 });
      }
    } catch (_) {
      // Raw archiving is best-effort and should not disturb the chat page.
    }
  }

  async function maybeAutoRead(message, button) {
    try {
      const conversation = collectConversation(message);
      if (!conversation.answer || conversation.answer.length < 80) return;

      const settings = await getSettings();
      if (!settings.autoRead) return;
      const reviewMode = normalizeReviewMode(settings.reviewMode);
      if (reviewMode === "manual") return;

      if (reviewMode === "answer") {
        await maybeAutoReadAnswer(message, button, conversation);
        return;
      }

      scheduleConversationReview(message, button, conversation);
    } catch (error) {
      updateToast(showToast("自动读取没有成功，可以手动点击复盘。"), error && error.message ? error.message : "自动读取没有成功，可以手动点击复盘。");
    }
  }

  async function maybeAutoReadAnswer(message, button, conversation) {
    const autoId = AfterAiShared.stableId(`${conversation.url}\n${conversation.prompt}\n${conversation.answer.slice(0, 1000)}`);
    if (STATE.autoReadIds.has(autoId)) return;
    STATE.autoReadIds.add(autoId);
    await generateReview(message, button, { auto: true });
  }

  function scheduleConversationReview(message, button, conversation) {
    if (findLastCapturableBlock() !== message) return;

    const conversationAutoId = getConversationAutoId(conversation);
    if (STATE.autoConversationIds.has(conversationAutoId)) return;

    const existing = STATE.conversationReviewTimers.get(conversationAutoId);
    if (existing) window.clearTimeout(existing);

    const timer = window.setTimeout(async () => {
      if (STATE.autoConversationIds.has(conversationAutoId)) return;
      if (findLastCapturableBlock() !== message) return;
      STATE.autoConversationIds.add(conversationAutoId);
      await generateReview(message, button, { auto: true });
    }, 18000);
    STATE.conversationReviewTimers.set(conversationAutoId, timer);
  }

  function getConversationAutoId(conversation) {
    try {
      const url = new URL(conversation.url || location.href);
      return AfterAiShared.stableId(`${url.hostname}\n${conversation.title || ""}\n${url.pathname}`);
    } catch (_) {
      return AfterAiShared.stableId(`${conversation.url || location.href}\n${conversation.title || ""}`);
    }
  }

  function normalizeReviewMode(mode) {
    if (["conversation", "manual", "answer"].includes(mode)) return mode;
    return "conversation";
  }

  async function getSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "AFTERAI_GET_SETTINGS" });
      return response && response.ok && response.settings ? response.settings : {};
    } catch (_) {
      return {};
    }
  }

  async function generateReview(message, button, options) {
    const conversation = collectConversation(message);
    if (!conversation.answer) {
      showPanel(message, { error: "没有读到这轮 AI 回答。可以等页面生成完成后再试一次。" });
      return;
    }

    STATE.busy = true;
    button.disabled = true;
    button.textContent = "复盘生成中...";
    const toast = options && options.auto ? showToast("正在自动读取这条 AI 回答，并生成学习复盘。") : null;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "AFTERAI_GENERATE_REVIEW",
        conversation
      });

      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "生成失败。");
      }

      showPanel(message, { review: response.review, recordId: response.recordId });
      button.textContent = "已生成复盘";
      if (toast) updateToast(toast, "已生成复盘，并保存到学习地图。");
    } catch (error) {
      showPanel(message, { error: error && error.message ? error.message : String(error) });
      button.textContent = "重新生成复盘";
      button.disabled = false;
      if (toast) updateToast(toast, "自动读取失败，可以手动重试。");
    } finally {
      STATE.busy = false;
    }
  }

  function collectConversation(assistantNode) {
    const answer = getMessageTextWithoutCoachUi(assistantNode);
    const userPrompt = findNearestUserPrompt(assistantNode);
    return {
      url: location.href,
      title: document.title,
      prompt: userPrompt,
      answer
    };
  }

  function findNearestUserPrompt(assistantNode) {
    const userNodes = queryAll('[data-message-author-role="user"], user-query, [class*="user-query"]');
    const explicitBefore = userNodes
      .filter((node) => node.compareDocumentPosition(assistantNode) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map((node) => getVisibleText(node))
      .filter((text) => text.length > 8);
    if (explicitBefore.length) return explicitBefore[explicitBefore.length - 1];

    const allNodes = queryAll([
      '[data-message-author-role="user"]',
      "user-query",
      '[data-testid*="conversation-turn"]',
      '[class*="user-query"]',
      '[class*="user-query-content"]',
      '[class*="user-message"]',
      '[class*="human"]',
      '[class*="input-content"]',
      '[class*="query-content"]',
      '[class*="ds-message"]',
      '[class*="user"]',
      '[class*="question"]',
      '[class*="query"]',
      "article",
      ".group"
    ].join(","));

    const before = allNodes
      .filter((node) => node.compareDocumentPosition(assistantNode) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map((node) => getVisibleText(node))
      .filter((text) => text.length > 8 && !/教我这次任务|复盘|复盘生成中|AfterAI Coach/.test(text));

    return before.length ? before[before.length - 1] : "";
  }

  function getMessageTextWithoutCoachUi(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(`.${BUTTON_CLASS}, .${PANEL_CLASS}, .afterai-coach-actions`).forEach((child) => child.remove());
    return getVisibleText(clone);
  }

  function showPanel(message, result) {
    const existing = message.querySelector(`.${PANEL_CLASS}`);
    if (existing) existing.remove();

    const panel = document.createElement("details");
    panel.className = PANEL_CLASS;

    if (result.error) {
      panel.open = true;
      panel.appendChild(createHeader("复盘没有生成出来"));
      const error = document.createElement("p");
      error.className = "afterai-coach-error";
      error.textContent = result.error;
      panel.appendChild(error);
      message.appendChild(panel);
      return;
    }

    const review = result.review;
    const recordId = result.recordId || "";
    panel.appendChild(createHeader(review.title || "这次任务的学习复盘"));
    panel.appendChild(renderList("完成了什么", review.what_was_done));
    panel.appendChild(renderSteps(review.ai_steps || []));
    if (review.assessment) {
      panel.appendChild(renderAssessment(review.assessment));
    }
    panel.appendChild(renderConcepts(review.concepts || [], recordId));
    panel.appendChild(renderPractice(review.practice || {}));
    panel.appendChild(renderQuiz(review.quiz || []));

    if (review.next_time_try) {
      panel.appendChild(renderCallout("下次先试这一小块", review.next_time_try));
    }
    if (review.encouragement) {
      panel.appendChild(renderCallout("一句提醒", review.encouragement));
    }
    panel.appendChild(renderReflectionControls(recordId, review));

    message.appendChild(panel);
  }

  function createHeader(title) {
    const header = document.createElement("summary");
    header.className = "afterai-coach-header";
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "AfterAI Coach";
    const h3 = document.createElement("h3");
    h3.textContent = title;
    header.append(eyebrow, h3);
    return header;
  }

  function renderList(title, items) {
    const section = createSection(title);
    const list = document.createElement("ul");
    (items || []).forEach((item) => {
      const li = document.createElement("li");
      li.textContent = String(item);
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  function renderSteps(steps) {
    const section = createSection("AI 是怎么做的");
    const list = document.createElement("ol");
    steps.forEach((item) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = item.step || "关键步骤";
      const p = document.createElement("p");
      p.textContent = item.why || "";
      li.append(strong, p);
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  function renderConcepts(concepts, recordId) {
    const section = createSection("需要补的知识");
    const list = document.createElement("div");
    list.className = "afterai-concepts";
    concepts.forEach((item) => {
      const row = document.createElement("div");
      row.className = "afterai-concept";
      const badge = document.createElement("span");
      badge.textContent = item.levelLabel || levelLabel(item.level);
      const text = document.createElement("div");
      text.className = "afterai-concept-copy";
      const title = document.createElement("strong");
      title.textContent = item.name || "知识点";
      const why = document.createElement("p");
      why.textContent = item.why_it_matters || "";
      const how = document.createElement("p");
      how.className = "afterai-coach-muted";
      how.textContent = item.how_to_learn ? `怎么学：${item.how_to_learn}` : "";
      text.append(title, why, how);

      const learned = document.createElement("button");
      learned.type = "button";
      learned.className = "afterai-learned-button";
      learned.textContent = "已学会";
      learned.addEventListener("click", async () => {
        learned.disabled = true;
        learned.textContent = "已放入已学会";
        row.classList.add("is-learned");
        await chrome.runtime.sendMessage({
          type: "AFTERAI_MARK_CONCEPT_LEARNED",
          concept: Object.assign({}, item, { recordId }),
          learned: true
        });
      });

      const favorite = document.createElement("button");
      favorite.type = "button";
      favorite.className = "afterai-favorite-button";
      favorite.textContent = "收藏";
      favorite.addEventListener("click", async () => {
        favorite.disabled = true;
        favorite.textContent = "已收藏";
        row.classList.add("is-favorite");
        await chrome.runtime.sendMessage({
          type: "AFTERAI_TOGGLE_FAVORITE_CONCEPT",
          concept: Object.assign({}, item, { recordId }),
          favorite: true
        });
      });

      const actions = document.createElement("div");
      actions.className = "afterai-concept-actions";
      actions.append(favorite, learned);

      row.append(badge, text, actions);
      list.appendChild(row);
    });
    section.appendChild(list);
    return section;
  }

  function renderPractice(practice) {
    const section = createSection("今天的小练习");
    const p = document.createElement("p");
    p.textContent = `${practice.timebox || "10分钟"}：${practice.task || "选一个小部分自己重做一次。"}`;
    const check = document.createElement("p");
    check.className = "afterai-coach-muted";
    check.textContent = practice.success_check ? `完成标准：${practice.success_check}` : "";
    section.append(p, check);
    return section;
  }

  function renderAssessment(assessment) {
    const section = createSection("客观评判");
    const verdict = document.createElement("p");
    verdict.className = `afterai-assessment afterai-assessment-${assessment.verdict || "unknown"}`;
    verdict.textContent = `${assessmentLabel(assessment.verdict)}：${assessment.summary || "没有明确判断。"}`;
    section.appendChild(verdict);

    (assessment.checks || []).forEach((item) => {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${judgmentLabel(item.judgment)}：${item.claim || "需要检查的说法"}`;
      const reason = document.createElement("p");
      reason.textContent = item.reason || "";
      details.append(summary, reason);
      if (item.suggested_fix) {
        const fix = document.createElement("p");
        fix.className = "afterai-coach-muted";
        fix.textContent = `建议修正：${item.suggested_fix}`;
        details.appendChild(fix);
      }
      section.appendChild(details);
    });

    if (assessment.caveat) {
      const caveat = document.createElement("p");
      caveat.className = "afterai-coach-muted";
      caveat.textContent = assessment.caveat;
      section.appendChild(caveat);
    }
    return section;
  }

  function renderReflectionControls(recordId, review) {
    const section = createSection("把这次变成能力");
    const ability = document.createElement("div");
    ability.className = "afterai-reflection-grid";
    ability.appendChild(renderScoreButtons("如果没有 AI，你能完成多少？", [0, 25, 50, 75, 100], async (score, button) => {
      await updateRecordMeta(recordId, { selfAbilityScore: score });
      markButtonGroup(button, `已记录 ${score}%`);
    }));
    ability.appendChild(renderScoreButtons("这份复盘有多有用？", [20, 40, 60, 80, 100], async (score, button) => {
      await updateRecordMeta(recordId, { reviewQualityScore: score });
      markButtonGroup(button, "已评分");
    }));
    section.appendChild(ability);

    const mistakes = assessmentMistakes(review.assessment);
    if (mistakes.length) {
      const list = document.createElement("div");
      list.className = "afterai-mistake-list";
      mistakes.forEach((mistake) => {
        const row = document.createElement("div");
        const copy = document.createElement("p");
        copy.textContent = mistake.title;
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "加入错题本";
        add.addEventListener("click", async () => {
          add.disabled = true;
          await updateRecordMeta(recordId, { addMistake: mistake });
          add.textContent = "已加入";
        });
        row.append(copy, add);
        list.appendChild(row);
      });
      section.appendChild(list);
    }
    return section;
  }

  function renderScoreButtons(title, scores, onSelect) {
    const box = document.createElement("div");
    box.className = "afterai-score-box";
    const label = document.createElement("strong");
    label.textContent = title;
    const row = document.createElement("div");
    scores.forEach((score) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${score}%`;
      button.addEventListener("click", () => onSelect(score, button));
      row.appendChild(button);
    });
    box.append(label, row);
    return box;
  }

  function markButtonGroup(button, label) {
    Array.from(button.parentElement.children).forEach((item) => {
      item.disabled = true;
      item.classList.remove("is-selected");
    });
    button.classList.add("is-selected");
    button.textContent = label;
  }

  function assessmentMistakes(assessment) {
    if (!assessment || !Array.isArray(assessment.checks)) return [];
    return assessment.checks
      .filter((item) => item.judgment === "wrong" || item.judgment === "questionable")
      .slice(0, 4)
      .map((item) => ({
        title: item.claim || "AI 回答里有一个需要复查的点",
        note: item.suggested_fix || item.reason || "复查这个说法，并写下正确做法。"
      }));
  }

  async function updateRecordMeta(recordId, patch) {
    if (!recordId) return;
    await chrome.runtime.sendMessage({
      type: "AFTERAI_UPDATE_RECORD_META",
      recordId,
      patch
    });
  }

  function renderQuiz(quiz) {
    const section = createSection("微测试");
    quiz.forEach((item) => {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = item.question || "问题";
      const answer = document.createElement("p");
      answer.textContent = item.answer || "";
      details.append(summary, answer);
      section.appendChild(details);
    });
    return section;
  }

  function renderCallout(title, text) {
    const section = createSection(title);
    const p = document.createElement("p");
    p.textContent = text;
    section.appendChild(p);
    return section;
  }

  function createSection(title) {
    const section = document.createElement("section");
    section.className = "afterai-coach-section";
    const h4 = document.createElement("h4");
    h4.textContent = title;
    section.appendChild(h4);
    return section;
  }

  function levelLabel(level) {
    if (level === "today") return "今天";
    if (level === "practice") return "练几次";
    if (level === "later") return "以后";
    return "知识";
  }

  function assessmentLabel(verdict) {
    if (verdict === "reliable") return "整体可靠";
    if (verdict === "mixed") return "部分可疑";
    if (verdict === "risky") return "风险较高";
    return "无法确认";
  }

  function judgmentLabel(judgment) {
    if (judgment === "supported") return "有依据";
    if (judgment === "questionable") return "可疑";
    if (judgment === "wrong") return "可能错误";
    return "待查证";
  }

  function getVisibleText(node) {
    return (node && node.innerText ? node.innerText : "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function queryAll(selector, root) {
    const start = root || document;
    const results = [];
    try {
      results.push(...Array.from(start.querySelectorAll(selector)));
    } catch (_) {
      return results;
    }

    const elements = start.querySelectorAll ? Array.from(start.querySelectorAll("*")) : [];
    elements.forEach((element) => {
      if (element.shadowRoot) {
        results.push(...queryAll(selector, element.shadowRoot));
      }
    });
    return Array.from(new Set(results));
  }

  function showToast(message, options) {
    if (STATE.pageWidgetsHidden) return null;
    if (STATE.toast) STATE.toast.remove();
    const toast = document.createElement("aside");
    toast.className = "afterai-coach-toast";
    const text = document.createElement("p");
    text.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => toast.remove());
    toast.append(text, close);
    document.documentElement.appendChild(toast);
    STATE.toast = toast;
    if (options && options.autoClose) {
      window.setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, options.autoClose);
    }
    return toast;
  }

  function updateToast(toast, message) {
    const text = toast && toast.querySelector("p");
    if (text) text.textContent = message;
    window.setTimeout(() => {
      if (toast && toast.isConnected) toast.remove();
    }, 4200);
  }
})();
