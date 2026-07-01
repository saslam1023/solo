/* ══════════════════════════════════════════════════════════
   CONFIG

   API_BASE: if the dashboard is served from the same origin as
   the api worker (e.g. both behind headorn.com via the router),
   leave this empty. If api.headorn.com is a separate origin,
   set it here and make sure CORS + credentials are configured
   on the worker side.
══════════════════════════════════════════════════════════ */
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.headorn.com';
/* ══════════════════════════════════════════════════════════
   FETCH HELPER
   - credentials: 'include' sends the session cookie set by the
     magic-link auth flow (Phase 3).
   - Every call funnels through here so a 401 anywhere in the
     app triggers the same "session expired" handling.
══════════════════════════════════════════════════════════ */
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    showAuthGate('Your session has expired.', true);
    throw new Error('UNAUTHENTICATED');
  }

  return res;
}

/* ══════════════════════════════════════════════════════════
   AUTH GATE
   No dedicated /me endpoint exists yet — GET /settings doubles
   as the session check on first load. A 401 here, or at any
   point later in the session, routes back to login. This is
   intentionally backed by the real session validation already
   built in Phase 3/9, not a client-side assumption.
══════════════════════════════════════════════════════════ */
function showAuthGate(message, showLoginLink) {
  document.getElementById('dash-shell').hidden = true;
  const gate = document.getElementById('auth-gate');
  const msg  = document.getElementById('auth-gate-message');
  const link = document.getElementById('auth-gate-login-link');
  gate.hidden = false;
  msg.textContent = message;
  link.hidden = !showLoginLink;
}

function showDashboard() {
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('dash-shell').hidden = false;
}

/* ══════════════════════════════════════════════════════════
   TOASTS
══════════════════════════════════════════════════════════ */
function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.textContent = message; // textContent — never innerHTML with user/server text
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */
let currentSettings = null;

/* ══════════════════════════════════════════════════════════
   LOAD SETTINGS
══════════════════════════════════════════════════════════ */
async function loadSettings() {
  const loadingEl = document.getElementById('settings-loading');
  const errorEl   = document.getElementById('settings-error');
  const formEl    = document.getElementById('settings-content');

  loadingEl.hidden = false;
  errorEl.hidden = true;
  formEl.hidden = true;

  let res;
  try {
    res = await apiFetch('/settings', { method: 'GET' });
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return; // already handled by apiFetch
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = 'Could not reach the server. Check your connection and try again.';
    return;
  }

  if (!res.ok) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = 'Could not load your settings. Please refresh the page.';
    return;
  }

  const data = await res.json();
  currentSettings = data;

  // Session confirmed valid — reveal the dashboard now, not before.
  showDashboard();

  populateSettingsForm(data);

  loadingEl.hidden = true;
  formEl.hidden = false;
}

function populateSettingsForm(data) {
  document.getElementById('f-display-name').value = data.displayName || '';
  document.getElementById('f-slug').value = data.slug || '';
  document.getElementById('f-domain').value = data.customDomain || '';

  // View store link
  const viewLink = document.getElementById('view-store-link');
  if (data.slug) {
    viewLink.href = `https://${data.slug}.headorn.com`;
  } else {
    viewLink.removeAttribute('href');
  }

  // Status pill
  const statusPill = document.getElementById('status-pill');
  statusPill.textContent = formatStatus(data.status);
  statusPill.className = 'status-pill ' + statusPillClass(data.status);

  // Connect pill
  const connectPill = document.getElementById('connect-pill');
  if (data.hasStripeConnect) {
    connectPill.textContent = 'Connected';
    connectPill.className = 'status-pill connected';
  } else {
    connectPill.textContent = 'Not connected';
    connectPill.className = 'status-pill not-connected';
  }

  // Domain verification banner
  const domainBanner = document.getElementById('domain-status-banner');
  const removeDomainBtn = document.getElementById('remove-domain-btn');
  if (data.customDomain) {
    domainBanner.hidden = false;
    domainBanner.textContent = data.customDomainVerified
      ? `${data.customDomain} is active and serving your store.`
      : `${data.customDomain} is saved but not yet verified. Domain verification is not available yet — your store address above is the only working way to reach your store for now.`;
    removeDomainBtn.hidden = false;
  } else {
    domainBanner.hidden = true;
    removeDomainBtn.hidden = true;
  }

  // Closed accounts: lock the form, keep it read-only
  const isClosed = data.status === 'closed';
  document.getElementById('save-store-btn').disabled = isClosed;
  document.getElementById('save-domain-btn').disabled = isClosed;
  document.getElementById('remove-domain-btn').disabled = isClosed;
  document.getElementById('open-close-account-btn').disabled = isClosed;
  if (isClosed) {
    document.getElementById('f-display-name').disabled = true;
    document.getElementById('f-slug').disabled = true;
    document.getElementById('f-domain').disabled = true;
  }
}

function formatStatus(status) {
  const map = {
    pending_products: 'Setting up — add products',
    ready: 'Ready',
    live: 'Live',
    closed: 'Closed',
  };
  return map[status] || status || 'Unknown';
}

function statusPillClass(status) {
  if (status === 'live' || status === 'ready') return 'live';
  if (status === 'closed') return 'closed';
  return 'pending';
}

/* ══════════════════════════════════════════════════════════
   SAVE STORE DETAILS (name + slug)
══════════════════════════════════════════════════════════ */
function clearFieldError(inputId, errorId) {
  document.getElementById(inputId).removeAttribute('aria-invalid');
  const el = document.getElementById(errorId);
  el.hidden = true;
  el.textContent = '';
}

function setFieldError(inputId, errorId, message) {
  document.getElementById(inputId).setAttribute('aria-invalid', 'true');
  const el = document.getElementById(errorId);
  el.hidden = false;
  el.textContent = message;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

document.getElementById('settings-content').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFieldError('f-display-name', 'err-display-name');
  clearFieldError('f-slug', 'err-slug');

  const displayName = document.getElementById('f-display-name').value.trim();
  const slug = document.getElementById('f-slug').value.trim().toLowerCase();
  const statusEl = document.getElementById('store-save-status');

  let hasError = false;
  if (!displayName) {
    setFieldError('f-display-name', 'err-display-name', 'Store name is required.');
    hasError = true;
  }
  if (slug.length < 3 || slug.length > 63 || !SLUG_PATTERN.test(slug)) {
    setFieldError('f-slug', 'err-slug', 'Use 3–63 lowercase letters, numbers, or hyphens. Cannot start or end with a hyphen.');
    hasError = true;
  }
  if (hasError) return;

  const btn = document.getElementById('save-store-btn');
  btn.disabled = true;
  statusEl.textContent = 'Saving…';
  statusEl.className = 'field-status';

  // Only send fields that actually changed
  const body = {};
  if (displayName !== (currentSettings.displayName || '')) body.displayName = displayName;
  if (slug !== (currentSettings.slug || '')) body.slug = slug;

  if (Object.keys(body).length === 0) {
    statusEl.textContent = 'No changes to save.';
    btn.disabled = false;
    return;
  }

  try {
    const res = await apiFetch('/settings/store', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.error && /slug/i.test(data.error)) {
        setFieldError('f-slug', 'err-slug', data.error);
      }
      statusEl.textContent = data.error || 'Could not save changes.';
      statusEl.className = 'field-status error';
      btn.disabled = false;
      return;
    }

    currentSettings = { ...currentSettings, ...data };
    populateSettingsForm(currentSettings);
    statusEl.textContent = 'Saved.';
    statusEl.className = 'field-status success';
    showToast('Store details saved');
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    statusEl.textContent = 'Could not reach the server. Please try again.';
    statusEl.className = 'field-status error';
  } finally {
    btn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════
   SAVE / REMOVE CUSTOM DOMAIN
══════════════════════════════════════════════════════════ */
document.getElementById('save-domain-btn').addEventListener('click', async () => {
  clearFieldError('f-domain', 'err-domain');
  const domain = document.getElementById('f-domain').value.trim().toLowerCase();
  const statusEl = document.getElementById('domain-save-status');
  const btn = document.getElementById('save-domain-btn');

  if (!domain) {
    setFieldError('f-domain', 'err-domain', 'Enter a domain, or use "Remove domain" instead.');
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Saving…';
  statusEl.className = 'field-status';

  try {
    const res = await apiFetch('/settings/domain', {
      method: 'PATCH',
      body: JSON.stringify({ customDomain: domain }),
    });
    const data = await res.json();

    if (!res.ok) {
      setFieldError('f-domain', 'err-domain', data.error || 'Could not save domain.');
      statusEl.textContent = '';
      btn.disabled = false;
      return;
    }

    currentSettings = { ...currentSettings, ...data };
    populateSettingsForm(currentSettings);
    statusEl.textContent = 'Saved.';
    statusEl.className = 'field-status success';
    showToast('Domain saved');
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    statusEl.textContent = 'Could not reach the server. Please try again.';
    statusEl.className = 'field-status error';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('remove-domain-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('domain-save-status');
  const btn = document.getElementById('remove-domain-btn');
  btn.disabled = true;
  statusEl.textContent = 'Removing…';
  statusEl.className = 'field-status';

  try {
    const res = await apiFetch('/settings/domain', {
      method: 'PATCH',
      body: JSON.stringify({ customDomain: null }),
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || 'Could not remove domain.';
      statusEl.className = 'field-status error';
      btn.disabled = false;
      return;
    }

    currentSettings = { ...currentSettings, ...data };
    populateSettingsForm(currentSettings);
    document.getElementById('f-domain').value = '';
    statusEl.textContent = 'Domain removed.';
    statusEl.className = 'field-status success';
    showToast('Domain removed');
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    statusEl.textContent = 'Could not reach the server. Please try again.';
    statusEl.className = 'field-status error';
  } finally {
    btn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════
   ACCOUNT CLOSURE — typed-slug confirmation
══════════════════════════════════════════════════════════ */
const closeModal = document.getElementById('close-account-modal');

function openCloseAccountModal() {
  const slug = currentSettings?.slug || '';
  document.getElementById('close-confirm-slug').textContent = slug;
  document.getElementById('close-confirm-input').value = '';
  document.getElementById('close-modal-confirm').disabled = true;
  document.getElementById('close-confirm-error').hidden = true;
  document.getElementById('close-account-error').hidden = true;
  closeModal.hidden = false;
  document.getElementById('close-confirm-input').focus();
}

function closeCloseAccountModal() {
  closeModal.hidden = true;
}

document.getElementById('open-close-account-btn').addEventListener('click', openCloseAccountModal);
document.getElementById('close-modal-x').addEventListener('click', closeCloseAccountModal);
document.getElementById('close-modal-cancel').addEventListener('click', closeCloseAccountModal);
closeModal.addEventListener('click', (e) => { if (e.target === closeModal) closeCloseAccountModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !closeModal.hidden) closeCloseAccountModal();
});

document.getElementById('close-confirm-input').addEventListener('input', (e) => {
  const expected = currentSettings?.slug || '';
  const matches = e.target.value === expected;
  document.getElementById('close-modal-confirm').disabled = !matches;
});

document.getElementById('close-modal-confirm').addEventListener('click', async () => {
  const expected = currentSettings?.slug || '';
  const typed = document.getElementById('close-confirm-input').value;
  const errorEl = document.getElementById('close-account-error');

  if (typed !== expected) {
    document.getElementById('close-confirm-error').hidden = false;
    document.getElementById('close-confirm-error').textContent = 'This does not match your store address.';
    return;
  }

  const btn = document.getElementById('close-modal-confirm');
  btn.disabled = true;
  btn.textContent = 'Closing account…';
  errorEl.hidden = true;

  try {
    const res = await apiFetch('/account', { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) {
      // Fails closed server-side on Stripe errors — surface that message exactly,
      // since it tells the merchant their account was NOT closed.
      errorEl.hidden = false;
      errorEl.textContent = data.error || 'Could not close your account. Please try again or contact support.';
      btn.disabled = false;
      btn.textContent = 'Permanently close account';
      return;
    }

    closeCloseAccountModal();
    showAuthGate('Your account has been closed.', true);
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    errorEl.hidden = false;
    errorEl.textContent = 'Could not reach the server. Your account has not been closed — please try again.';
    btn.disabled = false;
    btn.textContent = 'Permanently close account';
  }
});

/* ══════════════════════════════════════════════════════════
   LOGOUT
   No dedicated logout endpoint has been confirmed yet in this
   build. This clears the client-visible state and sends the
   person to /login; if the session cookie is HttpOnly (likely,
   given Phase 3's design), it can only be invalidated server-side
   — flag a POST /logout (or equivalent) endpoint as a follow-up
   if one doesn't already exist.
══════════════════════════════════════════════════════════ */
document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await apiFetch('/logout', { method: 'POST' });
  } catch {
    // Best-effort — proceed to login regardless, since the goal
    // is getting the person off this page either way.
  }
  window.location.href = '/login';
});

/* ══════════════════════════════════════════════════════════
   NAV TABS (Products / Orders wired in later phases)
══════════════════════════════════════════════════════════ */
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.disabled) return;
    document.querySelectorAll('.nav-tab').forEach((t) => {
      t.classList.remove('active');
      t.removeAttribute('aria-current');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-current', 'page');

    const section = tab.dataset.section;
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    document.getElementById(`section-${section}`).classList.add('active');
  });
});

/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
loadSettings();
