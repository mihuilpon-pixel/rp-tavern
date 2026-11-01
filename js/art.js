// Characters without a photo get their own stained-glass window, derived from the name.
const cache = new Map();

const PALETTES = [
    ['#7b2233', '#b9471f', '#e0ae57', '#2f4a3c', '#f07a3a'],
    ['#2f4a3c', '#6f8f6a', '#e0ae57', '#4a2a4f', '#c9662e'],
    ['#4a2a4f', '#7b2233', '#d98a3d', '#1f3d52', '#e8c27a'],
    ['#1f3d52', '#3f7183', '#e0ae57', '#7b2233', '#d9622b'],
    ['#6b3a1e', '#b9471f', '#e8c27a', '#3a4a26', '#8a2f3a'],
];

function hash(text) {
    let h = 2166136261;
    for (const ch of text) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function rng(seed) {
    let state = seed || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
}

export function stainedGlass(name) {
    const key = name || '?';
    if (cache.has(key)) return cache.get(key);
    const seed = hash(key);
    const random = rng(seed);
    const palette = PALETTES[seed % PALETTES.length];
    const width = 240;
    const height = 300;
    const cols = 4;
    const rows = 5;
    const points = [];
    for (let y = 0; y <= rows; y += 1) {
        for (let x = 0; x <= cols; x += 1) {
            const edgeX = x === 0 || x === cols;
            const edgeY = y === 0 || y === rows;
            points.push([
                (x / cols) * width + (edgeX ? 0 : (random() - 0.5) * 38),
                (y / rows) * height + (edgeY ? 0 : (random() - 0.5) * 38),
            ]);
        }
    }
    const shards = [];
    const addShard = (a, b, c) => {
        const [p, q, r] = [points[a], points[b], points[c]];
        const color = palette[Math.floor(random() * palette.length)];
        const opacity = (0.62 + random() * 0.38).toFixed(2);
        shards.push(`<polygon points="${p.map((n) => n.toFixed(1))} ${q.map((n) => n.toFixed(1))} ${r.map((n) => n.toFixed(1))}" fill="${color}" fill-opacity="${opacity}"/>`);
    };
    for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
            const i = y * (cols + 1) + x;
            const j = i + cols + 1;
            if (random() > 0.5) {
                addShard(i, i + 1, j);
                addShard(i + 1, j + 1, j);
            } else {
                addShard(i, i + 1, j + 1);
                addShard(i, j + 1, j);
            }
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g" cx="50%" cy="42%" r="62%"><stop offset="0" stop-color="#fff0c4" stop-opacity=".5"/><stop offset=".55" stop-color="#ffb35c" stop-opacity=".08"/><stop offset="1" stop-color="#140a08" stop-opacity=".62"/></radialGradient></defs><rect width="${width}" height="${height}" fill="#1b0f0d"/><g stroke="#140a08" stroke-width="3.2" stroke-linejoin="round">${shards.join('')}</g><rect width="${width}" height="${height}" fill="url(#g)"/></svg>`;
    const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    cache.set(key, url);
    return url;
}

export function initialOf(name) {
    return Array.from((name || '?').trim())[0]?.toUpperCase() || '?';
}
