const DEFAULTS = {
  provider: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
  requestTimeoutMs: 60000,
  outputLanguage: "简体中文",
  enableAssessment: false,
  autoRead: false
};

const form = document.querySelector("#settings-form");
const status = document.querySelector("#status");
const clearApi = document.querySelector("#clear-api");

restore();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  values.autoRead = document.querySelector("#autoRead").checked;
  values.enableAssessment = document.querySelector("#enableAssessment").checked;
  values.requestTimeoutMs = normalizeTimeoutSeconds(values.requestTimeoutSeconds) * 1000;
  delete values.requestTimeoutSeconds;
  await chrome.storage.local.set(values);
  status.textContent = "已保存";
  window.setTimeout(() => {
    status.textContent = "";
  }, 1800);
});

clearApi.addEventListener("click", async () => {
  document.querySelector("#provider").value = DEFAULTS.provider;
  document.querySelector("#baseUrl").value = "";
  document.querySelector("#model").value = "";
  document.querySelector("#apiKey").value = "";
  document.querySelector("#requestTimeoutSeconds").value = "60";
  await chrome.storage.local.set({
    provider: DEFAULTS.provider,
    baseUrl: "",
    endpoint: "",
    model: "",
    apiKey: "",
    requestTimeoutMs: DEFAULTS.requestTimeoutMs
  });
  status.textContent = "接口配置已清空";
  window.setTimeout(() => {
    status.textContent = "";
  }, 1800);
});

async function restore() {
  const values = Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS).concat(["endpoint"])));
  values.provider = normalizeProvider(values.provider);
  values.baseUrl = values.baseUrl || values.endpoint || "";
  values.requestTimeoutSeconds = String(Math.round(normalizeTimeoutMs(values.requestTimeoutMs) / 1000));
  for (const [key, value] of Object.entries(values)) {
    const field = document.querySelector(`#${key}`);
    if (!field) continue;
    if (field.type === "checkbox") {
      field.checked = Boolean(value);
    } else {
      field.value = value || "";
    }
  }
}

function normalizeProvider(provider) {
  if (["openai", "gemini", "claude", "tgi", "cohere"].includes(provider)) return provider;
  if (provider === "gemini") return "gemini";
  return "openai";
}

function normalizeTimeoutSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(Math.max(parsed, 5), 300);
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60000;
  return Math.min(Math.max(parsed, 5000), 300000);
}
