// background.js - Service Worker: Gemini API client, Storage, Dedupe & Audit Logs

const BUSINESS_SUITE_URL = 'https://www.tiktok.com/business-suite/messages';

const STORAGE_KEYS = {
  SETTINGS: 'tt_ar_settings',
  LOGS: 'tt_ar_logs',
  PROCESSED: 'tt_ar_processed',
  STATS: 'tt_ar_stats',
  SCHEDULE: 'tt_ar_schedule',
  MEMORY: 'tt_ar_memory',
  BOT_REPLIES: 'tt_ar_bot_replies'
};

const DEFAULT_SETTINGS = {
  enabled: false,
  enableMessages: true,
  enableMessageRequests: true,
  enableBusinessComments: true,
  enableActivityComments: true,
  enableSelfLearning: true,
  autoReloadBeforeScan: true,
  draftOnly: false,
  scanIntervalSec: 20,
  messageScanIntervalSec: 20,
  commentScanIntervalSec: 60,
  messageScanCount: 10,
  messageRequestScanCount: 5,
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
const MAX_MEMORY_ITEMS = 200;
const MAX_BOT_REPLY_HASHES = 500;
const GEMINI_TIMEOUT_MS = 25000;

// === SELF-LEARNING FEW-SHOT MEMORY ENGINE ===
function normalizeVietnameseForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VI_STOPWORDS = new Set([
  'la', 'va', 'cua', 'cho', 'voi', 'khong', 'co', 'duoc', 'nha', 'nhe', 'a', 'oi', 'em', 'anh', 'chi', 'ban', 'shop', 'ben', 'minh', 'tu', 'thi', 'ma', 'da', 'se', 'dang', 'mot', 'cac', 'nay', 'do', 'gi'
]);

function extractSearchTokens(text) {
  const norm = normalizeVietnameseForMatch(text);
  if (!norm) return new Set();
  const words = norm.split(' ').filter((w) => w.length >= 2 && !VI_STOPWORDS.has(w));
  const tokens = new Set(words);
  for (let i = 0; i < words.length - 1; i++) {
    tokens.add(`${words[i]}_${words[i + 1]}`);
  }
  return tokens;
}

function memoryKey(type, question, answer) {
  const q = normalizeVietnameseForMatch(question).slice(0, 120);
  const a = normalizeVietnameseForMatch(answer).slice(0, 120);
  return `${type}|${q}|${a}`;
}

async function getMemoryItems() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.MEMORY);
  return Array.isArray(res[STORAGE_KEYS.MEMORY]) ? res[STORAGE_KEYS.MEMORY] : [];
}

async function saveMemoryItems(items) {
  const trimmed = items.slice(0, MAX_MEMORY_ITEMS);
  await chrome.storage.local.set({ [STORAGE_KEYS.MEMORY]: trimmed });
  return trimmed;
}

async function getBotReplySet() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.BOT_REPLIES);
  return new Set(Array.isArray(res[STORAGE_KEYS.BOT_REPLIES]) ? res[STORAGE_KEYS.BOT_REPLIES] : []);
}

async function recordBotReplyText(replyText) {
  const norm = normalizeVietnameseForMatch(replyText).slice(0, 160);
  if (!norm) return;
  const res = await chrome.storage.local.get(STORAGE_KEYS.BOT_REPLIES);
  const list = Array.isArray(res[STORAGE_KEYS.BOT_REPLIES]) ? res[STORAGE_KEYS.BOT_REPLIES] : [];
  if (!list.includes(norm)) {
    list.unshift(norm);
    if (list.length > MAX_BOT_REPLY_HASHES) list.length = MAX_BOT_REPLY_HASHES;
    await chrome.storage.local.set({ [STORAGE_KEYS.BOT_REPLIES]: list });
  }
}

function isUsefulLearningPair(question, answer) {
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (q.length < 3 || a.length < 10) return false;
  if (q.length > 400 || a.length > 600) return false;
  const aNorm = normalizeVietnameseForMatch(a);
  if (/^(ok|oke|vang|da|cam on|thanks|hi|hello|\.+)$/.test(aNorm)) return false;
  // Chặn tuyệt đối không học lại địa chỉ nhầm của nhà thuốc (A30 Võ Văn Kiệt)
  if (aNorm.includes('vo van kiet') || aNorm.includes('a30')) return false;
  return true;
}

async function addMemoryPair({ type = 'message', question, answer, context = '', source = 'human_shop' }) {
  if (!isUsefulLearningPair(question, answer)) return { added: false };
  const items = await getMemoryItems();
  const key = memoryKey(type, question, answer);
  const existingIdx = items.findIndex((it) => it.key === key);
  const weight = source === 'manual' ? 2.5 : source === 'human_shop' ? 2.0 : 1.0;

  if (existingIdx >= 0) {
    // Upgrade source priority if human/manual confirmed it
    if (weight > (items[existingIdx].weight || 1)) {
      items[existingIdx].source = source;
      items[existingIdx].weight = weight;
      items[existingIdx].updatedAt = new Date().toISOString();
      await saveMemoryItems(items);
    }
    return { added: false, duplicate: true };
  }

  const entry = {
    id: crypto.randomUUID(),
    key,
    type,
    question: String(question).trim(),
    answer: String(answer).trim(),
    context: String(context || '').trim().slice(0, 160),
    source,
    weight,
    createdAt: new Date().toISOString(),
    usedCount: 0
  };
  items.unshift(entry);
  await saveMemoryItems(items);
  return { added: true, entry };
}

async function learnFromConversationHistory({ type = 'message', history = [], context = '' }) {
  const settings = await getSettings();
  if (settings.enableSelfLearning === false) return { learned: 0 };
  if (!Array.isArray(history) || history.length < 2) return { learned: 0 };

  const botReplySet = await getBotReplySet();
  let learned = 0;

  // Group consecutive customer messages followed by consecutive shop messages
  let i = 0;
  while (i < history.length) {
    if (history[i]?.sender !== 'customer') {
      i++;
      continue;
    }
    const custParts = [];
    while (i < history.length && history[i]?.sender === 'customer') {
      if (history[i].text) custParts.push(history[i].text.trim());
      i++;
    }
    const shopParts = [];
    while (i < history.length && history[i]?.sender === 'shop') {
      if (history[i].text) shopParts.push(history[i].text.trim());
      i++;
    }
    if (!custParts.length || !shopParts.length) continue;

    const question = custParts.join(' ');
    const answer = shopParts.join(' ');
    const answerNorm = normalizeVietnameseForMatch(answer).slice(0, 160);
    // Prioritize learning when a human agent replied (not our own bot)
    const isBot = botReplySet.has(answerNorm);
    const res = await addMemoryPair({
      type,
      question,
      answer,
      context,
      source: isBot ? 'bot_sent' : 'human_shop'
    });
    if (res.added) learned++;
  }

  return { learned };
}

async function retrieveRelevantMemories(type, queryText, contextText = '', limit = 4) {
  const items = await getMemoryItems();
  if (!items.length) return [];

  const queryTokens = extractSearchTokens(`${queryText || ''} ${contextText || ''}`);
  if (queryTokens.size === 0) return [];

  const scored = [];
  for (const item of items) {
    if (item.type && item.type !== type) continue;
    const itemTokens = extractSearchTokens(`${item.question} ${item.context || ''}`);
    if (itemTokens.size === 0) continue;

    let overlap = 0;
    for (const tok of queryTokens) {
      if (itemTokens.has(tok)) {
        // Bigrams (containing '_') get double weight for precision
        overlap += tok.includes('_') ? 2.0 : 1.0;
      }
    }
    if (overlap <= 0) continue;

    const denom = Math.sqrt(queryTokens.size * itemTokens.size);
    const similarity = overlap / Math.max(1, denom);
    const sourceBoost = item.source === 'manual' ? 1.35 : item.source === 'human_shop' ? 1.2 : 0.85;
    const score = similarity * sourceBoost;

    if (score >= 0.18) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

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

const COMMENT_DEDUPE_TTL_MS = 15 * 60 * 1000; // 15 phút (DOM TikTok đã tự kiểm tra phản hồi thật)

async function isProcessed(fingerprint) {
  const res = await chrome.storage.local.get(STORAGE_KEYS.PROCESSED);
  const map = res[STORAGE_KEYS.PROCESSED] || {};
  const entry = map[fingerprint];
  // Chỉ coi là đã xử lý nếu thực sự đã GỬI (không khóa các bản nháp demo!)
  if (!entry || entry.draftOnly) return false;
  // Với bình luận: nếu đã quá 15 phút và DOM thật không còn thấy phản hồi của shop (do chủ shop đã xóa) -> cho phép trả lời lại
  if (entry.type === 'comment' && entry.ts && Date.now() - entry.ts > COMMENT_DEDUPE_TTL_MS) {
    return false;
  }
  return true;
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

function sanitizeReplyForTikTok(text, type = 'message') {
  let out = String(text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (type === 'comment') {
    // CHÍNH SÁCH TIKTOK CHO BÌNH LUẬN: tuyệt đối cấm SĐT, hotline, Zalo, zl, link ngoài
    out = out
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\b(?:www\.)?[a-z0-9-]+\.(?:com|vn|net|org|gl|me)\S*/gi, '')
      .replace(/(?:\+?84|0)(?:[\s.\-]*\d){8,10}\b/g, '')
      .replace(/\b(?:hotline|zalo|zl|sđt|sdt)\b/gi, '')
      .replace(/số\s*điện\s*thoại/gi, '')
      .replace(/\s*\/\s*(?=[\s.,!?]|$)/g, ' ')
      .replace(/(?:hoặc\s+)?(?:liên hệ|gọi|nhắn)\s+(?:qua\s+)?(?:để\s+|nha|nhé|ạ|[.,!?]|$)/gi, 'nhắn tin trực tiếp cho em ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?])/g, '$1')
      .trim();
  } else {
    // CHÍNH SÁCH TIKTOK CHO TIN NHẮN: thay toàn bộ hotline / Zalo / sđt / số điện thoại bằng "zl"
    out = out
      .replace(/\b(?:hotline|sđt|sdt|số\s*điện\s*thoại)\s*[/\-&]\s*(?:zalo|zl)\b/gi, 'zl')
      .replace(/\b(?:zalo|zl)\s*[/\-&]\s*(?:hotline|sđt|sdt|số\s*điện\s*thoại)\b/gi, 'zl')
      .replace(/\b(?:hotline|zalo|sđt|sdt)\b/gi, 'zl')
      .replace(/số\s*điện\s*thoại/gi, 'zl')
      .replace(/\bzl(?:\s*[/\-]?\s*zl)+\b/gi, 'zl')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?])/g, '$1')
      .trim();
  }

  return out;
}

function hasCommentPolicyViolation(text) {
  const str = String(text || '');
  return (
    /https?:\/\/|\b(?:hotline|zalo|zl|sđt|sdt)\b|số\s*điện\s*thoại|(?:\+?84|0)(?:[\s.\-]*\d){8,10}\b/i.test(str)
  );
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

const OFFICIAL_CLINIC_SERVICES =
  '- 8 nhóm dịch vụ chuẩn y khoa:\n' +
  '  1. Lấy Mụn Y Khoa (lấy nhân mụn chuẩn kỹ thuật, làm sạch & phục hồi, hạn chế thâm sẹo)\n' +
  '  2. Chăm Sóc & Phục Hồi Da (làm sạch sâu, thanh lọc, củng cố hàng rào bảo vệ da, phục hồi da yếu/sau treatment)\n' +
  '  3. Premium Skin Therapy (chăm sóc da cao cấp kết hợp dưỡng chất & công nghệ hiện đại)\n' +
  '  4. Meso Remee (liệu trình cá nhân hóa giúp phục hồi, làm sáng, trẻ hóa da)\n' +
  '  5. Nâng Cơ, Xóa Nhăn (cải thiện độ săn chắc, đàn hồi, định hình đường nét da)\n' +
  '  6. Peel Da (thay mới bề mặt da, hỗ trợ cải thiện mụn, thâm, sạm)\n' +
  '  7. Sẹo Rỗ Đa Phương Thức (phác đồ phối hợp chuyên sâu tùy loại sẹo và độ sâu)\n' +
  '  8. Triệt Lông IPL (công nghệ ánh sáng IPL)';

const OFFICIAL_CLINIC_INFO_COMMENT =
  '=== THÔNG TIN CHÍNH THỨC KHẢI HOÀN SKINCARE PHAN THIẾT (DÙNG CHO BÌNH LUẬN TIKTOK) ===\n' +
  '- Tên cơ sở: Khải Hoàn Skincare - Chăm sóc da chuẩn y khoa Phan Thiết\n' +
  '- Địa chỉ duy nhất: Số 01 Vạn Thủy Tú, Phường Đức Thắng, TP. Phan Thiết, Tỉnh Bình Thuận\n' +
  '- Giờ mở cửa: 07:30 – 20:00 (Thứ 2 – Chủ Nhật)\n' +
  OFFICIAL_CLINIC_SERVICES + '\n' +
  '=== QUY TẮC BẮT BUỘC CHỐNG VI PHẠM CHÍNH SÁCH TIKTOK Ở BÌNH LUẬN ===\n' +
  '- TUYỆT ĐỐI CẤM viết số điện thoại, link web/bản đồ, hoặc các từ "hotline", "sđt", "số điện thoại", "Zalo", "zl", "Facebook" trong bình luận (vì TikTok quét vi phạm chính sách).\n' +
  '- Khi khách hỏi địa chỉ: CHỈ trả lời đúng địa chỉ "Số 01 Vạn Thủy Tú, Phường Đức Thắng, TP. Phan Thiết" và mời khách nhắn tin (ib) trên TikTok nếu cần gửi định vị hoặc đặt lịch.\n' +
  '- TUYỆT ĐỐI KHÔNG nhắc nhầm địa chỉ nhà thuốc khác (CẤM nhắc "A30 Võ Văn Kiệt").\n' +
  '- TUYỆT ĐỐI KHÔNG tự ý báo giá tiền; nếu khách hỏi giá thì mời khách nhắn tin (ib) để em tư vấn theo tình trạng da.';

const OFFICIAL_CLINIC_INFO_MESSAGE =
  '=== THÔNG TIN CHÍNH THỨC KHẢI HOÀN SKINCARE PHAN THIẾT (DÙNG CHO CUỘC HỘI THOẠI / TIN NHẮN) ===\n' +
  '- Tên cơ sở: Khải Hoàn Skincare - Chăm sóc da chuẩn y khoa Phan Thiết\n' +
  '- Địa chỉ duy nhất: Số 01 Vạn Thủy Tú, Phường Đức Thắng, TP. Phan Thiết, Tỉnh Bình Thuận\n' +
  '- Link bản đồ Google Maps (chỉ gửi khi khách hỏi đường/định vị): https://maps.app.goo.gl/j8VVAyXaEUeU1uS56\n' +
  '- Kênh liên hệ đặt lịch (CHỈ dùng từ "zl", KHÔNG viết hotline/sđt/Zalo): zl 0964 787 144\n' +
  '- Giờ mở cửa: 07:30 – 20:00 (Thứ 2 – Chủ Nhật)\n' +
  OFFICIAL_CLINIC_SERVICES + '\n' +
  '=== QUY TẮC BẮT BUỘC VỀ ĐỊA CHỈ, CHÍNH SÁCH TIKTOK & GIÁ DỊCH VỤ ===\n' +
  '- Khi khách hỏi địa chỉ / đường đi / giờ mở cửa: CHỈ trả lời đúng địa chỉ "Số 01 Vạn Thủy Tú, Phường Đức Thắng, TP. Phan Thiết, Tỉnh Bình Thuận". TUYỆT ĐỐI KHÔNG nhắc nhầm địa chỉ nhà thuốc khác (CẤM nhắc "A30 Võ Văn Kiệt").\n' +
  '- CHÍNH SÁCH TIKTOK TRONG TIN NHẮN: TUYỆT ĐỐI KHÔNG viết các từ "hotline", "sđt", "số điện thoại", "Zalo" — luôn thay bằng "zl" (ví dụ: "anh/chị nhắn qua zl 0964 787 144" hoặc "cho em xin zl của mình nhé").\n' +
  '- QUY TẮC CẤM BÁO GIÁ: TUYỆT ĐỐI KHÔNG tự ý báo giá tiền hay đưa ra con số giá cụ thể (trừ khi chủ shop tự ghi rõ bảng giá trong mục TÀI LIỆU NỘI BỘ BỔ SUNG bên dưới). Khi khách hỏi giá, hãy giải thích nhẹ nhàng chi phí tùy tình trạng da thực tế và ưu đãi hiện tại, mời khách mô tả tình trạng da hoặc nhắn qua zl 0964 787 144 / ghé Số 01 Vạn Thủy Tú để soi da và báo chi phí chính xác nhất.';

function buildSystemInstruction(settings, type, targetLang = 'vi', learnedExamples = []) {
  const basePrompt = type === 'message' ? settings.messagePrompt : settings.commentPrompt;
  const kb = String(settings.knowledgeBase || '').trim();
  const langRule = targetLang === 'en' ? ENGLISH_STRICT_RULE : VIETNAMESE_STRICT_RULE;
  const officialInfo = type === 'comment' ? OFFICIAL_CLINIC_INFO_COMMENT : OFFICIAL_CLINIC_INFO_MESSAGE;

  const sections = [langRule, basePrompt, officialInfo];

  if (kb) {
    sections.push(
      '=== TÀI LIỆU NỘI BỘ BỔ SUNG CỦA SHOP ===\n' +
        kb +
        '\n=== QUY TẮC SỬ DỤNG TÀI LIỆU NỘI BỘ BỔ SUNG ===\n' +
        '- Đối chiếu tin nhắn/bình luận của khách với TÀI LIỆU NỘI BỘ BỔ SUNG ở trên.\n' +
        '- Chỉ được báo giá cụ thể nếu dịch vụ đó có ghi rõ giá trong TÀI LIỆU NỘI BỘ BỔ SUNG này; nếu không có thì tuyệt đối không tự bịa hoặc tự báo giá.'
    );
  }

  if (Array.isArray(learnedExamples) && learnedExamples.length > 0) {
    const formatted = learnedExamples
      .map((ex, idx) => {
        const tag = ex.source === 'manual' ? 'Mẫu chuẩn' : ex.source === 'human_shop' ? 'Shop đã trả lời' : 'Lịch sử';
        return `${idx + 1}. [${tag}] Khách hỏi: "${ex.question}"\n   -> Shop trả lời: "${ex.answer}"`;
      })
      .join('\n');
    sections.push(
      '=== KINH NGHIỆM TRẢ LỜI THỰC TẾ CỦA SHOP (TỰ HỌC) ===\n' +
        formatted +
        '\nHãy học theo giọng văn tự nhiên, cách xưng hô và cách tư vấn từ các ví dụ thực tế tương tự ở trên. Tuyệt đối vẫn phải tuân thủ đúng địa chỉ Số 01 Vạn Thủy Tú và quy tắc không tự báo giá.'
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
  const learnedExamples =
    settings.enableSelfLearning !== false
      ? await retrieveRelevantMemories(
          payload.type,
          payload.latestText,
          payload.sharedVideoContext || payload.videoCaption || '',
          4
        )
      : [];
  const systemInstruction = buildSystemInstruction(settings, payload.type, targetLang, learnedExamples);
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

    // Lớp bảo vệ tầng 3: Chuẩn hóa chính sách TikTok (Cấm SĐT/hotline/Zalo/link ở bình luận; thay hotline/sđt/Zalo -> zl ở tin nhắn)
    if (payload.type === 'comment' && hasCommentPolicyViolation(replyText)) {
      replyText = await callGeminiApi({
        apiKey: settings.apiKey,
        model: activeModel,
        systemInstruction:
          (targetLang === 'en' ? ENGLISH_STRICT_RULE : VIETNAMESE_STRICT_RULE) +
          ' Viết lại câu trả lời bình luận TikTok thật tự nhiên, ngắn gọn 1-2 câu. TUYỆT ĐỐI xóa sạch số điện thoại, link, "hotline", "Zalo", "zl", "sđt", chỉ giữ địa chỉ Số 01 Vạn Thủy Tú (nếu khách hỏi địa chỉ) và mời khách nhắn tin (ib) trên TikTok.',
        userContent: `Viết lại bình luận sau cho sạch 100% chính sách TikTok (không SĐT, không hotline, không Zalo/zl, không link):\n"${replyText}"`,
        temperature: 0.2
      });
    }
    replyText = sanitizeReplyForTikTok(replyText, payload.type);

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
  // Dọn sạch các mẫu tự học cũ có chứa địa chỉ nhầm (A30 Võ Văn Kiệt) và chuẩn hóa hotline/Zalo/sđt -> zl
  const mem = await getMemoryItems();
  let memChanged = false;
  const cleanedMem = [];
  for (const item of mem) {
    const text = normalizeVietnameseForMatch(`${item.question || ''} ${item.answer || ''}`);
    if (text.includes('vo van kiet') || text.includes('a30')) {
      memChanged = true;
      continue;
    }
    const sanitizedAnswer = sanitizeReplyForTikTok(item.answer, item.type || 'message');
    if (sanitizedAnswer !== item.answer) {
      memChanged = true;
      cleanedMem.push({ ...item, answer: sanitizedAnswer });
    } else {
      cleanedMem.push(item);
    }
  }
  if (memChanged) {
    await saveMemoryItems(cleanedMem);
  }
  updateBadge(settings.enabled);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  updateBadge(settings.enabled);
});

async function ensureBusinessSuiteTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Nếu tab đang mở ĐÃ ở đúng /business-suite/messages rồi thì giữ nguyên
  if (activeTab?.id && /tiktok\.com\/business-suite\/messages\b/i.test(activeTab.url || '')) {
    return { tabId: activeTab.id, navigated: false };
  }

  // Nếu tab đang mở là BẤT KỲ trang nào khác của tiktok.com (trang chủ, hồ sơ, video, comments...) -> chuyển thẳng tab này sang URL mặc định
  if (activeTab?.id && /tiktok\.com/i.test(activeTab.url || '')) {
    await chrome.tabs.update(activeTab.id, { url: BUSINESS_SUITE_URL });
    return { tabId: activeTab.id, navigated: true };
  }

  // Nếu tab đang mở không phải TikTok -> ưu tiên chuyển sang tab /business-suite/messages có sẵn, không có thì mở tab mới
  const existingBsTabs = await chrome.tabs.query({
    currentWindow: true,
    url: ['https://www.tiktok.com/business-suite/messages*', 'https://tiktok.com/business-suite/messages*']
  });
  if (existingBsTabs.length > 0 && existingBsTabs[0].id) {
    await chrome.tabs.update(existingBsTabs[0].id, { active: true });
    return { tabId: existingBsTabs[0].id, navigated: false };
  }

  const created = await chrome.tabs.create({ url: BUSINESS_SUITE_URL, active: true });
  return { tabId: created.id, navigated: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.action) {
        case 'GET_STATE': {
          const [settings, stats, logsRes, schedRes, memory] = await Promise.all([
            getSettings(),
            getStats(),
            chrome.storage.local.get(STORAGE_KEYS.LOGS),
            chrome.storage.local.get(STORAGE_KEYS.SCHEDULE),
            getMemoryItems()
          ]);
          sendResponse({
            ok: true,
            settings,
            stats,
            logs: logsRes[STORAGE_KEYS.LOGS] || [],
            memoryCount: memory.length,
            memory: memory.slice(0, 30),
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
          const prev = await getSettings();
          const settings = await saveSettings(message.payload || {});
          const isEnabledNow = Boolean(settings.enabled);
          const justTurnedOn = !prev.enabled && isEnabledNow;

          let navigated = false;
          if (isEnabledNow && (justTurnedOn || message.forceNavigate)) {
            const navRes = await ensureBusinessSuiteTab();
            navigated = navRes.navigated;
            if (navigated) {
              await chrome.storage.local.set({
                [STORAGE_KEYS.SCHEDULE]: {
                  lastMsgScanAt: 0,
                  lastCmtScanAt: 0,
                  activeLane: null,
                  runOnNextLoad: true
                }
              });
            }
          }

          // Broadcast updated settings to all TikTok tabs
          const tabs = await chrome.tabs.query({ url: ['https://www.tiktok.com/*', 'https://tiktok.com/*'] });
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', settings }).catch(() => {});
            }
          }
          sendResponse({ ok: true, settings, navigated });
          break;
        }
        case 'ENSURE_BUSINESS_SUITE_TAB': {
          const navRes = await ensureBusinessSuiteTab();
          if (navRes.navigated) {
            await chrome.storage.local.set({
              [STORAGE_KEYS.SCHEDULE]: {
                lastMsgScanAt: 0,
                lastCmtScanAt: 0,
                activeLane: null,
                runOnNextLoad: true
              }
            });
          }
          sendResponse({ ok: true, ...navRes });
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
            if (reply) await recordBotReplyText(reply);
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
        case 'LEARN_FROM_HISTORY': {
          const res = await learnFromConversationHistory(message.payload || {});
          sendResponse({ ok: true, ...res });
          break;
        }
        case 'ADD_MEMORY_ITEM': {
          const res = await addMemoryPair({
            ...(message.payload || {}),
            source: 'manual'
          });
          sendResponse({ ok: true, ...res });
          break;
        }
        case 'DELETE_MEMORY_ITEM': {
          const id = message.payload?.id;
          const items = await getMemoryItems();
          const next = items.filter((item) => item.id !== id);
          await saveMemoryItems(next);
          sendResponse({ ok: true, remaining: next.length });
          break;
        }
        case 'CLEAR_MEMORY': {
          await saveMemoryItems([]);
          sendResponse({ ok: true });
          break;
        }
        case 'EXPORT_CONFIG': {
          const [settings, memory] = await Promise.all([getSettings(), getMemoryItems()]);
          sendResponse({
            ok: true,
            bundle: {
              schemaVersion: 1,
              exportedAt: new Date().toISOString(),
              settings,
              memory
            }
          });
          break;
        }
        case 'IMPORT_CONFIG': {
          const bundle = message.payload || {};
          if (bundle.settings && typeof bundle.settings === 'object') {
            await saveSettings(bundle.settings);
          }
          let importedMemoryCount = 0;
          if (Array.isArray(bundle.memory)) {
            const cleaned = bundle.memory.filter((it) => it && it.question && it.answer).slice(0, MAX_MEMORY_ITEMS);
            await saveMemoryItems(cleaned);
            importedMemoryCount = cleaned.length;
          }
          const nextSettings = await getSettings();
          const tabs = await chrome.tabs.query({ url: ['https://www.tiktok.com/*', 'https://tiktok.com/*'] });
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', settings: nextSettings }).catch(() => {});
            }
          }
          sendResponse({ ok: true, settings: nextSettings, importedMemoryCount });
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
