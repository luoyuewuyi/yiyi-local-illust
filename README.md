# 依依无限制剧情生图 · SillyTavern 扩展 (`yiyi-local-illust`)

专为 **大世界跑团 / 长篇剧情** 设计的 SillyTavern 自动插画扩展：

- **24 小时即开即画（推荐 Mac 常驻模式）**：默认走同源 `/yiyi-mac` 接口（PC / 手机浏览器均免跨域、免开额外隧道），后台对接 `WAI-Illustrious v17` + `Hyper-SDXL 8-step`（10 步高还原参数 + 强效防坏手/坏手指负向保护）与无限制 `4B` 剧情提炼模型；也可在悬浮窗中随时切换 `自动优选` 或 `仅 Windows`。
- **小白X (`LittleWhiteBox`) 记忆一致性锁定**：自动读取 `storySummary.json`（角色档案、别名、外貌/服饰/状态 facts、events、arcs）与 `stateAtoms` 状态原子，以及酒馆世界书、状态变量与前图视觉锚点，在大世界多角色切换与代词叙事下保持人物特征一致，不串戏、不把世界观名称强塞进画面。
- **纯净楼层提取与原图永久保存**：自动剥离 `<details>` / `<UpdateVariable>` / 状态栏与选项文本，支持手动点击楼层 `🎨` 按钮或开启楼层自动生成，成图直接上传并挂载到 SillyTavern `mes.extra.media` 中永久保存。

## 安装方式（SillyTavern Git URL）

在 SillyTavern 的 **扩展（Extensions） → 安装扩展（Install extension）** 中填入仓库地址即可：

```text
https://github.com/luoyuewuyi/yiyi-local-illust
```
