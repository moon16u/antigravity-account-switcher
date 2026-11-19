(function () {
  'use strict';

  const GOOGLE_AUTH_URL_RE = /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/;
  const LANG_STORAGE_KEY = 'ag-switcher-lang';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const USAGE_EXPAND_REFRESH_MS = 10_000;

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
      collapseAddBtn: '收起添加',
      collapseBtn: '收起',
      oauthLabelPlaceholder: '新账号备注名（可选，如 备用1）',
      oauthStartBtn: '浏览器授权添加',
      oauthPendingMsg:
        '请在弹出的浏览器中登录要添加的 Google 账号（无需退出当前 Antigravity）。若需登录另一个账号，可复制下方链接到无痕窗口或其它浏览器配置文件打开。',
      oauthExchangingMsg: '已收到 Google 回调，正在换取并加密保存凭证…',
      openAuthPage: '打开授权页',
      copyAuthUrl: '复制授权链接',
      cancelOAuth: '取消授权',
      captureLabelPlaceholder: '给当前账号起个备注名（可选，如 主号）',
      captureBtn: '保存当前账号',
      unsavedPromptFile: '检测到当前登录账号（{email}{tier}）尚未保存到切换列表，可输入备注后保存：',
      unsavedPromptKeyring: '当前已登录 {email}{tier}，请点击右上方「+ 添加账号」纳入切换列表。',
      corruptLocalCred: '检测到本地 OAuth 凭证格式异常，可通过上方「+ 添加账号」重新授权替换。',
      emptyAccounts: '暂无已保存账号。可点击右上方「+ 添加账号」免退出授权添加。',
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
      errUsageFailed: '获取用量失败',
      renamePlaceholder: '输入新别名（留空则清除别名）',
      saveBtn: '保存',
      cancelBtn: '取消',
      confirmSwitchMsg: '确认切换到「{name}」？将先备份当前账号并重启 Antigravity 窗口。',
      confirmSwitchBtn: '确认切换并重启',
      confirmRemoveMsg: '确认从本机密钥库移除「{name}」？不影响当前正在使用的系统登录态。',
      confirmRemoveBtn: '确认删除',
      blockedWorkTitle: '检测到当前有 {count} 项任务/子进程正在运行，已暂停重启：',
      blockedWorkMore: '… 还有更多运行中项',
      blockedWorkHint: '请等任务结束后点「重新检查并切换」；如确认无需等待，可点右侧强制切换。',
      blockedRetryBtn: '重新检查并切换',
      blockedForceBtn: '仍要强制切换',
      kindCascade: '对话运行中',
      kindTask: '后台任务',
      kindTerminal: '活跃终端',
      kindProcess: '运行中子进程',
      kindDefault: '运行中任务',
      unnamedTask: '未命名任务',
      fallbackSummary: '原生登录（备用）',
      fallbackDesc:
        '浏览器授权受阻时可使用此方式：备份当前账号并退出桌面应用，以未登录状态重开窗口进行原生登录。',
      newLoginBtn: '退出并走原生登录',
      newLoginConfirmMsg: '将自动备份当前账号并重启 Antigravity，随后清除当前登录态进入官方 Google 登录。',
      newLoginConfirmBtn: '确认退出并登录新号',
      logsSummary: '最近切换日志',
      noLogs: '暂无记录',
      footerNote: 'AES-256-GCM 本地加密保存 · 点击「切换」即可自动备份并重启切换账号',
      errRequestFailed: '请求失败（HTTP {status}）',
      errReadState: '读取账号状态失败',
      errActionFailed: '操作失败',
      errSwitchFailed: '切号失败',
      errOAuthIncomplete: '浏览器授权未完成，请重试。',
      noticeOAuthAdded: '已通过浏览器授权添加账号（{email}）',
      noticeBrowserOpened: '已唤起浏览器授权页，请在浏览器完成登录…',
      noticeBrowserFallback: '请点击「打开授权页」或复制授权链接到浏览器完成登录…',
      noticeCopied: '已复制授权链接，可粘贴到无痕窗口或其它浏览器配置文件中打开。',
      noticeCopyRestricted: '自动复制受限，已选中上方链接框，请按 Ctrl+C 复制。',
      noticeOAuthCancelled: '已取消浏览器授权。',
      noticeRefreshed: '已刷新账号状态与用量',
      noticeRefreshedLocal: '已刷新本地账号状态',
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
      collapseAddBtn: 'Close',
      collapseBtn: 'Hide',
      oauthLabelPlaceholder: 'Label (optional, e.g. Work)',
      oauthStartBtn: 'Authorize in Browser',
      oauthPendingMsg:
        'Sign in with your Google account in the opened browser (no need to quit Antigravity). Or copy the URL below into an incognito window or another browser profile.',
      oauthExchangingMsg: 'Callback received, encrypting & saving credentials…',
      openAuthPage: 'Open Auth Page',
      copyAuthUrl: 'Copy URL',
      cancelOAuth: 'Cancel',
      captureLabelPlaceholder: 'Label for current account (optional)',
      captureBtn: 'Save Account',
      unsavedPromptFile: 'Current signed-in account ({email}{tier}) is not in your saved list yet:',
      unsavedPromptKeyring: 'Signed in as {email}{tier}. Click "+ Add Account" above to add it for switching.',
      corruptLocalCred: 'Local OAuth credential format is invalid. Use "+ Add Account" to re-authorize and replace it.',
      emptyAccounts: 'No saved accounts yet. Click "+ Add Account" above to authorize without signing out.',
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
      errUsageFailed: 'Failed to load usage',
      renamePlaceholder: 'New label (empty clears label)',
      saveBtn: 'Save',
      cancelBtn: 'Cancel',
      confirmSwitchMsg: 'Switch to "{name}"? Your current session will be backed up before Antigravity restarts.',
      confirmSwitchBtn: 'Switch & Restart',
      confirmRemoveMsg: 'Remove "{name}" from local encrypted vault? Active OS session stays untouched.',
      confirmRemoveBtn: 'Confirm Remove',
      blockedWorkTitle: 'Detected {count} active task(s) / subprocess(es); restart paused:',
      blockedWorkMore: '… and more active items',
      blockedWorkHint: 'Wait for tasks to finish and click "Recheck & Switch", or force switch on the right.',
      blockedRetryBtn: 'Recheck & Switch',
      blockedForceBtn: 'Force Switch',
      kindCascade: 'Running Chat',
      kindTask: 'Background Task',
      kindTerminal: 'Active Terminal',
      kindProcess: 'Child Process',
      kindDefault: 'Active Task',
      unnamedTask: 'Unnamed Task',
      fallbackSummary: 'Native Sign-in (Fallback)',
      fallbackDesc:
        'If browser authorization is blocked, use this option: back up the current account, quit the desktop app, and reopen signed out for native Google sign-in.',
      newLoginBtn: 'Sign Out & Re-login',
      newLoginConfirmMsg: 'Will back up current account and restart Antigravity without active credentials for native sign-in.',
      newLoginConfirmBtn: 'Confirm & Restart',
      logsSummary: 'Recent Switch Logs',
      noLogs: 'No logs yet',
      footerNote: 'AES-256-GCM encrypted locally · Click Switch to back up & relaunch',
      errRequestFailed: 'Request failed (HTTP {status})',
      errReadState: 'Failed to load account status',
      errActionFailed: 'Operation failed',
      errSwitchFailed: 'Switch failed',
      errOAuthIncomplete: 'Browser authorization did not complete. Please try again.',
      noticeOAuthAdded: 'Account added via browser OAuth ({email})',
      noticeBrowserOpened: 'Browser authorization opened — complete sign-in in your browser…',
      noticeBrowserFallback: 'Click "Open Auth Page" or copy the URL below to sign in…',
      noticeCopied: 'Auth URL copied. Paste it into an incognito window or another browser profile.',
      noticeCopyRestricted: 'Clipboard restricted; URL selected above — press Ctrl+C to copy.',
      noticeOAuthCancelled: 'Browser authorization cancelled.',
      noticeRefreshed: 'Accounts & usage refreshed',
      noticeRefreshedLocal: 'Local account status refreshed',
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
    noticeTimer: null,
    confirm: null, // { type: 'switch' | 'remove' | 'new-login', id?: string }
    rename: null, // { id: string, value: string }
    usageOpen: {}, // { [id]: boolean }
    usageById: {}, // { [id]: { status: 'idle' | 'loading' | 'loaded' | 'error', data: object | null, error: string } }
    usageLastFetchAt: {}, // { [id]: number }
    didInitialTierSync: false,
    oauthPanelOpen: false,
    oauth: { status: 'idle', authUrl: '' },
    pollTimer: null,
  };

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
    }

    return svg;
  }

  function syncScheme() {
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
    if (!text) {
      box.className = 'notice hidden';
      box.textContent = '';
      return;
    }
    box.className = `notice ${kind === 'err' ? 'notice-err' : 'notice-ok'}`;
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
      err.activeWork = payload.activeWork || null;
      throw err;
    }
    return payload;
  }

  function pickDisplayEmail(item) {
    if (state.revealEmails && item?.email) return item.email;
    return item?.maskedEmail || '';
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

  function createUsageBucketRow(bucket, groupTitle = '') {
    const row = document.createElement('div');
    row.className = 'usage-bucket-row';
    if (bucket?.description) {
      row.title = bucket.description;
    }

    const left = document.createElement('div');
    left.className = 'usage-bucket-left';
    if (groupTitle) {
      const titleEl = document.createElement('div');
      titleEl.className = 'usage-group-title';
      titleEl.textContent = groupTitle;
      left.appendChild(titleEl);
    }

    const labelEl = document.createElement('div');
    labelEl.className = 'usage-bucket-label';
    labelEl.textContent = formatUsageWindowLabel(bucket);
    left.appendChild(labelEl);

    const hasFraction = typeof bucket?.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction);
    if (hasFraction && bucket.remainingFraction < 0.995) {
      const resetText = formatResetCountdown(bucket.resetTime);
      if (resetText) {
        const resetEl = document.createElement('div');
        resetEl.className = 'usage-bucket-reset';
        resetEl.textContent = resetText;
        left.appendChild(resetEl);
      }
    }

    const right = document.createElement('div');
    right.className = 'usage-bucket-right';
    const pctEl = document.createElement('span');
    pctEl.className = 'usage-pct';
    if (hasFraction) {
      const pct = Math.round(Math.min(1, Math.max(0, bucket.remainingFraction)) * 100);
      pctEl.textContent = t('usageLeft', { pct });
    } else {
      pctEl.textContent = bucket?.disabled ? t('usageDisabled') : t('usageUnavailablePct');
    }

    const ring = createUsageRingSvg(
      bucket?.disabled && !hasFraction ? null : hasFraction ? bucket.remainingFraction : null
    );
    right.append(pctEl, ring);
    row.append(left, right);
    return row;
  }

  function createUsageCardNode(acc, switching) {
    const entry = state.usageById[acc.id] || { status: 'idle', data: null, error: '' };
    const isLoading = entry.status === 'loading';

    const card = document.createElement('div');
    card.className = isLoading && entry.data ? 'usage-card usage-card-refreshing' : 'usage-card';

    const head = document.createElement('div');
    head.className = 'usage-card-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'usage-card-title';
    titleEl.textContent = t('usageHeading');
    const reloadBtn = createIconButton(
      'refresh',
      isLoading ? 'btn btn-icon btn-icon-sm is-spinning' : 'btn btn-icon btn-icon-sm',
      () => void loadAccountUsage(acc.id, { forceRefresh: true }),
      switching || isLoading,
      t('usageRefreshTitle')
    );
    head.append(titleEl, reloadBtn);
    card.appendChild(head);

    if (isLoading && !entry.data) {
      const loadingEl = document.createElement('div');
      loadingEl.className = 'usage-status-text';
      loadingEl.textContent = t('usageLoading');
      card.appendChild(loadingEl);
      return card;
    }

    if (entry.status === 'error' && !entry.data) {
      const errBox = document.createElement('div');
      errBox.className = 'usage-error';
      const msg = document.createElement('span');
      msg.textContent = entry.error || t('errUsageFailed');
      const retryBtn = createButton(
        t('usageRetry'),
        'btn btn-secondary btn-sm',
        () => void loadAccountUsage(acc.id, { forceRefresh: true }),
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

    const groups = Array.isArray(entry.data?.groups) ? entry.data.groups : [];
    if (groups.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'usage-status-text';
      emptyEl.textContent = t('usageEmpty');
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
      if (buckets.length === 1) {
        grpEl.appendChild(createUsageBucketRow(buckets[0], grp.displayName || ''));
      } else {
        if (grp?.displayName) {
          const grpTitle = document.createElement('div');
          grpTitle.className = 'usage-group-title';
          grpTitle.textContent = grp.displayName;
          grpEl.appendChild(grpTitle);
        }
        for (const bucket of buckets) {
          grpEl.appendChild(createUsageBucketRow(bucket));
        }
      }
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

    const revealBtn = el('toggle-reveal-btn');
    const revealLabel = state.revealEmails ? t('revealHideTitle') : t('revealShowTitle');
    revealBtn.title = revealLabel;
    revealBtn.setAttribute('aria-label', revealLabel);
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
    el('capture-label').placeholder = t('captureLabelPlaceholder');
    el('capture-btn').textContent = t('captureBtn');
    el('oauth-label').placeholder = t('oauthLabelPlaceholder');
    el('oauth-start-btn').textContent = t('oauthStartBtn');
    el('oauth-hide-btn').textContent = t('collapseBtn');
    el('oauth-link').textContent = t('openAuthPage');
    el('oauth-copy-btn').textContent = t('copyAuthUrl');
    el('oauth-cancel-btn').textContent = t('cancelOAuth');

    el('fallback-summary').textContent = t('fallbackSummary');
    el('fallback-desc').textContent = t('fallbackDesc');
    el('new-login-btn').textContent = t('newLoginBtn');

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

  function renderBlockedWorkBox(blockedWork, { onRetry, onCancel, onForce, switching }) {
    const title = document.createElement('div');
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
    const left = document.createElement('div');
    left.className = 'confirm-actions-left';
    left.appendChild(createButton(t('blockedRetryBtn'), 'btn btn-primary', onRetry, switching));
    left.appendChild(createButton(t('cancelBtn'), 'btn btn-ghost', onCancel, switching));
    const forceBtn = createButton(t('blockedForceBtn'), 'btn btn-danger-subtle', onForce, switching);
    row.append(left, forceBtn);

    return [title, list, hint, row];
  }

  function stopOAuthPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startOAuthPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      void pollOAuthStatus();
    }, 1500);
  }

  async function pollOAuthStatus() {
    if (!state.oauth || (state.oauth.status !== 'pending' && state.oauth.status !== 'exchanging')) {
      stopOAuthPolling();
      return;
    }
    try {
      const res = await apiPost('/api/oauth/status');
      const oauth = res?.oauth || { status: 'idle' };
      state.oauth = oauth;
      if (oauth.status === 'succeeded') {
        stopOAuthPolling();
        state.oauthPanelOpen = false;
        el('oauth-label').value = '';
        el('oauth-url-preview').value = '';
        if (res.active && res.accounts) {
          state.data = res;
        }
        showNotice(t('noticeOAuthAdded', { email: oauth.maskedEmail || '' }), 'ok');
        render();
      } else if (oauth.status === 'failed' || oauth.status === 'expired') {
        stopOAuthPolling();
        el('oauth-url-preview').value = '';
        if (res.active && res.accounts) {
          state.data = res;
        }
        showNotice(oauth.error || t('errOAuthIncomplete'), 'err');
        render();
      } else if (oauth.status === 'exchanging') {
        renderOAuthPanel(Boolean(state.data?.switching || state.busy));
      }
    } catch {
      // Transient polling errors are ignored until user cancels or timeout triggers
    }
  }

  function renderOAuthPanel(switching) {
    const panel = el('oauth-panel');
    const toggleBtn = el('oauth-toggle-btn');
    const form = el('oauth-form');
    const pendingBox = el('oauth-pending-box');
    const linkEl = el('oauth-link');
    const previewEl = el('oauth-url-preview');
    const startBtn = el('oauth-start-btn');
    const cancelBtn = el('oauth-cancel-btn');
    const pendingMsg = el('oauth-pending-msg');

    const oauthStatus = state.oauth?.status || 'idle';
    const inFlow = oauthStatus === 'pending' || oauthStatus === 'exchanging';
    const showPanel = state.oauthPanelOpen || inFlow;

    panel.className = showPanel ? 'oauth-panel' : 'oauth-panel hidden';
    toggleBtn.disabled = switching;
    toggleBtn.textContent = showPanel ? t('collapseAddBtn') : t('addAccountBtn');

    if (!showPanel) {
      previewEl.value = '';
      linkEl.removeAttribute('href');
      return;
    }

    form.className = inFlow ? 'inline-form hidden' : 'inline-form';
    startBtn.disabled = switching || state.busy;

    if (inFlow) {
      pendingBox.className = 'confirm-box';
      if (oauthStatus === 'exchanging') {
        pendingMsg.textContent = t('oauthExchangingMsg');
        linkEl.className = 'btn btn-primary hidden';
        linkEl.removeAttribute('href');
        previewEl.className = 'url-preview hidden';
        el('oauth-copy-btn').className = 'btn btn-secondary hidden';
      } else {
        pendingMsg.textContent = t('oauthPendingMsg');
        const validUrl = GOOGLE_AUTH_URL_RE.test(state.oauth.authUrl || '') ? state.oauth.authUrl : '';
        if (validUrl) {
          linkEl.href = validUrl;
          linkEl.className = 'btn btn-primary';
          previewEl.value = validUrl;
          previewEl.className = 'url-preview';
          el('oauth-copy-btn').className = 'btn btn-secondary';
        } else {
          linkEl.removeAttribute('href');
          linkEl.className = 'btn btn-primary hidden';
          previewEl.value = '';
          previewEl.className = 'url-preview hidden';
          el('oauth-copy-btn').className = 'btn btn-secondary hidden';
        }
      }
      cancelBtn.disabled = switching;
    } else {
      pendingBox.className = 'confirm-box hidden';
      linkEl.removeAttribute('href');
      previewEl.value = '';
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

    if (active.present && !active.valid) {
      banner.className = 'unsaved-banner unsaved-banner-err';
      infoEl.textContent = t('corruptLocalCred');
      captureForm.className = 'inline-form hidden';
    } else if (activeDisplayEmail && !hasSavedActive) {
      banner.className = 'unsaved-banner';
      if (active.present && active.valid) {
        infoEl.textContent = t('unsavedPromptFile', { email: activeDisplayEmail, tier: tierSuffix });
        captureForm.className = 'inline-form';
        captureBtn.disabled = switching;
      } else {
        infoEl.textContent = t('unsavedPromptKeyring', { email: activeDisplayEmail, tier: tierSuffix });
        captureForm.className = 'inline-form hidden';
      }
    } else {
      banner.className = 'unsaved-banner hidden';
      infoEl.textContent = '';
      captureForm.className = 'inline-form hidden';
    }

    const newLoginBtn = el('new-login-btn');
    const confirmBox = el('new-login-confirm');
    newLoginBtn.disabled = switching;

    if (state.confirm?.type === 'new-login') {
      confirmBox.className = 'confirm-box';
      if (state.confirm.blockedWork) {
        confirmBox.replaceChildren(
          ...renderBlockedWorkBox(state.confirm.blockedWork, {
            switching,
            onRetry: () =>
              executeSwitchAction('/api/accounts/new-login', { force: false }, { type: 'new-login' }),
            onCancel: () => {
              state.confirm = null;
              render();
            },
            onForce: () =>
              executeSwitchAction('/api/accounts/new-login', { force: true }, { type: 'new-login' }),
          })
        );
      } else {
        const msg = document.createElement('div');
        msg.textContent = t('newLoginConfirmMsg');
        const row = document.createElement('div');
        row.className = 'confirm-actions';
        row.appendChild(
          createButton(
            t('newLoginConfirmBtn'),
            'btn btn-primary',
            () => executeSwitchAction('/api/accounts/new-login', { force: false }, { type: 'new-login' }),
            switching
          )
        );
        row.appendChild(
          createButton(
            t('cancelBtn'),
            'btn btn-ghost',
            () => {
              state.confirm = null;
              render();
            },
            switching
          )
        );
        confirmBox.replaceChildren(msg, row);
      }
    } else {
      confirmBox.className = 'confirm-box hidden';
      confirmBox.replaceChildren();
    }
  }

  function renderAccountItem(acc, switching) {
    const item = document.createElement('div');
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
      actions.appendChild(
        createButton(
          t('switchBtn'),
          'btn btn-primary btn-sm',
          () => {
            state.confirm = { type: 'switch', id: acc.id };
            state.rename = null;
            render();
          },
          switching
        )
      );
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
    actions.appendChild(
      createIconButton(
        'trash',
        'btn btn-icon btn-icon-danger',
        () => {
          state.confirm = { type: 'remove', id: acc.id };
          state.rename = null;
          render();
        },
        switching,
        t('deleteTitle')
      )
    );

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
      saveBtn.className = 'btn btn-primary btn-sm';
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

    if (state.confirm && state.confirm.id === acc.id) {
      const cbox = document.createElement('div');
      cbox.className = 'confirm-box';

      if (state.confirm.type === 'switch' && state.confirm.blockedWork) {
        cbox.replaceChildren(
          ...renderBlockedWorkBox(state.confirm.blockedWork, {
            switching,
            onRetry: () =>
              executeSwitchAction(
                '/api/accounts/switch',
                { id: acc.id, force: false },
                { type: 'switch', id: acc.id }
              ),
            onCancel: () => {
              state.confirm = null;
              render();
            },
            onForce: () =>
              executeSwitchAction(
                '/api/accounts/switch',
                { id: acc.id, force: true },
                { type: 'switch', id: acc.id }
              ),
          })
        );
      } else {
        const msg = document.createElement('div');
        const confirmRow = document.createElement('div');
        confirmRow.className = 'confirm-actions';
        const displayName = acc.label || pickDisplayEmail(acc);

        if (state.confirm.type === 'switch') {
          msg.textContent = t('confirmSwitchMsg', { name: displayName });
          confirmRow.appendChild(
            createButton(
              t('confirmSwitchBtn'),
              'btn btn-primary btn-sm',
              () =>
                executeSwitchAction(
                  '/api/accounts/switch',
                  { id: acc.id, force: false },
                  { type: 'switch', id: acc.id }
                ),
              switching
            )
          );
        } else if (state.confirm.type === 'remove') {
          msg.textContent = t('confirmRemoveMsg', { name: displayName });
          confirmRow.appendChild(
            createButton(
              t('confirmRemoveBtn'),
              'btn btn-danger btn-sm',
              () => executeAction(() => apiPost('/api/accounts/remove', { id: acc.id })),
              switching
            )
          );
        }

        confirmRow.appendChild(
          createButton(
            t('cancelBtn'),
            'btn btn-ghost btn-sm',
            () => {
              state.confirm = null;
              render();
            },
            switching
          )
        );
        cbox.append(msg, confirmRow);
      }
      item.appendChild(cbox);
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
          (isInitialExpand || cur.status === 'error' || elapsed > USAGE_EXPAND_REFRESH_MS)
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
    renderOAuthPanel(switching);
    const listEl = el('accounts-list');

    if (accounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = active.present && active.valid ? t('emptyAccountsWithUnsaved') : t('emptyAccounts');
      listEl.replaceChildren(empty);
      return;
    }

    const nodes = accounts.map((acc) => renderAccountItem(acc, switching));
    listEl.replaceChildren(...nodes);
  }

  function renderLogs(data) {
    const logs = Array.isArray(data?.logs) ? data.logs : [];
    el('logs-view').textContent = logs.length ? logs.join('\n') : t('noLogs');
  }

  function render() {
    applyStaticI18n();
    renderHeaderAndUnsavedBanner(state.data);
    renderAccountsSection(state.data);
    renderLogs(state.data);
  }

  async function refreshState(silent = false) {
    try {
      const data = await apiPost('/api/state');
      state.data = data;
      if (!silent) showNotice('');
      render();
      if (!state.didInitialTierSync) {
        void syncMissingTiersInBackground();
      }
    } catch (err) {
      showNotice(err.message || t('errReadState'), 'err');
    }
  }

  async function syncMissingTiersInBackground() {
    if (state.didInitialTierSync) return;
    const accounts = Array.isArray(state.data?.accounts) ? state.data.accounts : [];
    if (!accounts.some((a) => !a.tierName)) return;
    state.didInitialTierSync = true;
    try {
      const res = await apiPost('/api/accounts/sync-tiers', { onlyMissing: true });
      if (res?.active && res?.accounts) {
        state.data = res;
        if (!state.rename) {
          render();
        }
      }
    } catch {
      // Silent best-effort tier enrichment
    }
  }

  async function loadAccountUsage(id, { forceRefresh = false } = {}) {
    const prev = state.usageById[id];
    if (prev?.status === 'loading') return;
    state.usageById[id] = {
      status: 'loading',
      data: prev?.data || null,
      error: '',
    };
    render();
    try {
      const res = await apiPost('/api/accounts/usage', { id, forceRefresh });
      state.usageById[id] = {
        status: 'loaded',
        data: res?.usage || null,
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
        status: 'error',
        data: prev?.data || null,
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
    let syncedRemote = false;
    let failed = false;
    try {
      try {
        const res = await apiPost('/api/accounts/sync-tiers', { onlyMissing: false });
        if (res?.active && res?.accounts) {
          state.data = res;
          syncedRemote = true;
          render();
        }
      } catch {
        try {
          const data = await apiPost('/api/state');
          state.data = data;
          render();
        } catch (err) {
          failed = true;
          showNotice(err.message || t('errReadState'), 'err');
        }
      }
      const openIds = Object.keys(state.usageOpen).filter((id) => state.usageOpen[id]);
      if (openIds.length > 0) {
        await Promise.allSettled(openIds.map((id) => loadAccountUsage(id, { forceRefresh: true })));
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed < 320) {
        await new Promise((r) => setTimeout(r, 320 - elapsed));
      }
    } finally {
      state.refreshing = false;
      render();
      if (!failed && !el('notice').textContent) {
        showNotice(syncedRemote ? t('noticeRefreshed') : t('noticeRefreshedLocal'), 'ok', {
          autoHideMs: 2500,
        });
      }
    }
  }

  async function executeAction(fn, keepConfirmOff = false) {
    state.busy = true;
    if (keepConfirmOff) state.confirm = null;
    render();
    try {
      const res = await fn();
      if (res && typeof res === 'object') {
        if (res.active && res.accounts) {
          state.data = res;
        } else if (res.switching) {
          state.data = { ...(state.data || {}), switching: true };
        }
        if (res.message) {
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
    render();
    try {
      const res = await apiPost(apiPath, body);
      if (res && typeof res === 'object' && res.switching) {
        state.data = { ...(state.data || {}), switching: true };
      }
      state.confirm = null;
      if (res?.message) {
        showNotice(res.message, 'ok');
      }
    } catch (err) {
      if (err.code === 'ACTIVE_WORK_RUNNING') {
        state.confirm = {
          ...confirmTarget,
          blockedWork: err.activeWork || { count: 1, items: [], truncated: false },
        };
      }
      showNotice(err.message || t('errSwitchFailed'), 'err');
    } finally {
      state.busy = false;
      render();
    }
  }

  function bindEvents() {
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

    el('oauth-toggle-btn').addEventListener('click', () => {
      const inFlow = state.oauth?.status === 'pending' || state.oauth?.status === 'exchanging';
      if (inFlow) return;
      state.oauthPanelOpen = !state.oauthPanelOpen;
      render();
    });

    el('oauth-hide-btn').addEventListener('click', () => {
      state.oauthPanelOpen = false;
      render();
    });

    el('oauth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const label = el('oauth-label').value;
      executeAction(async () => {
        const res = await apiPost('/api/oauth/start', { label });
        const oauth = res?.oauth || { status: 'idle' };
        state.oauth = oauth;
        state.oauthPanelOpen = true;
        if (oauth.status === 'pending') {
          startOAuthPolling();
          return {
            message: oauth.browserOpened ? t('noticeBrowserOpened') : t('noticeBrowserFallback'),
          };
        }
        return {};
      });
    });

    el('oauth-copy-btn').addEventListener('click', async () => {
      const authUrl = GOOGLE_AUTH_URL_RE.test(state.oauth?.authUrl || '') ? state.oauth.authUrl : '';
      if (!authUrl) return;
      const previewEl = el('oauth-url-preview');
      try {
        await navigator.clipboard.writeText(authUrl);
        showNotice(t('noticeCopied'), 'ok');
      } catch {
        previewEl.focus();
        previewEl.select();
        showNotice(t('noticeCopyRestricted'), 'err');
      }
    });

    el('oauth-cancel-btn').addEventListener('click', () => {
      stopOAuthPolling();
      executeAction(async () => {
        const res = await apiPost('/api/oauth/cancel');
        state.oauth = res?.oauth || { status: 'idle' };
        state.oauthPanelOpen = false;
        el('oauth-url-preview').value = '';
        return { message: t('noticeOAuthCancelled') };
      });
    });

    el('new-login-btn').addEventListener('click', () => {
      state.confirm = { type: 'new-login' };
      state.rename = null;
      render();
    });
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') {
      syncScheme();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    syncScheme();
    applyStaticI18n();
    bindEvents();
    refreshState(true);
  });
})();
