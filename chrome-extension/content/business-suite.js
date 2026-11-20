// content/business-suite.js - Quét chuẩn 100% DOM thực tế TikTok Business Suite (iframe /messages + .infinite-scroll-component + iframe /video/)

window.TTAR = window.TTAR || {};

(function (ns) {
  const {
    sleep,
    humanDelay,
    normalizeText,
    hashString,
    getWin,
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

  const DEFAULT_CONVERSATIONS_COUNT = 10;
  const DEFAULT_VIDEOS_COUNT = 5;

  function isBusinessSuitePage() {
    return /\/business-suite\//i.test(window.location.pathname);
  }

  function flashHighlight(el, color = '#38bdf8') {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    el.style.outline = `2px solid ${color}`;
    setTimeout(() => {
      try {
        el.style.outline = prevOutline;
      } catch (_) {}
    }, 1500);
  }

  async function logStep(type, customer, incoming, reply = '', error = '', level = 'info') {
    await sendRuntimeMessage({
      action: 'LOG_EVENT',
      payload: { level, type, customer, incoming, reply, error }
    });
  }

  function findTopTab(tabType) {
    const hrefPart = tabType === 'messages' ? '/business-suite/messages' : '/business-suite/comments';
    const byHref = document.querySelector(`a[href*="${hrefPart}"]`);
    if (byHref && isVisible(byHref)) return byHref;

    const patterns =
      tabType === 'messages'
        ? [/^Tin nhắn(\s*\d+)?$/i, /^Messages(\s*\d+)?$/i]
        : [/^Bình luận(\s*\d+)?$/i, /^Comments(\s*\d+)?$/i];

    const nodes = Array.from(document.querySelectorAll('a, button, [role="tab"]')).filter((el) => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.top > 180) return false;
      return patterns.some((re) => re.test(normalizeText(el.innerText)));
    });
    if (nodes.length > 0) return nodes[0];
    return findClickableByText(patterns);
  }

  async function switchBusinessTab(tabType) {
    const expectedPath = tabType === 'messages' ? '/business-suite/messages' : '/business-suite/comments';
    if (window.location.pathname.includes(expectedPath)) {
      return true;
    }
    const tab = findTopTab(tabType);
    if (!tab) return false;
    flashHighlight(tab, '#10b981');
    humanClick(tab);
    await sleep(1800);
    return true;
  }

  // ==================== PHẦN 1: IFRAME TIN NHẮN (/messages) ====================

  function getMessagesDoc() {
    const iframe = Array.from(document.querySelectorAll('iframe')).find(
      (f) => /\/messages/i.test(f.src || '') && f.getBoundingClientRect().width > 100
    );
    try {
      return iframe?.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  function getConversationRows(msgDoc, limit = DEFAULT_CONVERSATIONS_COUNT) {
    if (!msgDoc) return [];
    const listRoot = msgDoc.querySelector('[data-e2e="dm-new-conversation-list"]') || msgDoc;

    // Ưu tiên selector chuẩn data-e2e của TikTok Messages
    let rows = Array.from(listRoot.querySelectorAll('[data-e2e="chat-list-item"]')).filter(isVisible);

    // Dự phòng: neo theo mốc thời gian (11:43, 19/11/2026...) trong dm-new-conversation-list
    if (rows.length === 0) {
      const timeRegex = /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d+\s*(phút|giờ|ngày))$/i;
      const anchors = Array.from(listRoot.querySelectorAll('span, p, div')).filter((el) => {
        if (!isVisible(el) || el.children.length > 1) return false;
        return timeRegex.test(normalizeText(el.innerText));
      });

      const seen = new Set();
      for (const node of anchors) {
        let cur = node.parentElement;
        for (let depth = 0; depth < 7 && cur && cur !== listRoot; depth++) {
          const r = cur.getBoundingClientRect();
          if (r.width >= 180 && r.width <= 480 && r.height >= 48 && r.height <= 125) {
            if (!seen.has(cur)) {
              seen.add(cur);
              rows.push(cur);
            }
            break;
          }
          cur = cur.parentElement;
        }
      }
      rows = rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
    }

    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows.slice(0, limit);
  }

  async function scrollChatToBottom(msgDoc) {
    const box = msgDoc.querySelector('[data-e2e="dm-new-chatbox"]') || msgDoc.body;
    if (!box) return;
    const win = getWin(box);
    const scrollables = [box, ...Array.from(box.querySelectorAll('div'))].filter((el) => {
      if (!isVisible(el)) return false;
      const st = win.getComputedStyle(el);
      return /(auto|scroll|overlay)/i.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20;
    });
    for (const sc of scrollables) {
      sc.scrollTop = sc.scrollHeight;
    }
    await sleep(300);
  }

  function extractChatMessagesFromDoc(msgDoc) {
    const box = msgDoc.querySelector('[data-e2e="dm-new-chatbox"]');
    if (!box || !isVisible(box)) return { customerName: 'Khách', messages: [] };
    const boxRect = box.getBoundingClientRect();

    // Đọc tên khách ở header chatbox
    let customerName = 'Khách';
    const headerCandidates = Array.from(box.querySelectorAll('p, span, div, h1, h2, h3')).filter((el) => {
      if (!isVisible(el) || el.children.length > 0) return false;
      const r = el.getBoundingClientRect();
      return r.top >= boxRect.top && r.top <= boxRect.top + 85;
    });
    for (const el of headerCandidates) {
      const t = normalizeText(el.innerText);
      if (t && t.length >= 2 && t.length <= 60 && !/^@/.test(t)) {
        customerName = t;
        break;
      }
    }

    const inputEl = findEditableInput(box, [/gửi tin nhắn|send a message/i]);
    const inputTop = inputEl ? inputEl.getBoundingClientRect().top : boxRect.bottom - 65;
    const chatTop = boxRect.top + 65;

    // Ưu tiên [data-e2e="chat-item"] nếu có, không thì quét text leaf nodes trong chatbox
    const rawNodes = Array.from(box.querySelectorAll('p, span, div')).filter((el) => {
      if (!isVisible(el)) return false;
      if (el.closest('[contenteditable="true"], button, [role="button"], [role="tooltip"]')) return false;
      if (el.children.length > 2) return false;

      const r = el.getBoundingClientRect();
      if (r.top < chatTop || r.bottom > inputTop - 6) return false;
      if (r.height < 12 || r.width < 8) return false;

      const text = normalizeText(el.innerText);
      if (!text || text.length > 1500) return false;
      if (text.length < 2 && !/[a-zA-ZÀ-ỹ0-9]/.test(text)) return false;
      if (
        /^\d{1,2}\s*Tháng|^\d{1,2}:\d{2}$|^\d{1,2}\/\d{1,2}\/\d{4}|tin nhắn này được gửi|từ quảng cáo|yêu cầu trò chuyện đã được chấp nhận/i.test(
          text
        )
      ) {
        return false;
      }
      if (el.closest('a[href*="/video/"]')) return false;
      return true;
    });

    const leafNodes = rawNodes.filter(
      (node) => !rawNodes.some((other) => other !== node && node.contains(other))
    );
    leafNodes.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    const messages = [];
    for (const node of leafNodes) {
      const text = normalizeText(node.innerText);
      if (!text) continue;
      const rect = node.getBoundingClientRect();

      const distLeft = rect.left - boxRect.left;
      const distRight = boxRect.right - rect.right;
      const isCenteredNotice = Math.abs(distLeft - distRight) < 28 && rect.width < boxRect.width * 0.5;
      if (isCenteredNotice && /\d{1,2}:\d{2}|hôm nay|hôm qua|tháng/i.test(text)) {
        continue;
      }

      // Tin của kênh (shop) nằm sát lề phải chatbox; tin của khách nằm sát lề trái
      const sender = distRight + 24 < distLeft ? 'shop' : 'customer';

      const prev = messages[messages.length - 1];
      if (prev && prev.sender === sender && Math.abs(prev.top - rect.top) < 8) {
        if (!prev.text.includes(text)) {
          prev.text = `${prev.text} ${text}`.trim();
        }
      } else {
        messages.push({ sender, text, top: rect.top });
      }
    }

    // Đọc ngữ cảnh video/bài viết khách chia sẻ trong khung chat (nếu có)
    const sharedVideoParts = Array.from(box.querySelectorAll('a[href*="/video/"], [data-e2e*="video" i]'))
      .map((el) => {
        const imgAlt = el.querySelector('img')?.getAttribute('alt') || '';
        const txt = normalizeText(el.innerText || '');
        const href = el.getAttribute('href') || '';
        return normalizeText([txt, imgAlt, href ? `(link: ${href})` : ''].filter(Boolean).join(' '));
      })
      .filter((t) => t.length >= 4);
    const sharedVideoContext = [...new Set(sharedVideoParts)].slice(-2).join(' | ').slice(0, 320);

    return {
      customerName,
      sharedVideoContext,
      messages: messages.map(({ sender, text }) => ({ sender, text }))
    };
  }

  async function scanBusinessMessages(settings) {
    if (!isBusinessSuitePage()) return { scanned: 0, replied: 0, stoppedForDraft: false };

    const targetCount = Math.max(1, Math.min(20, Number(settings.messageScanCount) || DEFAULT_CONVERSATIONS_COUNT));
    const switched = await switchBusinessTab('messages');
    if (!switched) {
      StatusOverlay.update('error', 'Không tìm thấy tab Tin nhắn');
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }

    // Chờ iframe /messages và danh sách hội thoại render xong
    const ready = await waitFor(() => {
      const doc = getMessagesDoc();
      if (!doc) return null;
      const rows = getConversationRows(doc, targetCount);
      return rows.length > 0 ? { doc, count: rows.length } : null;
    }, 8000);

    if (!ready) {
      StatusOverlay.update('error', 'Tin nhắn: Không tải được iframe danh sách hội thoại');
      await logStep('message', 'System', 'Quét tab Tin nhắn', '', 'Không tìm thấy dòng hội thoại trong iframe /messages', 'error');
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }

    let scanned = 0;
    let replied = 0;

    for (let i = 0; i < ready.count; i++) {
      const msgDoc = getMessagesDoc();
      if (!msgDoc) break;
      const rows = getConversationRows(msgDoc, targetCount);
      const row = rows[i];
      if (!row) break;

      scanned++;
      const expectedName = normalizeText((row.innerText || '').split('\n')[0] || '');
      const prevHeaderName = extractChatMessagesFromDoc(msgDoc).customerName;
      StatusOverlay.update('busy', `Tin nhắn ${i + 1}/${ready.count}: Mở ${(expectedName || `#${i + 1}`).slice(0, 22)}...`);

      flashHighlight(row, '#38bdf8');
      humanClick(row);

      // Chờ khung chat thực sự chuyển sang đúng khách hàng vừa bấm (tránh đọc nhầm khách trước đó!)
      await waitFor(() => {
        const cur = extractChatMessagesFromDoc(msgDoc);
        if (!cur.customerName) return false;
        const matchedExpected =
          expectedName &&
          (cur.customerName.toLowerCase().includes(expectedName.toLowerCase().slice(0, 8)) ||
            expectedName.toLowerCase().includes(cur.customerName.toLowerCase().slice(0, 8)));
        const changedFromPrev = prevHeaderName && cur.customerName !== prevHeaderName;
        return (matchedExpected || changedFromPrev) && cur.messages.length > 0;
      }, 4000);
      await sleep(700);
      await scrollChatToBottom(msgDoc);
      await sleep(300);

      const { customerName, sharedVideoContext, messages } = extractChatMessagesFromDoc(msgDoc);
      if (messages.length === 0) {
        await logStep('message', customerName, 'Không đọc được tin nhắn trong khung chat');
        continue;
      }

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.sender === 'shop') {
        await logStep('message', customerName, `Kênh đã trả lời cuối ("${lastMsg.text.slice(0, 38)}") → Bỏ qua`);
        continue;
      }

      // Gom các tin nhắn liên tiếp cuối cùng của khách
      const trailingCustomerMsgs = [];
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j].sender === 'customer') {
          trailingCustomerMsgs.unshift(messages[j].text);
        } else {
          break;
        }
      }
      const latestCombinedText = trailingCustomerMsgs.join('\n');

      const fingerprint = `bs_msg_${hashString(`${customerName}|${latestCombinedText}`)}`;
      const checkRes = await sendRuntimeMessage({ action: 'CHECK_PROCESSED', fingerprint });
      if (checkRes?.processed) {
        await logStep('message', customerName, `Đã xử lý trước đó ("${latestCombinedText.slice(0, 35)}") → Bỏ qua`);
        continue;
      }

      StatusOverlay.update('busy', `Gemini đang trả lời tin nhắn ${customerName}...`);
      const aiRes = await sendRuntimeMessage({
        action: 'GENERATE_REPLY',
        payload: {
          type: 'message',
          source: 'business_suite_message',
          fingerprint,
          customerName,
          sharedVideoContext,
          latestText: latestCombinedText,
          history: messages
        }
      });

      if (!aiRes?.ok || !aiRes.replyText) {
        if (aiRes?.error) {
          StatusOverlay.update('error', `Lỗi Gemini: ${aiRes.error.slice(0, 42)}`);
        }
        continue;
      }

      const box = msgDoc.querySelector('[data-e2e="dm-new-chatbox"]') || msgDoc;
      const inputEl = await waitFor(
        () => findEditableInput(box, [/gửi tin nhắn|send a message/i]),
        4500
      );
      if (!inputEl) {
        await logStep('message', customerName, latestCombinedText, '', 'Không tìm thấy ô nhập tin nhắn trong iframe.', 'error');
        continue;
      }

      const filled = await fillEditableInput(inputEl, aiRes.replyText);
      if (!filled) {
        await logStep('message', customerName, latestCombinedText, '', 'Không thể điền nội dung vào ô nhập tin nhắn.', 'error');
        continue;
      }

      await humanDelay(450, 850);

      if (!settings.draftOnly) {
        const sendBtn = box.querySelector('[data-e2e="message-send"]');
        const sentOk = await submitInput(inputEl, sendBtn);
        if (!sentOk) {
          await logStep('message', customerName, latestCombinedText, aiRes.replyText, 'Đã điền nhưng nút gửi chưa ăn — sẽ thử lại ở vòng sau.', 'error');
          continue;
        }
        await humanDelay(650, 1050);
      }

      await sendRuntimeMessage({
        action: 'MARK_SENT',
        payload: {
          fingerprint,
          type: 'message',
          draftOnly: settings.draftOnly,
          customer: customerName,
          incoming: latestCombinedText,
          reply: aiRes.replyText
        }
      });

      replied++;
      StatusOverlay.update(
        'running',
        settings.draftOnly
          ? `Đã điền nháp cho ${customerName} (giữ màn hình)`
          : `Đã trả lời tin nhắn ${customerName}`
      );

      if (settings.draftOnly) {
        return { scanned, replied, stoppedForDraft: true };
      }

      await humanDelay(650, 1100);
    }

    return { scanned, replied, stoppedForDraft: false };
  }

  // ==================== PHẦN 2: TAB BÌNH LUẬN (.infinite-scroll-component + iframe /video/) ====================

  function getCommentVideoRows(limit = DEFAULT_VIDEOS_COUNT) {
    const container = document.querySelector('.infinite-scroll-component');
    if (container) {
      const items = Array.from(container.children).filter(
        (el) => isVisible(el) && el.getBoundingClientRect().height >= 45
      );
      if (items.length > 0) {
        items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        return items.slice(0, limit);
      }
    }
    return [];
  }

  function getVideoIframe() {
    return Array.from(document.querySelectorAll('iframe')).find(
      (f) => /\/video\//i.test(f.src || '') && f.getBoundingClientRect().width > 100
    );
  }

  function getVideoDoc() {
    const iframe = getVideoIframe();
    try {
      return iframe?.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  async function scrollVideoIframeDown(videoDoc, maxSteps = 12) {
    if (!videoDoc) return;
    const win = videoDoc.defaultView;
    const scroller = videoDoc.scrollingElement || videoDoc.documentElement;
    let lastScrollTop = -1;
    let stuckCount = 0;

    for (let s = 0; s < maxSteps; s++) {
      if (win) win.scrollBy(0, 440);
      if (scroller) scroller.scrollTop += 440;
      // Cuộn chậm rãi 650ms mỗi nhịp để TikTok kịp tải hết các bình luận lazy-load bên dưới
      await sleep(650);

      const curTop = scroller ? scroller.scrollTop : win?.scrollY || 0;
      if (Math.abs(curTop - lastScrollTop) < 8) {
        stuckCount++;
        if (stuckCount >= 3) break; // Chắc chắn đã chạm đáy danh sách bình luận
      } else {
        stuckCount = 0;
        lastScrollTop = curTop;
      }
    }
  }

  function extractCommentsFromVideoDoc(videoDoc, fallbackTitle = '') {
    if (!videoDoc) return { videoCaption: fallbackTitle, comments: [] };

    const captionEl = videoDoc.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]');
    let videoCaption = normalizeText(captionEl?.innerText || '');

    // Dự phòng nếu TikTok đổi data-e2e: đọc đoạn mô tả + hashtag nằm phía trên mục "X bình luận"
    if (!videoCaption) {
      const descCandidates = Array.from(videoDoc.querySelectorAll('h1, p, span, div')).filter((el) => {
        if (!isVisible(el) || el.children.length > 8) return false;
        if (el.closest('[class*="DivComment"]')) return false;
        const txt = normalizeText(el.innerText);
        return (
          txt.length >= 12 &&
          txt.length <= 500 &&
          /#\S+/.test(txt) &&
          !/^\d+\s*bình luận/i.test(txt)
        );
      });
      if (descCandidates.length > 0) {
        descCandidates.sort((a, b) => a.innerText.length - b.innerText.length);
        videoCaption = normalizeText(descCandidates[0].innerText);
      }
    }

    if (!videoCaption && fallbackTitle) {
      videoCaption = normalizeText(fallbackTitle);
    }
    videoCaption = videoCaption.slice(0, 420);

    // Selector chuẩn 100% từ DOM thực tế TikTok: [data-e2e="comment-reply-1"]
    const replyBtns = Array.from(videoDoc.querySelectorAll('[data-e2e="comment-reply-1"]')).filter(isVisible);

    const comments = [];
    const seen = new Set();

    for (const replyBtn of replyBtns) {
      // DivCommentObjectWrapper bao trọn 1 bình luận gốc + phần "Xem X câu trả lời" của riêng nó
      const objectWrap =
        replyBtn.closest('[class*="DivCommentObjectWrapper"]') ||
        replyBtn.closest('[class*="DivCommentItemWrapper"]')?.parentElement ||
        replyBtn.closest('[class*="DivCommentItemWrapper"]');

      if (!objectWrap || seen.has(objectWrap)) continue;
      seen.add(objectWrap);

      const fullBlockText = normalizeText(objectWrap.innerText);

      // Nếu bình luận ĐÃ có "Xem X câu trả lời" => đã có phản hồi, bỏ qua!
      if (/xem\s+\d+\s+câu trả lời|view\s+\d+\s+repl|ẩn câu trả lời|hide repl/i.test(fullBlockText)) {
        continue;
      }

      const itemWrap = replyBtn.closest('[class*="DivCommentItemWrapper"]') || objectWrap;
      const lines = (itemWrap.innerText || '')
        .split('\n')
        .map((l) => normalizeText(l))
        .filter(
          (l) =>
            l &&
            !/^(Trả lời|Reply|\d+)$/i.test(l) &&
            !/^\d{1,2}-\d{1,2}(\s*(Trả lời|Reply))?$/i.test(l) &&
            !/^\d{1,2}\/\d{1,2}\/\d{2,4}(\s*(Trả lời|Reply))?$/i.test(l) &&
            !/^\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)\s*trước(\s*(Trả lời|Reply))?$/i.test(l) &&
            !/^\d+[smhdw](\s*ago)?$/i.test(l)
        );

      if (lines.length < 2) continue;
      const author = lines[0].replace(/\s*[·•]\s*Bạn bè$/i, '').trim();
      const commentText = lines.slice(1).join(' ').trim();
      if (!commentText || commentText.length < 2) continue;

      comments.push({
        author,
        commentText,
        replyBtn,
        videoCaption
      });
    }

    return { videoCaption, comments };
  }

  async function scanBusinessComments(settings) {
    if (!isBusinessSuitePage()) return { scanned: 0, replied: 0, stoppedForDraft: false };

    const targetVideos = Math.max(1, Math.min(15, Number(settings.commentVideoCount) || DEFAULT_VIDEOS_COUNT));
    const switched = await switchBusinessTab('comments');
    if (!switched) return { scanned: 0, replied: 0, stoppedForDraft: false };

    const videoRows = await waitFor(() => {
      const items = getCommentVideoRows(targetVideos);
      return items.length > 0 ? items : null;
    }, 7000);

    if (!videoRows || videoRows.length === 0) {
      StatusOverlay.update('error', 'Bình luận: Không đọc được danh sách video');
      await logStep('comment', 'System', 'Quét tab Bình luận', '', 'Không thấy .infinite-scroll-component', 'error');
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }

    let replied = 0;

    for (let vIdx = 0; vIdx < videoRows.length; vIdx++) {
      const freshVideos = getCommentVideoRows(targetVideos);
      const vRow = freshVideos[vIdx];
      if (!vRow) break;

      const prevSrc = getVideoIframe()?.src || '';
      const rowVideoTitle = normalizeText((vRow.innerText || '').split('\n')[0] || '');
      StatusOverlay.update('busy', `Bình luận ${vIdx + 1}/${videoRows.length}: Đang mở video từ từ...`);
      flashHighlight(vRow, '#38bdf8');
      humanClick(vRow);

      // Chờ iframe video đổi src và tải xong
      await waitFor(() => {
        const doc = getVideoDoc();
        const curSrc = getVideoIframe()?.src || '';
        return doc && doc.readyState === 'complete' && (vIdx === 0 || curSrc !== prevSrc) ? doc : null;
      }, 7000);
      await sleep(1600);

      const videoDoc = getVideoDoc();
      if (!videoDoc) continue;

      // Chờ danh sách bình luận trong iframe render (tối đa 4.5s) rồi mới cuộn chậm xuống hết
      await waitFor(
        () =>
          videoDoc.querySelector('[data-e2e="comment-reply-1"]') ||
          /0 bình luận|hãy là người đầu tiên/i.test(videoDoc.body?.innerText || ''),
        4500
      );

      StatusOverlay.update('busy', `Bình luận ${vIdx + 1}/${videoRows.length}: Đang kéo xuống tải hết bình luận...`);
      await scrollVideoIframeDown(videoDoc, 12);
      await sleep(700);

      // Quét lặp lại DOM thật sau MỖI câu trả lời để không bao giờ bị stale DOM hay bỏ sót bình luận!
      const attemptedInVideo = new Set();
      let videoRepliedCount = 0;

      for (let guard = 0; guard < 25; guard++) {
        const liveDoc = getVideoDoc();
        if (!liveDoc) break;

        const { videoCaption, comments } = extractCommentsFromVideoDoc(liveDoc, rowVideoTitle);
        let nextItem = null;
        let nextFingerprint = '';

        for (const candidate of comments) {
          const fp = `bs_cmt_${hashString(`${videoCaption.slice(0, 40)}|${candidate.author}|${candidate.commentText}`)}`;
          if (attemptedInVideo.has(fp)) continue;
          const checkRes = await sendRuntimeMessage({ action: 'CHECK_PROCESSED', fingerprint: fp });
          if (checkRes?.processed) {
            attemptedInVideo.add(fp);
            continue;
          }
          nextItem = candidate;
          nextFingerprint = fp;
          break;
        }

        if (!nextItem) {
          if (videoRepliedCount === 0) {
            await logStep('comment', `Video #${vIdx + 1}`, 'Đã kiểm tra hết — không còn bình luận chưa trả lời');
          }
          break;
        }

        attemptedInVideo.add(nextFingerprint);
        StatusOverlay.update('busy', `Video #${vIdx + 1}: Gemini trả lời ${nextItem.author}...`);

        let aiRes = await sendRuntimeMessage({
          action: 'GENERATE_REPLY',
          payload: {
            type: 'comment',
            source: 'business_suite_comment',
            fingerprint: nextFingerprint,
            customerName: nextItem.author,
            latestText: nextItem.commentText,
            videoCaption
          }
        });

        // Nếu chạm giới hạn tốc độ gửi/phút -> chờ 15 giây rồi thử lại, KHÔNG bỏ sót bình luận!
        if (aiRes?.reason === 'rate_limited') {
          StatusOverlay.update('busy', 'Chạm giới hạn gửi/phút, tạm nghỉ 15s rồi trả lời tiếp...');
          await sleep(15000);
          aiRes = await sendRuntimeMessage({
            action: 'GENERATE_REPLY',
            payload: {
              type: 'comment',
              source: 'business_suite_comment',
              fingerprint: nextFingerprint,
              customerName: nextItem.author,
              latestText: nextItem.commentText,
              videoCaption
            }
          });
        }

        if (!aiRes?.ok || !aiRes.replyText) {
          if (aiRes?.error) {
            StatusOverlay.update('error', `Lỗi Gemini: ${aiRes.error.slice(0, 42)}`);
          }
          continue;
        }

        // Cuộn đúng bình luận vào giữa màn hình rồi bấm "Trả lời"
        try {
          nextItem.replyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_) {}
        await sleep(500);

        flashHighlight(nextItem.replyBtn, '#10b981');
        humanClick(nextItem.replyBtn);
        await sleep(900);

        const inputEl = await waitFor(
          () => findEditableInput(liveDoc, [/thêm bình luận|trả lời|add comment|reply/i], nextItem.replyBtn),
          4500
        );
        if (!inputEl) {
          await logStep('comment', nextItem.author, nextItem.commentText, '', 'Không tìm thấy ô nhập bình luận inline.', 'error');
          continue;
        }

        const filled = await fillEditableInput(inputEl, aiRes.replyText);
        if (!filled) {
          await logStep('comment', nextItem.author, nextItem.commentText, '', 'Không điền được nội dung vào ô bình luận.', 'error');
          continue;
        }

        await humanDelay(650, 1100);

        if (!settings.draftOnly) {
          const sentOk = await submitInput(inputEl);
          if (!sentOk) {
            await logStep('comment', nextItem.author, nextItem.commentText, aiRes.replyText, 'Đã điền bình luận nhưng nút gửi chưa ăn — sẽ thử lại ở vòng sau.', 'error');
            continue;
          }
          await humanDelay(1200, 1800);
        }

        await sendRuntimeMessage({
          action: 'MARK_SENT',
          payload: {
            fingerprint: nextFingerprint,
            type: 'comment',
            draftOnly: settings.draftOnly,
            customer: nextItem.author,
            incoming: nextItem.commentText,
            reply: aiRes.replyText
          }
        });

        replied++;
        videoRepliedCount++;
        StatusOverlay.update(
          'running',
          settings.draftOnly
            ? `Đã điền nháp bình luận ${nextItem.author} (giữ màn hình)`
            : `Đã trả lời bình luận ${nextItem.author} (Video #${vIdx + 1})`
        );

        if (settings.draftOnly) {
          return { scanned: vIdx + 1, replied, stoppedForDraft: true };
        }
      }

      // Chờ nhẹ trước khi chuyển sang video tiếp theo
      await humanDelay(1300, 1900);
    }

    return { scanned: videoRows.length, replied, stoppedForDraft: false };
  }

  function diagnoseBusinessSuite() {
    const msgDoc = getMessagesDoc();
    const videoDoc = getVideoDoc();
    const convRows = getConversationRows(msgDoc, 5);
    const videoRows = getCommentVideoRows(5);
    const chatData = msgDoc ? extractChatMessagesFromDoc(msgDoc) : { customerName: null, messages: [] };
    const cmtData = videoDoc ? extractCommentsFromVideoDoc(videoDoc) : { videoCaption: '', comments: [] };

    return {
      page: 'business_suite',
      url: window.location.pathname,
      messagesIframeReady: Boolean(msgDoc),
      conversationsFound: convRows.length,
      conversationsPreview: convRows.map((r) => normalizeText(r.innerText).slice(0, 40)),
      activeChatCustomer: chatData.customerName,
      lastMessage: chatData.messages[chatData.messages.length - 1] || null,
      videoRowsFound: videoRows.length,
      videoIframeReady: Boolean(videoDoc),
      unrepliedCommentsOnScreen: cmtData.comments.map((c) => ({
        author: c.author,
        text: c.commentText
      }))
    };
  }

  ns.businessSuite = {
    isBusinessSuitePage,
    scanBusinessMessages,
    scanBusinessComments,
    diagnoseBusinessSuite
  };
})(window.TTAR);
