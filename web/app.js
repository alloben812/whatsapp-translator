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
let showingQr = false;
let changingLanguage = null;
let speechSession = null;
let openingChatId = null;
let syncingChats = false;
let chatQuery = '';
let authGeneration = 0;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'];
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
function nativeChats() {
  const contacts = state?.contacts || [];
  const chats = Array.isArray(state?.chats) ? state.chats : [];
  const seen = new Set(chats.map((chat) => chat.id));
  return [...chats, ...contacts.filter((contact) => !seen.has(contact.id)).map(contactAsChat)]
    .map(chatView)
    .sort((left, right) => {
      const leftTime = timestamp(left.lastMessageAt);
      const rightTime = timestamp(right.lastMessageAt);
      if (leftTime !== rightTime) return rightTime - leftTime;
      return (left.name || phone(left.id)).localeCompare(right.name || phone(right.id), 'ru');
    });
}
function contactAsChat(contact) {
  return {
    id: contact.id, name: contact.name, language: contact.language || 'sr-Latn', translationEnabled: true,
    lastMessageAt: null,
    preview: phone(contact.id),
  };
}
function chatView(chat) {
  const last = latestMessage(chat.id);
  if (!last || timestamp(chat.lastMessageAt) > timestamp(last.createdAt)) {
    return { ...chat, name: chat.name || phone(chat.id), lastMessageAt: chat.lastMessageAt || null, preview: chat.preview || phone(chat.id) };
  }
  return {
    ...chat,
    name: chat.name || phone(chat.id),
    lastMessageAt: last.createdAt,
    preview: messagePreview(last),
  };
}
function latestMessage(contactId) {
  return state?.messages
    .filter((message) => message.contactId === contactId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1) || null;
}
function messagePreview(message) {
  const text = message.direction === 'incoming' ? message.translatedText || message.originalText : message.originalText;
  if (message.direction === 'incoming') return text;
  if (message.status === 'failed') return `Не отправлено: ${text}`;
  if (message.status === 'unknown') return `Не подтверждено: ${text}`;
  if (message.status === 'translating') return `Переводим: ${text}`;
  if (message.status === 'sending') return `Отправляем: ${text}`;
  return `Вы: ${text}`;
}
function chatFor(id) { return nativeChats().find((chat) => chat.id === id); }
function languages() { return state?.languages || [{ code: 'sr-Latn', label: 'Сербский · латиница' }]; }
function languageLabel(code) { return code === 'ru' ? 'Русский' : languages().find((item) => item.code === code)?.label || code || 'Язык собеседника'; }
function fillLanguageSelect(select, value) {
  const catalog = languages();
  const fingerprint = JSON.stringify(catalog);
  if (select.dataset.catalog !== fingerprint) {
    select.replaceChildren(...catalog.map((item) => {
      const option = element('option', '', item.label);
      option.value = item.code;
      return option;
    }));
    select.dataset.catalog = fingerprint;
  }
  if (catalog.some((item) => item.code === value)) select.value = value;
}
function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function timestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
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
    invalid_language: 'Этот язык пока недоступен. Выберите язык из списка.',
    invalid_audio: 'Нужна запись голоса до 60 секунд и 8 МБ. Повторите запись или введите текст.',
    transcription_busy: 'Предыдущая запись ещё распознаётся. Дождитесь результата.',
    transcription_timeout: 'Не удалось распознать запись вовремя. Попробуйте более короткую фразу.',
    transcription_unavailable: 'Диктовка временно недоступна. Можно ввести текст вручную.',
    invalid_transcription: 'Не удалось разобрать речь. Повторите запись или введите текст.',
    transcription_output_limit: 'Результат слишком большой. Запишите более короткую фразу.',
    unsupported_audio: 'Этот формат записи не поддерживается. Попробуйте другой браузер или введите текст.',
    audio_too_large: 'Запись слишком большая. Запишите более короткую фразу.',
    network: 'Не удалось связаться с переводчиком. Проверьте подключение к интернету.',
    chat_sync_unavailable: 'WhatsApp подключён, но список чатов сейчас недоступен. Попробуйте обновить ещё раз.',
    chat_sync_timeout: 'WhatsApp не успел вернуть список чатов. Попробуйте обновить ещё раз.',
    chats_unavailable: 'WhatsApp подключён, но список чатов сейчас недоступен. Попробуйте обновить ещё раз.',
    chats_timeout: 'WhatsApp не успел вернуть список чатов. Попробуйте обновить ещё раз.',
    chat_directory_unsupported: 'Этот сеанс WhatsApp пока не отдаёт список чатов. Можно выбрать чат вручную.',
    metadata_unavailable: 'WhatsApp не вернул данные чатов. Можно повторить обновление или добавить собеседника вручную.',
  };
  return messages[String(code || '').toLowerCase()] || 'Не получилось выполнить действие. Попробуйте позже.';
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

async function api(path, body, options = {}) {
  const controller = options.controller || new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? (body === undefined ? 12000 : 45000));
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = options.raw ? body.type : 'application/json';
    if (body !== undefined && path !== 'login') headers['X-CSRF-Token'] = state?.csrfToken || '';
    const response = await fetch(`api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', headers,
      body: body === undefined ? undefined : options.raw ? body : JSON.stringify(body), signal: controller.signal,
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
      if (path === 'chats/sync') return { ok: true };
      const error = new Error('Response unavailable');
      error.code = 'network';
      throw error;
    }
    return data;
  } catch (error) {
    if (typeof error.code !== 'string' || error.name === 'AbortError') {
      throw Object.assign(new Error('Request unavailable'), {
        code: path === 'transcribe' && error.name === 'AbortError' ? 'transcription_timeout' : 'network',
      });
    }
    throw error;
  } finally { clearTimeout(timeout); }
}

function clearPrivateView() {
  state = null;
  selectedId = null;
  contactFingerprint = '';
  messageFingerprint = '';
  writeStorage(SELECTED_STORAGE, null);
  $('contact-list').replaceChildren();
  $('message-list').replaceChildren();
  $('empty-contacts').hidden = true;
  $('pending-notice').hidden = true;
  $('chat-tools').hidden = true;
  $('chat-sync-status').hidden = true;
  $('contact-count').textContent = '0';
  $('contact-name').textContent = 'Место для разговора';
  $('contact-phone').textContent = 'Выберите собеседника слева';
  $('contact-avatar').textContent = '↔';
  $('recipient-label').textContent = 'Сначала выберите чат';
  $('language-route').textContent = 'Перевод личных чатов';
  $('qr-panel').hidden = true;
  $('qr-placeholder').hidden = false;
  $('qr-image').removeAttribute('src');
  $('message-text').value = pending?.text || '';
  $('message-text').disabled = true;
  $('send-button').disabled = true;
  $('app').classList.remove('chat-open');
}

function showLogin({ clear = false } = {}) {
  authGeneration++;
  cancelDictation();
  loginRequired = true;
  clearTimeout(pollTimer);
  $('app').hidden = true;
  if (clear) clearPrivateView();
  const wasHidden = $('login-view').hidden;
  $('login-view').hidden = false;
  if ($('contact-dialog').open) $('contact-dialog').close();
  if (wasHidden) $('password').focus();
}

async function poll({ manual = false } = {}) {
  if (polling) return polling;
  clearTimeout(pollTimer);
  const generation = authGeneration;
  polling = (async () => {
    try {
      const path = pending ? `state?requestKey=${encodeURIComponent(pending.idempotencyKey)}` : 'state';
      const next = await api(path);
      if (generation !== authGeneration) return false;
      next.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      state = next;
      loginRequired = false;
      $('app').hidden = false;
      $('login-view').hidden = true;
      $('network-banner').hidden = true;
      if (selectedId && !contactFor(selectedId)) {
        selectedId = null;
        writeStorage(SELECTED_STORAGE, null);
      }
      if (!selectedId && pending && contactFor(pending.contactId)) selectedId = pending.contactId;
      if (firstState && !selectedId && state.whatsapp.phase !== 'connected') $('app').classList.add('chat-open');
      if (!selectedId && state.whatsapp.phase === 'connected') $('app').classList.remove('chat-open');
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
      if (!loginRequired && generation === authGeneration) pollTimer = setTimeout(() => { void poll(); }, POLL_DELAY);
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
  if (pending || sending || speechSession || changingLanguage || openingChatId) {
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
  $('owner-logout').hidden = !state.auth?.required;
  $('demo-notice').hidden = state.mode !== 'demo';
  $('setup-panel').hidden = connected;
  $('open-connection').hidden = connected;
  for (const id of ['add-contact', 'add-first-contact', 'add-from-conversation', 'save-contact', 'refresh-empty-chats', 'sync-chats']) {
    $(id).disabled = !connected || Boolean(speechSession || changingLanguage) || (id === 'save-contact' && savingContact);
    $(id).title = connected ? '' : 'Сначала подключите WhatsApp';
  }
  $('sync-chats').disabled = !connected || syncingChats || Boolean(openingChatId || speechSession || changingLanguage);
  $('refresh-empty-chats').disabled = !connected || syncingChats || Boolean(openingChatId || speechSession || changingLanguage);
  $('setup-description').textContent = phase === 'qr' ? 'Отсканируйте код своим телефоном. Этот переводчик появится в списке связанных устройств.'
    : phase === 'connecting' ? 'Устанавливаем соединение. QR-код появится здесь через несколько секунд.'
      : phase === 'logged_out' ? 'Сессия WhatsApp завершена. Подключите свой телефон снова.'
        : phase === 'error' ? 'Не удалось установить соединение с WhatsApp. Попробуйте подключить его снова.'
          : 'Подключите свой аккаунт. Номер и привычные чаты остаются с вами.';
  const validQr = phase === 'qr' && typeof state.whatsapp.qrDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(state.whatsapp.qrDataUrl);
  const qrJustAppeared = validQr && !showingQr;
  showingQr = validQr;
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
  fillLanguageSelect($('new-contact-language'), $('new-contact-language').value || 'sr-Latn');
  renderContacts();
  renderConversation();
  updateComposer();
  if (qrJustAppeared) requestAnimationFrame(() => { $('conversation-scroll').scrollTop = 0; });
}

function translationReason(reason) {
  if (reason && /quota|limit|budget/i.test(reason)) return 'Лимит переводов сейчас исчерпан. Отправка станет доступна после его восстановления.';
  if (reason && /auth|login|credential/i.test(reason)) return 'Переводчик ожидает подключения. Вы можете подключить WhatsApp, а затем добавить собеседников.';
  return 'Переводчик ещё не готов к работе. Вы можете подключить WhatsApp, а затем добавить собеседников.';
}

function renderContacts() {
  const fingerprint = JSON.stringify([
    state.contacts,
    nativeChats(),
    state.chatSync,
    state.messages.map((message) => [message.contactId, message.id, message.createdAt, message.status, message.translatedText]),
    selectedId,
    openingChatId,
    syncingChats,
    chatQuery,
  ]);
  if (fingerprint === contactFingerprint) return;
  contactFingerprint = fingerprint;
  const focused = document.activeElement?.dataset?.contactId;
  const fragment = document.createDocumentFragment();
  const chats = nativeChats();
  const query = chatQuery.trim().toLocaleLowerCase('ru');
  const filtered = query ? chats.filter((chat) => `${chat.name} ${phone(chat.id)}`.toLocaleLowerCase('ru').includes(query)) : chats;
  for (const chat of filtered) {
    const contact = contactFor(chat.id);
    const active = Boolean(contact);
    const button = element('button', 'contact-button');
    button.type = 'button';
    button.dataset.contactId = chat.id;
    button.dataset.active = String(active);
    button.setAttribute('aria-current', String(chat.id === selectedId));
    button.setAttribute('aria-label', `${chat.name}, ${phone(chat.id)}`);
    const avatar = element('span', 'avatar', initials(chat.name || phone(chat.id)));
    avatar.setAttribute('aria-hidden', 'true');
    button.append(avatar);
    const copy = element('span', 'contact-copy');
    const nameLine = element('span', 'contact-name');
    nameLine.append(document.createTextNode(chat.name || phone(chat.id)));
    if (active) nameLine.append(element('span', 'translation-chip', 'перевод'));
    copy.append(nameLine);
    copy.append(element('span', 'contact-preview', openingChatId === chat.id ? 'Открываем чат…' : chat.preview || phone(chat.id)));
    button.append(copy);
    if (chat.lastMessageAt) button.append(element('span', 'contact-time', time(chat.lastMessageAt)));
    button.addEventListener('click', () => active ? selectContact(chat.id) : openNativeChat(chat.id));
    fragment.append(button);
  }
  $('contact-list').replaceChildren(fragment);
  $('chat-tools').hidden = state.whatsapp.phase !== 'connected';
  renderChatSyncStatus(chats, filtered);
  $('empty-contacts').hidden = filtered.length > 0;
  $('contact-count').textContent = String(chats.length);
  if (focused) [...$('contact-list').children].find((node) => node.dataset.contactId === focused)?.focus({ preventScroll: true });
}

function renderChatSyncStatus(chats, filtered) {
  const connected = state.whatsapp.phase === 'connected';
  const sync = state.chatSync || { status: 'idle', errorCode: null, lastSyncedAt: null };
  const hasQuery = chatQuery.trim().length > 0;
  $('sync-chats').textContent = syncingChats || sync.status === 'syncing' ? 'Обновляем…' : 'Обновить чаты';
  $('empty-contacts-title').textContent = !connected ? 'С кем поговорим?'
    : hasQuery ? 'Ничего не найдено'
      : sync.status === 'error' ? 'Чаты не обновились'
        : 'Загружаем чаты WhatsApp';
  $('empty-contacts-description').textContent = !connected ? 'Подключите WhatsApp, чтобы увидеть свои чаты.'
    : hasQuery ? 'Измените запрос или обновите список чатов.'
      : sync.status === 'error' ? `Не удалось получить список чатов: ${readableError(sync.errorCode)}`
        : 'Обновите список, чтобы увидеть привычные чаты из вашего WhatsApp.';
  $('refresh-empty-chats').hidden = !connected;
  $('add-first-contact').hidden = !connected;
  const parts = [];
  if (sync.status === 'syncing' || syncingChats) parts.push('Обновляем список чатов WhatsApp…');
  else if (sync.status === 'error') parts.push(`Не удалось обновить чаты: ${readableError(sync.errorCode)}`);
  else if (sync.lastSyncedAt && chats.length > 0) parts.push(`Обновлено ${time(sync.lastSyncedAt)}`);
  if (hasQuery && chats.length > 0) parts.push(`Найдено ${filtered.length}`);
  $('chat-sync-status').textContent = parts.join(' · ');
  $('chat-sync-status').hidden = !parts.length;
}

function selectContact(id) {
  if (speechSession || changingLanguage || openingChatId) {
    toast(speechSession ? 'Завершите или отмените диктовку, прежде чем сменить чат.'
      : openingChatId ? 'Сначала дождитесь открытия выбранного чата.'
        : 'Сначала дождитесь сохранения языка.');
    return;
  }
  if (!contactFor(id)) return;
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

async function openNativeChat(id) {
  if (speechSession || changingLanguage || openingChatId || pending || sending) {
    toast(speechSession ? 'Завершите или отмените диктовку, прежде чем сменить чат.'
      : pending || sending ? 'Сначала дождитесь результата предыдущей отправки.'
        : openingChatId ? 'Сначала дождитесь открытия выбранного чата.'
          : 'Сначала дождитесь сохранения языка.');
    return;
  }
  const chat = chatFor(id);
  if (!chat || state?.whatsapp.phase !== 'connected') return;
  if (selectedId) drafts.set(selectedId, $('message-text').value);
  openingChatId = id;
  renderContacts();
  updateComposer();
  try {
    const response = await api('chats/open', { contactId: id });
    const contact = response.contact || response;
    if (!contact?.id) throw Object.assign(new Error('Invalid contact'), { code: 'unknown_contact' });
    if (state) state.contacts = state.contacts.some((item) => item.id === contact.id)
      ? state.contacts.map((item) => item.id === contact.id ? contact : item)
      : [...state.contacts, contact];
    await poll();
    if (state && !state.contacts.some((item) => item.id === contact.id)) state.contacts = [...state.contacts, contact];
    openingChatId = null;
    selectContact(contact.id);
  } catch (error) {
    toast(readableError(error.code));
  } finally {
    openingChatId = null;
    if (state) {
      renderContacts();
      updateComposer();
    }
  }
}

async function syncNativeChats() {
  if (syncingChats || state?.whatsapp.phase !== 'connected' || speechSession || changingLanguage || openingChatId) return;
  syncingChats = true;
  renderContacts();
  try {
    await api('chats/sync', {}, { timeoutMs: 15000 });
    await poll();
  } catch (error) {
    toast(readableError(error.code));
    await poll();
  } finally {
    syncingChats = false;
    if (state) render();
  }
}

function renderConversation(forceScroll = false) {
  const contact = contactFor(selectedId);
  $('contact-name').textContent = contact?.name || (state.whatsapp.phase === 'connected' ? 'Место для разговора' : 'Подключение WhatsApp');
  $('contact-phone').textContent = contact ? phone(contact.id) : 'Ваши чаты и переводы — в одном месте';
  $('contact-avatar').textContent = contact ? initials(contact.name) : '↔';
  $('recipient-label').textContent = contact ? `Кому: ${contact.name} · ${phone(contact.id)}` : 'Сначала выберите чат';
  $('contact-language-control').hidden = !contact;
  $('language-route').textContent = contact ? `Русский ↔ ${languageLabel(contact.language || 'sr-Latn')}` : 'Перевод личных чатов';
  if (contact) fillLanguageSelect($('contact-language'), changingLanguage?.contactId === contact.id ? changingLanguage.language : contact.language || 'sr-Latn');
  const messages = contact ? state.messages.filter((message) => message.contactId === selectedId) : [];
  const connectingWithoutContact = !contact && state.whatsapp.phase !== 'connected';
  $('empty-conversation').hidden = messages.length > 0 || connectingWithoutContact;
  $('compose-form').hidden = connectingWithoutContact;
  $('add-from-conversation').hidden = Boolean(contact);
  $('empty-title').textContent = contact ? 'Первое слово за вами.' : 'Просто начните разговор.';
  $('empty-description').textContent = contact ? `Напишите ${contact.name} по-русски. Язык перевода: ${languageLabel(contact.language || 'sr-Latn')}. Сообщение уйдёт в этот чат.` : 'Выберите чат или добавьте собеседника. Перевод появится рядом с каждым сообщением.';
  const fingerprint = JSON.stringify([selectedId, messages, languages()]);
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
  if (contact && messages.length > 0 && (nearBottom || forceScroll)) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function messageElement(message) {
  const outgoing = message.direction === 'outgoing';
  const article = element('article', `message ${outgoing ? 'outgoing' : 'incoming'}`);
  article.setAttribute('aria-label', outgoing ? 'Ваше сообщение' : 'Сообщение собеседника');
  const bubble = element('div', 'message-bubble');
  if (!outgoing && message.translatedText) {
    bubble.append(element('p', 'message-translation', message.translatedText));
    const original = element('div', 'translation-block');
    original.append(element('span', 'translation-label', `Оригинал · ${languageLabel(message.sourceLanguage || 'sr-Latn')}`));
    original.append(element('p', 'message-original', message.originalText));
    bubble.append(original);
  } else {
    bubble.append(element('p', 'message-original', message.originalText));
    if (message.translatedText) {
      const translated = element('div', 'translation-block');
      translated.append(element('span', 'translation-label', `Перевод · ${languageLabel(message.targetLanguage || 'sr-Latn')}`));
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
  const locked = Boolean(pending || openingChatId) || sending;
  $('message-text').disabled = !contact || locked;
  const tooLong = $('message-text').value.length > 4000;
  $('send-button').disabled = !contact || !connected || !available || !networkOk || locked || Boolean(speechSession || changingLanguage) || tooLong || !$('message-text').value.trim();
  for (const button of document.querySelectorAll('.restore-message')) {
    button.disabled = locked || Boolean(speechSession || changingLanguage) || button.dataset.contactId !== selectedId;
  }
  for (const button of document.querySelectorAll('.contact-button')) button.disabled = Boolean(speechSession || changingLanguage || openingChatId);
  $('back-to-chats').disabled = Boolean(speechSession || changingLanguage || openingChatId);
  $('contact-language').disabled = !contact || locked || Boolean(speechSession || changingLanguage) || !networkOk;
  for (const id of ['add-contact', 'add-first-contact', 'add-from-conversation']) $(id).disabled = !connected || Boolean(speechSession || changingLanguage || openingChatId);
  $('sync-chats').disabled = !connected || syncingChats || Boolean(speechSession || changingLanguage || openingChatId);
  $('refresh-empty-chats').disabled = !connected || syncingChats || Boolean(speechSession || changingLanguage || openingChatId);
  updateDictation();
  $('send-button').firstElementChild.textContent = sending ? 'Отправляем…' : 'Перевести и отправить';
  $('pending-notice').hidden = !pending;
  if (pending) {
    const recipient = contactFor(pending.contactId);
    $('pending-description').textContent = `Сообщение для ${recipient?.name || phone(pending.contactId)}. Ответ пока не получен. Повторно не отправляем.`;
  }
  $('compose-help').textContent = speechSession ? 'Диктовка только добавляет текст. Отправка доступна после проверки черновика.'
    : openingChatId ? 'Открываем выбранный чат. Получатель остаётся неизменным до завершения.'
    : changingLanguage ? 'Сохраняем язык собеседника…'
    : tooLong ? 'Текст длиннее 4000 символов. Разделите его перед отправкой; весь текст сохранён в поле.'
    : pending ? 'Сначала проверьте результат предыдущего сообщения.'
    : !contact ? 'Выберите собеседника или добавьте новый чат.'
      : !networkOk ? 'Отправка будет доступна, когда восстановится связь.'
        : !connected ? 'Подключите WhatsApp, чтобы отправить сообщение.'
          : !available ? 'Отправка станет доступна, когда подключится переводчик.'
            : 'Enter — перевести и отправить · Shift + Enter — новая строка';
}

function recordingType() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined'
    || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/wav']
    .find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

function updateDictation() {
  const supported = Boolean(recordingType());
  const available = supported && state?.speech?.ready;
  $('start-dictation').hidden = Boolean(speechSession);
  $('start-dictation').disabled = !available || !contactFor(selectedId) || Boolean(pending || sending || changingLanguage || openingChatId) || !$('network-banner').hidden;
  $('voice-help').textContent = !supported ? 'Диктовка недоступна в этом браузере. Можно ввести текст вручную.'
    : !state?.speech?.ready ? 'Распознавание пока недоступно. Можно ввести текст вручную.'
      : 'Диктовка добавит текст в черновик. Перед отправкой проверьте его.';
  $('voice-status').hidden = !speechSession;
  if (!speechSession) return;
  const recording = speechSession.phase === 'recording';
  $('voice-status').dataset.phase = speechSession.phase;
  $('voice-state-label').textContent = recording ? 'Идёт запись'
    : speechSession.phase === 'permission' ? 'Ожидаем доступ к микрофону…' : 'Распознаём русский текст…';
  $('stop-dictation').hidden = !recording;
  $('voice-timer').hidden = !recording;
  if (recording) {
    const elapsed = Math.min(speechSession.maxSeconds, Math.floor((Date.now() - speechSession.startedAt) / 1000));
    const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('voice-timer').textContent = `${clock(elapsed)} / ${clock(speechSession.maxSeconds)}`;
  }
}

function releaseMicrophone(session) {
  clearInterval(session.timer);
  clearTimeout(session.deadline);
  session.stream?.getTracks().forEach((track) => track.stop());
}

function voiceError(text) {
  $('voice-error').textContent = text;
  $('voice-error').hidden = false;
}

function cancelDictation(reason) {
  const session = speechSession;
  if (!session) return;
  session.cancelled = true;
  session.controller?.abort();
  try { if (session.recorder?.state === 'recording') session.recorder.stop(); } catch { /* Tracks are closed below even if the recorder already stopped. */ }
  releaseMicrophone(session);
  session.chunks = [];
  speechSession = null;
  updateComposer();
  if (reason) voiceError(reason);
}

function stopDictation() {
  const session = speechSession;
  if (!session || session.phase !== 'recording') return;
  session.phase = 'transcribing';
  try {
    if (session.recorder.state !== 'inactive') session.recorder.stop();
  } catch {
    cancelDictation('Запись прервалась. Повторите диктовку или введите текст вручную.');
  } finally { releaseMicrophone(session); }
  updateComposer();
}

function appendTranscription(contactId, text) {
  // Use the current draft, not the text captured when recording started: typing
  // during recognition must survive. Never insert into a different contact's chat.
  const current = selectedId === contactId ? $('message-text').value : drafts.get(contactId) || '';
  const combined = current ? `${current}${/\s$/.test(current) ? '' : '\n'}${text}` : text;
  drafts.set(contactId, combined);
  if (selectedId === contactId) {
    $('message-text').value = combined;
    resizeComposer();
  }
}

async function transcribeRecording(session) {
  releaseMicrophone(session);
  if (session.cancelled || speechSession !== session) return;
  session.phase = 'transcribing';
  updateComposer();
  try {
    const mime = session.recorder.mimeType.split(';')[0].toLowerCase();
    if (!AUDIO_TYPES.includes(mime) || session.bytes === 0 || session.bytes > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error('Invalid recording'), { code: 'unsupported_audio' });
    }
    const audio = new Blob(session.chunks, { type: mime });
    session.chunks = [];
    session.controller = new AbortController();
    const result = await api('transcribe', audio, { raw: true, timeoutMs: 90000, controller: session.controller });
    if (session.cancelled || speechSession !== session) return;
    if (typeof result.text !== 'string' || !result.text.trim()) throw Object.assign(new Error('Empty transcription'), { code: 'invalid_transcription' });
    appendTranscription(session.contactId, result.text.trim());
    toast('Текст добавлен в черновик. Проверьте его перед отправкой.');
  } catch (error) {
    if (!session.cancelled && speechSession === session) voiceError(readableError(error.code));
  } finally {
    if (speechSession === session) {
      speechSession = null;
      updateComposer();
      if (selectedId === session.contactId && !$('message-text').disabled) $('message-text').focus();
    }
  }
}

async function startDictation() {
  const mimeType = recordingType();
  if (!mimeType || !state?.speech?.ready || !contactFor(selectedId) || pending || sending || changingLanguage || openingChatId || speechSession) return;
  const configuredMaximum = Number(state.speech.maxSeconds);
  const session = {
    contactId: selectedId, phase: 'permission', cancelled: false,
    chunks: [], bytes: 0, stream: null, recorder: null, timer: null, deadline: null,
    maxSeconds: Number.isFinite(configuredMaximum) ? Math.max(1, Math.min(60, configuredMaximum)) : 60,
  };
  speechSession = session;
  $('voice-error').hidden = true;
  updateComposer();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (session.cancelled || speechSession !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    session.recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
    session.recorder.addEventListener('dataavailable', (event) => {
      if (session.cancelled || speechSession !== session || !event.data.size) return;
      session.bytes += event.data.size;
      if (session.bytes > MAX_AUDIO_BYTES) {
        cancelDictation('Запись превысила 8 МБ. Попробуйте более короткую фразу.');
        return;
      }
      session.chunks.push(event.data);
    });
    session.recorder.addEventListener('stop', () => { void transcribeRecording(session); });
    session.recorder.addEventListener('error', () => {
      if (speechSession === session) cancelDictation('Запись прервалась. Повторите диктовку или введите текст вручную.');
    });
    session.startedAt = Date.now();
    session.recorder.start(250);
    session.phase = 'recording';
    session.timer = setInterval(updateDictation, 500);
    // Leave room for recorder scheduling and codec padding below the server's duration limit.
    session.deadline = setTimeout(() => {
      if (speechSession === session && session.phase === 'recording') stopDictation();
    }, Math.max(1, session.maxSeconds - 1) * 1000);
    updateComposer();
  } catch (error) {
    releaseMicrophone(session);
    if (session.cancelled || speechSession !== session) return;
    speechSession = null;
    const text = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Доступ к микрофону не разрешён. Разрешите его в браузере или введите текст вручную.'
      : error.name === 'NotFoundError' ? 'Микрофон не найден. Подключите его или введите текст вручную.'
        : 'Не удалось начать запись. Проверьте микрофон или введите текст вручную.';
    voiceError(text);
    updateComposer();
  }
}

function resizeComposer() {
  const textarea = $('message-text');
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
}

function openContactDialog() {
  if (speechSession || changingLanguage || openingChatId) return;
  $('contact-error').hidden = true;
  $('contact-dialog').showModal();
  $('new-contact-name').focus();
}

$('add-contact').addEventListener('click', openContactDialog);
$('chat-search').addEventListener('input', () => {
  chatQuery = $('chat-search').value;
  renderContacts();
});
$('sync-chats').addEventListener('click', () => { void syncNativeChats(); });
$('refresh-empty-chats').addEventListener('click', () => { void syncNativeChats(); });
$('start-dictation').addEventListener('click', () => { void startDictation(); });
$('stop-dictation').addEventListener('click', stopDictation);
$('cancel-dictation').addEventListener('click', () => { cancelDictation(); });
$('contact-language').addEventListener('change', async () => {
  const contact = contactFor(selectedId);
  const language = $('contact-language').value;
  if (!contact || speechSession || pending || sending || changingLanguage || openingChatId) return;
  if (!languages().some((item) => item.code === language) || language === contact.language) return;
  changingLanguage = { contactId: contact.id, language };
  updateComposer();
  try {
    const response = await api('contact-language', changingLanguage);
    const updated = response.contact || response;
    if (updated.id === contact.id && state) state.contacts = state.contacts.map((item) => item.id === updated.id ? updated : item);
    await poll();
    toast('Язык собеседника сохранён. Уже отправленные сообщения сохраняют прежний перевод.');
  } catch (error) { toast(readableError(error.code)); await poll(); }
  finally {
    changingLanguage = null;
    if (state) render();
  }
});
$('add-first-contact').addEventListener('click', openContactDialog);
$('add-from-conversation').addEventListener('click', openContactDialog);
$('open-connection').addEventListener('click', () => {
  $('app').classList.add('chat-open');
  $('conversation-scroll').scrollTop = 0;
  $('connect-button').focus({ preventScroll: true });
});
$('close-contact-dialog').addEventListener('click', () => $('contact-dialog').close());
$('back-to-chats').addEventListener('click', () => {
  if (speechSession || changingLanguage || openingChatId) return;
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
  if (savingContact || openingChatId || state?.whatsapp.phase !== 'connected') return;
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
    const response = await api('contacts', { name, phone: number, language: $('new-contact-language').value || 'sr-Latn' });
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
  if ($('send-button').disabled || pending || sending || speechSession || changingLanguage || openingChatId) return;
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
    const previousPolling = polling;
    await api('login', { password: $('password').value });
    $('password').value = '';
    loginRequired = false;
    authGeneration++;
    if (previousPolling) await previousPolling;
    await poll();
  } catch (error) {
    $('login-error').textContent = error.status === 401 ? 'Пароль не подошёл. Попробуйте ещё раз.' : readableError(error.code);
    $('login-error').hidden = false;
  } finally { $('login-button').disabled = false; }
});

$('owner-logout').addEventListener('click', async () => {
  $('owner-logout').disabled = true;
  try {
    await api('logout', {});
    showLogin({ clear: true });
  } catch (error) { toast(readableError(error.code)); }
  finally { $('owner-logout').disabled = false; }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !loginRequired) void poll();
});
window.addEventListener('online', () => { if (!loginRequired) void poll(); });
window.addEventListener('pagehide', () => { cancelDictation(); });
if (selectedId) $('app').classList.add('chat-open');
if (pending?.contactId === selectedId) $('message-text').value = pending.text;
void poll();
