// content/tiktok-activity.js - Quét & trả lời Bình luận qua Hoạt động -> Tab Bình luận trên tiktok.com

window.TTAR = window.TTAR || {};

(function (ns) {
  const {
    sleep,
    humanDelay,
    normalizeText,
    hashString,
    isVisible,
    waitFor,
    findClickableByText,
    humanClick,
    findEditableInput,
    fillEditableInput,
    submitInput,
    sendRuntimeMessage,
    StatusOverlay
  } = ns.dom;

  const PENDING_ACTIVITY_KEY = 'ttar_pending_activity_reply';

  function isTikTokMainSite() {
    return /tiktok\.com$/i.test(window.location.hostname) && !/\/business-suite\//i.test(window.location.pathname);
  }

  function findActivityNavButton() {
    const byAttr = document.querySelector(
      '[data-e2e="nav-activity"], [data-e2e="activity-icon"], button[aria-label*="Hoạt động" i], button[aria-label*="Activity" i]'
    );
    if (byAttr && isVisible(byAttr)) return byAttr;
    return findClickableByText([/^Hoạt động$/i, /^Activity$/i]);
  }

  function findNotificationPanel() {
    const header = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span')).find((el) => {
      if (!isVisible(el) || el.children.length > 1) return false;
      const txt = normalizeText(el.innerText);
      const r = el.getBoundingClientRect();
      return /^(Thông báo|Notifications|Activity)$/i.test(txt) && r.left < 380 && r.top < 140;
    });

    if (!header) return null;
    let panel = header.parentElement;
    for (let i = 0; i < 6 && panel && panel !== document.body; i++) {
      const r = panel.getBoundingClientRect();
      if (r.height >= 350 && r.width >= 240 && r.width <= 520) {
        return panel;
      }
      panel = panel.parentElement;
    }
    return document;
  }

  async function openActivityCommentsTab() {
    let panel = findNotificationPanel();
    if (!panel) {
      const navBtn = findActivityNavButton();
      if (!navBtn) return null;
      humanClick(navBtn);
      panel = await waitFor(() => findNotificationPanel(), 4500);
      if (!panel) return null;
    }

    const commentPill = findClickableByText([/^Bình luận$/i, /^Comments$/i], panel);
    if (commentPill) {
      humanClick(commentPill);
      await sleep(1000);
    }
    return panel;
  }

  function extractActivityCommentItems(panel) {
    const items = [];
    const seen = new Set();

    // Notification items contain comment/reply/mention actions
    const candidates = Array.from(panel.querySelectorAll('li, a, div')).filter((el) => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.height < 42 || r.height > 150 || r.width < 180 || r.width > 480) return false;
      const txt = normalizeText(el.innerText);
      return /đã bình luận:|đã trả lời bình luận|đã nhắc đến bạn|commented:|replied to your comment:|mentioned you/i.test(txt) && txt.length < 320;
    });

    // Keep innermost matching rows
    const rows = candidates.filter(
      (c) => !candidates.some((other) => other !== c && c.contains(other))
    );

    for (const row of rows) {
      const fullText = normalizeText(row.innerText);
      if (seen.has(fullText)) continue;
      seen.add(fullText);

      // Parse: "<Author> đã bình luận: <commentText> · <time>"
      const match = fullText.match(
        /^(.+?)\s+(?:đã bình luận:|đã trả lời bình luận[^:]*:|đã nhắc đến bạn[^:]*:|commented:|replied to your comment:|mentioned you[^:]*:)\s*(.+)$/i
      );
      if (!match) continue;

      const author = normalizeText(match[1]);
      let commentBody = normalizeText(match[2]);
      // Strip trailing relative time like "· 4 giờ trước" or "· 2 ngày trước"
      commentBody = commentBody
        .replace(/[·•]\s*\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)\s*trước$/i, '')
        .replace(/[·•]\s*\d+[smhdw](\s*ago)?$/i, '')
        .trim();

      if (!author || !commentBody) continue;
      items.push({ row, author, commentText: commentBody });
    }

    return items;
  }

  async function replyOnOpenedVideo(target, settings) {
    // Wait for comments section on video modal/page to render
    await sleep(1600);

    // Find video caption for better Gemini context
    const captionEl =
      document.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]') ||
      document.querySelector('h1');
    const videoCaption = normalizeText(captionEl?.innerText || '').slice(0, 300);

    // Locate the target comment's "Trả lời" / "Reply" button
    const replyButtons = Array.from(
      document.querySelectorAll('[data-e2e="comment-reply-1"], button, span, div')
    ).filter((el) => {
      if (!isVisible(el) || el.children.length > 1) return false;
      return /^(Trả lời|Reply)$/i.test(normalizeText(el.innerText));
    });

    let matchedReplyBtn = null;
    let alreadyReplied = false;
    const snippet = target.commentText.slice(0, 18).toLowerCase();

    for (const btn of replyButtons) {
      // Isolate single comment block (largest ancestor with exactly 1 "Trả lời" button)
      let block = btn.parentElement;
      let cursor = btn.parentElement;
      for (let i = 0; i < 8 && cursor && cursor !== document.body; i++) {
        const count = Array.from(cursor.querySelectorAll('[data-e2e="comment-reply-1"], button, span, div')).filter(
          (n) => isVisible(n) && n.children.length <= 1 && /^(Trả lời|Reply)$/i.test(normalizeText(n.innerText))
        ).length;
        if (count === 1) {
          block = cursor;
          cursor = cursor.parentElement;
        } else {
          break;
        }
      }
      if (!block) continue;
      const txt = normalizeText(block.innerText).toLowerCase();
      if (txt.includes(snippet) || txt.includes(target.author.toLowerCase())) {
        if (/xem\s+\d+\s+câu trả lời|view\s+\d+\s+repl/i.test(txt)) {
          alreadyReplied = true;
        } else {
          matchedReplyBtn = btn;
        }
        break;
      }
    }

    if (alreadyReplied) {
      await sendRuntimeMessage({
        action: 'MARK_SENT',
        payload: {
          fingerprint: target.fingerprint,
          type: 'comment',
          draftOnly: true,
          customer: target.author,
          incoming: target.commentText,
          reply: '(Bỏ qua - bình luận đã có câu trả lời)'
        }
      });
      return false;
    }

    if (matchedReplyBtn) {
      humanClick(matchedReplyBtn);
      await sleep(700);
    }

    StatusOverlay.update('busy', `Gemini đang trả lời bình luận của ${target.author}...`);
    const aiRes = await sendRuntimeMessage({
      action: 'GENERATE_REPLY',
      payload: {
        type: 'comment',
        source: 'activity_comment',
        fingerprint: target.fingerprint,
        customerName: target.author,
        latestText: target.commentText,
        videoCaption
      }
    });

    if (!aiRes?.ok || !aiRes.replyText) {
      return false;
    }

    const inputEl = await waitFor(
      () =>
        document.querySelector('[data-e2e="comment-input"] div[contenteditable="true"]') ||
        findEditableInput(document, [/thêm bình luận|trả lời|add comment|reply/i]),
      5000
    );

    if (!inputEl) {
      await sendRuntimeMessage({
        action: 'LOG_EVENT',
        payload: {
          level: 'error',
          type: 'comment',
          customer: target.author,
          incoming: target.commentText,
          error: 'Không tìm thấy ô nhập bình luận trên video.'
        }
      });
      return false;
    }

    const filled = await fillEditableInput(inputEl, aiRes.replyText);
    if (!filled) return false;

    await humanDelay(700, 1400);

    if (!settings.draftOnly) {
      const postBtn =
        document.querySelector('[data-e2e="comment-post"]') ||
        findClickableByText([/^Đăng$/i, /^Post$/i]);
      await submitInput(inputEl, postBtn);
      await humanDelay(900, 1500);
    }

    await sendRuntimeMessage({
      action: 'MARK_SENT',
      payload: {
        fingerprint: target.fingerprint,
        type: 'comment',
        draftOnly: settings.draftOnly,
        customer: target.author,
        incoming: target.commentText,
        reply: aiRes.replyText
      }
    });

    StatusOverlay.update(
      'running',
      settings.draftOnly
        ? `Đã điền nháp bình luận ${target.author}`
        : `Đã trả lời bình luận ${target.author}`
    );
    return true;
  }

  async function resumePendingActivityReply(settings) {
    const raw = sessionStorage.getItem(PENDING_ACTIVITY_KEY);
    if (!raw) return false;

    sessionStorage.removeItem(PENDING_ACTIVITY_KEY);
    try {
      const target = JSON.parse(raw);
      if (Date.now() - (target.ts || 0) > 60000) return false;
      return await replyOnOpenedVideo(target, settings);
    } catch (_) {
      return false;
    }
  }

  async function scanActivityComments(settings) {
    if (!isTikTokMainSite()) return { scanned: 0, replied: 0 };

    // If we just navigated to a video from a notification click, finish replying first
    const resumed = await resumePendingActivityReply(settings);
    if (resumed) {
      return { scanned: 1, replied: 1 };
    }

    const panel = await openActivityCommentsTab();
    if (!panel) {
      StatusOverlay.update('running', 'Hoạt động: Chưa thấy mục Thông báo');
      return { scanned: 0, replied: 0 };
    }

    const items = extractActivityCommentItems(panel).slice(0, 15);
    if (items.length === 0) {
      StatusOverlay.update('running', 'Hoạt động: Chưa thấy bình luận mới');
      return { scanned: 0, replied: 0 };
    }

    for (const item of items) {
      const fingerprint = `act_cmt_${hashString(`${item.author}|${item.commentText}`)}`;
      const checkRes = await sendRuntimeMessage({ action: 'CHECK_PROCESSED', fingerprint });
      if (checkRes?.processed) continue;

      const target = {
        author: item.author,
        commentText: item.commentText,
        fingerprint,
        ts: Date.now()
      };

      // Save in case clicking opens a new route/reloads page
      sessionStorage.setItem(PENDING_ACTIVITY_KEY, JSON.stringify(target));
      StatusOverlay.update('busy', `Mở bình luận của ${item.author}...`);
      humanClick(item.row);
      await humanDelay(1800, 2600);

      // If SPA modal opened without full reload, handle right away
      if (sessionStorage.getItem(PENDING_ACTIVITY_KEY)) {
        sessionStorage.removeItem(PENDING_ACTIVITY_KEY);
        const ok = await replyOnOpenedVideo(target, settings);
        return { scanned: 1, replied: ok ? 1 : 0 };
      }
      return { scanned: 1, replied: 0 };
    }

    StatusOverlay.update('running', 'Hoạt động: Đã xử lý hết bình luận gần đây');
    return { scanned: items.length, replied: 0 };
  }

  function diagnoseActivityPage() {
    const navBtn = Boolean(findActivityNavButton());
    const panel = findNotificationPanel();
    const itemsCount = panel ? extractActivityCommentItems(panel).length : 0;
    return {
      page: 'tiktok_main',
      activityNavFound: navBtn,
      notificationPanelOpen: Boolean(panel),
      commentNotificationsDetected: itemsCount
    };
  }

  ns.activity = {
    isTikTokMainSite,
    scanActivityComments,
    diagnoseActivityPage
  };
})(window.TTAR);
