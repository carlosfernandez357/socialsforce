// Motor de recomendación: trending, relacionados y "For You".
// Cada capa tiene fallback: si falta una tabla o una consulta falla, se degrada
// al siguiente método disponible sin romper la página.

const { q, features, categoryId, clamp, logError, slugify } = require("./safe");

const CARD = "p.id, p.title, p.slug, p.excerpt, p.image, p.category, p.views, p.published_at";
const LEGACY_TREND = "p.views / POW(TIMESTAMPDIFF(HOUR, p.published_at, NOW()) + 2, 1.5)";

// ---------- Caché de candidatos (5 min) ----------
let cache = { at: 0, posts: [], byId: new Map() };

async function loadCandidates() {
    if (Date.now() - cache.at < 5 * 60e3 && cache.posts.length) return cache;
    const f = features();
    const ctx = f.postContext ? ", p.evergreen, p.depth" : "";
    const stats = f.stats ? ", s.trend_score, s.rec_ctr, s.views_7d" : "";
    const join = f.stats ? "LEFT JOIN post_stats s ON s.post_id = p.id" : "";

    let posts = await q(`
        SELECT ${CARD}${ctx}${stats}, ${LEGACY_TREND} AS legacy_trend
        FROM posts p ${join}
        WHERE p.published_at <= NOW()
        ORDER BY p.published_at DESC
        LIMIT 500
    `, [], null, "candidates");

    if (!posts) { // fallback mínimo sin columnas opcionales
        posts = await q(`SELECT ${CARD}, ${LEGACY_TREND} AS legacy_trend FROM posts p WHERE p.published_at <= NOW() ORDER BY p.published_at DESC LIMIT 500`, [], [], "candidates");
    }

    const byId = new Map(posts.map(p => [p.id, p]));
    if (f.topics && posts.length) {
        const ids = posts.map(p => p.id);
        const rows = await q(`
            SELECT pt.post_id, pt.topic_id, pt.weight, t.slug, t.name
            FROM post_topics pt JOIN topics t ON t.id = pt.topic_id
            WHERE pt.post_id IN (${ids.map(() => "?").join(",")})
        `, ids, [], "candidates");
        for (const r of rows) {
            const p = byId.get(r.post_id);
            if (!p) continue;
            (p.topics = p.topics || []).push({ id: r.topic_id, w: Number(r.weight) || 5, slug: r.slug, name: r.name });
        }
    }

    const maxTrend = Math.max(1e-9, ...posts.map(trendOf));
    const maxCtr = Math.max(1e-9, ...posts.map(p => Number(p.rec_ctr) || 0));
    for (const p of posts) {
        p._trend = trendOf(p) / maxTrend;
        p._ctr = (Number(p.rec_ctr) || 0) / maxCtr;
        const hours = Math.max(0, (Date.now() - new Date(p.published_at)) / 3600e3);
        const ever = p.evergreen == null ? 3 : Number(p.evergreen);
        p._fresh = Math.exp(-hours / (48 * (1 + ever / 2)));
        p._catId = p.category ? categoryId(p.category) : null;
    }
    cache = { at: Date.now(), posts, byId };
    return cache;
}

function trendOf(p) {
    const t = Number(p.trend_score);
    return Number.isFinite(t) && t > 0 ? t : (Number(p.legacy_trend) || 0) * 0.01;
}

function invalidate() { cache.at = 0; }

const strip = (p) => ({ id: p.id, title: p.title, slug: p.slug, excerpt: p.excerpt, image: p.image, category: p.category, views: p.views, published_at: p.published_at });

// Selección con diversidad: máx `perCat` por categoría
function diversify(list, n, perCat = 2, exclude = new Set()) {
    const out = [], count = {};
    for (const p of list) {
        if (out.length >= n) break;
        if (exclude.has(p.id)) continue;
        const c = p.category || "_";
        if ((count[c] || 0) >= perCat) continue;
        count[c] = (count[c] || 0) + 1;
        out.push(p);
    }
    // Si no hay suficiente variedad, completar sin la restricción
    for (const p of list) {
        if (out.length >= n) break;
        if (!exclude.has(p.id) && !out.includes(p)) out.push(p);
    }
    return out;
}

// ---------- Trending ----------
async function getTrending(limit = 6, { perCat = 2, exclude = [] } = {}) {
    try {
        const { posts } = await loadCandidates();
        const sorted = [...posts].sort((a, b) => b._trend - a._trend);
        return diversify(sorted, limit, perCat, new Set(exclude)).map(p => ({ ...strip(p), trend_score: p._trend }));
    } catch (error) {
        logError("trending", error);
        return q(`SELECT ${CARD}, ${LEGACY_TREND} AS trend_score FROM posts p WHERE p.published_at <= NOW() ORDER BY trend_score DESC LIMIT ?`, [limit], [], "trending");
    }
}

// ---------- Similitud ----------
function cosine(a = [], b = []) {
    if (!a.length || !b.length) return 0;
    const mb = new Map(b.map(t => [t.id, t.w]));
    let dot = 0, na = 0, nb = 0;
    for (const t of a) { na += t.w * t.w; if (mb.has(t.id)) dot += t.w * mb.get(t.id); }
    for (const t of b) nb += t.w * t.w;
    return dot ? dot / Math.sqrt(na * nb) : 0;
}

async function topicsOf(ids) {
    const map = new Map();
    if (!ids.length || !features().topics) return map;
    const { byId } = await loadCandidates();
    const missing = [];
    for (const id of ids) {
        const p = byId.get(id);
        if (p && p.topics) map.set(id, p.topics); else missing.push(id);
    }
    if (missing.length) {
        const rows = await q(`SELECT post_id, topic_id, weight FROM post_topics WHERE post_id IN (${missing.map(() => "?").join(",")})`, missing, [], "topics");
        for (const r of rows) {
            if (!map.has(r.post_id)) map.set(r.post_id, []);
            map.get(r.post_id).push({ id: r.topic_id, w: Number(r.weight) || 5 });
        }
    }
    return map;
}

// Relacionados de un artículo: post_similarity -> temas en vivo -> categoría
async function getRelated(post, limit = 3, exclude = []) {
    const skip = new Set([post.id, ...exclude]);
    try {
        const { posts, byId } = await loadCandidates();
        const scores = new Map();
        const f = features();

        if (f.similarity) {
            const rows = await q(`SELECT related_id, score, method FROM post_similarity WHERE post_id = ? ORDER BY score DESC LIMIT 40`, [post.id], [], "related");
            const wMethod = { topics: 0.5, covisit: 0.35, embedding: 0.6 };
            for (const r of rows) scores.set(r.related_id, (scores.get(r.related_id) || 0) + (Number(r.score) || 0) * (wMethod[r.method] || 0.3));
        }
        if (scores.size < limit) {
            const mine = (await topicsOf([post.id])).get(post.id) || [];
            for (const p of posts) {
                if (skip.has(p.id)) continue;
                let s = cosine(mine, p.topics) * 0.5;
                if (post.category && p.category === post.category) s += 0.15;
                if (s > 0) scores.set(p.id, Math.max(scores.get(p.id) || 0, s));
            }
        }
        const ranked = [...scores.entries()]
            .filter(([id]) => !skip.has(id) && byId.has(id))
            .map(([id, s]) => { const p = byId.get(id); return { p, s: s + 0.1 * p._trend + 0.05 * p._fresh }; })
            .sort((a, b) => b.s - a.s)
            .map(x => x.p);
        const out = diversify(ranked, limit, 3, skip).map(strip);
        if (out.length >= limit) return out;

        // Relleno: misma categoría y luego trending
        const fill = posts.filter(p => !skip.has(p.id) && !out.find(o => o.id === p.id))
            .sort((a, b) => (b.category === post.category) - (a.category === post.category) || b._trend - a._trend);
        return [...out, ...fill.slice(0, limit - out.length).map(strip)];
    } catch (error) {
        logError("related", error);
        return q(`SELECT ${CARD} FROM posts p WHERE p.category = ? AND p.id != ? AND p.published_at <= NOW() ORDER BY RAND() LIMIT ?`, [post.category, post.id, limit], [], "related");
    }
}

// ---------- Perfil del visitante ----------
async function getProfile(visitorId, legacyCats = []) {
    const profile = { cats: new Map(), topics: new Map(), seen: new Set(), recent: [], hasData: false };
    const f = features();
    if (visitorId && f.interests) {
        const rows = await q(`
            SELECT kind, ref_id, score * POW(0.5, GREATEST(TIMESTAMPDIFF(SECOND, updated_at, NOW()), 0) / 604800) AS s
            FROM visitor_interests WHERE visitor_id = ?
        `, [visitorId], [], "profile");
        for (const r of rows) {
            const s = Number(r.s) || 0;
            if (s <= 0) continue;
            (r.kind === "topic" ? profile.topics : profile.cats).set(Number(r.ref_id), s);
        }
    }
    if (visitorId && f.tracking) {
        const views = await q(`
            SELECT post_id, MAX(started_at) AS last FROM post_views
            WHERE visitor_id = ? AND started_at >= NOW() - INTERVAL 60 DAY
            GROUP BY post_id ORDER BY last DESC LIMIT 200
        `, [visitorId], [], "profile");
        views.forEach(v => profile.seen.add(v.post_id));
        profile.recent = views.slice(0, 3).map(v => v.post_id);
    }
    // Historial del navegador (compatibilidad / sin tablas)
    if (!profile.cats.size && legacyCats.length) legacyCats.forEach((c, i) => profile.cats.set(categoryId(c), legacyCats.length - i));

    const norm = (m) => { const mx = Math.max(0, ...m.values()); if (mx > 0) for (const [k, v] of m) m.set(k, v / mx); };
    norm(profile.cats); norm(profile.topics);
    profile.hasData = profile.cats.size > 0 || profile.topics.size > 0;
    return profile;
}

function affinity(p, profile) {
    const cat = p._catId != null ? (profile.cats.get(p._catId) || 0) : 0;
    let top = 0;
    if (p.topics && p.topics.length && profile.topics.size) {
        let sw = 0;
        for (const t of p.topics) { top += (profile.topics.get(t.id) || 0) * t.w; sw += t.w; }
        top = sw ? top / sw : 0;
    }
    return profile.topics.size ? 0.6 * top + 0.4 * cat : cat;
}

// ---------- For You ----------
// Funciona siempre: con perfil (personalizado), con contexto (artículo actual) o en frío.
async function getForYou({ visitorId = null, legacyCats = [], exclude = [], contextId = null, page = 0, size = 6 } = {}) {
    try {
        const { posts } = await loadCandidates();
        if (!posts.length) return { posts: [], personalized: false };
        const profile = await getProfile(visitorId, legacyCats);
        const skip = new Set([...exclude, ...profile.seen]);
        if (contextId) skip.add(contextId);

        // Similitud con lo último leído (o con el artículo actual)
        const anchors = [...new Set([contextId, ...profile.recent].filter(Boolean))].slice(0, 3);
        const anchorTopics = await topicsOf(anchors);
        const anchorCats = new Set(anchors.map(id => cache.byId.get(id)).filter(Boolean).map(p => p.category));

        const scored = posts.filter(p => !skip.has(p.id)).map(p => {
            let sim = 0;
            for (const a of anchors) sim = Math.max(sim, cosine(anchorTopics.get(a), p.topics));
            if (!sim && anchorCats.has(p.category)) sim = 0.3;
            const score = profile.hasData
                ? 0.40 * affinity(p, profile) + 0.20 * sim + 0.20 * p._trend + 0.10 * p._fresh + 0.10 * p._ctr
                : 0.45 * p._trend + 0.25 * p._fresh + 0.15 * p._ctr + 0.15 * sim;
            return { p, score, aff: profile.hasData ? affinity(p, profile) : 0 };
        }).sort((a, b) => b.score - a.score);

        // Bloques de `size`: diversidad + ~1 hueco de exploración por bloque
        const pool = scored.map(x => x.p);
        const explore = profile.hasData ? scored.filter(x => x.aff < 0.15).sort((a, b) => b.p._trend - a.p._trend).map(x => x.p) : [];
        const result = [], used = new Set();
        const total = (page + 1) * size;
        while (result.length < total) {
            const need = Math.min(size, total - result.length);
            const exploreSlots = explore.length && need >= 5 ? 1 : 0;
            const block = diversify(pool.filter(p => !used.has(p.id)), need - exploreSlots, 2);
            block.forEach(p => used.add(p.id));
            if (exploreSlots) {
                const e = explore.find(p => !used.has(p.id));
                if (e) { used.add(e.id); block.splice(Math.min(3, block.length), 0, e); }
            }
            if (!block.length) break;
            result.push(...block);
        }
        return { posts: result.slice(page * size, total).map(strip), personalized: profile.hasData, hasMore: used.size < pool.length };
    } catch (error) {
        logError("foryou", error);
        const rows = await q(`SELECT ${CARD} FROM posts p WHERE p.published_at <= NOW() ORDER BY ${LEGACY_TREND} DESC LIMIT ?`, [size], [], "foryou");
        return { posts: rows, personalized: false, hasMore: false };
    }
}

// ---------- Sidebar del home ----------
async function getHomeSidebar(excludeIds = []) {
    const f = features();
    const skip = new Set(excludeIds);
    const out = { latest: [], mostRead: [], categories: [], topics: [] };
    try {
        const { posts } = await loadCandidates();
        out.latest = posts.filter(p => !skip.has(p.id)).slice(0, 8).map(strip);

        const weekAgo = Date.now() - 7 * 86400e3;
        out.mostRead = [...posts]
            .filter(p => !skip.has(p.id) && (f.stats ? true : new Date(p.published_at) >= weekAgo))
            .sort((a, b) => (f.stats ? (Number(b.views_7d) || 0) - (Number(a.views_7d) || 0) : 0) || (b.views || 0) - (a.views || 0))
            .slice(0, 5).map(strip);
    } catch (error) { logError("home-sidebar", error); }

    out.categories = await q(`
        SELECT category AS name, COUNT(*) AS total FROM posts
        WHERE category IS NOT NULL AND category != '' AND published_at <= NOW()
        GROUP BY category ORDER BY total DESC
    `, [], [], "home-sidebar");

    if (f.topics) {
        out.topics = await q(`
            SELECT t.slug, t.name, COUNT(*) AS total
            FROM post_topics pt
            JOIN topics t ON t.id = pt.topic_id
            JOIN posts p ON p.id = pt.post_id
            WHERE p.published_at <= NOW() AND p.published_at >= NOW() - INTERVAL 60 DAY
            GROUP BY t.id, t.slug, t.name
            ORDER BY total DESC, MAX(pt.weight) DESC
            LIMIT 18
        `, [], [], "home-sidebar");
    }
    return out;
}

// ---------- Temas del artículo ----------
// topics: [{name, weight}] o "OpenAI:9, Regulación:5"
function parseTopics(input) {
    let list = [];
    if (Array.isArray(input)) list = input;
    else if (typeof input === "string" && input.trim()) {
        try { const j = JSON.parse(input); if (Array.isArray(j)) list = j; } catch {
            list = input.split(",").map(s => { const [name, w] = s.split(":"); return { name, weight: w }; });
        }
    }
    const seen = new Set();
    return list.map(t => (typeof t === "string" ? { name: t, weight: 5 } : t))
        .map(t => ({ name: String(t.name || "").trim().slice(0, 100), slug: slugify(t.name), weight: clamp(Math.round(Number(t.weight) || 5), 1, 10) }))
        .filter(t => t.slug && !seen.has(t.slug) && seen.add(t.slug))
        .slice(0, 12);
}

async function saveTopics(postId, topicsInput) {
    const f = features();
    const topics = parseTopics(topicsInput);
    if (!f.topics || !postId) return topics;
    await q(`DELETE FROM post_topics WHERE post_id = ?`, [postId], null, "topics");
    for (const t of topics) {
        await q(`INSERT INTO topics (slug, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [t.slug, t.name], null, "topics");
        const row = await q(`SELECT id FROM topics WHERE slug = ? LIMIT 1`, [t.slug], [], "topics");
        if (row[0]) await q(`INSERT INTO post_topics (post_id, topic_id, weight) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE weight = VALUES(weight)`, [postId, row[0].id, t.weight], null, "topics");
    }
    invalidate();
    return topics;
}

async function getPostTopics(postId) {
    if (!features().topics) return [];
    return q(`SELECT t.slug, t.name, pt.weight FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.post_id = ? ORDER BY pt.weight DESC`, [postId], [], "topics");
}

module.exports = { loadCandidates, invalidate, getTrending, getRelated, getForYou, getHomeSidebar, parseTopics, saveTopics, getPostTopics, cosine };
