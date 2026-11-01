// The way in: age question, then the access code. The door swings open on success.
import { checkConnection, getServer, login, normalizeServerUrl } from '../api.js?v=remove-provider-brand-1';
import { el, reducedMotion } from '../ui.js';

const AGE_KEY = 'rpt.age';

export function ageConfirmed() {
    try {
        return localStorage.getItem(AGE_KEY) === 'yes';
    } catch {
        return false;
    }
}

function rememberAge() {
    try {
        localStorage.setItem(AGE_KEY, 'yes');
    } catch { /* private mode */ }
}

export async function renderDoor({ onEnter }) {
    const hatch = el('div.hatch');
    const leaf = el('div.door-leaf',
        el('span.door-hinge.top', { 'aria-hidden': 'true' }),
        el('span.door-hinge.bottom', { 'aria-hidden': 'true' }),
        hatch);
    const node = el('div.door-scene',
        el('div.door-glow', { 'aria-hidden': 'true' }),
        el('div.door-frame', leaf));

    function showRefused() {
        hatch.replaceChildren(
            el('h1.hatch-title', 'Приходите позже'),
            el('p.hatch-text', 'RP Tavern открыта только для совершеннолетних. Будем ждать вас, когда вам исполнится 18.'),
            el('button.btn.ghost.wide', { type: 'button', onclick: showAge }, 'Вернуться к вопросу'));
    }

    function showAge() {
        hatch.replaceChildren(
            el('p.hatch-kicker', 'Таверна ролевых историй'),
            el('h1.hatch-title', 'RP Tavern'),
            el('p.hatch-text', 'Внутри живые диалоги с ИИ-персонажами и истории для взрослых. Вам уже исполнилось 18 лет?'),
            el('div.hatch-actions',
                el('button.btn.primary.wide', {
                    type: 'button',
                    onclick: () => {
                        rememberAge();
                        showCode();
                    },
                }, 'Да, мне есть 18'),
                el('button.btn.ghost.wide', { type: 'button', onclick: showRefused }, 'Нет')));
    }

    function showCode() {
        const serverPreset = getServer();
        const serverInput = el('input.field-input', {
            id: 'door-server',
            type: 'url',
            inputMode: 'url',
            autocomplete: 'off',
            autocapitalize: 'off',
            spellcheck: false,
            placeholder: 'https://xxxx.trycloudflare.com',
            value: serverPreset,
        });
        const codeInput = el('input.field-input', {
            id: 'door-code',
            type: 'password',
            autocomplete: 'current-password',
            placeholder: 'Код от владельца',
            required: true,
        });
        const error = el('p.form-error', { role: 'alert', hidden: true });
        const submit = el('button.btn.primary.wide', { type: 'submit' }, 'Войти');

        const showError = (message) => {
            error.textContent = message;
            error.hidden = false;
            leaf.classList.remove('shake');
            void leaf.offsetWidth;
            leaf.classList.add('shake');
        };

        const form = el('form.hatch-form', {
            novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                error.hidden = true;
                const server = normalizeServerUrl(serverInput.value);
                if (!server) return showError('Укажите адрес сервера: его выдаёт Cloudflare Tunnel.');
                if (!codeInput.value.trim()) return showError('Введите код доступа.');
                if (location.protocol === 'https:' && server.startsWith('http://')) {
                    return showError('Сайт открыт по https, поэтому адрес сервера тоже должен начинаться с https://.');
                }
                submit.disabled = true;
                submit.textContent = 'Стучимся…';
                try {
                    await login(server, codeInput.value);
                    await openDoor();
                    onEnter();
                } catch (err) {
                    showError(err.message);
                    submit.disabled = false;
                    submit.textContent = 'Войти';
                }
                return undefined;
            },
        },
        el('label.field', { htmlFor: 'door-server' }, el('span.field-label', 'Адрес сервера'), serverInput),
        el('label.field', { htmlFor: 'door-code' }, el('span.field-label', 'Код доступа'), codeInput),
        error,
        submit);

        hatch.replaceChildren(
            el('p.hatch-kicker', 'Стук в дверь'),
            el('h1.hatch-title', 'Ваш код?'),
            form);
        (serverPreset ? codeInput : serverInput).focus({ preventScroll: true });
        checkConnection();
    }

    function openDoor() {
        if (reducedMotion()) return Promise.resolve();
        node.classList.add('opening');
        return new Promise((resolve) => {
            setTimeout(resolve, 760);
        });
    }

    if (ageConfirmed()) showCode();
    else showAge();

    return { node };
}
