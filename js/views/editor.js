// Character form with a live window preview.
import { getCharacter, saveCharacter, uid } from '../store.js';
import { confirmDialog, el, icon, portrait, toast } from '../ui.js';
import { go } from '../main.js';
import { topBar } from './common.js';

const PHOTO_WIDTH = 640;
const PHOTO_HEIGHT = 800;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

const LIMITS = { name: 60, description: 4000, personality: 3000, scenario: 3000, greeting: 3000 };

// Photos are cropped and re-encoded in the browser, which also strips EXIF and location.
async function preparePhoto(file) {
    if (!file.type.startsWith('image/')) throw new Error('Нужен файл изображения: JPG, PNG или WebP.');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('Файл больше 25 МБ. Выберите фото поменьше.');
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error('Не удалось прочитать это изображение. Попробуйте другой файл.');
    }
    const scale = Math.max(PHOTO_WIDTH / bitmap.width, PHOTO_HEIGHT / bitmap.height);
    const canvas = el('canvas', { width: PHOTO_WIDTH, height: PHOTO_HEIGHT });
    const drawWidth = bitmap.width * scale;
    const drawHeight = bitmap.height * scale;
    // Bias the crop upward: faces tend to sit in the top part of a portrait.
    canvas.getContext('2d').drawImage(bitmap, (PHOTO_WIDTH - drawWidth) / 2, (PHOTO_HEIGHT - drawHeight) * 0.3, drawWidth, drawHeight);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.84);
}

function textField({ id, label, hint, value, rows, maxLength, required, onInput }) {
    const counter = el('span.field-count');
    const control = rows
        ? el('textarea.field-input', { id, rows, maxLength, value })
        : el('input.field-input', { id, type: 'text', maxLength, value, autocomplete: 'off' });
    const error = el('span.field-error', { hidden: true });
    const update = () => {
        counter.textContent = `${control.value.length}/${maxLength}`;
    };
    control.addEventListener('input', () => {
        update();
        error.hidden = true;
        control.removeAttribute('aria-invalid');
        onInput?.();
    });
    update();
    return {
        control,
        setError(message) {
            error.textContent = message;
            error.hidden = false;
            control.setAttribute('aria-invalid', 'true');
        },
        node: el('label.field', { htmlFor: id },
            el('span.field-head',
                el('span.field-label', label, required ? el('span.req', { 'aria-hidden': 'true' }, ' *') : null),
                counter),
            hint ? el('span.field-hint', hint) : null,
            control,
            error),
    };
}

export async function renderEditor(id) {
    const existing = id ? await getCharacter(id) : null;
    if (id && !existing) {
        return {
            node: el('div.page.center',
                el('h1.title', 'Персонаж не найден'),
                el('p.muted', 'Возможно, он уже удалён.'),
                el('a.btn.primary', { href: '#/hall' }, 'Вернуться в зал')),
        };
    }

    const draft = {
        id: existing?.id || uid(),
        createdAt: existing?.createdAt || Date.now(),
        photo: existing?.photo || null,
    };
    let dirty = false;

    const previewBox = el('div.preview-window');
    const previewName = el('span.guest-name');
    const paintPreview = () => {
        const name = fields.name.control.value.trim();
        previewBox.replaceChildren(portrait({ name: name || '?', photo: draft.photo }));
        previewName.textContent = name || 'Имя персонажа';
    };
    const touched = () => {
        dirty = true;
        paintPreview();
    };

    const fields = {
        name: textField({ id: 'c-name', label: 'Имя', value: existing?.name || '', maxLength: LIMITS.name, required: true, onInput: touched }),
        description: textField({ id: 'c-desc', label: 'Описание', hint: 'Кто это, сколько лет, как выглядит, чем живёт.', value: existing?.description || '', rows: 5, maxLength: LIMITS.description, required: true, onInput: touched }),
        personality: textField({ id: 'c-pers', label: 'Характер', hint: 'Манера речи, привычки, что любит и что ненавидит.', value: existing?.personality || '', rows: 4, maxLength: LIMITS.personality, onInput: touched }),
        scenario: textField({ id: 'c-scen', label: 'Сценарий', hint: 'Где и как начинается история. Можно писать {{user}} вместо имени собеседника.', value: existing?.scenario || '', rows: 4, maxLength: LIMITS.scenario, onInput: touched }),
        greeting: textField({ id: 'c-greet', label: 'Приветствие', hint: 'Первая реплика в каждой новой беседе. Действия пишите между *звёздочками*.', value: existing?.greeting || '', rows: 4, maxLength: LIMITS.greeting, required: true, onInput: touched }),
    };

    const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true, id: 'c-photo' });
    const removePhoto = el('button.link-btn', {
        type: 'button',
        onclick: () => {
            draft.photo = null;
            removePhoto.hidden = true;
            touched();
        },
    }, icon('trash'), 'Убрать фото');
    removePhoto.hidden = !draft.photo;
    const photoStatus = el('p.field-hint', { role: 'status' }, 'JPG, PNG или WebP. Фото обрежется под окошко.');

    fileInput.addEventListener('change', async () => {
        const [file] = fileInput.files;
        fileInput.value = '';
        if (!file) return;
        photoStatus.textContent = 'Обрабатываем фото…';
        try {
            draft.photo = await preparePhoto(file);
            removePhoto.hidden = false;
            photoStatus.textContent = 'Фото готово.';
            touched();
        } catch (error) {
            photoStatus.textContent = error.message;
        }
    });

    const adult = el('input', { type: 'checkbox', id: 'c-adult', checked: Boolean(existing?.adultConfirmed) });
    const adultError = el('span.field-error', { hidden: true });
    adult.addEventListener('change', () => {
        adultError.hidden = true;
        dirty = true;
    });

    const save = el('button.btn.primary.wide', { type: 'submit' }, existing ? 'Сохранить' : 'Заселить в таверну');

    const form = el('form.editor-form', {
        novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            const value = (key) => fields[key].control.value.trim();
            let firstBad = null;
            for (const [key, message] of [['name', 'Как зовут персонажа?'], ['description', 'Опишите персонажа хотя бы в паре фраз.'], ['greeting', 'С чего персонаж начнёт разговор?']]) {
                if (!value(key)) {
                    fields[key].setError(message);
                    firstBad = firstBad || fields[key].control;
                }
            }
            if (!adult.checked) {
                adultError.textContent = 'В таверне могут жить только совершеннолетние персонажи.';
                adultError.hidden = false;
                firstBad = firstBad || adult;
            }
            if (firstBad) {
                firstBad.focus();
                return;
            }
            save.disabled = true;
            try {
                await saveCharacter({
                    ...existing,
                    id: draft.id,
                    createdAt: draft.createdAt,
                    name: value('name'),
                    description: value('description'),
                    personality: value('personality'),
                    scenario: value('scenario'),
                    greeting: value('greeting'),
                    photo: draft.photo,
                    adultConfirmed: true,
                });
                dirty = false;
                toast(existing ? 'Изменения сохранены' : `Персонаж «${value('name')}» создан`);
                go('/hall');
            } catch {
                save.disabled = false;
                toast('Не удалось сохранить: в браузере закончилось место или он запретил хранение данных.', { kind: 'bad', duration: 6000 });
            }
        },
    },
    fields.name.node,
    el('div.field',
        el('span.field-label', 'Фотография'),
        el('div.photo-row',
            el('label.btn.ghost', { htmlFor: 'c-photo', tabIndex: 0 }, icon('photo'), draft.photo ? 'Заменить фото' : 'Выбрать фото'),
            removePhoto),
        fileInput,
        photoStatus),
    fields.description.node,
    fields.personality.node,
    fields.scenario.node,
    fields.greeting.node,
    el('div.field',
        el('label.check', { htmlFor: 'c-adult' }, adult, el('span', 'Персонажу есть 18 лет, и он никогда не изображается ребёнком')),
        adultError),
    el('div.editor-save', save));

    paintPreview();

    const back = async (event) => {
        if (!dirty) return;
        event.preventDefault();
        const leave = await confirmDialog({ title: 'Уйти без сохранения?', text: 'Введённые данные пропадут.', confirmLabel: 'Уйти', cancelLabel: 'Остаться', danger: true });
        if (leave) {
            dirty = false;
            go('/hall');
        }
    };

    const bar = topBar({ title: existing ? `Изменить: ${existing.name}` : 'Новый постоялец' });
    bar.prepend(el('a.icon-btn', { href: '#/hall', 'aria-label': 'Назад', title: 'Назад', onclick: back }, icon('back')));

    const beforeUnload = (event) => {
        if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);

    const node = el('div.editor',
        bar,
        el('div.editor-body',
            el('aside.editor-preview', { 'aria-hidden': 'true' },
                el('div.guest.static',
                    el('span.guest-window', previewBox),
                    el('span.guest-plaque', previewName))),
            form));

    return { node, cleanup: () => window.removeEventListener('beforeunload', beforeUnload) };
}
