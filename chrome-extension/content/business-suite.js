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
  const DEFAULT_REQUEST_CONVERSATIONS_COUNT = 5;
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

  // ==================== PHẦN 1: IFRAME TIN NHẮN (/messages) — TỰ THÍCH ỨNG 4 TẦNG ====================

  function getMessagesDoc() {
    return ns.adaptive.resolveMessagesDoc();
  }

  function getConversationRows(msgDoc, limit = DEFAULT_CONVERSATIONS_COUNT) {
    return ns.adaptive.findConversationRows(msgDoc, limit);
  }

  async function scrollChatToBottom(msgDoc) {
    const box = ns.adaptive.findChatbox(msgDoc, getConversationRows(msgDoc, 3)) || msgDoc.body;
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
    const box = ns.adaptive.findChatbox(msgDoc, getConversationRows(msgDoc, 3));
    if (!box || !isVisible(box)) return { customerName: 'Khách', sharedVideoContext: '', messages: [] };
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
        /^\d{1,2}\s*Tháng|^\d{1,2}:\d{2}(\s*[AP]M)?$|^\d{1,2}\/\d{1,2}\/\d{4}|tin nhắn này được gửi|từ quảng cáo|yêu cầu trò chuyện đã được chấp nhận|message request accepted|this message was sent|from an ad/i.test(
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

  async function acceptMessageRequestIfNeeded(box) {
    if (!box) return false;
    const acceptBtn = Array.from(box.querySelectorAll('button, [role="button"]')).find((el) => {
      if (!isVisible(el)) return false;
      return /^(accept|chấp nhận)$/i.test(normalizeText(el.innerText));
    });
    if (acceptBtn) {
      flashHighlight(acceptBtn, '#10b981');
      humanClick(acceptBtn);
      await sleep(900);
      return true;
    }
    return false;
  }

  async function waitForMessagesListReady(targetCount, { labelPrefix = 'Tin nhắn', isRequest = false, timeoutMs = 30000 } = {}) {
    const start = Date.now();
    let lastStatusSec = -1;
    const emptyRegex = isRequest
      ? /không có yêu cầu tin nhắn|no message requests|chưa có yêu cầu|trống/i
      : /chưa có tin nhắn nào|không có tin nhắn|no messages yet|you have no messages/i;

    while (Date.now() - start < timeoutMs) {
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      if (elapsedSec !== lastStatusSec && elapsedSec >= 2) {
        lastStatusSec = elapsedSec;
        StatusOverlay.update('busy', `Đang chờ tải danh sách ${labelPrefix}... (${elapsedSec}s)`);
      }

      const doc = getMessagesDoc();
      if (doc && doc.readyState !== 'loading') {
        const rows = getConversationRows(doc, targetCount);
        if (rows.length > 0) {
          // Chờ nhẹ 700ms cho danh sách ổn định sau khi phần tử đầu tiên xuất hiện
          await sleep(700);
          const freshDoc = getMessagesDoc() || doc;
          const freshRows = getConversationRows(freshDoc, targetCount);
          return { doc: freshDoc, count: freshRows.length, empty: false };
        }
        // Nếu đã qua ít nhất 3s và trang hiện thông báo danh sách trống thật sự -> thoát sớm không cần chờ đủ 30s
        if (elapsedSec >= 3 && emptyRegex.test(doc.body?.innerText || '')) {
          return { doc, count: 0, empty: true };
        }
      }
      await sleep(350);
    }
    return null;
  }

  async function processConversationBatch(targetCount, settings, { labelPrefix = 'Tin nhắn', source = 'business_suite_message', isRequest = false } = {}) {
    const ready = await waitForMessagesListReady(targetCount, {
      labelPrefix,
      isRequest,
      timeoutMs: isRequest ? 15000 : 30000
    });

    if (!ready) {
      if (!isRequest) {
        StatusOverlay.update('error', `${labelPrefix}: Trang tải quá chậm (>30s), sẽ thử lại vòng sau`);
        await logStep('message', 'System', `Chờ danh sách ${labelPrefix}`, '', 'Trang tải quá 30s chưa thấy hội thoại', 'error');
      }
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }

    if (ready.empty || ready.count === 0) {
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
      StatusOverlay.update('busy', `${labelPrefix} ${i + 1}/${ready.count}: Mở ${(expectedName || `#${i + 1}`).slice(0, 22)}...`);

      flashHighlight(row, '#38bdf8');
      humanClick(row);

      await waitFor(() => {
        const cur = extractChatMessagesFromDoc(msgDoc);
        if (!cur.customerName) return false;
        const matchedExpected =
          expectedName &&
          (cur.customerName.toLowerCase().includes(expectedName.toLowerCase().slice(0, 8)) ||
            expectedName.toLowerCase().includes(cur.customerName.toLowerCase().slice(0, 8)));
        const changedFromPrev = prevHeaderName && cur.customerName !== prevHeaderName;
        return (matchedExpected || changedFromPrev) && cur.messages.length > 0;
      }, 10000);
      await sleep(700);
      await scrollChatToBottom(msgDoc);
      await sleep(300);

      const { customerName, sharedVideoContext, messages } = extractChatMessagesFromDoc(msgDoc);
      if (messages.length === 0) {
        await logStep('message', customerName, `${labelPrefix}: Không đọc được tin nhắn trong khung chat`);
        continue;
      }

      // Tự học thụ động từ các cặp hỏi-đáp thực tế của nhân viên shop trong hội thoại
      if (settings.enableSelfLearning !== false && messages.length >= 2) {
        sendRuntimeMessage({
          action: 'LEARN_FROM_HISTORY',
          payload: {
            type: 'message',
            history: messages,
            context: sharedVideoContext || ''
          }
        }).catch(() => {});
      }

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.sender === 'shop') {
        await logStep('message', customerName, `Kênh đã trả lời cuối ("${lastMsg.text.slice(0, 38)}") → Bỏ qua`);
        continue;
      }

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

      StatusOverlay.update('busy', `Gemini đang trả lời ${labelPrefix.toLowerCase()} ${customerName}...`);
      const aiRes = await sendRuntimeMessage({
        action: 'GENERATE_REPLY',
        payload: {
          type: 'message',
          source,
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

      const box = ns.adaptive.findChatbox(msgDoc, rows) || msgDoc;
      if (isRequest) {
        await acceptMessageRequestIfNeeded(box);
      }

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
          : `Đã trả lời ${labelPrefix.toLowerCase()} ${customerName}`
      );

      if (settings.draftOnly) {
        return { scanned, replied, stoppedForDraft: true };
      }

      await humanDelay(650, 1100);
    }

    return { scanned, replied, stoppedForDraft: false };
  }

  async function scanBusinessMessages(settings) {
    if (!isBusinessSuitePage()) return { scanned: 0, replied: 0, stoppedForDraft: false };

    const targetCount = Math.max(1, Math.min(20, Number(settings.messageScanCount) || DEFAULT_CONVERSATIONS_COUNT));
    const switched = await switchBusinessTab('messages');
    if (!switched) {
      StatusOverlay.update('error', 'Không tìm thấy tab Tin nhắn');
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }

    // Chờ iframe /messages sẵn sàng (tối đa 25s cho máy/mạng tải chậm)
    StatusOverlay.update('busy', 'Đang chờ khung Tin nhắn tải xong...');
    const msgDocReady = await waitFor(() => {
      const d = getMessagesDoc();
      return d && d.body ? d : null;
    }, 25000);
    if (!msgDocReady) {
      StatusOverlay.update('error', 'Tin nhắn: Không tải được iframe danh sách hội thoại');
      await logStep('message', 'System', 'Quét tab Tin nhắn', '', 'Không tìm thấy iframe /messages', 'error');
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }

    // Nếu đang kẹt bên trong mục Message requests từ phiên trước -> quay lại danh sách chính
    const existingBack = ns.adaptive.findMessageRequestsBackButton(msgDocReady);
    if (existingBack) {
      humanClick(existingBack);
      await sleep(900);
    }

    // 1. Quét các cuộc hội thoại Tin nhắn chính
    const mainRes = await processConversationBatch(targetCount, settings, {
      labelPrefix: 'Tin nhắn',
      source: 'business_suite_message',
      isRequest: false
    });

    if (mainRes.stoppedForDraft) {
      return mainRes;
    }

    // 2. Quét mục "Message requests" / "Yêu cầu tin nhắn" (tài khoản cá nhân nhắn tới)
    let reqRes = { scanned: 0, replied: 0, stoppedForDraft: false };
    if (settings.enableMessageRequests !== false) {
      const liveDoc = getMessagesDoc();
      const reqEntry = ns.adaptive.findMessageRequestsEntry(liveDoc);
      if (reqEntry) {
        const reqLimit = Math.max(
          1,
          Math.min(20, Number(settings.messageRequestScanCount) || DEFAULT_REQUEST_CONVERSATIONS_COUNT)
        );
        StatusOverlay.update('busy', `Mở Yêu cầu tin nhắn (quét tối đa ${reqLimit} hội thoại)...`);
        flashHighlight(reqEntry, '#f59e0b');
        humanClick(reqEntry);
        await sleep(1200);

        reqRes = await processConversationBatch(reqLimit, settings, {
          labelPrefix: 'Yêu cầu TN',
          source: 'business_suite_message_request',
          isRequest: true
        });

        // Quay lại danh sách Tin nhắn chính nếu không dừng ở nháp
        if (!reqRes.stoppedForDraft) {
          const backBtn = ns.adaptive.findMessageRequestsBackButton(getMessagesDoc());
          if (backBtn) {
            humanClick(backBtn);
            await sleep(800);
          }
        }
      }
    }

    return {
      scanned: mainRes.scanned + reqRes.scanned,
      replied: mainRes.replied + reqRes.replied,
      stoppedForDraft: mainRes.stoppedForDraft || reqRes.stoppedForDraft
    };
  }

  // ==================== PHẦN 2: TAB BÌNH LUẬN — TỰ THÍCH ỨNG 4 TẦNG ====================

  function getCommentVideoRows(limit = DEFAULT_VIDEOS_COUNT) {
    return ns.adaptive.findCommentVideoRows(limit);
  }

  function getVideoIframe() {
    return Array.from(document.querySelectorAll('iframe')).find(
      (f) => /\/video\//i.test(f.src || '') && f.getBoundingClientRect().width > 100
    );
  }

  function getVideoDoc() {
    return ns.adaptive.resolveVideoDoc();
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

    // Tìm nút "Trả lời" / "Reply" tự thích ứng (ưu tiên data-e2e, dự phòng text)
    const replyBtns = ns.adaptive.findCommentReplyButtons(videoDoc);

    const comments = [];
    const seen = new Set();

    for (const replyBtn of replyBtns) {
      const { objectWrap, itemWrap } = ns.adaptive.isolateCommentBlock(replyBtn, videoDoc);

      if (!objectWrap || seen.has(objectWrap)) continue;
      seen.add(objectWrap);

      const fullBlockText = normalizeText(objectWrap.innerText);

      // Nếu bình luận ĐÃ có "Xem X câu trả lời" => đã có phản hồi, bỏ qua!
      if (/xem\s+\d+\s+câu trả lời|view\s+\d+\s+repl|ẩn câu trả lời|hide repl/i.test(fullBlockText)) {
        continue;
      }

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

    const startWaitVideos = Date.now();
    let lastVidSec = -1;
    const videoRows = await waitFor(() => {
      const sec = Math.floor((Date.now() - startWaitVideos) / 1000);
      if (sec !== lastVidSec && sec >= 2) {
        lastVidSec = sec;
        StatusOverlay.update('busy', `Đang chờ tải danh sách video Bình luận... (${sec}s)`);
      }
      const items = getCommentVideoRows(targetVideos);
      return items.length > 0 ? items : null;
    }, 25000);

    if (!videoRows || videoRows.length === 0) {
      StatusOverlay.update('error', 'Bình luận: Trang tải quá chậm (>25s), chưa thấy danh sách video');
      await logStep('comment', 'System', 'Quét tab Bình luận', '', 'Quá 25s chưa thấy danh sách video', 'error');
      return { scanned: 0, replied: 0, stoppedForDraft: false };
    }
    await sleep(600);

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

      // Chờ iframe video đổi src và tải xong (tối đa 15s)
      await waitFor(() => {
        const doc = getVideoDoc();
        const curSrc = getVideoIframe()?.src || '';
        return doc && doc.readyState === 'complete' && (vIdx === 0 || curSrc !== prevSrc) ? doc : null;
      }, 15000);
      await sleep(1600);

      const videoDoc = getVideoDoc();
      if (!videoDoc) continue;

      // Chờ danh sách bình luận trong iframe render (tối đa 12s) rồi mới cuộn chậm xuống hết
      await waitFor(
        () =>
          ns.adaptive.findCommentReplyButtons(videoDoc).length > 0 ||
          /0 bình luận|0 comments|hãy là người đầu tiên|be the first to comment/i.test(videoDoc.body?.innerText || ''),
        12000
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
      messageRequestsFolderFound: Boolean(ns.adaptive.findMessageRequestsEntry(msgDoc)),
      conversationsFound: convRows.length,
      conversationsPreview: convRows.map((r) => normalizeText(r.innerText).slice(0, 40)),
      activeChatCustomer: chatData.customerName,
      lastMessage: chatData.messages[chatData.messages.length - 1] || null,
      videoRowsFound: videoRows.length,
      videoIframeReady: Boolean(videoDoc),
      unrepliedCommentsOnScreen: cmtData.comments.map((c) => ({
        author: c.author,
        text: c.commentText
      })),
      adaptiveStrategies: ns.adaptive.getAdaptiveReport()
    };
  }

  ns.businessSuite = {
    isBusinessSuitePage,
    scanBusinessMessages,
    scanBusinessComments,
    diagnoseBusinessSuite
  };
})(window.TTAR);
