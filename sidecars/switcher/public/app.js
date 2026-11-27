(function () {
  'use strict';

  const LANG_STORAGE_KEY = 'ag-switcher-lang';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const USAGE_EXPAND_REFRESH_MS = 10_000;
  const GUARD_TOGGLES = [
    ['guard-alert-enabled', 'alertEnabled'],
    ['guard-watch-weekly', 'watchWeekly'],
    ['guard-watch-5h', 'watch5h'],
    ['guard-dynamic-threshold', 'dynamicThresholdEnabled', true],
    ['guard-natural-pause', 'naturalPauseEnabled', true],
    ['guard-skip-onboarding', 'skipOnboardingPrompt'],
    ['guard-auto-switch', 'autoSwitchEnabled'],
    ['guard-auto-resume', 'autoResumeEnabled'],
  ];
  const CONFIRM_TEXT = {
    switch: ['confirmSwitchTitle', 'confirmSwitchMsg', 'confirmSwitchBtn'],
    remove: ['confirmRemoveTitle', 'confirmRemoveMsg', 'confirmRemoveBtn'],
    'new-login': ['confirmNewLoginTitle', 'newLoginConfirmMsg', 'newLoginConfirmBtn'],
  };

  const I18N = {
    zh: {
      pageTitle: '账号切换',
      lsConnected: 'LS 已连接',
      lsOffline: '离线模式',
      langBtnText: 'EN',
      langBtnTitle: 'Switch to English',
      revealShowTitle: '显示完整邮箱',
      revealHideTitle: '隐藏完整邮箱',
      refreshTitle: '刷新状态',
      savedAccounts: '已保存账号',
      addAccountBtn: '+ 添加账号',
      captureLabel: '当前账号备注名',
      captureLabelPlaceholder: '给当前账号起个备注名（可选，如 主号）',
      captureBtn: '保存当前账号',
      unsavedPromptFile: '检测到当前登录账号（{email}{tier}）尚未保存到切换列表，可输入备注后保存：',
      unsavedPromptKeyring: '检测到账号 {email}{tier}。请在 Antigravity 连接后刷新面板。',
      corruptLocalCred: '检测到本地登录凭证格式异常。点击「+ 添加账号」通过官方原生 Google 登录重新登录。',
      emptyAccounts: '暂无已保存账号。点击「+ 添加账号」通过官方原生 Google 登录添加。',
      emptyAccountsWithUnsaved: '可在上方保存当前账号，或点击右上方「+ 添加账号」添加其它账号。',
      unnamedAccount: '未命名账号',
      activeBadge: '当前使用',
      lastUsedPrefix: '上次使用',
      switchBtn: '切换',
      renameTitle: '重命名',
      deleteTitle: '删除',
      viewUsage: '查看用量',
      usageHeading: '用量',
      usageLoading: '正在获取用量…',
      usageEmpty: '暂无配额数据',
      usageLive: '实时',
      usageSnapshot: '本地快照',
      usageStaleSnapshot: '快照已超过 24 小时 · 切入后自动校准',
      usageNoSnapshot: '暂无本地快照，切换到该账号后将自动采集用量',
      usageRefreshTitle: '刷新用量',
      usageRetry: '重试',
      usageWeeklyLimit: '每周限额',
      usage5hLimit: '5小时限额',
      usageDefaultLimit: '限额',
      usageLeft: '剩余 {pct}%',
      usageUnavailablePct: '--',
      usageDisabled: '不可用',
      usageResetsSoon: '即将重置',
      usageResetsIn: '{time}后重置',
      usageEstimatedReset: '预计已重置',
      usageEstimatedFull: '预计 100%',
      errUsageFailed: '获取用量失败',
      renamePlaceholder: '输入新别名（留空则清除别名）',
      saveBtn: '保存',
      cancelBtn: '取消',
      confirmSwitchTitle: '切换账号',
      confirmSwitchMsg: '确认切换到「{name}」？将先备份当前账号并重启 Antigravity 窗口。',
      confirmSwitchBtn: '确认切换并重启',
      confirmRemoveTitle: '移除账号',
      confirmRemoveMsg: '确认从本机密钥库移除「{name}」？不影响当前正在使用的系统登录态。',
      confirmRemoveBtn: '确认删除',
      confirmBlockedTitle: '检测到活跃任务',
      blockedWorkTitle: '检测到当前有 {count} 项任务/子进程正在运行，已暂停重启：',
      blockedWorkMore: '… 还有更多运行中项',
      blockedWorkHint: '请等任务结束后点「重新检查并切换」。如确认无需等待，可点「仍要强制切换」。',
      blockedRetryBtn: '重新检查并切换',
      blockedForceBtn: '仍要强制切换',
      kindCascade: '对话运行中',
      kindTask: '后台任务',
      kindTerminal: '活跃终端',
      kindProcess: '运行中子进程',
      kindDefault: '运行中任务',
      unnamedTask: '未命名任务',
      toolsLabel: '高级工具',
      guardSummary: '高级设置',
      guardAlertLabel: '低额度实时提醒',
      guardAlertTip: '低风险：仅在对话进行时检查额度，空闲时不发起请求。',
      guardWatchWeeklyLabel: '监控 Gemini 周额度',
      guardWatch5hLabel: '监控 Gemini 5 小时额度',
      guardThresholdLabel: '触发阈值',
      guardThresholdTip: '剩余额度不高于此比例时触发提醒；开启动态阈值区间时作为浮动基准。',
      guardDynamicThresholdLabel: '动态阈值区间',
      guardDynamicThresholdTip: '低风险：每次会话在基准阈值附近自动浮动，先提示收尾再进入切号，减少固定阈值特征。',
      guardNaturalPauseLabel: '切号自然停顿',
      guardNaturalPauseTip: '低风险：关闭桌面端应用并更新登录态后，随机停顿 3–8 秒再重新启动。',
      guardAutoSwitchLabel: 'Agent 自主切号',
      guardAutoSwitchTip: '中风险：关闭时禁止 Agent 切号；开启后授权 Agent 在低额度或指令下自主切号（仅在无其他并发会话或任务时生效），高频切换可能增加账号关联风险。',
      guardAutoResumeLabel: '切号后自动续跑',
      guardAutoResumeTip: '中风险：桌面端应用重启就绪后自动唤醒当前会话继续任务；需开启「Agent 自主切号」后才可启用。',
      guardSkipOnboardingLabel: '跳过重复条款弹窗',
      guardSkipOnboardingTip: '低风险：切号时同步更新本地引导记录，减少重复弹出的条款确认窗；关闭则不改动应用配置。',
      guardInfoLabel: '设置说明',
      confirmNewLoginTitle: '添加账号',
      newLoginConfirmMsg: '将自动备份当前账号并重启 Antigravity，以未登录状态进入官方原生 Google 登录；登录完成后再点击「保存当前账号」纳入列表。',
      newLoginConfirmBtn: '确认并重启',
      logsSummary: '最近切换日志',
      noLogs: '暂无记录',
      footerNote: 'AES-256-GCM 本地加密保存 · 点击「切换」即可自动备份并重启切换账号',
      errRequestFailed: '请求失败（HTTP {status}）',
      errReadState: '读取账号状态失败',
      errActionFailed: '操作失败',
      errSwitchFailed: '切号失败',
      noticeNewLoginRestarting: '正在重启 Antigravity 以进入官方原生 Google 登录…',
      noticeGuardCooldown: '高级设置保护中，请 {sec} 秒后再试',
      noticeGuardCooldownFallback: '高级设置保护中，请稍后再试',
      errGuardSave: '无法更新高级设置',
    },
    en: {
      pageTitle: 'Account Switcher',
      lsConnected: 'LS Connected',
      lsOffline: 'Offline',
      langBtnText: '中',
      langBtnTitle: '切换为中文',
      revealShowTitle: 'Show full email',
      revealHideTitle: 'Hide full email',
      refreshTitle: 'Refresh status',
      savedAccounts: 'Saved Accounts',
      addAccountBtn: '+ Add Account',
      captureLabel: 'Label for current account',
      captureLabelPlaceholder: 'Label for current account (optional)',
      captureBtn: 'Save Account',
      unsavedPromptFile: 'Current signed-in account ({email}{tier}) is not in your saved list yet:',
      unsavedPromptKeyring: 'Account detected ({email}{tier}). Refresh the panel when Antigravity reconnects.',
      corruptLocalCred: 'Local sign-in credentials are invalid. Click "+ Add Account" to sign in again through official native Google sign-in.',
      emptyAccounts: 'No saved accounts yet. Click "+ Add Account" to add one through official native Google sign-in.',
      emptyAccountsWithUnsaved: 'Save the active account above, or click "+ Add Account" to add another.',
      unnamedAccount: 'Unnamed Account',
      activeBadge: 'Active',
      lastUsedPrefix: 'Last used',
      switchBtn: 'Switch',
      renameTitle: 'Rename',
      deleteTitle: 'Delete',
      viewUsage: 'View usage',
      usageHeading: 'Usage',
      usageLoading: 'Loading usage…',
      usageEmpty: 'No usage data',
      usageLive: 'Live',
      usageSnapshot: 'Snapshot',
      usageStaleSnapshot: 'Snapshot >24h old · syncs on switch',
      usageNoSnapshot: 'No local snapshot yet — captured automatically after switching to this account',
      usageRefreshTitle: 'Refresh usage',
      usageRetry: 'Retry',
      usageWeeklyLimit: 'Weekly limit',
      usage5hLimit: '5h limit',
      usageDefaultLimit: 'Limit',
      usageLeft: '{pct}% left',
      usageUnavailablePct: '--',
      usageDisabled: 'Unavailable',
      usageResetsSoon: 'Resets soon',
      usageResetsIn: 'Resets in {time}',
      usageEstimatedReset: 'Est. reset',
      usageEstimatedFull: 'Est. 100%',
      errUsageFailed: 'Failed to load usage',
      renamePlaceholder: 'New label (empty clears label)',
      saveBtn: 'Save',
      cancelBtn: 'Cancel',
      confirmSwitchTitle: 'Switch Account',
      confirmSwitchMsg: 'Switch to "{name}"? Your current session will be backed up before Antigravity restarts.',
      confirmSwitchBtn: 'Switch & Restart',
      confirmRemoveTitle: 'Remove Account',
      confirmRemoveMsg: 'Remove "{name}" from local encrypted vault? Active OS session stays untouched.',
      confirmRemoveBtn: 'Confirm Remove',
      confirmBlockedTitle: 'Active Work Detected',
      blockedWorkTitle: 'Detected {count} active task(s) / subprocess(es); restart paused:',
      blockedWorkMore: '… and more active items',
      blockedWorkHint: 'Wait for tasks to finish and click "Recheck & Switch", or click "Force Switch" to proceed now.',
      blockedRetryBtn: 'Recheck & Switch',
      blockedForceBtn: 'Force Switch',
      kindCascade: 'Running Chat',
      kindTask: 'Background Task',
      kindTerminal: 'Active Terminal',
      kindProcess: 'Child Process',
      kindDefault: 'Active Task',
      unnamedTask: 'Unnamed Task',
      toolsLabel: 'Advanced tools',
      guardSummary: 'Advanced Settings',
      guardAlertLabel: 'Live Low-Quota Alerts',
      guardAlertTip: 'Low risk: Checks quota only during active conversations, with zero idle requests.',
      guardWatchWeeklyLabel: 'Watch Gemini Weekly Quota',
      guardWatch5hLabel: 'Watch Gemini 5-Hour Quota',
      guardThresholdLabel: 'Alert Threshold',
      guardThresholdTip: 'Triggers alerts when remaining quota is at or below this level, or serves as the base for dynamic thresholds.',
      guardDynamicThresholdLabel: 'Dynamic Threshold Range',
      guardDynamicThresholdTip: 'Low risk: Varies soft wrap-up and switch thresholds slightly per session around the base value.',
      guardNaturalPauseLabel: 'Natural Relaunch Pause',
      guardNaturalPauseTip: 'Low risk: Waits a random 3–8 seconds after closing the desktop app before relaunching.',
      guardAutoSwitchLabel: 'Agent Autonomous Switch',
      guardAutoSwitchTip: 'Medium risk: Blocks Agent switching when off; when on, allows the Agent to switch accounts on low quota or request (only when no other sessions or tasks are running). Frequent switching may increase account-linkage risk.',
      guardAutoResumeLabel: 'Auto-Resume After Switch',
      guardAutoResumeTip: 'Medium risk: Automatically resumes the current conversation after the desktop app restarts; requires "Agent Autonomous Switch" to be enabled.',
      guardSkipOnboardingLabel: 'Skip Repeated Onboarding Modal',
      guardSkipOnboardingTip: 'Low risk: Updates the local onboarding state on switch to reduce repeated terms prompts; leave off to avoid modifying app settings.',
      guardInfoLabel: 'Setting details',
      confirmNewLoginTitle: 'Add Account',
      newLoginConfirmMsg: 'Will back up your current account and restart Antigravity into official native Google sign-in. After signing in, click "Save Account" to add it to the list.',
      newLoginConfirmBtn: 'Confirm & Restart',
      logsSummary: 'Recent Switch Logs',
      noLogs: 'No logs yet',
      footerNote: 'AES-256-GCM encrypted locally · Click Switch to back up & relaunch',
      errRequestFailed: 'Request failed (HTTP {status})',
      errReadState: 'Failed to load account status',
      errActionFailed: 'Operation failed',
      errSwitchFailed: 'Switch failed',
      noticeNewLoginRestarting: 'Restarting Antigravity for official native Google sign-in…',
      noticeGuardCooldown: 'Advanced Settings cooling down — please try again in {sec}s',
      noticeGuardCooldownFallback: 'Advanced Settings cooling down — please try again shortly',
      errGuardSave: 'Could not update advanced settings',
    },
  };

  function detectInitialLang() {
    try {
      const saved = window.localStorage?.getItem(LANG_STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch {
      // Ignore restricted storage
    }
    const nav = String(navigator.language || 'zh').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
  }

  const state = {
    lang: detectInitialLang(),
    data: null,
    revealEmails: false,
    busy: false,
    refreshing: false,
    loadingState: false,
    noticeTimer: null,
    confirm: null, // { type: 'switch' | 'remove' | 'new-login', id?: string }
    rename: null, // { id: string, value: string }
    usageOpen: {}, // { [id]: boolean }
    usageById: {}, // { [id]: { status, data, source, capturedAt, isStale, estimatedAnyReset, hasSnapshot, error } }
    usageLastFetchAt: {}, // { [id]: number }
    guardPatch: {},
  };
  let guardSaveQueue = Promise.resolve();

  function el(id) {
    return document.getElementById(id);
  }

  function t(key, vars = {}) {
    const dict = I18N[state.lang] || I18N.zh;
    let out = dict[key] ?? I18N.zh[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v ?? ''));
    }
    return out;
  }

  function createIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const addPath = (d) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    };
    const addCircle = (cx, cy, r) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(r));
      svg.appendChild(c);
    };

    if (name === 'eye') {
      addPath('M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z');
      addCircle(8, 8, 2);
    } else if (name === 'eye-off') {
      addPath('M2.5 2.5l11 11');
      addPath('M6.6 6.7a2 2 0 0 0 2.7 2.7');
      addPath('M4.3 4.5C2.5 5.7 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.3 0 2.4-.4 3.4-1');
      addPath('M6.4 3.7A7 7 0 0 1 8 3.5C12.1 3.5 14.5 8 14.5 8s-.7 1.4-2 2.6');
    } else if (name === 'refresh') {
      addPath('M13.5 8a5.5 5.5 0 1 1-1.35-3.6');
      addPath('M13.5 2.75v2.75h-2.75');
    } else if (name === 'edit') {
      addPath('M11.3 2.5l2.2 2.2-7.8 7.8-2.7.5.5-2.7 7.8-7.8Z');
    } else if (name === 'trash') {
      addPath('M2.75 4.25h10.5');
      addPath('M6 4.25V2.75h4v1.5');
      addPath('M4.25 4.25l.6 8.5a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.5');
    } else if (name === 'chevron-right') {
      addPath('M6 3.5l4.5 4.5-4.5 4.5');
    } else if (name === 'info') {
      addCircle(8, 8, 6.25);
      addPath('M8 7.5v3.25M8 5.25h.01');
    }

    return svg;
  }

  function syncScheme() {
    const root = document.documentElement;
    if (!getComputedStyle(root).getPropertyValue('--background').trim()) {
      delete root.dataset.theme;
      return;
    }
    const probe = document.createElement('span');
    probe.className = 'scheme-probe';
    document.documentElement.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const nums = (color.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const lum = (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / 255;
      document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
    }
  }

  function showNotice(text, kind = 'ok', { autoHideMs = 0 } = {}) {
    if (state.noticeTimer) {
      clearTimeout(state.noticeTimer);
      state.noticeTimer = null;
    }
    const box = el('notice');
    box.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    box.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
    if (!text) {
      box.className = 'notice hidden';
      box.textContent = '';
      return;
    }
    box.className = `notice notice-${kind}`;
    box.textContent = text;
    if (autoHideMs > 0) {
      state.noticeTimer = setTimeout(() => {
        state.noticeTimer = null;
        if (el('notice').textContent === text) {
          showNotice('');
        }
      }, autoHideMs);
    }
  }

  function formatTime(iso) {
    if (!iso) return '';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '';
    const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
    return new Date(ts).toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  async function apiPost(path, body = {}) {
    const fetcher = window.sidecar?.fetch
      ? window.sidecar.fetch
      : (url, opts) =>
          fetch(url, {
            ...opts,
            headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
          });
    const res = await fetcher(path, {
      method: 'POST',
      body: JSON.stringify({ ...body, revealEmails: state.revealEmails }),
    });
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      payload = {};
    }
    if (!res.ok) {
      const err = new Error(payload.error || t('errRequestFailed', { status: res.status }));
      err.status = res.status;
      err.code = payload.code || '';
      err.retryAfterSec = Number.isFinite(Number(payload.retryAfterSec))
        ? Math.max(1, Math.ceil(Number(payload.retryAfterSec)))
        : 0;
      err.activeWork = payload.activeWork || null;
      throw err;
    }
    return payload;
  }

  function pickDisplayEmail(item) {
    if (state.revealEmails && item?.email) return item.email;
    return item?.maskedEmail || '';
  }

  function canCaptureActiveAccount(active) {
    return (active.present && active.valid) || (active.lsConnected && Boolean(pickDisplayEmail(active)));
  }

  function avatarInitial(acc) {
    const src = String(acc?.label || acc?.email || acc?.maskedEmail || '?').trim();
    const first = src.charAt(0);
    return first ? first.toUpperCase() : '?';
  }

  function formatUsageWindowLabel(bucket) {
    const win = String(bucket?.window || '').toLowerCase();
    if (win === 'weekly') return t('usageWeeklyLimit');
    if (win === '5h') return t('usage5hLimit');
    return bucket?.displayName || bucket?.window || t('usageDefaultLimit');
  }

  function formatResetCountdown(iso) {
    if (!iso) return '';
    const targetMs = Date.parse(iso);
    if (!Number.isFinite(targetMs)) return '';
    const diffMs = targetMs - Date.now();
    if (diffMs <= 0) return '';
    if (diffMs < 60_000) return t('usageResetsSoon');

    const totalMins = Math.floor(diffMs / 60_000);
    const days = Math.floor(totalMins / (60 * 24));
    const hours = Math.floor((totalMins % (60 * 24)) / 60);
    const mins = totalMins % 60;

    let timeStr = '';
    if (state.lang === 'zh') {
      if (days > 0) timeStr = hours > 0 ? `${days}天 ${hours}小时` : `${days}天`;
      else if (hours > 0) timeStr = mins > 0 ? `${hours}小时 ${mins}分钟` : `${hours}小时`;
      else timeStr = `${mins}分钟`;
    } else {
      if (days > 0) timeStr = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
      else if (hours > 0) timeStr = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      else timeStr = `${mins}m`;
    }
    return t('usageResetsIn', { time: timeStr });
  }

  function createUsageRingSvg(remainingFraction) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'usage-ring-svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('aria-hidden', 'true');

    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'usage-ring-track');
    track.setAttribute('cx', '9');
    track.setAttribute('cy', '9');
    track.setAttribute('r', '6.5');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', '2.2');
    svg.appendChild(track);

    if (typeof remainingFraction === 'number' && Number.isFinite(remainingFraction)) {
      const clamped = Math.min(1, Math.max(0, remainingFraction));
      const pct = Math.round(clamped * 100);
      if (clamped > 0) {
        const radius = 6.5;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference * (1 - clamped);
        const tone = pct > 30 ? 'ok' : pct > 10 ? 'warn' : 'low';

        const arc = document.createElementNS(SVG_NS, 'circle');
        arc.setAttribute('class', `usage-ring-arc usage-ring-${tone}`);
        arc.setAttribute('cx', '9');
        arc.setAttribute('cy', '9');
        arc.setAttribute('r', String(radius));
        arc.setAttribute('fill', 'none');
        arc.setAttribute('stroke-width', '2.2');
        arc.setAttribute('stroke-linecap', 'round');
        arc.setAttribute('transform', 'rotate(-90 9 9)');
        arc.setAttribute('stroke-dasharray', circumference.toFixed(2));
        arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
        svg.appendChild(arc);
      }
    }

    return svg;
  }

  function createUsageBucketRow(bucket) {
    const row = document.createElement('div');
    row.className = 'usage-bucket-row';
    if (bucket?.description) {
      row.title = bucket.description;
    }

    const left = document.createElement('div');
    left.className = 'usage-bucket-left';

    const labelEl = document.createElement('div');
    labelEl.className = 'usage-bucket-label';
    labelEl.textContent = formatUsageWindowLabel(bucket);
    left.appendChild(labelEl);

    const estimatedReset = bucket?.estimatedReset === true;
    const fraction = estimatedReset ? 1 : bucket?.remainingFraction;
    const hasFraction = typeof fraction === 'number' && Number.isFinite(fraction);
    let resetText = '';
    if (estimatedReset) {
      resetText = t('usageEstimatedReset');
    } else if (hasFraction && fraction < 0.995) {
      resetText = formatResetCountdown(bucket.resetTime);
    }
    if (resetText) {
      const resetEl = document.createElement('div');
      resetEl.className = estimatedReset ? 'usage-bucket-reset usage-reset-est' : 'usage-bucket-reset';
      resetEl.textContent = resetText;
      left.appendChild(resetEl);
    }

    const right = document.createElement('div');
    right.className = 'usage-bucket-right';
    const pctEl = document.createElement('span');
    pctEl.className = 'usage-pct';
    if (estimatedReset) {
      pctEl.textContent = t('usageEstimatedFull');
    } else if (hasFraction) {
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      pctEl.textContent = t('usageLeft', { pct });
    } else {
      pctEl.textContent = bucket?.disabled ? t('usageDisabled') : t('usageUnavailablePct');
    }

    const ring = createUsageRingSvg(hasFraction ? fraction : null);
    right.append(pctEl, ring);
    row.append(left, right);
    return row;
  }

  function createUsageCardNode(acc, switching) {
    const entry = state.usageById[acc.id] || {};
    const isLoading = entry.status === 'loading';
    const hasLive = acc.isActive && entry.source === 'live';
    const hasSnapshot = entry.hasSnapshot && entry.source === 'snapshot';
    const usage = acc.isActive || hasSnapshot ? entry.data : null;

    const card = document.createElement('section');
    card.setAttribute('aria-label', t('usageHeading'));
    card.className = isLoading && usage ? 'usage-card usage-card-refreshing' : 'usage-card';

    const head = document.createElement('div');
    head.className = 'usage-card-head';
    if (hasLive || hasSnapshot) {
      const badge = document.createElement('span');
      badge.className = 'usage-source-badge';
      if (hasLive) {
        badge.classList.add('usage-source-live');
        badge.textContent = t('usageLive');
      } else {
        const timestamp = Date.parse(entry.capturedAt);
        badge.textContent = t('usageSnapshot');
        if (Number.isFinite(timestamp)) {
          const time = new Date(timestamp).toLocaleTimeString(state.lang === 'en' ? 'en-US' : 'zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          });
          badge.textContent += ` · ${time}`;
        }
      }
      head.appendChild(badge);
    }
    if (acc.isActive) {
      head.appendChild(
        createIconButton(
          'refresh',
          isLoading ? 'btn btn-icon btn-icon-sm is-spinning' : 'btn btn-icon btn-icon-sm',
          () => void loadAccountUsage(acc.id, { forceRefresh: true }),
          switching || isLoading,
          t('usageRefreshTitle')
        )
      );
    }
    if (head.hasChildNodes()) card.appendChild(head);

    if (hasSnapshot && entry.isStale) {
      const staleHint = document.createElement('div');
      staleHint.className = 'usage-stale-hint';
      staleHint.textContent = t('usageStaleSnapshot');
      card.appendChild(staleHint);
    }

    if (isLoading && !usage) {
      const loadingEl = document.createElement('div');
      loadingEl.className = 'usage-status-text';
      loadingEl.textContent = t('usageLoading');
      card.appendChild(loadingEl);
      return card;
    }

    if (entry.status === 'error' && !usage) {
      const errBox = document.createElement('div');
      errBox.className = 'usage-error';
      const msg = document.createElement('span');
      msg.textContent = entry.error || t('errUsageFailed');
      const retryBtn = createButton(
        t('usageRetry'),
        'btn btn-secondary btn-sm',
        () => void loadAccountUsage(acc.id, { forceRefresh: acc.isActive }),
        switching
      );
      errBox.append(msg, retryBtn);
      card.appendChild(errBox);
      return card;
    }

    if (entry.status === 'error' && entry.error) {
      const errBox = document.createElement('div');
      errBox.className = 'usage-error';
      const msg = document.createElement('span');
      msg.textContent = entry.error;
      errBox.appendChild(msg);
      card.appendChild(errBox);
    }

    const groups = Array.isArray(usage?.groups) ? usage.groups : [];
    const noSnapshot = !acc.isActive && entry.status === 'loaded' && (!entry.hasSnapshot || entry.source === 'none');
    if (noSnapshot || groups.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'usage-status-text';
      emptyEl.textContent = t(noSnapshot ? 'usageNoSnapshot' : 'usageEmpty');
      card.appendChild(emptyEl);
      return card;
    }

    const groupsEl = document.createElement('div');
    groupsEl.className = 'usage-groups';
    for (const grp of groups) {
      const grpEl = document.createElement('div');
      grpEl.className = 'usage-group';
      if (grp?.description) {
        grpEl.title = grp.description;
      }
      const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
      if (grp?.displayName) {
        const grpTitle = document.createElement('div');
        grpTitle.className = 'usage-group-title';
        grpTitle.textContent = grp.displayName;
        grpEl.appendChild(grpTitle);
      }
      const tiles = document.createElement('div');
      tiles.className = 'usage-buckets';
      for (const bucket of buckets) {
        tiles.appendChild(createUsageBucketRow(bucket));
      }
      grpEl.appendChild(tiles);
      groupsEl.appendChild(grpEl);
    }
    card.appendChild(groupsEl);
    return card;
  }

  function createButton(label, className, onClick, disabled = false, title = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.disabled = Boolean(disabled);
    if (title) btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function createIconButton(iconName, className, onClick, disabled = false, title = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.disabled = Boolean(disabled);
    if (title) {
      btn.title = title;
      btn.setAttribute('aria-label', title);
    }
    btn.appendChild(createIcon(iconName));
    btn.addEventListener('click', onClick);
    return btn;
  }

  function applyStaticI18n() {
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
    document.title = t('pageTitle');
    el('app-title').textContent = t('pageTitle');

    const langBtn = el('toggle-lang-btn');
    langBtn.textContent = t('langBtnText');
    langBtn.title = t('langBtnTitle');
    langBtn.setAttribute('aria-label', t('langBtnTitle'));

    const revealBtn = el('toggle-reveal-btn');
    const revealLabel = state.revealEmails ? t('revealHideTitle') : t('revealShowTitle');
    revealBtn.title = revealLabel;
    revealBtn.setAttribute('aria-label', revealLabel);
    revealBtn.disabled = state.loadingState;
    revealBtn.replaceChildren(createIcon(state.revealEmails ? 'eye-off' : 'eye'));

    const refreshBtn = el('refresh-btn');
    refreshBtn.title = t('refreshTitle');
    refreshBtn.setAttribute('aria-label', t('refreshTitle'));
    refreshBtn.className = state.refreshing ? 'btn btn-icon is-spinning' : 'btn btn-icon';
    refreshBtn.disabled = Boolean(state.refreshing || state.busy || state.data?.switching);
    refreshBtn.setAttribute('aria-busy', String(Boolean(state.refreshing)));
    if (!refreshBtn.hasChildNodes()) {
      refreshBtn.appendChild(createIcon('refresh'));
    }

    el('saved-heading').textContent = t('savedAccounts');
    el('add-account-btn').textContent = t('addAccountBtn');
    const captureLabel = el('capture-label');
    captureLabel.placeholder = t('captureLabelPlaceholder');
    captureLabel.setAttribute('aria-label', t('captureLabel'));
    el('capture-btn').textContent = t('captureBtn');

    el('tools-card').setAttribute('aria-label', t('toolsLabel'));
    el('guard-summary').textContent = t('guardSummary');
    el('guard-alert-label').textContent = t('guardAlertLabel');
    el('guard-alert-tip').textContent = t('guardAlertTip');
    el('guard-watch-weekly-label').textContent = t('guardWatchWeeklyLabel');
    el('guard-watch-5h-label').textContent = t('guardWatch5hLabel');
    el('guard-threshold-label').textContent = t('guardThresholdLabel');
    el('guard-threshold-tip').textContent = t('guardThresholdTip');
    el('guard-dynamic-threshold-label').textContent = t('guardDynamicThresholdLabel');
    el('guard-dynamic-threshold-tip').textContent = t('guardDynamicThresholdTip');
    el('guard-natural-pause-label').textContent = t('guardNaturalPauseLabel');
    el('guard-natural-pause-tip').textContent = t('guardNaturalPauseTip');
    el('guard-auto-switch-label').textContent = t('guardAutoSwitchLabel');
    el('guard-auto-switch-tip').textContent = t('guardAutoSwitchTip');
    el('guard-auto-resume-label').textContent = t('guardAutoResumeLabel');
    el('guard-auto-resume-tip').textContent = t('guardAutoResumeTip');
    el('guard-skip-onboarding-label').textContent = t('guardSkipOnboardingLabel');
    el('guard-skip-onboarding-tip').textContent = t('guardSkipOnboardingTip');
    for (const button of el('guard-settings-form').querySelectorAll('.info-tip-btn')) {
      button.setAttribute('aria-label', t('guardInfoLabel'));
    }

    el('logs-summary').textContent = t('logsSummary');
    el('footer-note').textContent = t('footerNote');
  }

  function formatActiveWorkKind(kind) {
    if (kind === 'cascade') return t('kindCascade');
    if (kind === 'task') return t('kindTask');
    if (kind === 'terminal') return t('kindTerminal');
    if (kind === 'process') return t('kindProcess');
    return t('kindDefault');
  }

  function renderBlockedWorkBox(blockedWork, { onRetry, cancelBtn, onForce, switching }) {
    const title = document.createElement('div');
    title.id = 'confirm-dialog-message';
    title.className = 'blocked-work-title';
    const count = Number.isFinite(blockedWork?.count) ? blockedWork.count : 1;
    title.textContent = t('blockedWorkTitle', { count });

    const list = document.createElement('ul');
    list.className = 'blocked-work-list';
    const items = Array.isArray(blockedWork?.items) ? blockedWork.items : [];
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = `[${formatActiveWorkKind(item?.kind)}] ${item?.label || t('unnamedTask')}`;
      list.appendChild(li);
    }
    if (blockedWork?.truncated) {
      const li = document.createElement('li');
      li.textContent = t('blockedWorkMore');
      list.appendChild(li);
    }

    const hint = document.createElement('div');
    hint.className = 'blocked-work-hint';
    hint.textContent = t('blockedWorkHint');

    const row = document.createElement('div');
    row.className = 'confirm-actions confirm-actions-split';
    const forceBtn = createButton(t('blockedForceBtn'), 'btn btn-danger-subtle btn-sm', onForce, switching);
    forceBtn.classList.add('confirm-actions-left');
    const right = document.createElement('div');
    right.className = 'confirm-actions-right';
    right.append(cancelBtn, createButton(t('blockedRetryBtn'), 'btn btn-primary btn-sm', onRetry, switching));
    row.append(forceBtn, right);

    return [title, list, hint, row];
  }

  function isConfirmDialogOpen(dialog) {
    return dialog.open || dialog.hasAttribute('open');
  }

  function cancelConfirmation() {
    if (!state.confirm || state.busy) return;
    const { type, id } = state.confirm;
    state.confirm = null;
    render();
    // Account rows are rebuilt by render(), so focus the new trigger after dismissal.
    el(type === 'new-login' ? 'add-account-btn' : `confirm-${type}-${id}`)?.focus?.({ preventScroll: true });
  }

  function renderConfirmDialog(data) {
    const dialog = el('confirm-dialog');
    const title = el('confirm-dialog-title');
    const content = el('confirm-dialog-content');
    const { type, id, blockedWork } = state.confirm || {};
    const isNewLogin = type === 'new-login';
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const account = accounts.find((acc) => acc.id === id);
    const copy = CONFIRM_TEXT[type];
    const isOpen = isConfirmDialogOpen(dialog);
    if (!copy || (!isNewLogin && !account)) {
      state.confirm = null;
      if (isOpen) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      title.textContent = '';
      content.replaceChildren();
      return;
    }

    const switching = Boolean(data?.switching || state.busy);
    const cancelBtn = createButton(t('cancelBtn'), 'btn btn-pill btn-sm', cancelConfirmation, switching);
    cancelBtn.autofocus = true;
    const active = document.activeElement;
    const focusedClass = active && content.contains?.(active) ? active.className : '';
    const apiPath = isNewLogin ? '/api/accounts/new-login' : '/api/accounts/switch';
    const runSwitch = (force) => executeSwitchAction(apiPath, { id, force }, { type, id });
    if (blockedWork) {
      title.textContent = t('confirmBlockedTitle');
      content.replaceChildren(...renderBlockedWorkBox(blockedWork, {
        onRetry: () => runSwitch(false),
        cancelBtn,
        onForce: () => runSwitch(true),
        switching,
      }));
    } else {
      const [titleKey, messageKey, submitKey] = copy;
      const name = account?.label || pickDisplayEmail(account) || t('unnamedAccount');
      title.textContent = t(titleKey);
      const msg = document.createElement('p');
      msg.id = 'confirm-dialog-message';
      msg.className = 'confirm-dialog-msg';
      msg.textContent = t(messageKey, { name });
      const row = document.createElement('div');
      row.className = 'confirm-actions';
      const removing = type === 'remove';
      const submit = removing
        ? () => executeAction(() => apiPost('/api/accounts/remove', { id }))
        : () => runSwitch(false);
      const submitClass = removing ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
      row.append(cancelBtn, createButton(t(submitKey), submitClass, submit, switching));
      content.replaceChildren(msg, row);
    }

    dialog.setAttribute('aria-describedby', 'confirm-dialog-message');
    if (!isOpen) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.setAttribute('open', '');
        cancelBtn.focus?.({ preventScroll: true });
      }
    } else {
      const next = focusedClass && Array.from(content.querySelectorAll('button')).find((button) => button.className === focusedClass);
      const focusTarget = switching ? dialog : next || cancelBtn;
      focusTarget.focus?.({ preventScroll: true });
    }
  }

  function renderHeaderAndUnsavedBanner(data) {
    const active = data?.active || {};
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const switching = Boolean(data?.switching || state.busy);

    const lsBadge = el('ls-badge');
    const lsBadgeText = el('ls-badge-text');
    lsBadge.className = active.lsConnected ? 'status-chip status-chip-ok' : 'status-chip status-chip-muted';
    lsBadgeText.textContent = active.lsConnected ? t('lsConnected') : t('lsOffline');

    const banner = el('unsaved-banner');
    const infoEl = el('unsaved-info');
    const captureForm = el('capture-form');
    const captureBtn = el('capture-btn');

    const hasSavedActive = accounts.some((a) => a.isActive);
    const activeDisplayEmail = pickDisplayEmail(active);
    const tierSuffix = active.tierName ? ` · ${active.tierName}` : '';

    if (activeDisplayEmail && !hasSavedActive && canCaptureActiveAccount(active)) {
      banner.className = 'unsaved-banner';
      infoEl.textContent = t('unsavedPromptFile', { email: activeDisplayEmail, tier: tierSuffix });
      captureForm.className = 'inline-form';
      captureBtn.disabled = switching;
    } else if (active.present && !active.valid) {
      banner.className = 'unsaved-banner unsaved-banner-err';
      infoEl.textContent = t('corruptLocalCred');
      captureForm.className = 'inline-form hidden';
    } else if (activeDisplayEmail && !hasSavedActive) {
      banner.className = 'unsaved-banner';
      infoEl.textContent = t('unsavedPromptKeyring', { email: activeDisplayEmail, tier: tierSuffix });
      captureForm.className = 'inline-form hidden';
    } else {
      banner.className = 'unsaved-banner hidden';
      infoEl.textContent = '';
      captureForm.className = 'inline-form hidden';
    }

    el('add-account-btn').disabled = switching;
  }

  function renderAccountItem(acc, switching) {
    const item = document.createElement('li');
    item.className = acc.isActive ? 'account-item account-item-active' : 'account-item';

    const row = document.createElement('div');
    row.className = 'account-row';

    const main = document.createElement('div');
    main.className = 'account-main';

    const avatar = document.createElement('div');
    avatar.className = acc.isActive ? 'account-avatar account-avatar-active' : 'account-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = avatarInitial(acc);

    const textCol = document.createElement('div');
    textCol.className = 'account-text';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'account-title-group';
    const nameEl = document.createElement('span');
    nameEl.className = 'account-name';
    nameEl.textContent = acc.label || pickDisplayEmail(acc) || t('unnamedAccount');
    titleGroup.appendChild(nameEl);

    if (acc.isActive) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'pill pill-active';
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      dot.setAttribute('aria-hidden', 'true');
      activeBadge.append(dot, document.createTextNode(t('activeBadge')));
      titleGroup.appendChild(activeBadge);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'account-meta';

    const emailText = pickDisplayEmail(acc);
    if (emailText) {
      const emailSpan = document.createElement('span');
      emailSpan.className = 'account-email';
      emailSpan.textContent = emailText;
      metaEl.appendChild(emailSpan);
    }

    if (acc.tierName) {
      if (metaEl.hasChildNodes()) {
        const sep = document.createElement('span');
        sep.className = 'meta-sep';
        sep.textContent = '·';
        metaEl.appendChild(sep);
      }
      const tierSpan = document.createElement('span');
      tierSpan.className = 'account-tier';
      tierSpan.textContent = acc.tierName;
      metaEl.appendChild(tierSpan);
    }

    const lastText = formatTime(acc.lastUsedAt);
    if (lastText) {
      if (metaEl.hasChildNodes()) {
        const sep = document.createElement('span');
        sep.className = 'meta-sep';
        sep.textContent = '·';
        metaEl.appendChild(sep);
      }
      const lastSpan = document.createElement('span');
      lastSpan.className = 'account-last';
      lastSpan.textContent = `${t('lastUsedPrefix')}: ${lastText}`;
      metaEl.appendChild(lastSpan);
    }

    textCol.append(titleGroup, metaEl);
    main.append(avatar, textCol);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'account-actions';
    if (!acc.isActive) {
      const switchBtn = createButton(
        t('switchBtn'),
        'btn btn-pill btn-sm',
        () => {
          state.confirm = { type: 'switch', id: acc.id };
          render();
        },
        switching
      );
      switchBtn.id = `confirm-switch-${acc.id}`;
      switchBtn.setAttribute('aria-haspopup', 'dialog');
      actions.appendChild(switchBtn);
    }
    actions.appendChild(
      createIconButton(
        'edit',
        'btn btn-icon',
        () => {
          state.rename = { id: acc.id, value: acc.label || '' };
          state.confirm = null;
          render();
        },
        switching,
        t('renameTitle')
      )
    );
    const removeBtn = createIconButton(
      'trash',
      'btn btn-icon btn-icon-danger',
      () => {
        state.confirm = { type: 'remove', id: acc.id };
        render();
      },
      switching,
      t('deleteTitle')
    );
    removeBtn.id = `confirm-remove-${acc.id}`;
    removeBtn.setAttribute('aria-haspopup', 'dialog');
    actions.appendChild(removeBtn);

    if (!(state.rename && state.rename.id === acc.id)) {
      row.appendChild(actions);
    }
    item.appendChild(row);

    if (state.rename && state.rename.id === acc.id) {
      const form = document.createElement('form');
      form.className = 'inline-form';
      form.autocomplete = 'off';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 40;
      input.value = state.rename.value;
      input.placeholder = t('renamePlaceholder');
      input.addEventListener('input', (e) => {
        if (state.rename) state.rename.value = e.target.value;
      });
      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'btn btn-secondary btn-sm';
      saveBtn.textContent = t('saveBtn');
      saveBtn.disabled = switching;
      const cancelBtn = createButton(
        t('cancelBtn'),
        'btn btn-ghost btn-sm',
        () => {
          state.rename = null;
          render();
        },
        switching
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const nextLabel = input.value;
        state.rename = null;
        executeAction(() => apiPost('/api/accounts/rename', { id: acc.id, label: nextLabel }));
      });
      form.append(input, saveBtn, cancelBtn);
      item.appendChild(form);
    }

    const usageBar = document.createElement('div');
    usageBar.className = 'account-usage-bar';
    const isUsageOpen = Boolean(state.usageOpen[acc.id]);
    const usageToggleBtn = document.createElement('button');
    usageToggleBtn.type = 'button';
    usageToggleBtn.className = isUsageOpen ? 'usage-toggle-btn usage-toggle-open' : 'usage-toggle-btn';
    usageToggleBtn.setAttribute('aria-expanded', String(isUsageOpen));
    usageToggleBtn.append(createIcon('chevron-right'), document.createTextNode(t('viewUsage')));
    usageToggleBtn.addEventListener('click', () => {
      const nextOpen = !state.usageOpen[acc.id];
      state.usageOpen[acc.id] = nextOpen;
      if (nextOpen) {
        const cur = state.usageById[acc.id];
        const isInitialExpand = !cur || cur.status === 'idle';
        const lastAt = state.usageLastFetchAt[acc.id] || 0;
        const elapsed = lastAt > 0 ? Date.now() - lastAt : Infinity;
        if (
          cur?.status !== 'loading' &&
          (!acc.isActive || isInitialExpand || cur.status === 'error' || elapsed > USAGE_EXPAND_REFRESH_MS)
        ) {
          void loadAccountUsage(acc.id, { forceRefresh: !isInitialExpand });
          return;
        }
      }
      render();
    });
    usageBar.appendChild(usageToggleBtn);
    if (isUsageOpen) {
      usageBar.appendChild(createUsageCardNode(acc, switching));
    }
    item.appendChild(usageBar);

    return item;
  }

  function renderAccountsSection(data) {
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const active = data?.active || {};
    const switching = Boolean(data?.switching || state.busy);
    if (data && Array.isArray(data.accounts)) {
      const validIds = new Set(accounts.map((a) => a.id));
      for (const k of Object.keys(state.usageOpen)) {
        if (!validIds.has(k)) delete state.usageOpen[k];
      }
      for (const k of Object.keys(state.usageById)) {
        if (!validIds.has(k)) delete state.usageById[k];
      }
      for (const k of Object.keys(state.usageLastFetchAt)) {
        if (!validIds.has(k)) delete state.usageLastFetchAt[k];
      }
    }
    el('saved-count').textContent = String(accounts.length);
    const listEl = el('accounts-list');

    if (accounts.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = canCaptureActiveAccount(active) ? t('emptyAccountsWithUnsaved') : t('emptyAccounts');
      listEl.replaceChildren(empty);
      return;
    }

    const nodes = accounts.map((acc) => renderAccountItem(acc, switching));
    listEl.replaceChildren(...nodes);
  }

  function guardSettingsDisabled() {
    return !state.data?.settings || state.data.switching || state.busy ||
      state.refreshing || state.loadingState;
  }

  function renderGuardSettings() {
    const disabled = guardSettingsDisabled();
    const settings = { ...state.data?.settings, ...state.guardPatch };
    const autoSwitchEnabled = Boolean(settings.autoSwitchEnabled);
    settings.autoResumeEnabled = autoSwitchEnabled && Boolean(settings.autoResumeEnabled);
    el('guard-auto-resume-row').classList.toggle('guard-row-disabled', !autoSwitchEnabled);
    for (const [id, key, fallback = false] of GUARD_TOGGLES) {
      const button = el(id);
      const buttonDisabled = disabled || (key === 'autoResumeEnabled' && !autoSwitchEnabled);
      const enabled = Boolean(settings[key] ?? fallback);
      button.disabled = buttonDisabled;
      button.setAttribute('aria-checked', String(enabled));
    }

    const threshold = el('guard-threshold');
    const value = String(settings.thresholdPercent ?? 10);
    const savedOption = threshold.querySelector('[data-saved-threshold]');
    if (savedOption?.value !== value) {
      savedOption?.remove();
      if (!Array.from(threshold.options).some((option) => option.value === value)) {
        const option = new Option(`${value}%`, value);
        option.dataset.savedThreshold = '';
        threshold.prepend(option);
      }
    }
    threshold.value = value;
    threshold.disabled = disabled;
  }

  function renderLogs(data) {
    const logs = Array.isArray(data?.logs) ? data.logs : [];
    el('logs-view').textContent = logs.length ? logs.join('\n') : t('noLogs');
  }

  function render() {
    applyStaticI18n();
    renderHeaderAndUnsavedBanner(state.data);
    renderAccountsSection(state.data);
    renderGuardSettings();
    renderLogs(state.data);
    renderConfirmDialog(state.data);
  }

  async function refreshState(silent = false) {
    state.loadingState = true;
    applyStaticI18n();
    renderGuardSettings();
    try {
      const data = await apiPost('/api/state');
      state.data = data;
      if (!silent) showNotice('');
    } catch (err) {
      showNotice(err.message || t('errReadState'), 'err');
    } finally {
      state.loadingState = false;
      render();
    }
  }

  async function saveGuardSetting(key, value) {
    if (guardSettingsDisabled()) return;
    const effectiveAutoSwitchEnabled = state.guardPatch.autoSwitchEnabled ?? state.data.settings.autoSwitchEnabled;
    if (key === 'autoResumeEnabled' && value === true && !effectiveAutoSwitchEnabled) return;
    if (Object.hasOwn(state.guardPatch, key)) {
      renderGuardSettings();
      return;
    }
    const patch = key === 'autoSwitchEnabled' && value === false
      ? { autoSwitchEnabled: false, autoResumeEnabled: false }
      : { [key]: value };
    state.guardPatch = { ...state.guardPatch, ...patch };
    renderGuardSettings();

    // The server returns a full settings snapshot, so apply save responses in order.
    guardSaveQueue = guardSaveQueue.then(async () => {
      let data;
      try {
        data = await apiPost('/api/settings/update', patch);
        if (!data?.settings) throw new Error(t('errGuardSave'));
      } catch (err) {
        if (err?.status === 429 || err?.code === 'RATE_LIMITED') {
          const sec = err.retryAfterSec || 0;
          const message = sec ? t('noticeGuardCooldown', { sec }) : t('noticeGuardCooldownFallback');
          showNotice(message, 'warn', { autoHideMs: Math.min(6000, Math.max(3000, sec * 1000)) });
        } else {
          // The server may have saved the setting before returning an error.
          data = await apiPost('/api/state').catch(() => null);
          showNotice(t('errGuardSave'), 'err');
        }
      } finally {
        if (data?.settings) {
          const { settings, logs, quotaAlert } = data;
          state.data = { ...state.data, settings, logs, quotaAlert };
          renderLogs(state.data);
        }
        for (const field of Object.keys(patch)) {
          if (state.guardPatch[field] === patch[field]) delete state.guardPatch[field];
        }
        renderGuardSettings();
      }
    });
    await guardSaveQueue;
  }

  async function loadAccountUsage(id, { forceRefresh = false } = {}) {
    const account = state.data?.accounts?.find((acc) => acc.id === id);
    if (!account) return;
    const prev = state.usageById[id] || {
      data: null,
      source: 'none',
      capturedAt: '',
      isStale: false,
      estimatedAnyReset: false,
      hasSnapshot: false,
    };
    if (prev.status === 'loading') return;
    state.usageById[id] = {
      ...prev,
      status: 'loading',
      error: '',
    };
    render();
    try {
      const res = await apiPost('/api/accounts/usage', {
        id,
        forceRefresh: Boolean(account.isActive && forceRefresh),
      });
      state.usageById[id] = {
        status: 'loaded',
        data: res?.usage ?? null,
        source: res?.source ?? 'none',
        capturedAt: res?.capturedAt ?? '',
        isStale: Boolean(res?.isStale),
        estimatedAnyReset: Boolean(res?.estimatedAnyReset),
        hasSnapshot: Boolean(res?.hasSnapshot),
        error: '',
      };
      state.usageLastFetchAt[id] = Date.now();
      if (res?.tierName && Array.isArray(state.data?.accounts)) {
        state.data = {
          ...state.data,
          accounts: state.data.accounts.map((a) =>
            a.id === id && a.tierName !== res.tierName ? { ...a, tierName: res.tierName } : a
          ),
        };
      }
    } catch (err) {
      state.usageById[id] = {
        ...prev,
        status: 'error',
        error: err?.message || t('errUsageFailed'),
      };
    } finally {
      render();
    }
  }

  async function refreshAll() {
    if (state.refreshing) return;
    state.refreshing = true;
    showNotice('');
    render();
    const startedAt = Date.now();
    try {
      const data = await apiPost('/api/state');
      state.data = data;
      render();
      const openAccounts = (data.accounts || []).filter((acc) => state.usageOpen[acc.id]);
      await Promise.allSettled(
        openAccounts.map((acc) => loadAccountUsage(acc.id, { forceRefresh: acc.isActive }))
      );
    } catch (err) {
      showNotice(err.message || t('errReadState'), 'err');
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 320) {
        await new Promise((r) => setTimeout(r, 320 - elapsed));
      }
      state.refreshing = false;
      render();
    }
  }

  async function executeAction(fn) {
    state.busy = true;
    render();
    try {
      const res = await fn();
      if (res && typeof res === 'object') {
        if (res.active && res.accounts) {
          state.data = res;
        } else if (res.switching) {
          state.data = { ...(state.data || {}), switching: true };
        }
        if (res.switching && res.message) {
          showNotice(res.message, 'ok');
        }
      }
      state.confirm = null;
    } catch (err) {
      showNotice(err.message || t('errActionFailed'), 'err');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function executeSwitchAction(apiPath, body, confirmTarget) {
    state.busy = true;
    showNotice('');
    render();
    try {
      const res = await apiPost(apiPath, body);
      if (res && typeof res === 'object' && res.switching) {
        state.data = { ...(state.data || {}), switching: true };
      }
      state.confirm = null;
      if (confirmTarget.type === 'new-login' && res?.switching) {
        showNotice(t('noticeNewLoginRestarting'), 'ok');
      } else if (res?.switching && res.message) {
        showNotice(res.message, 'ok');
      }
    } catch (err) {
      if (err.code === 'ACTIVE_WORK_RUNNING') {
        state.confirm = {
          ...confirmTarget,
          blockedWork: err.activeWork || { count: 1, items: [], truncated: false },
        };
      } else {
        state.confirm = null;
        showNotice(err.message || t('errSwitchFailed'), 'err');
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  function bindTipFallback(button) {
    const tip = button.popoverTargetElement;
    if (!tip?.showPopover) return;
    const show = () => {
      if (!tip.matches(':popover-open')) tip.showPopover({ source: button });
    };
    // Allow the pointer to cross the gap between the trigger and the top layer.
    const scheduleHide = () => setTimeout(() => {
      if (!button.matches(':hover, :focus-visible') && !tip.matches(':hover') && tip.matches(':popover-open')) {
        tip.hidePopover();
      }
    }, 200);
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') show();
    });
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) show();
    });
    button.addEventListener('blur', scheduleHide);
    button.addEventListener('pointerleave', scheduleHide);
    tip.addEventListener('pointerleave', scheduleHide);
  }

  function bindEvents() {
    const dialog = el('confirm-dialog');
    dialog.addEventListener('close', () => {
      if (!isConfirmDialogOpen(dialog)) cancelConfirmation();
    });
    dialog.addEventListener('cancel', (event) => {
      if (state.busy) event.preventDefault();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog && !state.busy) cancelConfirmation();
    });

    el('toggle-lang-btn').addEventListener('click', () => {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      try {
        window.localStorage?.setItem(LANG_STORAGE_KEY, state.lang);
      } catch {
        // Ignore storage errors
      }
      render();
    });

    el('refresh-btn').addEventListener('click', () => {
      void refreshAll();
    });
    el('toggle-reveal-btn').addEventListener('click', () => {
      state.revealEmails = !state.revealEmails;
      refreshState(true);
    });

    el('capture-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const labelInput = el('capture-label');
      const label = labelInput.value;
      executeAction(async () => {
        const res = await apiPost('/api/accounts/capture', { label });
        labelInput.value = '';
        return res;
      });
    });

    el('add-account-btn').addEventListener('click', () => {
      state.confirm = { type: 'new-login' };
      render();
    });

    for (const button of el('guard-settings-form').querySelectorAll('.info-tip-btn')) {
      button.appendChild(createIcon('info'));
      if (!('interestForElement' in HTMLButtonElement.prototype)) bindTipFallback(button);
    }
    for (const [id, key] of GUARD_TOGGLES) {
      const button = el(id);
      button.addEventListener('click', async () => {
        const nextValue = button.getAttribute('aria-checked') !== 'true';
        await saveGuardSetting(key, nextValue);
      });
    }
    const threshold = el('guard-threshold');
    threshold.addEventListener('change', () => {
      void saveGuardSetting('thresholdPercent', Number(threshold.value));
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source && event.source !== window.parent && event.source !== window) return;
    if (event.data?.type === 'theme-change') {
      syncScheme();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    syncScheme();
    bindEvents();
    refreshState(true);
  });
})();
