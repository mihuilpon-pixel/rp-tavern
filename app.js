// RP Tavern frontend connected to ../server.js API.
const $ = selector => document.querySelector(selector);
const apiQuery = new URLSearchParams(location.search).get('api');
if (apiQuery) {
  localStorage.setItem('rp-api-base', apiQuery.replace(/\/$/, ''));
  history.replaceState(null, '', location.pathname + location.hash);
}
let apiBase = localStorage.getItem('rp-api-base') || '';
let token = sessionStorage.getItem('rp-session-token') || '';
let bots = [];
let currentBot = null;
let requestBusy = false;
let toastTimer;

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
    if (!bots.length) showEmpty();
    else if (!currentBot || !bots.some(bot => bot.id === currentBot)) await selectBot(bots[0].id);
  } catch (error) { toast(error.message); }
}
function renderBots() {
  $('#bot-count').textContent = String(bots.length);
  const list = $('#bot-list'); list.replaceChildren();
  for (const bot of bots) {
    const button = document.createElement('button');
    button.className = `bot-item${currentBot === bot.id ? ' active' : ''}`;
    button.type = 'button';
    button.innerHTML = `<span class="avatar bot-avatar ${bots.indexOf(bot)%2?'alt':''}">${escapeHtml((bot.name || '?').slice(0,1).toUpperCase())}</span><span class="bot-text"><b>${escapeHtml(bot.name)}</b><small>${escapeHtml(bot.description || 'Персонаж SillyTavern')}</small></span>`;
    button.addEventListener('click', () => selectBot(bot.id));
    list.append(button);
  }
}
function showEmpty() {
  currentBot = null; $('#chat-view').classList.add('hidden'); $('#empty-state').classList.remove('hidden');
  $('#header-title').textContent = 'Ролевые истории'; renderBots();
}
async function selectBot(id) {
  const bot = bots.find(item => item.id === id); if (!bot) return;
  currentBot = id; renderBots(); $('#empty-state').classList.add('hidden'); $('#chat-view').classList.remove('hidden');
  $('#chat-name').textContent = bot.name; $('#chat-avatar').textContent = (bot.name || '?').slice(0,1).toUpperCase();
  $('#chat-avatar').className = `avatar bot-avatar ${bots.indexOf(bot)%2?'alt':''}`; $('#header-title').textContent = bot.name;
  $('#messages').replaceChildren();
  try {
    const messages = await api(`/api/chat/${encodeURIComponent(id)}`);
    for (const message of messages) appendMessage(message.role, message.content, bot.name);
  } catch (error) { appendMessage('system', error.message); }
  if (window.innerWidth <= 720) $('#sidebar').classList.remove('open');
}
function appendMessage(role, text, botName = '') {
  const node = document.createElement('div'); node.className = `message ${role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system'}`;
  if (role === 'assistant' && botName) {
    const sender = document.createElement('span'); sender.className = 'sender'; sender.textContent = botName; node.append(sender);
  }
  node.append(document.createTextNode(String(text ?? ''))); $('#messages').append(node); $('#messages').scrollTop = $('#messages').scrollHeight;
  return node;
}

function openDialog(id) { $(id).showModal(); }
['#add-bot','#add-bot-side','#empty-create'].forEach(selector => $(selector).addEventListener('click', () => openDialog('#bot-dialog')));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
$('#bot-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#bot-error').textContent = '';
  const form = event.currentTarget;
  const button = $('#create-bot-button'); button.disabled = true;
  try {
    const bot = await api('/api/bots', 'POST', {
      name: $('#bot-name').value.trim(), description: $('#bot-desc').value.trim(),
      personality: $('#bot-personality').value.trim(), scenario: $('#bot-scenario').value.trim(),
      first_mes: $('#bot-greeting').value.trim(),
    });
    form.reset(); $('#bot-dialog').close();
    bots.unshift(bot); renderBots(); await selectBot(bot.id); toast('Персонаж создан в SillyTavern.');
  } catch (error) { $('#bot-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#message-input').value.trim();
  if (!text || !currentBot || requestBusy) return;
  requestBusy = true; $('#message-input').value = '';
  appendMessage('user', text);
  const pending = appendMessage('assistant', '…', $('#chat-name').textContent);
  const send = event.currentTarget.querySelector('button'); send.disabled = true;
  try {
    const data = await api(`/api/chat/${encodeURIComponent(currentBot)}`, 'POST', {text});
    pending.replaceChildren(); pending.append(document.createTextNode(data.reply || ''));
  } catch (error) {
    pending.className = 'message system'; pending.textContent = `Не удалось получить ответ: ${error.message}`;
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
$('#close-sidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));
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
