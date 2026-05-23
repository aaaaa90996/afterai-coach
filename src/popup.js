document.querySelector("#open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard.html") });
});

document.querySelector("#open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.querySelector("#enable-current-page").addEventListener("click", async () => {
  const status = document.querySelector("#status");
  try {
    const tab = await getActiveTab();
    await injectCoach(tab.id);
    status.textContent = "已启用当前页。若没有在设置中隐藏悬浮入口，页面左下角会出现保存入口；也可以直接点“诊断当前页”。";
  } catch (error) {
    status.textContent = `启用失败：${error && error.message ? error.message : String(error)}`;
  }
});

document.querySelector("#diagnose-current-page").addEventListener("click", async () => {
  const status = document.querySelector("#status");
  try {
    const tab = await getActiveTab();
    let response = null;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "AFTERAI_PAGE_DIAGNOSTIC" });
    } catch (_) {
      response = await runDirectDiagnostic(tab.id);
    }
    status.textContent = formatDiagnostic(response);
  } catch (error) {
    status.textContent = "内容脚本未响应。请先点“启用当前页”，或刷新页面后重试。";
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("没有找到当前标签页。");
  return tab;
}

async function injectCoach(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/shared.js", "src/content.js"] });

  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ["src/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/shared.js", "src/content.js"] });
  } catch (_) {
    // The main document is enough for most chat pages. Some embedded frames reject injection.
  }
}

async function runDirectDiagnostic(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      ok: false,
      direct: true,
      url: location.href,
      title: document.title,
      assistantCount: 0,
      dockVisible: Boolean(document.querySelector(".afterai-fallback-dock")),
      bodyTextLength: document.body && document.body.innerText ? document.body.innerText.length : 0,
      sample: document.body && document.body.innerText ? document.body.innerText.slice(0, 160) : ""
    })
  });
  return result && result.result ? result.result : null;
}

function formatDiagnostic(response) {
  if (!response) return "没有读到页面状态。请刷新页面后再试。";
  const lines = [
    `内容脚本：${response.ok ? "已响应" : "未响应"}`,
    `回答块：${response.assistantCount || 0}`,
    `入口：${response.dockVisible ? "已显示" : "未显示"}`,
    `正文长度：${response.bodyTextLength || 0}`
  ];
  if (response.sample) lines.push(`样例：${response.sample.replace(/\s+/g, " ").slice(0, 80)}`);
  if (!response.ok) lines.push("建议：先点“启用当前页”，看到左下角入口后再保存。");
  if (response.ok && !response.assistantCount) lines.push("建议：Gemini 回答生成完成后，点左下角“保存最后回答”。");
  return lines.join("\n");
}
