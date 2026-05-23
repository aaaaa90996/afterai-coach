const timeline = document.querySelector("#timeline");
const empty = document.querySelector("#empty");
const refresh = document.querySelector("#refresh");
const statDays = document.querySelector("#stat-days");
const statPending = document.querySelector("#stat-pending");
const statLearned = document.querySelector("#stat-learned");
const statFavorites = document.querySelector("#stat-favorites");
const search = document.querySelector("#search");
const statusFilter = document.querySelector("#status-filter");
const levelFilter = document.querySelector("#level-filter");

refresh.addEventListener("click", render);
search.addEventListener("input", render);
statusFilter.addEventListener("change", render);
levelFilter.addEventListener("change", render);
render();

async function render() {
  const state = await chrome.runtime.sendMessage({ type: "AFTERAI_GET_LEARNING_STATE" });
  if (!state || !state.ok) return;

  const days = state.learningMap || [];
  const favoriteConcepts = state.favoriteConcepts || {};
  const totals = days.reduce((acc, day) => {
    acc.pending += day.pendingCount;
    acc.learned += day.learnedCount;
    return acc;
  }, { pending: 0, learned: 0 });

  statDays.textContent = String(days.length);
  statPending.textContent = String(totals.pending);
  statLearned.textContent = String(totals.learned);
  statFavorites.textContent = String(Object.keys(favoriteConcepts).length);
  empty.hidden = days.length > 0;
  markFavorites(days, favoriteConcepts);
  const filteredDays = applyFilters(days);
  timeline.replaceChildren(...filteredDays.map((day, index) => renderDay(day, index === 0)));
  empty.hidden = days.length > 0;
  if (days.length > 0 && filteredDays.length === 0) {
    const noMatch = document.createElement("div");
    noMatch.className = "empty";
    const title = document.createElement("h3");
    title.textContent = "没有匹配的学习点";
    const copy = document.createElement("p");
    copy.textContent = "换一个关键词、状态或层级筛选试试。";
    noMatch.append(title, copy);
    timeline.appendChild(noMatch);
  }
}

function applyFilters(days) {
  const keyword = search.value.trim().toLowerCase();
  const status = statusFilter.value;
  const level = levelFilter.value;
  const hasFilter = Boolean(keyword) || status !== "all" || level !== "all";

  return days.map((day) => {
    const filterConcepts = (concepts) => concepts.filter((concept) => {
      if (status === "pending" && concept.learned) return false;
      if (status === "learned" && !concept.learned) return false;
      if (status === "favorite" && !concept.favorite) return false;
      if (level !== "all" && concept.level !== level) return false;
      if (keyword) {
        const haystack = [
          concept.name,
          concept.why_it_matters,
          concept.how_to_learn,
          concept.recordTitles && concept.recordTitles.join(" ")
        ].join(" ").toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });

    const sessions = (day.sessions || []).map((session) => {
      const concepts = filterConcepts(session.concepts || []);
      const learnedCount = concepts.filter((concept) => concept.learned).length;
      return Object.assign({}, session, {
        concepts,
        learnedCount,
        pendingCount: concepts.length - learnedCount
      });
    }).filter((session) => session.concepts.length || (!hasFilter && session.records.length));

    const concepts = filterConcepts(day.concepts || []);

    const learnedCount = concepts.filter((concept) => concept.learned).length;
    return Object.assign({}, day, {
      concepts,
      sessions,
      learnedCount,
      pendingCount: concepts.length - learnedCount
    });
  }).filter((day) => day.sessions.length);
}

function renderDay(day, open) {
  const details = document.createElement("details");
  details.className = "day";
  details.open = open;

  const summary = document.createElement("summary");
  const date = document.createElement("div");
  date.className = "date";
  date.textContent = day.day.slice(5);

  const title = document.createElement("div");
  title.className = "day-title";
  const strong = document.createElement("strong");
  strong.textContent = day.pendingCount > 0 ? "今天还有知识点可以捞回来" : "这天的知识点都已收进能力库";
  const subtitle = document.createElement("span");
  subtitle.textContent = `${(day.sessions || []).length} 个会话，${day.records.length} 轮对话，${day.concepts.length} 个学习点`;
  title.append(strong, subtitle);

  const meter = document.createElement("div");
  meter.className = "meter";
  const pending = document.createElement("span");
  pending.className = "pending";
  pending.textContent = `${day.pendingCount} 待学习`;
  const learned = document.createElement("span");
  learned.className = "learned";
  learned.textContent = `${day.learnedCount} 已学会`;
  meter.append(pending, learned);

  summary.append(date, title, meter);

  const body = document.createElement("div");
  body.className = "day-body";
  body.append(renderSessions(day.sessions || []));

  details.append(summary, body);
  return details;
}

function renderSessions(sessions) {
  const list = document.createElement("section");
  list.className = "session-list";

  if (!sessions.length) {
    const emptyLine = document.createElement("p");
    emptyLine.textContent = "这天还没有会话记录。";
    list.appendChild(emptyLine);
    return list;
  }

  sessions.forEach((session, index) => {
    const details = document.createElement("details");
    details.className = "session";
    details.open = index === 0;

    const summary = document.createElement("summary");
    const title = document.createElement("div");
    title.className = "session-title";
    const strong = document.createElement("strong");
    strong.textContent = `${session.site} · ${session.title}`;
    const meta = document.createElement("span");
    meta.textContent = `${session.records.length} 轮对话，${session.concepts.length} 个学习点`;
    title.append(strong, meta);

    const meter = document.createElement("div");
    meter.className = "meter";
    const pending = document.createElement("span");
    pending.className = "pending";
    pending.textContent = `${session.pendingCount} 待学习`;
    const learned = document.createElement("span");
    learned.className = "learned";
    learned.textContent = `${session.learnedCount} 已学会`;
    meter.append(pending, learned);

    summary.append(title, meter);

    const body = document.createElement("div");
    body.className = "session-body";
    body.append(renderConcepts(session.concepts), renderRecords(session.records));

    details.append(summary, body);
    list.appendChild(details);
  });

  return list;
}

function renderConcepts(concepts) {
  const list = document.createElement("section");
  list.className = "concept-list";

  if (!concepts.length) {
    const emptyLine = document.createElement("p");
    emptyLine.textContent = "这天还没有生成复盘。点击 AI 回答下方的“教我这次任务”就能补上。";
    list.appendChild(emptyLine);
    return list;
  }

  concepts.forEach((concept) => {
    const row = document.createElement("article");
    row.className = [
      "concept",
      concept.learned ? "is-learned" : "",
      concept.favorite ? "is-favorite" : ""
    ].filter(Boolean).join(" ");

    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = concept.name;
    if (concept.occurrenceCount > 1) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `出现 ${concept.occurrenceCount} 次`;
      title.appendChild(count);
    }
    const why = document.createElement("p");
    why.textContent = concept.why_it_matters || "这个点出现在你的 AI 任务里，值得补一下。";
    const how = document.createElement("p");
    how.textContent = `怎么学：${concept.how_to_learn || "找一个小例子自己复做一遍。"}`;
    const source = document.createElement("small");
    const sourceNames = concept.recordTitles && concept.recordTitles.length
      ? concept.recordTitles.slice(0, 3).join(" / ")
      : concept.recordTitle || "一次 AI 任务";
    source.textContent = `${concept.levelLabel || "学习点"} · 来自：${sourceNames}`;
    copy.append(title, why, how, source);

    const actions = document.createElement("div");
    actions.className = "concept-actions";

    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.textContent = concept.favorite ? "取消收藏" : "收藏";
    favorite.addEventListener("click", async () => {
      favorite.disabled = true;
      await chrome.runtime.sendMessage({
        type: "AFTERAI_TOGGLE_FAVORITE_CONCEPT",
        concept,
        favorite: !concept.favorite
      });
      render();
    });

    const learned = document.createElement("button");
    learned.type = "button";
    learned.textContent = concept.learned ? "已学会" : "标记已学会";
    learned.disabled = concept.learned;
    learned.addEventListener("click", async () => {
      learned.disabled = true;
      learned.textContent = "已学会";
      row.classList.add("is-learned");
      await chrome.runtime.sendMessage({
        type: "AFTERAI_MARK_CONCEPT_LEARNED",
        concept,
        learned: true
      });
      render();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!confirm(`删除知识点“${concept.name}”？这会从学习地图、收藏夹和已学会列表中移除它。`)) return;
      remove.disabled = true;
      await chrome.runtime.sendMessage({
        type: "AFTERAI_DELETE_CONCEPT",
        concept
      });
      render();
    });

    actions.append(favorite, learned, remove);
    row.append(copy, actions);
    list.appendChild(row);
  });

  return list;
}

function markFavorites(days, favoriteConcepts) {
  days.forEach((day) => {
    (day.concepts || []).forEach((concept) => {
      concept.favorite = Boolean(favoriteConcepts[concept.id]);
    });
    (day.sessions || []).forEach((session) => {
      (session.concepts || []).forEach((concept) => {
        concept.favorite = Boolean(favoriteConcepts[concept.id]);
      });
    });
  });
}

function renderRecords(records) {
  const section = document.createElement("section");
  section.className = "records";
  const title = document.createElement("h3");
  title.textContent = "对话轮次";
  const list = document.createElement("ul");

  records.slice(0, 20).forEach((record, index) => {
    const item = document.createElement("li");
    const text = document.createElement("span");
    const assessment = record.review && record.review.assessment ? ` · ${assessmentLabel(record.review.assessment.verdict)}` : "";
    text.textContent = `第 ${records.length - index} 轮：${record.review && record.review.title ? record.review.title : record.promptPreview || record.answerPreview || "未命名任务"}${assessment}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "record-delete danger";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!confirm("删除这一轮对话记录？")) return;
      remove.disabled = true;
      await chrome.runtime.sendMessage({
        type: "AFTERAI_DELETE_RECORD",
        recordId: record.id
      });
      render();
    });

    item.append(text, remove);
    list.appendChild(item);
  });

  section.append(title, list);
  return section;
}

function assessmentLabel(verdict) {
  if (verdict === "reliable") return "整体可靠";
  if (verdict === "mixed") return "部分可疑";
  if (verdict === "risky") return "风险较高";
  return "待查证";
}
