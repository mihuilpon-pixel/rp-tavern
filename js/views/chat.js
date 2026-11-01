// The conversation. Messages are patched in place, never re-rendered as a whole,
// so long histories stay fast and scroll position survives every update.
import { cancelJob, checkConnection, describeLink, getLink, onLinkChange, readJob, startGeneration } from '../api.js';
import { createChat, deleteChat, getCharacter, getChat, listChats, makeMessage, messageText, saveChat } from '../store.js';
import { confirmDialog, el, fillNames, formatMessage, icon, iconButton, isTouch, openSheet, plural, portrait, reducedMotion, timeAgo, toast } from '../ui.js';
import { go } from '../main.js';
import { getUserName } from './settings.js';
import { linkStatusPanel } from './common.js';

const PAGE_SIZE = 40;
const POLL_MS = 450;
const POLL_FAILURE_GRACE_MS = 90 * 1000;
const SAVE_EVERY_MS = 2000;
const SWIPE_TRIGGER_PX = 72;
const SWIPE_EDGE_GUARD_PX = 24;
const STICK_TO_BOTTOM_PX = 120;
const HINT_KEY = 'rpt.swipeHint';

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function renderChat(chatId) {
    const chat = await getChat(chatId);
    const character = chat ? await getCharacter(chat.characterId) : null;
    if (!chat || !character) {
        return {
            node: el('div.page.center',
                el('h1.title', 'Беседа не найдена'),
                el('p.muted', 'Возможно, она или персонаж уже удалены.'),
                el('a.btn.primary', { href: '#/hall' }, 'Вернуться в зал')),
        };
    }

    const userName = getUserName();
    const show = (text) => fillNames(text, character.name, userName);

    let disposed = false;
    let generating = null; // { jobId, messageId, cancelled }
    let renderedFrom = Math.max(0, chat.messages.length - PAGE_SIZE);
    let openActions = null;
    let editingId = null;
    const nodes = new Map();

    // ------------------------------------------------------------ layout

    const list = el('div.messages', { role: 'log', 'aria-label': `Беседа: ${character.name}`, 'aria-live': 'polite' });
    const sentinel = el('button.older', { type: 'button', hidden: true, onclick: () => loadOlder() }, 'Показать раньше');
    const notices = el('div.notices');
    const scroller = el('div.scroller', el('div.scroller-inner', sentinel, list, notices));
    const toBottom = iconButton('down', 'К последнему сообщению', () => scrollDown(true), 'to-bottom');
    toBottom.hidden = true;

    const input = el('textarea.composer-input', {
        rows: 1,
        placeholder: 'Ваша реплика…',
        'aria-label': 'Ваше сообщение',
        enterKeyHint: isTouch() ? 'enter' : 'send',
        maxLength: 8000,
    });
    const sendButton = el('button.send', { type: 'button', 'aria-label': 'Отправить', title: 'Отправить', onclick: () => onSendClick() }, icon('send'));
    const composer = el('form.composer', {
        onsubmit: (event) => {
            event.preventDefault();
            onSendClick();
        },
    }, input, sendButton);

    const banner = el('button.link-banner', { type: 'button', hidden: true, onclick: () => openSheet((close) => linkStatusPanel(close), { className: 'small' }) });

    const draftKey = `rpt.draft.${chat.id}`;
    try {
        input.value = sessionStorage.getItem(draftKey) || '';
    } catch { /* no storage */ }

    // ------------------------------------------------------------ scrolling

    function nearBottom() {
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_TO_BOTTOM_PX;
    }

    function scrollDown(smooth = false) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
    }

    function updateToBottom() {
        toBottom.hidden = nearBottom();
    }

    function loadOlder() {
        if (renderedFrom === 0) return;
        const previousHeight = scroller.scrollHeight;
        const previousTop = scroller.scrollTop;
        const start = Math.max(0, renderedFrom - PAGE_SIZE);
        const fragment = document.createDocumentFragment();
        chat.messages.slice(start, renderedFrom).forEach((message) => fragment.append(buildMessage(message)));
        renderedFrom = start;
        list.prepend(fragment);
        sentinel.hidden = renderedFrom === 0;
        scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
    }

    scroller.addEventListener('scroll', () => {
        updateToBottom();
        if (scroller.scrollTop < 200 && renderedFrom > 0) loadOlder();
    }, { passive: true });

    // ------------------------------------------------------------ message rendering

    const lastBotId = () => {
        const last = chat.messages.at(-1);
        return last?.role === 'assistant' ? last.id : null;
    };

    // The greeting alone has nothing to answer, so only replies to a user can be regenerated.
    const canRegenerate = (message) => message.id === lastBotId()
        && chat.messages.some((m) => m.role === 'user');

    function buildMessage(message, { animate = false } = {}) {
        const isBot = message.role === 'assistant';
        const body = el('div.msg-text');
        const nav = el('div.msg-variants');
        const actions = el('div.msg-actions');
        const bubble = el('div.msg-bubble',
            isBot ? el('div.msg-name', character.name) : null,
            body,
            nav);
        const row = el(`article.msg.${isBot ? 'bot' : 'me'}${animate ? '.enter' : ''}`, { dataset: { id: message.id } },
            isBot ? portrait(character, 'avatar') : null,
            el('div.msg-column',
                el('div.swipe-hint-track', { 'aria-hidden': 'true' }, icon('redo')),
                bubble,
                actions));

        const entry = { row, body, nav, actions, bubble, message };
        nodes.set(message.id, entry);
        paintBody(entry);
        paintChrome(entry);

        bubble.addEventListener('click', (event) => {
            if (event.target.closest('button, textarea, a') || editingId === message.id) return;
            if (String(window.getSelection())) return;
            toggleActions(message.id);
        });
        if (isBot) attachSwipe(entry);
        return row;
    }

    function paintBody(entry) {
        if (editingId === entry.message.id) return;
        const text = messageText(entry.message);
        const streaming = generating?.messageId === entry.message.id;
        if (!text && streaming) {
            entry.body.replaceChildren(el('div.embers', { role: 'status', 'aria-label': `${character.name} пишет` }, el('i'), el('i'), el('i')));
            return;
        }
        entry.body.innerHTML = formatMessage(show(text));
    }

    function paintChrome(entry) {
        const { message, nav, actions } = entry;
        const busy = Boolean(generating);

        nav.replaceChildren();
        if (message.role === 'assistant' && message.variants.length > 1) {
            nav.append(
                iconButton('left', 'Предыдущий вариант', () => shiftVariant(message, -1)),
                el('span.variant-count', `${message.v + 1} / ${message.variants.length}`),
                iconButton('right', 'Следующий вариант', () => shiftVariant(message, 1)));
            nav.querySelectorAll('button').forEach((button) => {
                button.disabled = busy;
            });
        }

        actions.replaceChildren(
            canRegenerate(message) && !busy ? actionButton('redo', 'Новый ответ', () => regenerate(message)) : null,
            actionButton('edit', 'Изменить', () => beginEdit(message), busy),
            actionButton('copy', 'Копировать', () => copyMessage(message)),
            actionButton('trash', 'Удалить', () => removeMessage(message), busy));
        entry.row.classList.toggle('show-actions', openActions === message.id);
    }

    function actionButton(iconName, label, onClick, disabled = false) {
        return el('button.msg-action', { type: 'button', disabled, onclick: onClick }, icon(iconName), el('span', label));
    }

    function refreshChrome() {
        nodes.forEach(paintChrome);
        paintNotices();
        paintComposer();
    }

    function toggleActions(id) {
        openActions = openActions === id ? null : id;
        nodes.forEach((entry) => entry.row.classList.toggle('show-actions', openActions === entry.message.id));
    }

    // ------------------------------------------------------------ notices

    let lastError = null;

    function paintNotices() {
        notices.replaceChildren();
        if (lastError) {
            notices.append(el('div.error-card', { role: 'alert' },
                el('strong', lastError.title),
                el('p', lastError.text),
                el('div.error-actions',
                    lastError.retry ? el('button.btn.primary.small', { type: 'button', onclick: lastError.retry }, 'Повторить') : null,
                    el('button.btn.ghost.small', {
                        type: 'button',
                        onclick: () => {
                            lastError = null;
                            paintNotices();
                        },
                    }, 'Скрыть'))));
            return;
        }
        if (!generating && chat.messages.at(-1)?.role === 'user') {
            notices.append(el('div.answer-row',
                el('button.btn.ghost.small', { type: 'button', onclick: () => requestReply() }, icon('redo'), 'Получить ответ')));
        }
        if (chat.messages.length === 0) {
            notices.append(el('div.empty.compact',
                el('p.muted', 'Здесь пока тихо. Начните разговор первыми.')));
        }
    }

    function paintComposer() {
        sendButton.replaceChildren(icon(generating ? 'stop' : 'send'));
        const label = generating ? 'Остановить ответ' : 'Отправить';
        sendButton.setAttribute('aria-label', label);
        sendButton.title = label;
        sendButton.classList.toggle('stop', Boolean(generating));
    }

    function growInput() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    }

    input.addEventListener('input', () => {
        growInput();
        try {
            sessionStorage.setItem(draftKey, input.value);
        } catch { /* no storage */ }
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !isTouch() && !event.isComposing) {
            event.preventDefault();
            if (!generating) onSendClick();
        }
    });

    // ------------------------------------------------------------ generation

    function appendMessage(message, opts) {
        chat.messages.push(message);
        list.append(buildMessage(message, opts));
    }

    function onSendClick() {
        if (generating) {
            stopGeneration();
            return;
        }
        const text = input.value.trim();
        if (!text) {
            input.focus();
            return;
        }
        input.value = '';
        try {
            sessionStorage.removeItem(draftKey);
        } catch { /* no storage */ }
        growInput();
        lastError = null;
        const wasLast = lastBotId();
        appendMessage(makeMessage('user', text), { animate: true });
        if (wasLast) paintChrome(nodes.get(wasLast));
        scrollDown();
        requestReply();
    }

    function historyFor(targetId) {
        const messages = [];
        for (const message of chat.messages) {
            if (message.id === targetId) break;
            messages.push({ role: message.role, content: messageText(message) });
        }
        return messages;
    }

    async function requestReply() {
        if (generating) return;
        const message = makeMessage('assistant', '');
        await runGeneration(message, true);
    }

    async function regenerate(message) {
        if (generating || !canRegenerate(message)) return;
        openActions = null;
        message.variants.push('');
        message.v = message.variants.length - 1;
        await runGeneration(message, false);
    }

    // Undo the placeholder when a reply fails or is stopped before any text arrived.
    function discardEmptyVariant(message) {
        if (messageText(message)) return;
        if (message.variants.length > 1) {
            message.variants.splice(message.v, 1);
            message.v = message.variants.length - 1;
            paintBody(nodes.get(message.id));
        } else {
            chat.messages.splice(chat.messages.indexOf(message), 1);
            nodes.get(message.id)?.row.remove();
            nodes.delete(message.id);
        }
    }

    async function runGeneration(message, isNew) {
        lastError = null;
        generating = { jobId: null, messageId: message.id, cancelled: false };
        if (isNew) {
            appendMessage(message, { animate: true });
        } else {
            paintBody(nodes.get(message.id));
        }
        refreshChrome();
        if (nearBottom() || isNew) scrollDown();

        try {
            const { jobId } = await startGeneration({
                userName,
                character: {
                    name: character.name,
                    description: character.description,
                    personality: character.personality,
                    scenario: character.scenario,
                },
                messages: historyFor(message.id),
            });
            generating.jobId = jobId;
            chat.pendingJob = { id: jobId, messageId: message.id, variant: message.v };
            await saveChat(chat);
            if (generating.cancelled) {
                cancelJob(jobId).catch(() => {});
                throw new Stopped();
            }
            await followJob(message, jobId, 0);
        } catch (error) {
            if (disposed) return;
            handleGenerationFailure(message, error);
        }
        if (!disposed) await finishGeneration(message);
    }

    class Stopped extends Error {}

    function handleGenerationFailure(message, error) {
        discardEmptyVariant(message);
        if (error instanceof Stopped) return;
        const link = getLink();
        const networkTitle = error.code === 'NETWORK' ? describeLink(link).title : null;
        const titles = {
            ST_DOWN: 'SillyTavern выключена',
            ST_BACKEND: 'Модель не ответила',
            ST_FORBIDDEN: 'SillyTavern отказала в доступе',
            ST_UNSUPPORTED: 'Неподходящий режим SillyTavern',
            ST_NOT_CONFIGURED: 'SillyTavern не настроена',
            BUSY: 'Сервер занят',
            TIMEOUT: 'Слишком долгий ответ',
            EMPTY: 'Пустой ответ',
            JOB_GONE: 'Ответ потерян',
            UNSET: 'Адрес сервера не указан',
        };
        lastError = {
            title: titles[error.code] || networkTitle || 'Не удалось получить ответ',
            text: error.message || 'Попробуйте ещё раз.',
            retry: () => {
                lastError = null;
                if (chat.messages.at(-1)?.role === 'assistant' && canRegenerate(chat.messages.at(-1))) regenerate(chat.messages.at(-1));
                else requestReply();
            },
        };
        checkConnection();
    }

    async function finishGeneration(message) {
        const wasNearBottom = nearBottom();
        generating = null;
        chat.pendingJob = null;
        message.at = Date.now();
        await saveChat(chat).catch(() => toast('Не удалось сохранить беседу в браузере.', { kind: 'bad' }));
        if (disposed) return;
        const entry = nodes.get(message.id);
        if (entry) paintBody(entry);
        refreshChrome();
        if (wasNearBottom || lastError) scrollDown();
    }

    // Reads a job until it ends. Dropped polls are tolerated: a phone may lock or change networks.
    async function followJob(message, jobId, startFrom) {
        let from = startFrom;
        let lastSave = Date.now();
        let failingSince = 0;
        for (;;) {
            if (disposed) return;
            if (generating?.cancelled) throw new Stopped();
            let job;
            try {
                job = await readJob(jobId, from);
                failingSince = 0;
                // Left the chat: the job stays pending in the saved chat and resumes on return.
                if (disposed) return;
            } catch (error) {
                if (error.code !== 'NETWORK') throw error;
                failingSince = failingSince || Date.now();
                if (Date.now() - failingSince > POLL_FAILURE_GRACE_MS) throw error;
                await sleep(3000);
                continue;
            }
            if (job.text) {
                const stick = nearBottom();
                message.variants[message.v] += job.text;
                from = job.length;
                paintBody(nodes.get(message.id));
                if (stick) scrollDown();
                if (Date.now() - lastSave > SAVE_EVERY_MS) {
                    lastSave = Date.now();
                    saveChat(chat).catch(() => {});
                }
            }
            if (job.status === 'done') return;
            if (job.status === 'cancelled') throw new Stopped();
            if (job.status === 'error') {
                const error = new Error(job.error?.message || 'Не удалось получить ответ.');
                error.code = job.error?.code;
                throw error;
            }
            await sleep(document.visibilityState === 'visible' ? POLL_MS : 2000);
        }
    }

    function stopGeneration() {
        if (!generating) return;
        generating.cancelled = true;
        if (generating.jobId) cancelJob(generating.jobId).catch(() => {});
    }

    // The reply may have kept going while this chat was closed: pick it up where it stopped.
    async function resumePending() {
        const pending = chat.pendingJob;
        if (!pending) return;
        const message = chat.messages.find((m) => m.id === pending.messageId);
        if (!message) {
            chat.pendingJob = null;
            await saveChat(chat);
            return;
        }
        generating = { jobId: pending.id, messageId: message.id, cancelled: false };
        message.v = Math.min(pending.variant, message.variants.length - 1);
        paintBody(nodes.get(message.id));
        refreshChrome();
        try {
            await followJob(message, pending.id, messageText(message).length);
        } catch (error) {
            if (disposed) return;
            handleGenerationFailure(message, error);
        }
        if (!disposed) await finishGeneration(message);
    }

    // ------------------------------------------------------------ message actions

    function shiftVariant(message, delta) {
        if (generating) return;
        const next = message.v + delta;
        if (next < 0) return;
        if (next >= message.variants.length) {
            if (canRegenerate(message)) regenerate(message);
            return;
        }
        message.v = next;
        const entry = nodes.get(message.id);
        paintBody(entry);
        paintChrome(entry);
        saveChat(chat).catch(() => {});
    }

    function beginEdit(message) {
        if (generating) return;
        const entry = nodes.get(message.id);
        editingId = message.id;
        openActions = null;
        entry.row.classList.remove('show-actions');
        entry.row.classList.add('editing');
        const area = el('textarea.edit-input', { value: messageText(message), 'aria-label': 'Текст сообщения' });
        const finish = () => {
            editingId = null;
            entry.row.classList.remove('editing');
            paintBody(entry);
            paintChrome(entry);
        };
        const commit = async () => {
            const text = area.value.trim();
            if (!text) {
                toast('Пустое сообщение нельзя сохранить. Его можно удалить.');
                return;
            }
            message.variants[message.v] = text;
            finish();
            await saveChat(chat).catch(() => toast('Не удалось сохранить.', { kind: 'bad' }));
        };
        area.addEventListener('input', () => {
            area.style.height = 'auto';
            area.style.height = `${area.scrollHeight + 2}px`;
        });
        area.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') finish();
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit();
        });
        entry.body.replaceChildren(area, el('div.edit-actions',
            el('button.btn.ghost.small', { type: 'button', onclick: finish }, 'Отмена'),
            el('button.btn.primary.small', { type: 'button', onclick: commit }, 'Сохранить')));
        area.style.height = `${area.scrollHeight + 2}px`;
        area.focus({ preventScroll: true });
        area.setSelectionRange(area.value.length, area.value.length);
    }

    async function copyMessage(message) {
        try {
            await navigator.clipboard.writeText(show(messageText(message)));
            toast('Скопировано');
        } catch {
            toast('Браузер не разрешил копирование.', { kind: 'bad' });
        }
        openActions = null;
        refreshChrome();
    }

    function removeMessage(message) {
        if (generating) return;
        const index = chat.messages.indexOf(message);
        if (index < 0) return;
        chat.messages.splice(index, 1);
        const entry = nodes.get(message.id);
        const after = entry.row.nextElementSibling;
        entry.row.remove();
        nodes.delete(message.id);
        openActions = null;
        lastError = null;
        refreshChrome();
        saveChat(chat).catch(() => {});
        toast('Сообщение удалено', {
            action: 'Вернуть',
            duration: 6000,
            onAction: () => {
                if (disposed) return;
                chat.messages.splice(index, 0, message);
                list.insertBefore(buildMessage(message), after && after.isConnected ? after : null);
                refreshChrome();
                saveChat(chat).catch(() => {});
            },
        });
    }

    // ------------------------------------------------------------ swipe to regenerate

    function hideSwipeHint() {
        try {
            localStorage.setItem(HINT_KEY, '1');
        } catch { /* no storage */ }
        document.querySelectorAll('.swipe-tip').forEach((tip) => tip.remove());
    }

    function attachSwipe(entry) {
        const { bubble, row, message } = entry;
        let startX = 0;
        let startY = 0;
        let dx = 0;
        let tracking = false;
        let horizontal = false;

        const reset = () => {
            bubble.style.transition = '';
            bubble.style.transform = '';
            row.style.removeProperty('--swipe');
            row.classList.remove('swiping', 'armed');
        };

        bubble.addEventListener('touchstart', (event) => {
            tracking = false;
            if (event.touches.length !== 1 || generating || editingId || message.id !== lastBotId()) return;
            const touch = event.touches[0];
            // The screen edges belong to the browser's back gesture.
            if (touch.clientX < SWIPE_EDGE_GUARD_PX || touch.clientX > window.innerWidth - SWIPE_EDGE_GUARD_PX) return;
            if (!canRegenerate(message) && message.variants.length < 2) return;
            startX = touch.clientX;
            startY = touch.clientY;
            dx = 0;
            horizontal = false;
            tracking = true;
        }, { passive: true });

        bubble.addEventListener('touchmove', (event) => {
            if (!tracking) return;
            const touch = event.touches[0];
            const moveX = touch.clientX - startX;
            const moveY = touch.clientY - startY;
            if (!horizontal) {
                if (Math.abs(moveX) < 10 && Math.abs(moveY) < 10) return;
                if (Math.abs(moveY) >= Math.abs(moveX)) {
                    tracking = false;
                    return;
                }
                horizontal = true;
                row.classList.add('swiping');
            }
            // Right swipe has somewhere to go only if an earlier variant exists.
            dx = moveX > 0 && message.v === 0 ? 0 : moveX;
            const damped = Math.sign(dx) * Math.min(Math.abs(dx), 120) * 0.8;
            bubble.style.transition = 'none';
            bubble.style.transform = `translate3d(${damped}px,0,0)`;
            row.style.setProperty('--swipe', String(Math.min(Math.abs(dx) / SWIPE_TRIGGER_PX, 1)));
            row.classList.toggle('armed', dx <= -SWIPE_TRIGGER_PX);
            if (event.cancelable) event.preventDefault();
        }, { passive: false });

        const release = () => {
            if (!tracking) return;
            tracking = false;
            const distance = dx;
            reset();
            if (!horizontal) return;
            if (distance <= -SWIPE_TRIGGER_PX) {
                hideSwipeHint();
                navigator.vibrate?.(12);
                shiftVariant(message, 1);
            } else if (distance >= SWIPE_TRIGGER_PX) {
                shiftVariant(message, -1);
            }
        };
        bubble.addEventListener('touchend', release);
        bubble.addEventListener('touchcancel', () => {
            tracking = false;
            reset();
        });
    }

    function maybeShowSwipeTip() {
        if (!isTouch()) return;
        let seen = false;
        try {
            seen = Boolean(localStorage.getItem(HINT_KEY));
        } catch { /* no storage */ }
        const id = lastBotId();
        if (seen || !id || !canRegenerate(chat.messages.at(-1))) return;
        nodes.get(id)?.bubble.append(el('div.swipe-tip', 'Смахните влево, чтобы получить другой ответ'));
    }

    // ------------------------------------------------------------ chat header and menu

    function chatsSheet() {
        openSheet((close) => {
            const body = el('div.chats-list');
            listChats(character.id).then((chats) => {
                body.replaceChildren(...chats.map((item) => el(`div.chats-item${item.id === chat.id ? '.current' : ''}`,
                    el('a.chats-open', { href: `#/chat/${item.id}`, onclick: close },
                        el('span.chats-preview', item.messages.length ? show(messageText(item.messages.at(-1))).replace(/[*«»"]/g, '').slice(0, 80) : 'Пустая беседа'),
                        el('span.chats-meta', `${item.messages.length} ${plural(item.messages.length, 'сообщение', 'сообщения', 'сообщений')} · ${timeAgo(item.updatedAt)}`)),
                    iconButton('trash', 'Удалить беседу', async () => {
                        const yes = await confirmDialog({ title: 'Удалить беседу?', text: 'Все её сообщения пропадут. Отменить это нельзя.', confirmLabel: 'Удалить', danger: true });
                        if (!yes) return;
                        await deleteChat(item.id);
                        close();
                        if (item.id === chat.id) go('/hall');
                        else toast('Беседа удалена');
                    }))));
            });
            return el('div.confirm',
                iconButton('close', 'Закрыть', close, 'sheet-close'),
                el('h2.confirm-title', `Беседы: ${character.name}`),
                body,
                el('div.confirm-actions',
                    el('button.btn.primary.wide', {
                        type: 'button',
                        onclick: async () => {
                            const fresh = await createChat(character);
                            close();
                            go(`/chat/${fresh.id}`);
                        },
                    }, 'Новая беседа')));
        });
    }

    function paintBanner(link) {
        const trouble = !['ok', 'checking'].includes(link.state);
        banner.hidden = !trouble;
        if (trouble) {
            banner.replaceChildren(el('strong', describeLink(link).title), el('span', 'Подробнее'));
        }
    }

    const offLink = onLinkChange(paintBanner);
    paintBanner(getLink());

    const header = el('header.chat-head',
        el('a.icon-btn', { href: '#/hall', 'aria-label': 'В зал', title: 'В зал' }, icon('back')),
        portrait(character, 'avatar'),
        el('div.chat-head-text',
            el('h1.chat-title', character.name),
            el('span.chat-sub', 'Нажмите на реплику, чтобы изменить')),
        iconButton('list', 'Беседы с этим персонажем', chatsSheet));

    const side = el('aside.chat-side',
        el('a.chat-side-back', { href: '#/hall' }, icon('back'), 'В зал'),
        el('div.chat-side-window', portrait(character)),
        el('h2.chat-side-name', character.name),
        character.scenario?.trim() ? el('section.chat-side-text', el('h3.eyebrow', 'Сценарий'), el('p', show(character.scenario))) : null,
        el('section.chat-side-text', el('h3.eyebrow', 'О персонаже'), el('p', character.description)),
        el('div.chat-side-actions',
            el('button.btn.ghost.wide', { type: 'button', onclick: chatsSheet }, icon('list'), 'Все беседы'),
            el('a.link-btn', { href: `#/edit/${character.id}` }, icon('edit'), 'Изменить персонажа')));

    const node = el('div.chat',
        side,
        el('div.chat-main',
            header,
            banner,
            scroller,
            el('div.composer-wrap', toBottom, composer)));

    // ------------------------------------------------------------ first paint

    chat.messages.slice(renderedFrom).forEach((message) => list.append(buildMessage(message)));
    sentinel.hidden = renderedFrom === 0;
    paintNotices();
    paintComposer();

    return {
        node,
        onMount() {
            growInput();
            scrollDown();
            resumePending();
            maybeShowSwipeTip();
            if (!isTouch()) input.focus({ preventScroll: true });
        },
        cleanup() {
            disposed = true;
            offLink();
        },
    };
}
