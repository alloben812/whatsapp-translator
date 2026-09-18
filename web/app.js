const $ = (id) => document.getElementById(id);
const PENDING_STORAGE = 'razgovor.pending.v1';
const SELECTED_STORAGE = 'razgovor.selected.v1';
const POLL_DELAY = 1500;
let state = null;
let selectedId = readStorage(SELECTED_STORAGE) || null;
let pending = readPending();
let sending = false;
let connecting = false;
let savingContact = false;
let polling = null;
let pollTimer = null;
let toastTimer = null;
let contactFingerprint = '';
let messageFingerprint = '';
let loginRequired = false;
let firstState = true;
const drafts = new Map();

function readStorage(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* Private browser modes may make storage unavailable. */ }
}

function readPending() {
  try {
    const value = JSON.parse(readStorage(PENDING_STORAGE) || 'null');
    if (value && typeof value.contactId === 'string' && typeof value.text === 'string'
      && typeof value.idempotencyKey === 'string' && typeof value.createdAt === 'string') return value;
  } catch { /* A stale or malformed local draft is not an instruction. */ }
  return null;
}

function savePending(value) {
  pending = value;
  writeStorage(PENDING_STORAGE, value ? JSON.stringify(value) : null);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function phone(id) { return `+${String(id).split('@')[0]}`; }
function initials(name) { return name.trim().split(/\s+/u).slice(0, 2).map((part) => Array.from(part)[0] || '').join('').toLocaleUpperCase('ru'); }
function contactFor(id) { return state?.contacts.find((contact) => contact.id === id); }
function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function readableError(code) {
  const messages = {
    unauthorized: 'Введите пароль, чтобы открыть чаты.',
    invalid_password: 'Пароль не подошёл. Попробуйте ещё раз.',
    invalid_credentials: 'Пароль не подошёл. Попробуйте ещё раз.',
    csrf_invalid: 'Страница обновляется. Повторите действие через несколько секунд.',
    invalid_csrf: 'Страница обновляется. Повторите действие через несколько секунд.',
    forbidden: 'Сессия устарела. Обновите страницу.',
    whatsapp_not_connected: 'Подключите WhatsApp, чтобы отправить сообщение.',
    whatsapp_unavailable: 'Сначала подключите WhatsApp и дождитесь соединения.',
    transport_not_connected: 'Подключите WhatsApp, чтобы отправить сообщение.',
    not_connected: 'Соединение с WhatsApp потеряно. Подключите его снова.',
    translator_unavailable: 'Переводчик пока недоступен. Попробуйте немного позже.',
    translation_unavailable: 'Переводчик пока недоступен. Попробуйте немного позже.',
    translator_not_ready: 'Переводчик пока недоступен. Попробуйте немного позже.',
    translation_failed: 'Не удалось перевести сообщение.',
    translation_empty: 'Переводчик вернул пустой ответ. Сообщение не отправлено.',
    invalid_contact: 'Проверьте имя и номер телефона с кодом страны.',
    invalid_phone: 'Укажите международный номер с кодом страны, например +381 64 123 4567.',
    invalid_request: 'Проверьте заполненные поля.',
    invalid_input: 'Проверьте имя, номер телефона и текст сообщения.',
    validation_error: 'Проверьте заполненные поля.',
    unknown_contact: 'Собеседник не найден. Выберите его ещё раз.',
    contact_not_found: 'Этот номер не найден в WhatsApp. Проверьте код страны и номер.',
    contact_exists: 'Этот собеседник уже есть в списке чатов.',
    invalid_text: 'Введите текст сообщения.',
    empty_text: 'Введите текст сообщения.',
    message_too_long: 'Сообщение слишком длинное. Разделите его на несколько частей.',
    idempotency_conflict: 'Этот запрос уже использован для другого сообщения. Обновите страницу.',
    delivery_unknown: 'Результат отправки неизвестен. Проверьте сообщение в WhatsApp перед повтором.',
    rate_limited: 'Слишком много попыток. Подождите немного и попробуйте снова.',
    too_many_requests: 'Слишком много попыток. Подождите немного и попробуйте снова.',
    retry_not_allowed: 'Повторить можно только перевод входящего сообщения с ошибкой.',
    network: 'Не удалось связаться с переводчиком. Проверьте подключение к интернету.',
  };
  return messages[String(code || '').toLowerCase()] || 'Не получилось выполнить действие. Попробуйте позже.';
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), body === undefined ? 12000 : 45000);
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (body !== undefined && path !== 'login') headers['X-CSRF-Token'] = state?.csrfToken || '';
    const response = await fetch(`api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error('Request failed');
      error.code = data?.error?.code || (response.status === 401 ? 'unauthorized' : 'request_failed');
      error.status = response.status;
      if (response.status === 401 && path !== 'login') showLogin();
      throw error;
    }
    if (!data) {
      const error = new Error('Response unavailable');
      error.code = 'network';
      throw error;
    }
    return data;
  } catch (error) {
    if (!error.code || error.name === 'AbortError') error.code = 'network';
    throw error;
  } finally { clearTimeout(timeout); }
}

function showLogin() {
  loginRequired = true;
  clearTimeout(pollTimer);
  $('app').hidden = true;
  const wasHidden = $('login-view').hidden;
  $('login-view').hidden = false;
  if ($('contact-dialog').open) $('contact-dialog').close();
  if (wasHidden) $('password').focus();
}

async function poll({ manual = false } = {}) {
  if (polling) return polling;
  clearTimeout(pollTimer);
  polling = (async () => {
    try {
      const path = pending ? `state?requestKey=${encodeURIComponent(pending.idempotencyKey)}` : 'state';
      const next = await api(path);
      next.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      state = next;
      loginRequired = false;
      $('app').hidden = false;
      $('login-view').hidden = true;
      $('network-banner').hidden = true;
      if (selectedId && !contactFor(selectedId)) selectedId = null;
      if (!selectedId && pending && contactFor(pending.contactId)) selectedId = pending.contactId;
      if (firstState && !selectedId && state.whatsapp.phase !== 'connected') $('app').classList.add('chat-open');
      firstState = false;
      const found = pending && state.messages.find((message) => message.idempotencyKey === pending.idempotencyKey);
      if (found) settlePending(found);
      render();
      if (manual && pending) toast('Результат пока неизвестен. Повторно сообщение не отправлялось. Проверьте чат в WhatsApp.');
      return true;
    } catch (error) {
      if (error.status !== 401) {
        $('network-banner').hidden = false;
        $('connection-label').textContent = 'Нет связи';
        $('connection-status').dataset.phase = 'error';
        updateComposer();
        if (manual) toast(readableError(error.code));
      }
      return false;
    } finally {
      polling = null;
      if (!loginRequired) pollTimer = setTimeout(() => { void poll(); }, POLL_DELAY);
    }
  })();
  return polling;
}

function settlePending(message) {
  if (!pending) return;
  const sent = pending;
  savePending(null);
  if (drafts.get(sent.contactId) === sent.text) drafts.delete(sent.contactId);
  if (selectedId === sent.contactId && $('message-text').value === sent.text) {
    $('message-text').value = '';
    resizeComposer();
  }
  if (message.status === 'failed') toast(`${outgoingFailureText(message)} Исходный текст сохранён в чате.`);
  else if (message.status === 'unknown') toast('Результат отправки неизвестен. Проверьте сообщение в WhatsApp перед повтором.');
}

function outgoingFailureText(message) {
  if (message.errorCode === 'whatsapp_disconnected') return 'WhatsApp отключился до отправки. Сообщение не отправлено.';
  if (['translation_failed', 'invalid_translation', 'translation_empty'].includes(message.errorCode)) return 'Перевод не получился. Сообщение не отправлено.';
  if (message.errorCode === 'interrupted_translation') return 'Перевод был прерван. Сообщение не отправлено.';
  return 'Сообщение не отправлено.';
}

function restoreFailedOutgoing(id) {
  const message = state?.messages.find((item) => item.id === id);
  if (!message || message.direction !== 'outgoing' || message.status !== 'failed'
    || message.contactId !== selectedId || !contactFor(selectedId)) {
    toast('Откройте чат с этим собеседником и проверьте состояние сообщения.');
    return;
  }
  if (pending || sending) {
    toast('Сначала дождитесь результата предыдущей отправки.');
    return;
  }
  const composer = $('message-text');
  if (composer.value && composer.value !== message.originalText) {
    toast('В поле уже есть другой черновик. Сохраните его или очистите поле, затем верните текст.');
    return;
  }
  composer.value = message.originalText;
  drafts.set(selectedId, message.originalText);
  resizeComposer();
  updateComposer();
  composer.focus();
  toast('Текст возвращён в поле. Для отправки нажмите «Перевести и отправить».');
}

function render() {
  const phase = state.whatsapp.phase;
  const connected = phase === 'connected';
  const labels = { disconnected: 'Не подключён', connecting: 'Подключаем…', qr: 'Ожидаем QR', connected: 'WhatsApp подключён', logged_out: 'Нужно подключить', error: 'Нет соединения' };
  $('connection-status').dataset.phase = phase;
  $('connection-label').textContent = labels[phase] || 'Проверяем связь';
  $('demo-label').hidden = state.mode !== 'demo';
  $('demo-notice').hidden = state.mode !== 'demo';
  $('setup-panel').hidden = connected;
  $('open-connection').hidden = connected;
  for (const id of ['add-contact', 'add-first-contact', 'add-from-conversation', 'save-contact']) {
    $(id).disabled = !connected || (id === 'save-contact' && savingContact);
    $(id).title = connected ? '' : 'Сначала подключите WhatsApp';
  }
  $('setup-description').textContent = phase === 'qr' ? 'Отсканируйте код своим телефоном. Этот переводчик появится в списке связанных устройств.'
    : phase === 'connecting' ? 'Устанавливаем соединение. QR-код появится здесь через несколько секунд.'
      : phase === 'logged_out' ? 'Сессия WhatsApp завершена. Подключите свой телефон снова.'
        : phase === 'error' ? 'Не удалось установить соединение с WhatsApp. Попробуйте подключить его снова.'
          : 'Подключите свой аккаунт. Номер и привычные чаты остаются с вами.';
  const validQr = phase === 'qr' && typeof state.whatsapp.qrDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(state.whatsapp.qrDataUrl);
  $('qr-panel').hidden = !validQr;
  $('qr-placeholder').hidden = validQr;
  if (validQr) {
    if ($('qr-image').getAttribute('src') !== state.whatsapp.qrDataUrl) $('qr-image').src = state.whatsapp.qrDataUrl;
  } else $('qr-image').removeAttribute('src');
  $('connect-button').hidden = connected || validQr;
  $('connect-button').disabled = connecting || phase === 'connecting';
  $('connect-button').textContent = connecting || phase === 'connecting' ? 'Подключаем…' : phase === 'logged_out' || phase === 'error' ? 'Подключить снова ↗' : 'Подключить WhatsApp ↗';
  $('translator-notice').hidden = state.translator.ready;
  $('translator-reason').textContent = state.translator.ready ? '' : translationReason(state.translator.reason);
  renderContacts();
  renderConversation();
  updateComposer();
}

function translationReason(reason) {
  if (reason && /quota|limit|budget/i.test(reason)) return 'Лимит переводов сейчас исчерпан. Отправка станет доступна после его восстановления.';
  if (reason && /auth|login|credential/i.test(reason)) return 'Переводчик ожидает подключения. Вы можете подключить WhatsApp, а затем добавить собеседников.';
  return 'Переводчик ещё не готов к работе. Вы можете подключить WhatsApp, а затем добавить собеседников.';
}

function renderContacts() {
  const fingerprint = JSON.stringify([state.contacts, state.messages.map((message) => [message.contactId, message.id, message.translatedText]), selectedId]);
  if (fingerprint === contactFingerprint) return;
  contactFingerprint = fingerprint;
  const focused = document.activeElement?.dataset?.contactId;
  const fragment = document.createDocumentFragment();
  for (const contact of state.contacts) {
    const messages = state.messages.filter((message) => message.contactId === contact.id);
    const last = messages.at(-1);
    const button = element('button', 'contact-button');
    button.type = 'button';
    button.dataset.contactId = contact.id;
    button.setAttribute('aria-current', String(contact.id === selectedId));
    button.setAttribute('aria-label', `${contact.name}, ${phone(contact.id)}`);
    const avatar = element('span', 'avatar', initials(contact.name));
    avatar.setAttribute('aria-hidden', 'true');
    button.append(avatar);
    const copy = element('span', 'contact-copy');
    copy.append(element('span', 'contact-name', contact.name));
    copy.append(element('span', 'contact-preview', last ? (last.direction === 'outgoing' ? 'Вы: ' : '') + (last.direction === 'incoming' ? last.translatedText || last.originalText : last.originalText) : phone(contact.id)));
    button.append(copy);
    if (last) button.append(element('span', 'contact-time', time(last.createdAt)));
    button.addEventListener('click', () => selectContact(contact.id));
    fragment.append(button);
  }
  $('contact-list').replaceChildren(fragment);
  $('empty-contacts').hidden = state.contacts.length > 0;
  $('contact-count').textContent = String(state.contacts.length);
  if (focused) [...$('contact-list').children].find((node) => node.dataset.contactId === focused)?.focus({ preventScroll: true });
}

function selectContact(id) {
  if (selectedId) drafts.set(selectedId, $('message-text').value);
  selectedId = id;
  writeStorage(SELECTED_STORAGE, id);
  $('message-text').value = pending?.contactId === id ? pending.text : drafts.get(id) || '';
  $('app').classList.add('chat-open');
  messageFingerprint = '';
  renderContacts();
  renderConversation(true);
  updateComposer();
  resizeComposer();
  if (window.matchMedia('(min-width: 761px)').matches && !$('message-text').disabled) $('message-text').focus();
}

function renderConversation(forceScroll = false) {
  const contact = contactFor(selectedId);
  $('contact-name').textContent = contact?.name || (state.whatsapp.phase === 'connected' ? 'Место для разговора' : 'Подключение WhatsApp');
  $('contact-phone').textContent = contact ? phone(contact.id) : 'Ваши чаты и переводы — в одном месте';
  $('contact-avatar').textContent = contact ? initials(contact.name) : '↔';
  $('recipient-label').textContent = contact ? `Кому: ${contact.name} · ${phone(contact.id)}` : 'Сначала выберите чат';
  const messages = contact ? state.messages.filter((message) => message.contactId === selectedId) : [];
  $('empty-conversation').hidden = messages.length > 0;
  $('add-from-conversation').hidden = Boolean(contact);
  $('empty-title').textContent = contact ? 'Первое слово за вами.' : 'Просто начните разговор.';
  $('empty-description').textContent = contact ? `Напишите ${contact.name} по-русски. Сообщение будет переведено на сербский и отправлено в этот чат.` : 'Выберите чат или добавьте собеседника. Перевод появится рядом с каждым сообщением.';
  const fingerprint = JSON.stringify([selectedId, messages]);
  if (messageFingerprint === fingerprint && !forceScroll) return;
  messageFingerprint = fingerprint;
  const scroll = $('conversation-scroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 110;
  const fragment = document.createDocumentFragment();
  let previousDate = '';
  for (const message of messages) {
    const date = new Date(message.createdAt);
    const day = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
    if (day && day !== previousDate) {
      fragment.append(element('div', 'day-divider', day));
      previousDate = day;
    }
    fragment.append(messageElement(message));
  }
  $('message-list').replaceChildren(fragment);
  if (nearBottom || forceScroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function messageElement(message) {
  const outgoing = message.direction === 'outgoing';
  const article = element('article', `message ${outgoing ? 'outgoing' : 'incoming'}`);
  article.setAttribute('aria-label', outgoing ? 'Ваше сообщение' : 'Сообщение собеседника');
  const bubble = element('div', 'message-bubble');
  if (!outgoing && message.translatedText) {
    bubble.append(element('p', 'message-translation', message.translatedText));
    const original = element('div', 'translation-block');
    original.append(element('span', 'translation-label', 'Оригинал · сербский'));
    original.append(element('p', 'message-original', message.originalText));
    bubble.append(original);
  } else {
    bubble.append(element('p', 'message-original', message.originalText));
    if (message.translatedText) {
      const translated = element('div', 'translation-block');
      translated.append(element('span', 'translation-label', 'Перевод · сербский'));
      translated.append(element('p', 'message-translation', message.translatedText));
      bubble.append(translated);
    }
  }
  if (!message.translatedText && message.status === 'translating') bubble.append(element('p', 'message-waiting', 'Переводим…'));
  if (message.status === 'unknown') bubble.append(element('p', 'message-error', 'Нет подтверждения отправки. Проверьте чат в WhatsApp перед повтором.'));
  if (message.status === 'failed') {
    bubble.append(element('p', 'message-error', outgoing ? outgoingFailureText(message) : 'Пока не удалось перевести. Оригинал сохранён.'));
    if (outgoing) {
      const restore = element('button', 'text-button restore-message', 'Вернуть текст в поле');
      restore.type = 'button';
      restore.dataset.contactId = message.contactId;
      restore.addEventListener('click', () => restoreFailedOutgoing(message.id));
      bubble.append(restore);
    } else {
      const retry = element('button', 'text-button retry-translation', 'Повторить перевод');
      retry.type = 'button';
      retry.disabled = !state.translator.ready;
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { await api('retry-translation', { id: message.id }); await poll(); }
        catch (error) { toast(readableError(error.code)); retry.disabled = false; }
      });
      bubble.append(retry);
    }
  }
  article.append(bubble);
  const meta = element('div', 'message-meta');
  const labels = { translating: 'Переводим', sending: 'Отправляем', sent: '✓ Отправлено', delivered: '✓✓ Доставлено', read: '✓✓ Прочитано', received: 'Переведено для вас', failed: outgoing ? 'Не отправлено' : 'Без перевода', unknown: 'Отправка не подтверждена' };
  const status = element('span', 'message-status', labels[message.status] || 'Проверяем состояние');
  status.dataset.status = message.status;
  meta.append(element('span', '', time(message.createdAt)), status);
  article.append(meta);
  return article;
}

function updateComposer() {
  const contact = contactFor(selectedId);
  const connected = state?.whatsapp.phase === 'connected';
  const available = state?.translator.ready;
  const networkOk = $('network-banner').hidden;
  const locked = Boolean(pending) || sending;
  $('message-text').disabled = !contact || locked;
  $('send-button').disabled = !contact || !connected || !available || !networkOk || locked || !$('message-text').value.trim();
  for (const button of document.querySelectorAll('.restore-message')) {
    button.disabled = locked || button.dataset.contactId !== selectedId;
  }
  $('send-button').firstElementChild.textContent = sending ? 'Отправляем…' : 'Перевести и отправить';
  $('pending-notice').hidden = !pending;
  if (pending) {
    const recipient = contactFor(pending.contactId);
    $('pending-description').textContent = `Сообщение для ${recipient?.name || phone(pending.contactId)}. Ответ пока не получен. Повторно не отправляем.`;
  }
  $('compose-help').textContent = pending ? 'Сначала проверьте результат предыдущего сообщения.'
    : !contact ? 'Выберите собеседника или добавьте новый чат.'
      : !networkOk ? 'Отправка будет доступна, когда восстановится связь.'
        : !connected ? 'Подключите WhatsApp, чтобы отправить сообщение.'
          : !available ? 'Отправка станет доступна, когда подключится переводчик.'
            : 'Enter — перевести и отправить · Shift + Enter — новая строка';
}

function resizeComposer() {
  const textarea = $('message-text');
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
}

function openContactDialog() {
  $('contact-error').hidden = true;
  $('contact-dialog').showModal();
  $('new-contact-name').focus();
}

$('add-contact').addEventListener('click', openContactDialog);
$('add-first-contact').addEventListener('click', openContactDialog);
$('add-from-conversation').addEventListener('click', openContactDialog);
$('open-connection').addEventListener('click', () => {
  $('app').classList.add('chat-open');
  $('conversation-scroll').scrollTop = 0;
  $('connect-button').focus({ preventScroll: true });
});
$('close-contact-dialog').addEventListener('click', () => $('contact-dialog').close());
$('back-to-chats').addEventListener('click', () => {
  $('app').classList.remove('chat-open');
  [...$('contact-list').children].find((node) => node.dataset.contactId === selectedId)?.focus();
});
$('message-text').addEventListener('input', () => {
  if (selectedId) drafts.set(selectedId, $('message-text').value);
  resizeComposer();
  updateComposer();
});
$('message-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send-button').disabled) $('compose-form').requestSubmit();
  }
});

$('contact-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (savingContact || state?.whatsapp.phase !== 'connected') return;
  const name = $('new-contact-name').value.trim();
  const number = $('new-contact-phone').value.replace(/[\s()-]/g, '');
  if (!/^\+?[1-9]\d{6,14}$/.test(number)) {
    $('contact-error').textContent = readableError('invalid_phone');
    $('contact-error').hidden = false;
    return;
  }
  savingContact = true;
  $('save-contact').disabled = true;
  $('contact-error').hidden = true;
  try {
    const response = await api('contacts', { name, phone: number });
    const contact = response.contact || response;
    await poll();
    if (!state?.contacts.some((item) => item.id === contact.id)) throw Object.assign(new Error('Contact not available'), { code: 'network' });
    $('contact-dialog').close();
    $('contact-form').reset();
    selectContact(contact.id);
  } catch (error) {
    $('contact-error').textContent = readableError(error.code);
    $('contact-error').hidden = false;
  } finally { savingContact = false; $('save-contact').disabled = state?.whatsapp.phase !== 'connected'; }
});

$('connect-button').addEventListener('click', async () => {
  if (connecting) return;
  connecting = true;
  $('setup-error').hidden = true;
  if (state) render();
  try { await api('connect', {}); await poll(); }
  catch (error) {
    $('setup-error').textContent = readableError(error.code);
    $('setup-error').hidden = false;
  } finally { connecting = false; if (state) render(); }
});

$('compose-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('send-button').disabled || pending || sending) return;
  // Persist the exact command before the request: a lost HTTP response must never
  // create a new message identity or cause an automatic second send.
  const request = { contactId: selectedId, text: $('message-text').value, idempotencyKey: crypto.randomUUID(), createdAt: new Date().toISOString() };
  drafts.set(request.contactId, request.text);
  savePending(request);
  sending = true;
  updateComposer();
  try {
    const response = await api('send', { contactId: request.contactId, text: request.text, idempotencyKey: request.idempotencyKey });
    const message = response.message || response;
    if (message.idempotencyKey === request.idempotencyKey && pending?.idempotencyKey === request.idempotencyKey) {
      settlePending(message);
      if (state && !state.messages.some((item) => item.id === message.id)) state.messages.push(message);
    }
    await poll();
  } catch (error) {
    // An explicit client rejection happened before dispatch. A timeout or a server
    // failure can occur after delivery, so retain the command and only check state.
    if (error.status >= 400 && error.status < 500 && error.status !== 408) {
      if (pending?.idempotencyKey === request.idempotencyKey) savePending(null);
      toast(readableError(error.code));
    } else if (pending?.idempotencyKey === request.idempotencyKey) {
      toast('Ответ не получен. Проверяем результат; повторной отправки не будет.');
    }
    await poll();
  } finally {
    sending = false;
    updateComposer();
    if (!pending) renderConversation(true);
  }
});

$('check-result').addEventListener('click', async () => {
  $('check-result').disabled = true;
  try { await poll({ manual: true }); } finally { $('check-result').disabled = false; }
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-button').disabled = true;
  $('login-error').hidden = true;
  try {
    await api('login', { password: $('password').value });
    $('password').value = '';
    loginRequired = false;
    await poll();
  } catch (error) {
    $('login-error').textContent = error.status === 401 ? 'Пароль не подошёл. Попробуйте ещё раз.' : readableError(error.code);
    $('login-error').hidden = false;
  } finally { $('login-button').disabled = false; }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !loginRequired) void poll();
});
window.addEventListener('online', () => { if (!loginRequired) void poll(); });
if (selectedId) $('app').classList.add('chat-open');
if (pending?.contactId === selectedId) $('message-text').value = pending.text;
void poll();
