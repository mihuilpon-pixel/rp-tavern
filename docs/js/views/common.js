// Pieces shared by several screens.
import { checkConnection, describeLink, getLink, onLinkChange } from '../api.js';
import { el, icon, openSheet } from '../ui.js';

export function linkStatusPanel(close) {
    const title = el('h2.confirm-title');
    const text = el('p.confirm-text');
    const chain = el('ol.chain', { 'aria-hidden': 'true' });
    let off = () => {};
    const paint = (link) => {
        if (title.isConnected === false && chain.childElementCount > 0) {
            off();
            return;
        }
        const info = describeLink(link);
        title.textContent = info.title;
        text.textContent = info.text;
        const reached = { ok: 4, st: 3, node: 2, tunnel: 1, unset: 1, offline: 0, checking: 0 }[link.state] ?? 0;
        chain.replaceChildren(...['Сайт', 'Туннель', 'Node.js', 'SillyTavern'].map((label, index) => el(`li.chain-link${reached > index ? '.on' : ''}`, label)));
    };
    paint(getLink());
    off = onLinkChange(paint);
    const retry = el('button.btn.primary', {
        type: 'button',
        onclick: async () => {
            retry.disabled = true;
            retry.textContent = 'Проверяем…';
            await checkConnection();
            retry.disabled = false;
            retry.textContent = 'Проверить снова';
        },
    }, 'Проверить снова');
    return el('div.confirm',
        title,
        text,
        chain,
        el('div.confirm-actions',
            el('a.btn.ghost', { href: '#/settings', onclick: close }, 'Настройки'),
            retry));
}

// The small lantern in the header. Always tappable: it explains what exactly is off.
export function linkLamp() {
    const label = el('span.lamp-label');
    const button = el('button.lamp', {
        type: 'button',
        onclick: () => openSheet((close) => linkStatusPanel(close), { className: 'small' }),
    }, el('span.lamp-flame', { 'aria-hidden': 'true' }), label);
    const paint = (link) => {
        button.dataset.state = link.state;
        const info = describeLink(link);
        label.textContent = link.state === 'ok' ? 'На связи' : link.state === 'checking' ? 'Проверяем' : 'Нет связи';
        button.title = `${info.title}. ${info.text}`;
        button.setAttribute('aria-label', button.title);
    };
    paint(getLink());
    const off = onLinkChange(paint);
    return { node: button, cleanup: off };
}

export function topBar({ back, title, actions = [] }) {
    return el('header.topbar',
        back ? el('a.icon-btn', { href: back, 'aria-label': 'Назад', title: 'Назад' }, icon('back')) : null,
        title ? el('h1.topbar-title', title) : null,
        el('div.topbar-actions', actions));
}
