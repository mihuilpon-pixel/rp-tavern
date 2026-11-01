import { adminLogin, endAdminSession, getAdminSessions, getServer } from './api.js?v=remove-provider-brand-1';
import { el, toast, confirmDialog } from './ui.js?v=remove-provider-brand-1';
import { topBar } from './views/common.js?v=remove-provider-brand-1';

const root = document.getElementById('admin-app');
const TOKEN_KEY = 'rpt.adminToken';

function page(...children) {
    root.replaceChildren(el('div.settings',
        topBar({ back: './#/settings', title: 'Панель администратора' }),
        el('div.settings-body.admin-body', children)));
}

function showGate(errorText = '') {
    const code = el('input.field-input', {
        type: 'password',
        autocomplete: 'current-password',
        placeholder: 'Секретный код администратора',
        required: true,
        'aria-label': 'Код администратора',
    });
    const error = el('p.form-error', { hidden: !errorText }, errorText);
    const submit = el('button.btn.primary.wide', { type: 'submit' }, 'Войти в панель');
    const form = el('form.settings-card', {
        onsubmit: async (event) => {
            event.preventDefault();
            error.hidden = true;
            submit.disabled = true;
            try {
                const result = await adminLogin(code.value.trim());
                sessionStorage.setItem(TOKEN_KEY, result.token);
                await showSessions(result.token);
            } catch (err) {
                error.textContent = err.message;
                error.hidden = false;
            } finally { submit.disabled = false; }
        },
    },
    el('h2.eyebrow', 'Защищённый раздел'),
    el('p.field-hint', 'Код администратора находится в локальном файле config.local.json и в окне Node.js.'),
    el('label.field', el('span.field-label', 'Код администратора'), code),
    error,
    submit);
    page(form);
    code.focus({ preventScroll: true });
}

function deviceName(userAgent = '') {
    if (/android/i.test(userAgent)) return 'Телефон Android';
    if (/iPhone|iPad|iPod/i.test(userAgent)) return 'Устройство Apple';
    if (/Windows/i.test(userAgent)) return 'Компьютер Windows';
    if (/Macintosh|Mac OS/i.test(userAgent)) return 'Компьютер Mac';
    return 'Устройство';
}

function formatTime(timestamp) {
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

async function showSessions(token) {
    let data;
    try { data = await getAdminSessions(token); }
    catch (error) {
        sessionStorage.removeItem(TOKEN_KEY);
        showGate(error.message);
        return;
    }

    const list = el('div.admin-session-list');
    const count = el('p.field-hint', `Всего сеансов: ${data.sessions.length}`);
    const paint = () => {
        count.textContent = `Всего сеансов: ${data.sessions.length}`;
        if (!data.sessions.length) {
            list.replaceChildren(el('div.empty.compact', el('h2.title-sm', 'Активных сеансов пока нет'), el('p.muted', 'Сеансы появятся после входа пользователей.')));
            return;
        }
        list.replaceChildren(...data.sessions.map((session) => {
            const device = el('div.admin-device',
                el('span.admin-state', { dataset: { state: session.active ? 'active' : 'idle' } }),
                el('div',
                    el('h2.title-sm', deviceName(session.userAgent)),
                    el('p.field-hint', session.userAgent || 'Браузер не сообщил данные об устройстве.')));
            const codeLabel = session.codeType === 'tester' ? 'Одноразовый тестовый ключ' : `Ключ ••••${session.codeHint}`;
            const details = el('div.admin-session-details',
                el('span.admin-badge', session.active ? 'Сейчас активен' : 'Неактивен'),
                el('span', codeLabel),
                el('span', `Вход: ${formatTime(session.createdAt)}`),
                el('span', `Последняя активность: ${formatTime(session.lastSeenAt)}`));
            const end = el('button.btn.danger-ghost', {
                type: 'button',
                onclick: async () => {
                    const yes = await confirmDialog({
                        title: 'Завершить этот сеанс?',
                        text: 'Устройство потеряет доступ при следующем запросе к серверу.',
                        confirmLabel: 'Завершить сеанс',
                        danger: true,
                    });
                    if (!yes) return;
                    end.disabled = true;
                    try {
                        await endAdminSession(token, session.id);
                        data.sessions = data.sessions.filter((item) => item.id !== session.id);
                        paint();
                        toast('Сеанс завершён.');
                    } catch (error) {
                        end.disabled = false;
                        toast(error.message, { kind: 'bad' });
                    }
                },
            }, 'Завершить сеанс');
            return el('article.admin-session', device, details, end);
        }));
    };
    paint();

    const refresh = el('button.btn.ghost', {
        type: 'button',
        onclick: async () => {
            refresh.disabled = true;
            try {
                const next = await getAdminSessions(token);
                data.sessions = next.sessions;
                paint();
            } catch (error) { toast(error.message, { kind: 'bad' }); }
            finally { refresh.disabled = false; }
        },
    }, 'Обновить список');
    const exit = el('button.btn.ghost', {
        type: 'button',
        onclick: () => {
            sessionStorage.removeItem(TOKEN_KEY);
            showGate();
        },
    }, 'Выйти из админ-панели');
    page(
        el('section.settings-card',
            el('h2.eyebrow', 'Сеансы пользователей'),
            el('p.field-hint', `Список относится к серверу ${getServer()}. После перезапуска Node.js пользователям нужно войти заново.`),
            count,
            el('div.card-actions', refresh, exit)),
        list);
}

const token = sessionStorage.getItem(TOKEN_KEY);
if (token) showSessions(token);
else showGate();
