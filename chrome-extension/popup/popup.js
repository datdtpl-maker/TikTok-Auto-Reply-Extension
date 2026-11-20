// popup.js - Quản lý cấu hình, test Gemini API, test DOM và xem nhật ký

const $ = (id) => document.getElementById(id);

function showToast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.style.background = isError ? '#ef4444' : '#10b981';
  el.style.color = isError ? '#fff' : '#022c22';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2400);
}

function sendBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

async function sendActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'Không tìm thấy tab đang mở.' };
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: 'Tab hiện tại không phải TikTok hoặc cần tải lại (F5) trang TikTok.'
        });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

function renderLogs(logs) {
  const list = $('logsList');
  if (!logs || logs.length === 0) {
    list.innerHTML = '<div class="empty">Chưa có lịch sử hoạt động.</div>';
    return;
  }

  list.innerHTML = logs
    .map((item) => {
      const time = new Date(item.ts).toLocaleTimeString('vi-VN');
      const badge = item.type === 'message' ? 'Tin nhắn' : item.type === 'comment' ? 'Bình luận' : 'Hệ thống';
      return `
        <div class="log-item ${item.level || 'info'}">
          <div class="log-meta">
            <span>${badge} • ${escapeHtml(item.customer || 'Khách')}</span>
            <span>${time}</span>
          </div>
          ${item.incoming ? `<div class="log-in">Khách: ${escapeHtml(item.incoming)}</div>` : ''}
          ${item.reply ? `<div class="log-out">AI (${item.draftOnly ? 'Nháp' : 'Gửi'}): ${escapeHtml(item.reply)}</div>` : ''}
          ${item.error ? `<div class="log-err">Lỗi: ${escapeHtml(item.error)}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function collectFormSettings() {
  return {
    enabled: $('toggleEnabled').checked,
    enableMessages: $('enableMessages').checked,
    enableBusinessComments: $('enableBusinessComments').checked,
    enableActivityComments: $('enableActivityComments').checked,
    autoReloadBeforeScan: $('autoReloadBeforeScan').checked,
    draftOnly: $('draftOnly').checked,
    messageScanIntervalSec: Math.max(10, Number($('messageScanIntervalSec').value) || 20),
    commentScanIntervalSec: Math.max(15, Number($('commentScanIntervalSec').value) || 60),
    messageScanCount: Math.max(1, Math.min(20, Number($('messageScanCount').value) || 10)),
    commentVideoCount: Math.max(1, Math.min(15, Number($('commentVideoCount').value) || 5)),
    maxRepliesPerMinute: Math.max(1, Number($('maxRepliesPerMinute').value) || 15),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    customModel: $('customModel').value.trim(),
    messagePrompt: $('messagePrompt').value.trim(),
    commentPrompt: $('commentPrompt').value.trim()
  };
}

function syncCustomModelVisibility() {
  $('customModelWrap').classList.toggle('hidden', $('model').value !== 'custom');
}

async function loadState() {
  const res = await sendBg({ action: 'GET_STATE' });
  if (!res?.ok) return;

  const { settings, stats, logs } = res;
  $('toggleEnabled').checked = Boolean(settings.enabled);
  $('statusDot').classList.toggle('on', Boolean(settings.enabled));

  $('enableMessages').checked = Boolean(settings.enableMessages);
  $('enableBusinessComments').checked = Boolean(settings.enableBusinessComments);
  $('enableActivityComments').checked = Boolean(settings.enableActivityComments);
  $('autoReloadBeforeScan').checked = settings.autoReloadBeforeScan !== false;
  $('draftOnly').checked = Boolean(settings.draftOnly);
  $('messageScanIntervalSec').value = settings.messageScanIntervalSec || 20;
  $('commentScanIntervalSec').value = settings.commentScanIntervalSec || 60;
  $('messageScanCount').value = settings.messageScanCount || 10;
  $('commentVideoCount').value = settings.commentVideoCount || 5;
  $('maxRepliesPerMinute').value = settings.maxRepliesPerMinute || 15;

  $('apiKey').value = settings.apiKey || '';
  $('model').value = settings.model || 'gemini-3.8-flash';
  $('customModel').value = settings.customModel || '';
  $('messagePrompt').value = settings.messagePrompt || '';
  $('commentPrompt').value = settings.commentPrompt || '';
  syncCustomModelVisibility();

  $('statMsg').textContent = stats.messagesReplied || 0;
  $('statCmt').textContent = stats.commentsReplied || 0;
  $('statDraft').textContent = stats.draftsCreated || 0;
  $('statErr').textContent = stats.errors || 0;

  renderLogs(logs);
}

async function saveAll(silent = false) {
  const payload = collectFormSettings();
  const res = await sendBg({ action: 'SAVE_SETTINGS', payload });
  if (res?.ok) {
    $('statusDot').classList.toggle('on', Boolean(payload.enabled));
    if (!silent) showToast('Đã lưu cài đặt!');
  } else {
    showToast(res?.error || 'Lỗi lưu cài đặt', true);
  }
}

// Tab switching
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'logs') loadState();
  });
});

$('model').addEventListener('change', syncCustomModelVisibility);
$('toggleEnabled').addEventListener('change', () => saveAll(false));
$('btnSaveControl').addEventListener('click', () => saveAll(false));
$('btnSaveAi').addEventListener('click', () => saveAll(false));

$('btnTestApi').addEventListener('click', async () => {
  const box = $('apiTestResult');
  box.className = 'notice';
  box.textContent = 'Đang kiểm tra kết nối Gemini API...';
  box.classList.remove('hidden');

  const model =
    $('model').value === 'custom' && $('customModel').value.trim()
      ? $('customModel').value.trim()
      : $('model').value;

  const res = await sendBg({
    action: 'TEST_GEMINI_API',
    payload: { apiKey: $('apiKey').value.trim(), model }
  });

  if (res?.ok) {
    box.className = 'notice ok';
    box.textContent = `Kết nối thành công! Gemini trả lời: "${res.sampleReply}"`;
  } else {
    box.className = 'notice err';
    box.textContent = `Thất bại: ${res?.error || 'Không rõ lỗi'}`;
  }
});

$('btnScanNow').addEventListener('click', async () => {
  await saveAll(true);
  showToast('Đang chạy 1 vòng quét...');
  const res = await sendActiveTab({ action: 'RUN_SCAN_NOW' });
  if (res?.ok) {
    showToast('Quét xong! Kiểm tra Nhật ký.');
    loadState();
  } else {
    showToast(res?.error || res?.reason || 'Không quét được', true);
  }
});

$('btnDiagnose').addEventListener('click', async () => {
  const out = $('diagOutput');
  out.classList.remove('hidden');
  out.textContent = 'Đang quét DOM...';
  const res = await sendActiveTab({ action: 'DIAGNOSE_DOM' });
  if (res?.ok) {
    out.textContent = JSON.stringify(res.diag, null, 2);
  } else {
    out.textContent = res?.error || 'Không đọc được DOM.';
  }
});

$('btnClearLogs').addEventListener('click', async () => {
  await sendBg({ action: 'CLEAR_LOGS' });
  loadState();
  showToast('Đã xóa nhật ký.');
});

$('btnClearDedupe').addEventListener('click', async () => {
  await sendBg({ action: 'CLEAR_PROCESSED' });
  showToast('Đã reset bộ nhớ chống trùng.');
});

loadState();
