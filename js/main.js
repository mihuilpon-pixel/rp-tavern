import { getToken, normalizeServerUrl, setServer, startHeartbeat, verifySession } from './api.js';
import { seedIfFirstRun } from './store.js';
import { el, reducedMotion, toast } from './ui.js';
import { ageConfirmed, renderDoor } from './views/door.js';
import { renderHall } from './views/hall.js';
import { renderEditor } from './views/editor.js';
import { renderChat } from './views/chat.js';
import { renderSettings } from './views/settings.js';

const app = document.getElementById('app');
let cleanup = null;
let renderRun = 0;

function trackViewport() {
    // iOS ignores interactive-widget, so the composer follows the keyboard through visualViewport.
    const viewport = window.visualViewport;
    const apply = () => {
        const height = viewport ? viewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--app-h', `${Math.round(height)}px`);
        if (viewport && window.scrollY !== 0 && document.querySelector('.chat')) window.scrollTo(0, 0);
    };
    apply();
    viewport?.addEventListener('resize', apply);
    window.addEventListener('resize', apply);
}

function parseRoute() {
    const [, section = '', id = ''] = location.hash.replace(/^#/, '').split('/');
    return { section, id: decodeURIComponent(id) };
}

export function go(path) {
    if (location.hash === `#${path}`) route();
    else location.hash = path;
}

function swapView(node, teardown, onMount) {
    // startViewTransition runs this callback later, so everything that needs the new DOM goes inside.
    const replace = () => {
        cleanup?.();
        cleanup = teardown || null;
        app.replaceChildren(node);
        window.scrollTo(0, 0);
        onMount?.();
    };
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(replace);
    else replace();
}

function renderBroken(error) {
    console.error(error);
    swapView(el('div.page.center',
        el('h1.title', 'Что-то сломалось'),
        el('p.muted', 'Не удалось открыть этот экран. Ваши данные не пострадали.'),
        el('a.btn.primary', { href: '#/hall' }, 'Вернуться в зал')));
}

async function route() {
    const run = (renderRun += 1);
    const { section, id } = parseRoute();
    const signedIn = Boolean(getToken()) && ageConfirmed();

    if (!signedIn && section !== 'door') {
        location.replace('#/door');
        return;
    }
    if (signedIn && (section === 'door' || section === '')) {
        location.replace('#/hall');
        return;
    }

    try {
        let view;
        if (section === 'door') view = await renderDoor({ onEnter: () => go('/hall') });
        else if (section === 'hall') view = await renderHall();
        else if (section === 'new') view = await renderEditor(null);
        else if (section === 'edit') view = await renderEditor(id);
        else if (section === 'chat') view = await renderChat(id);
        else if (section === 'settings') view = await renderSettings();
        else view = await renderHall();
        if (run !== renderRun) {
            view.cleanup?.();
            return;
        }
        swapView(view.node, view.cleanup, view.onMount);
    } catch (error) {
        if (run === renderRun) renderBroken(error);
    }
}

function adoptServerFromLink() {
    const params = new URLSearchParams(location.search);
    const shared = normalizeServerUrl(params.get('server'));
    if (shared) setServer(shared);
    if (params.has('server')) history.replaceState(null, '', location.pathname + location.hash);
}

async function boot() {
    trackViewport();
    adoptServerFromLink();
    window.addEventListener('hashchange', route);
    window.addEventListener('rpt:signed-out', () => {
        toast('Сессия устарела. Введите код доступа заново.');
        go('/door');
    });
    await seedIfFirstRun();
    startHeartbeat();
    route();
    // A tunnel being down must not sign anyone out, so only an explicit 401 ends the session.
    if (getToken()) verifySession().catch(() => {});
}

boot().catch(renderBroken);
