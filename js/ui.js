import { stainedGlass, initialOf } from './art.js';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

// el('div.card', { onclick }, child, 'text')
export function el(spec, props, ...children) {
    const [tag, ...classes] = spec.split('.');
    const node = document.createElement(tag || 'div');
    if (classes.length) node.className = classes.join(' ');
    if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) {
        children.unshift(props);
    } else if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key in node && key !== 'list' && key !== 'form') node[key] = value;
            else node.setAttribute(key, value === true ? '' : value);
        }
    }
    children.flat(Infinity).forEach((child) => {
        if (child === null || child === undefined || child === false) return;
        node.append(child);
    });
    return node;
}

const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    send: '<path d="M4 12l16-8-5 17-3.5-7z"/><path d="M11.500 14L20 4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.500" fill="currentColor" stroke="none"/>',
    edit: '<path d="M4 20l1-4L16 5a2 2 0 013 3L8 19z"/>',
    trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
    redo: '<path d="M20 11a8 8 0 10-2.300 6.300"/><path d="M20 5v6h-6"/>',
    gear: '<circle cx="12" cy="12" r="3.200"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    down: '<path d="M6 10l6 6 6-6"/>',
    left: '<path d="M14 6l-6 6 6 6"/>',
    right: '<path d="M10 6l6 6-6 6"/>',
    search: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/>',
    photo: '<rect x="3" y="5" width="18" height="15" rx="2.500"/><circle cx="9" cy="11" r="1.800"/><path d="M4 18l5-4 4 3 3-2.500 4 3.500"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.010M4 12h.010M4 18h.010"/>',
    more: '<circle cx="5" cy="12" r="1.400" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.400" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.400" fill="currentColor" stroke="none"/>',
};

export function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return span;
}

export function iconButton(name, label, onClick, extraClass = '') {
    return el(`button.icon-btn${extraClass ? `.${extraClass}` : ''}`, { type: 'button', title: label, 'aria-label': label, onclick: onClick }, icon(name));
}

// Arched portrait: the photo, or a stained-glass window with the initial.
export function portrait(character, size = '') {
    const box = el(`div.portrait${size ? `.${size}` : ''}`);
    const hasPhoto = Boolean(character.photo);
    box.append(el('img', {
        src: character.photo || stainedGlass(character.name),
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        draggable: false,
    }));
    if (!hasPhoto) box.append(el('span.portrait-initial', { 'aria-hidden': 'true' }, initialOf(character.name)));
    return box;
}

function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Role-play markup. The text is escaped first, so a reply can never inject HTML.
export function formatMessage(text) {
    const safe = escapeHtml(text);
    const styled = safe
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em class="act">$1</em>')
        // An action still being streamed or cut off by Stop has no closing star yet.
        .replace(/\*([^*\n]+)$/g, '<em class="act">$1</em>')
        .replace(/(«[^»\n]*»|&quot;[^\n]*?&quot;|“[^”\n]*”)/g, '<span class="say">$1</span>');
    return styled
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export function fillNames(text, charName, userName) {
    return text.replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
}

export function timeAgo(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} дн назад`;
    return new Date(timestamp).toLocaleDateString('ru-RU');
}

export function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
}

// ---------------------------------------------------------------- toast

export function toast(message, { action, onAction, duration = 3800, kind = '' } = {}) {
    const host = document.getElementById('toasts');
    const node = el(`div.toast${kind ? `.${kind}` : ''}`, { role: 'status' }, el('span', message));
    const remove = () => {
        node.classList.add('leaving');
        setTimeout(() => node.remove(), reducedMotion() ? 0 : 180);
    };
    const timer = setTimeout(remove, duration);
    if (action) {
        node.append(el('button.toast-action', {
            type: 'button',
            onclick: () => {
                clearTimeout(timer);
                remove();
                onAction();
            },
        }, action));
    }
    host.append(node);
}

// ---------------------------------------------------------------- dialogs

// Native <dialog>: focus trap, Esc and the backdrop come with it. Bottom sheet on phones.
export function openSheet(build, { className = '' } = {}) {
    const dialog = el(`dialog.sheet${className ? `.${className}` : ''}`);
    const close = () => {
        if (!dialog.open || dialog.classList.contains('closing')) return;
        dialog.classList.add('closing');
        setTimeout(() => {
            dialog.close();
            dialog.remove();
        }, reducedMotion() ? 0 : 170);
    };
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) close();
    });
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
    });
    dialog.append(build(close));
    document.body.append(dialog);
    dialog.showModal();
    return { dialog, close };
}

export function confirmDialog({ title, text, confirmLabel, cancelLabel = 'Отмена', danger = false }) {
    return new Promise((resolve) => {
        let answered = false;
        const answer = (value, close) => {
            if (answered) return;
            answered = true;
            resolve(value);
            close();
        };
        const sheet = openSheet((close) => el('div.confirm',
            el('h2.confirm-title', title),
            el('p.confirm-text', text),
            el('div.confirm-actions',
                el('button.btn.ghost', { type: 'button', onclick: () => answer(false, close) }, cancelLabel),
                el(`button.btn${danger ? '.danger' : '.primary'}`, { type: 'button', onclick: () => answer(true, close) }, confirmLabel)),
        ), { className: 'small' });
        sheet.dialog.addEventListener('close', () => {
            if (!answered) resolve(false);
        });
    });
}

// ---------------------------------------------------------------- tavern sign

export function hallSign() {
    return el('a.sign', { href: '#/hall', 'aria-label': 'RP Tavern, на главную' },
        el('span.sign-chains', { 'aria-hidden': 'true' }),
        el('span.sign-board', el('span.sign-name', 'RP Tavern')));
}
