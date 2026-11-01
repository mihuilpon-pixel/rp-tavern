'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, originAllowed, trimHistory, extractText, resolveBackend, buildRequest, parseGenerateBody } = require('../server.js');

const SETTINGS = {
    main_api: 'openai',
    oai_settings: { chat_completion_source: 'custom', custom_model: 'mock', custom_url: 'http://mock/v1', temp_openai: 1, openai_max_tokens: 100 },
};

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

// Behaves like AI service: CSRF session, settings, streamed generation.
function fakeAIService(behaviour) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (req.url === '/csrf-token') {
                res.setHeader('Set-Cookie', 'session=abc; Path=/');
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ token: 'csrf' }));
            }
            if (req.headers['x-csrf-token'] !== 'csrf' || !String(req.headers.cookie).includes('session=abc')) {
                res.statusCode = 403;
                return res.end('Invalid CSRF token');
            }
            const body = raw ? JSON.parse(raw) : {};
            calls.push({ url: req.url, body });
            if (req.url === '/api/settings/get') {
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ settings: JSON.stringify(behaviour.settings || SETTINGS) }));
            }
            return behaviour.generate(req, res, body);
        });
    });
    return { server, calls };
}

function streamWords(res, words) {
    res.setHeader('Content-Type', 'text/event-stream');
    for (const word of words) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
}

async function setup(behaviour, t, overrides = {}) {
    const fake = fakeAIService(behaviour);
    const stPort = await listen(fake.server);
    const config = { accessCode: 'open-sesame', secret: 'test-secret', aiServiceUrl: `http://127.0.0.1:${stPort}`, ...overrides };
    const { server } = createApp(config);
    const port = await listen(server);
    t.after(() => {
        server.close();
        server.closeAllConnections();
        fake.server.close();
        fake.server.closeAllConnections();
    });
    const base = `http://127.0.0.1:${port}`;
    const login = async () => (await (await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ code: 'open-sesame' }) })).json()).token;
    return { base, login, calls: fake.calls, fake };
}

const GENERATE_BODY = {
    userName: 'Лео',
    character: { name: 'Марта', description: 'Хозяйка {{char}}', personality: 'Тёплая', scenario: 'Вечер' },
    messages: [{ role: 'assistant', content: 'Привет' }, { role: 'user', content: 'Здравствуй' }],
};

async function waitForJob(base, token, jobId) {
    for (let i = 0; i < 100; i += 1) {
        const res = await fetch(`${base}/api/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (data.status !== 'running') return data;
        await new Promise((r) => { setTimeout(r, 10); });
    }
    throw new Error('job did not finish');
}

async function startJob(base, token, body = GENERATE_BODY) {
    return fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('login rejects a wrong code and locks after repeated failures', async (t) => {
    const { base } = await setup({}, t);
    const attempt = (code) => fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ code }) });
    assert.equal((await attempt('wrong')).status, 403);
    for (let i = 0; i < 7; i += 1) await attempt('wrong');
    const locked = await attempt('open-sesame');
    assert.equal(locked.status, 429);
    assert.equal((await locked.json()).error.code, 'TOO_MANY_ATTEMPTS');
});

test('protected routes need a valid token and a changed code invalidates it', async (t) => {
    const { base, login } = await setup({}, t);
    assert.equal((await fetch(`${base}/api/session`)).status, 401);
    const token = await login();
    assert.equal((await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${token}x` } })).status, 401);

    const other = createApp({ accessCode: 'another-code', secret: 'test-secret', aiServiceUrl: 'http://127.0.0.1:9' });
    const port = await listen(other.server);
    t.after(() => other.server.close());
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('admin can list active sessions and revoke one', async (t) => {
    const { base, login } = await setup({}, t, { adminCode: 'admin-secret' });
    const userToken = await login();
    const adminLogin = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'admin-secret' }),
    });
    assert.equal(adminLogin.status, 200);
    const { token: adminToken } = await adminLogin.json();
    const headers = { Authorization: `Bearer ${adminToken}` };

    const listed = await fetch(`${base}/api/admin/sessions`, { headers });
    assert.equal(listed.status, 200);
    const { sessions } = await listed.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].codeHint, 'same');

    const revoked = await fetch(`${base}/api/admin/sessions/${sessions[0].id}`, { method: 'DELETE', headers });
    assert.equal(revoked.status, 200);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${userToken}` } })).status, 401);
    assert.equal((await (await fetch(`${base}/api/admin/sessions`, { headers })).json()).sessions.length, 0);
});

test('generation streams through a job and the request reaches AI service', async (t) => {
    const { base, login, calls } = await setup({ generate: (req, res) => streamWords(res, ['Добро ', 'пожаловать']) }, t);
    const token = await login();
    const started = await startJob(base, token);
    assert.equal(started.status, 202);
    const { jobId } = await started.json();
    const result = await waitForJob(base, token, jobId);
    assert.equal(result.status, 'done');
    assert.equal(result.text, 'Добро пожаловать');

    const partial = await (await fetch(`${base}/api/jobs/${jobId}?from=6`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(partial.text, 'пожаловать');

    const sent = calls.find((c) => c.url === '/api/backends/chat-completions/generate').body;
    assert.equal(sent.chat_completion_source, 'custom');
    assert.equal(sent.custom_url, 'http://mock/v1');
    assert.equal(sent.model, 'mock');
    assert.equal(sent.messages[0].role, 'system');
    assert.match(sent.messages[0].content, /Хозяйка Марта/);
    assert.deepEqual(sent.messages.at(-1), { role: 'user', content: 'Здравствуй' });
});

test('model failures surface as readable errors', async (t) => {
    const { base, login } = await setup({
        generate: (req, res) => {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: true }));
        },
    }, t);
    const token = await login();
    const { jobId } = await (await startJob(base, token)).json();
    const result = await waitForJob(base, token, jobId);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'ST_BACKEND');
    assert.match(result.error.message, /API-ключ/);
});

test('an empty model reply is an error, not a blank message', async (t) => {
    const { base, login } = await setup({ generate: (req, res) => streamWords(res, []) }, t);
    const token = await login();
    const { jobId } = await (await startJob(base, token)).json();
    const result = await waitForJob(base, token, jobId);
    assert.equal(result.error.code, 'EMPTY');
});

test('cancel aborts the job and keeps it from completing', async (t) => {
    const { base, login } = await setup({
        generate: (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'нач' } }] })}\n\n`);
        },
    }, t);
    const token = await login();
    const { jobId } = await (await startJob(base, token)).json();
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/api/jobs/${jobId}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json()).status, 'cancelled');
});

test('health tells apart a stopped AI service', async (t) => {
    const { server } = createApp({ accessCode: 'x', secret: 'y', aiServiceUrl: 'http://127.0.0.1:9' });
    const port = await listen(server);
    t.after(() => server.close());
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.engine, 'down');

    const down = await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: JSON.stringify({ code: 'x' }) })).json();
    const started = await startJob(`http://127.0.0.1:${port}`, down.token);
    assert.equal(started.status, 503);
    assert.equal((await started.json()).error.code, 'ST_DOWN');
});

test('static files stay inside docs and config is not served', async (t) => {
    const { base } = await setup({}, t);
    for (const target of ['/..%2fserver.js', '/..%2fconfig.local.json', '/%2e%2e/package.json']) {
        assert.equal((await fetch(`${base}${target}`)).status, 404, target);
    }
});

test('CORS allows GitHub Pages and refuses unknown origins', () => {
    const patterns = ['https://*.github.io', 'http://localhost:*'];
    assert.ok(originAllowed('https://someone.github.io', patterns));
    assert.ok(originAllowed('http://localhost:5173', patterns));
    assert.ok(!originAllowed('https://evil.example', patterns));
    assert.ok(!originAllowed('https://github.io.evil.example', patterns));
    assert.ok(!originAllowed('https://a.b.github.io.evil.example', patterns));
});

test('history trimming drops the oldest messages but keeps the latest', () => {
    const messages = [
        { role: 'user', content: 'a'.repeat(50) },
        { role: 'assistant', content: 'b'.repeat(50) },
        { role: 'user', content: 'c'.repeat(50) },
    ];
    const kept = trimHistory(messages, 'X', 'Y', 110);
    assert.equal(kept.length, 2);
    assert.equal(kept[1].content[0], 'c');
    assert.equal(trimHistory([{ role: 'user', content: 'z'.repeat(500) }], 'X', 'Y', 10).length, 1);
});

test('text completion backend gets a transcript prompt and stop strings', () => {
    const backend = resolveBackend({ main_api: 'textgenerationwebui', textgenerationwebui_settings: { type: 'koboldcpp', server_urls: { koboldcpp: 'http://k' } } });
    const { route, body } = buildRequest(backend, parseGenerateBody(GENERATE_BODY));
    assert.equal(route, '/api/backends/text-completions/generate');
    assert.equal(body.api_type, 'koboldcpp');
    assert.match(body.prompt, /Лео: Здравствуй\nМарта:$/);
    assert.deepEqual(body.stop, ['\nЛео:']);
});

test('unsupported AI service API gives a clear message', () => {
    assert.throws(() => resolveBackend({ main_api: 'novel' }), /неподдерживаемый режим/);
});

test('response shapes of different providers are understood', () => {
    assert.equal(extractText({ choices: [{ delta: { content: 'a' } }] }), 'a');
    assert.equal(extractText({ choices: [{ message: { content: 'b' } }] }), 'b');
    assert.equal(extractText({ choices: [{ text: 'c' }] }), 'c');
    assert.equal(extractText({ type: 'content_block_delta', delta: { text: 'd' } }), 'd');
    assert.equal(extractText({ candidates: [{ content: { parts: [{ text: 'x', thought: true }, { text: 'e' }] } }] }), 'e');
    assert.equal(extractText({ content: [{ text: 'f' }] }), 'f');
    assert.equal(extractText({ type: 'ping' }), '');
});
