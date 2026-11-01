'use strict';
// Dev stand-in for AI service: same CSRF session, settings and streaming contract, canned replies.
// It also serves docs/ on a second port, which makes the site cross-origin like on GitHub Pages.
//   node test/mock-sillytavern.js [stPort=8011] [sitePort=5500]
// Change the behaviour with POST /__mode {"mode":"ok"|"fail"|"slow"|"empty"}.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const stPort = Number(process.argv[2] || 8011);
const sitePort = Number(process.argv[3] || 5500);
const DOCS = path.join(__dirname, '..', 'docs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const SETTINGS = {
    main_api: 'openai',
    oai_settings: { chat_completion_source: 'custom', custom_model: 'mock-model', custom_url: 'http://mock/v1', temp_openai: 0.9, openai_max_tokens: 300 },
};

let mode = 'ok';
let replyNumber = 0;

function reply(body) {
    replyNumber += 1;
    const last = body.messages?.at(-1)?.content || '';
    return `*${body.char_name || 'Персонаж'} поднимает взгляд.* «Ответ номер ${replyNumber}. Вы сказали: ${last.slice(0, 60)}» *Огонь в очаге тихо потрескивает, и за окном всё так же идёт дождь.*`;
}

const st = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        if (req.url === '/__mode') {
            mode = JSON.parse(raw).mode;
            return res.end(mode);
        }
        if (req.url === '/csrf-token') {
            res.setHeader('Set-Cookie', 'session-mock=1; Path=/; HttpOnly');
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ token: 'mock-token' }));
        }
        if (req.headers['x-csrf-token'] !== 'mock-token' || !String(req.headers.cookie).includes('session-mock=1')) {
            res.statusCode = 403;
            return res.end('Invalid CSRF token');
        }
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/api/settings/get') {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ settings: JSON.stringify(SETTINGS) }));
        }
        if (req.url === '/api/backends/chat-completions/generate') {
            if (mode === 'fail') {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: { message: 'mock: invalid API key' } }));
            }
            res.setHeader('Content-Type', 'text/event-stream');
            if (mode === 'empty') return res.end('data: [DONE]\n\n');
            const words = reply(body).split(/(?<= )/);
            const delay = mode === 'slow' ? 700 : 45;
            let i = 0;
            const timer = setInterval(() => {
                if (i >= words.length) {
                    clearInterval(timer);
                    return res.end('data: [DONE]\n\n');
                }
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\n\n`);
                i += 1;
            }, delay);
            req.socket.on('close', () => clearInterval(timer));
            return undefined;
        }
        res.statusCode = 404;
        return res.end('not found');
    });
});
st.listen(stPort, '127.0.0.1', () => console.log(`mock AI service: http://127.0.0.1:${stPort}`));

const site = http.createServer((req, res) => {
    const relative = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(DOCS, relative);
    if (!target.startsWith(DOCS)) {
        res.statusCode = 404;
        return res.end();
    }
    return fs.readFile(target, (err, data) => {
        if (err) {
            res.statusCode = 404;
            return res.end('not found');
        }
        res.setHeader('Content-Type', MIME[path.extname(target)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        return res.end(data);
    });
});
site.listen(sitePort, '127.0.0.1', () => console.log(`site as on Pages: http://localhost:${sitePort}`));
