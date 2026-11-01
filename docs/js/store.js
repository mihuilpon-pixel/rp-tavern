// All characters and chats live in this browser's IndexedDB, so history stays
// readable while the owner's computer is off.
import { SEED_CHARACTERS } from './seeds.js';

const DB_NAME = 'rp-tavern';
const DB_VERSION = 1;
let dbPromise = null;

export function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('characters', { keyPath: 'id' });
            const chats = db.createObjectStore('chats', { keyPath: 'id' });
            chats.createIndex('characterId', 'characterId');
            db.createObjectStore('meta', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

function wrap(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function store(name, mode = 'readonly') {
    const db = await openDb();
    return db.transaction(name, mode).objectStore(name);
}

export async function listCharacters() {
    const items = await wrap((await store('characters')).getAll());
    return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getCharacter(id) {
    return wrap((await store('characters')).get(id));
}

export async function saveCharacter(character) {
    await wrap((await store('characters', 'readwrite')).put({ ...character, updatedAt: Date.now() }));
}

export async function deleteCharacter(id) {
    const db = await openDb();
    const tx = db.transaction(['characters', 'chats'], 'readwrite');
    tx.objectStore('characters').delete(id);
    const chats = tx.objectStore('chats');
    const keys = await wrap(chats.index('characterId').getAllKeys(id));
    keys.forEach((key) => chats.delete(key));
    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

export async function listChats(characterId) {
    const all = characterId
        ? await wrap((await store('chats')).index('characterId').getAll(characterId))
        : await wrap((await store('chats')).getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id) {
    return wrap((await store('chats')).get(id));
}

export async function saveChat(chat) {
    chat.updatedAt = Date.now();
    await wrap((await store('chats', 'readwrite')).put(chat));
}

export async function deleteChat(id) {
    await wrap((await store('chats', 'readwrite')).delete(id));
}

export function makeMessage(role, text) {
    return { id: uid(), role, variants: [text], v: 0, at: Date.now() };
}

export function messageText(message) {
    return message.variants[message.v] ?? '';
}

export async function createChat(character) {
    const chat = {
        id: uid(),
        characterId: character.id,
        messages: character.greeting?.trim() ? [makeMessage('assistant', character.greeting.trim())] : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pendingJob: null,
    };
    await saveChat(chat);
    return chat;
}

export async function seedIfFirstRun() {
    const meta = await wrap((await store('meta')).get('seeded'));
    if (meta) return;
    await restoreSeeds();
    await wrap((await store('meta', 'readwrite')).put({ key: 'seeded', value: true }));
}

export async function restoreSeeds() {
    const now = Date.now();
    await Promise.all(SEED_CHARACTERS.map((seed, index) => saveCharacter({ ...seed, createdAt: now - index })));
}

export async function exportAll() {
    return {
        app: 'rp-tavern',
        version: 1,
        exportedAt: new Date().toISOString(),
        characters: await listCharacters(),
        chats: await listChats(),
    };
}

function validMessage(m) {
    return m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant')
        && Array.isArray(m.variants) && m.variants.every((t) => typeof t === 'string') && Number.isInteger(m.v);
}

export async function importAll(data) {
    if (data?.app !== 'rp-tavern' || !Array.isArray(data.characters) || !Array.isArray(data.chats)) {
        throw new Error('Это не файл резервной копии RP Tavern.');
    }
    const characters = data.characters.filter((c) => typeof c?.id === 'string' && typeof c.name === 'string');
    // Photos render as <img src>, so only image data URLs are let back in.
    characters.forEach((c) => {
        if (typeof c.photo !== 'string' || !c.photo.startsWith('data:image/')) c.photo = null;
    });
    const ids = new Set(characters.map((c) => c.id));
    const chats = data.chats.filter((c) => typeof c?.id === 'string' && ids.has(c.characterId)
        && Array.isArray(c.messages) && c.messages.every(validMessage));
    for (const character of characters) await saveCharacter(character);
    for (const chat of chats) await saveChat({ ...chat, pendingJob: null });
    return { characters: characters.length, chats: chats.length };
}

export async function wipeAll() {
    const db = await openDb();
    const tx = db.transaction(['characters', 'chats'], 'readwrite');
    tx.objectStore('characters').clear();
    tx.objectStore('chats').clear();
    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}
