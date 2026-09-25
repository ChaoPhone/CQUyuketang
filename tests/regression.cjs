const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let playwright;
try { playwright = require('playwright'); } catch {
  playwright = require(path.join(process.env.USERPROFILE,
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
}
const root = path.resolve(__dirname, '..');
const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:cqu-yuketang.user.js'], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, 'cqu-yuketang.user.js'), 'utf8');
// Expose closures from the real userscript, without copying its implementation.
const instrumented = source.replace('  boot().catch(err => {',
  '  window.testApi = { Utils, Store, Route, Resolve, Player, Media, Guard, Actions, Runner, Solver, AiWorkspaceRunner, ProRunner, panel: () => panel, start };\n  boot().catch(err => {');

(async () => {
  const browser = await playwright.chromium.launch({ channel: process.env.TEST_BROWSER || 'msedge', headless: true });
  let failures = 0;
  async function test(name, run, html = '') {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Every request is intercepted. No course server or AI endpoint is contacted.
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<html><body>${html}</body></html>` }));
    try {
      await page.goto('https://courses.cqu.edu.cn/ai-workspace/lms-graph/1/video/2');
      await page.evaluate(instrumented);
      await page.waitForFunction(() => window.testApi?.panel());
      await run(page);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); }
  }
  await test('strict completion rejects partial and contradictory status', async page => {
    assert.deepEqual(await page.evaluate(() => ['98%', '99%', '未完成 已完成 100%', '1100%', '100%', '12/12', '3/12'].map(t => testApi.Utils.isDone(t))),
      [false, false, false, false, true, true, false]);
  });
  await test('body and catalog text cannot finish the current lesson', async page => {
    assert.equal(await page.evaluate(() => testApi.Resolve.completionMarker().done), false);
  }, '<div>100%</div><aside class="catalog"><div class="progress-wrap">100%</div></aside>');
  await test('current incomplete progress overrides completed unrelated text', async page => {
    assert.equal(await page.evaluate(() => testApi.Resolve.completionMarker().done), false);
  }, '<div class="progress-wrap">20%</div><div>100%</div>');
  await test('ordinary pointer movement never moves the panel', async page => {
    const before = await page.locator('#cqu-ykt-helper-iframe').boundingBox();
    await page.mouse.move(900, 500);
    await page.waitForTimeout(50);
    assert.deepEqual(await page.locator('#cqu-ykt-helper-iframe').boundingBox(), before);
  });
  await test('drag uses host coordinates and stops on release', async page => {
    const frame = page.frameLocator('#cqu-ykt-helper-iframe');
    const header = await frame.locator('#header').boundingBox();
    const before = await page.locator('#cqu-ykt-helper-iframe').boundingBox();
    await page.mouse.move(header.x + 100, header.y + 20);
    await page.mouse.down();
    await page.mouse.move(header.x + 200, header.y + 80, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const after = await page.locator('#cqu-ykt-helper-iframe').boundingBox();
    assert.ok(Math.abs(after.x - before.x - 100) < 3);
    assert.ok(Math.abs(after.y - before.y - 60) < 3);
    await page.mouse.move(900, 600);
    await page.waitForTimeout(50);
    assert.deepEqual(await page.locator('#cqu-ykt-helper-iframe').boundingBox(), after);
  });
  await test('minimize keeps an offscreen panel reachable', async page => {
    await page.evaluate(() => { document.querySelector('#cqu-ykt-helper-iframe').style.left = '-400px'; testApi.panel().minimality.click(); });
    const rect = await page.locator('#cqu-ykt-helper-iframe').boundingBox();
    assert.ok(rect.x + rect.width >= 48);
  });
  await test('latest playback rate survives correction timer', async page => {
    assert.equal(await page.evaluate(async () => {
      testApi.Player.applySpeed(2);
      testApi.Player.applySpeed(3);
      await new Promise(resolve => setTimeout(resolve, 5200));
      return document.querySelector('video').playbackRate;
    }), 3);
  }, '<video></video>');
  await test('unmute restores audible volume', async page => {
    assert.equal(await page.evaluate(() => {
      const media = document.querySelector('video'); media.volume = 0.6;
      testApi.Player.mute(media); testApi.Player.unmute(); return media.volume;
    }), 0.6);
  }, '<video></video>');
  await test('cursor is isolated between classrooms', async page => {
    assert.equal(await page.evaluate(() => {
      testApi.Store.setCursor(8); history.pushState({}, '', '/ai-workspace/lms-graph/9');
      return testApi.Store.getCursor();
    }), 0);
  });
  await test('disabled next button is not reported as navigation', async page => {
    assert.equal(await page.evaluate(() => testApi.Runner.clickNext()), false);
  }, '<button class="btn-next" disabled>下一节</button>');
  await test('zero time display does not finish unloaded media', async page => {
    // waitUntilDone 现在返回状态字符串（'done'/'stalled'/'timeout'/'left'），不再混用布尔值
    assert.equal(await page.evaluate(() => testApi.Player.waitUntilDone(document.querySelector('video'), { timeout: 20 })), 'timeout');
  }, '<video></video><div class="xt_video_player_current_time_display">00:00 / 00:00</div>');
  await test('replacement media ended event completes the wait', async page => {
    assert.equal(await page.evaluate(async () => {
      const old = document.querySelector('video'); let current = old;
      setTimeout(() => { current = document.createElement('video'); old.replaceWith(current); }, 50);
      setTimeout(() => current.dispatchEvent(new Event('ended')), 1000);
      return testApi.Player.waitUntilDone(old, { timeout: 1800, getMedia: () => current });
    }), 'done');
  }, '<video></video>');
  await test('run failure restores the start button', async page => {
    await page.evaluate(() => { const p = testApi.panel(); p.setStartHandler(async () => { throw new Error('fixture failure'); }); p.start(); });
    await page.waitForTimeout(100);
    assert.equal(await page.frameLocator('#cqu-ykt-helper-iframe').locator('#btn-start').isEnabled(), true);
  });
  await test('SPA catalog navigation dispatches the learning runner', async page => {
    assert.deepStrictEqual(await page.evaluate(async () => {
      history.pushState({}, '', '/pro/lms/sign/1');
      const visits = [];
      testApi.ProRunner.prototype.run = async function () {
        visits.push(location.pathname);
        if (visits.length === 1) history.pushState({}, '', '/pro/lms/sign/1/video/2');
      };
      await testApi.start(); return visits;
    }), ['/pro/lms/sign/1', '/pro/lms/sign/1/video/2']);
  });
  await test('AI timeout never navigates or reports completed', async page => {
    assert.equal(await page.evaluate(async () => {
      const api = testApi; const messages = [];
      api.Utils.poll = async () => true;
      api.Player.kickstart = async () => true;
      api.Player.observePause = () => () => {};
      api.Player.keepAlive = () => () => {};
      api.Player.waitUntilDone = async () => false;
      api.Runner.clickNext = () => { messages.push('navigated'); return true; };
      const p = { log: m => messages.push(m), warn: m => messages.push(m), ok: m => messages.push(m), resetStartButton() {} };
      await new api.AiWorkspaceRunner(p, api.Route.current()).run();
      return messages.includes('navigated') || messages.some(m => m.includes('处理完毕'));
    }), false);
  }, '<video></video>');
  await test('stopping cancels a pending autoplay gesture', async page => {
    assert.equal(await page.evaluate(async () => {
      const media = document.querySelector('video');
      media.play = async () => { throw new Error('blocked'); };
      const pending = testApi.Player.kickstart(media);
      await Promise.resolve(); await Promise.resolve();
      testApi.Actions.stop();
      return Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
    }), false);
  }, '<video></video>');
  await test('stopped completion wait returns without success', async page => {
    assert.equal(await page.evaluate(async () => {
      testApi.Actions.stop();
      return testApi.Player.waitUntilDone(document.querySelector('video'), { timeout: 20 });
    }), 'left');
  }, '<video></video><div class="progress-wrap">100%</div>');
  await test('batch navigation before waiting is not mistaken for cancellation', async page => {
    assert.equal(await page.evaluate(async () => {
      testApi.Actions.routeUrl = location.origin + '/pro/lms/sign/1';
      return testApi.Player.waitUntilDone(document.querySelector('video'), { timeout: 20 });
    }), 'done');
  }, '<video></video><div class="progress-wrap">100%</div>');
  await test('rounded matching time display alone cannot finish media', async page => {
    assert.equal(await page.evaluate(async () => {
      const media = document.querySelector('video');
      Object.defineProperty(media, 'duration', { value: 60 });
      Object.defineProperty(media, 'currentTime', { value: 59.95 });
      return testApi.Player.waitUntilDone(media, { timeout: 20 });
    }), 'timeout');
  }, '<video></video><div class="xt_video_player_current_time_display">01:00 / 01:00</div>');
  await test('shadow media duration determines timeout', async page => {
    assert.equal(await page.evaluate(async () => {
      const root = document.createElement('div'); document.body.append(root);
      const shadow = root.attachShadow({ mode: 'open' });
      const media = document.createElement('video'); shadow.append(media);
      Object.defineProperty(media, 'duration', { value: 600 });
      return testApi.Utils.getMediaTimeout();
    }), 1800000);
  });
  await test('clearing progress ignores URL query parameters', async page => {
    assert.equal(await page.evaluate(() => {
      history.pushState({}, '', '/v2/web/studentLog/1?tab=all');
      testApi.Store.setProgress(location.href.split('?')[0], 4);
      testApi.Store.clearAll();
      return testApi.Store.getProgress(location.href.split('?')[0]).outside;
    }), 0);
  });
  await test('invalid stored rate falls back to supported speed', async page => {
    assert.equal(await page.evaluate(() => {
      testApi.Store.setFeatureConf({ rate: -8 }); return testApi.Store.getFeatureConf().rate;
    }), 2);
  });
  await test('video title cannot override an exam type', async page => {
    assert.equal(await page.evaluate(() => testApi.Media.guessLeafType({ iconHref: '#icon-kaoshi', text: '视频测验' })), 'exam');
  });
  await test('exam route never starts a media player', async page => {
    assert.equal(await page.evaluate(async () => {
      let polled = false;
      testApi.Utils.poll = async () => { polled = true; return false; };
      await new testApi.AiWorkspaceRunner(testApi.panel(), { kind: 'ai', classroomId: '1', type: 'exam' }).run();
      return polled;
    }), false);
  });
  await test('explicit video icon wins over classroom words in title', async page => {
    assert.equal(await page.evaluate(() => testApi.Media.guessLeafType({ iconHref: '#icon-shipin', text: '课堂视频测验讲解' })), 'video');
  });
  await test('decimal speed has a valid player control value', async page => {
    assert.equal(await page.evaluate(() => {
      testApi.Player.applySpeed(1.5); return document.querySelector('xt-button').getAttribute('keyt');
    }), '1.50');
  }, '<xt-speedbutton></xt-speedbutton><xt-speedlist><xt-button></xt-button></xt-speedlist>');
  await test('GM request timeout rejects instead of hanging', async page => {
    assert.equal(await page.evaluate(async () => {
      testApi.Store.setAIConf({ url: 'https://example.invalid/api', key: 'fixture', model: 'fixture' });
      window.GM_xmlhttpRequest = options => { setTimeout(() => options.ontimeout?.(), 0); };
      return Promise.race([
        testApi.Solver.askAI('fixture').then(() => 'resolved', error => error.message),
        new Promise(resolve => setTimeout(() => resolve('hung'), 100)),
      ]);
    }), '请求超时');
  });
  await test('successful media diagnostic does not require both audio and video', async page => {
    await page.frameLocator('#cqu-ykt-helper-iframe').locator('#btn-diag').click();
    assert.equal(await page.frameLocator('#cqu-ykt-helper-iframe').locator('#info').innerText().then(text => text.includes('关键契约未命中')), false);
  }, '<video></video>');

  // ---------- 播放守护（capture 阶段拦截）----------
  // 这批用例对应「经常卡住 / 无法连续播放」的核心修复。

  // 媒体桩：长视频（600s）、paused 由 window.__paused 标志位可控、记录 play() 调用次数。
  // 注意：**不要**在这里替换 HTMLMediaElement.prototype.pause —— Guard 会基于
  // 当时的 prototype.pause 做二次覆写，桩若先替换就会成为「原生 pause」，
  // 导致 Guard 的覆写看起来没生效。
  //
  // 也不用「监听原生 pause 事件」来计数：paused 被 defineProperty 变成 getter 后，
  // 原生 pause() 无法真正改状态，也就不会派发 pause 事件。改用可控标志位断言。
  const guardFixture = (extra = '', initialPaused = 'true', timeExpr = null) => `
    <video></video>
    <script>
      const v = document.querySelector('video');
      window.__pausedFlag = ${initialPaused};
      Object.defineProperty(v, 'duration', { value: 600, configurable: true });
      Object.defineProperty(v, 'paused', { configurable: true, get: () => window.__pausedFlag });
      ${timeExpr ? `Object.defineProperty(v, 'currentTime', { configurable: true, get: () => ${timeExpr} });` : ''}
      window.__played = 0;
      const nativePause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () { window.__pausedFlag = true; return nativePause.apply(this, arguments); };
      v.play = function () { window.__played++; window.__pausedFlag = false; return Promise.resolve(); };
      ${extra}
    </script>`;

  await test('guard blocks pause from reaching site listeners', async page => {
    assert.deepStrictEqual(await page.evaluate(async () => {
      const api = testApi;
      api.Actions.reset();
      api.Store.setFeatureConf({ autoAI: false, autoComment: false, rate: 2 });
      const video = document.querySelector('video');
      api.Media.find = () => ({ el: video, kind: 'video', root: 'document' });
      api.Guard.install({ shouldRun: () => !api.Actions.stopped });
      let siteSaw = 0;
      video.addEventListener('pause', () => { siteSaw++; });
      video.dispatchEvent(new Event('pause', { bubbles: false }));
      await new Promise(r => setTimeout(r, 20));
      api.Guard.uninstall();
      return { siteSaw, played: window.__played };
    }), { siteSaw: 0, played: 1 });
  }, guardFixture());

  await test('guard intercepts direct pause() calls', async page => {
    const diag = await page.evaluate(async () => {
      const api = testApi;
      api.Actions.reset();
      api.Store.setFeatureConf({ autoAI: false, autoComment: false, rate: 2 });
      const video = document.querySelector('video');
      api.Media.find = () => ({ el: video, kind: 'video', root: 'document' });
      api.Guard.install({ shouldRun: () => !api.Actions.stopped });
      window.__pausedFlag = false;
      window.__played = 0;
      const guarded = api.Guard._isGuarded(video);
      // 注意：不能断言 HTMLMediaElement.prototype.__cquGuarded —— 那读的是
      // 测试评估所在世界的原型；Tampermonkey 沙箱下脚本可能打在页面世界的原型上
      // （这正是脚本采用「双路覆写」的原因）。只断言可观察行为。
      video.pause();                       // 平台直接调用 pause()
      await new Promise(r => setTimeout(r, 20));
      const result = {
        guarded,
        stillPlaying: window.__pausedFlag === false,
        played: window.__played,
        pausedAfter: video.paused,
      };
      api.Guard.uninstall();
      return result;
    });
    assert.deepStrictEqual(diag, {
      guarded: true,
      stillPlaying: true,
      played: 1,
      pausedAfter: false,
    });
    // paused=false 是前提：Guard 对「已经暂停」的媒体不做恢复（那是用户的合法暂停）
  }, guardFixture('', 'false'));

  await test('guard ignores media shorter than the minimum duration', async page => {
    assert.equal(await page.evaluate(async () => {
      const api = testApi;
      api.Actions.reset();
      const video = document.querySelector('video');
      api.Media.find = () => ({ el: video, kind: 'video', root: 'document' });
      api.Guard.install({ shouldRun: () => !api.Actions.stopped });
      // duration 为 5s，低于 30s 阈值，不应被接管
      return api.Guard._isGuarded(video);
    }), false);
  }, guardFixture('', 'true').replace('value: 600', 'value: 5'));

  await test('guard blocks visibilitychange from reaching site listeners', async page => {
    assert.equal(await page.evaluate(async () => {
      const api = testApi;
      api.Actions.reset();
      const video = document.querySelector('video');
      api.Media.find = () => ({ el: video, kind: 'video', root: 'document' });
      api.Guard.install({ shouldRun: () => !api.Actions.stopped });
      let siteSaw = 0;
      document.addEventListener('visibilitychange', () => { siteSaw++; });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 20));
      api.Guard.uninstall();
      return siteSaw;
    }), 0);
  }, guardFixture());

  await test('watchdog resumes a stalled player and logs the recovery', async page => {
    assert.deepStrictEqual(await page.evaluate(async () => {
      const api = testApi;
      api.Actions.reset();
      api.Store.setFeatureConf({ autoAI: false, autoComment: false, rate: 2 });
      const video = document.querySelector('video');
      api.Media.find = () => ({ el: video, kind: 'video', root: 'document' });
      // 缩短阈值，让看门狗在测试时间内触发（生产值为 15000/3000）
      api.Guard.STALL_MS = 150;
      api.Guard.TICK_MS = 60;
      api.Guard.install({ shouldRun: () => !api.Actions.stopped });
      // 时间轴冻结在 10s 且 paused=false —— 典型的「卡住」状态
      await new Promise(r => setTimeout(r, 500));
      api.Guard.uninstall();
      const log = api.panel().info.innerText || '';
      return { stalled: log.includes('播放停滞'), played: window.__played };
    }).then(r => ({ stalled: r.stalled, recovered: r.played >= 1 })), { stalled: true, recovered: true });
  }, guardFixture('', 'false', '10'));

  await test('guard uninstall restores the native pause path', async page => {
    assert.deepStrictEqual(await page.evaluate(async () => {
      const api = testApi;
      api.Actions.reset();
      const video = document.querySelector('video');
      api.Media.find = () => ({ el: video, kind: 'video', root: 'document' });
      api.Guard.install({ shouldRun: () => !api.Actions.stopped });
      api.Guard.uninstall();
      // 卸载后 pause() 必须走原生路径：标志位应变为已暂停，且不会触发恢复播放
      window.__pausedFlag = false;
      window.__played = 0;
      video.pause();
      await new Promise(r => setTimeout(r, 20));
      return { paused: window.__pausedFlag, played: window.__played };
    }), { paused: true, played: 0 });
  }, guardFixture('', 'false'));

  await browser.close();
  console.log(`${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
