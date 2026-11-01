// Talks to server.js through the tunnel and keeps track of which link in the chain is broken.
const SERVER_KEY = 'rpt.server';
const TOKEN_KEY = 'rpt.token';

const HEALTH_TIMEOUT_MS = 7000;
const REQUEST_TIMEOUT_MS = 20000;

function read(key) {
    try {
        return localStorage.getItem(key) || '';
    } catch {
        return '';
    }
}

function write(key, value) {
    try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
    } catch { /* private mode: lives until the tab closes */ }
}

export class ApiError extends Error {
    constructor(code, message, status = 0) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export function normalizeServerUrl(raw) {
    let value = (raw || '').trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) {
        value = `${/^(localhost|127\.0\.0\.1)(:|$)/i.test(value) ? 'http' : 'https'}://${value}`;
    }
    try {
        const url = new URL(value);
        return url.origin;
    } catch {
        return '';
    }
}

export function getServer() {
    const stored = read(SERVER_KEY);
    if (stored) return stored;
    if (window.RPT_CONFIG?.defaultServer) return normalizeServerUrl(window.RPT_CONFIG.defaultServer);
    // The site opened straight from server.js: same address, no tunnel involved.
    if (['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '3000') return location.origin;
    return '';
}

export function setServer(url) {
    write(SERVER_KEY, url);
    checkConnection();
}

export function getToken() {
    return read(TOKEN_KEY);
}

export function setToken(token) {
    write(TOKEN_KEY, token);
}

// ---------------------------------------------------------------- connection state

export const LINK_MESSAGES = {
    checking: { title: 'Проверяем связь', text: 'Секунду.' },
    ok: { title: 'На связи', text: 'Сайт, сервер и SillyTavern работают.' },
    unset: {
        title: 'Адрес сервера не указан',
        text: 'Вставьте адрес туннеля в настройках, чтобы персонажи могли отвечать.',
    },
    offline: {
        title: 'Нет интернета',
        text: 'Устройство не в сети. История доступна, новые ответы придут после подключения.',
    },
    tunnel: {
        title: 'Туннель не отвечает',
        text: 'Cloudflare Tunnel выключен, или Quick Tunnel выдал новый адрес. Запустите туннель и обновите адрес в настройках.',
    },
    node: {
        title: 'Сервер Node.js выключен',
        text: 'Адрес отвечает, но сервер не работает. На компьютере владельца выполните node server.js.',
    },
    st: {
        title: 'SillyTavern выключена',
        text: 'Сервер работает, но SillyTavern на 127.0.0.1:8000 не отвечает. Запустите её на компьютере владельца.',
    },
};

let link = { state: 'checking', detail: null };
const listeners = new Set();

export function getLink() {
    return link;
}

export function onLinkChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function setLink(state, detail = null) {
    if (link.state === state && link.detail === detail) return;
    link = { state, detail };
    listeners.forEach((fn) => fn(link));
}

export function describeLink(current = link) {
    const base = LINK_MESSAGES[current.state] || LINK_MESSAGES.checking;
    return current.detail ? { ...base, text: current.detail } : base;
}

// CORS hides the error pages Cloudflare serves, but a no-cors probe still shows whether
// the address answers at all: it does when the tunnel is up and Node.js behind it is down.
async function classifyFailure(server) {
    if (navigator.onLine === false) return 'offline';
    try {
        await fetch(`${server}/`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return 'node';
    } catch {
        return 'tunnel';
    }
}

let checkRun = 0;

export async function checkConnection(server = getServer()) {
    if (!server) {
        setLink('unset');
        return link;
    }
    checkRun += 1;
    const run = checkRun;
    try {
        const response = await fetch(`${server}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        const data = await response.json();
        if (run !== checkRun) return link;
        if (data.service !== 'rp-tavern') setLink('node');
        else if (data.sillyTavern === 'up') setLink('ok');
        else setLink('st', data.message);
    } catch {
        const state = await classifyFailure(server);
        if (run === checkRun) setLink(state);
    }
    return link;
}

let heartbeat = null;

export function startHeartbeat() {
    if (heartbeat) return;
    const beat = () => {
        if (document.visibilityState === 'visible') {
            checkConnection();
            if (getToken()) verifySession().catch(() => {});
        }
    };
    heartbeat = setInterval(beat, 25000);
    document.addEventListener('visibilitychange', beat);
    window.addEventListener('online', beat);
    window.addEventListener('offline', () => setLink('offline'));
    beat();
}

// ---------------------------------------------------------------- requests

async function request(method, path, body, { timeout = REQUEST_TIMEOUT_MS, server = getServer(), auth = true } = {}) {
    if (!server) throw new ApiError('UNSET', LINK_MESSAGES.unset.text);
    let response;
    try {
        response = await fetch(`${server}${path}`, {
            method,
            cache: 'no-store',
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(auth && getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeout),
        });
    } catch {
        const state = await classifyFailure(server);
        setLink(state);
        throw new ApiError('NETWORK', describeLink().text);
    }
    let data = null;
    try {
        data = await response.json();
    } catch { /* an HTML error page from Cloudflare */ }
    if (!response.ok) {
        if (!data?.error) {
            setLink('node');
            throw new ApiError('NETWORK', LINK_MESSAGES.node.text, response.status);
        }
        if (data.error.code === 'ST_DOWN') setLink('st');
        if (data.error.code === 'UNAUTHORIZED') {
            setToken('');
            window.dispatchEvent(new CustomEvent('rpt:signed-out'));
        }
        throw new ApiError(data.error.code, data.error.message, response.status);
    }
    return data;
}

export async function login(server, code) {
    const { token } = await request('POST', '/api/login', { code }, { server, auth: false });
    write(SERVER_KEY, server);
    setToken(token);
    checkConnection(server);
    return token;
}

export function verifySession() {
    return request('GET', '/api/session');
}

export function logoutSession() {
    return request('DELETE', '/api/session');
}

async function adminRequest(method, path, body, token = '') {
    const server = getServer();
    if (!server) throw new ApiError('UNSET', LINK_MESSAGES.unset.text);
    let response;
    try {
        response = await fetch(`${server}${path}`, {
            method,
            cache: 'no-store',
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        throw new ApiError('NETWORK', 'Не удалось связаться с сервером. Проверь адрес туннеля.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data?.error?.code || 'ADMIN_ERROR', data?.error?.message || 'Ошибка панели администратора.', response.status);
    return data;
}

export function adminLogin(code) {
    return adminRequest('POST', '/api/admin/login', { code });
}

export function getAdminSessions(token) {
    return adminRequest('GET', '/api/admin/sessions', undefined, token);
}

export function endAdminSession(token, sessionId) {
    return adminRequest('DELETE', `/api/admin/sessions/${encodeURIComponent(sessionId)}`, undefined, token);
}

export function startGeneration(payload) {
    return request('POST', '/api/generate', payload);
}

export function readJob(jobId, from) {
    return request('GET', `/api/jobs/${jobId}?from=${from}`);
}

export function cancelJob(jobId) {
    return request('DELETE', `/api/jobs/${jobId}`);
}
