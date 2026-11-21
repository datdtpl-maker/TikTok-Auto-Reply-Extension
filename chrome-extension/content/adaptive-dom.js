// content/adaptive-dom.js - Cơ chế tự thích ứng giao diện 4 tầng (Self-Healing Adaptive DOM Engine)
// Tự động chuyển đổi linh hoạt nếu TikTok đổi class, bỏ data-e2e, đổi URL iframe hoặc gộp ra main DOM.

window.TTAR = window.TTAR || {};

(function (ns) {
  const { normalizeText, isVisible, getWin } = ns.dom;

  const lastStrategyReport = {};

  function recordStrategy(key, strategy, count = 1) {
    lastStrategyReport[key] = { strategy, count, ts: new Date().toLocaleTimeString('vi-VN') };
  }

  function getAccessibleDocs() {
    const docs = [document];
    const seen = new Set([document]);

    const scanFrames = (rootDoc) => {
      try {
        const frames = rootDoc.querySelectorAll('iframe');
        for (const f of frames) {
          try {
            const rect = f.getBoundingClientRect();
            const d = f.contentDocument;
            if (d && !seen.has(d) && rect.width > 120 && rect.height > 120) {
              seen.add(d);
              docs.push(d);
              scanFrames(d);
            }
          } catch (_) {}
        }
      } catch (_) {}
    };

    scanFrames(document);
    return docs;
  }

  /**
   * Tự tìm Document chứa giao diện Tin nhắn (ưu tiên iframe /messages, tự thích ứng nếu TikTok đổi URL iframe hoặc bỏ iframe).
   */
  function resolveMessagesDoc() {
    // Tầng 1: iframe src chứa /messages hoặc /inbox
    const directIframe = Array.from(document.querySelectorAll('iframe')).find(
      (f) => /\/(messages|inbox|im)\b/i.test(f.src || '') && f.getBoundingClientRect().width > 120
    );
    try {
      if (directIframe?.contentDocument) {
        recordStrategy('messagesSurface', 'L1:iframe-src');
        return directIframe.contentDocument;
      }
    } catch (_) {}

    // Tầng 2: Quét tất cả document/iframe tìm semantic anchor của Tin nhắn
    const docs = getAccessibleDocs();
    for (const d of docs) {
      if (
        d.querySelector('[data-e2e="dm-new-conversation-list"], [data-e2e="dm-new-chatbox"], [data-e2e="chat-list-item"]')
      ) {
        recordStrategy('messagesSurface', d === document ? 'L2:main-doc-e2e' : 'L2:iframe-e2e');
        return d;
      }
    }

    // Tầng 3: Quét theo text/placeholder đặc trưng ("Gửi tin nhắn", "Chỉ chưa đọc", "Bộ lọc")
    for (const d of docs) {
      const txt = normalizeText(d.body?.innerText || '').slice(0, 4000);
      if (/chỉ chưa đọc|unread only|gửi tin nhắn|send a message/i.test(txt)) {
        recordStrategy('messagesSurface', d === document ? 'L3:main-doc-text' : 'L3:iframe-text');
        return d;
      }
    }

    recordStrategy('messagesSurface', 'none', 0);
    return null;
  }

  /**
   * Tự tìm Document chứa vùng Video + Bình luận (ưu tiên iframe /video/, tự thích ứng nếu TikTok gộp vào main DOM).
   */
  function resolveVideoDoc() {
    // Tầng 1: iframe src chứa /video/
    const directIframe = Array.from(document.querySelectorAll('iframe')).find(
      (f) => /\/video\//i.test(f.src || '') && f.getBoundingClientRect().width > 120
    );
    try {
      if (directIframe?.contentDocument) {
        recordStrategy('videoSurface', 'L1:iframe-src');
        return directIframe.contentDocument;
      }
    } catch (_) {}

    // Tầng 2: Quét tất cả document/iframe có [data-e2e="comment-reply-1"] hoặc [data-e2e="comment-input"]
    const docs = getAccessibleDocs();
    for (const d of docs) {
      if (d.querySelector('[data-e2e="comment-reply-1"], [data-e2e="comment-input"]')) {
        recordStrategy('videoSurface', d === document ? 'L2:main-doc-e2e' : 'L2:iframe-e2e');
        return d;
      }
    }

    // Tầng 3: Quét theo text đặc trưng ("Thêm bình luận", "X bình luận", "Trả lời")
    for (const d of docs) {
      const hasCommentInput = Array.from(d.querySelectorAll('[contenteditable="true"], textarea')).some((el) => {
        if (!isVisible(el)) return false;
        const hint = normalizeText(
          (el.getAttribute('placeholder') || '') +
            ' ' +
            (el.getAttribute('aria-label') || '') +
            ' ' +
            (el.parentElement?.innerText || '')
        );
        return /thêm bình luận|add comment|trả lời/i.test(hint);
      });
      if (hasCommentInput) {
        recordStrategy('videoSurface', d === document ? 'L3:main-doc-text' : 'L3:iframe-text');
        return d;
      }
    }

    recordStrategy('videoSurface', 'none', 0);
    return null;
  }

  /**
   * Thuật toán hình học (Tầng 4): Tìm danh sách dọc gồm các dòng lặp lại cùng chiều rộng trong 1 vùng root.
   * Không phụ thuộc class name hay data-e2e.
   */
  function findRepeatedVerticalRows(rootDoc, { maxLeftRatio = 0.55, minTop = 80, minH = 44, maxH = 165 } = {}) {
    const win = rootDoc.defaultView || window;
    const maxLeft = (win.innerWidth || 1280) * maxLeftRatio;
    let bestGroup = [];
    let bestScore = -1;

    const containers = Array.from(rootDoc.querySelectorAll('div, ul, section, aside'));
    for (const container of containers) {
      if (!isVisible(container)) continue;
      const cRect = container.getBoundingClientRect();
      if (cRect.left > maxLeft || cRect.width < 160 || cRect.width > 560 || cRect.height < 120) {
        continue;
      }

      const children = Array.from(container.children).filter((ch) => {
        if (!isVisible(ch)) return false;
        const r = ch.getBoundingClientRect();
        if (r.top < minTop || r.width < 150 || r.width > 540 || r.height < minH || r.height > maxH) {
          return false;
        }
        const txt = normalizeText(ch.innerText);
        return txt.length >= 3 && !/^Bộ lọc.*Chỉ chưa đọc$/i.test(txt);
      });

      if (children.length < 2) continue;

      const refW = children[0].getBoundingClientRect().width;
      const refL = children[0].getBoundingClientRect().left;
      const aligned = children.filter((ch) => {
        const r = ch.getBoundingClientRect();
        return Math.abs(r.width - refW) <= 28 && Math.abs(r.left - refL) <= 24;
      });
      if (aligned.length < 2) continue;

      const hasMedia = aligned.some((ch) => ch.querySelector('img, canvas, svg'));
      const score = aligned.length * 100 + (hasMedia ? 60 : 0) - Math.round(cRect.left / 20);
      if (score > bestScore) {
        bestScore = score;
        bestGroup = aligned;
      }
    }

    bestGroup.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return bestGroup;
  }

  function isMessageRequestsRow(el) {
    const txt = normalizeText(el?.innerText || '');
    return /^(message requests|yêu cầu tin nhắn)\b/i.test(txt) || /\b(you have \d+ requests?|bạn có \d+ yêu cầu)\b/i.test(txt);
  }

  /**
   * Tìm dòng mục "Message requests" / "Yêu cầu tin nhắn" trong danh sách Tin nhắn.
   */
  function findMessageRequestsEntry(msgDoc) {
    if (!msgDoc) return null;
    const listRoot = msgDoc.querySelector('[data-e2e="dm-new-conversation-list"]') || msgDoc;

    // Tìm thẻ text chứa đúng "Message requests" hoặc "Yêu cầu tin nhắn"
    const labelNode = Array.from(listRoot.querySelectorAll('p, span, div')).find((el) => {
      if (!isVisible(el) || el.children.length > 1) return false;
      return /^(message requests|yêu cầu tin nhắn)$/i.test(normalizeText(el.innerText));
    });
    if (!labelNode) return null;

    // Leo lên đúng thẻ dòng clickable của mục Message requests
    let cur = labelNode.parentElement;
    for (let d = 0; d < 7 && cur && cur !== listRoot; d++) {
      const r = cur.getBoundingClientRect();
      if (r.width >= 160 && r.width <= 540 && r.height >= 44 && r.height <= 135) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return labelNode.parentElement || labelNode;
  }

  /**
   * Tìm nút quay lại (<) ở tiêu đề "< Message requests" / "< Yêu cầu tin nhắn".
   */
  function findMessageRequestsBackButton(msgDoc) {
    if (!msgDoc) return null;
    const headerLabel = Array.from(msgDoc.querySelectorAll('h1, h2, h3, p, span, div')).find((el) => {
      if (!isVisible(el) || el.children.length > 2) return false;
      const r = el.getBoundingClientRect();
      return r.top < 160 && /^(message requests|yêu cầu tin nhắn)$/i.test(normalizeText(el.innerText));
    });
    if (!headerLabel) return null;

    let row = headerLabel.parentElement;
    for (let d = 0; d < 4 && row && row !== msgDoc.body; d++) {
      const btn = Array.from(row.querySelectorAll('button, [role="button"], svg')).find((el) => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left <= headerLabel.getBoundingClientRect().left + 10 && r.width <= 48 && r.height <= 48;
      });
      if (btn) return btn.closest('button, [role="button"]') || btn;
      row = row.parentElement;
    }
    return null;
  }

  /**
   * Tìm danh sách hội thoại Tin nhắn theo 4 tầng thích ứng (tự lọc bỏ dòng thư mục Message requests).
   */
  function findConversationRows(msgDoc, limit = 10, { includeRequestsFolder = false } = {}) {
    if (!msgDoc) return [];
    const listRoot = msgDoc.querySelector('[data-e2e="dm-new-conversation-list"]') || msgDoc;
    const filterRow = (el) => isVisible(el) && (includeRequestsFolder || !isMessageRequestsRow(el));

    // Tầng 1: data-e2e chuẩn
    let rows = Array.from(listRoot.querySelectorAll('[data-e2e="chat-list-item"]')).filter(filterRow);
    if (rows.length > 0) {
      rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      recordStrategy('conversationList', 'L1:data-e2e', rows.length);
      return rows.slice(0, limit);
    }

    // Tầng 2: role="listitem" hoặc aria-label hội thoại
    rows = Array.from(listRoot.querySelectorAll('[role="listitem"], li')).filter((el) => {
      if (!filterRow(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 160 && r.width <= 520 && r.height >= 44 && r.height <= 135 && normalizeText(el.innerText).length >= 3;
    });
    if (rows.length >= 2) {
      rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      recordStrategy('conversationList', 'L2:role-listitem', rows.length);
      return rows.slice(0, limit);
    }

    // Tầng 3: Neo theo chuỗi thời gian (11:43, 19/11/2026, 9/21/2026, 5 phút...)
    const timeRegex = /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}|\d+\s*(phút|giờ|ngày|m|h|d))$/i;
    const anchors = Array.from(listRoot.querySelectorAll('span, p, div, time')).filter((el) => {
      if (!isVisible(el) || el.children.length > 1) return false;
      return timeRegex.test(normalizeText(el.innerText));
    });
    const seen = new Set();
    const anchored = [];
    for (const node of anchors) {
      let cur = node.parentElement;
      for (let d = 0; d < 7 && cur && cur !== listRoot; d++) {
        const r = cur.getBoundingClientRect();
        if (r.width >= 170 && r.width <= 520 && r.height >= 46 && r.height <= 135 && filterRow(cur)) {
          if (!seen.has(cur)) {
            seen.add(cur);
            anchored.push(cur);
          }
          break;
        }
        cur = cur.parentElement;
      }
    }
    const cleanAnchored = anchored.filter((row) => !anchored.some((o) => o !== row && row.contains(o)));
    if (cleanAnchored.length >= 1) {
      cleanAnchored.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      recordStrategy('conversationList', 'L3:time-anchor', cleanAnchored.length);
      return cleanAnchored.slice(0, limit);
    }

    // Tầng 4: Hình học danh sách dọc lặp lại
    const geoRows = findRepeatedVerticalRows(msgDoc, { maxLeftRatio: 0.52, minTop: 60 }).filter(filterRow);
    recordStrategy('conversationList', geoRows.length ? 'L4:geometry' : 'none', geoRows.length);
    return geoRows.slice(0, limit);
  }

  /**
   * Tìm khung chat đang mở theo 3 tầng thích ứng.
   */
  function findChatbox(msgDoc, convRows = []) {
    if (!msgDoc) return null;

    // Tầng 1: data-e2e chuẩn
    const byE2e = msgDoc.querySelector('[data-e2e="dm-new-chatbox"]');
    if (byE2e && isVisible(byE2e)) {
      recordStrategy('chatbox', 'L1:data-e2e');
      return byE2e;
    }

    // Tầng 2: Khung nằm bên phải danh sách hội thoại và chứa ô nhập liệu
    const leftEdge = convRows.length > 0 ? convRows[0].getBoundingClientRect().right - 15 : 220;
    const candidates = Array.from(msgDoc.querySelectorAll('div, main, section')).filter((el) => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return (
        r.left >= leftEdge &&
        r.width >= 260 &&
        r.height >= 260 &&
        Boolean(el.querySelector('div[contenteditable="true"], textarea, [role="textbox"]'))
      );
    });
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
      recordStrategy('chatbox', 'L2:geometry-with-input');
      return candidates[0];
    }

    recordStrategy('chatbox', 'L3:doc-body');
    return msgDoc.body;
  }

  /**
   * Tìm danh sách 5 video cột trái trên tab Bình luận Business Suite theo 4 tầng thích ứng.
   */
  function findCommentVideoRows(limit = 5) {
    // Tầng 1: .infinite-scroll-component > div (DOM thực tế hiện tại)
    const scroller = document.querySelector('.infinite-scroll-component');
    if (scroller) {
      const items = Array.from(scroller.children).filter(
        (el) => isVisible(el) && el.getBoundingClientRect().height >= 45
      );
      if (items.length > 0) {
        items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        recordStrategy('videoList', 'L1:infinite-scroll', items.length);
        return items.slice(0, limit);
      }
    }

    // Tầng 2: Neo theo chuỗi trạng thái bình luận (Việt + Anh: "Không có bình luận mới nào", "No new comments", "5 giờ", "5h")
    const maxLeft = window.innerWidth * 0.52;
    const statusRegex =
      /^(không có bình luận mới nào|no new comments?|\d+\s*bình luận mới|\d+\s*new comments?|\d+\s*(phút|giờ|ngày|min|mins|hr|hrs|hour|hours|day|days|m|h|d)|\d{1,2}\/\d{1,2}\/\d{4})$/i;
    const anchors = Array.from(document.querySelectorAll('span, p, div')).filter((el) => {
      if (!isVisible(el) || el.children.length > 1) return false;
      const r = el.getBoundingClientRect();
      return r.top > 120 && r.left < maxLeft && statusRegex.test(normalizeText(el.innerText));
    });
    const seen = new Set();
    const anchored = [];
    for (const node of anchors) {
      let cur = node.parentElement;
      for (let d = 0; d < 7 && cur && cur !== document.body; d++) {
        const r = cur.getBoundingClientRect();
        if (r.left < maxLeft && r.width >= 160 && r.width <= 520 && r.height >= 50 && r.height <= 165) {
          if (!seen.has(cur)) {
            seen.add(cur);
            anchored.push(cur);
          }
          break;
        }
        cur = cur.parentElement;
      }
    }
    const clean = anchored.filter((row) => !anchored.some((o) => o !== row && row.contains(o)));
    if (clean.length >= 1) {
      clean.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      recordStrategy('videoList', 'L2:status-anchor', clean.length);
      return clean.slice(0, limit);
    }

    // Tầng 3: Hình học danh sách dọc bên trái
    const geo = findRepeatedVerticalRows(document, { maxLeftRatio: 0.5, minTop: 120, minH: 52, maxH: 170 });
    recordStrategy('videoList', geo.length ? 'L3:geometry' : 'none', geo.length);
    return geo.slice(0, limit);
  }

  /**
   * Tìm toàn bộ nút "Trả lời" / "Reply" trong vùng bình luận (tự thích ứng nếu bỏ data-e2e).
   */
  function findCommentReplyButtons(videoDoc) {
    if (!videoDoc) return [];

    // Tầng 1: data-e2e chuẩn
    let btns = Array.from(videoDoc.querySelectorAll('[data-e2e="comment-reply-1"]')).filter(isVisible);
    if (btns.length > 0) {
      recordStrategy('replyButtons', 'L1:data-e2e', btns.length);
      return btns;
    }

    // Tầng 2: Quét theo nhãn chữ "Trả lời" / "Reply"
    btns = Array.from(videoDoc.querySelectorAll('p, span, button, div, a')).filter((el) => {
      if (!isVisible(el) || el.children.length > 1) return false;
      if (el.closest('[contenteditable="true"], textarea')) return false;
      return /^(Trả lời|Reply)$/i.test(normalizeText(el.innerText));
    });
    recordStrategy('replyButtons', btns.length ? 'L2:text-match' : 'none', btns.length);
    return btns;
  }

  /**
   * Cô lập đúng 1 khung bình luận duy nhất (bao gồm cả dòng "Xem X câu trả lời" nếu có, không lẫn sang bình luận khác).
   */
  function isolateCommentBlock(replyBtn, videoDoc) {
    // Tầng 1: Class chuẩn của TikTok
    const byClass =
      replyBtn.closest('[class*="DivCommentObjectWrapper"]') ||
      replyBtn.closest('[class*="DivCommentItemWrapper"]')?.parentElement;
    if (byClass && byClass !== videoDoc.body) {
      const r = byClass.getBoundingClientRect();
      if (r.height <= 360) {
        return {
          objectWrap: byClass,
          itemWrap: replyBtn.closest('[class*="DivCommentItemWrapper"]') || byClass
        };
      }
    }

    // Tầng 2 (Hình học tự thích ứng): Leo lên khung bao lớn nhất chỉ chứa đúng 1 nút "Trả lời"
    const countReplies = (el) =>
      Array.from(el.querySelectorAll('[data-e2e="comment-reply-1"], p, span, button')).filter(
        (n) => isVisible(n) && n.children.length <= 1 && /^(Trả lời|Reply)$/i.test(normalizeText(n.innerText))
      ).length;

    let best = replyBtn.parentElement;
    let cur = replyBtn.parentElement;
    for (let d = 0; d < 8 && cur && cur !== videoDoc.body; d++) {
      const r = cur.getBoundingClientRect();
      const txt = normalizeText(cur.innerText);
      const hasHeader = /\b\d+\s*bình luận\b|\b\d+\s*comments?\b/i.test(txt);
      const hasInput = Boolean(cur.querySelector('[contenteditable="true"], textarea'));
      if (countReplies(cur) === 1 && r.height <= 300 && !hasHeader && !hasInput) {
        best = cur;
        cur = cur.parentElement;
      } else {
        break;
      }
    }
    return { objectWrap: best, itemWrap: best };
  }

  function getAdaptiveReport() {
    return { ...lastStrategyReport };
  }

  ns.adaptive = {
    resolveMessagesDoc,
    resolveVideoDoc,
    findMessageRequestsEntry,
    findMessageRequestsBackButton,
    findConversationRows,
    findChatbox,
    findCommentVideoRows,
    findCommentReplyButtons,
    isolateCommentBlock,
    getAdaptiveReport
  };
})(window.TTAR);
