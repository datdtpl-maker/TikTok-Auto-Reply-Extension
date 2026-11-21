// background.js - Service Worker: Gemini API client, Storage, Dedupe & Audit Logs

const STORAGE_KEYS = {
  SETTINGS: 'tt_ar_settings',
  LOGS: 'tt_ar_logs',
  PROCESSED: 'tt_ar_processed',
  STATS: 'tt_ar_stats',
  SCHEDULE: 'tt_ar_schedule'
};

const DEFAULT_SETTINGS = {
  enabled: false,
  enableMessages: true,
  enableBusinessComments: true,
  enableActivityComments: true,
  autoReloadBeforeScan: true,
  draftOnly: false,
  scanIntervalSec: 20,
  messageScanIntervalSec: 20,
  commentScanIntervalSec: 60,
  messageScanCount: 10,
  commentVideoCount: 5,
  maxRepliesPerMinute: 15,
  apiKey: '',
  model: 'gemini-3.8-flash',
  customModel: '',
  temperature: 0.5,
  shopName: 'Khải Hoàn Skincare',
  knowledgeBase: '',
  messagePrompt:
    'Bạn là nhân viên CSKH chuyên nghiệp, thân thiện của Khải Hoàn Skincare. ' +
    'QUY TẮC BẮT BUỘC: Đọc kỹ lịch sử chat, video/dịch vụ khách gửi kèm (nếu có) và tin nhắn mới nhất của khách để trả lời BÁM SÁT ĐÚNG trọng tâm câu hỏi hoặc tình huống của khách. ' +
    'Nếu đã rõ khách hỏi về dịch vụ nào (ví dụ: triệt râu, triệt nách, peel da, trị mụn, trị sẹo lõm...), hãy nhắc đích danh dịch vụ đó trong câu trả lời, KHÔNG trả lời chung chung rập khuôn. ' +
    'Nếu khách chỉ phản hồi ngắn (như "ok", "cảm ơn"), hãy phản hồi tự nhiên, đúng mạch trò chuyện trước đó. ' +
    'Viết tiếng Việt tự nhiên, lịch sự, ngắn gọn (2-3 câu), xưng "em" và gọi "anh/chị" hoặc "bạn". Không dùng markdown (**, #, gạch đầu dòng).',
  commentPrompt:
    'Bạn là nhân viên CSKH thân thiện của Khải Hoàn Skincare trả lời bình luận trên video TikTok. ' +
    'QUY TẮC BẮT BUỘC: Bám sát ĐÚNG nội dung bình luận của khách VÀ chủ đề/nội dung của video đó. ' +
    'Nếu khách hỏi giá hoặc hỏi về dịch vụ trong video -> nhắc đúng tên dịch vụ trong video đó, giải đáp ngắn gọn và khéo léo mời khách nhắn tin (ib) để em báo giá/tư vấn chi tiết. ' +
    'Nếu khách bình luận khen, góp ý hoặc đùa vui (ví dụ "xịn nha shop", "hài nha") -> trả lời tương tác tự nhiên, duyên dáng đúng ý khách nói, KHÔNG ép mời mua hàng cứng nhắc. ' +
    'Trả lời cực kỳ ngắn gọn (1-2 câu), tiếng Việt tự nhiên, không dùng markdown.'
};

const MAX_LOGS = 150;
const MAX_PROCESSED = 1000;
const GEMINI_TIMEOUT_MS = 25000;

let recentReplyTimestamps = [];

async function getSettings() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  updateBadge(next.enabled);
  return next;
}

async function getStats() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.STATS);
  return {
    messagesReplied: 0,
    commentsReplied: 0,
    draftsCreated: 0,
    errors: 0,
    ...(res[STORAGE_KEYS.STATS] || {})
  };
}

async function incrementStat(field) {
  const stats = await getStats();
  stats[field] = (stats[field] || 0) + 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
  return stats;
}

async function appendLog(entry) {
  const res = await chrome.storage.local.get(STORAGE_KEYS.LOGS);
  const logs = Array.isArray(res[STORAGE_KEYS.LOGS]) ? res[STORAGE_KEYS.LOGS] : [];
  logs.unshift({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...entry
  });
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: logs });
}

async function isProcessed(fingerprint) {
  const res = await chrome.storage.local.get(STORAGE_KEYS.PROCESSED);
  const map = res[STORAGE_KEYS.PROCESSED] || {};
  const entry = map[fingerprint];
  // Chỉ coi là đã xử lý nếu thực sự đã GỬI (không khóa các bản nháp demo!)
  return Boolean(entry && !entry.draftOnly);
}

async function markProcessed(fingerprint, meta = {}) {
  const res = await chrome.storage.local.get(STORAGE_KEYS.PROCESSED);
  const map = res[STORAGE_KEYS.PROCESSED] || {};
  map[fingerprint] = { ts: Date.now(), ...meta };

  const keys = Object.keys(map);
  if (keys.length > MAX_PROCESSED) {
    keys
      .sort((a, b) => (map[a]?.ts || 0) - (map[b]?.ts || 0))
      .slice(0, keys.length - MAX_PROCESSED)
      .forEach((k) => delete map[k]);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.PROCESSED]: map });
}

async function clearProcessed() {
  await chrome.storage.local.set({ [STORAGE_KEYS.PROCESSED]: {} });
}

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#10b981' : '#64748b' });
}

function checkRateLimit(maxPerMinute) {
  const now = Date.now();
  recentReplyTimestamps = recentReplyTimestamps.filter((t) => now - t < 60000);
  if (recentReplyTimestamps.length >= maxPerMinute) {
    return false;
  }
  recentReplyTimestamps.push(now);
  return true;
}

function sanitizeReplyForTikTok(text) {
  return String(text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiApi({ apiKey, model, systemInstruction, userContent, temperature = 0.5 }) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Chưa nhập Gemini API Key trong mục Cấu hình Gemini AI.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  const body = {
    system_instruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userContent }]
      }
    ],
    generationConfig: {
      temperature: Number(temperature) || 0.5,
      maxOutputTokens: 1024
    }
  };

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const msg = data?.error?.message || `HTTP ${response.status}`;
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const backoff = 1200 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
          await sleep(backoff);
          lastError = new Error(`Gemini API ${response.status}: ${msg}`);
          continue;
        }
        throw new Error(`Gemini API lỗi (${response.status}): ${msg}`);
      }

      const rawText =
        data?.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought && typeof p.text === 'string')
          .map((p) => p.text)
          .join('')
          .trim() || '';

      if (!rawText) {
        const blockReason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
        throw new Error(`Gemini không trả về nội dung (${blockReason || 'empty'}).`);
      }

      return sanitizeReplyForTikTok(rawText);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < 2 && (err.name === 'AbortError' || String(err.message).includes('Failed to fetch'))) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('Gemini API thất bại sau 3 lần thử.');
}

const VIETNAMESE_STRICT_RULE =
  'QUY TẮC NGÔN NGỮ BẮT BUỘC (KHÔNG ĐƯỢC VI PHẠM): ' +
  '100% câu trả lời PHẢI viết bằng tiếng Việt có dấu tự nhiên. ' +
  'TUYỆT ĐỐI KHÔNG trả lời bằng tiếng Anh, tiếng Trung, tiếng Hàn, tiếng Nhật hay bất kỳ ngôn ngữ nào khác.';

const ENGLISH_STRICT_RULE =
  'STRICT LANGUAGE RULE (MANDATORY): ' +
  'The customer is writing in English. You MUST reply 100% in natural, polite, friendly English (concise 2-3 sentences for messages, 1-2 sentences for comments, no markdown). ' +
  'Translate any matching service names/prices from the internal spa knowledge base accurately into English without inventing prices.';

function isCustomerEnglish(text) {
  const str = String(text || '').trim();
  if (!str) return false;
  // Có dấu tiếng Việt => chắc chắn là tiếng Việt
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(str)) {
    return false;
  }
  // Có từ khóa tiếng Việt không dấu phổ biến => tiếng Việt
  if (
    /\b(xin gia|gia sao|bao nhieu|shop oi|ben minh|tu van|triet|nan mun|tham nach|da mun|cam on|khong|duoc khong|o dau|dia chi|lieu trinh|buoi le)\b/i.test(
      str
    )
  ) {
    return false;
  }
  // Có cấu trúc / từ vựng tiếng Anh rõ ràng
  const englishMatches = str.match(
    /\b(hi|hello|hey|can you|could you|how much|what is|what are|where|price|cost|service|services|product|products|treatment|treatments|skin|skincare|acne|please|thank|thanks|tell me|more about|book|appointment|open|hours|address|location|available|do you|i have|i want|interested|help)\b/gi
  );
  return Boolean(englishMatches && englishMatches.length >= 2);
}

function detectTargetLanguage(payload) {
  if (isCustomerEnglish(payload?.latestText)) {
    return 'en';
  }
  return 'vi';
}

function buildSystemInstruction(settings, type, targetLang = 'vi') {
  const basePrompt = type === 'message' ? settings.messagePrompt : settings.commentPrompt;
  const kb = String(settings.knowledgeBase || '').trim();
  const langRule = targetLang === 'en' ? ENGLISH_STRICT_RULE : VIETNAMESE_STRICT_RULE;

  const sections = [langRule, basePrompt];

  if (kb) {
    sections.push(
      '=== TÀI LIỆU NỘI BỘ SPA (GÓI DỊCH VỤ & BẢNG GIÁ CHÍNH THỨC) ===\n' +
        kb +
        '\n=== QUY TẮC SỬ DỤNG TÀI LIỆU NỘI BỘ ===\n' +
        '- Đối chiếu tin nhắn/bình luận của khách và nội dung video với TÀI LIỆU NỘI BỘ ở trên.\n' +
        '- Nếu khách hỏi đúng dịch vụ có trong tài liệu nội bộ: tư vấn và báo CHÍNH XÁC tên gói, giá tiền, liệu trình theo đúng tài liệu (tuyệt đối không tự bịa giá hoặc sai số).\n' +
        '- Nếu khách hỏi nội dung/dịch vụ KHÔNG có trong tài liệu nội bộ: áp dụng lối văn tư vấn mặc định ở trên.'
    );
  }

  return sections.filter(Boolean).join('\n\n');
}

function isLikelyNonVietnamese(text) {
  const str = String(text || '').trim();
  if (!str) return false;
  // Chặn ký tự Trung / Nhật / Hàn / Thái / Cyrillic / Ả Rập
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f\u0400-\u04ff\u0600-\u06ff]/.test(str)) {
    return true;
  }
  // Nếu câu dài >= 20 ký tự nhưng không có bất kỳ ký tự tiếng Việt có dấu nào -> nghi ngờ trả lời tiếng Anh/ngoại ngữ
  const hasVietnameseDiacritics = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
    str
  );
  if (str.length >= 20 && !hasVietnameseDiacritics) {
    return true;
  }
  // Chặn các cụm câu trả lời tiếng Anh phổ biến
  if (/\b(hello|hi there|thank you|please|price|inbox us|message us|contact us|available|service)\b/i.test(str)) {
    return true;
  }
  return false;
}

function buildUserPrompt(payload) {
  if (payload.type === 'message') {
    const historyLines = (payload.history || [])
      .slice(-12)
      .map((m) => `[${m.sender === 'shop' ? 'Shop' : 'Khách'}]: ${m.text}`)
      .join('\n');

    return [
      `Khách hàng: ${payload.customerName || 'Khách'}`,
      payload.sharedVideoContext
        ? `Video / Nội dung đính kèm trong cuộc trò chuyện: ${payload.sharedVideoContext}`
        : '',
      historyLines ? `Lịch sử tin nhắn gần nhất:\n${historyLines}` : '',
      `Tin nhắn mới nhất của khách cần trả lời:\n"${payload.latestText}"`,
      'Hãy trả lời BÁM SÁT ĐÚNG nội dung khách vừa nhắn và ngữ cảnh cuộc trò chuyện trên. Chỉ xuất đúng nội dung tin nhắn gửi cho khách (không thêm lời giải thích).'
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  return [
    `Nội dung / Tiêu đề video TikTok: "${payload.videoCaption || '(Không rõ tiêu đề video)'}"`,
    `Người bình luận: ${payload.customerName || 'Khách'}`,
    `Nội dung khách bình luận:\n"${payload.latestText}"`,
    'Hãy trả lời BÁM SÁT ĐÚNG nội dung khách bình luận kết hợp với chủ đề video trên. Chỉ xuất đúng câu trả lời ngắn gọn (không thêm lời giải thích).'
  ].join('\n\n');
}

async function handleGenerateReply(payload) {
  const settings = await getSettings();

  if (payload.fingerprint && (await isProcessed(payload.fingerprint))) {
    return { ok: false, skipped: true, reason: 'duplicate' };
  }

  if (!checkRateLimit(settings.maxRepliesPerMinute || 6)) {
    return { ok: false, skipped: true, reason: 'rate_limited' };
  }

  const activeModel =
    settings.model === 'custom' && settings.customModel.trim()
      ? settings.customModel.trim()
      : settings.model || 'gemini-3.8-flash';

  const targetLang = detectTargetLanguage(payload);
  const systemInstruction = buildSystemInstruction(settings, payload.type, targetLang);
  const userContent = buildUserPrompt(payload);

  try {
    let replyText = await callGeminiApi({
      apiKey: settings.apiKey,
      model: activeModel,
      systemInstruction,
      userContent,
      temperature: settings.temperature
    });

    // Lớp bảo vệ tầng 2:
    // - Nếu khách nhắn tiếng Việt (hoặc ngôn ngữ khác không phải tiếng Anh) -> ép 100% tiếng Việt có dấu
    // - Nếu khách nhắn tiếng Anh -> cho phép trả lời tiếng Anh tự nhiên (chỉ chặn ký tự CJK/Thái/Nga)
    if (targetLang === 'vi' && isLikelyNonVietnamese(replyText)) {
      replyText = await callGeminiApi({
        apiKey: settings.apiKey,
        model: activeModel,
        systemInstruction:
          VIETNAMESE_STRICT_RULE +
          ' Giữ nguyên thông tin giá/dịch vụ, không dùng markdown, chỉ xuất đúng câu trả lời tiếng Việt.',
        userContent: `Hãy chuyển toàn bộ câu trả lời sau sang tiếng Việt có dấu tự nhiên, lịch sự theo phong cách CSKH spa:\n"${replyText}"`,
        temperature: 0.2
      });
    } else if (
      targetLang === 'en' &&
      /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/i.test(
        replyText
      )
    ) {
      replyText = await callGeminiApi({
        apiKey: settings.apiKey,
        model: activeModel,
        systemInstruction:
          ENGLISH_STRICT_RULE + ' Keep exact service/price details, no markdown, output only the reply.',
        userContent: `Rewrite this spa customer reply cleanly in natural polite English:\n"${replyText}"`,
        temperature: 0.2
      });
    }

    await appendLog({
      level: 'info',
      type: payload.type,
      source: payload.source || payload.type,
      customer: payload.customerName || 'Khách',
      incoming: payload.latestText,
      reply: replyText,
      draftOnly: settings.draftOnly
    });

    return { ok: true, replyText, draftOnly: settings.draftOnly };
  } catch (err) {
    await incrementStat('errors');
    await appendLog({
      level: 'error',
      type: payload.type,
      source: payload.source || payload.type,
      customer: payload.customerName || 'Khách',
      incoming: payload.latestText,
      error: err.message
    });
    return { ok: false, error: err.message };
  }
}

async function handleTestApi({ apiKey, model }) {
  const text = await callGeminiApi({
    apiKey,
    model: model || 'gemini-3.8-flash',
    systemInstruction: 'Trả lời cực ngắn bằng tiếng Việt.',
    userContent: 'Xin chào, hãy phản hồi đúng 1 câu xác nhận kết nối thành công.',
    temperature: 0.2
  });
  return { ok: true, sampleReply: text };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await getSettings();
  if (!settings.model || settings.model === 'gemini-2.5-flash') {
    settings.model = 'gemini-3.8-flash';
  }
  // Cập nhật prompt mới nếu người dùng vẫn đang dùng bản prompt mặc định cũ
  if (settings.messagePrompt?.includes('Nếu khách hỏi giá hoặc dịch vụ chưa có trong thông tin')) {
    settings.messagePrompt = DEFAULT_SETTINGS.messagePrompt;
  }
  if (settings.commentPrompt?.includes('Giải đáp nhanh thắc mắc của khách dựa trên nội dung video và khéo léo')) {
    settings.commentPrompt = DEFAULT_SETTINGS.commentPrompt;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  updateBadge(settings.enabled);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  updateBadge(settings.enabled);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.action) {
        case 'GET_STATE': {
          const [settings, stats, logsRes, schedRes] = await Promise.all([
            getSettings(),
            getStats(),
            chrome.storage.local.get(STORAGE_KEYS.LOGS),
            chrome.storage.local.get(STORAGE_KEYS.SCHEDULE)
          ]);
          sendResponse({
            ok: true,
            settings,
            stats,
            logs: logsRes[STORAGE_KEYS.LOGS] || [],
            schedule: schedRes[STORAGE_KEYS.SCHEDULE] || {
              lastMsgScanAt: 0,
              lastCmtScanAt: 0,
              activeLane: null
            }
          });
          break;
        }
        case 'UPDATE_SCHEDULE': {
          const curRes = await chrome.storage.local.get(STORAGE_KEYS.SCHEDULE);
          const nextSched = {
            lastMsgScanAt: 0,
            lastCmtScanAt: 0,
            activeLane: null,
            ...(curRes[STORAGE_KEYS.SCHEDULE] || {}),
            ...(message.payload || {})
          };
          await chrome.storage.local.set({ [STORAGE_KEYS.SCHEDULE]: nextSched });
          sendResponse({ ok: true, schedule: nextSched });
          break;
        }
        case 'SAVE_SETTINGS': {
          const settings = await saveSettings(message.payload || {});
          // Broadcast updated settings to all TikTok tabs
          const tabs = await chrome.tabs.query({ url: ['https://www.tiktok.com/*', 'https://tiktok.com/*'] });
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', settings }).catch(() => {});
            }
          }
          sendResponse({ ok: true, settings });
          break;
        }
        case 'TEST_GEMINI_API': {
          const res = await handleTestApi(message.payload || {});
          sendResponse(res);
          break;
        }
        case 'CHECK_PROCESSED': {
          const processed = await isProcessed(message.fingerprint);
          sendResponse({ ok: true, processed });
          break;
        }
        case 'GENERATE_REPLY': {
          const res = await handleGenerateReply(message.payload || {});
          sendResponse(res);
          break;
        }
        case 'MARK_SENT': {
          const { fingerprint, type, draftOnly, customer, incoming, reply } = message.payload || {};
          // Chỉ lưu chống trùng vĩnh viễn khi đã GỬI THẬT (draftOnly === false)
          if (fingerprint && !draftOnly) {
            await markProcessed(fingerprint, { type, draftOnly: false });
          }
          if (draftOnly) {
            await incrementStat('draftsCreated');
          } else if (type === 'message') {
            await incrementStat('messagesReplied');
          } else {
            await incrementStat('commentsReplied');
          }
          await appendLog({
            level: 'success',
            type,
            source: draftOnly ? 'draft_filled' : 'sent',
            customer: customer || 'Khách',
            incoming: incoming || '',
            reply: reply || ''
          });
          sendResponse({ ok: true });
          break;
        }
        case 'LOG_EVENT': {
          await appendLog(message.payload || { level: 'info', incoming: 'Event' });
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_LOGS': {
          await chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: [] });
          sendResponse({ ok: true });
          break;
        }
        case 'CLEAR_PROCESSED': {
          await clearProcessed();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // keep channel open for async response
});
