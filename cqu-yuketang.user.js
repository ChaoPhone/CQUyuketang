// ==UserScript==
// @name         重庆大学雨课堂刷课助手 (CQU 适配版)
// @namespace    https://courses.cqu.edu.cn/
// @version      1.1.0
// @description  适配重庆大学在线课程平台（courses.cqu.edu.cn）的自动播放助手，仅供个人学习使用。思路源自开源项目 Niuwh/yuketang-jiaoben。
// @author       CQU 适配版
// @license      GPL-3.0
// @match        *://courses.cqu.edu.cn/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      api.anthropic.com
// @connect      *
// ==/UserScript==

/*
 * ⚠️ 声明
 *   来源：思路、面板交互与 pro/v2 双路线架构来自开源项目
 *         https://github.com/Niuwh/yuketang-jiaoben  (GPL-3.0)
 *         本仓库是针对重庆大学站点的适配分支，遵循同一许可证。
 *   用途：仅供个人学习使用。请勿用于商业用途、请勿传播牟利。
 *         使用者需自行承担一切后果。
 */

/*
 *  ⚠️ 关于 @require（曾经导致脚本完全不运行）
 *
 *  早期版本用了：
 *      // @require https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
 *      // @require https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
 *
 *  油猴的行为是：@require 的资源**下载完成后才会执行脚本主体**。
 *  这两个域名（cdnjs.cloudflare.com / unpkg.com）在国内网络下往往连接超时，
 *  结果就是脚本一行都没跑、面板不出现、控制台连报错都没有 —— 极难排查。
 *
 *  现在改为：**默认零外部依赖**，html2canvas / Tesseract 改成用到时（AI 识图答题）
 *  才按需懒加载，并带多个国内可达的 CDN 回退；全都失败则自动降级为纯文本模式。
 *  只播放视频完全不需要这两个库。
 */

/*
 * ============================================================================
 *  重庆大学雨课堂刷课助手 —— CQU 研究适配版
 * ----------------------------------------------------------------------------
 *  思路与面板交互源自：https://github.com/Niuwh/yuketang-jiaoben (GPL-3.0)
 *
 *  CQU 站点调研结论（详见 README.md）：
 *    courses.cqu.edu.cn 是雨课堂「专业版」贴牌部署：
 *      - 静态资源  fe-static-yuketang.yuketang.cn/fe/static/pro/1.3.312/fe-proxtassets/
 *      - 主路由    /pro/lms/:sign/:classroom_id[/:type/:leaf_id]
 *      - 旧版兼容  /v2/web/studentLog/:classroom_id
 *      - 无 CSP 响应头，油猴注入不受限
 *
 *  本适配版相对上游的三处关键改造：
 *    1. 域名与路由：不再硬编码 "yuketang.cn/pro/lms" 字符串，改为解析 URL 结构取得
 *       sign / classroom_id / leaf_id / type，天然支持任意贴牌域名。
 *    2. DOM 契约层：所有可能随版本漂移的选择器集中到 DOM 表，每条都是「候选链」，
 *       并保留上游写法作为候选之一，便于回溯。
 *    3. 自检能力：新增 🔍 诊断，逐条报告契约命中情况，未登录/改版时可自助定位缺口。
 * ============================================================================
 */

(() => {
  'use strict';

  // 面板实例，由 boot() 赋值后全局复用。
  // ⚠️ 这行不能删：在 'use strict' 下给未声明的标识符赋值会抛
  //    ReferenceError: panel is not defined（曾因此导致「面板挂载失败」）。
  let panel;

  /* ==========================================================================
   * 0. 配置
   * ========================================================================== */

  const Config = {
    version: '1.1.0',
    playbackRate: 2,          // 视频倍速
    pptInterval: 3000,        // PPT 自动翻页间隔(ms)
    pollInterval: 1000,       // 通用轮询间隔
    maxStepTimeoutFallback: 3 * 60 * 1000, // 拿不到媒体时长时的兜底超时
    storageKeys: {
      progress: '[CQU雨课堂]刷课进度',
      ai: 'cqu_ykt_ai_conf',
      feature: 'cqu_ykt_feature_conf',
      leafCursor: 'cqu_ykt_leaf_cursor',
      pending: 'cqu_ykt_pending_autostart',
    },
  };

  /* ==========================================================================
   * 1. DOM 契约层 —— 本项目唯一需要随站点改版维护的地方
   *
   * 每个键都是「候选选择器数组」，按顺序取第一个命中的。
   * 新增/修正适配时只改这里，业务逻辑不用动。
   * ========================================================================== */

  const DOM = {
    // ---- 课程目录（pro 路线左侧/主区目录树）----
    leafList: [
      '.leaf_list__wrap .activity__wrap',       // 上游 pro 路线写法
      '.leaf-detail',                            // 上游旧版写法
      '[class*="leaf_list"] [class*="activity"]',
      '[class*="leaf_list"] [class*="leaf"]',
      '[class*="activity__wrap"]',
      '[class*="catalog"] li',
      '[class*="chapter"] li',
    ],

    // 目录中单个叶子内部的「标题」
    leafTitle: ['h2', '.title', '[class*="title"]', '[class*="name"]', 'span'],

    // 目录中单个叶子内部的「类型图标」(<use xlink:href="#icon-shipin">)
    leafIcon: ['.tag use', 'use', '[class*="tag"] use', 'svg use', 'i[class*="icon"]'],

    // 目录中单个叶子内部的「状态/完成度」容器
    leafStatus: [
      '.statistics-box .aside',
      '[class*="statistics"]',
      '[class*="status"]',
      '[class*="progress"]',
      '[class*="aside"]',
    ],

    // ---- 学习页（打开某个叶子之后）----
    // 顶部标题栏
    headerBar: ['.header-bar', '[class*="header-bar"]', '[class*="headerBar"]', '[class*="lesson-header"]'],
    // 进度显示元素（文本形如 100% / 12/12 / 已完成）
    progressWrap: ['.progress-wrap .text', '.progress-wrap', '[class*="progress"]'],
    // 「下一节」按钮 —— pro 路线主要导航手段
    nextButton: ['.btn-next', '[class*="btn-next"]', '[class*="next"] button', 'button[class*="next"]'],
    // 目录展开 / 批量区展开按钮
    expandButton: ['.sub-info .gray span', '[class*="sub-info"] span', '[class*="expand"]'],
    // 批量区内部条目
    batchItem: ['.activity__wrap', '[class*="activity__wrap"]', '.leaf_list__wrap li'],
    // 旧版(v2)目录列表
    v2LogList: ['.logs-list', '[class*="logs-list"]', '[class*="logsList"]'],
    // 旧版(v2)列表条目
    v2Item: ['.content-box section', '.content-box', '[class*="content-box"]'],

    // ---- 视频播放器 ----
    video: ['video'],
    audio: ['audio'],
    // 播放器「播放/暂停」提示节点（上游用于反暂停）
    playTip: ['.play-btn-tip', '[class*="play-btn-tip"]'],
    // xt 播放器倍速控件（上游做法）
    speedList: ['xt-speedlist'],
    speedButton: ['xt-speedbutton'],
    // 播放器时间显示（用于判定播完）
    timeDisplay: ['.xt_video_player_current_time_display', '[class*="current_time"]', '[class*="currentTime"]'],

    // ---- 课件 ----
    videoBox: ['.video-box', '[class*="video-box"]', '[class*="videoBox"]'],
    pptWrapper: ['.swiper-wrapper', '[class*="swiper-wrapper"]'],
    coursewareCheck: ['.ppt_img_box .check', 'p.check', '[class*="check"]'],

    // ---- 弹窗 ----
    dialog: ['.el-dialog__wrapper', '.el-message-box__wrapper', '[role="dialog"]', '.el-dialog'],

    // ---- 作业 ----
    subjectItem: ['.subject-item.J_order', '.subject-item', '[class*="subject-item"]'],
    optionList: [
      '.list-inline.list-unstyled-radio',
      '.list-unstyled.list-unstyled-radio',
      '.list-unstyled',
      'ul.list',
      '[class*="option-list"]',
      '[class*="answer-list"]',
      '[role="radiogroup"]',
    ],
    optionItem: ['li', '.option-item', '[class*="option-item"]', '[class*="answer-item"]'],
    submitButton: ['button', '.el-button', '[role="button"]'],
    // 讨论区
    commentText: [
      '#new_discuss .new_discuss_list .cont_detail',
      '.new_discuss_list dd .cont_detail',
      '.cont_detail.word-break',
      '[class*="cont_detail"]',
      '[class*="comment"] [class*="content"]',
    ],
    commentInput: ['.el-textarea__inner', 'textarea', '[contenteditable="true"]'],
    commentSubmit: ['.el-button.submitComment', '.publish_discuss .postBtn button', '.el-button--primary'],
  };

  // 上游使用的绝对选择器：保留作为「最后一道兜底」，不参与首次匹配
  const LEGACY_ABSOLUTE = {
    proStatus:
      '#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title',
    proTitleBar: '.header-bar',
  };

  /* ==========================================================================
   * 2. 工具
   * ========================================================================== */

  const Utils = {
    sleep: (ms = 1000) => new Promise(r => setTimeout(r, ms)),

    /**
     * 懒加载外部脚本，带多个 CDN 回退。
     *
     * 为什么不用 @require：油猴会等 @require 全部下载完才执行脚本，
     * 一旦 CDN 连不上（国内访问 cdnjs / unpkg 经常超时），脚本就完全不运行。
     * 改成运行时按需加载后，只播放视频的场景零外部依赖。
     */
    _loaded: new Map(),

    loadScript(urls, timeout = 12000) {
      const key = urls.join('|');
      if (this._loaded.has(key)) return this._loaded.get(key);

      const promise = (async () => {
        for (const url of urls) {
          const ok = await new Promise(resolve => {
            let done = false;
            const s = document.createElement('script');
            s.src = url;
            s.async = true;
            const finish = result => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve(result);
            };
            s.onload = () => finish(true);
            s.onerror = () => finish(false);
            const timer = setTimeout(() => finish(false), timeout);
            (document.head || document.documentElement).appendChild(s);
          });
          if (ok) return url;
        }
        return null;
      })();

      this._loaded.set(key, promise);
      return promise;
    },

    /** 按需加载 html2canvas（AI 识图答题才需要） */
    async ensureHtml2Canvas() {
      if (typeof window.html2canvas === 'function') return true;
      const hit = await this.loadScript([
        'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
        'https://registry.npmmirror.com/html2canvas/1.4.1/files/dist/html2canvas.min.js',
        'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      ]);
      return Boolean(hit) && typeof window.html2canvas === 'function';
    },

    /** 按需加载 Tesseract.js（OCR，AI 识图答题才需要） */
    async ensureTesseract() {
      if (typeof window.Tesseract !== 'undefined') return true;
      const hit = await this.loadScript([
        'https://cdn.jsdelivr.net/npm/tesseract.js@2.1.0/dist/tesseract.min.js',
        'https://registry.npmmirror.com/tesseract.js/2.1.0/files/dist/tesseract.min.js',
        'https://unpkg.com/tesseract.js@2.1.0/dist/tesseract.min.js',
      ]);
      return Boolean(hit) && typeof window.Tesseract !== 'undefined';
    },

    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },

    async poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      const start = Date.now();
      // 先立即判一次，避免已经满足条件还要等一个 interval
      try {
        if (checker()) return true;
      } catch (_) { /* 忽略单次探测异常 */ }
      while (Date.now() - start <= timeout) {
        await this.sleep(interval);
        try {
          if (checker()) return true;
        } catch (_) { /* 忽略单次探测异常 */ }
      }
      return false;
    },

    normalized(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },

    /**
     * 完成度文本判定。
     * 覆盖：100% / 99% / 98% / 已完成 / 已读 / 已学完，以及 "12/12" 形式的进度比。
     */
    isDone(text) {
      const t = this.normalized(text);
      if (!t) return false;
      if (/100%|9[89]%|已完成|已读|已学完|已观看/.test(t)) return true;
      const m = t.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        const cur = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        return total > 0 && cur >= total;
      }
      return false;
    },

    /** 明确表示「未完成」的状态文本，优先于 isDone 的模糊判定 */
    isExplicitlyUndone(text) {
      return /未开始|未读|未学|进行中|未完成/.test(this.normalized(text));
    },

    inIframe() {
      try {
        return window.top !== window.self;
      } catch (_) {
        return true;
      }
    },

    async waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      if (getTarget()) return getTarget();
      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },

    scrollToBottom(selector) {
      const el = document.querySelector(selector);
      if (el) el.scrollTop = el.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
    },

    /** 取视频/音频时长，转成等待超时（至少 10s，给足缓冲） */
    async getMediaTimeout() {
      const el = document.querySelector('video') || document.querySelector('audio');
      if (!el) return Config.maxStepTimeoutFallback;
      let duration = Number(el.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await Promise.race([
          new Promise(resolve => el.addEventListener('loadedmetadata', resolve, { once: true })),
          this.sleep(5000),
        ]);
        duration = Number(el.duration);
      }
      if (!Number.isFinite(duration) || duration <= 0) return Config.maxStepTimeoutFallback;
      return Math.max(duration * 1000 * 3, 10000);
    },

    /**
     * 关闭雨课堂的挂机/离开检测弹窗。
     * CQU 使用同一套前端，弹窗文案应当一致。
     */
    async dismissPopups() {
      const found = DOM.dialog.flatMap(sel => [...document.querySelectorAll(sel)]);
      for (const wrapper of found) {
        let style;
        let rect;
        try {
          style = getComputedStyle(wrapper);
          rect = wrapper.getBoundingClientRect();
        } catch (_) {
          continue;
        }
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickLabel = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          if (clickLabel('继续观看')) return '继续观看';
        } else if (text.includes('报告老师')) {
          if (clickLabel('取消')) return '取消(报告老师)';
        } else if (/已暂停|离开了|切换/.test(text) && buttons.length === 1) {
          buttons[0].click();
          return '通用确认';
        }
      }
      return '';
    },
  };

  /* ==========================================================================
   * 3. 选择器解析器 —— 契约层的执行者
   * ========================================================================== */

  const Resolve = {
    /** 返回第一个命中的选择器 + 全部匹配元素 */
    all(candidates) {
      for (const sel of candidates) {
        let nodes = [];
        try {
          nodes = [...document.querySelectorAll(sel)];
        } catch (_) {
          continue;
        }
        if (nodes.length) return { selector: sel, nodes };
      }
      return { selector: null, nodes: [] };
    },

    one(candidates) {
      const { selector, nodes } = this.all(candidates);
      return { selector, node: nodes[0] || null, nodes };
    },

    /** 在某元素内部按候选链找 */
    within(root, candidates) {
      if (!root) return { selector: null, node: null, nodes: [] };
      for (const sel of candidates) {
        let nodes = [];
        try {
          nodes = [...root.querySelectorAll(sel)];
        } catch (_) {
          continue;
        }
        if (nodes.length) return { selector: sel, node: nodes[0], nodes };
      }
      return { selector: null, node: null, nodes: [] };
    },

    /**
     * 进度锚点解析：先按契约找，找不到就做「全页文本扫描」。
     * 这是替代上游超长绝对选择器的关键兜底 —— 只要页面上还显示进度文本就能工作。
     */
    completionMarker(excludeRoot = null) {
      // 1) 契约优先
      const hit = this.one(DOM.progressWrap);
      if (hit.node && Utils.isDone(hit.node.innerText)) {
        return { text: Utils.normalized(hit.node.innerText), done: true, node: hit.node, via: hit.selector };
      }

      // 2) 全页扫描：找「最深」的、文本像进度的小节点
      const re = /(\d{1,3}\s*%|\d+\s*\/\s*\d+|已完成|已读|已学完)/;
      let best = null;
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = Utils.normalized(node.nodeValue);
        if (!text || text.length > 40 || !re.test(text)) continue;
        const el = node.parentElement;
        if (!el) continue;
        if (excludeRoot && excludeRoot.contains(el)) continue;
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
        } catch (_) {
          continue;
        }
        // 取文本最短的（最贴近纯进度文本）
        if (!best || text.length < best.text.length) best = { text, node: el };
      }
      // 3) 兜底：上游绝对选择器
      if (!best) {
        const legacy = document.querySelector(LEGACY_ABSOLUTE.proStatus);
        if (legacy) {
          const text = Utils.normalized(legacy.innerText);
          return { text, done: Utils.isDone(text), node: legacy, via: 'legacy-absolute' };
        }
        return { text: '', done: false, node: null, via: null };
      }
      return { text: best.text, done: Utils.isDone(best.text), node: best.node, via: 'text-scan' };
    },
  };

  /* ==========================================================================
   * 4. 路由解析
   *
   * 关键改造：不再匹配 "yuketang.cn/pro/lms" 这类域名字符串，
   * 而是直接从 pathname 结构里抽出 sign / classroomId / type / leafId。
   * ========================================================================== */

  const Route = {
    /**
     * /pro/lms/:sign/:classroom_id
     * /pro/lms/:sign/:classroom_id/:type/:leaf_id
     * type ∈ video|audio|graph|forum|homework|exam|live
     */
    parseProLms() {
      const m = location.pathname.match(/\/pro\/lms\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/?#]+))?/);
      if (!m) return null;
      const [, sign, classroomId, type, leafId] = m;
      return {
        kind: 'pro',
        sign,
        classroomId,
        type: type || '',
        leafId: leafId || '',
        isCatalog: !type,
      };
    },

    /** /v2/web/studentLog/:classroom_id 及其子页 */
    parseV2() {
      const m = location.pathname.match(/\/v2\/web\/(?:studentLog|studentCards|student)\/?([^/?#]*)/);
      if (!m) return null;
      return {
        kind: 'v2',
        classroomId: m[1] || new URLSearchParams(location.search).get('classroom_id') || '',
        type: '',
        leafId: '',
        isCatalog: !location.pathname.includes('/studentCards/'),
      };
    },

    /**
     * AI 学习空间。真实结构（已用 CQU 实地址验证）：
     *   /ai-workspace/lms-graph/:classroomId
     *   /ai-workspace/lms-graph/:classroomId/:type/:leafId
     * 例：/ai-workspace/lms-graph/31317597/video/84703555?fromProIframe=1&isyth=1&is_chapter=1&node_id=16380147
     *
     * 注意：
     *   - 只有 3 段路径，不是 4 段；type 在第 2 段，leafId 在第 3 段。
     *   - node_id 只在 query 里，不在 path 里。
     *   - fromProIframe=1 表示本页是被专业版目录页内嵌/跳转过来的播放器页，
     *     这种页面没有目录树，只能做「接管播放」，导航交给上层。
     */
    parseAiWorkspace() {
      const m = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)(?:\/([^/]+))?(?:\/([^/?#]+))?/);
      if (!m) return null;
      const [, classroomId, seg2, seg3] = m;
      const q = new URLSearchParams(location.search);
      const common = {
        kind: 'ai',
        classroomId,
        nodeId: q.get('node_id') || '',
        fromProIframe: q.get('fromProIframe') === '1',
        isChapter: q.get('is_chapter') === '1',
      };
      if (!seg2) {
        return { ...common, type: '', leafId: '', isCatalog: true };
      }
      return { ...common, type: seg2, leafId: seg3 || '', isCatalog: false };
    },

    /** /pro-ai-workspace/* —— CQU 专业版的 AI 学习空间 */
    parseProAiWorkspace() {
      if (!location.pathname.startsWith('/pro-ai-workspace')) return null;
      const sp = new URLSearchParams(location.search);
      return {
        kind: 'pro-ai',
        classroomId: sp.get('classroom_id') || sp.get('classroomId') || '',
        type: sp.get('type') || '',
        leafId: sp.get('leaf_id') || sp.get('leafId') || '',
        isCatalog: false,
      };
    },

    current() {
      return this.parseProLms() || this.parseV2() || this.parseAiWorkspace() || this.parseProAiWorkspace();
    },

    /** 当前 classroomId（供跨页恢复用） */
    classroomId() {
      const r = this.current();
      return r?.classroomId || '';
    },

    /** 是否是可刷课的学习页 */
    isLearningPage() {
      return Boolean(this.current());
    },

    /** 从叶子 URL 反推目录 URL（leaf 跳转后用于返回） */
    catalogUrl() {
      const r = this.current();
      if (!r) return '';
      if (r.kind === 'pro') return `${location.origin}/pro/lms/${r.sign}/${r.classroomId}`;
      if (r.kind === 'v2') return `${location.origin}/v2/web/studentLog/${r.classroomId}`;
      if (r.kind === 'ai' && !r.fromProIframe) return `${location.origin}/ai-workspace/lms-graph/${r.classroomId}`;
      return '';
    },
  };

  /* ==========================================================================
   * 5. 存储
   * ========================================================================== */

  const Store = {
    _get(key, fallback) {
      return Utils.safeJSONParse(localStorage.getItem(key), fallback);
    },

    getAIConf() {
      const saved = this._get(Config.storageKeys.ai, {}) || {};
      const conf = {
        url: saved.url ?? 'https://api.deepseek.com/chat/completions',
        key: saved.key ?? 'sk-xxxxxxx',
        model: saved.model ?? 'deepseek-chat',
        apiFormat: saved.apiFormat ?? 'openai',
        authMethod: saved.authMethod ?? 'bearer',
      };
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },

    getFeatureConf() {
      const saved = this._get(Config.storageKeys.feature, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
        rate: saved.rate ?? Config.playbackRate,
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    },

    getCursor() {
      const v = localStorage.getItem(Config.storageKeys.leafCursor);
      return v ? Number(v) : 0;
    },
    setCursor(n) {
      localStorage.setItem(Config.storageKeys.leafCursor, String(n));
    },
    clearCursor() {
      localStorage.removeItem(Config.storageKeys.leafCursor);
    },

    getProgress(url) {
      const all = this._get(Config.storageKeys.progress, {}) || {};
      return all[url] || { outside: 0, inside: 0 };
    },
    setProgress(url, outside, inside = 0) {
      const all = this._get(Config.storageKeys.progress, {}) || {};
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const all = this._get(Config.storageKeys.progress, {}) || {};
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },

    getPending() {
      const saved = this._get(Config.storageKeys.pending, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        localStorage.removeItem(Config.storageKeys.pending);
        return null;
      }
      return saved;
    },
    setPending(classroomId, returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPending() || {};
      localStorage.setItem(Config.storageKeys.pending, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now(),
      }));
    },
    clearPending() {
      localStorage.removeItem(Config.storageKeys.pending);
    },

    clearAll() {
      Store.clearCursor();
      Store.clearPending();
      Store.removeProgress(location.href);
      localStorage.removeItem(Config.storageKeys.pending);
    },
  };

  /* ==========================================================================
   * 6. 诊断
   * ========================================================================== */

  /**
   * 关键契约：这些未命中才会真正影响功能。
   *
   * 其余契约（nextButton / batchItem / v2LogList / subjectItem / commentText …）
   * 都是**特定页面类型专用**的：在视频播放页上它们本来就该为空。
   * 如果不做区分，一次诊断会报出十几条「未命中」，使用者会误以为脚本坏了。
   */
  const CRITICAL_CONTRACTS = ['video', 'audio', 'progressWrap', 'leafList'];

  const Diag = {
    /** 逐条契约体检 */
    contracts() {
      const rows = [];
      for (const [name, candidates] of Object.entries(DOM)) {
        let hit = null;
        let count = 0;
        for (const sel of candidates) {
          let n = 0;
          try {
            n = document.querySelectorAll(sel).length;
          } catch (_) {
            rows.push({ name, selector: sel, count: -1, note: '无效选择器' });
            continue;
          }
          if (n > 0) {
            hit = sel;
            count = n;
            break;
          }
        }
        rows.push({ name, selector: hit, count, note: hit ? 'OK' : '未命中' });
      }
      return rows;
    },

    media() {
      const found = Media.find();
      const el = found.el;
      return {
        命中根: found.root || '(未找到)',
        类型: found.kind || '(无)',
        承载iframe: el ? Boolean(Media.findHostIframe(el)) : false,
        状态: el ? {
          duration: Number(el.duration) || 0,
          currentTime: Number(el.currentTime) || 0,
          paused: el.paused,
          ended: el.ended,
          muted: el.muted,
          volume: el.volume,
          rate: el.playbackRate,
          readyState: el.readyState,
        } : null,
        可穿透根数量: Media.roots().length,
      };
    },

    /** 目录叶子快照（前 30 条） */
    leaves() {
      const { selector, nodes } = Resolve.all(DOM.leafList);
      return {
        selector,
        total: nodes.length,
        items: nodes.slice(0, 30).map((n, i) => {
          const icon = Resolve.within(n, DOM.leafIcon);
          const title = Resolve.within(n, DOM.leafTitle);
          const status = Resolve.within(n, DOM.leafStatus);
          const href = icon.node?.getAttribute('xlink:href') || icon.node?.getAttribute('href') || '';
          return {
            index: i,
            title: Utils.normalized(title.node?.innerText || n.innerText).slice(0, 40),
            icon: href || (icon.node?.className ? String(icon.node.className) : ''),
            status: Utils.normalized(status.node?.innerText || '').slice(0, 30),
            type: Media.guessLeafType({ iconHref: href, className: String(n.className || ''), text: n.innerText || '' }),
          };
        }),
      };
    },

    report() {
      const route = Route.current();
      const marker = Resolve.completionMarker();
      const report = {
        时间: new Date().toLocaleString(),
        版本: Config.version,
        地址: location.href,
        路由: route || '未能解析（当前不是 CQU 雨课堂学习页？）',
        路线: route ? Runner.labelOf(route) : '-',
        当前进度锚点: marker.text || '(未找到)',
        判定完成: marker.done,
        锚点来源: marker.via || '-',
        媒体: this.media(),
        契约: this.contracts(),
        目录: this.leaves(),
      };
      return report;
    },

    /** 控制台友好的输出 */
    print() {
      const r = this.report();
      /* eslint-disable no-console */
      console.group('%c[CQU雨课堂] 诊断报告', 'color:#1677ff;font-weight:bold');
      console.log('路由:', r['路由']);
      console.log('路线:', r['路线']);
      console.log('进度锚点:', r['当前进度锚点'], '| 完成 =', r['判定完成'], '| 来源 =', r['锚点来源']);
      console.log('媒体:', r['媒体']);
      console.table(r['契约']);
      console.log('目录 (%d 项):', r['目录'].total, r['目录'].items);
      console.groupEnd();
      /* eslint-enable no-console */
      return r;
    },

    /**
     * 生成紧凑的纯文本报告。
     *
     * 为什么不直接用 JSON.stringify(report)：
     * 契约有 30+ 条、目录可能上百项，JSON 又长又难读，
     * 贴出来刷屏且抓不住重点。这里只输出「关键信息 + 未命中契约」，
     * 命中详情折叠成一行，长度可控。
     */
    text() {
      const r = this.report();
      const L = [];
      L.push('===== CQU 雨课堂助手 诊断报告 =====');
      L.push(`版本    : v${r['版本']}`);
      L.push(`时间    : ${r['时间']}`);
      L.push(`地址    : ${r['地址']}`);
      L.push(`路线    : ${r['路线']}`);
      L.push(`路由    : ${JSON.stringify(r['路由'])}`);
      L.push('');
      L.push('--- 进度 ---');
      L.push(`锚点文本: ${r['当前进度锚点']}`);
      L.push(`判定完成: ${r['判定完成']}`);
      L.push(`锚点来源: ${r['锚点来源']}`);
      L.push('');
      L.push('--- 媒体 ---');
      const m = r['媒体'];
      L.push(`命中根  : ${m['命中根']}`);
      L.push(`类型    : ${m['类型']}`);
      L.push(`承载iframe: ${m['承载iframe']}`);
      L.push(`可穿透根: ${m['可穿透根数量']}`);
      L.push(`状态    : ${m['状态'] ? JSON.stringify(m['状态']) : '(无)'}`);
      L.push('');
      L.push('--- DOM 契约 ---');
      const hit = r['契约'].filter(c => c.note === 'OK');
      const miss = r['契约'].filter(c => c.note !== 'OK');
      L.push(`命中 ${hit.length} / 共 ${r['契约'].length}`);
      L.push('未命中:');
      if (miss.length) {
        for (const c of miss) L.push(`  - ${c.name}  (${c.note})`);
      } else {
        L.push('  (无)');
      }
      L.push('命中详情:');
      for (const c of hit) L.push(`  - ${c.name} = ${c.selector} ×${c.count}`);
      L.push('');
      L.push('--- 目录 ---');
      L.push(`契约    : ${r['目录'].selector || '(未命中)'}`);
      L.push(`数量    : ${r['目录'].total}`);
      for (const it of r['目录'].items.slice(0, 15)) {
        L.push(`  [${it.index}] ${it.type} | ${it.title} | status="${it.status}" | icon=${it.icon || '-'}`);
      }
      L.push('');
      L.push('--- 面板日志 ---');
      const logs = this.logBuffer.slice(-60);
      if (logs.length) logs.forEach(x => L.push('  ' + x));
      else L.push('  (空)');
      L.push('===== 报告结束 =====');
      return L.join('\n');
    },

    // 面板日志的镜像缓冲，便于随诊断一起导出
    logBuffer: [],

    /** 一键复制到剪贴板，方便反馈适配问题 */
    async copy() {
      const text = this.text();
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // 剪贴板被拒时退回 textarea 方案
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (_) { /* ignore */ }
        ta.remove();
        return ok;
      }
    },

    /** 控制台直接打印纯文本报告 */
    printText() {
      /* eslint-disable-next-line no-console */
      console.log(this.text());
      return this.text();
    },
  };

  /* ==========================================================================
   * 7. 媒体 + 播放器控制
   * ========================================================================== */

  const Media = {
    guessLeafType({ iconHref = '', className = '', text = '' }) {
      const hay = `${iconHref} ${className} ${text}`.toLowerCase();
      if (/shipin|video|视频/.test(hay)) return 'video';
      if (/audio|音频|yinpin/.test(hay)) return 'audio';
      if (/tuwen|graph|图文|richtext/.test(hay)) return 'graph';
      if (/taolun|forum|讨论/.test(hay)) return 'forum';
      if (/zuoye|homework|作业/.test(hay)) return 'homework';
      if (/kaoshi|exam|考试|测验/.test(hay)) return 'exam';
      if (/ketang|live|课堂|直播/.test(hay)) return 'live';
      if (/kejian|courseware|课件|ppt/.test(hay)) return 'courseware';
      if (/piliang|批量/.test(hay)) return 'batch';
      return 'unknown';
    },

    /**
     * 跨根查找媒体元素。
     *
     * 为什么需要：CQU 的 AI 学习空间 / 课件页会把播放器放进 shadow DOM
     * 或同源 iframe 里（`fromProIframe=1` 就是这个场景）。只在顶层
     * document.querySelector('video') 查会什么都找不到 —— 上游脚本在这种
     * 页面上的表现就是「一直卡住不播放」。
     *
     * 遍历顺序：先顶层 document（最快路径），再 shadow root，最后同源 iframe。
     * 同源限制导致的跨域 iframe 会读 contentDocument 抛错，直接跳过。
     */
    find() {
      const direct = this._pick(document);
      if (direct) return direct;
      for (const root of this.roots()) {
        const hit = this._pick(root);
        if (hit) return hit;
      }
      return { el: null, kind: null, root: null };
    },

    _pick(root) {
      if (!root || !root.querySelector) return null;
      let v = null;
      let a = null;
      try {
        v = root.querySelector('video');
        if (!v) a = root.querySelector('audio');
      } catch (_) {
        return null;
      }
      if (v) return { el: v, kind: 'video', root: this._describeRoot(root) };
      if (a) return { el: a, kind: 'audio', root: this._describeRoot(root) };
      return null;
    },

    _describeRoot(root) {
      if (root === document) return 'document';
      if (root.host) return `shadow(${root.host.tagName?.toLowerCase() || '?'})`;
      return 'iframe';
    },

    /** 枚举全部可穿透的根：shadow root（含嵌套）+ 同源 iframe document（含嵌套） */
    roots() {
      const out = [];
      const seen = new WeakSet();
      const walk = (root, depth) => {
        if (!root || depth > 4) return;
        let nodes;
        try {
          nodes = root.querySelectorAll('*');
        } catch (_) {
          return;
        }
        for (const el of nodes) {
          // shadow root
          if (el.shadowRoot && !seen.has(el.shadowRoot)) {
            seen.add(el.shadowRoot);
            out.push(el.shadowRoot);
            walk(el.shadowRoot, depth + 1);
          }
          // 同源 iframe
          if (el.tagName === 'IFRAME') {
            let doc = null;
            try {
              doc = el.contentDocument;
            } catch (_) {
              continue; // 跨域，跳过
            }
            if (doc && !seen.has(doc)) {
              seen.add(doc);
              out.push(doc);
              walk(doc, depth + 1);
            }
          }
        }
      };
      walk(document, 0);
      return out;
    },

    /** 找到承载媒体的 iframe 元素（用于上报 / 诊断） */
    findHostIframe(el) {
      if (!el) return null;
      try {
        const win = el.ownerDocument?.defaultView;
        if (!win || win === window) return null;
        return [...document.querySelectorAll('iframe')].find(f => {
          try {
            return f.contentWindow === win;
          } catch (_) {
            return false;
          }
        }) || null;
      } catch (_) {
        return null;
      }
    },
  };

  const Player = {
    // 静音强制状态：true 时持续把媒体压回 muted，直到 unmute() 被调用
    _muted: false,
    _muteTimer: null,
    _muteVolumeHandler: null,

    isNearEnd(media, threshold = 1) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      const currentTime = Number(media.currentTime || 0);
      return Number.isFinite(duration) && duration > 1 && currentTime > 0 && duration - currentTime <= threshold;
    },

    /**
     * 启动播放，并处理浏览器的自动播放拦截。
     *
     * 关键点：静音后 Chrome 允许无手势自动播放，所以先静音再 play()。
     * 万一仍被拦截（Firefox / Safari 策略更严），挂一次性用户手势监听 ——
     * 用户点一下页面任意位置就自动开始，不需要再点一次「开始刷课」。
     */
    async kickstart(media) {
      if (!media) return false;
      this.mute(media);

      const attempt = async () => {
        try {
          await media.play();
          return !media.paused;
        } catch (_) {
          return false;
        }
      };

      if (await attempt()) return true;

      Actions.log('浏览器拦截了自动播放，点一下页面任意位置即可开始（只需一次）');
      return new Promise(resolve => {
        let settled = false;
        const once = async () => {
          if (settled) return;
          settled = true;
          cleanup();
          const okPlay = await attempt();
          resolve(okPlay);
        };
        const cleanup = () => {
          document.removeEventListener('click', once, true);
          document.removeEventListener('keydown', once, true);
          document.removeEventListener('touchstart', once, true);
        };
        document.addEventListener('click', once, true);
        document.addEventListener('keydown', once, true);
        document.addEventListener('touchstart', once, true);
        // 15s 内没有手势就放弃等待，交回主流程
        setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(false);
        }, 15000);
      });
    },

    /**
     * 后台保活：定期发出轻微鼠标活动 + 阻止页面因失焦被标记。
     * 雨课堂有「切屏/挂机检测」，后台播放时这是最容易踩的坑。
     */
    keepAlive() {
      const targets = [document, document.body].filter(Boolean);
      const fire = () => {
        for (const t of targets) {
          try {
            const ev = new MouseEvent('mousemove', {
              bubbles: true, cancelable: true, clientX: 5, clientY: 5,
            });
            t.dispatchEvent(ev);
          } catch (_) { /* ignore */ }
        }
      };
      // 立即来一次，之后每 20s 一次
      fire();
      const timer = setInterval(fire, 20000);
      return () => clearInterval(timer);
    },

    /** 倍速：优先驱动 xt 播放器 UI（上游做法），否则直接改 playbackRate */
    applySpeed(rate) {
      const r = rate || Store.getFeatureConf().rate || Config.playbackRate;
      const speedBtnRes = Resolve.one(['xt-speedlist xt-button', 'xt-speedlist > * > *']);
      const speedWrap = Resolve.one(DOM.speedButton);
      if (speedBtnRes.node && speedWrap.node) {
        const btn = speedBtnRes.node;
        btn.setAttribute('data-speed', r);
        btn.setAttribute('keyt', `${r}.00`);
        btn.innerText = `${r}.00X`;
        try {
          const ev = document.createEvent('MouseEvent');
          ev.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
          speedWrap.node.dispatchEvent(ev);
        } catch (_) { /* ignore */ }
        btn.click();
      }
      // 无论如何都直接设置一次，双重保险
      const m = Media.find().el;
      if (m) {
        try {
          m.playbackRate = r;
        } catch (_) { /* ignore */ }
      }
      // 兜底：周期性纠正被站点改回的倍速
      if (!this._rateTimer) {
        this._rateTimer = setInterval(() => {
          const media = Media.find().el;
          if (media && Math.abs(media.playbackRate - r) > 0.01) {
            try {
              media.playbackRate = r;
            } catch (_) { /* ignore */ }
          }
        }, 5000);
      }
    },

    /**
     * 静音。
     *
     * 为什么不用「点播放器音量按钮」那套（上游做法）：
     *   1. 音量按钮的选择器依赖具体播放器 DOM，站点改版就失效 —— 静默失败；
     *   2. 更糟的是，**在已静音状态下点它是切换**，会把声音反而打开；
     *   3. 播放器（如 xt-* 自定义元素）会在用户交互 / 切清晰度时
     *      自行把 volume 重置回去，只设一次必然失效。
     *
     * 所以改为：直接设媒体属性 + 持续强制 + 事件即时纠正。
     * 三重保障，且不依赖任何 DOM 结构。
     */
    mute(media) {
      this._muted = true;

      const apply = el => {
        try {
          // 先设 muted 属性：这是唯一能压住 volume 的开关
          el.muted = true;
          el.volume = 0;
          // 部分播放器有独立的属性，一并清掉
          el.removeAttribute?.('volume');
        } catch (_) { /* ignore */ }
      };

      // 立即对当前媒体生效
      apply(media || Media.find().el);

      // 1) 立即纠正播放器的重置：监听 volumechange
      //    站点一旦把音量改回去，事件触发时我们马上再静音
      if (!this._muteVolumeHandler) {
        this._muteVolumeHandler = e => {
          if (!this._muted) return;
          const el = e.target;
          if (!el || el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') return;
          if (!el.muted || el.volume !== 0) apply(el);
        };
      }
      document.addEventListener('volumechange', this._muteVolumeHandler, true);

      // 2) 定时兜底：防止 volumechange 被播放器拦截或未派发
      if (!this._muteTimer) {
        this._muteTimer = setInterval(() => {
          if (!this._muted) return;
          const el = Media.find().el;
          if (el && (!el.muted || el.volume !== 0)) apply(el);
        }, 1000);
      }
    },

    /** 解除静音并清理强制逻辑（用户手动停止时调用） */
    unmute() {
      this._muted = false;
      if (this._muteTimer) {
        clearInterval(this._muteTimer);
        this._muteTimer = null;
      }
      if (this._muteVolumeHandler) {
        document.removeEventListener('volumechange', this._muteVolumeHandler, true);
        this._muteVolumeHandler = null;
      }
      const el = Media.find().el;
      if (el) {
        try {
          el.muted = false;
        } catch (_) { /* ignore */ }
      }
    },

    applyMediaDefault(media, rate) {
      if (!media) return;
      const r = rate || Store.getFeatureConf().rate || Config.playbackRate;
      // 静音优先于其它设置：否则自动播放可能被浏览器拦截
      this.mute(media);
      try {
        media.playbackRate = r;
      } catch (_) { /* ignore */ }
      media.play().catch(() => { /* 交给 observePause 兜底 */ });
    },

    /**
     * 反暂停观察者。
     * 三重保险：play() 自愈 + pause 事件 + 定时兜底 + 播放器 UI 提示文本观察。
     */
    observePause(media, shouldResume = () => true) {
      if (!media) return () => {};
      const canResume = () => shouldResume() && !media.ended && !this.isNearEnd(media);

      const tryPlay = () => {
        if (!canResume()) return;
        media.play().catch(e => {
          if (!canResume()) return;
          /* eslint-disable-next-line no-console */
          console.warn('[CQU雨课堂] 自动播放失败，3s 后重试:', e?.message || e);
          setTimeout(tryPlay, 3000);
        });
      };
      tryPlay();

      const onPause = () => {
        if (canResume()) tryPlay();
      };
      media.addEventListener('pause', onPause);

      const timer = setInterval(() => {
        if (media.paused && canResume()) tryPlay();
      }, 5000);

      // 播放器 UI：按钮被点成「播放」时强行恢复
      const tipRes = Resolve.one(DOM.playTip);
      let observer = null;
      if (tipRes.node) {
        observer = new MutationObserver(() => {
          if (Utils.normalized(tipRes.node.innerText) === '播放' && canResume()) tryPlay();
        });
        observer.observe(tipRes.node, { childList: true, characterData: true, subtree: true });
      }

      return () => {
        media.removeEventListener('pause', onPause);
        clearInterval(timer);
        if (observer) observer.disconnect();
      };
    },

    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    },

    /**
     * 统一「播完」等待：进度文本 与 ended 事件 双通道，谁先到算谁。
     * 这是相对上游的实质改进 —— 上游只等进度文本，文本选择器一漂移就死等超时。
     */
    async waitUntilDone(media, { onTick, timeout } = {}) {
      const limit = timeout || await Utils.getMediaTimeout();
      const start = Date.now();
      let done = false;
      const onEnded = () => {
        done = true;
      };
      if (media) media.addEventListener('ended', onEnded, { once: true });

      try {
        while (Date.now() - start < limit) {
          if (onTick) onTick();
          const popup = await Utils.dismissPopups();
          if (popup) Actions.log(`已关闭挂机弹窗（${popup}）`);

          if (done || (media && media.ended)) return true;

          const marker = Resolve.completionMarker();
          if (marker.done) return true;

          // 时间显示相等也视为播完（部分播放器不派发 ended）
          const timeRes = Resolve.one(DOM.timeDisplay);
          if (timeRes.node) {
            const [now, total] = Utils.normalized(timeRes.node.innerText).split('/').map(s => s.trim());
            if (now && total && now === total) return true;
          }

          await Utils.sleep(800);
        }
        return false;
      } finally {
        if (media) media.removeEventListener('ended', onEnded);
      }
    },
  };

  /* ==========================================================================
   * 8. 防切屏
   *
   * 上游做法：拦截 visibilitychange / blur / pagehide 的监听注册。
   * 保留，但仅在 pro 路线启用，并整体 try/catch（部分浏览器不允许覆写）。
   * ========================================================================== */

  function preventScreenCheck() {
    try {
      const win = unsafeWindow;
      const blacklist = new Set(['visibilitychange', 'blur', 'pagehide', 'webkitvisibilitychange']);
      const originalAdd = win.EventTarget.prototype.addEventListener;
      const originalRemove = win.EventTarget.prototype.removeEventListener;

      win.EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (blacklist.has(type) && (this === win.document || this === win)) {
          return;
        }
        return originalAdd.call(this, type, listener, options);
      };
      win.EventTarget.prototype.removeEventListener = function (type, listener, options) {
        if (blacklist.has(type) && (this === win.document || this === win)) {
          return;
        }
        return originalRemove.call(this, type, listener, options);
      };

      // 伪造成「始终可见且聚焦」
      try {
        Object.defineProperty(win.document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(win.document, 'hidden', { get: () => false, configurable: true });
        win.document.hasFocus = () => true;
      } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
  }

  /* ==========================================================================
   * 9. AI 解题
   * ========================================================================== */

  const Solver = {
    /**
     * 识别题面文本。
     *
     * 分两级：
     *   1. OCR（html2canvas 截图 + Tesseract 识别）—— 需要时**懒加载**，不阻塞脚本启动；
     *   2. 纯文本兜底 —— 直接读 innerText，覆盖绝大多数文字题 / 判断题。
     *
     * 注意：OCR 的 CDN 在国内经常连不上。加载失败只是退化成纯文本模式，
     * 不影响视频播放功能（只播放视频根本不会走到这里）。
     */
    async recognize(element, panel) {
      if (!element) return '';

      const fallbackText = Utils.normalized(element.innerText);

      // 懒加载依赖；失败就用纯文本
      const [hasCanvas, hasOcr] = await Promise.all([
        Utils.ensureHtml2Canvas(),
        Utils.ensureTesseract(),
      ]);
      if (!hasCanvas || !hasOcr) {
        if (panel) panel.log('OCR 依赖加载失败（CDN 不可达），已降级为纯文本模式');
        return fallbackText;
      }

      try {
        const canvas = await window.html2canvas(element, { backgroundColor: '#fff', scale: 2, logging: false });
        const dataUrl = canvas.toDataURL('image/png');
        const { data } = await window.Tesseract.recognize(dataUrl, 'chi_sim+eng');
        return Utils.normalized(data?.text || '') || fallbackText;
      } catch (e) {
        if (panel) panel.log(`OCR 失败，退回文本模式：${e?.message || e}`);
        return fallbackText;
      }
    },

    askAI(questionText, optionCount = 4) {
      const saved = Store.getAIConf();
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';

      if (!API_KEY || API_KEY === 'sk-xxxxxxx') {
        return Promise.reject(new Error('请在 [AI配置] 中填写有效的 API Key'));
      }

      const maxChar = String.fromCharCode(65 + Math.max(optionCount, 1) - 1);
      const range = optionCount > 0 ? `A-${maxChar}` : 'A-D';
      const prompt = [
        '以下是一道题目，请给出正确答案。',
        `如果是选择题，只输出选项字母（范围 ${range}，多选直接连写，如 ABD）。`,
        '如果是判断题，只输出「对」或「错」。',
        '不要输出任何解释、标点或多余文字。',
        '',
        '题目内容：',
        questionText,
      ].join('\n');

      const systemPrompt = '你是一个只输出答案的助手。判断题输出\'对\'或\'错\'，选择题输出字母。';

      const isAnthropic = API_FORMAT === 'anthropic' || API_URL.includes('api.anthropic.com');
      const authHeader = AUTH_METHOD === 'x-api-key'
        ? { 'x-api-key': API_KEY }
        : { Authorization: `Bearer ${API_KEY}` };

      return new Promise((resolve, reject) => {
        const handle = res => {
          try {
            const json = JSON.parse(res.responseText);
            let answerText = '';
            if (isAnthropic) {
              answerText = json.content?.[0]?.text || json.choices?.[0]?.message?.content || '';
            } else {
              answerText = json.choices?.[0]?.message?.content || json.content?.[0]?.text || '';
            }
            if (!answerText) return reject(new Error('AI 返回内容为空'));
            return resolve(answerText.trim());
          } catch (e) {
            return reject(new Error(`解析 AI 响应失败：${e.message}`));
          }
        };

        const fail = res => reject(new Error(`请求失败: HTTP ${res.status} - ${String(res.responseText).slice(0, 200)}`));

        if (isAnthropic) {
          const body = {
            model: MODEL_NAME,
            max_tokens: 64,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          };
          if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
              method: 'POST',
              url: API_URL,
              headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeader },
              data: JSON.stringify(body),
              onload: res => (res.status >= 200 && res.status < 300 ? handle(res) : fail(res)),
              onerror: () => reject(new Error('网络错误')),
            });
          } else {
            fetch(API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeader },
              body: JSON.stringify(body),
            }).then(async r => {
              const text = await r.text();
              if (!r.ok) return reject(new Error(`请求失败: HTTP ${r.status} - ${text.slice(0, 200)}`));
              handle({ status: r.status, responseText: text });
            }).catch(e => reject(new Error(`网络错误：${e.message}`)));
          }
          return;
        }

        const body = {
          model: MODEL_NAME,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
        };
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers: { 'Content-Type': 'application/json', ...authHeader },
            data: JSON.stringify(body),
            onload: res => (res.status >= 200 && res.status < 300 ? handle(res) : fail(res)),
            onerror: () => reject(new Error('网络错误')),
          });
        } else {
          fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify(body),
          }).then(async r => {
            const text = await r.text();
            if (!r.ok) return reject(new Error(`请求失败: HTTP ${r.status} - ${text.slice(0, 200)}`));
            handle({ status: r.status, responseText: text });
          }).catch(e => reject(new Error(`网络错误：${e.message}`)));
        }
      });
    },

    /** 解析 AI 答案文本 -> 选项下标数组 */
    parseAnswer(aiResponse, optionCount) {
      const text = String(aiResponse || '');
      const letterMatch = text.match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，、]\s*[A-F]+)*)/i)
        || text.match(/^[\s]*([A-F]+)[\s。.！!]*$/);
      const map = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

      if (letterMatch) {
        const letters = letterMatch[1].replace(/[,，、\s]/g, '').toUpperCase().split('');
        const idx = letters.map(c => map[c]).filter(i => Number.isInteger(i) && i < Math.max(optionCount, 1));
        if (idx.length) return idx;
      }

      if (/正确|对|√|T\b/i.test(text) && !/错误|不对|错/.test(text)) return [0];
      if (/错误|错|×|F\b/i.test(text)) return [1];
      return [];
    },

    /** 选项 + 提交 */
    async autoSelectAndSubmit(aiResponse, itemBodyElement) {
      if (!itemBodyElement) throw new Error('题目容器为空');
      const listRes = Resolve.within(itemBodyElement, DOM.optionList);
      const list = listRes.node;
      if (!list) throw new Error('未找到选项列表');

      const options = [...list.querySelectorAll(DOM.optionItem.join(','))];
      const targets = this.parseAnswer(aiResponse, options.length);
      if (!targets.length) throw new Error(`无法从 AI 回复解析出答案：${String(aiResponse).slice(0, 60)}`);

      for (const idx of targets) {
        const opt = options[idx];
        if (!opt) continue;
        const clickable = opt.querySelector('label.el-radio, label, input, .el-radio__input, [class*="radio"]') || opt;
        clickable.click();
        await Utils.sleep(250);
      }
      Actions.log(`已选中 ${targets.map(i => String.fromCharCode(65 + i)).join('')}`);

      await Utils.sleep(500);
      // 找「提交/保存」按钮
      const ownerDoc = itemBodyElement.ownerDocument || document;
      const roots = [itemBodyElement.parentElement, itemBodyElement, ownerDoc].filter(Boolean);
      let submitBtn = null;
      for (const root of roots) {
        const btns = [...root.querySelectorAll(DOM.submitButton.join(','))];
        submitBtn = btns.find(b => /提交|保存|确认|确定/.test(b.innerText || '') && !b.disabled && !b.classList.contains('is-disabled'));
        if (submitBtn) break;
      }
      if (submitBtn) {
        submitBtn.click();
        Actions.log('已提交答案');
      } else {
        Actions.log('未找到提交按钮（可能自动保存）');
      }
      return true;
    },
  };

  /* ==========================================================================
   * 10. UI 面板
   *
   * 设计约束（重大蓝白，克制大气）：
   *   - 单一强调色：重大蓝 #0B4F9E，只用于主操作与选中态，不做装饰性着色
   *   - 中性色阶统一偏冷（#0F172A / #475569 / #94A3B8 / #E2E8F0 / #F8FAFC）
   *   - 圆角锁定一套：面板/卡片 12px，控件 8px，不混用
   *   - 阴影带蓝调（不用纯黑投影），克制到几乎看不见
   *   - 界面无 emoji 装饰，状态语义靠左侧色条表达
   *   - 所有正文/按钮对比度 ≥ WCAG AA 4.5:1
   * ========================================================================== */

  const THEME = {
    primary: '#0B4F9E',       // 重大蓝
    primaryDark: '#083B77',
    primarySoft: '#EAF2FB',
    ink: '#0F172A',
    body: '#475569',
    muted: '#94A3B8',
    line: '#E2E8F0',
    surface: '#FFFFFF',
    canvas: '#F8FAFC',
    ok: '#15803D',
    warn: '#B45309',
    error: '#B91C1C',
  };

  function createPanel() {
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, {
      position: 'fixed',
      top: '40px',
      left: '40px',
      width: '520px',
      height: '400px',
      zIndex: '999999',
      border: `1px solid ${THEME.line}`,
      borderRadius: '12px',
      background: THEME.surface,
      overflow: 'hidden',
      // 带蓝调的柔和投影，避免纯黑投影的廉价感
      boxShadow: '0 12px 32px -8px rgba(11,79,158,0.18), 0 2px 8px -2px rgba(15,23,42,0.06)',
    });
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'cqu-ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) throw new Error('面板挂载点不存在');
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
      :root{
        --primary:${THEME.primary}; --primary-dark:${THEME.primaryDark}; --primary-soft:${THEME.primarySoft};
        --ink:${THEME.ink}; --body:${THEME.body}; --muted:${THEME.muted};
        --line:${THEME.line}; --surface:${THEME.surface}; --canvas:${THEME.canvas};
        --ok:${THEME.ok}; --warn:${THEME.warn}; --error:${THEME.error};
        --r-panel:12px; --r-control:8px;
      }
      *{box-sizing:border-box}
      html,body{
        overflow:hidden;margin:0;padding:0;background:transparent;
        font-family:"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
        color:var(--body);-webkit-font-smoothing:antialiased;
      }

      /* ---- 最小化态 ---- */
      .mini{
        position:absolute;inset:0;display:none;align-items:center;justify-content:center;
        background:var(--primary);color:#fff;border-radius:var(--r-panel);
        font-size:13px;font-weight:600;letter-spacing:.04em;cursor:pointer;user-select:none;
      }
      .mini.show{display:flex}
      .mini:hover{background:var(--primary-dark)}

      /* ---- 面板 ---- */
      .panel{
        width:100%;height:100%;background:var(--surface);border-radius:var(--r-panel);
        display:flex;flex-direction:column;overflow:hidden;position:relative;
      }
      /* 顶部 3px 强调条：唯一的装饰性用色 */
      .panel::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--primary);z-index:2}

      /* ---- 标题栏 ---- */
      .header{
        flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;
        height:46px;padding:0 12px 0 14px;margin-top:3px;
        background:var(--surface);border-bottom:1px solid var(--line);
        cursor:move;user-select:none;
      }
      .brand{display:flex;align-items:center;gap:9px;min-width:0}
      .brand-mark{
        width:22px;height:22px;border-radius:6px;background:var(--primary);color:#fff;
        display:flex;align-items:center;justify-content:center;
        font-size:11px;font-weight:700;letter-spacing:.02em;flex:0 0 auto;
      }
      .brand-text{display:flex;flex-direction:column;min-width:0}
      .brand-title{font-size:13px;font-weight:600;color:var(--ink);line-height:1.25;white-space:nowrap}
      .brand-sub{font-size:10.5px;color:var(--muted);line-height:1.25;white-space:nowrap;letter-spacing:.01em}

      .tools{display:flex;align-items:center;gap:2px;flex:0 0 auto}
      .tool{
        width:24px;height:24px;border:0;background:transparent;border-radius:6px;
        color:var(--muted);cursor:pointer;font-size:13px;line-height:1;
        display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s;
      }
      .tool:hover{background:var(--canvas);color:var(--primary)}

      /* ---- 日志区 ---- */
      .body{flex:1 1 auto;overflow-y:auto;padding:10px 12px;background:var(--surface)}
      .info{margin:0;padding:0;list-style:none}
      .info li{
        font-size:12px;line-height:1.6;color:var(--body);
        padding:2px 0 2px 9px;border-left:2px solid var(--line);
        margin-bottom:3px;word-break:break-word;
      }
      .info li.ok{border-left-color:var(--ok);color:#14532D}
      .info li.warn{border-left-color:var(--warn);color:#78350F}
      .info li.err{border-left-color:var(--error);color:#7F1D1D}
      .info li.rule{border:0;padding:6px 0 2px;color:var(--muted);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase}
      .info::-webkit-scrollbar{width:8px}
      .info::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
      .body::-webkit-scrollbar{width:8px}
      .body::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
      .body::-webkit-scrollbar-thumb:hover{background:var(--muted)}

      /* ---- 设置抽屉 ---- */
      #settings{
        display:none;position:absolute;top:49px;left:0;right:0;bottom:57px;
        background:var(--surface);z-index:9;padding:14px 16px;overflow-y:auto;
        border-bottom:1px solid var(--line);
      }
      #settings::-webkit-scrollbar{width:8px}
      #settings::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
      .field{margin-bottom:12px}
      .field label{display:block;font-size:11px;font-weight:600;color:var(--ink);margin-bottom:5px;letter-spacing:.01em}
      .field input[type=text],.field input[type=password],.field input[type=number],.field select{
        width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:var(--r-control);
        font-size:12px;color:var(--ink);background:var(--surface);font-family:inherit;
        transition:border-color .12s,box-shadow .12s;
      }
      .field input::placeholder{color:var(--muted)}
      .field input:focus,.field select:focus{
        outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft);
      }
      .field .hint{font-size:10.5px;color:var(--muted);margin-top:4px;line-height:1.5}
      .check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--body);cursor:pointer;padding:3px 0}
      .check input{width:14px;height:14px;accent-color:var(--primary);margin:0;cursor:pointer}
      .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .settings-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}

      /* ---- 底部操作栏 ---- */
      .footer{
        flex:0 0 auto;display:flex;align-items:center;gap:6px;
        padding:9px 12px;background:var(--canvas);border-top:1px solid var(--line);
      }
      .btn{
        border:1px solid transparent;border-radius:var(--r-control);background:transparent;
        font-family:inherit;font-size:12px;font-weight:500;color:var(--body);
        padding:7px 11px;cursor:pointer;white-space:nowrap;
        transition:background .12s,border-color .12s,color .12s,transform .06s;
      }
      .btn:hover{background:var(--surface);border-color:var(--line);color:var(--ink)}
      .btn:active{transform:translateY(1px)}
      .btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
      .btn-primary{
        background:var(--primary);color:#fff;border-color:var(--primary);
        font-weight:600;padding:7px 16px;margin-left:auto;
      }
      .btn-primary:hover{background:var(--primary-dark);border-color:var(--primary-dark);color:#fff}
      .btn-primary:disabled{background:var(--muted);border-color:var(--muted);cursor:default;transform:none}
      .btn-quiet{color:var(--muted)}
      .btn-quiet:hover{color:var(--error);border-color:var(--line)}
    </style></head><body>
      <div class="mini" id="mini">展开</div>
      <div class="panel" id="panel">
        <div class="header" id="header">
          <div class="brand">
            <div class="brand-mark">CQU</div>
            <div class="brand-text">
              <span class="brand-title">雨课堂助手</span>
              <span class="brand-sub">courses.cqu.edu.cn</span>
            </div>
          </div>
          <div class="tools">
            <button class="tool" id="minimality" title="最小化">&#8211;</button>
            <button class="tool" id="question" title="关于">?</button>
          </div>
        </div>

        <div class="body" id="body">
          <ul class="info" id="info"></ul>
        </div>

        <div id="settings">
          <div class="field">
            <label for="ai_url">API 地址</label>
            <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
          </div>
          <div class="field">
            <label for="ai_key">API Key</label>
            <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
            <div class="hint">仅保存在本机浏览器，不会上传</div>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="ai_model">模型</label>
              <input type="text" id="ai_model" placeholder="deepseek-chat">
            </div>
            <div class="field">
              <label for="playback_rate">播放倍速</label>
              <input type="number" id="playback_rate" min="1" max="4" step="0.25">
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="ai_format">接口格式</label>
              <select id="ai_format">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div class="field">
              <label for="auth_method">鉴权方式</label>
              <select id="auth_method">
                <option value="bearer">Bearer</option>
                <option value="x-api-key">x-api-key</option>
              </select>
            </div>
          </div>
          <div class="field" style="margin-bottom:6px">
            <label class="check"><input type="checkbox" id="feature_auto_ai">AI 自动作答（作业 / 题目）</label>
            <label class="check"><input type="checkbox" id="feature_auto_comment">批量区图文 / 讨论自动回复</label>
          </div>
          <div class="settings-footer">
            <button class="btn" id="close_settings">取消</button>
            <button class="btn btn-primary" id="save_settings" style="margin-left:0">保存</button>
          </div>
        </div>

        <div class="footer">
          <button class="btn" id="btn-diag">诊断</button>
          <button class="btn" id="btn-setting">配置</button>
          <button class="btn" id="btn-reload">重载</button>
          <button class="btn btn-quiet" id="btn-clear">清除</button>
          <button class="btn btn-quiet" id="btn-stop">停止</button>
          <button class="btn btn-primary" id="btn-start">开始刷课</button>
        </div>
      </div>
    </body></html>`);
    doc.close();

    const $ = id => doc.getElementById(id);
    const ui = {
      iframe, doc,
      panel: $('panel'), header: $('header'), info: $('info'), body: $('body'),
      btnStart: $('btn-start'), btnClear: $('btn-clear'), btnSetting: $('btn-setting'),
      btnStop: $('btn-stop'), btnReload: $('btn-reload'), btnDiag: $('btn-diag'),
      settings: $('settings'), saveSettings: $('save_settings'), closeSettings: $('close_settings'),
      aiUrlInput: $('ai_url'), aiKeyInput: $('ai_key'), aiModelInput: $('ai_model'),
      aiFormatSelect: $('ai_format'), authMethodSelect: $('auth_method'),
      rateInput: $('playback_rate'),
      featureAutoAI: $('feature_auto_ai'), featureAutoComment: $('feature_auto_comment'),
      minimality: $('minimality'), question: $('question'), miniBasic: $('mini'),
    };
    // ---- 拖拽 ----
    let isDragging = false;
    let startX = 0; let startY = 0; let startLeft = 0; let startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      if (e.target && e.target.closest && e.target.closest('.tools')) return;
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mouseup', stopDrag);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    // ---- 最小化 ----
    const normalSize = { width: 540, height: 380 };
    const miniSize = 64;
    let isMinimized = false;
    ui.minimality.addEventListener('click', () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    });
    ui.miniBasic.addEventListener('click', () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    });

    ui.question.addEventListener('click', () => {
      hostWindow.alert(
        'CQU 雨课堂刷课助手（研究适配版）\n\n'
        + '站点：courses.cqu.edu.cn（雨课堂专业版）\n'
        + '思路源自 Niuwh/yuketang-jiaoben (GPL-3.0)\n\n'
        + '仅供学习交流，请合理使用。'
      );
    });

    // ---- 日志 ----
    // 状态语义靠 CSS 类的左侧色条表达，不再用 emoji 装饰
    const append = (message, kind = '') => {
      const li = doc.createElement('li');
      li.innerText = message;
      if (kind) li.className = kind;
      ui.info.appendChild(li);
      // 同步进诊断导出缓冲，方便一键把所有日志随身带走
      Diag.logBuffer.push(`[${new Date().toLocaleTimeString()}] ${message}`);
      if (Diag.logBuffer.length > 300) Diag.logBuffer.shift();
      // 只在用户没往上翻的时候自动滚到底，避免打断回看日志
      const nearBottom = ui.body.scrollHeight - ui.body.scrollTop - ui.body.clientHeight < 60;
      if (nearBottom) {
        try {
          li.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
        } catch (_) { /* ignore */ }
      }
      // 防止日志无限膨胀导致面板卡顿
      while (ui.info.childElementCount > 500) ui.info.removeChild(ui.info.firstElementChild);
    };
    const log = m => append(m);
    const warn = m => append(m, 'warn');
    const error = m => append(m, 'err');
    const ok = m => append(m, 'ok');
    const rule = m => append(m, 'rule');

    // ---- 配置读写 ----
    const defaultAI = {
      url: 'https://api.deepseek.com/chat/completions',
      key: 'sk-xxxxxxx',
      model: 'deepseek-chat',
      apiFormat: 'openai',
      authMethod: 'bearer',
    };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
      ui.aiFormatSelect.value = saved.apiFormat || defaultAI.apiFormat;
      ui.authMethodSelect.value = saved.authMethod || defaultAI.authMethod;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = !!saved.autoAI;
      ui.featureAutoComment.checked = !!saved.autoComment;
      ui.rateInput.value = saved.rate ?? Config.playbackRate;
    };
    loadAIConf();
    loadFeatureConf();

    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    ui.saveSettings.onclick = () => {
      Store.setAIConf({
        url: ui.aiUrlInput.value.trim(),
        key: ui.aiKeyInput.value.trim(),
        model: ui.aiModelInput.value.trim(),
        apiFormat: ui.aiFormatSelect.value,
        authMethod: ui.authMethodSelect.value,
      });
      let rate = parseFloat(ui.rateInput.value);
      if (!Number.isFinite(rate) || rate < 1 || rate > 4) rate = Config.playbackRate;
      Store.setFeatureConf({
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked,
        rate,
      });
      ui.settings.style.display = 'none';
      ok(`配置已保存（倍速 ${rate}x）`);
    };

    ui.btnClear.onclick = () => {
      Store.clearAll();
      ok('已清除刷课进度与跳转缓存');
    };

    ui.btnDiag.onclick = async () => {
      const report = Diag.print();
      rule('诊断结果');
      log(`路由：${JSON.stringify(report['路由'])}`);

      // 区分「本页不该有」和「本该有却没有」，避免一堆正常的未命中吓到使用者
      const miss = report['契约'].filter(r => r.note !== 'OK').map(r => r.name);
      const critical = miss.filter(n => CRITICAL_CONTRACTS.includes(n));
      const optional = miss.filter(n => !CRITICAL_CONTRACTS.includes(n));

      if (critical.length) {
        warn(`关键契约未命中：${critical.join(', ')} —— 这会影响自动播放`);
      } else {
        ok('关键契约全部命中（媒体查找 / 进度判定可用）');
      }
      if (optional.length) {
        log(`其余未命中（本页类型通常不需要，可忽略）：${optional.join(', ')}`);
      }

      const media = report['媒体'];
      log(`媒体：类型=${media['类型']} 命中根=${media['命中根']} 承载iframe=${media['承载iframe']}`);
      if (media['状态']) {
        const s = media['状态'];
        log(`时长=${s.duration}s 当前=${s.currentTime}s 暂停=${s.paused} 倍速=${s.rate} readyState=${s.readyState}`);
      }
      log(`进度锚点：${report['当前进度锚点'] || '(无)'} → 完成=${report['判定完成']}（来源 ${report['锚点来源']}）`);

      const copied = await Diag.copy();
      if (copied) ok('完整诊断报告已复制到剪贴板（含日志），直接粘贴即可');
      else warn('复制失败，可到控制台执行 __CQU_DIAG_TEXT__() 获取报告');
    };

    ui.btnStop.onclick = () => {
      Store.clearPending();
      Actions.stop();
      Player.unmute();          // 解除静音强制，把声音还给用户
      log('已停止刷课，页面即将刷新');
      setTimeout(() => hostWindow.location.reload(), 400);
    };

    ui.btnReload.onclick = () => {
      Store.setPending(Route.classroomId());
      log('正在重载并恢复刷课...');
      setTimeout(() => hostWindow.location.reload(), 400);
    };

    // ---- 启动按钮 ----
    let startHandler = null;
    let running = false;
    const invokeStart = () => {
      if (running) {
        log('已在刷课中，忽略重复点击');
        return;
      }
      running = true;
      ui.btnStart.innerText = '刷课中';
      ui.btnStart.disabled = true;
      log('启动中...');
      if (startHandler) {
        Promise.resolve(startHandler()).catch(e => error(`运行异常：${e?.message || e}`));
      }
    };

    return {
      ...ui,
      log, warn, error, ok, rule,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnStart.onclick = invokeStart;
      },
      start() {
        invokeStart();
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
        const idle = text !== '刷课中...';
        if (idle) running = false;
        ui.btnStart.disabled = !idle;
      },
    };
  }

  /* ==========================================================================
   * 11. 运行器
   * ========================================================================== */

  /** 负责把日志/状态统一出口，避免各 Runner 直接依赖 panel 变量 */
  const Actions = {
    panel: null,
    log(m) {
      if (this.panel) this.panel.log(m);
      /* eslint-disable-next-line no-console */
      else console.log('[CQU雨课堂]', m);
    },
    warn(m) {
      if (this.panel) this.panel.warn(m);
      /* eslint-disable-next-line no-console */
      else console.warn('[CQU雨课堂]', m);
    },
    stopped: false,
    stop() {
      this.stopped = true;
    },
    reset() {
      this.stopped = false;
    },
  };

  const Runner = {
    labelOf(route) {
      if (!route) return '未知';
      if (route.kind === 'pro') return route.isCatalog ? '专业版目录页 (pro/lms)' : `专业版学习页 (pro/lms/${route.type})`;
      if (route.kind === 'v2') return route.isCatalog ? '旧版目录页 (v2/web/studentLog)' : '旧版课件页 (v2/web/studentCards)';
      if (route.kind === 'ai') {
        const leaf = route.type ? `/${route.type}/${route.leafId}` : '';
        return `AI学习空间 (ai-workspace/lms-graph/${route.classroomId || '?'}${leaf})`
          + (route.fromProIframe ? ' [专业版内嵌播放器]' : '');
      }
      if (route.kind === 'pro-ai') return '专业版AI学习空间 (pro-ai-workspace)';
      return '未知';
    },

    /** 找到当前页的「下一节」按钮并点击 */
    clickNext() {
      const { selector, node } = Resolve.one(DOM.nextButton);
      if (!node) return false;
      // 上游做法：先派发 mousemove 触发框架的 hover 逻辑，再点击
      try {
        const ev = new Event('mousemove', { bubbles: true });
        ev.clientX = 9999; ev.clientY = 9999;
        node.dispatchEvent(ev);
      } catch (_) { /* ignore */ }
      node.click();
      Actions.log(`已点击「下一节」（${selector}）`);
      return true;
    },
  };

  /* ---------------- pro 路线（CQU 主路线） ---------------- */

  class ProRunner {
    constructor(panel) {
      this.panel = panel;
      this.cursor = Store.getCursor();
      this.maxSteps = 500; // 防御性上限，避免死循环
    }

    leafNodes() {
      const { selector, nodes } = Resolve.all(DOM.leafList);
      this.leafSelector = selector;
      return nodes;
    }

    describeLeaf(node, index) {
      const icon = Resolve.within(node, DOM.leafIcon);
      const titleRes = Resolve.within(node, DOM.leafTitle);
      const statusRes = Resolve.within(node, DOM.leafStatus);
      const iconHref = icon.node?.getAttribute('xlink:href') || icon.node?.getAttribute('href') || '';
      const className = String(icon.node?.className || '');
      const title = Utils.normalized(titleRes.node?.innerText || node.innerText).slice(0, 60);
      const statusText = Utils.normalized(statusRes.node?.innerText || '');
      return {
        index,
        node,
        title: title || `第 ${index + 1} 项`,
        iconHref,
        className,
        statusText,
        type: Media.guessLeafType({ iconHref, className, text: `${title} ${statusText}` }),
      };
    }

    async run() {
      preventScreenCheck();
      this.panel.log(`路线：${Runner.labelOf(Route.current())}`);

      const route = Route.current();
      if (route && !route.isCatalog && route.leafId) {
        // 直接落在学习页：先接管播放，再回目录继续
        await this.handleLearningPage(route);
        return;
      }

      let step = 0;
      while (!Actions.stopped && step < this.maxSteps) {
        step++;
        await Utils.dismissPopups();
        const leaves = this.leafNodes();
        if (!leaves.length) {
          this.panel.warn('未找到课程目录节点，契约 leafList 全部未命中');
          this.panel.log('建议点 [诊断] 查看实际页面结构后反馈');
          this.panel.resetStartButton('开始刷课');
          return;
        }
        this.panel.log(`目录共 ${leaves.length} 项（契约：${this.leafSelector}），游标 ${this.cursor}`);

        if (this.cursor >= leaves.length) {
          this.panel.ok('全部处理完毕');
          this.panel.resetStartButton('已完成');
          Store.clearCursor();
          Store.clearPending();
          return;
        }

        const leaf = this.describeLeaf(leaves[this.cursor], this.cursor);

        // 跳过已完成
        if (Utils.isDone(leaf.statusText) && !Utils.isExplicitlyUndone(leaf.statusText)) {
          this.panel.ok(`${leaf.title} 已完成，跳过`);
          this.advanceCursor();
          continue;
        }

        this.panel.log(`[${this.cursor + 1}/${leaves.length}] ${leaf.type} · ${leaf.title}`);

        switch (leaf.type) {
          case 'video':
          case 'audio':
          case 'graph':
          case 'courseware':
            await this.openLeaf(leaf);
            break;
          case 'homework':
            await this.handleHomeworkLeaf(leaf);
            break;
          case 'batch':
            await this.handleBatchLeaf(leaf);
            break;
          case 'exam':
            this.panel.log('考试区域不自动作答，跳过');
            this.advanceCursor();
            break;
          case 'live':
            this.panel.log('直播/课堂不自动处理，跳过');
            this.advanceCursor();
            break;
          default:
            this.panel.log(`类型未识别（icon=${leaf.iconHref || '无'}），尝试按媒体打开`);
            await this.openLeaf(leaf);
            break;
        }
      }

      if (step >= this.maxSteps) {
        this.panel.warn(`已达单次运行上限 ${this.maxSteps} 步，已停止以防死循环`);
      }
      this.panel.resetStartButton('开始刷课');
    }

    advanceCursor() {
      this.cursor++;
      Store.setCursor(this.cursor);
    }

    /**
     * 打开一个叶子。
     * 可能是同页跳转，也可能是新标签页（上游用 pending + opener 处理）。
     */
    async openLeaf(leaf) {
      const before = location.href;
      leaf.node.click();
      // 等待可能的页面跳转
      await Utils.sleep(1500);

      if (location.href !== before) {
        return; // 发生了同页跳转，交给 handleLearningPage
      }
      // 未跳转：可能是新标签页打开了，本页停在此处
      await Utils.sleep(1500);
      if (location.href !== before) return;

      this.panel.warn(`${leaf.title} 点击后页面无变化，可能未成功打开`);
      this.advanceCursor();
    }

    /** 处理学习页（视频/音频/图文），完成后回目录 */
    async handleLearningPage(route) {
      this.panel.log(`学习页类型：${route.type || '未知'}`);

      if (route.type === 'homework' || route.type === 'exam') {
        this.panel.log(`${route.type} 页面不自动作答`);
        return;
      }

      const ready = await Utils.poll(() => Boolean(Media.find().el), { interval: 500, timeout: 20000 });
      const { el: media, kind } = Media.find();

      if (!ready || !media) {
        this.panel.log('未检测到媒体元素，按已完成处理并返回目录');
        await this.returnToCatalog();
        return;
      }

      this.panel.log(`接管 ${kind}：目标倍速 ${Store.getFeatureConf().rate}x，静音开启`);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(media);

      // 若当前已播完，直接返回
      const marker = Resolve.completionMarker();
      if (marker.done) {
        this.panel.ok(`当前内容已播完（${marker.text}）`);
        stopObserve();
        await this.returnToCatalog();
        return;
      }

      const finished = await Player.waitUntilDone(media, { timeout: await Utils.getMediaTimeout() });
      stopObserve();

      if (finished) {
        this.panel.ok('播放完成');
      } else {
        this.panel.warn('等待播放完成超时，仍继续下一步');
      }
      await this.returnToCatalog();
    }

    /** 回目录：优先点「下一节」，否则回目录 URL */
    async returnToCatalog() {
      if (Runner.clickNext()) {
        await Utils.sleep(2000);
        return;
      }
      const catalog = Route.catalogUrl();
      if (catalog && location.href !== catalog) {
        this.panel.log('未找到「下一节」，返回目录页继续');
        location.href = catalog;
        await Utils.sleep(1500);
        return;
      }
      this.panel.log('无法返回目录页，请手动确认');
      this.panel.resetStartButton('开始刷课');
    }

    /** 作业叶子 */
    async handleHomeworkLeaf(leaf) {
      const flags = Store.getFeatureConf();
      if (!flags.autoAI) {
        this.panel.log('AI 自动答题未开启，跳过作业');
        this.advanceCursor();
        return;
      }
      leaf.node.click();
      await Utils.sleep(2500);

      const { nodes: items } = Resolve.all(DOM.subjectItem);
      if (!items.length) {
        this.panel.warn('未找到题目（subjectItem 契约未命中），跳过');
        history.back();
        await Utils.sleep(1200);
        this.advanceCursor();
        return;
      }

      this.panel.log(`共 ${items.length} 题，开始 OCR + AI 作答`);
      for (let i = 0; i < items.length; i++) {
        if (Actions.stopped) return;
        const item = items[i];
        try {
          item.scrollIntoView({ behavior: 'smooth', block: 'center' });
          item.click();
          await Utils.sleep(1500);
        } catch (_) { /* ignore */ }

        const body = Resolve.one(['.item-body', '[class*="item-body"]', '.item-type']).node || item;
        const ocr = await Solver.recognize(body, this.panel);
        if (!ocr || ocr.length <= 5) {
          this.panel.log(`第 ${i + 1} 题文本过短，跳过`);
          continue;
        }
        for (let retry = 1; retry <= 3; retry++) {
          try {
            this.panel.log(`第 ${i + 1} 题请求 AI（第 ${retry} 次）`);
            const answer = await Solver.askAI(ocr, 4);
            await Solver.autoSelectAndSubmit(answer, body);
            break;
          } catch (e) {
            this.panel.warn(`第 ${i + 1} 题失败：${e?.message || e}`);
            if (retry < 3) await Utils.sleep(4000);
          }
        }
        await Utils.sleep(1200);
      }

      this.panel.ok('作业处理完毕');
      history.back();
      await Utils.sleep(1500);
      this.advanceCursor();
    }

    /** 批量区（父节点下挂着多个活动） */
    async handleBatchLeaf(leaf) {
      const expand = Resolve.within(leaf.node, DOM.expandButton);
      if (expand.node) {
        expand.node.click();
        await Utils.sleep(1500);
      }
      const items = Resolve.within(leaf.node, DOM.batchItem).nodes;
      if (!items.length) {
        this.panel.log('批量区未展开出子项，按普通节点跳过');
        this.advanceCursor();
        return;
      }
      this.panel.log(`批量区共 ${items.length} 个子项`);

      for (let i = 0; i < items.length; i++) {
        if (Actions.stopped) return;
        const sub = items[i];
        const icon = Resolve.within(sub, DOM.leafIcon);
        const iconHref = icon.node?.getAttribute('xlink:href') || '';
        const title = Utils.normalized(sub.querySelector('h2')?.innerText || sub.innerText).slice(0, 50);
        const statusText = Utils.normalized(Resolve.within(sub, DOM.leafStatus).node?.innerText || '');
        const type = Media.guessLeafType({ iconHref, text: `${title} ${statusText}` });

        if (Utils.isDone(statusText) && !Utils.isExplicitlyUndone(statusText)) {
          this.panel.ok(`${title} 已完成，跳过`);
          continue;
        }

        this.panel.log(`批量 [${i + 1}/${items.length}] ${type} · ${title}`);
        if (type === 'video' || type === 'audio' || type === 'courseware') {
          sub.click();
          await Utils.sleep(2500);
          const { el: media } = Media.find();
          if (media) {
            Player.applySpeed();
            Player.mute();
            const stop = Player.observePause(media);
            await Player.waitUntilDone(media);
            stop();
          } else {
            await Utils.poll(() => Resolve.completionMarker().done, { interval: 1000, timeout: 60000 });
          }
          history.back();
          await Utils.sleep(1500);
        } else if (type === 'graph' || type === 'forum') {
          await this.handleCommentItem(sub, type === 'graph' ? '图文' : '讨论');
        } else {
          this.panel.log('子项类型未知，跳过');
        }
      }
      this.advanceCursor();
    }

    async handleCommentItem(node, typeText) {
      const flags = Store.getFeatureConf();
      node.click();
      await Utils.sleep(1500);
      if (!flags.autoComment) {
        this.panel.log(`${typeText}已查看（未开启自动回复）`);
        history.back();
        await Utils.sleep(1200);
        return;
      }
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);

      let firstComment = '';
      for (let retry = 0; retry < 20 && !firstComment; retry++) {
        const { nodes } = Resolve.all(DOM.commentText);
        firstComment = Utils.normalized(nodes.find(n => n.innerText?.trim())?.innerText || '');
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log(`${typeText}未找到可复用评论，跳过`);
      } else {
        const input = Resolve.one(DOM.commentInput).node;
        if (input) {
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            input.value = firstComment;
          } else {
            input.innerText = firstComment;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = Resolve.all(DOM.commentSubmit).nodes
            .find(b => !b.disabled && !b.classList.contains('is-disabled'));
          if (sendBtn) {
            sendBtn.click();
            this.panel.ok(`已在${typeText}区发表评论`);
          } else {
            this.panel.warn('发送按钮不可用');
          }
        } else {
          this.panel.warn('未找到评论输入框');
        }
      }
      history.back();
      await Utils.sleep(1200);
    }
  }

  /* ---------------- v2 旧版路线 ---------------- */

  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href.split('?')[0];
      const saved = Store.getProgress(this.baseUrl);
      this.outside = saved.outside || 0;
      this.inside = saved.inside || 0;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async run() {
      this.panel.log(`路线：${Runner.labelOf(Route.current())}`);
      this.panel.log(`从第 ${this.outside + 1} 项继续`);

      if (location.pathname.includes('/studentCards/')) {
        const { el: media } = Media.find();
        if (media) {
          this.panel.log('检测到课件页，直接接管播放');
          Player.applySpeed();
          Player.mute();
          const stop = Player.observePause(media);
          await Player.waitUntilDone(media);
          stop();
          history.back();
          await Utils.sleep(1500);
        }
      }

      let guard = 0;
      while (!Actions.stopped && guard < 500) {
        guard++;
        const { selector, nodes: list } = Resolve.all(DOM.v2LogList);
        const items = list.length ? [...list[0].children] : [];
        if (!items.length) {
          this.panel.warn(`未找到课程列表（契约 v2LogList 未命中，当前：${selector || '无'}）`);
          this.panel.resetStartButton('开始刷课');
          return;
        }
        if (this.outside >= items.length) {
          this.panel.ok('课程已刷完');
          this.panel.resetStartButton('已完成');
          Store.removeProgress(this.baseUrl);
          Store.clearPending();
          return;
        }

        const itemRes = Resolve.within(items[this.outside], DOM.v2Item);
        const course = itemRes.node;
        if (!course) {
          this.panel.warn(`第 ${this.outside + 1} 项节点异常，跳过`);
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        const icon = Resolve.within(course, DOM.leafIcon);
        const iconHref = icon.node?.getAttribute('xlink:href') || '';
        const title = Utils.normalized(course.querySelector('h2')?.innerText || course.innerText).slice(0, 50);
        const statusText = Utils.normalized(Resolve.within(course, DOM.leafStatus).node?.innerText || '');
        const type = Media.guessLeafType({ iconHref, text: `${title} ${statusText}` });

        if (Utils.isDone(statusText) && !Utils.isExplicitlyUndone(statusText)) {
          this.panel.ok(`${title} 已完成，跳过`);
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`[${this.outside + 1}/${items.length}] ${type} · ${title}`);
        const before = location.href;
        course.click();
        await Utils.sleep(2500);

        if (location.href === before) {
          this.panel.warn('点击后页面无变化，跳过该项');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        return; // 已跳转到学习页，由新一轮 run() 接管
      }
      this.panel.resetStartButton('开始刷课');
    }
  }

  /* ---------------- ai-workspace 路线（本次测试用例所在路线） ---------------- */

  /**
   * AI 学习空间播放器页。
   *
   * 目标（按用户要求）：一键启动后自动后台挂机播放，不打扰用户。
   *
   * 实测地址形态：
   *   /ai-workspace/lms-graph/31317597/video/84703555
   *     ?fromProIframe=1&isyth=1&is_chapter=1&node_id=16380147
   *
   * 三个必须处理的点：
   *   1. 播放器可能在 shadow DOM 或同源 iframe 里 → 用 Media.find() 跨根查找。
   *   2. 自动播放可能被浏览器拦截 → Player.kickstart() 静音播放 + 一次性手势兜底。
   *   3. 页面有切屏/挂机检测 → preventScreenCheck() + Player.keepAlive()。
   */
  class AiWorkspaceRunner {
    constructor(panel, route) {
      this.panel = panel;
      this.route = route;
    }

    async run() {
      const r = this.route;
      this.panel.log(`课堂 ${r.classroomId} · 类型 ${r.type || '(未指定)'} · 节点 ${r.leafId || '(无)'}`);
      if (r.nodeId) this.panel.log(`章节 node_id=${r.nodeId}`);
      if (r.fromProIframe) this.panel.log('检测到 fromProIframe=1：内嵌播放器模式，只接管播放不做跳转');

      // 防切屏必须在页面脚本注册监听之前生效，越早越好
      preventScreenCheck();

      if (r.type === 'exercise' || r.type === 'homework') {
        this.panel.warn('作业/练习类页面暂不自动作答，仅提供诊断');
        this.panel.log('如需适配请点 [诊断] 反馈结构');
        this.panel.resetStartButton('开始刷课');
        return;
      }

      // ---- 1. 等媒体元素出现 ----
      this.panel.log('正在查找播放器（含 shadow DOM / iframe）...');
      const ready = await Utils.poll(() => Boolean(Media.find().el), { interval: 500, timeout: 30000 });
      const found = Media.find();

      if (!ready || !found.el) {
        this.panel.warn('未找到 video/audio 元素，无法自动播放');
        this.panel.log('可能原因：页面还在加载、播放器在跨域 iframe 内、或该节点不是媒体类型');
        this.panel.log('可点 [诊断] 查看可穿透根数量与媒体状态');
        this.panel.resetStartButton('开始刷课');
        return;
      }

      let media = found.el;
      this.panel.ok(`已找到 ${found.kind} 元素（位置：${found.root}）`);

      const rate = Store.getFeatureConf().rate || Config.playbackRate;
      const finishInfo = Resolve.completionMarker();
      if (finishInfo.text) this.panel.log(`当前进度锚点：${finishInfo.text}`);

      if (finishInfo.done) {
        this.panel.ok('该节点已播放完成，无需重复播放');
        this.panel.resetStartButton('已完成');
        return;
      }

      // ---- 2. 接管播放 ----
      Player.applySpeed(rate);
      Player.mute();

      const stopObserve = Player.observePause(media);
      const stopKeepAlive = Player.keepAlive();

      const started = await Player.kickstart(media);
      if (started) {
        this.panel.ok(`已开始播放：${rate}x，静音，后台挂机中`);
      } else {
        this.panel.warn('未能自动开始播放');
        this.panel.log('请手动点击播放器一次，脚本会自动接管倍速与保持播放');
      }

      // 等待真正开始推进（确认不是「假播放」）
      const advanced = await Utils.poll(() => {
        const cur = Media.find().el;
        if (cur) media = cur;
        if (!media) return false;
        return media.currentTime > 0.5 || (!media.paused && media.readyState >= 2);
      }, { interval: 500, timeout: 20000 });

      if (!advanced) {
        this.panel.warn('媒体未开始推进，可能仍被拦截或资源加载失败');
      } else {
        this.panel.log('播放已确认推进，开始挂机等待完成');
      }

      try {
        const done = await Player.waitUntilDone(media, {
          onTick: () => {
            // 媒体元素被替换（切清晰度/切源）时重新接管
            const cur = Media.find().el;
            if (cur && cur !== media) {
              this.panel.log('检测到播放器元素变化，重新接管');
              media = cur;
              Player.applySpeed(rate);
              Player.mute(media);
            }
          },
        });
        if (done) this.panel.ok('播放完成');
        else this.panel.warn('等待播放完成超时（可能是长视频或进度上报延迟）');
      } finally {
        stopObserve();
        stopKeepAlive();
      }

      // ---- 3. 收尾 ----
      if (Utils.inIframe()) {
        this.panel.log('本页在 iframe 内，已播放完毕，通知父窗口');
        try {
          window.parent.postMessage({ type: 'CQU_YKT_PLAY_DONE', classroomId: r.classroomId, leafId: r.leafId }, '*');
        } catch (_) { /* ignore */ }
        this.panel.resetStartButton('已完成');
        return;
      }

      // 非内嵌场景下尝试自动进入下一节
      if (!r.fromProIframe && Runner.clickNext()) {
        this.panel.log('已进入下一节');
        await Utils.sleep(2000);
        return;
      }

      const catalog = Route.catalogUrl();
      if (!r.fromProIframe && catalog) {
        this.panel.log('返回目录页继续');
        location.href = catalog;
        return;
      }

      this.panel.ok('本节点处理完毕（未做跳转，请在上层目录页点击「开始刷课」继续）');
      this.panel.resetStartButton('已完成');
    }
  }

  /* ==========================================================================
   * 12. 路由分发 + 启动
   * ========================================================================== */

  async function start() {
    Actions.reset();
    const route = Route.current();
    const classroomId = Route.classroomId();

    if (!route) {
      panel.warn('当前页面不是 CQU 雨课堂学习页');
      panel.log('请进入 /pro/lms/<sign>/<classroom_id> 或 /v2/web/studentLog/<id> 后重试');
      panel.resetStartButton('开始刷课');
      return;
    }

    // 记录跨页自动恢复标记
    Store.setPending(classroomId, location.href.split('?')[0]);
    panel.log(`识别到课堂 ID：${classroomId || '(未知)'}`);

    if (route.kind === 'pro') {
      await new ProRunner(panel).run();
    } else if (route.kind === 'v2') {
      await new V2Runner(panel).run();
    } else if (route.kind === 'ai') {
      await new AiWorkspaceRunner(panel, route).run();
    } else if (route.kind === 'pro-ai') {
      panel.warn('专业版 AI 学习空间页面暂未适配，仅提供诊断信息');
      panel.log('请点击 [诊断] 并把结果反馈，以便补充适配');
      panel.resetStartButton('开始刷课');
    } else {
      panel.resetStartButton('开始刷课');
    }
  }

  async function boot() {
    // ---- 启动心跳：脚本一跑起来就先留下痕迹 ----
    // 这样「面板没出现」时能立刻区分是「脚本根本没运行」还是「运行了但挂载失败」。
    /* eslint-disable-next-line no-console */
    console.log(
      `%c[CQU雨课堂] 脚本已执行 v${Config.version}`,
      'color:#1677ff;font-weight:bold',
      `\n  URL: ${location.href}`
      + `\n  顶层窗口: ${!Utils.inIframe()}`
      + `\n  文档状态: ${document.readyState}`
    );

    if (Utils.inIframe()) {
      /* eslint-disable-next-line no-console */
      console.log('[CQU雨课堂] 当前在 iframe 内，按设计跳过注入（避免出现多个面板）。请在顶层页面操作。');
      return;
    }

    try {
      await Utils.waitForMountTarget();
      panel = createPanel();
      Actions.panel = panel;
      panel.log(`雨课堂助手 v${Config.version} 已就绪`);
      panel.setStartHandler(start);

      const route = Route.current();
      if (route) {
        panel.ok(Runner.labelOf(route));
      } else {
        panel.warn('当前页面未匹配到雨课堂路由，请进入课程学习页');
      }
      panel.log('点击右下角「开始刷课」启动自动播放');

      // 诊断入口：?cqu_diag=1
      if (new URLSearchParams(location.search).get('cqu_diag') === '1') {
        setTimeout(() => Diag.print(), 3000);
        panel.log('已启用 ?cqu_diag=1，诊断结果见控制台');
      }

      // 跨页自动恢复
      const pending = Store.getPending();
      if (pending && route && pending.classroomId === Route.classroomId()) {
        panel.log(`检测到跨页跳转，1.2s 后自动恢复刷课（课堂 ${pending.classroomId}）`);
        setTimeout(() => panel.start(), 1200);
      }
    } catch (err) {
      /* eslint-disable-next-line no-console */
      console.error('[CQU雨课堂] 面板挂载失败:', err);
      // 挂载失败也要让用户看到，否则又是一次「面板没出现，不知道为什么」
      try {
        const tip = document.createElement('div');
        tip.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;background:#b91c1c;color:#fff;'
          + 'padding:10px 14px;border-radius:6px;font:13px/1.6 system-ui,sans-serif;max-width:520px;white-space:pre-wrap';
        tip.textContent = `CQU 雨课堂助手面板挂载失败\n${err?.message || err}\n详情见控制台（F12）`;
        (document.body || document.documentElement).appendChild(tip);
      } catch (_) { /* 连提示都挂不上就只能看控制台了 */ }
    }
  }

  // 控制台诊断入口
  try {
    unsafeWindow.__CQU_DIAG__ = () => Diag.print();
    unsafeWindow.__CQU_DIAG_TEXT__ = () => Diag.printText();
  } catch (_) {
    window.__CQU_DIAG__ = () => Diag.print();
    window.__CQU_DIAG_TEXT__ = () => Diag.printText();
  }

  boot().catch(err => {
    /* eslint-disable-next-line no-console */
    console.error('[CQU雨课堂] 启动异常:', err);
  });

})();
