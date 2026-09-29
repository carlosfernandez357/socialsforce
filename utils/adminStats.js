// Datos del dashboard del admin. Cada bloque es independiente: si una tabla falta
// o una consulta falla, ese bloque queda vacío y se añade una recomendación.

const { q, features, health } = require("./safe");

async function collect() {
    const f = features();
    const out = { features: f, kpis: {}, charts: {}, tables: {}, alerts: [], health: null };
    const alert = (level, text) => out.alerts.push({ level, text });

    // ---------- KPIs y gráficas de lectura ----------
    if (f.tracking) {
        const [k] = await q(`
            SELECT
                SUM(started_at >= NOW() - INTERVAL 1 DAY) AS views24h,
                COUNT(*) AS views7d,
                COUNT(DISTINCT visitor_id) AS visitors7d,
                ROUND(AVG(active_seconds)) AS avgSeconds,
                ROUND(AVG(max_scroll_pct)) AS avgScroll,
                ROUND(AVG(engagement), 3) AS avgEngagement,
                ROUND(100 * AVG(engagement < 0.15), 1) AS bounceRate,
                ROUND(100 * AVG(engagement >= 0.6), 1) AS goodReadRate,
                ROUND(100 * AVG(visitor_id IS NOT NULL), 1) AS consentRate
            FROM post_views
            WHERE started_at >= NOW() - INTERVAL 7 DAY
        `, [], [{}], "admin-stats");
        out.kpis = k || {};

        out.charts.daily = await q(`
            SELECT DATE(started_at) AS d, COUNT(*) AS views, ROUND(AVG(engagement), 3) AS engagement,
                   COUNT(DISTINCT visitor_id) AS visitors
            FROM post_views
            WHERE started_at >= CURDATE() - INTERVAL 29 DAY
            GROUP BY DATE(started_at) ORDER BY d
        `, [], [], "admin-stats");

        out.charts.sources = await q(`
            SELECT source AS label, COUNT(*) AS value, ROUND(AVG(engagement), 3) AS engagement
            FROM post_views WHERE started_at >= NOW() - INTERVAL 7 DAY
            GROUP BY source ORDER BY value DESC
        `, [], [], "admin-stats");

        out.charts.hours = await q(`
            SELECT HOUR(started_at) AS h, COUNT(*) AS value
            FROM post_views WHERE started_at >= NOW() - INTERVAL 7 DAY
            GROUP BY HOUR(started_at) ORDER BY h
        `, [], [], "admin-stats");

        out.charts.categories = await q(`
            SELECT p.category AS label, COUNT(*) AS views, ROUND(AVG(v.engagement), 3) AS engagement,
                   ROUND(AVG(v.active_seconds)) AS seconds
            FROM post_views v JOIN posts p ON p.id = v.post_id
            WHERE v.started_at >= NOW() - INTERVAL 30 DAY AND p.category IS NOT NULL AND p.category != ''
            GROUP BY p.category ORDER BY views DESC LIMIT 12
        `, [], [], "admin-stats");

        out.tables.topEngagement = await q(`
            SELECT p.id, p.title, p.slug, p.category, COUNT(*) AS views,
                   ROUND(AVG(v.engagement), 2) AS engagement, ROUND(AVG(v.active_seconds)) AS seconds,
                   ROUND(AVG(v.max_scroll_pct)) AS scroll
            FROM post_views v JOIN posts p ON p.id = v.post_id
            WHERE v.started_at >= NOW() - INTERVAL 30 DAY
            GROUP BY p.id, p.title, p.slug, p.category
            HAVING views >= 5
            ORDER BY engagement DESC LIMIT 10
        `, [], [], "admin-stats");

        out.tables.highBounce = await q(`
            SELECT p.id, p.title, p.slug, COUNT(*) AS views, ROUND(100 * AVG(v.engagement < 0.15)) AS bounce
            FROM post_views v JOIN posts p ON p.id = v.post_id
            WHERE v.started_at >= NOW() - INTERVAL 30 DAY
            GROUP BY p.id, p.title, p.slug
            HAVING views >= 10
            ORDER BY bounce DESC LIMIT 5
        `, [], [], "admin-stats");

        if (!Number(out.kpis.views24h)) alert("warning", "No reading data in the last 24 h. Check that /js/tracker.js loads on articles and that /api/track responds (maybe no traffic yet).");
        if (Number(out.kpis.bounceRate) > 60) alert("warning", `High bounce rate (${out.kpis.bounceRate}%). Review titles/intros of the articles in “High bounce”.`);
    } else {
        alert("error", "Table post_views not found: reading time, engagement and traffic sources are not being recorded. Views are still counted in posts.views.");
    }

    // ---------- Dispositivos ----------
    if (f.visitors) {
        out.charts.devices = await q(`
            SELECT device AS label, COUNT(*) AS value FROM visitors
            WHERE last_seen_at >= NOW() - INTERVAL 30 DAY
            GROUP BY device ORDER BY value DESC
        `, [], [], "admin-stats");
    }

    // ---------- Recomendaciones (CTR) ----------
    if (f.impressions) {
        out.charts.ctr = await q(`
            SELECT placement AS label, COUNT(*) AS impressions, SUM(clicked) AS clicks,
                   ROUND(100 * SUM(clicked) / COUNT(*), 2) AS ctr
            FROM rec_impressions WHERE shown_at >= NOW() - INTERVAL 7 DAY
            GROUP BY placement ORDER BY impressions DESC
        `, [], [], "admin-stats");
        const imp = out.charts.ctr.reduce((a, r) => a + Number(r.impressions || 0), 0);
        const clk = out.charts.ctr.reduce((a, r) => a + Number(r.clicks || 0), 0);
        out.kpis.recCtr = imp ? +(100 * clk / imp).toFixed(2) : null;
        out.kpis.recImpressions = imp;
    } else {
        alert("info", "Table rec_impressions not found: recommendations work but their CTR cannot be measured.");
    }

    // ---------- Tendencias y temas ----------
    if (f.stats) {
        out.tables.trendingNow = await q(`
            SELECT p.id, p.title, p.slug, p.category, s.views_1h, s.views_24h, s.views_7d,
                   ROUND(s.trend_score, 3) AS trend, ROUND(s.rec_ctr * 100, 1) AS ctr
            FROM post_stats s JOIN posts p ON p.id = s.post_id
            WHERE p.published_at <= NOW()
            ORDER BY s.trend_score DESC LIMIT 10
        `, [], [], "admin-stats");
    } else {
        alert("info", "Table post_stats not found: trending uses the classic formula (views / age).");
    }

    if (f.topics) {
        out.tables.topics = await q(`
            SELECT t.slug, t.name, COUNT(DISTINCT pt.post_id) AS posts,
                   ${f.tracking ? "(SELECT COUNT(*) FROM post_views v JOIN post_topics x ON x.post_id = v.post_id WHERE x.topic_id = t.id AND v.started_at >= NOW() - INTERVAL 7 DAY)" : "0"} AS views7d
            FROM topics t JOIN post_topics pt ON pt.topic_id = t.id
            GROUP BY t.id, t.slug, t.name
            ORDER BY views7d DESC, posts DESC LIMIT 15
        `, [], [], "admin-stats");
        const [nt] = await q(`
            SELECT COUNT(*) AS n FROM posts p
            WHERE p.published_at <= NOW() AND NOT EXISTS (SELECT 1 FROM post_topics pt WHERE pt.post_id = p.id)
        `, [], [{ n: 0 }], "admin-stats");
        out.kpis.postsWithoutTopics = Number(nt && nt.n) || 0;
        if (out.kpis.postsWithoutTopics > 0) alert("info", `${out.kpis.postsWithoutTopics} published articles have no topics. Related articles fall back to category; new AI articles fill topics automatically.`);
    } else {
        alert("warning", "Tables topics/post_topics not found: related articles use category only and /topic pages are disabled.");
    }

    if (!f.similarity) alert("info", "Table post_similarity not found: related articles are calculated live (slower, still works).");
    if (!f.interests) alert("info", "Table visitor_interests not found: “For You” uses the browser history and trends instead of the server profile.");
    if (!f.postContext) alert("info", "Columns posts.evergreen/depth not found: freshness uses default values.");

    // ---------- Salud del sistema ----------
    out.health = {
        startedAt: health.startedAt,
        schemaCheckedAt: health.schemaCheckedAt,
        jobs: health.jobs,
        errors: health.errors.slice(0, 15)
    };
    for (const [name, j] of Object.entries(health.jobs)) {
        if (j && j.ok === false) alert("error", `Background job “${name}” failed: ${j.error}`);
    }
    if (health.errors.length) alert("warning", `${health.errors.length} recent errors were caught without breaking the site (see “System health”).`);

    return out;
}

module.exports = { collect };
