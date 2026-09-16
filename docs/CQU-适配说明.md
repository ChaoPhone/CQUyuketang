# CQU 适配说明

本文记录把 [Niuwh/yuketang-jiaoben](https://github.com/Niuwh/yuketang-jiaoben) 的思路
落到 `https://courses.cqu.edu.cn/` 的完整过程：调研证据、真实路由、DOM 契约、
以及第一个测试用例（AI 学习空间视频页）的实现。

---

## 1. 调研：CQU 站点是什么

抓取 `https://courses.cqu.edu.cn/` 首页（`Content-Length: 7660`）后可直接确认：

| 证据 | 值 |
| --- | --- |
| `<meta name="keywords">` | 雨课堂,清华大学,智慧教学,翻转课堂,混合式教学,教学工具,教学软件 |
| 静态资源 | `fe-static-yuketang.yuketang.cn/fe/static/pro/1.3.312/fe-proxtassets/` |
| CDN | `qn-sfe.yuketang.cn`、`storagecdn.xuetangx.com`、`proxt-cdn.xuetangx.com` |
| 页面壳 | `<div id="app"></div>`（Vue SPA） |
| CSP | **无** `Content-Security-Policy` 响应头 |

结论：**CQU 是雨课堂「专业版」的贴牌部署**，同一套前端代码，只有域名、学校信息、
后端集群不同。原脚本的核心逻辑可以整体复用。

### 1.1 路由从哪来

从 CQU 自己下发的应用包 `app_cbfb609cdfe1ae90.js`（4.58 MB）里提取出 **671 条** `path:` 路由定义。
与本项目相关的部分：

```
/pro/lms/:sign/:classroom_id                          ← 专业版课程目录（学习页根）
/pro/lms/:sign/:classroom_id/video/:leaf_id           ← 视频
/pro/lms/:sign/:classroom_id/audio/:leaf_id           ← 音频
/pro/lms/:sign/:classroom_id/graph/:leaf_id           ← 图文
/pro/lms/:sign/:classroom_id/forum/:leaf_id           ← 讨论
/pro/lms/:sign/:classroom_id/homework/:leaf_id        ← 作业
/pro/lms/:sign/:classroom_id/exam/:leaf_id            ← 考试
/pro/lms/:sign/:classroom_id/live/:leaf_id            ← 直播
/pro-learning-center/:subpath*                        ← 专业版学习中心
/pro-ai-workspace/:subpath*                           ← 专业版 AI 学习空间
/v2/web/studentLog/:classroom_id                      ← 旧版目录（兼容保留）
/ai-workspace/lms-graph/:classroomId/...              ← AI 学习空间（本次测试用例所在）
```

### 1.2 DOM 契约可行性校验

把 CQU 自己下发的 CSS（`app.7d9511c2.css` + `styles.190cee27.css`，合计 3.13 MB）拉下来，
统计上游脚本依赖的类名出现次数：

| 选择器片段 | 命中次数 | 用途 |
| --- | --- | --- |
| `btn-next` | 35 | pro 路线「下一节」——主要导航手段 |
| `app_index-wrapper` | 28 | pro 路线骨架 |
| `viewContainer` | 25 | pro 路线滚动容器 |
| `heightAbsolutely` | 5 | pro 路线骨架 |
| `content-box` | 27 | 课程条目 |
| `progress-wrap` | 5 | 进度文本容器 |
| `el-dialog__wrapper` | 4 | 弹窗（挂机检测） |
| `shipin` `tuwen` `taolun` `zuoye` `kaoshi` `ketang` `kejian` `piliang` | 136 / 50 / 56 / 56 / 68 / 285 / 116 / 58 | 叶子类型图标 |

**未命中**（首屏 CSS 中为 0）：

`header-bar`、`leaf-detail`、`leaf_list__wrap`、`activity__wrap`、`statistics-box`、
`xt-speedlist`、`xt-speedbutton`、`play-btn-tip`、`xt_video_player_current_time_display`、
`subject-item`、`container-problem`、`logs-list`。

两种可能：

1. 这些类名位于**按需加载的 chunk**里（首屏 bundle 只含公共部分）——很可能；
2. CQU 的 `1.3.312` 版本**已经改版**，这些类名被替换了——也可能。

无法在未登录状态下区分。**这正是本项目不照抄硬编码选择器、而要做「候选链 + 诊断」的原因。**

---

## 2. 相对上游的三处关键改造

### 改造一：路由解析取代域名字符串匹配

上游：

```js
const matchURL = `${location.host}${path[0]}/${path[1]}/${path[2]}`;
if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
  new V2Runner(panel).run();
} else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
  ...
```

问题：每支持一个学校就要加一个域名字符串。CQU 的 `courses.cqu.edu.cn` 两个分支都不匹配，
所以原脚本在 CQU 站点上**完全不会触发**。

本版改为从 `pathname` 结构里抽出 `sign / classroomId / type / leafId`：

```js
parseProLms() {
  const m = location.pathname.match(/\/pro\/lms\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/?#]+))?/);
  ...
}
```

天然支持任意贴牌域名，新增学校不用改代码。

### 改造二：DOM 契约层（候选链）

所有可能漂移的选择器集中到 `DOM` 表，每个键是**候选选择器数组**，按顺序取第一个命中：

```js
leafList: [
  '.leaf_list__wrap .activity__wrap',   // 上游 pro 路线写法
  '.leaf-detail',                       // 上游旧版写法
  '[class*="leaf_list"] [class*="activity"]',
  '[class*="catalog"] li',
  '[class*="chapter"] li',
],
```

上游一旦某个选择器失效，`?.` 会把错误吞成 `undefined`，表现为「脚本卡住但不报错」，
是这类脚本最难排查的故障模式。本版会明确说出**是哪一条契约没匹配上**。

### 改造三：文本锚点 + 双通道完成判定

上游 pro 路线判断完成度用的是超长绝对选择器：

```js
document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText
```

本版改成「找那个写着进度的元素」，三级降级：

1. 契约命中 `.progress-wrap .text` 等已知容器；
2. **全页文本扫描** —— TreeWalker 找文本形如 `100%` / `12/12` / `已完成` 的最深节点；
3. 最后才回退上游的绝对选择器。

只要页面上**还显示着进度文本**就能工作，不依赖 DOM 层级。

完成判定同时用两条通道，谁先到算谁：

- `ended` 事件（媒体真实播完）
- 进度文本变为完成态

上游只等进度文本，文本一漂移就死等到超时。

### 改造四：静音改为属性强制（修真实 bug）

上游的静音实现是**点击播放器的音量按钮**：

```js
mute() {
  const muteBtn = document.querySelector('#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon');
  if (muteBtn) muteBtn.click();
  const video = document.querySelector('video');
  if (video) video.volume = 0;
}
```

实测中静音不生效，根因有三条：

1. **选择器失效**：`xt-volumebutton` 这类类名在 CQU 的 `1.3.312` 上未命中，
   `muteBtn` 是 `null`，按钮点击这一段**静默跳过**；
2. **只设一次**：`volume = 0` 只执行一次。雨课堂的 xt 播放器在用户交互、
   切清晰度、重新挂载播放器时会自己把音量重置回去，之后脚本不再纠正；
3. **反效果风险**：更糟的是，「点击音量按钮」在**已静音状态下是切换** ——
   万一选择器命中了，反而会把声音打开。

改为**不依赖任何 DOM 结构**的属性强制：

```js
mute(media) {
  this._muted = true;
  const apply = el => { el.muted = true; el.volume = 0; el.removeAttribute?.('volume'); };
  apply(media || Media.find().el);                       // 立即生效
  document.addEventListener('volumechange', this._muteVolumeHandler, true);  // 事件即时纠正
  this._muteTimer = setInterval(() => { /* 定时兜底 */ }, 1000);              // 防事件被拦截
}
```

三重保障：

| 层 | 作用 |
| --- | --- |
| 立即设置 `muted = true` + `volume = 0` | 唯一能压住 `volume` 的开关 |
| `volumechange` 事件（捕获阶段，委托到 document） | 播放器一改音量就立刻纠正 |
| 1s 定时兜底 | 防播放器不派发事件 / 事件被拦截 |

代价是**用户无法手动取消静音**（会被立刻纠正回来）—— 这是刻意的：
刷课场景下静音是刚需。因此点「停止」时会调用 `Player.unmute()`
解除强制并把声音还给用户。

另注意 `mute()` 必须在 `play()` **之前**执行：Chrome 只允许**静音**的媒体
无手势自动播放，顺序反了会被自动播放策略拦截。

---

## 3. 第一个测试用例：AI 学习空间视频页

用户提供的实地址：

```
https://courses.cqu.edu.cn/ai-workspace/lms-graph/31317597/video/84703555
  ?fromProIframe=1&isyth=1&is_chapter=1&node_id=16380147
```

### 3.1 路由结构解析

路径是 **3 段**，不是 4 段：

| 位置 | 值 | 含义 |
| --- | --- | --- |
| path[0] | `ai-workspace` | 应用 |
| path[1] | `lms-graph` | 图谱学习路由 |
| path[2] | `31317597` | `classroomId`（课堂 ID） |
| path[3] | `video` | `type`（**类型在第 2 段**） |
| path[4] | `84703555` | `leafId`（叶子 ID，**在第 3 段**） |
| query `node_id` | `16380147` | 章节节点 ID（**只在 query 里，不在 path 里**） |
| query `fromProIframe` | `1` | 本页是被专业版目录页内嵌/跳转过来的播放器页 |

最初我按 4 段结构写解析器，结果 `type` 被吃成 `84703555`、`leafId` 被吃成 `undefined`。
这个 bug 在开发过程中被真实地址的解析用例固化成回归测试，防止再犯。

### 3.2 这条路线上的三个真实风险

**风险 1：播放器不在顶层 document。**
`fromProIframe=1` 说明这是被嵌入的播放器页，媒体元素可能在 shadow DOM 或同源 iframe 里。
上游只做 `document.querySelector('video')`，在这种页面上什么都找不到 —— 表现就是「一直卡住不播放」。

本版 `Media.find()` 跨根查找：先顶层 document（最快路径），再枚举 shadow root，最后同源 iframe，
递归深度上限 4，跨域 iframe 读 `contentDocument` 抛错时直接跳过。

**风险 2：浏览器自动播放拦截。**
`video.play()` 在无用户手势时会被拒。本版 `Player.kickstart()`：

1. 先设 `muted = true; volume = 0`（静音后 Chrome 允许自动播放）；
2. `play()`；失败则挂**一次性**用户手势监听（click / keydown / touchstart，捕获阶段）；
3. 用户点页面任意位置即自动开始，15s 无手势则放弃等待交回主流程。

这样仍然是「一键启动」，不需要用户再点第二次。

**风险 3：切屏 / 挂机检测。**
后台播放时页面失焦，雨课堂会弹检测弹窗甚至暂停视频。本版三层防护：

- `preventScreenCheck()` —— 在页面脚本注册监听前拦截 `visibilitychange` / `blur` / `pagehide` / `webkitvisibilitychange`，
  并伪造 `visibilityState='visible'`、`hidden=false`、`hasFocus()=true`；
- `Player.keepAlive()` —— 每 20s 派发一次轻微 `mousemove`；
- `Utils.dismissPopups()` —— 监测并点击「继续观看」/「取消」关掉挂机弹窗。

### 3.3 一键启动流程

点面板 `▶ 开始刷课` 之后：

```
解析路由 (kind=ai, classroomId=31317597, type=video, leafId=84703555)
   ↓
preventScreenCheck()                         防切屏，尽早生效
   ↓
轮询查找媒体元素（跨 shadow/iframe），最多 30s
   ↓
已有完成标记？ → 是则直接结束（避免重复刷）
   ↓
Player.applySpeed(2x) + Player.mute()
   ↓
Player.observePause(media)                   反暂停：play 自愈 + pause 事件 + 5s 定时兜底
Player.keepAlive()                           后台保活
   ↓
Player.kickstart(media)                      静音播放 + 一次性手势兜底
   ↓
确认 currentTime 真的在推进（防「假播放」）
   ↓
Player.waitUntilDone(media)                  ended 事件 或 进度文本，谁先到算谁
   ↓
收尾：iframe 内 → postMessage 通知父窗口
      非内嵌   → 尝试「下一节」，否则回目录页
```

### 3.4 验证方式

开发期用三套离线测试验证过核心链路（测试脚本已按项目要求移除，此处仅记录结论）：

| 测试 | 覆盖内容 |
| --- | --- |
| 路由解析 | 6 个用例，含本条真实地址的 3 段路径 + query 解析 |
| 自动播放链路 | 22 条断言（无依赖 DOM 桩） |
| 静态检查 | 扫描「赋值给未声明标识符」（防 `ReferenceError`） |

自动播放链路的具体断言：

- shadow DOM 内的 `video` 能被 `Media.find()` 找到，且证明顶层 `document.querySelector('video')`
  **查不到**（跨根查找确有必要）；
- 倍速设置、`play()` 调用；
- **静音强制**：静音后 `muted=true`+`volume=0`；播放器重置音量后被立即纠正；
  未派发 `volumechange` 时靠定时兜底纠正；`unmute()` 后不再干扰；
- **静音先于 `play()`**（Chrome 只允许静音媒体无手势自动播放，顺序错了会被拦截）；
- 站点触发 `pause` 后脚本自动恢复；停止观察后不再干扰；
- 推进到末尾派发 `ended` 并被捕获；
- 完成度文本判定 9 组用例（`100%`/`已完成`/`12/12`/`3/12`/`进行中`/`98%` 等）；
- `.progress-wrap .text` 锚点命中与已完成跳过。

> 注：DOM 桩**不执行** userscript 本体，而是复刻其判定逻辑（`isDone`、`findMedia`、
> `observePause`、`mute`）。契约层的真实命中情况必须靠页面上的 `🔍 诊断` 确认。

---

## 4. 调试手册

### 面板不出现（最常见）

**第一步：确认脚本执行了没有。** F12 → 控制台 → 刷新页面，找这行：

```
[CQU雨课堂] 脚本已执行 v1.1.0
```

| 现象 | 结论 | 处理 |
| --- | --- | --- |
| 没有这行 | 脚本**根本没运行** | 见下方「@require 陷阱」 |
| 有这行 + `当前在 iframe 内，按设计跳过注入` | 页面被嵌入 | 去顶层页面操作 |
| 有这行 + 红色提示框 `面板挂载失败` | 挂载异常 | 把红框里的错误信息发出来 |
| 有这行 + 面板出现 | 正常 | — |

#### `@require` 陷阱（v1.0.0 的真实故障）

v1.0.0 的元数据块里有两个 `@require`：

```
// @require https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
```

油猴的加载规则是：**`@require` 的资源全部下载完成后，才执行脚本主体。**

`cdnjs.cloudflare.com` 与 `unpkg.com` 在国内网络下经常连接超时（每个要等到超时），
于是脚本**一行都不会执行**：没有面板、没有报错、油猴图标上也不会有明显提示。
这是这类脚本最难排查的故障模式之一 —— 看起来像"脚本没生效"，实际是"脚本没开始跑"。

v1.0.1 的处理：

1. 删掉两个 `@require`，**只播放视频的场景零外部依赖**；
2. html2canvas / Tesseract 改为**用到时才懒加载**（仅 AI 识图答题需要），
   并按 `jsdelivr → npmmirror → unpkg → cdnjs` 顺序回退，全部失败则降级为纯文本识别；
3. `Solver.recognize()` 增加纯文本兜底分支，依赖缺失不再抛错。

**排查手段**：新增启动心跳日志，脚本一执行就打印版本、URL、是否顶层窗口、文档状态。
有无这行日志，是区分"没运行"和"运行失败"的分水岭。

### 点「开始刷课」后没反应

1. 点 `🔍 诊断`，看控制台表格里 `leafList` / `video` 等契约是否 `未命中`；
2. 看「命中根」是 `document` 还是 `shadow`/`iframe` —— 若显示 `(未找到)`，
   说明媒体元素在**跨域** iframe 内，脚本无法穿透（浏览器同源策略限制，无解）；
3. 看「类型」是否为 `(无)`。

### 诊断输出示例

```
路由: {kind: "ai", classroomId: "31317597", type: "video", leafId: "84703555",
       nodeId: "16380147", fromProIframe: true, isChapter: true, isCatalog: false}
路线: AI学习空间 (ai-workspace/lms-graph/31317597/video/84703555) [专业版内嵌播放器]
进度锚点: 12% | 完成 = false | 来源 = text-scan
媒体: {命中根: "shadow", 类型: "video", 承载iframe: false, 可穿透根数量: 3, 状态: {...}}
```

反馈问题时把 `🔍 诊断` 复制的内容贴出来即可（面板会提示「已复制到剪贴板」）。

### 控制台入口

```js
__CQU_DIAG__()   // 随时打印诊断报告
```

---

## 5. 待确认事项

见 `docs/验证清单.md`。
