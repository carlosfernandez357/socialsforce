// Tareas periódicas dentro de Node: post_stats (10 min), similitud por temas (6 h)
// y co-visitas (24 h). Cada tarea es independiente y registra su estado en health.jobs.

const { q, features, health, logError, refreshSchema } = require("./safe");
const { invalidate, cosine } = require("./recommend");

const running = new Set();

async function runJob(name, fn) {
    if (running.has(name)) return;
    running.add(name);
    const started = Date.now();
    const state = health.jobs[name] = health.jobs[name] || {};
    try {
        const info = await fn();
        Object.assign(state, { lastRun: new Date(), ok: true, ms: Date.now() - started, info: info || null, error: null });
    } catch (error) {
        logError("job:" + name, error);
        Object.assign(state, { lastRun: new Date(), ok: false, ms: Date.now() - started, error: error.message });
    } finally {
        running.delete(name);
    }
}

// ---------- post_stats + trend_score ----------
async function computeStats() {
    const f = features();
    if (!f.stats || !f.tracking) return "skipped (faltan post_stats o post_views)";
    const ever = f.postContext ? "COALESCE(p.evergreen, 3)" : "3";
    const ctr = f.impressions
        ? `LEFT JOIN (
               SELECT post_id, (SUM(clicked) + 1) / (COUNT(*) + 20) AS ctr
               FROM rec_impressions WHERE shown_at >= NOW() - INTERVAL 14 DAY GROUP BY post_id
           ) ri ON ri.post_id = p.id`
        : "";

    const [ok] = [await q(`
        INSERT INTO post_stats (post_id, views_1h, views_6h, views_24h, views_7d, engaged_24h,
                                avg_active_seconds, avg_scroll, rec_ctr, trend_score, updated_at)
        SELECT p.id,
            COALESCE(v.v1, 0), COALESCE(v.v6, 0), COALESCE(v.v24, 0), COALESCE(v.v7d, 0), COALESCE(v.e24, 0),
            COALESCE(v.avg_as, 0), COALESCE(v.avg_sp, 0), ${f.impressions ? "COALESCE(ri.ctr, 0)" : "0"},
            (COALESCE(v.v6, 0) + 0.3 * COALESCE(v.v24, 0) + 2 * COALESCE(v.e24, 0) + 0.02 * p.views)
              / POW(GREATEST(TIMESTAMPDIFF(HOUR, p.published_at, NOW()), 0) + 2, GREATEST(1.5 - ${ever} * 0.05, 0.8)),
            NOW()
        FROM posts p
        LEFT JOIN (
            SELECT post_id,
                SUM(started_at >= NOW() - INTERVAL 1 HOUR) AS v1,
                SUM(started_at >= NOW() - INTERVAL 6 HOUR) AS v6,
                SUM(started_at >= NOW() - INTERVAL 24 HOUR) AS v24,
                COUNT(*) AS v7d,
                SUM(started_at >= NOW() - INTERVAL 24 HOUR AND engagement >= 0.6) AS e24,
                AVG(active_seconds) AS avg_as,
                AVG(max_scroll_pct) AS avg_sp
            FROM post_views
            WHERE started_at >= NOW() - INTERVAL 7 DAY
            GROUP BY post_id
        ) v ON v.post_id = p.id
        ${ctr}
        WHERE p.published_at <= NOW()
        ON DUPLICATE KEY UPDATE
            views_1h = VALUES(views_1h), views_6h = VALUES(views_6h), views_24h = VALUES(views_24h),
            views_7d = VALUES(views_7d), engaged_24h = VALUES(engaged_24h),
            avg_active_seconds = VALUES(avg_active_seconds), avg_scroll = VALUES(avg_scroll),
            rec_ctr = VALUES(rec_ctr), trend_score = VALUES(trend_score), updated_at = VALUES(updated_at)
    `, [], null, "job:stats")];
    if (!ok) throw new Error("No se pudo actualizar post_stats (ver errores)");
    invalidate();
    return `${ok.affectedRows || 0} filas`;
}

async function replaceSimilarity(method, pairs) {
    await q(`DELETE FROM post_similarity WHERE method = ?`, [method], null, "job:" + method);
    for (let i = 0; i < pairs.length; i += 300) {
        const chunk = pairs.slice(i, i + 300);
        await q(`INSERT INTO post_similarity (post_id, related_id, score, method) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(",")}
                 ON DUPLICATE KEY UPDATE score = VALUES(score)`,
            chunk.flatMap(p => [p[0], p[1], +p[2].toFixed(4), method]), null, "job:" + method);
    }
}

// ---------- Similitud por temas (coseno sobre pesos) ----------
async function computeTopicSimilarity() {
    const f = features();
    if (!f.similarity || !f.topics) return "skipped (faltan topics/post_similarity)";
    const rows = await q(`
        SELECT pt.post_id, pt.topic_id, pt.weight FROM post_topics pt
        JOIN posts p ON p.id = pt.post_id
        WHERE p.published_at <= NOW()
        ORDER BY p.published_at DESC
        LIMIT 60000
    `, [], [], "job:topics");
    const vec = new Map(), byTopic = new Map();
    for (const r of rows) {
        if (!vec.has(r.post_id)) vec.set(r.post_id, []);
        vec.get(r.post_id).push({ id: r.topic_id, w: Number(r.weight) || 5 });
        if (!byTopic.has(r.topic_id)) byTopic.set(r.topic_id, new Set());
        byTopic.get(r.topic_id).add(r.post_id);
    }
    const pairs = [];
    for (const [pid, v] of vec) {
        const cand = new Set();
        v.forEach(t => byTopic.get(t.id).forEach(o => o !== pid && cand.add(o)));
        const top = [...cand].map(o => [pid, o, cosine(v, vec.get(o))]).filter(x => x[2] > 0.05)
            .sort((a, b) => b[2] - a[2]).slice(0, 12);
        pairs.push(...top);
    }
    await replaceSimilarity("topics", pairs);
    invalidate();
    return `${vec.size} artículos, ${pairs.length} pares`;
}

// ---------- Co-visitas ("quien leyó X también leyó Y") ----------
async function computeCovisit() {
    const f = features();
    if (!f.similarity || !f.tracking) return "skipped";
    const rows = await q(`
        SELECT DISTINCT visitor_id, post_id FROM post_views
        WHERE visitor_id IS NOT NULL AND engagement >= 0.3 AND started_at >= NOW() - INTERVAL 30 DAY
        LIMIT 200000
    `, [], [], "job:covisit");
    const byVisitor = new Map(), n = new Map();
    for (const r of rows) {
        if (!byVisitor.has(r.visitor_id)) byVisitor.set(r.visitor_id, []);
        byVisitor.get(r.visitor_id).push(r.post_id);
        n.set(r.post_id, (n.get(r.post_id) || 0) + 1);
    }
    const co = new Map();
    for (const list of byVisitor.values()) {
        if (list.length < 2 || list.length > 150) continue; // ignora perfiles anómalos
        for (let i = 0; i < list.length; i++) for (let j = 0; j < list.length; j++) {
            if (i === j) continue;
            const k = list[i] + ":" + list[j];
            co.set(k, (co.get(k) || 0) + 1);
        }
    }
    const per = new Map();
    for (const [k, c] of co) {
        if (c < 2) continue; // mínimo 2 visitantes en común
        const [a, b] = k.split(":").map(Number);
        const s = c / Math.sqrt(n.get(a) * n.get(b));
        if (!per.has(a)) per.set(a, []);
        per.get(a).push([a, b, s]);
    }
    const pairs = [];
    for (const list of per.values()) pairs.push(...list.sort((x, y) => y[2] - x[2]).slice(0, 12));
    await replaceSimilarity("covisit", pairs);
    return `${byVisitor.size} visitantes, ${pairs.length} pares`;
}

// Limpieza: impresiones > 90 días
async function cleanup() {
    const f = features();
    if (f.impressions) await q(`DELETE FROM rec_impressions WHERE shown_at < NOW() - INTERVAL 90 DAY LIMIT 50000`, [], null, "job:cleanup");
    // Retención (ver política de privacidad): 12 meses de inactividad -> se borra el perfil
    if (f.tracking) {
        await q(`UPDATE post_views SET visitor_id = NULL WHERE visitor_id IS NOT NULL AND started_at < NOW() - INTERVAL 12 MONTH LIMIT 50000`, [], null, "job:cleanup");
        await q(`DELETE FROM post_views WHERE started_at < NOW() - INTERVAL 13 MONTH LIMIT 50000`, [], null, "job:cleanup");
    }
    if (f.visitors) {
        if (f.interests) await q(`DELETE vi FROM visitor_interests vi JOIN visitors v ON v.id = vi.visitor_id WHERE v.last_seen_at < NOW() - INTERVAL 12 MONTH`, [], null, "job:cleanup");
        await q(`DELETE FROM visitors WHERE last_seen_at < NOW() - INTERVAL 12 MONTH LIMIT 50000`, [], null, "job:cleanup");
    }
    return "ok";
}

function start() {
    const every = (ms, fn) => setInterval(fn, ms).unref();
    const boot = async () => {
        await refreshSchema();
        await runJob("stats", computeStats);
        await runJob("topics", computeTopicSimilarity);
        await runJob("covisit", computeCovisit);
    };
    setTimeout(boot, 5000).unref();
    every(10 * 60e3, async () => { await refreshSchema(); await runJob("stats", computeStats); });
    every(6 * 3600e3, () => runJob("topics", computeTopicSimilarity));
    every(24 * 3600e3, async () => { await runJob("covisit", computeCovisit); await runJob("cleanup", cleanup); });
}

module.exports = { start, runJob, computeStats, computeTopicSimilarity, computeCovisit, cleanup };
