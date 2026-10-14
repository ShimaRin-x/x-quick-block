// ==UserScript==
// @name         X 快捷屏蔽 · Quick Block for X
// @name:en      X Quick Block
// @namespace    https://github.com/ShimaRin-x/x-quick-block
// @version      1.3.3
// @description  在推文右上角「…」按钮旁注入一个醒目的【屏蔽】按钮；点击后复放 X 官方原生菜单点击链完成屏蔽，不调用任何私有 API、不处理 csrf/bearer token。支持油猴菜单一键切换「需要确认 / 点击即屏蔽」。
// @description:en Inject a visible Block button next to the tweet caret and drive X's own native menu/confirm flow. Includes a Tampermonkey menu switch for confirm / no-confirm / long-press modes. No private API, no csrf/bearer handling.
// @author       ShimaRin-x
// @license      MIT
// @homepageURL  https://github.com/ShimaRin-x/x-quick-block
// @supportURL   https://github.com/ShimaRin-x/x-quick-block/issues
// @downloadURL  https://raw.githubusercontent.com/ShimaRin-x/x-quick-block/main/x-quick-block.user.js
// @updateURL    https://raw.githubusercontent.com/ShimaRin-x/x-quick-block/main/x-quick-block.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @match        https://pro.x.com/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='9.25' fill='none' stroke='%23f4212e' stroke-width='2'/%3E%3Cpath d='M5.6 18.4 18.4 5.6' stroke='%23f4212e' stroke-width='2'/%3E%3C/svg%3E
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * ============================================================================
 *  X 快捷屏蔽 · 架构总览
 * ============================================================================
 *
 *  ┌─ 观察层 Scanner ────────────────────────────────────────────────────────┐
 *  │ MutationObserver(childList+subtree) → 脏节点队列(Set) → rAF 批量处理      │
 *  │ · 每帧限额 CONFIG.maxPerFrame，防止长列表滚动时掉帧                        │
 *  │ · process() 以 caret 节点身份 + 推文指纹双校验，识别 X 时间线的「节点复用」  │
 *  │ · 5s 低频安全扫描兜底（选择器 :not([data-xqb-done]) 保证廉价）             │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *                                  ↓
 *  ┌─ 注入层 Injector ───────────────────────────────────────────────────────┐
 *  │ 在 [data-testid="caret"] 的相邻位置插入 .xqb-btn                          │
 *  │ · 图标 = 克隆官方菜单项里的 <svg>（首次抓取后缓存，全站复用）                │
 *  │ · pointerdown/mousedown/click 全部 stopPropagation，避免误开详情页        │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *                                  ↓
 *  ┌─ 确认层 Confirm ────────────────────────────────────────────────────────┐
 *  │ 气泡二次确认（或长按触发）。气泡内嵌「克隆 + computed style 内联」的官方    │
 *  │ 菜单行，做到像素级所见即所得；Enter 确认 / Esc 取消 / 滚动即取消            │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *                                  ↓
 *  ┌─ 执行层 NativeFlow（互斥队列，全局同一时刻只允许一个菜单）────────────────┐
 *  │ 1. realClick(caret)                → 打开官方 [role="menu"]              │
 *  │ 2. findMenuAction(menu)            → 命中 [data-testid="block"] 或文案    │
 *  │ 3. captureNativeVisual(blockItem)  → 克隆官方图标/菜单行（视觉缓存）       │
 *  │ 4. realClick(blockItem) [+指针序列兜底] → 官方确认弹窗                    │
 *  │ 5. realClick([data-testid="confirmationSheetConfirm"]) → 完成             │
 *  │ finally: Esc 关闭残留菜单（多级兜底），保证不留下悬挂 UI                    │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 *  ⚠️ 为什么不直接把「克隆出来的节点」当按钮并触发它的 click？
 *     React 17+ 采用根容器事件委托，靠节点上的 __reactFiber$ / __reactProps$
 *     这两个 JS expando 定位 fiber；cloneNode() 只复制 HTML 属性，不复制 expando。
 *     克隆体没有 fiber，React 会顺着 parentNode 找到【外层推文】的 fiber，
 *     事件被派发到错误链路 → 实际效果是打开推文详情页。
 *     因此：克隆只用于「外观 / 预览」，动作统一走原生真实节点复放。
 * ============================================================================
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════
   * 0. 配置
   * ══════════════════════════════════════════════════════════════════════ */

  const VERSION = '1.3.3';
  const LOG_PREFIX = '[XQB]';

  const CONFIG = {
    /** 打开详细日志（console）。控制台执行 __XQB__.config.debug = true 亦可临时开启 */
    debug: false,

    /* ---------- 触发方式 ---------- */
    /** 'popover' = 气泡二次确认 | 'longpress' = 长按触发 | 'none' = 单击直出 */
    confirmMode: 'popover',
    /** 长按模式阈值（ms） */
    longPressMs: 550,

    /* ---------- 官方弹窗 ---------- */
    /** 用户已在我们的气泡里确认过 → 自动点击 X 官方「屏蔽」确认弹窗，避免二次确认 */
    autoConfirmNative: true,
    /** 自动点确认前的等待窗口（ms）：期间按 Esc 可反悔 */
    nativeConfirmDelayMs: 300,
    /**
     * confirmMode = 'none' 时建议设为 false，
     * 否则「单击即屏蔽」= 0 次确认，风险自负。
     */

    /* ---------- 按钮外观 ---------- */
    /** 'after' = 在「…」右侧 | 'before' = 在「…」左侧 */
    buttonPosition: 'after',
    /**
     * 'pill' = 图标 + 「屏蔽」文字 | 'icon' = 仅图标（更紧凑）
     * 两者**默认态都是透明的次级灰**（与 X 的「…」/回复/点赞同色，不打扰阅读），
     * 鼠标悬停时才变成红色胶囊。高度都跟随 caret 实测高度，不会改变 X 的布局。
     */
    buttonStyle: 'pill',
    /**
     * 实测 caret 高度并同步到按钮（真实 X 上 caret 为 20px，
     * 若硬编码 34px 会把 caret 拉伸、破坏其原生 hover 圆形）。
     */
    matchCaretHeight: true,
    /** 克隆官方 SVG 图标（拿到前用内置 circle-slash 兜底） */
    cloneNativeIcon: true,
    /** 确认气泡里内嵌克隆版官方菜单行（像素级预览） */
    clonePreviewRow: true,
    /** 是否在页面空闲时预热抓取一次官方视觉（会闪现一次菜单，默认关） */
    warmUpCapture: false,

    /* ---------- 性能 ---------- */
    /** 每帧最多处理多少条推文 */
    maxPerFrame: 24,
    /** 同一推文的复用校验节流（ms） */
    verifyThrottleMs: 1200,
    /** 低频安全扫描间隔（ms） */
    safetyScanMs: 4000,
    /** 单次 MutationObserver 回调最多处理多少条变更记录 */
    maxRecordsPerTick: 300,

    /* ---------- 超时 ---------- */
    menuTimeoutMs: 1600,
    dialogTimeoutMs: 1800,
    pollIntervalMs: 40,

    /* ---------- 快捷键 ---------- */
    /** 屏蔽「鼠标当前悬停的推文」；设为 null 关闭 */
    hotkey: 'Alt+Shift+B',
    /** 循环切换确认方式（气泡 → 直接屏蔽 → 长按）；设为 null 关闭 */
    modeHotkey: 'Alt+Shift+K',

    /* ---------- 文案兜底 ---------- */
    i18n: {
      blockRe: /^(?:屏蔽|封锁|封鎖|블록|차단|ブロック|block|bloquear|bloquejar|blocca|bloquer|blokkeren|sperren|заблокировать|حظر|engelle|chặn|blokuj|blocare|μπλοκ)/i,
      unblockRe: /(?:取消\s*屏蔽|取消封鎖|解除封鎖|unblock|desbloquear|bloqueo.*取消|débloquer|debloquer|ブロック解除|차단\s*해제|entsperren|разблокировать|إلغاء\s*الحظر|odblokuj|blocco)/i,
      /** 极端情况下的激进兜底：文案含 block/屏蔽 且未被否定即视为屏蔽项 */
      aggressiveFallback: false,
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 1. 选择器注册表 —— X 改版时【只需要改这里】
   * ══════════════════════════════════════════════════════════════════════ */

  const SEL = {
    /** 推文根节点 */
    tweet: ['article[data-testid="tweet"]'],
    /** 「…」更多按钮 */
    caret: ['[data-testid="caret"]'],
    /** 下拉菜单容器候选 */
    menu: ['[role="menu"]', '[data-testid="Dropdown"]'],
    /** 菜单项 */
    menuItem: ['[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]'],
    /** 屏蔽项 */
    blockItem: ['[data-testid="block"]'],
    /** 取消屏蔽项（存在即说明已屏蔽） */
    unblockItem: ['[data-testid="unblock"]'],
    /** 官方确认弹窗的确认按钮 */
    confirmBtn: ['[data-testid="confirmationSheetConfirm"]'],
    /** 官方确认弹窗的取消按钮 */
    cancelBtn: ['[data-testid="confirmationSheetCancel"]'],
    /** 官方弹窗容器 */
    dialog: ['[data-testid="confirmationSheetDialog"]', '[role="dialog"]'],
    /** 用户名区块 */
    userName: ['[data-testid="User-Name"]'],
    /** 浮层挂载点 */
    layers: ['#layers'],
  };

  /** 取 SEL 里首个命中的元素 */
  function q1(root, key) {
    if (!root) return null;
    for (const sel of SEL[key]) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 2. 基础工具
   * ══════════════════════════════════════════════════════════════════════ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    if (CONFIG.debug) console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  /** 轮询等待，返回首个真值；超时返回 null */
  function waitFor(fn, timeoutMs, intervalMs) {
    const gap = intervalMs || CONFIG.pollIntervalMs;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        let v = null;
        try {
          v = fn();
        } catch (e) {
          log('waitFor 内抛错', e);
        }
        if (v) return resolve(v);
        if (performance.now() - t0 >= timeoutMs) return resolve(null);
        setTimeout(tick, gap);
      };
      tick();
    });
  }

  /**
   * 元素是否真实可见。
   *
   * ⚠️ 千万不要用 el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})：
   *    在真实 x.com 上实测，完全可见的下拉菜单（208×440）与全部菜单项
   *    都会得到 false —— X 的浮层祖先链上带有 content-visibility / opacity 之类的
   *    绘制优化属性，checkVisibility 会顺着祖先链把它们判成不可见。
   *    一旦这里误判，getVisibleMenuRoots() 永远为空，整个功能直接失效。
   *    因此只用「已在文档中 + 有实际尺寸 + 自身未被 display/visibility 隐藏」。
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return false;
    }
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return true;
  }

  function normText(el) {
    if (!el) return '';
    const aria = el.getAttribute && el.getAttribute('aria-label');
    const raw = (el.textContent || '') + ' ' + (aria || '');
    return raw.replace(/\s+/g, ' ').trim();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 3. 原生事件复放
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 首选 el.click()：这是浏览器原生派发，React 的 onClick 会正常响应。
   * 失败时退回完整指针序列。
   */
  function realClick(el) {
    if (!el || !el.isConnected) return false;
    try {
      el.click();
      return true;
    } catch (e) {
      log('el.click() 失败，改用指针序列', e);
    }
    try {
      dispatchPointerSequence(el);
      return true;
    } catch (e2) {
      warn('指针序列派发失败', e2);
      return false;
    }
  }

  /** 完整 mouse/pointer 序列，用于 el.click() 不生效的老版本/特殊节点 */
  function dispatchPointerSequence(el) {
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2) || 1;
    const y = Math.round(r.top + r.height / 2) || 1;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
    };
    const hasPointer = typeof window.PointerEvent === 'function';
    const emit = (type, Ctor, extra) => {
      try {
        el.dispatchEvent(new Ctor(type, Object.assign({}, common, extra || {})));
      } catch (_) {
        /* 构造失败忽略 */
      }
    };
    if (hasPointer) {
      emit('pointerover', PointerEvent, { buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
      emit('pointerenter', PointerEvent, { buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: false });
    }
    emit('mouseover', MouseEvent, { buttons: 0 });
    if (hasPointer) emit('pointerdown', PointerEvent, { buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    emit('mousedown', MouseEvent, { buttons: 1 });
    if (hasPointer) emit('pointerup', PointerEvent, { buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    emit('mouseup', MouseEvent, { buttons: 0 });
    emit('click', MouseEvent, { buttons: 0 });
  }

  /** 派发 Esc（多目标，兼容 React 委托与原生监听两种实现） */
  function pressEscape(target) {
    const t = target && target.isConnected ? target : document.body;
    let ev;
    try {
      ev = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      // 老式 handler 会读 keyCode/which，构造器不接受，只能 defineProperty
      Object.defineProperty(ev, 'keyCode', { get: () => 27 });
      Object.defineProperty(ev, 'which', { get: () => 27 });
    } catch (_) {
      return;
    }
    t.dispatchEvent(ev);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 4. 浮层探查（菜单 / 弹窗）
   * ══════════════════════════════════════════════════════════════════════ */

  /** 所有当前可见的菜单候选（X 把浮层 portal 到 #layers） */
  function getVisibleMenuRoots() {
    const scope = document.getElementById('layers') || document.body;
    const out = [];
    const seen = new Set();
    for (const sel of SEL.menu) {
      let list;
      try {
        list = scope.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of list) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out;
  }

  function lastVisibleMenu() {
    const list = getVisibleMenuRoots();
    return list.length ? list[list.length - 1] : null;
  }

  /**
   * 从候选里挑出「刚才那次 caret 点击」打开的菜单。
   * 打分依据：离 caret 近 + 含屏蔽/取消屏蔽项 + 含菜单项，同时排除点击前就存在的旧菜单。
   */
  function pickCaretMenu(prevMenu, caret) {
    const menus = getVisibleMenuRoots();
    if (!menus.length) return null;

    let cr = null;
    try {
      cr = caret.getBoundingClientRect();
    } catch (_) {
      /* ignore */
    }

    let best = null;
    let bestScore = -Infinity;

    for (const m of menus) {
      let score = 0;
      const isPrev = m === prevMenu;
      if (isPrev) score -= 30; // 旧菜单强烈降权（但不硬排除：X 可能复用同一节点）

      const hasBlock = !!(m.querySelector(SEL.blockItem.join(',')) || m.querySelector(SEL.unblockItem.join(',')));
      const items = m.querySelectorAll(SEL.menuItem.join(','));
      if (hasBlock) score += 60;
      if (items.length) score += 8;
      if (!items.length && !hasBlock) score -= 40; // 空壳/骨架

      if (cr && items.length) {
        const r = m.getBoundingClientRect();
        const dx = Math.abs((r.left + r.right) / 2 - (cr.left + cr.right) / 2);
        const dy = Math.abs(r.top - cr.bottom);
        score += Math.max(0, 500 - (dx + dy)) / 20;
      }
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** 收集菜单项（兼容 testid 落在 menuItem 本身或其后代两种情况） */
  function collectMenuItems(root) {
    if (!root) return [];
    const sels = SEL.menuItem.concat(SEL.blockItem, SEL.unblockItem).join(',');
    let all;
    try {
      all = Array.from(root.querySelectorAll(sels));
    } catch (_) {
      return [];
    }
    const out = [];
    const seen = new Set();
    for (const el of all) {
      const item = el.matches(SEL.menuItem.join(',')) ? el : el.closest(SEL.menuItem.join(',')) || el;
      if (seen.has(item) || !isVisible(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  }

  /**
   * 定位「屏蔽」/「取消屏蔽」菜单项。
   * 三级策略：① data-testid ② 多语言文案 ③（可选）激进兜底
   * @returns {{kind:'block'|'unblock', el:Element, via:string}|null}
   */
  function findMenuAction(root) {
    const items = collectMenuItems(root);
    if (!items.length) return null;

    const hitTestId = (key) => {
      for (const sel of SEL[key]) {
        for (const el of items) {
          if (el.matches(sel)) return el;
          const inner = el.querySelector(sel);
          if (inner) return el;
        }
      }
      return null;
    };

    const blockById = hitTestId('blockItem');
    if (blockById) return { kind: 'block', el: blockById, via: 'testid:block' };

    const unblockById = hitTestId('unblockItem');
    if (unblockById) return { kind: 'unblock', el: unblockById, via: 'testid:unblock' };

    // 文案匹配：先判定否定式，避免把「取消屏蔽」当成「屏蔽」
    for (const el of items) {
      const t = normText(el);
      if (!t) continue;
      if (CONFIG.i18n.unblockRe.test(t)) return { kind: 'unblock', el, via: 'text:unblock' };
    }
    for (const el of items) {
      const t = normText(el);
      if (!t) continue;
      if (CONFIG.i18n.blockRe.test(t)) return { kind: 'block', el, via: 'text:block' };
    }

    if (CONFIG.i18n.aggressiveFallback) {
      for (const el of items) {
        const t = normText(el);
        if (/block|屏蔽|封鎖/i.test(t)) return { kind: 'block', el, via: 'aggressive' };
      }
    }
    return null;
  }

  /** 官方确认弹窗的确认按钮（取可见的最后一个） */
  function getConfirmButton() {
    const scope = document.getElementById('layers') || document.body;
    const list = scope.querySelectorAll(SEL.confirmBtn.join(','));
    for (let i = list.length - 1; i >= 0; i--) {
      if (isVisible(list[i])) return list[i];
    }
    // 兜底：testid 改版时，在可见弹窗里按文案找（排除「取消屏蔽」等否定式）
    const dlg = getVisibleDialog();
    if (!dlg) return null;
    const btns = dlg.querySelectorAll('button,[role="button"]');
    for (let i = btns.length - 1; i >= 0; i--) {
      const el = btns[i];
      if (!isVisible(el)) continue;
      const t = normText(el);
      if (!t || t.length > 24) continue;
      if (CONFIG.i18n.unblockRe.test(t)) continue;
      if (CONFIG.i18n.blockRe.test(t)) return el;
    }
    return null;
  }

  function getCancelButton() {
    const scope = document.getElementById('layers') || document.body;
    const list = scope.querySelectorAll(SEL.cancelBtn.join(','));
    for (let i = list.length - 1; i >= 0; i--) {
      if (isVisible(list[i])) return list[i];
    }
    const dlg = getVisibleDialog();
    if (!dlg) return null;
    const btns = dlg.querySelectorAll('button,[role="button"]');
    for (let i = btns.length - 1; i >= 0; i--) {
      const el = btns[i];
      if (!isVisible(el)) continue;
      const t = normText(el);
      if (/^(取消|取消屏蔽|Cancel|Never mind|Not now)$/i.test(t)) return el;
    }
    return null;
  }

  function getVisibleDialog() {
    const scope = document.getElementById('layers') || document.body;
    for (const sel of SEL.dialog) {
      const list = scope.querySelectorAll(sel);
      for (let i = list.length - 1; i >= 0; i--) {
        if (isVisible(list[i])) return list[i];
      }
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 5. 克隆视觉 —— 「克隆法」真正成立的地方
   * ══════════════════════════════════════════════════════════════════════ */

  /** 克隆时要内联的 computed style 白名单（shadow DOM 里没有 X 的样式表，必须内联） */
  const COPY_PROPS = [
    'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space',
    'display', 'flex-direction', 'align-items', 'justify-content', 'flex-grow', 'flex-shrink',
    'gap', 'padding', 'margin', 'border', 'border-radius', 'width', 'height',
    'min-width', 'min-height', 'max-width', 'box-sizing', 'opacity', 'fill', 'stroke',
  ];

  /** 深拷贝节点并内联计算样式（用于确认气泡里的官方菜单行预览） */
  function cloneWithStyles(src) {
    const dst = src.cloneNode(false);
    const cs = getComputedStyle(src);
    for (const p of COPY_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== 'none' && v !== 'normal') dst.style.setProperty(p, v);
    }
    // 递归子节点
    for (const child of Array.from(src.childNodes)) {
      if (child.nodeType === 1) {
        dst.appendChild(cloneWithStyles(child));
      } else if (child.nodeType === 3) {
        dst.appendChild(document.createTextNode(child.nodeValue));
      }
    }
    // 去掉所有交互语义，纯展示
    dst.removeAttribute('role');
    dst.removeAttribute('tabindex');
    dst.removeAttribute('id');
    dst.style.pointerEvents = 'none';
    dst.setAttribute('aria-hidden', 'true');
    dst.querySelectorAll('[role],[tabindex],[id],[data-testid]').forEach((n) => {
      n.removeAttribute('role');
      n.removeAttribute('tabindex');
      n.removeAttribute('id');
      n.removeAttribute('data-testid');
    });
    return dst;
  }

  const Visual = {
    /** 官方屏蔽图标的 outerHTML（首次从真实菜单抓取后缓存） */
    iconSvg: '',
    /** 官方菜单行的克隆体（展示用） */
    previewRow: null,
    captured: false,
  };

  /** 从真实菜单项抓取官方视觉，供按钮图标与确认气泡复用 */
  function captureNativeVisual(blockItem) {
    if (!blockItem) return;
    try {
      if (!Visual.iconSvg) {
        const svg = blockItem.querySelector('svg');
        if (svg) {
          const c = svg.cloneNode(true);
          // 去掉 id/class，避免与 X 自己的雪碧图样式/引用冲突，也避免 class 重复属性
          c.removeAttribute('id');
          c.removeAttribute('class');
          c.querySelectorAll('[id],[class]').forEach((n) => {
            n.removeAttribute('id');
            n.removeAttribute('class');
          });
          c.setAttribute('width', '18');
          c.setAttribute('height', '18');
          c.setAttribute('aria-hidden', 'true');
          c.style.display = 'block';
          Visual.iconSvg = c.outerHTML;
          log('已缓存官方屏蔽图标');
          applyCachedIconToAll();
        }
      }
      if (!Visual.previewRow) {
        Visual.previewRow = cloneWithStyles(blockItem);
        log('已缓存官方菜单行预览');
      }
      Visual.captured = true;
    } catch (e) {
      warn('抓取官方视觉失败（不影响功能）', e);
    }
  }

  /** 内置兜底图标（禁行标志） */
  const FALLBACK_ICON =
    '<svg class="xqb-ic" viewBox="0 0 24 24" aria-hidden="true" style="display:block">' +
    '<circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M5.6 18.4 18.4 5.6" stroke="currentColor" stroke-width="2" fill="none"/>' +
    '</svg>';

  function iconHTML() {
    return CONFIG.cloneNativeIcon && Visual.iconSvg
      ? Visual.iconSvg.replace('<svg', '<svg class="xqb-ic"')
      : FALLBACK_ICON;
  }

  function applyCachedIconToAll() {
    if (!Visual.iconSvg) return;
    document.querySelectorAll('.xqb-btn .xqb-ic-slot').forEach((slot) => {
      if (slot.dataset.icon === 'native') return; // 已是官方图标
      slot.innerHTML = iconHTML();
      slot.dataset.icon = 'native';
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 6. 主题
   * ══════════════════════════════════════════════════════════════════════ */

  function detectTheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/(\d+(?:\.\d+)?)/g);
      if (!m || m.length < 3) return 'dark';
      const [r, g, b] = m.map(Number);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum > 0.5 ? 'light' : 'dark';
    } catch (_) {
      return 'dark';
    }
  }

  function syncTheme() {
    const t = detectTheme();
    document.documentElement.classList.toggle('xqb-dark', t === 'dark');
    if (uiHost) uiHost.classList.toggle('xqb-dark', t === 'dark');
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 7. UI：样式 / Shadow 宿主 / Toast / 确认气泡
   * ══════════════════════════════════════════════════════════════════════ */

  const LIGHT_DOM_CSS = `
:root {
  --xqb-danger: rgb(244, 33, 46);
  --xqb-danger-bg: rgba(244, 33, 46, 0.10);
  --xqb-fg: rgb(83, 100, 113);
  --xqb-fg-strong: rgb(15, 20, 25);
}
html.xqb-dark {
  --xqb-danger: rgb(249, 24, 52);
  --xqb-danger-bg: rgba(249, 24, 52, 0.12);
  --xqb-fg: rgb(113, 118, 123);
  --xqb-fg-strong: rgb(231, 233, 234);
}
.xqb-btn {
  /* 高度由脚本按 caret 实测值写入 --xqb-h（真实 X 上为 20px）。
     这一点在实测中很关键：若按钮高于 caret，会把 caret 拉伸成竖长胶囊、
     并改变 X 原生 hover 形状；跟随高度则对原生布局零影响。 */
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-sizing: border-box;
  flex: 0 0 auto;
  align-self: center;
  height: var(--xqb-h, 20px);
  min-width: var(--xqb-h, 20px);
  margin: 0 1px;
  padding: 0 5px;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: var(--xqb-fg);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: background-color .15s ease, color .15s ease, opacity .15s ease, transform .1s ease;
  z-index: 2;
}
/* 默认态：完全对齐 X 原生操作栏 —— 透明底 + 次级灰（与旁边的「…」同色），不打扰阅读
   hover 态：红色胶囊（文字/图标变红 + 淡红底），沿用 X 自己 hover 的配色习惯 */
.xqb-btn[data-style="pill"] { background: transparent; color: var(--xqb-fg); }
.xqb-btn[data-style="pill"]:hover,
.xqb-btn[data-style="icon"]:hover {
  background: var(--xqb-danger-bg);
  color: var(--xqb-danger);
}
.xqb-btn:focus-visible { outline: 2px solid var(--xqb-danger); outline-offset: 1px; }
.xqb-btn .xqb-ic-slot { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.xqb-btn .xqb-ic,
.xqb-btn .xqb-ic-slot svg {
  display: block;
  width: calc(var(--xqb-h, 20px) - 6px);
  height: calc(var(--xqb-h, 20px) - 6px);
  fill: currentColor;
}
.xqb-btn .xqb-tx {
  font-size: calc(var(--xqb-h, 20px) - 8px);
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.xqb-btn[data-pressing="1"] { transform: scale(.88); background: var(--xqb-danger-bg); color: var(--xqb-danger); }
.xqb-btn[data-busy="1"] { pointer-events: none; opacity: .85; color: var(--xqb-danger); }
.xqb-btn[data-busy="1"] > * { opacity: .12; }
.xqb-btn[data-busy="1"]::after {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: xqb-spin .7s linear infinite;
}
.xqb-btn[data-state="blocked"] { color: var(--xqb-danger); cursor: default; }
@keyframes xqb-spin { to { transform: rotate(360deg); } }
`;

  const SHADOW_CSS = `
:host {
  all: initial;
  --xqb-bg: rgb(255, 255, 255);
  --xqb-fg: rgb(15, 20, 25);
  --xqb-sub: rgb(83, 100, 113);
  --xqb-line: rgba(0, 0, 0, .08);
  --xqb-danger: rgb(244, 33, 46);
  --xqb-shadow: 0 4px 24px rgba(0, 0, 0, .22);
}
:host(.xqb-dark) {
  --xqb-bg: rgb(0, 0, 0);
  --xqb-fg: rgb(231, 233, 234);
  --xqb-sub: rgb(113, 118, 123);
  --xqb-line: rgba(255, 255, 255, .12);
  --xqb-danger: rgb(249, 24, 52);
  --xqb-shadow: 0 4px 24px rgba(255, 255, 255, .12);
}
.wrap { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
                     "PingFang SC", "Microsoft YaHei", sans-serif; }
.pop {
  position: fixed; pointer-events: auto; min-width: 240px; max-width: 320px;
  background: var(--xqb-bg); color: var(--xqb-fg);
  border: 1px solid var(--xqb-line); border-radius: 16px;
  box-shadow: var(--xqb-shadow); padding: 12px 12px 10px;
  font-size: 14px; line-height: 1.35;
  animation: pop-in .12s ease-out;
}
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
.pop-title { font-size: 15px; font-weight: 800; margin-bottom: 8px; }
.pop-preview {
  margin: 2px 0 10px; padding: 6px 8px; border-radius: 10px;
  background: rgba(127, 127, 127, .12); overflow: hidden;
}
.pop-preview .fallback { display: flex; align-items: center; gap: 10px;
  font-size: 15px; font-weight: 400; color: var(--xqb-fg); padding: 4px 2px; }
.pop-preview .fallback svg { width: 18px; height: 18px; flex: 0 0 auto; }
.pop-actions { display: flex; gap: 8px; justify-content: flex-end; }
.pop-actions button {
  font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
  border-radius: 9999px; padding: 7px 14px; border: 1px solid var(--xqb-line);
  background: transparent; color: var(--xqb-fg);
}
.pop-actions button[data-act="cancel"]:hover { background: rgba(127, 127, 127, .16); }
.pop-actions button[data-act="ok"] { background: var(--xqb-danger); border-color: transparent; color: #fff; }
.pop-actions button[data-act="ok"]:hover { filter: brightness(1.08); }
.pop-hint { margin-top: 8px; font-size: 11px; color: var(--xqb-sub); text-align: right; }
.toasts { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
          display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
.toast {
  max-width: 76vw; padding: 9px 16px; border-radius: 9999px;
  background: var(--xqb-bg); color: var(--xqb-fg);
  border: 1px solid var(--xqb-line); box-shadow: var(--xqb-shadow);
  font-size: 13px; font-weight: 600; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; animation: toast-in .16s ease-out;
}
.toast[data-type="ok"] { border-color: rgba(0, 186, 124, .55); }
.toast[data-type="err"] { border-color: var(--xqb-danger); color: var(--xqb-danger); }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } }
`;

  /** 注入 light DOM 样式（按钮活体在 X 的 DOM 里，只能用普通样式表） */
  function injectLightStyle() {
    if (document.getElementById('xqb-style')) return;
    const s = document.createElement('style');
    s.id = 'xqb-style';
    s.textContent = LIGHT_DOM_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  let uiHost = null;
  let uiRoot = null;
  let uiWrap = null;
  let toastBox = null;

  function ensureUiHost() {
    if (uiHost && uiHost.isConnected) return;
    uiHost = document.createElement('div');
    uiHost.id = 'xqb-ui-host';
    uiHost.style.cssText = 'all:initial;position:static;';
    uiRoot = uiHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    uiRoot.appendChild(style);
    uiWrap = document.createElement('div');
    uiWrap.className = 'wrap';
    uiRoot.appendChild(uiWrap);
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    uiWrap.appendChild(toastBox);
    (document.body || document.documentElement).appendChild(uiHost);
    syncTheme();
  }

  const Toast = {
    show(msg, type) {
      ensureUiHost();
      const el = document.createElement('div');
      el.className = 'toast';
      el.dataset.type = type || 'info';
      el.textContent = msg;
      toastBox.appendChild(el);
      while (toastBox.children.length > 3) toastBox.removeChild(toastBox.firstChild);
      setTimeout(() => {
        el.style.transition = 'opacity .18s ease';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      }, 2600);
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 7.5 设置持久化 + 油猴菜单开关
   * ══════════════════════════════════════════════════════════════════════ */

  const MODE_TEXT = {
    popover: '气泡二次确认',
    none: '直接屏蔽（无需确认）',
    longpress: '长按屏蔽',
  };

  /** 优先用油猴存储；没有 GM_* 时退化为 localStorage，脚本仍可独立运行 */
  const Store = {
    get(key, dflt) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue('xqb.' + key);
          return v === undefined ? dflt : v;
        }
        const raw = localStorage.getItem('xqb.' + key);
        return raw === null ? dflt : JSON.parse(raw);
      } catch (_) {
        return dflt;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue('xqb.' + key, value);
        else localStorage.setItem('xqb.' + key, JSON.stringify(value));
      } catch (_) {
        /* 存储不可用时忽略：只影响下次启动是否记得 */
      }
    },
  };

  /** 启动时载入用户上次的选择 */
  function applyStoredSettings() {
    const m = Store.get('mode', null);
    if (m && MODE_TEXT[m]) CONFIG.confirmMode = m;
    const a = Store.get('autoConfirmNative', null);
    if (typeof a === 'boolean') CONFIG.autoConfirmNative = a;
    log('已载入设置', { mode: CONFIG.confirmMode, autoConfirmNative: CONFIG.autoConfirmNative });
  }

  /**
   * 注册 / 刷新油猴菜单。
   * 只有声明了 @grant GM_registerMenuCommand 才会出现菜单项；
   * 这里用 typeof 守卫，所以脚本即便在 @grant none 下也照常工作（只是没有菜单）。
   */
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    const tick = (on) => (on ? '● ' : '○ ');
    const cmds = [
      ['xqb-mode-popover', tick(CONFIG.confirmMode === 'popover') + '确认方式：气泡二次确认', () => setMode('popover')],
      ['xqb-mode-none', tick(CONFIG.confirmMode === 'none') + '确认方式：直接屏蔽（点一下即屏蔽）', () => setMode('none')],
      ['xqb-mode-longpress', tick(CONFIG.confirmMode === 'longpress') + '确认方式：长按 ' + CONFIG.longPressMs / 1000 + ' 秒屏蔽', () => setMode('longpress')],
      ['xqb-native', tick(CONFIG.autoConfirmNative) + '官方确认弹窗：自动点掉', () => setAutoConfirmNative(!CONFIG.autoConfirmNative)],
      ['xqb-status', '查看当前设置', () => api.status()],
      ['xqb-reset', '重置注入状态（排障用）', () => api.reset()],
    ];
    for (const [id, label, fn] of cmds) {
      try {
        if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id);
        GM_registerMenuCommand(label, fn, { id, autoClose: true });
      } catch (e) {
        // 老版本 TM 不支持 {id} 选项：退回匿名注册（功能可用，但勾选状态不会刷新）
        try {
          GM_registerMenuCommand(label, fn);
        } catch (_) {
          /* 注册失败静默处理，不影响主功能 */
        }
      }
    }
  }

  /** 切换确认方式（并记住） */
  function setMode(mode) {
    if (!MODE_TEXT[mode]) return CONFIG.confirmMode;
    CONFIG.confirmMode = mode;
    Store.set('mode', mode);
    registerMenu();
    Toast.show('确认方式：' + MODE_TEXT[mode], 'ok');
    log('confirmMode =', mode);
    return mode;
  }

  /** 循环切换：气泡 → 直接屏蔽 → 长按 → 气泡 */
  function cycleMode() {
    const order = ['popover', 'none', 'longpress'];
    const i = order.indexOf(CONFIG.confirmMode);
    return setMode(order[(i + 1) % order.length]);
  }

  /** 是否自动点掉官方确认弹窗 */
  function setAutoConfirmNative(on) {
    CONFIG.autoConfirmNative = !!on;
    Store.set('autoConfirmNative', CONFIG.autoConfirmNative);
    registerMenu();
    Toast.show(
      CONFIG.autoConfirmNative ? '官方确认弹窗：自动点掉' : '官方确认弹窗：留给你手动点',
      'info'
    );
    return CONFIG.autoConfirmNative;
  }

  /** 二次确认气泡 */
  const Popover = {
    el: null,
    resolver: null,
    anchor: null,
    handlers: null,

    isOpen() {
      return !!this.el;
    },

    /**
     * @param {{anchor:HTMLElement, title:string, handle:string, preview:Node|null}} opts
     * @returns {Promise<boolean>}
     */
    open(opts) {
      this.close(false);
      ensureUiHost();

      const el = document.createElement('div');
      el.className = 'pop';
      el.setAttribute('role', 'dialog');

      const title = document.createElement('div');
      title.className = 'pop-title';
      title.textContent = opts.title || '确认屏蔽？';
      el.appendChild(title);

      if (opts.preview) {
        const box = document.createElement('div');
        box.className = 'pop-preview';
        box.appendChild(opts.preview);
        el.appendChild(box);
      }

      const actions = document.createElement('div');
      actions.className = 'pop-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.dataset.act = 'cancel';
      cancel.textContent = '取消';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.dataset.act = 'ok';
      ok.textContent = '确认屏蔽';
      actions.appendChild(cancel);
      actions.appendChild(ok);
      el.appendChild(actions);

      const hint = document.createElement('div');
      hint.className = 'pop-hint';
      hint.textContent = 'Enter 确认 · Esc 取消';
      el.appendChild(hint);

      uiWrap.appendChild(el);
      this.el = el;
      this.anchor = opts.anchor;

      el.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        this.close(btn.dataset.act === 'ok');
      });

      // 定位：默认贴在按钮右下方，越界自动翻转/夹紧
      this.position();

      const onKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          this.close(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.close(false);
        }
      };
      // 滚动策略：不再直接关掉，而是跟着锚点重新定位；只有锚点滚出视口才关闭。
      // （真实站点上点击后可能紧随伪滚动事件，开头 250ms 直接忽略）
      const openedAt = performance.now();
      const onScroll = () => {
        if (performance.now() - openedAt < 250) return;
        const a = this.anchor;
        if (a && a.isConnected) {
          const r = a.getBoundingClientRect();
          if (r.bottom > 0 && r.top < window.innerHeight) {
            this.position();
            return;
          }
        }
        this.close(false);
      };
      const onResize = () => this.close(false);
      this.handlers = { onKey, onScroll, onResize };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, { passive: true, capture: true });
      window.addEventListener('resize', onResize, { passive: true });
      document.addEventListener('mousedown', this._onOutside = (e) => {
        if (this.el && !e.composedPath().includes(this.el) && !e.composedPath().includes(this.anchor)) {
          this.close(false);
        }
      }, true);

      setTimeout(() => {
        try {
          ok.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }, 0);

      return new Promise((resolve) => {
        this.resolver = resolve;
      });
    },

    position() {
      if (!this.el || !this.anchor || !this.anchor.isConnected) return;
      const a = this.anchor.getBoundingClientRect();
      const r = this.el.getBoundingClientRect();
      const M = 8;
      let left = a.right - r.width;
      let top = a.bottom + 6;
      if (left < M) left = M;
      if (left + r.width > window.innerWidth - M) left = window.innerWidth - M - r.width;
      if (top + r.height > window.innerHeight - M) top = a.top - r.height - 6;
      if (top < M) top = M;
      this.el.style.left = Math.round(left) + 'px';
      this.el.style.top = Math.round(top) + 'px';
    },

    close(result) {
      if (!this.el) return;
      const el = this.el;
      const res = this.resolver;
      this.el = null;
      this.resolver = null;
      if (this.handlers) {
        window.removeEventListener('keydown', this.handlers.onKey, true);
        window.removeEventListener('scroll', this.handlers.onScroll, { capture: true });
        window.removeEventListener('resize', this.handlers.onResize);
        this.handlers = null;
      }
      if (this._onOutside) {
        document.removeEventListener('mousedown', this._onOutside, true);
        this._onOutside = null;
      }
      this.anchor = null;
      el.remove();
      if (res) res(!!result);
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 8. 错误与文案
   * ══════════════════════════════════════════════════════════════════════ */

  class XQBError extends Error {
    constructor(code, message) {
      super(message || XQBError.text(code));
      this.name = 'XQBError';
      this.code = code;
    }
    static text(code) {
      const M = {
        CARET_NOT_FOUND: '未找到该推文的「更多」按钮',
        MENU_TIMEOUT: '原生菜单打开超时，请重试',
        NO_BLOCK_ITEM: '菜单里没有「屏蔽」项（可能是广告/自己的推文/引用推文）',
        ALREADY_BLOCKED: '该账号已在你的屏蔽列表中',
        CLICK_FAILED: '点击「屏蔽」无效，X 可能已改版（可执行 __XQB__.inspectMenu() 排查）',
        DIALOG_NOT_RECOGNIZED: '官方弹窗已出现，但未识别出确认按钮，请手动点击',
        DIALOG_TIMEOUT: '未检测到官方确认弹窗',
        ABORTED: '已取消',
        LOCK_BUSY: '正在处理中，请稍候',
      };
      return M[code] || code;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 9. 执行层：互斥队列 + 原生点击链复放
   * ══════════════════════════════════════════════════════════════════════ */

  let lockChain = Promise.resolve();
  let lockDepth = 0;

  /** 全局互斥：同一时刻只允许驱动一个 X 下拉菜单 */
  function withMenuLock(task) {
    const next = lockChain.then(async () => {
      lockDepth += 1;
      try {
        return await task();
      } finally {
        lockDepth -= 1;
      }
    });
    lockChain = next.catch(() => {});
    return next;
  }

  function isBusy() {
    return lockDepth > 0;
  }

  /**
   * 关闭残留菜单。
   *
   * ⚠️ 实测结论（真实 x.com）：Esc **不能**关掉 caret 下拉菜单 —— 派发 Escape 时
   *    能观察到 X 的处理器确实执行了（defaultPrevented === true），但菜单仍然留着。
   *    而再次点击 caret（X 自己的 toggle 逻辑）100% 生效。
   *    因此顺序为：① caret 再点一次  ② Esc（多目标，兼容其它浮层）  ③ 外部 mousedown
   *
   * @param {Element|null} caret 触发本次菜单的 caret；缺失时跳过第 ① 步
   * @returns {Promise<boolean>} 是否已确认关闭
   */
  async function closeMenuIfOpen(caret) {
    const isClosed = () => !getVisibleMenuRoots().length;
    if (isClosed()) return true;

    // ① 官方 toggle：再点一次 caret
    if (caret && caret.isConnected) {
      realClick(caret);
      if (await waitFor(isClosed, 400, 30)) return true;
    }

    // ② Esc：无法关闭本菜单，但能关掉其它浮层，保留作为兜底
    const menu = lastVisibleMenu();
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) pressEscape(active);
    if (menu) pressEscape(menu);
    pressEscape(document.body);
    pressEscape(document);
    if (await waitFor(isClosed, 300, 30)) return true;

    // ③ 外部 mousedown（X 的浮层常规关闭路径）
    try {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
      document.dispatchEvent(new MouseEvent('mousedown', init));
      document.body.dispatchEvent(new MouseEvent('mousedown', init));
    } catch (_) {
      /* ignore */
    }
    if (await waitFor(isClosed, 300, 30)) return true;

    // ④ 最后再试一次 caret（第 ① 步可能被 X 的过渡动画吞掉）
    if (caret && caret.isConnected && getVisibleMenuRoots().length) {
      realClick(caret);
      if (await waitFor(isClosed, 400, 30)) return true;
    }
    if (!isClosed()) warn('菜单未能自动关闭，请手动点击空白处');
    return isClosed();
  }

  /**
   * 打开某条推文的官方 caret 菜单
   * @returns {Promise<Element|null>}
   */
  async function openCaretMenu(caret) {
    const prev = lastVisibleMenu();
    const hasAria = caret.hasAttribute('aria-expanded'); // 实测真实 X 上存在，且 false → true
    realClick(caret);

    let expanded = false;
    if (hasAria) {
      expanded = !!(await waitFor(
        () => (caret.getAttribute('aria-expanded') === 'true' ? true : null),
        900,
        30
      ));
      if (expanded) log('caret aria-expanded=true');
    }

    let menu = await waitFor(() => pickCaretMenu(prev, caret), CONFIG.menuTimeoutMs);
    if (menu) return menu;

    log('click() 未唤出菜单，改用完整指针序列');
    dispatchPointerSequence(caret);
    menu = await waitFor(() => pickCaretMenu(prev, caret), CONFIG.menuTimeoutMs);

    if (!menu && expanded) {
      warn('caret 已展开但未识别到菜单，选择器可能失效 → 控制台执行 __XQB__.inspectMenu()');
    }
    return menu;
  }

  /**
   * 点击屏蔽项并等待官方确认弹窗
   * @returns {Promise<Element|null>} 确认按钮，或 null（未出现弹窗）
   */
  async function clickBlockAndWaitDialog(blockItem) {
    realClick(blockItem);
    let btn = await waitFor(getConfirmButton, CONFIG.dialogTimeoutMs);
    if (btn) return btn;

    if (blockItem.isConnected) {
      log('屏蔽项 click() 未触发弹窗，改用指针序列重试');
      dispatchPointerSequence(blockItem);
      btn = await waitFor(getConfirmButton, CONFIG.dialogTimeoutMs);
    }
    return btn;
  }

  /**
   * 官方弹窗留给用户手动处理时，等弹窗消失后自动收掉背后残留的下拉菜单。
   * 实测（真实 x.com）：点了「屏蔽」→ 官方确认弹窗出现 → 弹窗消失后
   * **下拉菜单依然留在页面上**，X 不会自己收掉，必须由我们再 toggle 一次 caret。
   */
  function scheduleMenuCleanupAfterDialog(caret) {
    const c = caret;
    waitFor(() => !getVisibleDialog(), 120000, 400).then(() => {
      if (!getVisibleDialog()) closeMenuIfOpen(c);
    });
  }

  /**
   * 完整原生屏蔽流程。调用方必须已持有 withMenuLock。
   * @returns {Promise<{mode:'auto'|'manual'|'direct', verified:boolean, reason?:string}>}
   */
  async function nativeBlockFlow(article) {
    const caret = findCaret(article);
    if (!caret) throw new XQBError('CARET_NOT_FOUND');

    let confirmBtn = null;
    try {
      // ① 打开官方菜单
      const menu = await openCaretMenu(caret);
      if (!menu) throw new XQBError('MENU_TIMEOUT');

      // ② 定位「屏蔽」项
      const hit = findMenuAction(menu);
      if (!hit) throw new XQBError('NO_BLOCK_ITEM');
      if (hit.kind === 'unblock') throw new XQBError('ALREADY_BLOCKED');
      log('命中屏蔽项', hit.via, normText(hit.el).slice(0, 40));

      // ③ 克隆官方视觉（图标 + 菜单行）
      captureNativeVisual(hit.el);

      // ④ 点击原生屏蔽项
      confirmBtn = await clickBlockAndWaitDialog(hit.el);

      if (!confirmBtn) {
        // 弹窗在、但按钮没被识别出来 → 不擅自判断成功，交给用户手动点
        if (getVisibleDialog()) {
          scheduleMenuCleanupAfterDialog(caret);
          return { mode: 'manual', verified: false, reason: 'unrecognized' };
        }
        // 没弹窗且菜单已消失：该分支直接执行了（无法确证，标记未验证）
        if (!getVisibleMenuRoots().length) {
          log('无确认弹窗且菜单已关闭，判定为直接执行');
          return { mode: 'direct', verified: false };
        }
        throw new XQBError('CLICK_FAILED');
      }

      if (!CONFIG.autoConfirmNative) {
        // 交由用户手动点官方弹窗（此时不要关弹窗），弹窗消失后再自动收掉菜单
        scheduleMenuCleanupAfterDialog(caret);
        return { mode: 'manual', verified: false };
      }

      // ⑤ 官方确认弹窗 —— 留一个反悔窗口，期间 Esc 可中止
      let aborted = false;
      const onKey = (e) => {
        if (e.key === 'Escape') {
          aborted = true;
          e.preventDefault();
          e.stopPropagation();
        }
      };
      window.addEventListener('keydown', onKey, true);
      try {
        await sleep(CONFIG.nativeConfirmDelayMs);
      } finally {
        window.removeEventListener('keydown', onKey, true);
      }

      if (aborted) {
        const cancel = getCancelButton();
        if (cancel) realClick(cancel);
        else pressEscape(getVisibleDialog() || document.body);
        throw new XQBError('ABORTED');
      }

      realClick(confirmBtn);

      // 弹窗消失 = 官方已受理（这是可靠的成功信号）
      const closed = await waitFor(() => !getVisibleDialog(), 2500, 60);
      return { mode: 'auto', verified: !!closed };
    } finally {
      // 弹窗由官方流程负责关闭，这里只收菜单（实测：Esc 无效，用 caret toggle）
      if (!getVisibleDialog()) await closeMenuIfOpen(caret);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 10. 推文元信息 / 指纹
   * ══════════════════════════════════════════════════════════════════════ */

  const RESERVED_PATHS = new Set([
    'home', 'explore', 'notifications', 'messages', 'settings', 'search', 'compose',
    'i', 'intent', 'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'hashtag', 'search-home',
  ]);

  /** 取推文作者 handle（不带 @） */
  function getHandle(article) {
    const box = q1(article, 'userName') || article;
    const links = box.querySelectorAll('a[href]');
    for (const a of links) {
      const raw = a.getAttribute('href') || '';
      let path = raw;
      try {
        path = new URL(raw, location.href).pathname;
      } catch (_) {
        /* 相对路径直接用 */
      }
      const seg = path.split(/[/?#]/).filter(Boolean)[0] || '';
      if (!seg || RESERVED_PATHS.has(seg.toLowerCase())) continue;
      if (/^[A-Za-z0-9_]{1,15}$/.test(seg)) return seg;
    }
    return '';
  }

  /** 推文指纹：用于识别 X 时间线的 DOM 节点复用 */
  function tweetKey(article) {
    let id = '';
    try {
      const time = article.querySelector('time');
      const link = time && time.closest('a');
      if (link) id = link.getAttribute('href') || link.href || '';
    } catch (_) {
      /* ignore */
    }
    let name = '';
    try {
      const box = q1(article, 'userName');
      if (box) name = (box.textContent || '').slice(0, 64);
    } catch (_) {
      /* ignore */
    }
    return (id + '|' + name).slice(0, 200);
  }

  function findCaret(article) {
    const caret = q1(article, 'caret');
    if (!caret) return null;
    // 引用推文内部可能也有结构，必须确认 caret 属于当前 article
    if (caret.closest(SEL.tweet.join(',')) !== article) return null;
    return caret;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 11. 按钮注入
   * ══════════════════════════════════════════════════════════════════════ */

  /** article → 注入状态。WeakMap 保证推文被回收后不泄漏内存 */
  let stateMap = new WeakMap();

  function stateFor(article) {
    let s = stateMap.get(article);
    if (!s) {
      s = { btn: null, caret: null, key: '', lastCheck: 0, done: false, blocked: false };
      stateMap.set(article, s);
    }
    return s;
  }

  /** 气泡里的预览节点：优先用克隆的官方菜单行，否则退化为同风格文本行 */
  function buildPreview(handle) {
    if (CONFIG.clonePreviewRow && Visual.previewRow) {
      try {
        return cloneWithStyles(Visual.previewRow);
      } catch (e) {
        log('克隆预览行失败，退化', e);
      }
    }
    const row = document.createElement('div');
    row.className = 'fallback';
    row.innerHTML = iconHTML();
    const txt = document.createElement('span');
    txt.textContent = '屏蔽' + (handle ? ' @' + handle : '');
    row.appendChild(txt);
    return row;
  }

  function setBusy(btn, busy) {
    if (!btn || !btn.isConnected) return;
    if (busy) {
      btn.dataset.busy = '1';
      btn.setAttribute('aria-busy', 'true');
    } else {
      delete btn.dataset.busy;
      btn.removeAttribute('aria-busy');
    }
  }

  /** 按钮主流程 */
  async function handleButtonClick(article, btn, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const s = stateFor(article);
    if (s.blocked || s.done) return;
    if (btn.dataset.busy === '1') return;

    const handle = btn.dataset.handle || getHandle(article);

    /* ---- 二次确认 ---- */
    if (CONFIG.confirmMode === 'popover') {
      if (Popover.isOpen()) Popover.close(false);
      const ok = await Popover.open({
        anchor: btn,
        title: '屏蔽' + (handle ? ' @' + handle : '该账号') + '？',
        handle,
        preview: buildPreview(handle),
      });
      if (!ok) return;
    }

    // 气泡停留期间用户可能已滚动/推文已被回收
    if (!article.isConnected) return;
    setBusy(btn, true);
    Popover.close(false);

    try {
      const res = await withMenuLock(() => nativeBlockFlow(article));
      if (res.mode === 'manual') {
        // 交给用户点官方弹窗：保留按钮，不标记完成，用户还能取消
        Toast.show(
          res.reason === 'unrecognized' ? XQBError.text('DIALOG_NOT_RECOGNIZED') : '请在官方弹窗中点「屏蔽」',
          'info'
        );
        setBusy(btn, false);
        return;
      }
      if (res.verified === false) {
        // 无法确证成功时绝不谎报
        Toast.show('已提交屏蔽请求，请确认结果', 'info');
      } else {
        Toast.show('已屏蔽' + (handle ? ' @' + handle : ''), 'ok');
      }
      markBlocked(article, btn);
    } catch (err) {
      const code = err && err.code;
      if (code === 'ALREADY_BLOCKED') {
        Toast.show(XQBError.text(code), 'info');
        markBlocked(article, btn);
      } else if (code === 'ABORTED') {
        Toast.show('已取消', 'info');
        setBusy(btn, false);
      } else {
        warn('屏蔽失败', err);
        Toast.show((err && err.message) || '屏蔽失败', 'err');
        setBusy(btn, false);
      }
    }
  }

  function markBlocked(article, btn) {
    const s = stateFor(article);
    s.done = true;
    s.blocked = true;
    // 存指纹而非 '1'：节点被复用时能识别出来并重置（见 enqueue）
    article.setAttribute('data-xqb-done', tweetKey(article));
    if (btn && btn.isConnected) {
      setBusy(btn, false);
      btn.dataset.state = 'blocked';
      btn.setAttribute('aria-disabled', 'true');
      btn.title = '已屏蔽';
      // 官方流程通常会把该推文替换成占位块，这里稍等后自行移除，避免视觉残留
      setTimeout(() => {
        if (btn.isConnected) btn.remove();
      }, 1200);
    }
  }

  /** 创建按钮 */
  function createBlockButton(article, caret, key) {
    const handle = getHandle(article);
    const btn = document.createElement('div');
    btn.className = 'xqb-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.dataset.handle = handle;
    btn.title = '屏蔽' + (handle ? ' @' + handle : '');

    /* 关键：高度对齐 caret 实测值（真实 X 为 20px）。
       若硬编码 34px，实测会把 caret 由 19×20 拉伸为 19×34，破坏其原生 hover 圆圈。 */
    let h = 20;
    if (CONFIG.matchCaretHeight) {
      const measured = Math.round(caret.getBoundingClientRect().height);
      if (measured >= 14 && measured <= 48) h = measured;
    }
    btn.style.setProperty('--xqb-h', h + 'px');

    // 外观模式：'pill' 红胶囊（醒目）/ 'icon' 仅图标（最原生）
    btn.dataset.style = CONFIG.buttonStyle === 'icon' ? 'icon' : 'pill';

    const slot = document.createElement('span');
    slot.className = 'xqb-ic-slot';
    slot.innerHTML = iconHTML();
    slot.dataset.icon = Visual.iconSvg ? 'native' : 'fallback';
    btn.appendChild(slot);

    if (btn.dataset.style === 'pill') {
      const tx = document.createElement('span');
      tx.className = 'xqb-tx';
      tx.textContent = '屏蔽';
      btn.appendChild(tx);
    }

    // 阻断冒泡：否则点击会打开推文详情页 / 触发卡片拖拽
    const swallow = (e) => {
      e.stopPropagation();
    };
    btn.addEventListener('pointerdown', swallow);
    btn.addEventListener('mousedown', swallow);
    btn.addEventListener('touchstart', swallow, { passive: true });

    /*
     * 事件绑定：所有确认模式共用同一套监听，**在事件发生时**才读 CONFIG.confirmMode。
     * 这一点很关键：用户可以在运行中通过油猴菜单 / Alt+Shift+K 切换确认方式，
     * 若按创建时的模式绑定监听器，已注入的按钮就会保留旧行为 ——
     * 例如切到「长按」后短按会被旧的 click 监听直接屏蔽掉，长按保护形同虚设。
     */
    let pressTimer = null;
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      delete btn.dataset.pressing;
    };

    // 长按判定（仅长按模式下启动计时器）
    btn.addEventListener('pointerdown', () => {
      cancelPress();
      if (CONFIG.confirmMode !== 'longpress') return;
      btn.dataset.pressing = '1';
      pressTimer = setTimeout(() => {
        pressTimer = null;
        delete btn.dataset.pressing;
        btn.dataset.longFired = '1'; // 标记：紧随其后的 click 是被长按消费掉的
        handleButtonClick(article, btn, null);
      }, CONFIG.longPressMs);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) =>
      btn.addEventListener(t, cancelPress, { passive: true })
    );

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // ① 长按已触发 → 消费掉这次 click
      if (btn.dataset.longFired === '1') {
        delete btn.dataset.longFired;
        return;
      }
      // ② 长按模式下的短按：只提示，不执行
      if (CONFIG.confirmMode === 'longpress') {
        Toast.show(
          '长按 ' + CONFIG.longPressMs / 1000 + 's 屏蔽' + (handle ? ' @' + handle : ''),
          'info'
        );
        return;
      }
      // ③ 气泡确认 / 直接屏蔽
      handleButtonClick(article, btn, e);
    });

    // 键盘用户没有长按 → Enter/Space 直接走流程（气泡确认仍会拦一道）
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      handleButtonClick(article, btn, null);
    });

    log('注入按钮', handle, key.slice(0, 60));
    return btn;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 12. 扫描层
   * ══════════════════════════════════════════════════════════════════════ */

  const pending = new Set();
  let scheduled = false;

  function enqueue(article) {
    if (!article || !article.isConnected) return;

    // 已屏蔽的推文默认跳过；但 X 会把同一 DOM 节点复用到别的推文上，
    // 此时 data-xqb-done 里存的指纹会与新内容不符 → 撤销标记并重新处理。
    const done = article.getAttribute('data-xqb-done');
    if (done) {
      if (done === tweetKey(article)) return;
      article.removeAttribute('data-xqb-done');
      const s = stateFor(article);
      s.done = false;
      s.blocked = false;
      log('已屏蔽的节点被复用为新推文，重置状态');
    }

    pending.add(article);
    schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  }

  function flush() {
    scheduled = false;
    const list = Array.from(pending);
    pending.clear();
    const budget = Math.max(1, CONFIG.maxPerFrame);
    for (let i = 0; i < list.length; i++) {
      if (i < budget) process(list[i]);
      else pending.add(list[i]);
    }
    if (pending.size) schedule();
  }

  /** 处理单条推文：注入 / 复用校验 */
  function process(article) {
    if (!article || !article.isConnected) return;
    if (article.hasAttribute('data-xqb-done')) return;

    const s = stateFor(article);
    const now = performance.now();
    const liveBtn = s.btn && s.btn.isConnected ? s.btn : null;
    const caretNow = findCaret(article);

    if (liveBtn) {
      // 校验 1（O(1)）：caret 节点身份变了 → 节点被复用
      if (caretNow && caretNow === s.caret) {
        if (now - s.lastCheck < CONFIG.verifyThrottleMs) return;
        s.lastCheck = now;
        // 校验 2（有节流）：指纹变了 → 同一节点被换成了别的推文
        if (tweetKey(article) === s.key) {
          syncButtonMeta(liveBtn, article);
          return;
        }
      }
      log('检测到节点复用/重渲染，重建按钮');
      liveBtn.remove();
      s.btn = null;
      s.caret = null;
      s.key = '';
    }

    s.lastCheck = now;

    const caret = caretNow || findCaret(article);
    if (!caret) return; // 引用推文 / 广告 / 无更多按钮：不注入

    const parent = caret.parentElement;
    if (!parent || parent.closest(SEL.tweet.join(',')) !== article) return;

    const key = tweetKey(article);
    const btn = createBlockButton(article, caret, key);
    if (CONFIG.buttonPosition === 'before') parent.insertBefore(btn, caret);
    else caret.insertAdjacentElement('afterend', btn);

    s.btn = btn;
    s.caret = caret;
    s.key = key;
    article.setAttribute('data-xqb', '1');
  }

  /** 按钮文案随推文复用一起更新 */
  function syncButtonMeta(btn, article) {
    const handle = btn.dataset.handle || '';
    const now = getHandle(article);
    if (handle === now) return;
    btn.dataset.handle = now;
    btn.title = '屏蔽' + (now ? ' @' + now : '');
  }

  /* ---- MutationObserver ---- */
  const observer = new MutationObserver((records) => {
    const cap = CONFIG.maxRecordsPerTick;
    const n = Math.min(records.length, cap);
    for (let i = 0; i < n; i++) {
      const m = records[i];
      if (m.type !== 'childList') continue;
      const target = m.target;

      // 新插入的子树里可能整块带着推文
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(SEL.tweet.join(','))) {
          enqueue(node);
        } else if (node.querySelectorAll) {
          const arts = node.querySelectorAll(SEL.tweet.join(','));
          for (const a of arts) enqueue(a);
        }
      }

      // late-render：caret/操作栏稍后才出现，重新检查变更所在的推文
      if (target.nodeType === 1 || target.nodeType === 3) {
        const el = target.nodeType === 1 ? target : target.parentElement;
        const host = el && el.closest ? el.closest(SEL.tweet.join(',')) : null;
        if (host) enqueue(host);
      }
    }
  });

  function startObserver() {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---- 全量 & 兜底扫描 ---- */
  function scanAll() {
    const list = document.querySelectorAll(SEL.tweet.join(','));
    for (const a of list) enqueue(a);
    if (list.length) schedule();
    return list.length;
  }

  function safetyScan() {
    // SPA 路由兜底：隔离世界里 patch history 无效，所以用 URL 轮询（纯字符串比较，成本可忽略）
    if (location.href !== lastHref) {
      lastHref = location.href;
      onRouteChange();
    }
    // :not 过滤掉已屏蔽的推文，保持查询廉价
    const list = document.querySelectorAll(SEL.tweet.join(',') + ':not([data-xqb-done])');
    for (const a of list) {
      const s = stateMap.get(a);
      const live = s && s.btn && s.btn.isConnected;
      if (!live) {
        enqueue(a);
      } else if (performance.now() - s.lastCheck > CONFIG.verifyThrottleMs) {
        enqueue(a);
      }
    }
    if (list.length) schedule();
    syncTheme();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 13. SPA 路由 & 主题 & 快捷键
   * ══════════════════════════════════════════════════════════════════════ */

  function patchHistory() {
    try {
      for (const fn of ['pushState', 'replaceState']) {
        const orig = history[fn];
        if (!orig || orig.__xqbWrapped) continue;
        const wrapped = function (...args) {
          const r = orig.apply(this, args);
          onRouteChange();
          return r;
        };
        wrapped.__xqbWrapped = true;
        history[fn] = wrapped;
      }
    } catch (e) {
      log('history 挂钩失败（不影响功能）', e);
    }
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
  }

  let routeTimer = null;
  let lastHref = location.href;
  function onRouteChange() {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      routeTimer = null;
      Popover.close(false);
      log('路由变化，重新扫描');
      scanAll();
      syncTheme();
    }, 120);
  }

  function watchTheme() {
    try {
      const mo = new MutationObserver(() => syncTheme());
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      mo.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    } catch (e) {
      log('主题观察失败', e);
    }
    try {
      const mm = window.matchMedia('(prefers-color-scheme: dark)');
      if (mm.addEventListener) mm.addEventListener('change', syncTheme);
      else if (mm.addListener) mm.addListener(syncTheme);
    } catch (_) {
      /* ignore */
    }
  }

  let hoveredArticle = null;

  function bindHoverTrack() {
    document.addEventListener(
      'mouseover',
      (e) => {
        const el = e.target;
        if (!el || !el.closest) return;
        hoveredArticle = el.closest(SEL.tweet.join(','));
      },
      { passive: true, capture: true }
    );
  }

  /**
   * Alt+Shift+K 循环切换确认方式。
   * 不依赖油猴菜单权限，因此在任何环境下都能用（菜单不可用时这就是那个「开关」）。
   */
  function bindModeHotkey() {
    if (!CONFIG.modeHotkey) return;
    const want = CONFIG.modeHotkey.toLowerCase().split('+').map((s) => s.trim());
    document.addEventListener(
      'keydown',
      (e) => {
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const parts = [];
        if (e.altKey) parts.push('alt');
        if (e.shiftKey) parts.push('shift');
        if (e.ctrlKey) parts.push('ctrl');
        if (e.metaKey) parts.push('meta');
        parts.push((e.key || '').toLowerCase());
        if (parts.join('+') !== want.join('+')) return;
        e.preventDefault();
        e.stopPropagation();
        cycleMode();
      },
      true
    );
  }

  function bindHotkey() {
    if (!CONFIG.hotkey) return;
    const want = CONFIG.hotkey.toLowerCase().split('+').map((s) => s.trim());
    document.addEventListener(
      'keydown',
      (e) => {
        const parts = [];
        if (e.altKey) parts.push('alt');
        if (e.shiftKey) parts.push('shift');
        if (e.ctrlKey) parts.push('ctrl');
        if (e.metaKey) parts.push('meta');
        parts.push((e.key || '').toLowerCase());
        if (parts.join('+') !== want.join('+')) return;
        // 输入框里不劫持
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const art = hoveredArticle && hoveredArticle.isConnected ? hoveredArticle : null;
        if (!art) return;
        const btn = art.querySelector('.xqb-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        btn.click();
      },
      true
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 14. 调试 API（兼容性修复全靠它）
   * ══════════════════════════════════════════════════════════════════════ */

  const api = {
    version: VERSION,
    config: CONFIG,
    sel: SEL,
    toast: (m, t) => Toast.show(m, t),
    rescan: () => scanAll(),

    /** 手动屏蔽指定推文节点（或页面第一条） */
    blockTweet(articleEl) {
      const art = articleEl || document.querySelector(SEL.tweet.join(','));
      if (!art) return Promise.reject(new Error('未找到推文节点'));
      const btn = art.querySelector('.xqb-btn');
      if (btn) {
        btn.click();
        return Promise.resolve('已触发按钮点击');
      }
      return withMenuLock(() => nativeBlockFlow(art)).then((r) => {
        Toast.show('已屏蔽', 'ok');
        return r;
      });
    },

    /**
     * 打开某条推文的原生菜单并把菜单项结构打印出来 —— 选择器失效时的首选排查手段。
     * @returns {Promise<Array<{testid:string, role:string, text:string}>>}
     */
    async inspectMenu(articleEl) {
      const art = articleEl || hoveredArticle || document.querySelector(SEL.tweet.join(','));
      if (!art) return [];
      return withMenuLock(async () => {
        const caret = findCaret(art);
        if (!caret) {
          warn('该推文没有 caret');
          return [];
        }
        const menu = await openCaretMenu(caret);
        if (!menu) {
          warn('菜单未打开');
          return [];
        }
        const items = collectMenuItems(menu).map((el) => ({
          testid: el.getAttribute('data-testid') || (el.querySelector('[data-testid]') || {}).getAttribute?.('data-testid') || '',
          role: el.getAttribute('role') || '',
          text: normText(el).slice(0, 60),
        }));
        console.table(items);
        console.log(LOG_PREFIX + ' 菜单原始 HTML：\n', menu.outerHTML.slice(0, 6000));
        const hit = findMenuAction(menu);
        console.log(LOG_PREFIX + ' 命中结果：', hit ? { kind: hit.kind, via: hit.via, text: normText(hit.el) } : '未命中');
        await closeMenuIfOpen(caret);
        return items;
      });
    },

    /** 一次性打印当前环境体检结果 */
    diagnose() {
      const arts = document.querySelectorAll(SEL.tweet.join(','));
      const withCaret = Array.from(arts).filter((a) => findCaret(a)).length;
      const withBtn = document.querySelectorAll('.xqb-btn').length;
      const info = {
        version: VERSION,
        theme: detectTheme(),
        tweetNodes: arts.length,
        injectable: withCaret,
        injectedButtons: withBtn,
        popoverOpen: Popover.isOpen(),
        menuOpen: getVisibleMenuRoots().length,
        busy: isBusy(),
        hasNativeIcon: !!Visual.iconSvg,
        hasNativePreview: !!Visual.previewRow,
        confirmMode: CONFIG.confirmMode,
        autoConfirmNative: CONFIG.autoConfirmNative,
      };
      console.table(info);
      return info;
    },

    /**
     * 逐条推文自检 —— 验收评论区/时间线是否每条都注入了按钮。
     * 用法：在帖子详情页（评论区）控制台执行 __XQB__.selftest()
     * 期望：problems === 0，且 injected === withCaret
     * @returns {{tweets:number, withCaret:number, injected:number, markedDone:number, problems:number}}
     */
    selftest() {
      const arts = Array.from(document.querySelectorAll(SEL.tweet.join(',')));
      const rows = arts.map((a, i) => {
        const caret = findCaret(a);
        const btn = a.querySelector('.xqb-btn');
        const own = btn && btn.closest(SEL.tweet.join(',')) === a ? btn : null;
        const s = stateMap.get(a);
        return {
          i,
          handle: getHandle(a),
          hasCaret: !!caret,
          injected: !!own,
          title: own ? own.title : null,
          height: own ? own.style.getPropertyValue('--xqb-h') : null,
          adjacent: !!(own && caret && (own.previousElementSibling === caret || own.nextElementSibling === caret)),
          done: a.hasAttribute('data-xqb-done'),
          key: s ? s.key.slice(-24) : '',
        };
      });
      const missing = rows.filter((r) => r.hasCaret && !r.injected && !r.done);
      const summary = {
        tweets: rows.length,
        withCaret: rows.filter((r) => r.hasCaret).length,
        injected: rows.filter((r) => r.injected).length,
        markedDone: rows.filter((r) => r.done).length,
        problems: missing.length,
      };
      console.table(summary);
      if (missing.length) {
        const detail = missing.map((r) => ({ i: r.i, handle: r.handle, hasCaret: r.hasCaret }));
        console.warn(LOG_PREFIX + ' 以下推文未注入按钮：', detail);
      } else {
        console.log(LOG_PREFIX + ' 自检通过：所有带「更多」按钮的推文都已注入【屏蔽】✅');
      }
      return summary;
    },

    /** 清掉所有注入痕迹，便于对比排查 */
    reset() {
      document.querySelectorAll('.xqb-btn').forEach((b) => b.remove());
      document.querySelectorAll('[data-xqb],[data-xqb-done]').forEach((a) => {
        a.removeAttribute('data-xqb');
        a.removeAttribute('data-xqb-done');
      });
      stateMap = new WeakMap(); // WeakMap 无 clear()，直接换实例
      pending.clear();
      Toast.show('已重置注入状态', 'info');
    },

    /** 当前设置一览（等价于油猴菜单里的「查看当前设置」） */
    status() {
      const info = {
        version: VERSION,
        confirmMode: CONFIG.confirmMode,
        confirmModeText: MODE_TEXT[CONFIG.confirmMode],
        autoConfirmNative: CONFIG.autoConfirmNative,
        hotkey: CONFIG.hotkey,
        modeHotkey: CONFIG.modeHotkey,
        tampermonkeyMenu: typeof GM_registerMenuCommand === 'function',
        gmStorage: typeof GM_setValue === 'function',
      };
      console.table(info);
      Toast.show(
        '确认方式：' + MODE_TEXT[CONFIG.confirmMode] +
          (CONFIG.autoConfirmNative ? ' · 官方弹窗自动点掉' : ' · 官方弹窗手动'),
        'info'
      );
      return info;
    },

    /** 切换确认方式：'popover' 气泡 | 'none' 直接屏蔽 | 'longpress' 长按 */
    setMode,
    /** 循环切换确认方式（等同 Alt+Shift+K） */
    cycleMode,
    /** true = 自动点掉官方确认弹窗；false = 留给用户手动点 */
    setAutoConfirmNative,
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 15. 启动
   * ══════════════════════════════════════════════════════════════════════ */

  function warmUpCapture() {
    if (!CONFIG.warmUpCapture) return;
    const run = () => {
      if (Visual.captured) return;
      const art = Array.from(document.querySelectorAll(SEL.tweet.join(','))).find((a) => findCaret(a));
      if (!art) return;
      withMenuLock(async () => {
        const caret = findCaret(art);
        if (!caret) return;
        try {
          const menu = await openCaretMenu(caret);
          if (!menu) return;
          const hit = findMenuAction(menu);
          if (hit && hit.kind === 'block') captureNativeVisual(hit.el);
          await closeMenuIfOpen(caret);
        } catch (e) {
          log('预热抓取失败', e);
          await closeMenuIfOpen(caret);
        }
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      setTimeout(() => window.requestIdleCallback(run, { timeout: 2000 }), 3000);
    } else {
      setTimeout(run, 3000);
    }
  }

  /**
   * 重复安装自愈。
   *
   * 背景：篡改猴按「@name + @namespace」识别脚本。如果脚本的 namespace 变过
   * （本项目 v1.3.1 把 namespace 从 github.com/local/... 改成了仓库地址），
   * 篡改猴会把它当成**另一个脚本**装进去，于是页面上同时跑两份实例：
   * 每条推文出现两个按钮、两个浮层宿主，而先加载的旧实例抢先建了 <style>，
   * 新实例看到已存在就跳过 → 旧样式（常驻红色）反而生效。
   *
   * 处理：以版本号仲裁，新版本接管并清掉旧实例的 DOM 产物；
   * 版本相同或更旧的一方直接让位（返回 false 表示不要初始化）。
   * 注意：这只能让页面恢复正常，无法卸载篡改猴里的旧条目 —— 那一步需要用户在面板里删。
   *
   * @returns {boolean} 本实例是否应当继续初始化
   */
  function claimSingleton() {
    const KEY = '__XQB_INSTANCE__';
    let pageWin = window;
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) pageWin = unsafeWindow;
    } catch (_) {
      /* 取不到就用当前 window */
    }
    let prev = null;
    try {
      prev = pageWin[KEY] || null;
    } catch (_) {
      /* 页面 window 不可读则跳过仲裁，按单实例处理 */
    }

    const cmp = (a, b) => {
      const pa = String(a).split('.').map(Number);
      const pb = String(b).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
      }
      return 0;
    };

    if (prev && prev.version && cmp(prev.version, VERSION) >= 0) {
      // 已有同版本或更新的实例在跑 → 让位，避免重复注入
      warn('检测到另一个实例（v' + prev.version + '），本实例让位以免重复注入');
      return false;
    }

    if (prev) {
      // 本实例更新 → 接管，并清掉旧实例留下的 DOM 产物
      warn('检测到旧实例（v' + prev.version + '），本实例 v' + VERSION + ' 接管并清理其残留');
      try {
        document.querySelectorAll('.xqb-btn').forEach((b) => b.remove());
        document.querySelectorAll('#xqb-ui-host, #xqb-style').forEach((n) => n.remove());
        document.querySelectorAll('[data-xqb],[data-xqb-done]').forEach((a) => {
          a.removeAttribute('data-xqb');
          a.removeAttribute('data-xqb-done');
        });
        pending.clear();
        stateMap = new WeakMap();
      } catch (e) {
        warn('清理旧实例残留失败（不影响继续初始化）', e);
      }
    } else if (document.querySelector('#xqb-ui-host')) {
      // 没有登记锁却已存在浮层宿主 → 说明页面上还跑着一个**没有本保护机制**的旧版本
      // （典型成因：改了 @namespace，篡改猴把它当成另一个脚本重复安装）。
      // 这里只能清掉它的样式表让本实例的样式生效；它自己的 MutationObserver 仍会继续
      // 注入按钮，所以「每条推文两个按钮」必须靠用户在篡改猴面板删掉旧条目才能根治。
      warn(
        '检测到未登记锁的旧实例（很可能是篡改猴里重复安装的旧条目）。' +
          '请打开篡改猴面板删除重复的「X 快捷屏蔽」，只保留 v' + VERSION + ' 这一条。'
      );
      try {
        document.querySelectorAll('#xqb-style, #xqb-ui-host').forEach((n) => n.remove());
      } catch (_) {
        /* ignore */
      }
    }

    try {
      pageWin[KEY] = { version: VERSION, ts: Date.now() };
    } catch (_) {
      /* 写不进去也无妨 */
    }
    return true;
  }

  function init() {
    if (!claimSingleton()) return; // 已有实例在跑，直接让位
    applyStoredSettings(); // 先载入用户上次选择的「确认方式」
    injectLightStyle();
    ensureUiHost();
    startObserver();
    patchHistory();
    bindHoverTrack();
    bindHotkey();
    bindModeHotkey();
    watchTheme();
    syncTheme();
    scanAll();
    setInterval(safetyScan, CONFIG.safetyScanMs);
    warmUpCapture();
    registerMenu(); // 油猴菜单开关（无 GM 权限时自动跳过）

    // 暴露调试 API。
    // 注意：声明了 @grant 之后脚本运行在隔离世界，window 不再等于页面 window，
    // 因此优先挂到 unsafeWindow（TM 提供的页面 window），否则退回当前 window。
    let pageWin = window;
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) pageWin = unsafeWindow;
    } catch (_) {
      /* MV3 下可能取不到，退回隔离世界的 window */
    }
    try {
      Object.defineProperty(pageWin, '__XQB__', {
        value: api,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch (_) {
      try {
        pageWin.__XQB__ = api;
      } catch (e2) {
        warn('无法挂载 __XQB__（页面 window 不可写）', e2);
      }
    }
    if (pageWin !== window) {
      try {
        window.__XQB__ = api; // 隔离世界也留一份，便于 DevTools 切换上下文
      } catch (_) {
        /* ignore */
      }
    }

    log(
      '已启动 v' + VERSION,
      '\n控制台可用：__XQB__.status() / __XQB__.setMode("none") / __XQB__.selftest() / __XQB__.inspectMenu() / __XQB__.reset()',
      '\n快捷键：' + CONFIG.modeHotkey + ' 切换确认方式 · ' + CONFIG.hotkey + ' 屏蔽悬停推文'
    );
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
