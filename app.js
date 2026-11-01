// RP Tavern frontend connected to ../server.js API.
const $ = selector => document.querySelector(selector);
const DEFAULT_API_BASE = 'https://vacancies-invision-tracked-collaborative.trycloudflare.com';
const API_DEFAULT_REVISION = 'quick-tunnel-2026-11-01-2';
if (localStorage.getItem('rp-api-default-revision') !== API_DEFAULT_REVISION) {
  localStorage.setItem('rp-api-base', DEFAULT_API_BASE);
  localStorage.setItem('rp-api-default-revision', API_DEFAULT_REVISION);
}
const apiQuery = new URLSearchParams(location.search).get('api');
if (apiQuery) {
  localStorage.setItem('rp-api-base', apiQuery.replace(/\/$/, ''));
  history.replaceState(null, '', location.pathname + location.hash);
}
let apiBase = localStorage.getItem('rp-api-base') || DEFAULT_API_BASE;
let token = sessionStorage.getItem('rp-session-token') || '';
let bots = [];
let currentBot = null;
let requestBusy = false;
let toastTimer;
let botPhotoData = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}
async function api(path, method = 'GET', body) {
  const headers = {'Content-Type':'application/json'};
  if (token) headers['x-token'] = token;
  const response = await fetch(apiBase + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && token) logout(false);
    throw new Error(data.error || `Ошибка сервера (${response.status})`);
  }
  return data;
}

function enterApp() {
  $('#gate').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#connection-dot').classList.add('online'); $('#connection-label').textContent = 'Сервер сайта';
  $('#connection-detail').textContent = 'Ответы через SillyTavern';
}
async function login(code, adult) {
  if (!adult) throw new Error('Подтверди, что тебе исполнилось 18 лет.');
  const data = await api('/api/login', 'POST', {code, adult});
  token = data.token; sessionStorage.setItem('rp-session-token', token);
  enterApp(); await loadBots();
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try { await login($('#code').value.trim(), $('#adult').checked); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});

async function loadBots() {
  try {
    bots = await api('/api/bots'); renderBots();
    if (!bots.length) {
      showEmpty();
      if (window.innerWidth <= 720) $('#sidebar').classList.add('open');
    } else if (!currentBot || !bots.some(bot => bot.id === currentBot)) {
      if (window.innerWidth <= 720) {
        showEmpty();
        $('#sidebar').classList.add('open');
      } else await selectBot(bots[0].id);
    }
  } catch (error) { toast(error.message); }
}
function renderBots() {
  $('#bot-count').textContent = String(bots.length);
  const list = $('#bot-list'); list.replaceChildren();
  for (const bot of bots) {
    const item = document.createElement('div');
    item.className = `bot-item${currentBot === bot.id ? ' active' : ''}`;
    const avatar = bot.avatar
      ? `<span class="avatar bot-avatar has-photo"><img src="${escapeHtml(bot.avatar)}" alt=""></span>`
      : `<span class="avatar bot-avatar ${bots.indexOf(bot)%2?'alt':''}">${escapeHtml((bot.name || '?').slice(0,1).toUpperCase())}</span>`;
    const select = document.createElement('button');
    select.className = 'bot-select'; select.type = 'button';
    select.innerHTML = `${avatar}<span class="bot-text"><b>${escapeHtml(bot.name)}</b><small>${escapeHtml(bot.description || 'Персонаж SillyTavern')}</small></span>`;
    select.addEventListener('click', () => selectBot(bot.id));
    item.append(select);
    if (bot.stName) {
      const remove = document.createElement('button');
      remove.className = 'bot-delete'; remove.type = 'button'; remove.textContent = '🗑';
      remove.title = `Удалить ${bot.name}`; remove.setAttribute('aria-label', `Удалить бота ${bot.name}`);
      remove.addEventListener('click', () => deleteBot(bot.id, remove));
      item.append(remove);
    }
    list.append(item);
  }
}
function showEmpty() {
  $('#app').classList.remove('chat-open');
  currentBot = null; $('#chat-view').classList.add('hidden'); $('#empty-state').classList.remove('hidden');
  $('#header-title').textContent = 'Ролевые истории';
  if (window.innerWidth <= 720) $('#sidebar').classList.add('open');
  renderBots();
}
async function selectBot(id) {
  const bot = bots.find(item => item.id === id); if (!bot) return;
  $('#app').classList.toggle('chat-open', window.innerWidth <= 720);
  currentBot = id; renderBots(); $('#empty-state').classList.add('hidden'); $('#chat-view').classList.remove('hidden');
  $('#delete-bot').hidden = !bot.stName;
  $('#chat-name').textContent = bot.name;
  $('#chat-avatar').className = `avatar bot-avatar ${bots.indexOf(bot)%2?'alt':''}${bot.avatar?' has-photo':''}`;
  $('#chat-avatar').replaceChildren();
  if (bot.avatar) { const image = document.createElement('img'); image.src = bot.avatar; image.alt = ''; $('#chat-avatar').append(image); }
  else $('#chat-avatar').textContent = (bot.name || '?').slice(0,1).toUpperCase();
  $('#header-title').textContent = bot.name;
  await refreshMessages(id, bot.name);
  if (window.innerWidth <= 720) $('#sidebar').classList.remove('open');
}
async function refreshMessages(botId = currentBot, botName = $('#chat-name').textContent) {
  try {
    const history = await api(`/api/chat/${encodeURIComponent(botId)}`);
    if (currentBot !== botId) return;
    $('#messages').replaceChildren();
    history.forEach((message, index) => appendMessage(message.role, message.content, botName, index));
    $('#messages').scrollTop = $('#messages').scrollHeight;
  } catch (error) {
    if (currentBot === botId) appendMessage('system', error.message);
  }
}
function appendMessage(role, text, botName = '', messageIndex = null) {
  const node = document.createElement('div'); node.className = `message ${role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system'}`;
  if (Number.isInteger(messageIndex)) node.dataset.messageIndex = String(messageIndex);
  if (role === 'assistant' && botName) {
    const sender = document.createElement('span'); sender.className = 'sender'; sender.textContent = botName; node.append(sender);
  }
  const content = document.createElement('div'); content.className = 'message-content'; content.textContent = String(text ?? ''); node.append(content);
  if ((role === 'user' || role === 'assistant') && Number.isInteger(messageIndex)) {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '✎'; edit.title = 'Редактировать'; edit.setAttribute('aria-label', 'Редактировать сообщение');
    edit.addEventListener('click', () => editMessage(messageIndex, content, actions));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Удалить'; remove.setAttribute('aria-label', 'Удалить сообщение');
    remove.addEventListener('click', () => removeMessage(messageIndex));
    actions.append(edit, remove); node.append(actions);
  }
  $('#messages').append(node); $('#messages').scrollTop = $('#messages').scrollHeight;
  return node;
}

async function editMessage(index, content, actions) {
  if (requestBusy || !currentBot || content.dataset.editing) return;
  const botId = currentBot, oldText = content.textContent;
  content.dataset.editing = 'true';
  const editor = document.createElement('textarea'); editor.className = 'message-edit-input'; editor.maxLength = 20000; editor.value = oldText;
  const controls = document.createElement('div'); controls.className = 'message-edit-actions';
  const saveButton = document.createElement('button'); saveButton.type = 'button'; saveButton.className = 'message-save'; saveButton.textContent = 'Сохранить';
  const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.className = 'message-cancel'; cancelButton.textContent = 'Отмена';
  controls.append(saveButton, cancelButton); content.replaceChildren(editor, controls); actions.hidden = true; editor.focus();
  cancelButton.addEventListener('click', () => refreshMessages(botId));
  saveButton.addEventListener('click', async () => {
    const text = editor.value.trim();
    if (!text) { editor.focus(); return; }
    saveButton.disabled = cancelButton.disabled = true;
    try {
      await api(`/api/chat/${encodeURIComponent(botId)}/${index}`, 'PATCH', {content: text});
      await refreshMessages(botId);
      toast('Сообщение изменено.');
    } catch (error) {
      saveButton.disabled = cancelButton.disabled = false; toast(error.message);
    }
  });
}

async function removeMessage(index) {
  if (requestBusy || !currentBot) return;
  const botId = currentBot;
  if (!window.confirm('Удалить это сообщение из переписки?')) return;
  try {
    await api(`/api/chat/${encodeURIComponent(botId)}/${index}`, 'DELETE');
    await refreshMessages(botId); toast('Сообщение удалено.');
  } catch (error) { toast(error.message); }
}

async function deleteBot(id, trigger) {
  const bot = bots.find(item => item.id === id);
  if (!bot?.stName) return;
  if (!window.confirm(`Удалить «${bot.name}»? Карточка персонажа и её переписки также будут удалены из SillyTavern.`)) return;
  const button = trigger || $('#delete-bot');
  button.disabled = true;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}`, 'DELETE');
    bots = bots.filter(item => item.id !== bot.id);
    if (currentBot === bot.id) {
      currentBot = null;
      if (bots.length) await selectBot(bots[0].id); else showEmpty();
    } else renderBots();
    toast('Бот и его переписки удалены.');
  } catch (error) {
    toast(error.message);
  } finally { button.disabled = false; }
}
$('#delete-bot').addEventListener('click', event => deleteBot(currentBot, event.currentTarget));

function openDialog(id) { $(id).showModal(); }
$('#tariffs-open').addEventListener('click', () => openDialog('#tariff-dialog'));
document.querySelectorAll('.tariff-select').forEach(button => button.addEventListener('click', () => {
  const result = $('#tariff-result');
  result.replaceChildren(document.createTextNode(`Выбран тариф «${button.dataset.tariff}» — ${button.dataset.price}. Чтобы подключить его и получить код доступа, напиши мне в Telegram: `));
  const contact = document.createElement('a');
  contact.href = 'https://t.me/pipirkaser';
  contact.target = '_blank';
  contact.rel = 'noopener noreferrer';
  contact.textContent = '@pipirkaser';
  result.append(contact, document.createTextNode('.'));
}));
['#add-bot','#add-bot-side','#empty-create'].forEach(selector => $(selector).addEventListener('click', () => openDialog('#bot-dialog')));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.close).close()));

$('#bot-photo').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  $('#bot-error').textContent = '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    $('#bot-error').textContent = 'Выбери изображение JPG, PNG или WebP.'; event.target.value = ''; return;
  }
  if (file.size > 10 * 1024 * 1024) {
    $('#bot-error').textContent = 'Размер изображения должен быть не больше 10 МБ.'; event.target.value = ''; return;
  }
  try {
    const source = await createImageBitmap(file);
    const edge = Math.min(source.width, source.height);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    context.drawImage(source, (source.width - edge) / 2, (source.height - edge) / 2, edge, edge, 0, 0, 512, 512);
    source.close();
    botPhotoData = canvas.toDataURL('image/jpeg', 0.82);
    $('#bot-photo-preview').src = botPhotoData; $('#bot-photo-preview').hidden = false;
    $('#bot-photo-placeholder').hidden = true; $('#bot-photo-label').textContent = 'Изменить фотографию';
  } catch {
    $('#bot-error').textContent = 'Не удалось прочитать это изображение.'; event.target.value = '';
  }
});

$('#bot-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#bot-error').textContent = '';
  const form = event.currentTarget;
  const button = $('#create-bot-button'); button.disabled = true;
  try {
    const bot = await api('/api/bots', 'POST', {
      name: $('#bot-name').value.trim(), description: $('#bot-desc').value.trim(),
      personality: $('#bot-personality').value.trim(), scenario: $('#bot-scenario').value.trim(),
      first_mes: $('#bot-greeting').value.trim(),
      avatarData: botPhotoData,
    });
    botPhotoData = ''; $('#bot-photo-preview').removeAttribute('src'); $('#bot-photo-preview').hidden = true;
    $('#bot-photo-placeholder').hidden = false; $('#bot-photo-label').textContent = 'Добавить фотографию';
    form.reset(); $('#bot-dialog').close();
    bots.unshift(bot); renderBots(); await selectBot(bot.id); toast('Персонаж создан в SillyTavern.');
  } catch (error) { $('#bot-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const inputText = $('#message-input').value.trim();
  if (!currentBot || requestBusy) return;
  const text = inputText || '[Пропуск]';
  requestBusy = true; const botId = currentBot; $('#message-input').value = '';
  appendMessage('user', text);
  const pending = appendMessage('assistant', '…', $('#chat-name').textContent);
  const send = event.currentTarget.querySelector('button'); send.disabled = true;
  try {
    await api(`/api/chat/${encodeURIComponent(botId)}`, 'POST', {text});
    await refreshMessages(botId);
  } catch (error) {
    pending.className = 'message system'; pending.textContent = `Не удалось получить ответ: ${error.message}`;
    if (currentBot === botId) await refreshMessages(botId);
  } finally { requestBusy = false; send.disabled = false; $('#message-input').focus(); }
});
$('#message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#message-form').requestSubmit(); }
});

function logout(reload = true) {
  token = ''; sessionStorage.removeItem('rp-session-token');
  if (reload) location.reload(); else { $('#app').classList.add('hidden'); $('#gate').classList.remove('hidden'); }
}
$('#logout').addEventListener('click', () => logout());
$('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('#chat-back').addEventListener('click', () => {
  $('#chat-view').classList.add('hidden'); $('#empty-state').classList.add('hidden');
  $('#sidebar').classList.add('open');
});
$('#close-sidebar').addEventListener('click', () => {
  $('#sidebar').classList.remove('open');
  if (currentBot) { $('#empty-state').classList.add('hidden'); $('#chat-view').classList.remove('hidden'); }
  else { $('#chat-view').classList.add('hidden'); $('#empty-state').classList.remove('hidden'); }
});
$('#api-settings-open').addEventListener('click', () => openDialog('#settings-dialog'));
$('#api-settings').addEventListener('click', () => openDialog('#settings-dialog'));
$('#api-settings-top').addEventListener('click', () => openDialog('#settings-dialog'));
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  let url = $('#api-url').value.trim().replace(/\/$/, '');
  if (url && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) {
    toast('Для публичного сервера нужен HTTPS адрес.'); return;
  }
  apiBase = url; if (url) localStorage.setItem('rp-api-base', url); else localStorage.removeItem('rp-api-base');
  $('#settings-dialog').close(); toast('Адрес сервера сохранён.');
});
$('#api-url').value = apiBase;

if (token) {
  enterApp();
  loadBots().catch(() => logout(false));
}
