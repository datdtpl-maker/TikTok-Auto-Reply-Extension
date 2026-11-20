// content/main.js - Orchestrator phân lịch độc lập giữa Quét Tin nhắn & Quét Bình luận

window.TTAR = window.TTAR || {};

(function (ns) {
  const { sleep, sendRuntimeMessage, StatusOverlay } = ns.dom;
  const bs = ns.businessSuite;
  const act = ns.activity;

  const RELOAD_FLAG_KEY = 'ttar_run_after_reload';
  const LAST_MSG_KEY = 'ttar_last_msg_scan';
  const LAST_CMT_KEY = 'ttar_last_cmt_scan';

  let settings = null;
  let timerId = null;
  let isScanning = false;
  let cycleCount = 0;
  let pausedOnDraft = false;

  function getLastTs(key) {
    return Number(sessionStorage.getItem(key) || 0);
  }

  function setLastTs(key, val = Date.now()) {
    sessionStorage.setItem(key, String(val));
  }

  async function loadSettings() {
    const res = await sendRuntimeMessage({ action: 'GET_STATE' });
    if (res?.ok && res.settings) {
      settings = res.settings;
    }
    return settings;
  }

  async function runOneCycle(options = {}) {
    const { manual = false, runMsg = true, runCmt = true } =
      typeof options === 'boolean' ? { manual: options, runMsg: true, runCmt: true } : options;

    if (isScanning) return { ok: false, reason: 'already_running' };
    if (!settings) await loadSettings();
    if (!settings) return { ok: false, reason: 'no_settings' };

    if (!manual && !settings.enabled) {
      StatusOverlay.update('idle', 'TikTok AI: Đang tạm dừng');
      return { ok: false, reason: 'disabled' };
    }

    if (!settings.apiKey || !settings.apiKey.trim()) {
      StatusOverlay.update('error', 'TikTok AI: Chưa nhập Gemini API Key');
      return { ok: false, reason: 'missing_api_key' };
    }

    isScanning = true;
    cycleCount++;

    try {
      let msgResult = { scanned: 0, replied: 0, stoppedForDraft: false };
      let cmtResult = { scanned: 0, replied: 0, stoppedForDraft: false };

      if (bs.isBusinessSuitePage()) {
        if (runMsg && settings.enableMessages) {
          const count = Number(settings.messageScanCount) || 10;
          StatusOverlay.update('busy', `Đang quét ${count} hội thoại Tin nhắn gần nhất...`);
          msgResult = await bs.scanBusinessMessages(settings);
          setLastTs(LAST_MSG_KEY);
        }

        if (runCmt && settings.enableBusinessComments && !msgResult.stoppedForDraft) {
          if (runMsg && settings.enableMessages) await sleep(800);
          const vCount = Number(settings.commentVideoCount) || 5;
          StatusOverlay.update('busy', `Đang quét ${vCount} video Bình luận gần nhất...`);
          cmtResult = await bs.scanBusinessComments(settings);
          setLastTs(LAST_CMT_KEY);
        }

        if (msgResult.stoppedForDraft || cmtResult.stoppedForDraft) {
          pausedOnDraft = true;
        } else {
          pausedOnDraft = false;
          const modeLabel = settings.draftOnly ? 'Nháp' : 'Auto';
          StatusOverlay.update(
            'running',
            `BS (${modeLabel}) • Quét #${cycleCount} • TN:${msgResult.replied} BL:${cmtResult.replied}`
          );
        }
      } else if (act.isTikTokMainSite()) {
        if (runCmt && settings.enableActivityComments) {
          StatusOverlay.update('busy', 'Đang quét Hoạt động → Bình luận...');
          cmtResult = await act.scanActivityComments(settings);
          setLastTs(LAST_CMT_KEY);
          const modeLabel = settings.draftOnly ? 'Nháp' : 'Auto';
          StatusOverlay.update(
            'running',
            `Hoạt động (${modeLabel}) • Quét #${cycleCount} • BL:${cmtResult.replied}`
          );
        } else {
          StatusOverlay.update('idle', 'TikTok AI: Chế độ Hoạt động đang tắt');
        }
      }

      return { ok: true, msgResult, cmtResult };
    } catch (err) {
      StatusOverlay.update('error', `Lỗi quét: ${(err?.message || '').slice(0, 42)}`);
      await sendRuntimeMessage({
        action: 'LOG_EVENT',
        payload: {
          level: 'error',
          type: 'system',
          customer: 'System',
          incoming: window.location.pathname,
          error: err?.message || String(err)
        }
      });
      return { ok: false, error: err?.message || String(err) };
    } finally {
      isScanning = false;
    }
  }

  function checkAndRunDueLanes(allowReload = true) {
    if (!settings?.enabled || document.visibilityState !== 'visible' || isScanning || pausedOnDraft) {
      return;
    }

    const now = Date.now();
    const msgIntervalMs = Math.max(10, Number(settings.messageScanIntervalSec) || 20) * 1000;
    const cmtIntervalMs = Math.max(15, Number(settings.commentScanIntervalSec) || 60) * 1000;

    const msgDue =
      bs.isBusinessSuitePage() &&
      Boolean(settings.enableMessages) &&
      now - getLastTs(LAST_MSG_KEY) >= msgIntervalMs;

    const cmtDue =
      ((bs.isBusinessSuitePage() && Boolean(settings.enableBusinessComments)) ||
        (act.isTikTokMainSite() && Boolean(settings.enableActivityComments))) &&
      now - getLastTs(LAST_CMT_KEY) >= cmtIntervalMs;

    if (!msgDue && !cmtDue) return;

    if (allowReload && settings.autoReloadBeforeScan) {
      StatusOverlay.update('busy', 'Đang F5 làm mới để bắt tin nhắn/bình luận mới...');
      sessionStorage.setItem(RELOAD_FLAG_KEY, JSON.stringify({ runMsg: msgDue, runCmt: cmtDue }));
      window.location.reload();
      return;
    }

    runOneCycle({ manual: false, runMsg: msgDue, runCmt: cmtDue });
  }

  function restartScheduler(runImmediately = false, immediateLanes = null) {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }

    if (!settings?.enabled) {
      StatusOverlay.update('idle', 'TikTok AI: Đang tạm dừng');
      return;
    }

    const msgSec = Math.max(10, Number(settings.messageScanIntervalSec) || 20);
    const cmtSec = Math.max(15, Number(settings.commentScanIntervalSec) || 60);
    StatusOverlay.update(
      'running',
      `TikTok AI (${settings.draftOnly ? 'Nháp' : 'Auto'}) • TN:${msgSec}s • BL:${cmtSec}s`
    );

    if (runImmediately) {
      const lanes = immediateLanes || { runMsg: true, runCmt: true };
      setTimeout(() => runOneCycle({ manual: false, ...lanes }), 2000);
    }

    // Kiểm tra lịch độc lập mỗi 3 giây
    timerId = setInterval(() => checkAndRunDueLanes(true), 3000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.action === 'SETTINGS_UPDATED') {
        settings = message.settings;
        pausedOnDraft = false;
        restartScheduler(Boolean(settings?.enabled), { runMsg: true, runCmt: true });
        sendResponse({ ok: true });
      } else if (message?.action === 'RUN_SCAN_NOW') {
        await loadSettings();
        pausedOnDraft = false;
        const res = await runOneCycle({ manual: true, runMsg: true, runCmt: true });
        sendResponse(res);
      } else if (message?.action === 'DIAGNOSE_DOM') {
        const diag = bs.isBusinessSuitePage()
          ? bs.diagnoseBusinessSuite()
          : act.diagnoseActivityPage();
        sendResponse({ ok: true, diag });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  // Boot
  (async () => {
    const rawFlag = sessionStorage.getItem(RELOAD_FLAG_KEY);
    let reloadLanes = null;
    if (rawFlag) {
      sessionStorage.removeItem(RELOAD_FLAG_KEY);
      try {
        reloadLanes = JSON.parse(rawFlag);
      } catch (_) {
        reloadLanes = { runMsg: true, runCmt: true };
      }
    }
    await sleep(reloadLanes ? 2600 : 1200);
    await loadSettings();
    restartScheduler(Boolean(reloadLanes || settings?.enabled), reloadLanes);
  })();
})(window.TTAR);
