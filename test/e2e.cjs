'use strict';
/**
 * X 快捷屏蔽 · 无头端到端测试
 * 用 jsdom 搭一个「仿 X DOM + 仿官方菜单/弹窗行为」的环境，把整条链路真的跑一遍。
 * jsdom 没有排版引擎（rect 全 0），因此对 getBoundingClientRect 打桩 —— 这只影响可见性判定，
 * 不影响被测逻辑。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SCRIPT_PATH = process.env.XQB_SCRIPT
  ? path.resolve(process.env.XQB_SCRIPT)
  : path.resolve(__dirname, '..', 'x-quick-block.user.js');
const code = fs
  .readFileSync(SCRIPT_PATH, 'utf8')
  .replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) {
    passes++;
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '   → ' + extra : ''));
  }
}

/* ───────────────────────── 环境 ───────────────────────── */

function boot() {
  const vc = new VirtualConsole();
  vc.on('warn', (...a) => console.log('        [warn]', ...a.map(String)));
  vc.on('error', (...a) => console.log('        [error]', ...a.map(String)));
  vc.on('jsdomError', (e) => console.log('        [jsdomError]', e.message));

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="react-root"></div><div id="layers"></div></body></html>',
    { url: 'https://x.com/home', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: vc }
  );
  const { window } = dom;
  // 复刻真实 x.com 的陷阱：完全可见的浮层 checkVisibility() 也会返回 false。
  // 生产代码若改回 checkVisibility 过滤，这里的用例会立刻崩掉。
  window.Element.prototype.checkVisibility = function () {
    return false;
  };
  // jsdom 无 layout：给所有元素一个非零 rect，让 isVisible() 正常工作。
  // caret 特意给 20px 高 —— 与真实 x.com 实测一致，用于验证「按钮高度跟随 caret」。
  window.Element.prototype.getBoundingClientRect = function () {
    const h = this.getAttribute && this.getAttribute('data-testid') === 'caret' ? 20 : 40;
    return { x: 100, y: 100, left: 100, top: 100, right: 140, bottom: 100 + h, width: 40, height: h };
  };
  return { dom, window, document: window.document };
}

function makeTweet(window, handle, statusId) {
  const doc = window.document;
  const art = doc.createElement('article');
  art.setAttribute('data-testid', 'tweet');
  art.setAttribute('data-handle', handle);

  const un = doc.createElement('div');
  un.setAttribute('data-testid', 'User-Name');
  const a = doc.createElement('a');
  a.setAttribute('href', '/' + handle);
  a.textContent = '@' + handle;
  un.appendChild(a);

  const link = doc.createElement('a');
  link.setAttribute('href', '/' + handle + '/status/' + statusId);
  const time = doc.createElement('time');
  time.setAttribute('datetime', '2026-01-01T00:00:00Z');
  time.textContent = '1h';
  link.appendChild(time);

  const bar = doc.createElement('div');
  const caret = doc.createElement('div');
  caret.setAttribute('data-testid', 'caret');
  caret.setAttribute('role', 'button');
  caret.textContent = '···';
  bar.appendChild(caret);

  art.appendChild(un);
  art.appendChild(link);
  art.appendChild(bar);
  doc.getElementById('react-root').appendChild(art);
  return art;
}

/** 仿 X：点击 caret 开菜单；点屏蔽项弹确认框；Esc 关闭 */
function installFakeX(window, state) {
  const doc = window.document;
  const layers = doc.getElementById('layers');

  const closeMenu = () => {
    const m = layers.querySelector('[data-testid="Dropdown"]');
    if (m) m.remove();
  };

  const openMenu = (article) => {
    closeMenu();
    const handle = article.getAttribute('data-handle') || 'unknown';
    const drop = doc.createElement('div');
    drop.setAttribute('data-testid', 'Dropdown');
    const menu = doc.createElement('div');
    menu.setAttribute('role', 'menu');
    const mk = (label, testid) => {
      const it = doc.createElement('div');
      it.setAttribute('role', 'menuitem');
      it.setAttribute('tabindex', '-1');
      if (testid) it.setAttribute('data-testid', testid);
      it.textContent = label;
      return it;
    };
    const blockId = state.blockTestId === false ? null : state.alreadyBlocked ? 'unblock' : 'block';
    const labels = [
      mk('关注 @' + handle),
      mk('添加到列表'),
      mk((state.alreadyBlocked ? '取消屏蔽 @' : '屏蔽 @') + handle, blockId),
      mk('举报推文'),
      mk('嵌入推文'),
    ];
    if (state.noBlockItem) labels.splice(2, 1); // 广告/自己推文等场景：菜单里没有屏蔽项
    labels.forEach((i) => menu.appendChild(i));
    drop.appendChild(menu);
    layers.appendChild(drop);
    state.menuOpens++;
  };

  const openConfirm = (article) => {
    const handle = article ? article.getAttribute('data-handle') : 'unknown';
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('data-testid', 'confirmationSheetDialog');
    const ok = doc.createElement('div');
    ok.setAttribute('role', 'button');
    ok.setAttribute('data-testid', 'confirmationSheetConfirm');
    ok.textContent = '屏蔽';
    ok.addEventListener('click', () => {
      state.blocked.push(handle);
      dlg.remove();
    });
    const no = doc.createElement('div');
    no.setAttribute('role', 'button');
    no.setAttribute('data-testid', 'confirmationSheetCancel');
    no.textContent = '取消';
    no.addEventListener('click', () => dlg.remove());
    dlg.appendChild(ok);
    dlg.appendChild(no);
    layers.appendChild(dlg);
    state.dialogs++;
  };

  doc.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;

    if (t.closest('#layers')) {
      const item = t.closest('[role="menuitem"]');
      if (item) {
        state.itemClicks.push(item.textContent);
        const label = item.textContent.trim();
        if (/^(屏蔽|Block)/.test(label)) {
          // 复刻真实 x.com 行为（已实测）：打开官方确认弹窗时，背后的下拉菜单
          // 依然留在页面上，X 不会自己收掉 —— 生产代码必须在弹窗消失后 toggle 关掉它。
          openConfirm(state.currentArticle);
        } else {
          closeMenu();
        }
      }
      return;
    }

    const caret = t.closest('[data-testid="caret"]');
    if (caret) {
      state.currentArticle = caret.closest('article[data-testid="tweet"]');
      // 真实 X 的行为：caret 是 toggle —— 已展开时再点一次即关闭
      if (layers.querySelector('[data-testid="Dropdown"]')) closeMenu();
      else openMenu(state.currentArticle);
    }
  });

  // ⚠️ 刻意不实现 Esc 关闭：真实 x.com 实测 Esc 关不掉 caret 菜单
  //（派发时 X 的处理器确实跑了 defaultPrevented=true，但菜单仍在）。
  // 让测试环境比真实环境更严格，从而强迫生产代码只能靠 caret toggle 收尾。
}

/* ───────────────────────── 用例 ───────────────────────── */

async function scenarioMain() {
  console.log('\n[1] 主流程：注入 → 二次确认 → 复放原生菜单 → 自动确认');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', '111');
  let articleClicked = false;
  art.addEventListener('click', () => {
    articleClicked = true;
  });

  window.eval(code);
  await sleep(150);

  const btn = art.querySelector('.xqb-btn');
  check('注入按钮存在', !!btn);
  check('按钮带本实例标记 .xqb-mine', btn && btn.classList.contains('xqb-mine'));
  check('按钮紧跟在 caret 之后', !!btn && btn.previousElementSibling?.getAttribute('data-testid') === 'caret');
  check('tooltip = 屏蔽 @tester', btn && btn.title === '屏蔽 @tester', btn && btn.title);
  check('按钮高度跟随 caret 实测值 20px', btn && btn.style.getPropertyValue('--xqb-h') === '20px', btn && btn.style.getPropertyValue('--xqb-h'));
  check('默认外观为胶囊形态', btn && btn.dataset.style === 'pill');
  check('胶囊含「屏蔽」字样', !!btn && /屏蔽/.test(btn.textContent), btn && btn.textContent);
  // 样式回归：默认态必须与 X 原生操作栏一致（透明底 + 次级灰），红色只出现在 hover 态
  const injectedCSS = document.getElementById('xqb-style').textContent;
  check(
    '默认态样式：透明底 + 次级灰（不刺眼）',
    /\.xqb-btn\[data-style="pill"\]\s*\{\s*background:\s*transparent;\s*color:\s*var\(--xqb-fg\)/.test(injectedCSS),
    injectedCSS.match(/\.xqb-btn\[data-style="pill"\][^}]*\}/)?.[0]
  );
  check(
    '红色只在 hover 态出现',
    /:hover[^{]*\{[^}]*--xqb-danger-bg/.test(injectedCSS) &&
      !/\.xqb-btn\[data-style="pill"\]\s*\{[^}]*--xqb-danger-bg/.test(injectedCSS)
  );
  check('--xqb-fg 亮色值对齐 X 原生灰 rgb(83,100,113)', /--xqb-fg:\s*rgb\(83,\s*100,\s*113\)/.test(injectedCSS));
  check('--xqb-fg 暗色值对齐 X 原生灰 rgb(113,118,123)', /--xqb-fg:\s*rgb\(113,\s*118,\s*123\)/.test(injectedCSS));
  check('推文被标记 data-xqb', art.getAttribute('data-xqb') === '1');
  check(
    '调试 API 已挂载',
    typeof window.__XQB__ === 'object' && typeof window.__XQB__.diagnose === 'function'
  );
  check('启动时未惊动官方菜单', state.menuOpens === 0, 'menuOpens=' + state.menuOpens);

  window.__XQB__.config.nativeConfirmDelayMs = 20;

  // 点击注入按钮
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  check('弹出二次确认气泡', !!window.__XQB__ && !!document.querySelector('#xqb-ui-host'));
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  check('气泡已渲染', !!pop);
  check('气泡含官方预览区', !!pop && !!pop.querySelector('.pop-preview'));
  check('点击按钮未冒泡给 X（防误开详情页）', articleClicked === false && state.menuOpens === 0, 'clicked=' + articleClicked + ' menus=' + state.menuOpens);

  // 点「确认屏蔽」
  const okBtn = pop.querySelector('button[data-act="ok"]');
  okBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);

  check('官方菜单被打开过', state.menuOpens === 1, 'menuOpens=' + state.menuOpens);
  check('命中并点击了原生屏蔽项', state.itemClicks.some((t) => /^屏蔽/.test(t.trim())), JSON.stringify(state.itemClicks));
  check('弹出官方确认框', state.dialogs === 1, 'dialogs=' + state.dialogs);
  check('完成屏蔽（官方逻辑执行）', state.blocked.includes('tester'), JSON.stringify(state.blocked));
  check('推文被标记 data-xqb-done', !!art.getAttribute('data-xqb-done'));
  check('残留菜单已关闭', !document.querySelector('#layers [role="menu"]'));
  const toasts = document.querySelector('#xqb-ui-host').shadowRoot.querySelectorAll('.toast');
  check('弹出 Toast', toasts.length >= 1, 'toasts=' + toasts.length);
  check('toasts 内容含「已屏蔽」', Array.from(toasts).some((t) => /已屏蔽/.test(t.textContent)));
  await sleep(1400);
  check('成功后按钮自动移除', !art.querySelector('.xqb-btn'));
}

async function scenarioCancel() {
  console.log('\n[2] 取消路径：气泡点「取消」不应触发任何官方动作');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', '222');
  window.eval(code);
  await sleep(150);

  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  const cancel = pop.querySelector('button[data-act="cancel"]');
  cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(200);

  check('取消后菜单未被打开', state.menuOpens === 0, 'menuOpens=' + state.menuOpens);
  check('取消后无屏蔽', state.blocked.length === 0);
  check('取消后按钮仍在', !!art.querySelector('.xqb-btn'));
  check('取消后无 data-xqb-done', !art.getAttribute('data-xqb-done'));
}

async function scenarioEscAbort() {
  console.log('\n[3] 反悔窗口：官方弹窗出现后按 Esc 应中止并关闭弹窗');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', '333');
  window.eval(code);
  await sleep(150);

  window.__XQB__.config.nativeConfirmDelayMs = 400; // 拉长反悔窗口
  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  // 等官方弹窗出现，然后按 Esc
  let waited = 0;
  while (waited < 1500 && !document.querySelector('[data-testid="confirmationSheetConfirm"]')) {
    await sleep(30);
    waited += 30;
  }
  check('官方弹窗已出现', !!document.querySelector('[data-testid="confirmationSheetConfirm"]'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(700);
  check('Esc 后未执行屏蔽', state.blocked.length === 0, JSON.stringify(state.blocked));
  check('Esc 后官方弹窗已关闭', !document.querySelector('[data-testid="confirmationSheetDialog"]'));
  check('悬挂的下拉菜单已用 caret toggle 关闭', !document.querySelector('#layers [role="menu"]'));
  const toasts = document.querySelector('#xqb-ui-host').shadowRoot.querySelectorAll('.toast');
  check('提示「已取消」', Array.from(toasts).some((t) => /已取消/.test(t.textContent)));
}

async function scenarioNoTestId() {
  console.log('\n[4] 选择器容错：屏蔽项没有 data-testid 时靠多语言文案命中');
  const { window } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: false };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', '444');
  window.eval(code);
  await sleep(150);

  window.__XQB__.config.nativeConfirmDelayMs = 20;
  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = window.document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);
  check('文案兜底命中并完成屏蔽', state.blocked.includes('tester'), JSON.stringify(state.blocked));
}

async function scenarioAlreadyBlocked() {
  console.log('\n[5] 已屏蔽账号：命中 unblock 项应给出提示且不误点');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true, alreadyBlocked: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', '555');
  window.eval(code);
  await sleep(150);

  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);

  check('未点击「取消屏蔽」项', !state.itemClicks.some((t) => /取消屏蔽/.test(t)), JSON.stringify(state.itemClicks));
  check('无失败弹窗交互', state.dialogs === 0);
  const toasts = document.querySelector('#xqb-ui-host').shadowRoot.querySelectorAll('.toast');
  check('提示已在屏蔽列表', Array.from(toasts).some((t) => /屏蔽列表/.test(t.textContent)), Array.from(toasts).map((t) => t.textContent).join(' | '));
  check('残留菜单已关闭', !document.querySelector('#layers [role="menu"]'));
}

async function scenarioRecycle() {
  console.log('\n[6] 时间线节点复用：同一 DOM 节点换成别的推文后应重建按钮');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'first', '666');
  window.eval(code);
  await sleep(150);

  let btn = art.querySelector('.xqb-btn');
  check('初次注入', !!btn && btn.title === '屏蔽 @first', btn && btn.title);

  window.__XQB__.config.verifyThrottleMs = 0; // 关掉节流以便确定性验证

  // 模拟 X 复用该节点
  const nameLink = art.querySelector('[data-testid="User-Name"] a');
  nameLink.setAttribute('href', '/second');
  nameLink.textContent = '@second';
  art.setAttribute('data-handle', 'second');
  art.querySelector('time').closest('a').setAttribute('href', '/second/status/777');
  await sleep(200);

  btn = art.querySelector('.xqb-btn');
  check('复用后仍只有一个按钮', art.querySelectorAll('.xqb-btn').length === 1, String(art.querySelectorAll('.xqb-btn').length));
  check('复用后 tooltip 更新为 @second', !!btn && btn.title === '屏蔽 @second', btn && btn.title);
}

async function scenarioAlreadyBlockedRecycle() {
  console.log('\n[7] 已屏蔽节点被复用：data-xqb-done 指纹不符时应重新注入');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'old', '888');
  window.eval(code);
  await sleep(150);

  window.__XQB__.config.nativeConfirmDelayMs = 20;
  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(1500);
  check('屏蔽完成', state.blocked.includes('old'));
  check('按钮已移除', !art.querySelector('.xqb-btn'));

  window.__XQB__.config.verifyThrottleMs = 0;
  const nameLink = art.querySelector('[data-testid="User-Name"] a');
  nameLink.setAttribute('href', '/fresh');
  nameLink.textContent = '@fresh';
  art.setAttribute('data-handle', 'fresh');
  art.querySelector('time').closest('a').setAttribute('href', '/fresh/status/999');
  await sleep(250);

  const btn2 = art.querySelector('.xqb-btn');
  check('复用后重新注入按钮', !!btn2, btn2 ? btn2.title : 'none');
  check('tooltip 为 @fresh', !!btn2 && btn2.title === '屏蔽 @fresh', btn2 && btn2.title);
  check('data-xqb-done 已清除', !art.getAttribute('data-xqb-done'));
}

async function scenarioInspectMenu() {
  console.log('\n[8] 调试 API：inspectMenu 应能枚举菜单项并自行收尾');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', 'aaa');
  window.eval(code);
  await sleep(150);

  const items = await window.__XQB__.inspectMenu(art);
  check('枚举到菜单项', Array.isArray(items) && items.length === 5, JSON.stringify(items));
  const block = (items || []).find((i) => i.testid === 'block');
  check('识别出 block 项', !!block && /屏蔽/.test(block.text), JSON.stringify(block));
  check('inspectMenu 结束后菜单已关闭', !document.querySelector('#layers [role="menu"]'));

  const info = window.__XQB__.diagnose();
  check('diagnose 返回体检信息', info && info.tweetNodes === 1 && info.injectedButtons === 1, JSON.stringify(info));
}

async function scenarioNoBlockItem() {
  console.log('\n[9] 菜单里没有屏蔽项：报错后必须靠 caret toggle 收尾，不留悬挂菜单');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true, noBlockItem: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'advert', 'ccc');
  window.eval(code);
  await sleep(150);

  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(700);

  check('未误点任何菜单项', state.itemClicks.length === 0, JSON.stringify(state.itemClicks));
  check('未触发屏蔽', state.blocked.length === 0);
  check('悬挂菜单已用 caret toggle 关闭', !document.querySelector('#layers [role="menu"]'));
  const toasts = document.querySelector('#xqb-ui-host').shadowRoot.querySelectorAll('.toast');
  check('提示「没有屏蔽项」', Array.from(toasts).some((t) => /屏蔽」项/.test(t.textContent)), Array.from(toasts).map((t) => t.textContent).join(' | '));
  check('按钮恢复可点（未卡在 busy）', btn.dataset.busy !== '1');
}

async function scenarioReplyThread() {
  console.log('\n[10] 评论区场景：主贴 + 多条回复，每条回复都要有自己的按钮，且屏蔽的是回复作者');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const main = makeTweet(window, 'author_main', 'aaa');
  const r1 = makeTweet(window, 'replier_one', 'bbb');
  const r2 = makeTweet(window, 'replier_two', 'ccc');
  const r3 = makeTweet(window, 'replier_three', 'ddd');

  window.eval(code);
  await sleep(200);
  window.__XQB__.config.nativeConfirmDelayMs = 20;
  window.__XQB__.config.verifyThrottleMs = 0;

  const all = [main, r1, r2, r3];
  check('主贴与 3 条回复都注入了按钮', all.every((a) => a.querySelector('.xqb-btn')), all.map((a) => !!a.querySelector('.xqb-btn')).join(','));
  check(
    '每条按钮的 tooltip 对应各自作者',
    all.every((a, i) => a.querySelector('.xqb-btn').title === '屏蔽 @' + ['author_main', 'replier_one', 'replier_two', 'replier_three'][i]),
    all.map((a) => a.querySelector('.xqb-btn').title).join(' | ')
  );
  check('按钮都紧跟各自 caret', all.every((a) => a.querySelector('.xqb-btn').previousElementSibling?.getAttribute('data-testid') === 'caret'));

  // 点第 3 条（replier_two）的按钮
  const btn = r2.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  check('气泡标题指向该回复作者', /replier_two/.test(pop.querySelector('.pop-title').textContent), pop.querySelector('.pop-title').textContent);
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);

  check('屏蔽的是该回复作者', state.blocked.length === 1 && state.blocked[0] === 'replier_two', JSON.stringify(state.blocked));
  check('主贴与其它回复未被误伤', !state.blocked.includes('author_main') && !state.blocked.includes('replier_one') && !state.blocked.includes('replier_three'));
  check('只给一条推文打了完成标记', document.querySelectorAll('[data-xqb-done]').length === 1, String(document.querySelectorAll('[data-xqb-done]').length));
  check('悬挂菜单已关闭', !document.querySelector('#layers [role="menu"]'));

  // 评论区验收 API：应报告 4 条推文全部注入、0 问题
  const st = window.__XQB__.selftest();
  check('selftest：4 条推文全部注入', st.tweets === 4 && st.injected === 4 && st.withCaret === 4, JSON.stringify(st));
  check('selftest：problems 为 0', st.problems === 0, JSON.stringify(st));
  check('selftest：已屏蔽那条计入 markedDone', st.markedDone === 1, JSON.stringify(st));
}

async function scenarioModeSwitch() {
  console.log('\n[12] 确认方式开关：none = 点一下直接屏蔽（不弹气泡）');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', 'eee');
  window.eval(code);
  await sleep(150);
  window.__XQB__.config.nativeConfirmDelayMs = 20;

  const st0 = window.__XQB__.status();
  check('默认是气泡确认', st0.confirmMode === 'popover', JSON.stringify(st0));
  check('status 报告无 GM 存储（jsdom 环境）', st0.gmStorage === false && st0.tampermonkeyMenu === false, JSON.stringify(st0));

  window.__XQB__.setMode('none');
  check('切换到直接屏蔽', window.__XQB__.config.confirmMode === 'none');
  check('设置已持久化到 localStorage', window.localStorage.getItem('xqb.mode') === JSON.stringify('none'), String(window.localStorage.getItem('xqb.mode')));

  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(700);

  const sr = document.querySelector('#xqb-ui-host').shadowRoot;
  check('未弹出二次确认气泡', !sr.querySelector('.pop'));
  check('直接完成屏蔽', state.blocked.includes('tester'), JSON.stringify(state.blocked));
  check('官方菜单与弹窗各走了一次', state.menuOpens === 1 && state.dialogs === 1, JSON.stringify(state));
  check('推文被标记完成', !!art.getAttribute('data-xqb-done'));
  const toasts = Array.from(sr.querySelectorAll('.toast')).map((t) => t.textContent);
  check('提示「已屏蔽」', toasts.some((t) => /已屏蔽/.test(t)), toasts.join(' | '));

  // 循环切换顺序：none → longpress → popover
  check('cycleMode 切到 longpress', window.__XQB__.cycleMode() === 'longpress');
  check('cycleMode 再切回 popover', window.__XQB__.cycleMode() === 'popover');
}

async function scenarioLongPress() {
  console.log('\n[13] 长按模式：短按只提示、长按才屏蔽，且不会双触发');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', 'fff');
  window.eval(code);
  await sleep(150);
  window.__XQB__.config.nativeConfirmDelayMs = 20;
  window.__XQB__.setMode('longpress');
  window.__XQB__.config.longPressMs = 80;

  const btn = art.querySelector('.xqb-btn');
  // 短按：pointerdown + 立刻 pointerup + click
  btn.dispatchEvent(new window.Event('pointerdown'));
  btn.dispatchEvent(new window.Event('pointerup'));
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(250);
  check('短按不屏蔽', state.blocked.length === 0, JSON.stringify(state.blocked));
  check('短按未打开官方菜单', state.menuOpens === 0, 'menuOpens=' + state.menuOpens);
  const sr = document.querySelector('#xqb-ui-host').shadowRoot;
  check('短按给出长按提示', Array.from(sr.querySelectorAll('.toast')).some((t) => /长按/.test(t.textContent)));

  // 长按：pointerdown 后保持超过阈值
  btn.dispatchEvent(new window.Event('pointerdown'));
  await sleep(200);
  await sleep(600);
  check('长按触发屏蔽', state.blocked.includes('tester'), JSON.stringify(state.blocked));
  check('长按只走一次', state.menuOpens === 1 && state.dialogs === 1, JSON.stringify(state));
}

async function scenarioManualNative() {
  console.log('\n[14] 官方弹窗手动模式：留给你自己点，且弹窗关闭后自动收尾菜单');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', '9a9');
  window.eval(code);
  await sleep(150);

  window.__XQB__.setAutoConfirmNative(false);
  check('已切到手动模式', window.__XQB__.config.autoConfirmNative === false);
  check('持久化 autoConfirmNative', window.localStorage.getItem('xqb.autoConfirmNative') === 'false', String(window.localStorage.getItem('xqb.autoConfirmNative')));

  const btn = art.querySelector('.xqb-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const sr = document.querySelector('#xqb-ui-host').shadowRoot;
  const pop = sr.querySelector('.pop');
  check('气泡仍会弹出（用户自己的确认还在）', !!pop);
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(600);

  check('官方弹窗留在屏幕上', !!document.querySelector('[data-testid="confirmationSheetConfirm"]'));
  check('此时还没有真的屏蔽', state.blocked.length === 0, JSON.stringify(state.blocked));
  check('未标记完成（用户还能取消）', !art.getAttribute('data-xqb-done'));
  check('按钮未卡在 busy', art.querySelector('.xqb-btn').dataset.busy !== '1');
  check('提示去官方弹窗点确认', Array.from(sr.querySelectorAll('.toast')).some((t) => /官方弹窗/.test(t.textContent)));

  // 用户自己点了官方「屏蔽」
  document.querySelector('[data-testid="confirmationSheetConfirm"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(900);
  check('手动确认后完成屏蔽', state.blocked.includes('tester'), JSON.stringify(state.blocked));
  check('弹窗消失后背后的菜单被自动收掉', !document.querySelector('#layers [role="menu"]'));
}

async function scenarioStoredMode() {
  console.log('\n[15] 启动即读取用户上次选择的确认方式');
  const { window } = boot();
  window.localStorage.setItem('xqb.mode', JSON.stringify('none'));
  window.localStorage.setItem('xqb.autoConfirmNative', 'false');
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  makeTweet(window, 'tester', 'bbb2');
  window.eval(code);
  await sleep(150);
  check('启动时应用了已存的 mode', window.__XQB__.config.confirmMode === 'none', window.__XQB__.config.confirmMode);
  check('启动时应用了已存的 autoConfirmNative', window.__XQB__.config.autoConfirmNative === false);
}

async function scenarioDuplicateInstall() {
  console.log('\n[16] 重复安装（篡改猴里装了两份）：旧实例的按钮必须被隐藏，新实例照常工作');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'tester', 'dup1');

  // 模拟「旧实例」留下的产物：一个没有 .xqb-mine 标记的按钮 + 它的浮层宿主
  const legacy = document.createElement('div');
  legacy.className = 'xqb-btn';
  legacy.title = '屏蔽 @tester（旧实例）';
  art.querySelector('[data-testid="caret"]').insertAdjacentElement('afterend', legacy);
  const legacyHost = document.createElement('div');
  legacyHost.id = 'xqb-ui-host';
  document.body.appendChild(legacyHost);

  window.eval(code);
  await sleep(200);
  window.__XQB__.config.nativeConfirmDelayMs = 20;

  check('新实例识别出旧实例产物', document.querySelectorAll('.xqb-btn').length === 2, String(document.querySelectorAll('.xqb-btn').length));
  check('本实例按钮带标记', document.querySelectorAll('.xqb-btn.xqb-mine').length === 1);
  check('旧实例按钮不带标记（交给 CSS 隐藏）', document.querySelectorAll('.xqb-btn:not(.xqb-mine)').length === 1);
  check(
    'CSS 规则会隐藏旧实例按钮',
    /\.xqb-btn:not\(\.xqb-mine\)\s*\{\s*display:\s*none/.test(document.getElementById('xqb-style').textContent)
  );

  const st = window.__XQB__.selftest();
  check('selftest 只统计本实例按钮', st.injected === 1 && st.tweets === 1, JSON.stringify(st));
  check('selftest 报告存在重复实例', st.duplicateInstances === 1, JSON.stringify(st));
  const diag = window.__XQB__.diagnose();
  check('diagnose 报告重复按钮数', diag.duplicateInstanceButtons === 1, JSON.stringify(diag));

  // 关键：点击必须作用在本实例的按钮上，而不是旧实例那个
  const mine = art.querySelector('.xqb-btn.xqb-mine');
  mine.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  const pop = document.querySelector('#xqb-ui-host').shadowRoot.querySelector('.pop');
  check('气泡由本实例弹出（旧宿主已清掉）', !!pop);
  pop.querySelector('button[data-act="ok"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);
  check('屏蔽正常完成', state.blocked.includes('tester'), JSON.stringify(state.blocked));
}

async function scenarioNoCaret() {
  console.log('\n[11] 引用推文/无 caret：不应注入按钮，也不应报错');
  const { window, document } = boot();
  const state = { blocked: [], menuOpens: 0, dialogs: 0, itemClicks: [], currentArticle: null, blockTestId: true };
  installFakeX(window, state);
  const art = makeTweet(window, 'quoted', 'bbb');
  art.querySelector('[data-testid="caret"]').remove();
  window.eval(code);
  await sleep(200);
  check('无 caret 时不注入', !art.querySelector('.xqb-btn'));
}

(async () => {
  console.log('目标脚本：' + SCRIPT_PATH);
  await scenarioMain();
  await scenarioCancel();
  await scenarioEscAbort();
  await scenarioNoTestId();
  await scenarioAlreadyBlocked();
  await scenarioRecycle();
  await scenarioAlreadyBlockedRecycle();
  await scenarioInspectMenu();
  await scenarioNoBlockItem();
  await scenarioReplyThread();
  await scenarioModeSwitch();
  await scenarioLongPress();
  await scenarioManualNative();
  await scenarioStoredMode();
  await scenarioDuplicateInstall();
  await scenarioNoCaret();
  console.log('\n========================================');
  console.log('  通过 ' + passes + ' 项，失败 ' + failures + ' 项');
  console.log('========================================');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(2);
});
