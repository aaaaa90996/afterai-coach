document.querySelector("#open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard.html") });
});

document.querySelector("#open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
