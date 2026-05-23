# AfterAI Coach

AfterAI Coach 是一个浏览器扩展 MVP。它会在 AI 网页回答下方插入“教我这次任务”按钮，把最后一轮用户请求和 AI 回答发送给你配置的 LLM API，然后生成：

- AI 完成了什么
- AI 是怎么做的
- 需要补哪些知识
- 今天能做的 10 分钟小练习
- 微测试
- 下次先自己尝试的一小块
- 跨 AI 网页的本地任务记录
- 按天展开的学习地图
- 重复知识点自动合并，并显示出现次数
- “已学会”按钮，把知识点放入已掌握列表
- 收藏知识点，并在学习地图中查看收藏夹
- 可选“客观评判”，复盘时检查 AI 回答是否可靠
- 可选“自动读取并生成复盘”，开启后新 AI 回答会自动进入学习地图，并显示可关闭提示框

## 安装

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`D:\mfx_encoder_dll_副本\afterai-coach-extension`。
5. 点击扩展图标，进入设置页，选择接口格式，填写 `base_url`、模型和 API Key。
6. 默认请求超时是 60 秒，可以在设置页调整到 5-300 秒。
7. 如需自动读取，打开设置页里的“自动读取并生成复盘”。默认关闭，避免意外消耗 API。
8. 如需检查 AI 回答可靠性，打开“复盘时检查 AI 回答可靠性”。默认关闭，因为它会增加等待时间和 API 消耗。

## 默认支持的 AI 网页

- ChatGPT
- Claude
- Gemini
- 豆包
- 腾讯元宝
- Kimi
- DeepSeek Chat
- 通义

## API 配置

设置页只保留接口格式，`base_url`、模型和 Key 都由用户自己填写。

支持的接口格式：

- OpenAI Chat Completions
- Gemini generateContent
- Claude Messages
- TGI Chat Completions
- Cohere Chat v2

路径拼接规则：

- OpenAI/TGI：`base_url` + `/chat/completions`
- Claude：`base_url` + `/v1/messages`
- Cohere：`base_url` + `/v2/chat`
- Gemini：`base_url` + `/models/{model}:generateContent`

如果你填的是完整请求地址，例如已经包含 `/chat/completions` 或 `/v1/messages`，插件会尽量直接使用。

## 使用

1. 打开支持的 AI 网页。
2. 等 AI 回答完成。
3. 在回答下方点击“教我这次任务”。
4. 查看自动生成的学习复盘面板。
5. 点击扩展图标，再点“打开学习地图”，查看每天沉淀出的待学习内容。

如果在设置页开启“自动读取并生成复盘”，插件会在识别到新的 AI 回答后自动生成复盘。读取时页面右下角会出现一个可关闭的小提示框。

## 学习地图

学习地图会按天汇总所有支持 AI 网页里识别到的任务。生成复盘后，知识点会进入当天列表。

- 同一天重复出现的知识点只显示一次。
- 重复次数会显示为“出现 N 次”。
- 可以按关键词、待学习、已学会、今天学、练几次、以后学筛选。
- 可以切到“收藏夹”查看收藏的知识点。
- 点击“已学会”或“标记已学会”后，该知识点会进入已掌握列表。

## 设计取舍

- 第一版采用手动触发，避免每次聊天都消耗 API Token。
- API Key 只保存在浏览器本机的 `chrome.storage.local`。
- 页面脚本只负责读取对话和渲染面板，真正的 API 请求在 Background Service Worker 中完成。
- DOM 读取用了多种通用选择器，但不同 AI 网站改版后可能需要微调 `src/content.js` 的选择器。
- 任务记录、复盘、已学会知识点都保存在浏览器本地，最多保留最近 500 条任务。

## 开发检查

```powershell
npm test
npm run check
```

如果系统里的 `node.exe` 被权限策略拦截，可以只先用浏览器加载扩展检查 manifest 和页面功能。
