// content/main.js - Orchestrator phân lịch độc lập + Đếm ngược từng giây cho Tin nhắn & Bình luận

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
  let pendingImmediateRun = false;
  let reloadingNow = false;
  let cycleCount = 0;
  let pausedOnDraft = false;

  function getLastTs(key) {
    return Number(sessionStorage.getItem(key) || 0);
  }

  function setLastTs(key, val = Date.now()) {
    sessionStorage.setItem(key, String(val));
  }

  function formatCountdown(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return mins > 0
      ? `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`
      : `${rem}s`;
  }

  async function syncScheduleToBg(partial) {
    await sendRuntimeMessage({ action: 'UPDATE_SCHEDULE', payload: partial });
  }

  async function loadSettings() {
    const res = await sendRuntimeMessage({ action: 'GET_STATE' });
    if (res?.ok && res.settings) {
      settings = res.settings;
      if (res.schedule) {
        const bestMsgTs = Math.max(getLastTs(LAST_MSG_KEY), Number(res.schedule.lastMsgScanAt) || 0);
        const bestCmtTs = Math.max(getLastTs(LAST_CMT_KEY), Number(res.schedule.lastCmtScanAt) || 0);
        if (bestMsgTs) setLastTs(LAST_MSG_KEY, bestMsgTs);
        if (bestCmtTs) setLastTs(LAST_CMT_KEY, bestCmtTs);
      }
    }
    return settings;
  }

  function renderCountdownPill() {
    if (!settings?.enabled) {
      StatusOverlay.update('idle', 'TikTok AI: Đang tạm dừng');
      return;
    }
    if (isScanning || pendingImmediateRun || reloadingNow || pausedOnDraft) return;

    const now = Date.now();
    const msgIntervalMs = Math.max(10, Number(settings.messageScanIntervalSec) || 20) * 1000;
    const cmtIntervalMs = Math.max(15, Number(settings.commentScanIntervalSec) || 60) * 1000;

    const parts = [settings.draftOnly ? 'Nháp' : 'Auto'];

    if (bs.isBusinessSuitePage() && settings.enableMessages) {
      const remMsg = Math.max(0, (msgIntervalMs - (now - getLastTs(LAST_MSG_KEY))) / 1000);
      parts.push(`TN: ${formatCountdown(remMsg)}`);
    }

    if (
      (bs.isBusinessSuitePage() && settings.enableBusinessComments) ||
      (act.isTikTokMainSite() && settings.enableActivityComments)
    ) {
      const remCmt = Math.max(0, (cmtIntervalMs - (now - getLastTs(LAST_CMT_KEY))) / 1000);
      parts.push(`BL: ${formatCountdown(remCmt)}`);
    }

    StatusOverlay.update('running', parts.join(' • '));
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
          const startedAt = Date.now();
          await syncScheduleToBg({ activeLane: 'messages' });
          StatusOverlay.update('busy', `Đang quét ${count} hội thoại Tin nhắn gần nhất...`);
          try {
            msgResult = await bs.scanBusinessMessages(settings);
          } finally {
            const doneAt = Date.now();
            setLastTs(LAST_MSG_KEY, doneAt);
            // Đẩy mốc đếm ngược của Bình luận lùi đúng bằng thời gian quét Tin nhắn để không bị trừ giờ nghỉ
            const prevCmt = getLastTs(LAST_CMT_KEY);
            const nextCmt = prevCmt ? prevCmt + (doneAt - startedAt) : doneAt;
            if (!runCmt && prevCmt) {
              setLastTs(LAST_CMT_KEY, nextCmt);
              await syncScheduleToBg({ lastMsgScanAt: doneAt, lastCmtScanAt: nextCmt, activeLane: null });
            } else {
              await syncScheduleToBg({ lastMsgScanAt: doneAt, activeLane: null });
            }
          }
        }

        if (runCmt && settings.enableBusinessComments && !msgResult.stoppedForDraft) {
          if (runMsg && settings.enableMessages) await sleep(800);
          const vCount = Number(settings.commentVideoCount) || 5;
          const startedAt = Date.now();
          await syncScheduleToBg({ activeLane: 'comments' });
          StatusOverlay.update('busy', `Đang quét ${vCount} video Bình luận gần nhất...`);
          try {
            cmtResult = await bs.scanBusinessComments(settings);
          } finally {
            const doneAt = Date.now();
            setLastTs(LAST_CMT_KEY, doneAt);
            // Khi quét Bình luận xong, dời mốc Tin nhắn tương ứng để Tin nhắn nghỉ đủ 100% số giây đã cài (không bị quét lại ngay lập tức)
            const prevMsg = getLastTs(LAST_MSG_KEY);
            const nextMsg = runMsg ? doneAt : prevMsg ? prevMsg + (doneAt - startedAt) : doneAt;
            setLastTs(LAST_MSG_KEY, nextMsg);
            await syncScheduleToBg({ lastMsgScanAt: nextMsg, lastCmtScanAt: doneAt, activeLane: null });
          }
        }

        if (msgResult.stoppedForDraft || cmtResult.stoppedForDraft) {
          pausedOnDraft = true;
        } else {
          pausedOnDraft = false;
        }
      } else if (act.isTikTokMainSite()) {
        if (runCmt && settings.enableActivityComments) {
          await syncScheduleToBg({ activeLane: 'comments' });
          StatusOverlay.update('busy', 'Đang quét Hoạt động → Bình luận...');
          try {
            cmtResult = await act.scanActivityComments(settings);
          } finally {
            const doneAt = Date.now();
            setLastTs(LAST_CMT_KEY, doneAt);
            await syncScheduleToBg({ lastCmtScanAt: doneAt, activeLane: null });
          }
        } else {
          StatusOverlay.update('idle', 'TikTok AI: Chế độ Hoạt động đang tắt');
        }
      }

      return { ok: true, msgResult, cmtResult };
    } catch (err) {
      await syncScheduleToBg({ activeLane: null });
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
      renderCountdownPill();
    }
  }

  function tickScheduler() {
    if (!settings?.enabled) {
      StatusOverlay.update('idle', 'TikTok AI: Đang tạm dừng');
      return;
    }

    if (isScanning || pendingImmediateRun || reloadingNow || pausedOnDraft) return;

    renderCountdownPill();

    if (document.visibilityState !== 'visible') return;

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

    if (settings.autoReloadBeforeScan) {
      reloadingNow = true;
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
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
    reloadingNow = false;

    if (!settings?.enabled) {
      pendingImmediateRun = false;
      syncScheduleToBg({ activeLane: null });
      StatusOverlay.update('idle', 'TikTok AI: Đang tạm dừng');
      return;
    }

    // Khởi tạo mốc đếm ngược nếu chưa có
    const now = Date.now();
    if (!getLastTs(LAST_MSG_KEY)) {
      setLastTs(LAST_MSG_KEY, now);
      syncScheduleToBg({ lastMsgScanAt: now });
    }
    if (!getLastTs(LAST_CMT_KEY)) {
      setLastTs(LAST_CMT_KEY, now);
      syncScheduleToBg({ lastCmtScanAt: now });
    }

    if (runImmediately) {
      // Khóa pendingImmediateRun trước khi bật ticker 1s để tuyệt đối KHÔNG bị F5 lặp lại trước khi quét!
      pendingImmediateRun = true;
      const lanes = immediateLanes || { runMsg: true, runCmt: true };
      StatusOverlay.update('busy', 'Đã tải xong — chuẩn bị quét phiên mới...');
      setTimeout(async () => {
        pendingImmediateRun = false;
        await runOneCycle({ manual: false, ...lanes });
      }, 1500);
    } else {
      pendingImmediateRun = false;
      renderCountdownPill();
    }

    // Cập nhật đồng hồ đếm ngược mỗi 1 giây
    timerId = setInterval(() => tickScheduler(), 1000);
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
    await sleep(reloadLanes ? 2600 : 1500);
    const stateRes = await sendRuntimeMessage({ action: 'GET_STATE' });
    if (stateRes?.ok && stateRes.settings) {
      settings = stateRes.settings;
      if (stateRes.schedule) {
        const bestMsgTs = Math.max(getLastTs(LAST_MSG_KEY), Number(stateRes.schedule.lastMsgScanAt) || 0);
        const bestCmtTs = Math.max(getLastTs(LAST_CMT_KEY), Number(stateRes.schedule.lastCmtScanAt) || 0);
        if (bestMsgTs) setLastTs(LAST_MSG_KEY, bestMsgTs);
        if (bestCmtTs) setLastTs(LAST_CMT_KEY, bestCmtTs);

        if (stateRes.schedule.runOnNextLoad && bs.isBusinessSuitePage()) {
          await syncScheduleToBg({ runOnNextLoad: false });
          reloadLanes = reloadLanes || { runMsg: true, runCmt: true };
        }
      }
    }
    restartScheduler(Boolean(reloadLanes), reloadLanes);
  })();
})(window.TTAR);
