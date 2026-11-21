# 依依无限制剧情生图 · SillyTavern 扩展 (`yiyi-local-illust`)

专为 **大世界跑团 / 长篇剧情** 设计的 SillyTavern 自动插画扩展：

- **24 小时即开即画（Mac 常驻 / HTTPS 远程 / 双机切换）**：支持同源 `/yiyi-mac` 以及完整 HTTPS 远程生图地址（解决 HTTPS 酒馆访问 HTTP 的 Mixed Content 拦截与跨设备直连问题）；后台对接 `WAI-Illustrious v17` + `Hyper-SDXL 8-step`（10 步高还原参数 + 强效防坏手/坏手指负向保护）与无限制 `4B` 剧情提炼模型，并提供明确的连接/密码/网关/超时诊断提示。
- **全能记忆适配 + 无插件剧情自总结（3 档模式）**：
  - **智能全适配（推荐）**：同时读取 **小白X (`LittleWhiteBox`)**、第三方表格/数据库/向量记忆插件（`extensionPrompts`、`sheets` / `hash_sheets` / `tableData`、MVU `stat_data` 等深层变量）、酒馆世界书与摘要；当没有安装任何记忆插件时，会自动从前文对话楼层提取人物外貌、穿搭、场景转换与前图锚点保持一致。
  - **仅剧情总结（无插件模式）**：跳过记忆插件与世界书，纯靠近 35 层剧情正文+状态栏视觉字段提取人物与场景特征。
  - **关闭历史记忆**：仅看当前楼层正文画面。
- **纯净楼层提取与永久保存**：自动剥离状态栏与选项文本，支持手动点击楼层 `🎨` 按钮或开启楼层自动生成，成图直接上传并挂载到 SillyTavern `mes.extra.media` 中永久保存。

## 安装方式（SillyTavern Git URL）

在 SillyTavern 的 **扩展（Extensions） → 安装扩展（Install extension）** 中填入仓库地址即可：

```text
https://github.com/luoyuewuyi/yiyi-local-illust
```

若连接到设置了访问密码的服务端，或使用好友共享的独立酒馆实例：点开悬浮窗后填入完整生图地址（如 `https://你的生图域名/yiyi-mac`）与访问密码，点击 **测试连接** 即可查看详细状态或原因排查。
