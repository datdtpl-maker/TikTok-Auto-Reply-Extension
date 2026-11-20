// content/dom-utils.js - Cross-Iframe Safe DOM Helpers, React/Draft.js Input Filler & Floating Status Pill

window.TTAR = window.TTAR || {};

(function (ns) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function humanDelay(minMs = 900, maxMs = 2000) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return sleep(ms);
  }

  function normalizeText(str) {
    return String(str || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hashString(input) {
    let hash = 2166136261;
    const str = normalizeText(input).toLowerCase();
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getWin(el) {
    return el?.ownerDocument?.defaultView || window;
  }

  function getDoc(el) {
    return el?.ownerDocument || document;
  }

  // Cross-iframe safe visibility check (NEVER use `el instanceof Element` across iframe boundaries!)
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const win = getWin(el);
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return false;
    }
  }

  async function waitFor(fn, timeoutMs = 6000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function getAllAccessibleRoots(root = document, visited = new Set()) {
    if (!root || visited.has(root)) return [];
    visited.add(root);
    const roots = [root];

    try {
      const iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
      for (const frame of iframes) {
        try {
          if (frame.contentDocument) {
            roots.push(...getAllAccessibleRoots(frame.contentDocument, visited));
          }
        } catch (_) {}
      }
    } catch (_) {}

    try {
      const allEls = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of allEls) {
        if (el.shadowRoot) {
          roots.push(...getAllAccessibleRoots(el.shadowRoot, visited));
        }
      }
    } catch (_) {}

    return roots;
  }

  function queryAllDeep(selector, root = document) {
    const roots = getAllAccessibleRoots(root);
    const results = [];
    const seen = new Set();
    for (const r of roots) {
      try {
        const list = r.querySelectorAll(selector);
        for (const el of list) {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }
      } catch (_) {}
    }
    return results;
  }

  function findClickableByText(patterns, root = document, selector = 'button, a, [role="tab"], [role="button"], li, div, span') {
    const regexList = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(`^${p}$`, 'i')));
    const nodes = Array.from(root.querySelectorAll(selector));

    let best = null;
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (el.children.length > 6) continue;
      const text = normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      if (!text || text.length > 60) continue;

      if (regexList.some((re) => re.test(text))) {
        best = el;
        if (el.matches('button, a, [role="tab"], [role="button"]')) {
          return el;
        }
      }
    }
    return best;
  }

  function humanClick(el) {
    if (!el || el.nodeType !== 1) return false;
    const win = getWin(el);
    try {
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch (_) {}
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: win, clientX, clientY };
    try {
      el.dispatchEvent(new win.MouseEvent('pointerdown', opts));
      el.dispatchEvent(new win.MouseEvent('mousedown', opts));
      el.dispatchEvent(new win.MouseEvent('pointerup', opts));
      el.dispatchEvent(new win.MouseEvent('mouseup', opts));
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
    return true;
  }

  function isTikTokAccentColor(colorStr) {
    const m = String(colorStr || '').match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return false;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    return r >= 200 && g <= 130 && b <= 150;
  }

  function findEditableInput(root = document, placeholderPatterns = [], preferNearEl = null) {
    const candidates = Array.from(
      root.querySelectorAll(
        'div[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea, input[type="text"]'
      )
    ).filter((el) => {
      if (!isVisible(el)) return false;
      if (el.closest && el.closest('#ttar-status-pill')) return false;
      const aria = normalizeText(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
      if (/tìm kiếm|search|email|điện thoại|danh xưng|ghi chú/i.test(aria)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // Nếu vừa bấm nút "Trả lời" của 1 bình luận, ưu tiên ô nhập inline nằm ngay gần nút đó
    if (preferNearEl && isVisible(preferNearEl)) {
      const nearRect = preferNearEl.getBoundingClientRect();
      const nearby = candidates
        .map((el) => ({
          el,
          dist: Math.abs(el.getBoundingClientRect().top - nearRect.bottom)
        }))
        .filter((x) => x.dist <= 260)
        .sort((a, b) => a.dist - b.dist);
      if (nearby.length > 0) {
        return nearby[0].el;
      }
    }

    if (placeholderPatterns.length > 0) {
      for (const el of candidates) {
        const containerText = normalizeText(
          (el.getAttribute('placeholder') || '') +
            ' ' +
            (el.getAttribute('aria-label') || '') +
            ' ' +
            (el.getAttribute('data-placeholder') || '') +
            ' ' +
            (el.parentElement?.innerText || '')
        );
        if (placeholderPatterns.some((re) => re.test(containerText))) {
          return el;
        }
      }
    }

    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return candidates[0];
  }

  // Cross-iframe safe React/Draft.js/Lexical input filler
  async function fillEditableInput(inputEl, text) {
    if (!inputEl || !text) return false;
    const doc = getDoc(inputEl);
    const win = getWin(inputEl);

    inputEl.focus();
    await sleep(200);

    const tag = inputEl.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(inputEl, text);
      } else {
        inputEl.value = text;
      }
      inputEl.dispatchEvent(new win.Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new win.Event('change', { bubbles: true }));
      await sleep(180);
      return normalizeText(inputEl.value).includes(normalizeText(text).slice(0, 10));
    }

    // Contenteditable inside main doc OR iframe (Draft.js / Lexical / Slate used by TikTok)
    try {
      win.focus();
      inputEl.click();
      inputEl.focus();
      await sleep(150);

      const sel = win.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(inputEl);
      sel.removeAllRanges();
      sel.addRange(range);

      // Method 1 (Best for TikTok Draft.js / Lexical): Synthetic Paste event with DataTransfer
      // Updates React/Draft.js internal state cleanly so placeholder disappears & Send icon appears!
      const dt = new win.DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvent = new win.ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      inputEl.dispatchEvent(pasteEvent);
      await sleep(300);

      if (normalizeText(inputEl.innerText || inputEl.textContent).includes(normalizeText(text).slice(0, 10))) {
        return true;
      }

      // Method 2: beforeinput + execCommand('insertText')
      inputEl.dispatchEvent(
        new win.InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        })
      );
      doc.execCommand('insertText', false, text);
      inputEl.dispatchEvent(
        new win.InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        })
      );
      await sleep(250);

      if (normalizeText(inputEl.innerText || inputEl.textContent).includes(normalizeText(text).slice(0, 10))) {
        return true;
      }
    } catch (_) {}

    // Last fallback
    inputEl.textContent = text;
    inputEl.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    await sleep(180);
    return normalizeText(inputEl.innerText || inputEl.textContent).length > 0;
  }

  function findNearbySendButton(inputEl) {
    if (!inputEl) return null;
    const win = getWin(inputEl);
    const inRect = inputEl.getBoundingClientRect();

    let container = inputEl.parentElement;
    for (let depth = 0; depth < 8 && container && container !== container.ownerDocument.body; depth++) {
      const cRect = container.getBoundingClientRect();
      // Cho phép khung nhập liệu cao tới 380px khi tin nhắn dài nhiều dòng (vd 310/6000 ký tự)
      if (cRect.height > 380) break;

      const candidates = Array.from(
        container.querySelectorAll(
          'button, [role="button"], [data-e2e*="send" i], [data-e2e*="post" i], svg'
        )
      )
        .map((el) => {
          if (el.tagName.toLowerCase() === 'svg') {
            return el.closest('button, [role="button"]') || el.parentElement || el;
          }
          return el;
        })
        .filter((el, idx, arr) => {
          if (arr.indexOf(el) !== idx) return false;
          if (!isVisible(el)) return false;
          if (el.contains(inputEl)) return false;

          const r = el.getBoundingClientRect();
          if (r.width < 14 || r.width > 95 || r.height < 14 || r.height > 72) return false;

          const txt = normalizeText(el.innerText || el.getAttribute('aria-label') || '');
          const e2e = el.getAttribute('data-e2e') || '';
          if (/^(đăng|gửi|send|post)$/i.test(txt) || /send|post/i.test(e2e)) {
            return true;
          }

          // Nút máy bay giấy đỏ ✈️ / mũi tên hồng ⬆️ nằm bên phải ô nhập liệu và nằm trong khoảng chiều dọc của khung nhập (kể cả khi căn đáy nhiều dòng)
          const verticallyAligned = r.top <= inRect.bottom + 36 && r.bottom >= inRect.top - 24;
          const isToTheRight = r.left >= inRect.right - 24;
          const hasSvg = el.tagName.toLowerCase() === 'svg' || Boolean(el.querySelector('svg'));
          return verticallyAligned && isToTheRight && hasSvg;
        });

      if (candidates.length > 0) {
        const nonClose = candidates.filter((el) => {
          const label = normalizeText(
            (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '') + ' ' + (el.className || '')
          );
          return !/close|cancel|dismiss|đóng|hủy|^x$|^×$/i.test(label);
        });
        const pool = nonClose.length > 0 ? nonClose : candidates;

        // Ưu tiên nút "Đăng" / "Gửi" / data-e2e="message-send"
        const exactSend = pool.filter((el) => {
          const txt = normalizeText(el.innerText || el.getAttribute('aria-label') || '');
          const e2e = el.getAttribute('data-e2e') || '';
          return /^(đăng|gửi|send|post)$/i.test(txt) || /send|post/i.test(e2e);
        });
        if (exactSend.length > 0) return exactSend[0];

        // Ưu tiên nút có màu đỏ/hồng đặc trưng TikTok (#FE2C55) — kể cả màu trên thẻ <svg> hoặc <path>
        const accentBtns = pool.filter((el) => {
          const st = win.getComputedStyle(el);
          const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
          const path = svg?.querySelector('path');
          const svgSt = svg ? win.getComputedStyle(svg) : null;
          const pathSt = path ? win.getComputedStyle(path) : null;
          return (
            isTikTokAccentColor(st.backgroundColor) ||
            isTikTokAccentColor(st.color) ||
            isTikTokAccentColor(svgSt?.color) ||
            isTikTokAccentColor(svgSt?.fill) ||
            isTikTokAccentColor(pathSt?.fill)
          );
        });
        if (accentBtns.length > 0) {
          accentBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
          return accentBtns[0];
        }

        pool.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return pool[0];
      }

      container = container.parentElement;
    }
    return null;
  }

  function isInputCleared(inputEl) {
    if (!inputEl || !inputEl.isConnected) return true;
    const tag = inputEl.tagName.toLowerCase();
    const val = tag === 'textarea' || tag === 'input' ? inputEl.value : inputEl.innerText || inputEl.textContent;
    return normalizeText(val).length < 4;
  }

  async function submitInput(inputEl, explicitSendBtn = null) {
    const win = getWin(inputEl);
    await sleep(350);

    // Bước 1: Bấm nút gửi (máy bay giấy đỏ ✈️ / mũi tên hồng ⬆️ / nút Đăng)
    const sendBtn = explicitSendBtn || findNearbySendButton(inputEl);
    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
      humanClick(sendBtn);
      const innerSvg = sendBtn.querySelector?.('svg');
      if (innerSvg && innerSvg !== sendBtn) {
        humanClick(innerSvg);
      }
      await sleep(700);
      if (isInputCleared(inputEl)) return true;
    }

    // Bước 2 (Dự phòng): Nhấn phím Enter ngay trong ô nhập
    inputEl.focus();
    const enterOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    inputEl.dispatchEvent(new win.KeyboardEvent('keydown', enterOpts));
    inputEl.dispatchEvent(new win.KeyboardEvent('keypress', enterOpts));
    inputEl.dispatchEvent(new win.KeyboardEvent('keyup', enterOpts));
    await sleep(700);
    return isInputCleared(inputEl);
  }

  async function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, error: 'Empty response' });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  const StatusOverlay = {
    el: null,
    ensure() {
      if (this.el && document.body.contains(this.el)) return this.el;
      const pill = document.createElement('div');
      pill.id = 'ttar-status-pill';
      pill.style.cssText = [
        'position:fixed',
        'bottom:16px',
        'right:16px',
        'z-index:2147483640',
        'background:rgba(15,23,42,0.92)',
        'color:#f8fafc',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
        'font-size:12px',
        'line-height:1.4',
        'padding:8px 12px',
        'border-radius:10px',
        'border:1px solid rgba(148,163,184,0.35)',
        'box-shadow:0 8px 24px rgba(0,0,0,0.35)',
        'display:flex',
        'align-items:center',
        'gap:8px',
        'max-width:380px',
        'backdrop-filter:blur(8px)'
      ].join(';');
      pill.innerHTML =
        '<span id="ttar-dot" style="width:8px;height:8px;border-radius:50%;background:#64748b;flex-shrink:0;"></span>' +
        '<span id="ttar-text" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">TikTok AI: Đang tạm dừng</span>';
      document.body.appendChild(pill);
      this.el = pill;
      return pill;
    },
    update(status, text) {
      const pill = this.ensure();
      const dot = pill.querySelector('#ttar-dot');
      const label = pill.querySelector('#ttar-text');
      const colors = {
        idle: '#64748b',
        running: '#10b981',
        busy: '#38bdf8',
        error: '#ef4444'
      };
      if (dot) dot.style.background = colors[status] || colors.idle;
      if (label) label.textContent = text;
    }
  };

  ns.dom = {
    sleep,
    humanDelay,
    normalizeText,
    hashString,
    getWin,
    getDoc,
    isVisible,
    waitFor,
    getAllAccessibleRoots,
    queryAllDeep,
    findClickableByText,
    humanClick,
    findEditableInput,
    fillEditableInput,
    findNearbySendButton,
    submitInput,
    sendRuntimeMessage,
    StatusOverlay
  };
})(window.TTAR);
