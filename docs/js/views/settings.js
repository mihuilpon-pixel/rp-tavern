import { checkConnection, describeLink, getLink, getServer, logoutSession, normalizeServerUrl, onLinkChange, setServer, setToken } from '../api.js?v=remove-provider-brand-1';
import { exportAll, importAll, wipeAll } from '../store.js';
import { confirmDialog, el, toast } from '../ui.js';
import { go } from '../main.js';
import { topBar } from './common.js';

const NAME_KEY = 'rpt.userName';

export function getUserName() {
    try {
        return localStorage.getItem(NAME_KEY) || 'Гость';
    } catch {
        return 'Гость';
    }
}

function setUserName(name) {
    try {
        localStorage.setItem(NAME_KEY, name);
    } catch { /* private mode */ }
}

export async function renderSettings() {
    const serverInput = el('input.field-input', {
        id: 's-server',
        type: 'url',
        inputMode: 'url',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: false,
        placeholder: 'https://xxxx.trycloudflare.com',
        value: getServer(),
    });
    const linkTitle = el('strong');
    const linkText = el('span');
    const linkBox = el('div.link-box', { role: 'status' }, linkTitle, linkText);
    const paintLink = (link) => {
        const info = describeLink(link);
        linkBox.dataset.state = link.state;
        linkTitle.textContent = info.title;
        linkText.textContent = info.text;
    };
    paintLink(getLink());
    const off = onLinkChange(paintLink);

    const saveServer = el('button.btn.primary', {
        type: 'submit',
    }, 'Сохранить и проверить');

    const serverForm = el('form.settings-card', {
        novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            const raw = serverInput.value.trim();
            const url = normalizeServerUrl(raw);
            if (raw && !url) {
                toast('Это не похоже на адрес. Пример: https://xxxx.trycloudflare.com', { kind: 'bad' });
                return;
            }
            if (url && location.protocol === 'https:' && url.startsWith('http://')) {
                toast('Сайт открыт по https, поэтому адрес сервера тоже должен начинаться с https://', { kind: 'bad', duration: 6000 });
                return;
            }
            serverInput.value = url;
            setServer(url);
            saveServer.disabled = true;
            await checkConnection();
            saveServer.disabled = false;
        },
    },
    el('h2.eyebrow', 'Подключение'),
    el('label.field', { htmlFor: 's-server' },
        el('span.field-label', 'Адрес сервера'),
        el('span.field-hint', 'Quick Tunnel выдаёт новый адрес при каждом запуске. Вставьте его сюда, вход и история сохранятся.'),
        serverInput),
    linkBox,
    el('div.card-actions', saveServer));

    const nameInput = el('input.field-input', {
        id: 's-name',
        type: 'text',
        maxLength: 60,
        autocomplete: 'off',
        value: getUserName(),
        onchange: () => {
            setUserName(nameInput.value.trim() || 'Гость');
            toast('Имя сохранено');
        },
    });

    const importInput = el('input', {
        type: 'file',
        accept: 'application/json,.json',
        hidden: true,
        id: 's-import',
        onchange: async () => {
            const [file] = importInput.files;
            importInput.value = '';
            if (!file) return;
            try {
                const result = await importAll(JSON.parse(await file.text()));
                toast(`Восстановлено: персонажей ${result.characters}, бесед ${result.chats}`);
            } catch (error) {
                toast(error instanceof SyntaxError ? 'Файл повреждён.' : error.message, { kind: 'bad' });
            }
        },
    });

    const node = el('div.settings',
        topBar({ back: '#/hall', title: 'Настройки' }),
        el('div.settings-body',
            serverForm,
            el('section.settings-card',
                el('h2.eyebrow', 'Администрирование'),
                el('p.field-hint', 'Просматривай вошедшие устройства и завершай отдельные сеансы.'),
                el('div.card-actions',
                    el('a.btn.ghost', { href: 'admin.html' }, 'Открыть панель администратора'))),
            el('section.settings-card',
                el('h2.eyebrow', 'Вы'),
                el('label.field', { htmlFor: 's-name' },
                    el('span.field-label', 'Как к вам обращаться'),
                    el('span.field-hint', 'Это имя подставится вместо {{user}} и будет известно персонажам.'),
                    nameInput)),
            el('section.settings-card',
                el('h2.eyebrow', 'Ваши данные'),
                el('p.field-hint', 'Персонажи и беседы хранятся только в этом браузере. Чтобы перенести их на другое устройство, скачайте копию и загрузите её там.'),
                el('div.card-actions',
                    el('button.btn.ghost', {
                        type: 'button',
                        onclick: async () => {
                            const url = URL.createObjectURL(new Blob([JSON.stringify(await exportAll())], { type: 'application/json' }));
                            const link = el('a', { href: url, download: `rp-tavern-${new Date().toISOString().slice(0, 10)}.json` });
                            link.click();
                            setTimeout(() => URL.revokeObjectURL(url), 5000);
                        },
                    }, 'Скачать копию'),
                    el('label.btn.ghost', { htmlFor: 's-import', tabIndex: 0 }, 'Загрузить копию'),
                    importInput),
                el('div.card-actions',
                    el('button.btn.danger-ghost', {
                        type: 'button',
                        onclick: async () => {
                            const yes = await confirmDialog({
                                title: 'Удалить всё?',
                                text: 'Все персонажи и беседы в этом браузере будут удалены. Отменить это нельзя.',
                                confirmLabel: 'Удалить всё',
                                danger: true,
                            });
                            if (!yes) return;
                            await wipeAll();
                            toast('Данные удалены');
                            go('/hall');
                        },
                    }, 'Удалить все данные'))),
            el('section.settings-card',
                el('h2.eyebrow', 'Выход'),
                el('div.card-actions',
                    el('button.btn.ghost', {
                        type: 'button',
                        onclick: async () => {
                            try { await logoutSession(); } catch { /* local sign-out still works offline */ }
                            setToken('');
                            go('/door');
                        },
                    }, 'Выйти из таверны')))));

    return { node, cleanup: off };
}
