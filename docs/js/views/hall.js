// The hall: every guest has a lit window on the wall.
import { createChat, deleteCharacter, listCharacters, listChats, messageText, restoreSeeds } from '../store.js';
import { confirmDialog, el, fillNames, hallSign, icon, iconButton, openSheet, plural, portrait, timeAgo, toast } from '../ui.js';
import { linkLamp } from './common.js';
import { go } from '../main.js';

function firstSentence(text) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    const match = clean.match(/^.{20,140}?[.!?…](?=\s|$)/);
    return match ? match[0] : clean.slice(0, 120);
}

function windowCard(character, chatCount, onOpen, index) {
    return el('button.guest', {
        type: 'button',
        onclick: () => onOpen(character),
        style: `--i:${Math.min(index, 10)}`,
    },
    el('span.guest-window', portrait(character)),
    el('span.guest-plaque',
        el('span.guest-name', character.name),
        el('span.guest-line', firstSentence(character.description)),
        chatCount ? el('span.guest-count', `${chatCount} ${plural(chatCount, 'беседа', 'беседы', 'бесед')}`) : null));
}

async function startNew(character, close) {
    const chat = await createChat(character);
    close();
    go(`/chat/${chat.id}`);
}

function profileSheet(character, chats, refresh) {
    return openSheet((close) => {
        const last = chats[0];
        return el('div.profile',
            iconButton('close', 'Закрыть', close, 'sheet-close'),
            el('div.profile-head',
                portrait(character, 'large'),
                el('div.profile-id',
                    el('h2.profile-name', character.name),
                    el('p.profile-desc', character.description))),
            el('div.profile-body',
                character.personality?.trim() ? el('section', el('h3.eyebrow', 'Характер'), el('p', character.personality)) : null,
                character.scenario?.trim() ? el('section', el('h3.eyebrow', 'Сценарий'), el('p', fillNames(character.scenario, character.name, 'вы'))) : null),
            el('div.profile-actions',
                last ? el('a.btn.primary.wide', { href: `#/chat/${last.id}`, onclick: close }, 'Продолжить беседу') : null,
                el(`button.btn.wide${last ? '.ghost' : '.primary'}`, { type: 'button', onclick: () => startNew(character, close) }, last ? 'Новая беседа' : 'Начать беседу'),
                el('div.profile-minor',
                    el('a.link-btn', { href: `#/edit/${character.id}`, onclick: close }, icon('edit'), 'Изменить'),
                    el('button.link-btn.danger', {
                        type: 'button',
                        onclick: async () => {
                            const count = chats.length;
                            const yes = await confirmDialog({
                                title: `Удалить персонажа «${character.name}»?`,
                                text: count
                                    ? `Беседы с этим персонажем тоже будут удалены: ${count}. Отменить это нельзя.`
                                    : 'Отменить это нельзя.',
                                confirmLabel: 'Удалить',
                                danger: true,
                            });
                            if (!yes) return;
                            await deleteCharacter(character.id);
                            close();
                            toast(`Персонаж «${character.name}» удалён`);
                            refresh();
                        },
                    }, icon('trash'), 'Удалить'))));
    }, { className: 'profile-sheet' });
}

export async function renderHall() {
    const lamp = linkLamp();
    const grid = el('div.guests');
    const recent = el('section.recent', { hidden: true });
    const empty = el('div.empty', { hidden: true });
    const search = el('input.search-input', {
        type: 'search',
        placeholder: 'Найти постояльца',
        'aria-label': 'Найти персонажа',
        enterKeyHint: 'search',
    });

    let characters = [];
    let chats = [];

    const open = async (character) => {
        profileSheet(character, chats.filter((c) => c.characterId === character.id), refresh);
    };

    function paint() {
        const query = search.value.trim().toLowerCase();
        const visible = characters.filter((c) => !query || `${c.name} ${c.description}`.toLowerCase().includes(query));
        const counts = new Map();
        chats.forEach((c) => counts.set(c.characterId, (counts.get(c.characterId) || 0) + 1));

        const createTile = el('a.guest.guest-new', { href: '#/new' },
            el('span.guest-window', el('span.guest-new-icon', icon('plus'))),
            el('span.guest-plaque',
                el('span.guest-name', 'Свободная комната'),
                el('span.guest-line', 'Создать своего персонажа')));

        if (characters.length === 0) {
            grid.replaceChildren();
            empty.hidden = false;
            empty.replaceChildren(
                el('div.flame.large', { 'aria-hidden': 'true' }),
                el('h2.title-sm', 'В таверне никого нет'),
                el('p.muted', 'Заселите первого постояльца или верните стартовых персонажей.'),
                el('div.empty-actions',
                    el('a.btn.primary', { href: '#/new' }, 'Создать персонажа'),
                    el('button.btn.ghost', {
                        type: 'button',
                        onclick: async () => {
                            await restoreSeeds();
                            refresh();
                        },
                    }, 'Вернуть стартовых')));
            return;
        }
        if (visible.length === 0) {
            empty.hidden = false;
            empty.replaceChildren(
                el('h2.title-sm', 'Таких здесь нет'),
                el('p.muted', `По запросу «${search.value.trim()}» никого не нашлось.`));
            grid.replaceChildren(createTile);
            return;
        }
        empty.hidden = true;
        grid.replaceChildren(
            ...visible.map((c, index) => windowCard(c, counts.get(c.id) || 0, open, index)),
            createTile);
    }

    function paintRecent() {
        const items = [];
        for (const chat of chats.slice(0, 8)) {
            const character = characters.find((c) => c.id === chat.characterId);
            if (!character || chat.messages.length === 0) continue;
            items.push(el('a.recent-item', { href: `#/chat/${chat.id}` },
                portrait(character, 'mini'),
                el('span.recent-text',
                    el('span.recent-name', character.name),
                    el('span.recent-last', fillNames(messageText(chat.messages.at(-1)), character.name, 'вы').replace(/[*«»"]/g, '').slice(0, 70))),
                el('span.recent-time', timeAgo(chat.updatedAt))));
        }
        recent.hidden = items.length === 0;
        recent.replaceChildren(el('h2.eyebrow', 'Недавние беседы'), el('div.recent-list', items));
    }

    async function refresh() {
        [characters, chats] = await Promise.all([listCharacters(), listChats()]);
        paint();
        paintRecent();
    }

    search.addEventListener('input', paint);
    await refresh();

    const node = el('div.hall',
        el('header.hall-head',
            hallSign(),
            el('div.hall-tools',
                lamp.node,
                el('a.icon-btn', { href: '#/settings', 'aria-label': 'Настройки', title: 'Настройки' }, icon('gear')))),
        el('div.hall-body',
            el('div.hall-title',
                el('h1.title', 'С кем посидим сегодня?'),
                el('label.search', icon('search'), search)),
            recent,
            el('h2.eyebrow', 'Постояльцы'),
            empty,
            grid));

    return { node, cleanup: lamp.cleanup };
}
