'use strict';
// RP Tavern bridge: site (GitHub Pages) -> Cloudflare Tunnel -> this server -> SillyTavern.
// No dependencies: `node server.js` is all it takes. Secrets live in config.local.json, never in docs/.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = process.env.RPT_CONFIG || path.join(__dirname, 'config.local.json');
const DOCS_DIR = ['public', 'docs'].map((folder) => path.join(__dirname, folder)).find((folder) => fs.existsSync(folder)) || __dirname;

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARS = 24000;
const MAX_ACTIVE_JOBS = 4;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS_PER_IP = 8;
const LOGIN_MAX_FAILS_TOTAL = 50;
const SETTINGS_CACHE_MS = 15 * 1000;

const DEFAULT_ORIGINS = ['https://*.github.io', 'http://localhost:*', 'http://127.0.0.1:*'];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

// ---------------------------------------------------------------- config

function loadConfig(configPath = CONFIG_PATH) {
    let config = {};
    let created = false;
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    const legacyCode = typeof config.accessCode === 'string' ? config.accessCode.trim() : '';
    let accessCodes = Array.isArray(config.accessCodes)
        ? [...new Set(config.accessCodes.filter((code) => typeof code === 'string').map((code) => code.trim()).filter(Boolean))]
        : (legacyCode ? [legacyCode] : []);
    if (!accessCodes.length) {
        accessCodes = [crypto.randomBytes(9).toString('base64url')];
        created = true;
    }
    if (JSON.stringify(config.accessCodes) !== JSON.stringify(accessCodes)) {
        config.accessCodes = accessCodes;
        created = true;
    }
    if (!accessCodes.includes(legacyCode)) {
        config.accessCode = accessCodes[0];
        created = true;
    }
    if (!config.secret) {
        config.secret = crypto.randomBytes(32).toString('hex');
        created = true;
    }
    if (created) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    }
    return { config, created };
}

function originAllowed(origin, patterns) {
    return patterns.some((pattern) => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        return new RegExp(`^${escaped}$`, 'i').test(origin);
    });
}

// ---------------------------------------------------------------- auth

function configuredAccessCodes(config) {
    const codes = Array.isArray(config.accessCodes) ? config.accessCodes : [config.accessCode];
    return [...new Set(codes.filter((code) => typeof code === 'string').map((code) => code.trim()).filter(Boolean))];
}

function signToken(config, accessCode = config.accessCode) {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
    return `${payload}.${tokenSignature(config, payload, accessCode)}`;
}

function tokenSignature(config, payload, accessCode = config.accessCode) {
    return crypto.createHmac('sha256', `${config.secret}:${accessCode}`).update(payload).digest('base64url');
}

function safeEqual(a, b) {
    const hashA = crypto.createHash('sha256').update(String(a)).digest();
    const hashB = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function tokenValid(config, token) {
    if (typeof token !== 'string' || !token.includes('.')) return false;
    const [payload, signature] = token.split('.');
    if (!configuredAccessCodes(config).some((code) => safeEqual(signature, tokenSignature(config, payload, code)))) return false;
    try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- SillyTavern client

function createSillyTavernClient(config) {
    const baseUrl = (config.sillyTavernUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    const basicAuth = config.sillyTavernBasicAuth
        ? `Basic ${Buffer.from(`${config.sillyTavernBasicAuth.user}:${config.sillyTavernBasicAuth.password}`).toString('base64')}`
        : null;
    let session = null;
    let settingsCache = null;

    function baseHeaders() {
        return basicAuth ? { Authorization: basicAuth } : {};
    }

    async function ping(timeoutMs = 3000) {
        const response = await fetch(`${baseUrl}/csrf-token`, {
            headers: baseHeaders(),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 401 || response.status === 403) {
            throw new ApiError(502, 'ST_FORBIDDEN', 'SillyTavern отклонила подключение: проверьте её логин или белый список адресов.');
        }
        if (!response.ok) throw new Error(`csrf-token: HTTP ${response.status}`);
        return response;
    }

    async function ensureSession(force = false) {
        if (session && !force) return session;
        const response = await ping(5000);
        const { token } = await response.json();
        const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        session = { token, cookie };
        return session;
    }

    async function post(route, body, signal, retry = true) {
        const { token, cookie } = await ensureSession();
        const response = await fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: {
                ...baseHeaders(),
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
                Cookie: cookie,
            },
            body: JSON.stringify(body),
            signal,
        });
        // SillyTavern restarted: the old session cookie is no longer valid.
        if (response.status === 403 && retry) {
            session = null;
            return post(route, body, signal, false);
        }
        return response;
    }

    async function readSettings() {
        if (settingsCache && Date.now() - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.value;
        const response = await post('/api/settings/get', {}, AbortSignal.timeout(8000));
        if (!response.ok) throw new Error(`settings/get: HTTP ${response.status}`);
        const data = await response.json();
        const value = typeof data.settings === 'string' ? JSON.parse(data.settings) : (data.settings || {});
        settingsCache = { at: Date.now(), value };
        return value;
    }

    return { baseUrl, ping, post, readSettings };
}

// Matches getChatCompletionModel() in SillyTavern's public/scripts/openai.js.
const MODEL_KEY_BY_SOURCE = { makersuite: 'google_model', vertexai: 'vertexai_model', custom: 'custom_model' };

function resolveBackend(settings, overrides = {}) {
    const mainApi = overrides.api || settings.main_api || 'openai';
    if (mainApi === 'openai') {
        const oai = settings.oai_settings || {};
        const source = overrides.source || oai.chat_completion_source || 'openai';
        const model = overrides.model || oai[MODEL_KEY_BY_SOURCE[source] || `${source}_model`];
        return {
            kind: 'chat',
            source,
            model,
            temperature: overrides.temperature ?? oai.temp_openai ?? 0.9,
            maxTokens: overrides.maxTokens ?? oai.openai_max_tokens ?? 600,
            customUrl: overrides.customUrl || oai.custom_url || '',
            oai,
        };
    }
    if (mainApi === 'textgenerationwebui') {
        const textgen = settings.textgenerationwebui_settings || {};
        const type = overrides.source || textgen.type || 'ooba';
        return {
            kind: 'text',
            type,
            server: overrides.customUrl || textgen.server_urls?.[type] || '',
            model: overrides.model || textgen[`${type}_model`],
            temperature: overrides.temperature ?? textgen.temp ?? 0.9,
            maxTokens: overrides.maxTokens ?? settings.amount_gen ?? 400,
        };
    }
    throw new ApiError(502, 'ST_UNSUPPORTED', `В SillyTavern выбран API «${mainApi}». RP Tavern работает с Chat Completion и Text Completion: переключите API в SillyTavern.`);
}

// ---------------------------------------------------------------- prompt

function clip(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function fillMacros(text, charName, userName) {
    return text.replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
}

function parseGenerateBody(body) {
    const character = body?.character;
    const name = clip(character?.name, 80).trim();
    if (!name) throw new ApiError(400, 'BAD_REQUEST', 'У персонажа нет имени.');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'В беседе нет сообщений.');
    }
    return {
        userName: clip(body.userName, 60).trim() || 'Гость',
        character: {
            name,
            description: clip(character.description, 8000),
            personality: clip(character.personality, 8000),
            scenario: clip(character.scenario, 8000),
        },
        messages: body.messages
            .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) })),
    };
}

function buildSystemPrompt({ character, userName }) {
    const parts = [
        `Это ролевая беседа. Ты отвечаешь только за персонажа ${character.name}, собеседник играет за ${userName}.`,
        'Оставайся в образе и не говори за собеседника. Действия пиши между *звёздочками*, речь в кавычках. Отвечай на языке собеседника.',
        'Все участники истории совершеннолетние. Никогда не изображай несовершеннолетних в сексуальном контексте.',
    ];
    if (character.description.trim()) parts.push(`Описание персонажа:\n${character.description.trim()}`);
    if (character.personality.trim()) parts.push(`Характер:\n${character.personality.trim()}`);
    if (character.scenario.trim()) parts.push(`Сценарий:\n${character.scenario.trim()}`);
    return fillMacros(parts.join('\n\n'), character.name, userName);
}

// Oldest messages are dropped first; the character sheet always stays in the prompt.
function trimHistory(messages, charName, userName, budget = MAX_CONTEXT_CHARS) {
    const kept = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const content = fillMacros(messages[i].content, charName, userName);
        if (kept.length > 0 && used + content.length > budget) break;
        used += content.length;
        kept.unshift({ role: messages[i].role, content });
    }
    return kept;
}

function buildRequest(backend, parsed) {
    const { character, userName } = parsed;
    const system = buildSystemPrompt(parsed);
    const history = trimHistory(parsed.messages, character.name, userName);

    if (backend.kind === 'chat') {
        const { oai } = backend;
        const body = {
            chat_completion_source: backend.source,
            model: backend.model,
            messages: [{ role: 'system', content: system }, ...history],
            temperature: backend.temperature,
            max_tokens: backend.maxTokens,
            stream: true,
            char_name: character.name,
            user_name: userName,
            group_names: [],
            custom_prompt_post_processing: oai.custom_prompt_post_processing,
            reverse_proxy: oai.reverse_proxy || undefined,
            proxy_password: oai.proxy_password || undefined,
        };
        if (backend.source === 'custom') {
            if (!backend.customUrl) {
                throw new ApiError(502, 'ST_NOT_CONFIGURED', 'В SillyTavern не указан адрес Custom API.');
            }
            body.custom_url = backend.customUrl;
            body.custom_include_body = oai.custom_include_body;
            body.custom_exclude_body = oai.custom_exclude_body;
            body.custom_include_headers = oai.custom_include_headers;
        }
        return { route: '/api/backends/chat-completions/generate', body };
    }

    if (!backend.server) {
        throw new ApiError(502, 'ST_NOT_CONFIGURED', 'В SillyTavern не указан адрес сервера Text Completion.');
    }
    const transcript = history
        .map((m) => `${m.role === 'user' ? userName : character.name}: ${m.content}`)
        .join('\n');
    const stop = [`\n${userName}:`];
    return {
        route: '/api/backends/text-completions/generate',
        body: {
            api_type: backend.type,
            api_server: backend.server,
            model: backend.model,
            prompt: `${system}\n\n${transcript}\n${character.name}:`,
            temperature: backend.temperature,
            max_tokens: backend.maxTokens,
            max_new_tokens: backend.maxTokens,
            stream: true,
            stop,
            stopping_strings: stop,
        },
    };
}

// Each provider SillyTavern proxies has its own response shape.
function extractText(data) {
    const choice = data.choices?.[0];
    if (choice) {
        const value = choice.delta?.content ?? choice.message?.content ?? choice.text;
        return typeof value === 'string' ? value : '';
    }
    if (typeof data.delta?.text === 'string') return data.delta.text;
    const parts = data.candidates?.[0]?.content?.parts || data.responseContent?.parts;
    if (Array.isArray(parts)) return parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (Array.isArray(data.content)) return data.content.map((c) => c.text || '').join('');
    if (typeof data.content === 'string') return data.content;
    if (typeof data.message?.content === 'string') return data.message.content;
    if (Array.isArray(data.message?.content)) return data.message.content.map((c) => c.text || '').join('');
    if (typeof data.token?.text === 'string') return data.token.text;
    if (typeof data.results?.[0]?.text === 'string') return data.results[0].text;
    return '';
}

function errorFromPayload(data) {
    if (!data?.error) return null;
    if (typeof data.error === 'string') return data.error;
    return data.error.message || data.message || '';
}

function backendError(detail) {
    const suffix = detail ? ` Ответ: ${String(detail).slice(0, 300)}` : '';
    return new ApiError(502, 'ST_BACKEND', `SillyTavern не смогла получить ответ от модели. Проверьте API-ключ и модель в SillyTavern.${suffix}`);
}

async function readCompletion(response, onText) {
    if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let detail = raw;
        try {
            detail = errorFromPayload(JSON.parse(raw)) ?? raw;
        } catch { /* not JSON, keep the raw text */ }
        throw backendError(detail);
    }

    const isStream = (response.headers.get('content-type') || '').includes('text/event-stream');
    if (!isStream) {
        const data = await response.json().catch(() => null);
        if (!data) throw backendError('');
        const failure = errorFromPayload(data);
        if (failure !== null) throw backendError(failure);
        onText(extractText(data));
        return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = (line) => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let data;
        try {
            data = JSON.parse(payload);
        } catch {
            return;
        }
        const failure = errorFromPayload(data);
        if (failure !== null) throw backendError(failure);
        onText(extractText(data));
    };
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.forEach(handleLine);
    }
    if (buffer) handleLine(buffer);
}

// ---------------------------------------------------------------- jobs
// The site polls instead of holding one long response: Quick Tunnels do not
// support SSE and Cloudflare cuts silent responses at about 100 seconds.

function createJobStore() {
    const jobs = new Map();

    function activeCount() {
        return [...jobs.values()].filter((job) => job.status === 'running').length;
    }

    function sweep() {
        const now = Date.now();
        for (const [id, job] of jobs) {
            if (job.status !== 'running' && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
        }
    }

    function finish(job, status, error) {
        if (job.status !== 'running') return;
        job.status = status;
        job.error = error || null;
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
    }

    function start(run) {
        sweep();
        if (activeCount() >= MAX_ACTIVE_JOBS) {
            throw new ApiError(429, 'BUSY', 'Сейчас обрабатывается слишком много ответов. Повторите через минуту.');
        }
        const job = {
            id: crypto.randomUUID(),
            status: 'running',
            text: '',
            error: null,
            finishedAt: 0,
            controller: new AbortController(),
        };
        job.timer = setTimeout(() => {
            finish(job, 'error', { code: 'TIMEOUT', message: 'Модель не ответила за 5 минут.' });
            job.controller.abort();
        }, JOB_TIMEOUT_MS);
        jobs.set(job.id, job);
        run(job).then(
            () => {
                if (!job.text.trim()) {
                    finish(job, 'error', { code: 'EMPTY', message: 'Модель вернула пустой ответ. Попробуйте ещё раз или проверьте настройки модели в SillyTavern.' });
                } else {
                    finish(job, 'done');
                }
            },
            (err) => {
                if (job.controller.signal.aborted) return;
                finish(job, 'error', {
                    code: err instanceof ApiError ? err.code : 'ST_DOWN',
                    message: err instanceof ApiError ? err.message : 'SillyTavern перестала отвечать. Проверьте, что она запущена.',
                });
            },
        );
        return job;
    }

    function cancel(job) {
        finish(job, 'cancelled');
        job.controller.abort();
    }

    return { jobs, start, cancel, sweep, activeCount };
}

// ---------------------------------------------------------------- http

function createApp(config) {
    const st = createSillyTavernClient(config);
    const jobStore = createJobStore();
    const fails = new Map();
    let totalFails = [];
    const allowedOrigins = config.allowedOrigins || DEFAULT_ORIGINS;

    function clientIp(req) {
        return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
    }

    function checkLoginLimit(req) {
        const now = Date.now();
        totalFails = totalFails.filter((at) => now - at < LOGIN_WINDOW_MS);
        const mine = (fails.get(clientIp(req)) || []).filter((at) => now - at < LOGIN_WINDOW_MS);
        if (mine.length >= LOGIN_MAX_FAILS_PER_IP || totalFails.length >= LOGIN_MAX_FAILS_TOTAL) {
            throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Слишком много неверных попыток. Подождите 10 минут.');
        }
    }

    function recordLoginFail(req) {
        const now = Date.now();
        const ip = clientIp(req);
        fails.set(ip, [...(fails.get(ip) || []).filter((at) => now - at < LOGIN_WINDOW_MS), now]);
        totalFails.push(now);
    }

    async function readJson(req) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) throw new ApiError(413, 'TOO_LARGE', 'Запрос слишком большой.');
            chunks.push(chunk);
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
            throw new ApiError(400, 'BAD_REQUEST', 'Некорректный запрос.');
        }
    }

    function requireAuth(req) {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!tokenValid(config, token)) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Сессия устарела. Введите код доступа заново.');
        }
    }

    function sendJson(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    async function handleHealth(res) {
        let sillyTavern = 'up';
        let message = null;
        try {
            await st.ping();
        } catch (err) {
            sillyTavern = err instanceof ApiError ? 'forbidden' : 'down';
            message = err instanceof ApiError ? err.message : null;
        }
        sendJson(res, 200, { ok: true, service: 'rp-tavern', sillyTavern, message });
    }

    async function handleGenerate(req, res) {
        requireAuth(req);
        const parsed = parseGenerateBody(await readJson(req));

        let backend;
        try {
            backend = resolveBackend(await st.readSettings(), config.generation || {});
        } catch (err) {
            if (err instanceof ApiError) throw err;
            throw new ApiError(503, 'ST_DOWN', 'SillyTavern не отвечает. Запустите её на компьютере владельца.');
        }
        const { route, body } = buildRequest(backend, parsed);

        const job = jobStore.start(async (current) => {
            const response = await st.post(route, body, current.controller.signal);
            await readCompletion(response, (text) => {
                if (current.status === 'running') current.text += text;
            });
        });
        sendJson(res, 202, { jobId: job.id });
    }

    function handleJobGet(req, res, job, url) {
        requireAuth(req);
        const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
        sendJson(res, 200, {
            status: job.status,
            text: job.text.slice(from),
            length: job.text.length,
            error: job.error,
        });
    }

    function serveStatic(req, res, url) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            throw new ApiError(405, 'METHOD', 'Метод не поддерживается.');
        }
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const target = path.resolve(DOCS_DIR, relative);
        if (target !== DOCS_DIR && !target.startsWith(DOCS_DIR + path.sep)) {
            throw new ApiError(404, 'NOT_FOUND', 'Не найдено.');
        }
        fs.readFile(target, (err, data) => {
            if (err) {
                sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Не найдено.' } });
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
            });
            res.end(req.method === 'HEAD' ? undefined : data);
        });
    }

    async function route(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;

        if (pathname === '/api/health' && req.method === 'GET') return handleHealth(res);

        if (pathname === '/api/login' && req.method === 'POST') {
            checkLoginLimit(req);
            const { code } = await readJson(req);
            const accessCode = typeof code === 'string'
                ? configuredAccessCodes(config).find((candidate) => safeEqual(code.trim(), candidate))
                : null;
            if (!accessCode) {
                recordLoginFail(req);
                throw new ApiError(403, 'BAD_CODE', 'Неверный код доступа.');
            }
            return sendJson(res, 200, { token: signToken(config, accessCode) });
        }

        if (pathname === '/api/session' && req.method === 'GET') {
            requireAuth(req);
            return sendJson(res, 200, { ok: true });
        }

        if (pathname === '/api/generate' && req.method === 'POST') return handleGenerate(req, res);

        const jobMatch = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
        if (jobMatch) {
            requireAuth(req);
            const job = jobStore.jobs.get(jobMatch[1]);
            if (!job) throw new ApiError(404, 'JOB_GONE', 'Этот ответ больше недоступен: сервер перезапускался или прошло слишком много времени.');
            if (req.method === 'GET') return handleJobGet(req, res, job, url);
            if (req.method === 'DELETE') {
                jobStore.cancel(job);
                return sendJson(res, 200, { ok: true });
            }
        }

        if (pathname.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', 'Не найдено.');
        return serveStatic(req, res, url);
    }

    const server = http.createServer(async (req, res) => {
        const origin = req.headers.origin;
        if (origin && originAllowed(origin, allowedOrigins)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        try {
            await route(req, res);
        } catch (err) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (err instanceof ApiError) {
                sendJson(res, err.status, { error: { code: err.code, message: err.message } });
            } else {
                console.error('[rp-tavern]', err);
                sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера.' } });
            }
        }
    });
    return { server, st, jobStore };
}

function main() {
    const { config, created } = loadConfig();
    const port = Number(process.env.PORT || config.port || 3000);
    const { server, st, jobStore } = createApp(config);
    setInterval(jobStore.sweep, 60 * 1000).unref();

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Порт ${port} уже занят. Закройте другой запущенный сервер или укажите "port" в config.local.json.`);
            process.exit(1);
        }
        throw err;
    });
    // Loopback only: the outside world gets in through the tunnel, not the local network.
    server.listen(port, '127.0.0.1', async () => {
        console.log(`RP Tavern: http://localhost:${port}`);
        console.log(`Коды доступа (${configuredAccessCodes(config).length}):`);
        configuredAccessCodes(config).forEach((code, index) => console.log(`  ${index + 1}. ${code}`));
        console.log(`Добавляйте и удаляйте ключи в config.local.json, затем перезапустите сервер.${created ? ' Конфигурация создана или обновлена.' : ''}`);
        console.log(`Туннель:     cloudflared tunnel --url http://127.0.0.1:${port}`);
        try {
            await st.ping();
            console.log(`SillyTavern: на связи (${st.baseUrl})`);
        } catch {
            console.log(`SillyTavern: НЕ отвечает на ${st.baseUrl}. Запустите её, чаты до этого работать не будут.`);
        }
    });
}

if (require.main === module) main();

module.exports = { createApp, loadConfig, originAllowed, buildRequest, resolveBackend, parseGenerateBody, trimHistory, extractText };
