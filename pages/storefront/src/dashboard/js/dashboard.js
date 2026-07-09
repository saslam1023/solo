/* ══════════════════════════════════════════════════════════
   CONFIG

   API_BASE: if the dashboard is served from the same origin as
   the api worker (e.g. both behind headorn.com via the router),
   leave this empty. If api.headorn.com is a separate origin,
   set it here and make sure CORS + credentials are configured
   on the worker side.
══════════════════════════════════════════════════════════ */
// Same-origin: the router forwards this page AND every API route
// (/settings, /products, /orders, /auth) to the correct backend, so
// there is no cross-origin request anywhere in this flow — no CORS,
// no cross-site cookie handling. This also keeps the __Host- session
// cookie correctly scoped to the tenant subdomain that set it.
const API_BASE = '';
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
   PRODUCTS — Phase 10b

   Security note: every render function below builds DOM with
   createElement + textContent, never innerHTML with server/user
   data — same rule as the toast helper above. innerHTML is only
   ever used for static, hardcoded markup we wrote ourselves
   (there isn't any in this section).
══════════════════════════════════════════════════════════ */
let currentProducts = [];
let productsLoaded = false;
let editingProductId = null;
let pfVariantRowCount = 0;

function penceToPoundsStr(pence) {
  return (pence / 100).toFixed(2);
}

function poundsStrToPence(str) {
  if (str === '' || str === null || str === undefined) return NaN;
  return Math.round(parseFloat(str) * 100);
}

function replaceProductInState(updatedProduct) {
  const idx = currentProducts.findIndex((p) => p.id === updatedProduct.id);
  if (idx === -1) {
    currentProducts.push(updatedProduct);
  } else {
    currentProducts[idx] = updatedProduct;
  }
}

/* ── Small DOM builder helper — attrs are set via setAttribute,
   text via textContent. No HTML string parsing involved. ── */
function makeLabelledInput(labelText, fieldName, uid, inputAttrs, value, disabled) {
  const wrap = document.createElement('div');
  wrap.className = 'v-field';
  const inputId = `f-${fieldName}-${uid}`;
  const label = document.createElement('label');
  label.className = 'v-label';
  label.textContent = labelText;
  label.htmlFor = inputId;
  const input = document.createElement('input');
  input.className = 'settings-input v-input';
  input.id = inputId;
  input.dataset.field = fieldName;
  Object.entries(inputAttrs).forEach(([k, v]) => input.setAttribute(k, v));
  input.value = value;
  if (disabled) input.disabled = true;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return { wrap, input };
}

/* ══════════════════════════════════════════════════════════
   LOAD + RENDER PRODUCT LIST
══════════════════════════════════════════════════════════ */
async function loadProducts() {
  const loadingEl = document.getElementById('products-loading');
  const errorEl = document.getElementById('products-error');
  const listEl = document.getElementById('products-list');
  const emptyEl = document.getElementById('products-empty');

  loadingEl.hidden = false;
  errorEl.hidden = true;
  listEl.hidden = true;
  emptyEl.hidden = true;

  let res;
  try {
    res = await apiFetch('/products', { method: 'GET' });
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = 'Could not reach the server. Check your connection and try again.';
    return;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = data.error || 'Could not load your products. Please refresh the page.';
    return;
  }

  // handleListProducts returns a bare array, not { products, total }.
  currentProducts = await res.json();
  productsLoaded = true;
  loadingEl.hidden = true;
  renderProductList();
}

function renderProductList() {
  const listEl = document.getElementById('products-list');
  const emptyEl = document.getElementById('products-empty');

  listEl.innerHTML = ''; // clearing only — safe, no data involved

  if (currentProducts.length === 0) {
    listEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;
  listEl.hidden = false;
  currentProducts.forEach((product) => listEl.appendChild(buildProductCard(product)));
}

function buildProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card' + (product.status === 'archived' ? ' is-archived' : '');
  card.dataset.productId = product.id;

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'product-card-header';

  const headerLeft = document.createElement('div');
  const nameEl = document.createElement('h3');
  nameEl.className = 'product-card-name';
  nameEl.textContent = product.name;
  const descEl = document.createElement('p');
  descEl.className = 'product-card-desc';
  descEl.textContent = product.description;
  const meta = document.createElement('div');
  meta.className = 'product-card-meta';
  const statusPill = document.createElement('span');
  statusPill.className = 'status-pill ' + (product.status === 'active' ? 'live' : 'closed');
  statusPill.textContent = product.status === 'active' ? 'Active' : 'Archived';
  const typeBadge = document.createElement('span');
  typeBadge.className = 'type-badge';
  typeBadge.textContent = product.type === 'physical' ? 'Physical' : 'Digital';
  meta.appendChild(statusPill);
  meta.appendChild(typeBadge);
  headerLeft.appendChild(nameEl);
  headerLeft.appendChild(descEl);
  headerLeft.appendChild(meta);
  header.appendChild(headerLeft);

  const actions = document.createElement('div');
  actions.className = 'product-card-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-secondary';
  editBtn.textContent = 'Edit details';
  editBtn.addEventListener('click', () => openProductModal(product));
  actions.appendChild(editBtn);

  if (product.status === 'active') {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'btn btn-danger';
    archiveBtn.textContent = 'Archive product';
    archiveBtn.addEventListener('click', () => confirmArchiveProduct(product));
    actions.appendChild(archiveBtn);
  }
  header.appendChild(actions);
  card.appendChild(header);

  // ── Images ──
  const imagesWrap = document.createElement('div');
  imagesWrap.className = 'product-images';
  (product.imageUrls || []).forEach((url) => {
    const thumb = document.createElement('div');
    thumb.className = 'product-image-thumb';
    const img = document.createElement('img');
    img.src = url; // attribute assignment, not HTML parsing — safe
    img.alt = '';
    thumb.appendChild(img);
    imagesWrap.appendChild(thumb);
  });

  if (product.status === 'active') {
    const uploadStatus = document.createElement('p');
    uploadStatus.className = 'field-status image-upload-status';
    uploadStatus.setAttribute('role', 'status');
    uploadStatus.setAttribute('aria-live', 'polite');

    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'image-upload-btn btn btn-secondary';
    uploadLabel.appendChild(document.createTextNode('Add image'));
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
    fileInput.className = 'image-upload-input';
    fileInput.setAttribute('aria-label', `Upload an image for ${product.name}`);
    fileInput.addEventListener('change', (e) => {
      handleImageUpload(product, e.target.files[0], uploadStatus);
      e.target.value = ''; // allow re-selecting the same file later
    });
    uploadLabel.appendChild(fileInput);

    imagesWrap.appendChild(uploadLabel);
    imagesWrap.appendChild(uploadStatus);
  }
  card.appendChild(imagesWrap);

  // ── Variants ──
  const variantsWrap = document.createElement('div');
  variantsWrap.className = 'variants-wrap';
  const heading = document.createElement('div');
  heading.className = 'variants-heading';
  heading.textContent = 'Variants';
  variantsWrap.appendChild(heading);
  product.variants.forEach((variant) => variantsWrap.appendChild(buildVariantRow(product, variant)));
  card.appendChild(variantsWrap);

  return card;
}

function buildVariantRow(product, variant) {
  const isArchived = variant.status === 'archived';
  const row = document.createElement('div');
  row.className = 'variant-row' + (isArchived ? ' is-archived' : '');
  row.dataset.variantId = variant.id;

  const fields = document.createElement('div');
  fields.className = 'variant-row-fields';

  const skuF = makeLabelledInput('SKU', 'sku', variant.id, { type: 'text' }, variant.sku || '', isArchived);
  const colourF = makeLabelledInput('Colour', 'colour', variant.id, { type: 'text' }, variant.colour || '', isArchived);
  const sizeF = makeLabelledInput('Size', 'size', variant.id, { type: 'text' }, variant.size || '', isArchived);
  fields.appendChild(skuF.wrap);
  fields.appendChild(colourF.wrap);
  fields.appendChild(sizeF.wrap);

  let weightF = null;
  if (product.type === 'physical') {
    weightF = makeLabelledInput(
      'Weight (g)', 'weightG', variant.id,
      { type: 'number', min: '0', step: '1' },
      variant.weightG != null ? String(variant.weightG) : '',
      isArchived
    );
    fields.appendChild(weightF.wrap);
  }

  const priceF = makeLabelledInput(
    'Price (£)', 'pricePence', variant.id,
    { type: 'number', min: '0.01', step: '0.01', required: 'required' },
    penceToPoundsStr(variant.pricePence),
    isArchived
  );
  const stockF = makeLabelledInput(
    'Stock', 'stock', variant.id,
    { type: 'number', min: '0', step: '1', required: 'required' },
    String(variant.stock),
    isArchived
  );
  fields.appendChild(priceF.wrap);
  fields.appendChild(stockF.wrap);
  row.appendChild(fields);

  const footer = document.createElement('div');
  footer.className = 'variant-row-footer';

  const statusPill = document.createElement('span');
  statusPill.className = 'status-pill ' + (isArchived ? 'closed' : 'live');
  statusPill.textContent = isArchived ? 'Archived' : 'Active';
  footer.appendChild(statusPill);

  const statusMsg = document.createElement('p');
  statusMsg.className = 'field-status v-status';
  statusMsg.setAttribute('role', 'status');
  statusMsg.setAttribute('aria-live', 'polite');
  footer.appendChild(statusMsg);

  const buttons = document.createElement('div');
  buttons.className = 'variant-row-buttons';

  if (!isArchived) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () =>
      saveVariant(
        product, variant,
        { sku: skuF.input, colour: colourF.input, size: sizeF.input, weightG: weightF ? weightF.input : null, pricePence: priceF.input, stock: stockF.input },
        statusMsg, saveBtn
      )
    );
    buttons.appendChild(saveBtn);

    const activeCount = product.variants.filter((v) => v.status === 'active').length;
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'btn btn-danger';
    archiveBtn.textContent = 'Archive';
    if (activeCount <= 1) {
      archiveBtn.disabled = true;
      archiveBtn.title = 'Cannot archive the last active variant — archive the whole product instead.';
    } else {
      archiveBtn.addEventListener('click', () => confirmArchiveVariant(product, variant));
    }
    buttons.appendChild(archiveBtn);
  }
  footer.appendChild(buttons);
  row.appendChild(footer);

  return row;
}

/* ══════════════════════════════════════════════════════════
   SAVE VARIANT (inline, per-row)
══════════════════════════════════════════════════════════ */
async function saveVariant(product, variant, inputs, statusMsg, saveBtn) {
  statusMsg.textContent = '';
  statusMsg.className = 'field-status v-status';

  const sku = inputs.sku.value.trim();
  const colour = inputs.colour.value.trim();
  const size = inputs.size.value.trim();
  const priceStr = inputs.pricePence.value.trim();
  const stockStr = inputs.stock.value.trim();

  const pricePence = poundsStrToPence(priceStr);
  if (!priceStr || isNaN(pricePence) || pricePence < 1) {
    statusMsg.textContent = 'Enter a valid price.';
    statusMsg.className = 'field-status v-status error';
    return;
  }

  const stock = parseInt(stockStr, 10);
  if (stockStr === '' || isNaN(stock) || stock < 0 || !Number.isInteger(stock)) {
    statusMsg.textContent = 'Enter a valid stock quantity (0 or more).';
    statusMsg.className = 'field-status v-status error';
    return;
  }

  const body = {};
  if (sku !== (variant.sku || '')) body.sku = sku;
  if (colour !== (variant.colour || '')) body.colour = colour;
  if (size !== (variant.size || '')) body.size = size;
  if (pricePence !== variant.pricePence) body.pricePence = pricePence;
  if (stock !== variant.stock) body.stock = stock;

  if (inputs.weightG) {
    const weightStr = inputs.weightG.value.trim();
    if (weightStr !== '') {
      const weightG = parseInt(weightStr, 10);
      if (isNaN(weightG) || weightG < 0 || !Number.isInteger(weightG)) {
        statusMsg.textContent = 'Enter a valid weight in grams.';
        statusMsg.className = 'field-status v-status error';
        return;
      }
      if (weightG !== variant.weightG) body.weightG = weightG;
    }
  }

  if (Object.keys(body).length === 0) {
    statusMsg.textContent = 'No changes to save.';
    return;
  }

  saveBtn.disabled = true;
  statusMsg.textContent = 'Saving…';

  try {
    const res = await apiFetch(`/products/${product.id}/variants/${variant.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      statusMsg.textContent = data.error || 'Could not save changes.';
      statusMsg.className = 'field-status v-status error';
      saveBtn.disabled = false;
      return;
    }

    replaceProductInState(data);
    renderProductList();
    showToast('Variant saved');
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    statusMsg.textContent = 'Could not reach the server. Please try again.';
    statusMsg.className = 'field-status v-status error';
    saveBtn.disabled = false;
  }
}

/* ══════════════════════════════════════════════════════════
   IMAGE UPLOAD
   Backend expects a raw binary body with Content-Type set to
   the image mime type — not multipart/FormData.
══════════════════════════════════════════════════════════ */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function handleImageUpload(product, file, statusEl) {
  if (!file) return;

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    statusEl.textContent = 'Unsupported image type. Use JPEG, PNG, WebP, or GIF.';
    statusEl.className = 'field-status image-upload-status error';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    statusEl.textContent = 'Image is too large (max 5MB).';
    statusEl.className = 'field-status image-upload-status error';
    return;
  }

  statusEl.textContent = 'Uploading…';
  statusEl.className = 'field-status image-upload-status';

  try {
    const res = await apiFetch(`/products/${product.id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || 'Could not upload image.';
      statusEl.className = 'field-status image-upload-status error';
      return;
    }

    replaceProductInState(data.product);
    renderProductList();
    showToast('Image uploaded');
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    statusEl.textContent = 'Could not reach the server. Please try again.';
    statusEl.className = 'field-status image-upload-status error';
  }
}

/* ══════════════════════════════════════════════════════════
   GENERIC ARCHIVE-CONFIRM MODAL
   Reused for both product and variant archiving. The confirm
   button is cloned on each open to drop any previously-bound
   listener rather than accumulating them.
══════════════════════════════════════════════════════════ */
function openConfirmModal({ title, message, confirmLabel, onConfirm }) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-message').textContent = message;
  document.getElementById('confirm-modal-error').hidden = true;

  const oldBtn = document.getElementById('confirm-modal-confirm');
  const freshBtn = oldBtn.cloneNode(true);
  freshBtn.textContent = confirmLabel;
  freshBtn.disabled = false;
  oldBtn.parentNode.replaceChild(freshBtn, oldBtn);

  freshBtn.addEventListener('click', async () => {
    freshBtn.disabled = true;
    freshBtn.textContent = 'Working…';
    const errorEl = document.getElementById('confirm-modal-error');
    errorEl.hidden = true;
    try {
      await onConfirm();
      closeConfirmModal();
    } catch (err) {
      if (err.message === 'UNAUTHENTICATED') return;
      errorEl.hidden = false;
      errorEl.textContent = err.message || 'Something went wrong. Please try again.';
      freshBtn.disabled = false;
      freshBtn.textContent = confirmLabel;
    }
  });

  document.getElementById('confirm-modal').hidden = false;
  freshBtn.focus();
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').hidden = true;
}

document.getElementById('confirm-modal-x').addEventListener('click', closeConfirmModal);
document.getElementById('confirm-modal-cancel').addEventListener('click', closeConfirmModal);
document.getElementById('confirm-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('confirm-modal')) closeConfirmModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('confirm-modal').hidden) closeConfirmModal();
});

function confirmArchiveProduct(product) {
  openConfirmModal({
    title: 'Archive this product?',
    message: `"${product.name}" and all its variants will be archived and removed from your storefront. This cannot be undone.`,
    confirmLabel: 'Archive product',
    onConfirm: async () => {
      const res = await apiFetch(`/products/${product.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not archive product.');
      replaceProductInState(data);
      renderProductList();
      showToast('Product archived');
    },
  });
}

function confirmArchiveVariant(product, variant) {
  openConfirmModal({
    title: 'Archive this variant?',
    message: `This variant of "${product.name}" will stop being available to buyers. This cannot be undone.`,
    confirmLabel: 'Archive variant',
    onConfirm: async () => {
      const res = await apiFetch(`/products/${product.id}/variants/${variant.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not archive variant.');
      replaceProductInState(data);
      renderProductList();
      showToast('Variant archived');
    },
  });
}

/* ══════════════════════════════════════════════════════════
   ADD / EDIT PRODUCT MODAL
══════════════════════════════════════════════════════════ */
function currentPfType() {
  const checked = document.querySelector('input[name="pf-type"]:checked');
  return checked ? checked.value : 'physical';
}

function openProductModal(product) {
  editingProductId = product ? product.id : null;
  document.getElementById('product-modal-title').textContent = product ? 'Edit product' : 'Add product';
  document.getElementById('product-form-error').hidden = true;
  document.getElementById('product-form-status').textContent = '';
  clearFieldError('pf-name', 'pf-err-name');
  clearFieldError('pf-description', 'pf-err-description');
  document.getElementById('pf-err-variants').hidden = true;

  document.getElementById('pf-name').value = product ? product.name : '';
  document.getElementById('pf-description').value = product ? product.description : '';
  document.getElementById('pf-materials').value = product ? (product.materials || []).join(', ') : '';
  document.getElementById('pf-tags').value = product ? (product.tags || []).join(', ') : '';

  document.querySelectorAll('input[name="pf-type"]').forEach((r) => {
    r.checked = product ? r.value === product.type : r.value === 'physical';
    r.disabled = !!product; // immutable once created — backend has no route to change it
  });
  document.getElementById('pf-type-locked-hint').hidden = !product;

  const variantsSection = document.getElementById('pf-variants-section');
  const variantRows = document.getElementById('pf-variant-rows');
  variantRows.innerHTML = ''; // clearing only
  pfVariantRowCount = 0;

  if (product) {
    // Existing variants are edited inline in the product card — the
    // backend has no "add variant to an existing product" route.
    variantsSection.hidden = true;
  } else {
    variantsSection.hidden = false;
    addVariantRow();
  }

  document.getElementById('product-modal').hidden = false;
  document.getElementById('pf-name').focus();
}

function closeProductModal() {
  document.getElementById('product-modal').hidden = true;
}

document.getElementById('add-product-btn').addEventListener('click', () => openProductModal(null));
document.getElementById('product-modal-x').addEventListener('click', closeProductModal);
document.getElementById('product-modal-cancel').addEventListener('click', closeProductModal);
document.getElementById('product-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('product-modal')) closeProductModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('product-modal').hidden) closeProductModal();
});

document.getElementById('pf-add-variant-btn').addEventListener('click', () => addVariantRow());
document.querySelectorAll('input[name="pf-type"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const isPhysical = currentPfType() === 'physical';
    document.querySelectorAll('.pf-weight-field').forEach((f) => { f.hidden = !isPhysical; });
  });
});

function addVariantRow() {
  pfVariantRowCount++;
  const rowId = `new-${pfVariantRowCount}`;
  const row = document.createElement('div');
  row.className = 'pf-variant-row';
  row.dataset.rowId = rowId;

  const fields = document.createElement('div');
  fields.className = 'pf-variant-row-fields';

  const skuF = makeLabelledInput('SKU', 'sku', rowId, { type: 'text' }, '', false);
  const colourF = makeLabelledInput('Colour', 'colour', rowId, { type: 'text' }, '', false);
  const sizeF = makeLabelledInput('Size', 'size', rowId, { type: 'text' }, '', false);
  fields.appendChild(skuF.wrap);
  fields.appendChild(colourF.wrap);
  fields.appendChild(sizeF.wrap);

  const weightF = makeLabelledInput('Weight (g)', 'weightG', rowId, { type: 'number', min: '0', step: '1' }, '', false);
  weightF.wrap.classList.add('pf-weight-field');
  weightF.wrap.hidden = currentPfType() !== 'physical';
  fields.appendChild(weightF.wrap);

  const priceF = makeLabelledInput('Price (£)', 'pricePence', rowId, { type: 'number', min: '0.01', step: '0.01', required: 'required' }, '', false);
  const stockF = makeLabelledInput('Stock', 'stock', rowId, { type: 'number', min: '0', step: '1' }, '', false);
  fields.appendChild(priceF.wrap);
  fields.appendChild(stockF.wrap);
  row.appendChild(fields);

  const footer = document.createElement('div');
  footer.className = 'pf-variant-row-footer';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-secondary';
  removeBtn.textContent = 'Remove variant';
  removeBtn.setAttribute('aria-label', 'Remove this variant');
  removeBtn.addEventListener('click', () => {
    if (document.querySelectorAll('.pf-variant-row').length <= 1) {
      showToast('At least one variant is required', true);
      return;
    }
    row.remove();
  });
  footer.appendChild(removeBtn);
  row.appendChild(footer);

  document.getElementById('pf-variant-rows').appendChild(row);
}

document.getElementById('product-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const errorBanner = document.getElementById('product-form-error');
  const statusEl = document.getElementById('product-form-status');
  const saveBtn = document.getElementById('product-modal-save');
  errorBanner.hidden = true;
  statusEl.textContent = '';
  clearFieldError('pf-name', 'pf-err-name');
  clearFieldError('pf-description', 'pf-err-description');
  document.getElementById('pf-err-variants').hidden = true;

  const name = document.getElementById('pf-name').value.trim();
  const description = document.getElementById('pf-description').value.trim();
  const materials = document.getElementById('pf-materials').value.split(',').map((s) => s.trim()).filter(Boolean);
  const tags = document.getElementById('pf-tags').value.split(',').map((s) => s.trim()).filter(Boolean);

  let hasError = false;
  if (!name) {
    setFieldError('pf-name', 'pf-err-name', 'Product name is required.');
    hasError = true;
  }
  if (!description) {
    setFieldError('pf-description', 'pf-err-description', 'Description is required.');
    hasError = true;
  }
  if (hasError) return;

  if (editingProductId) {
    // ── EDIT: name/description/materials/tags only — no variants here ──
    const product = currentProducts.find((p) => p.id === editingProductId);
    const body = {};
    if (product && name !== product.name) body.name = name;
    if (product && description !== product.description) body.description = description;
    if (!product || JSON.stringify(materials) !== JSON.stringify(product.materials || [])) body.materials = materials;
    if (!product || JSON.stringify(tags) !== JSON.stringify(product.tags || [])) body.tags = tags;

    if (Object.keys(body).length === 0) {
      statusEl.textContent = 'No changes to save.';
      return;
    }

    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';

    try {
      const res = await apiFetch(`/products/${editingProductId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        errorBanner.hidden = false;
        errorBanner.textContent = data.error || 'Could not save changes.';
        statusEl.textContent = '';
        return;
      }
      replaceProductInState(data);
      renderProductList();
      closeProductModal();
      showToast('Product updated');
    } catch (err) {
      if (err.message === 'UNAUTHENTICATED') return;
      errorBanner.hidden = false;
      errorBanner.textContent = 'Could not reach the server. Please try again.';
    } finally {
      saveBtn.disabled = false;
    }
    return;
  }

  // ── CREATE: full product + variants ──
  const type = currentPfType();
  const variantRows = document.querySelectorAll('.pf-variant-row');
  const variants = [];
  let variantError = variantRows.length === 0 ? 'At least one variant is required.' : null;

  variantRows.forEach((row, idx) => {
    if (variantError) return;
    const get = (field) => row.querySelector(`[data-field="${field}"]`);
    const skuVal = get('sku')?.value.trim() || undefined;
    const colourVal = get('colour')?.value.trim() || undefined;
    const sizeVal = get('size')?.value.trim() || undefined;
    const priceStr = get('pricePence')?.value.trim() || '';
    const stockStr = get('stock')?.value.trim() || '';
    const weightStr = type === 'physical' ? (get('weightG')?.value.trim() || '') : '';

    const pricePence = poundsStrToPence(priceStr);
    if (!priceStr || isNaN(pricePence) || pricePence < 1) {
      variantError = `Variant ${idx + 1}: enter a valid price.`;
      return;
    }

    let stock = 0;
    if (stockStr !== '') {
      stock = parseInt(stockStr, 10);
      if (isNaN(stock) || stock < 0 || !Number.isInteger(stock)) {
        variantError = `Variant ${idx + 1}: stock must be 0 or more.`;
        return;
      }
    }

    let weightG;
    if (weightStr !== '') {
      weightG = parseInt(weightStr, 10);
      if (isNaN(weightG) || weightG < 0 || !Number.isInteger(weightG)) {
        variantError = `Variant ${idx + 1}: weight must be 0 or more.`;
        return;
      }
    }

    variants.push({ sku: skuVal, colour: colourVal, size: sizeVal, weightG, stock, pricePence });
  });

  if (variantError) {
    document.getElementById('pf-err-variants').hidden = false;
    document.getElementById('pf-err-variants').textContent = variantError;
    return;
  }

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving…';

  try {
    const res = await apiFetch('/products', {
      method: 'POST',
      body: JSON.stringify({ name, description, type, materials, tags, variants }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorBanner.hidden = false;
      errorBanner.textContent = data.error || 'Could not create product.';
      statusEl.textContent = '';
      return;
    }

    // Response is the created product, optionally with a `warning` field
    // (approaching/at the product limit — see checkProductLimit server-side).
    const { warning, ...product } = data;
    currentProducts.push(product);
    renderProductList();
    closeProductModal();
    showToast('Product created');

    if (warning) {
      const limitBanner = document.getElementById('products-limit-banner');
      limitBanner.hidden = false;
      limitBanner.textContent = warning;
    }
  } catch (err) {
    if (err.message === 'UNAUTHENTICATED') return;
    errorBanner.hidden = false;
    errorBanner.textContent = 'Could not reach the server. Please try again.';
  } finally {
    saveBtn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════
   LOGOUT
   POST /auth/logout (confirmed in workers/api/src/routes/auth.ts)
   clears the server-side session and the __Host- cookie. Best-effort:
   if the request fails we still redirect to /login, since the goal
   is getting the person off this page either way.
══════════════════════════════════════════════════════════ */
document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {
    // Best-effort — proceed to login regardless, since the goal
    // is getting the person off this page either way.
  }
  window.location.href = '/login';
});

/* ══════════════════════════════════════════════════════════
   NAV TABS
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

    if (section === 'products' && !productsLoaded) {
      loadProducts();
    }
  });
});

/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
loadSettings();
