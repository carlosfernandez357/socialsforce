// Consentimiento, visitante anónimo, medición de lectura (tiempo activo + scroll),
// impresiones/clics de recomendaciones y actualización del perfil de intereses.

const crypto = require("crypto");
const { q, features, categoryId, readingMinutes, clamp, logError } = require("./safe");

const SOURCES = ["external", "direct", "home", "foryou", "related", "sidebar", "trending", "recent", "category", "search"];
const PLACEMENTS = ["foryou", "related", "sidebar", "home"];
const MAX_SECONDS = 900;
const HALF_LIFE_SEC = 7 * 24 * 3600;

// ---------- Consentimiento ----------
// Cookie sf_consent = "v1.a1.p0.m0" (analytics, personalization, marketing)
function parseConsent(raw) {
    const c = { set: false, analytics: false, personalization: false, marketing: false };
    if (!raw || typeof raw !== "string" || !raw.startsWith("v1")) return c;
    c.set = true;
    c.analytics = /\.a1/.test(raw);
    c.personalization = /\.p1/.test(raw);
    c.marketing = /\.m1/.test(raw);
    return c;
}

function consentMiddleware(req, res, next) {
    req.consent = parseConsent(req.cookies && req.cookies.sf_consent);
    res.locals.consent = req.consent;

    const vid = req.cookies && req.cookies.sf_vid;
    const validVid = typeof vid === "string" && /^[0-9a-f-]{36}$/i.test(vid);

    if (req.consent.personalization) {
        if (validVid) {
            req.visitorId = vid;
        } else if ((req.method === "GET" && !req.path.startsWith("/admin") && !req.path.includes(".")) || req.path === "/api/track") {
            req.visitorId = crypto.randomUUID();
            req.newVisitor = true;
            res.cookie("sf_vid", req.visitorId, {
                maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: "lax",
                secure: process.env.NODE_ENV === "production"
            });
        }
    } else if (vid) {
        res.clearCookie("sf_vid"); // consentimiento retirado
    }
    next();
}

async function ensureVisitor(req) {
    if (!req.visitorId || !features().visitors) return;
    const ua = String(req.headers["user-agent"] || "");
    const device = /tablet|ipad/i.test(ua) ? "tablet" : /mobi|android|iphone/i.test(ua) ? "mobile" : "desktop";
    await q(`INSERT IGNORE INTO visitors (id, device) VALUES (?, ?)`, [req.visitorId, device], null, "visitors");
}

// ---------- Anti-bots / deduplicación en memoria ----------
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|pingdom|curl|wget|python|axios/i;
const dedupe = new Map();          // hash(ip+ua+post) -> timestamp
const liveViews = new Map();       // viewId -> { postId, applied, visitorId, at }
const rate = new Map();            // ip -> { n, at }

function cleanupMaps() {
    const now = Date.now();
    for (const [k, t] of dedupe) if (now - t > 24 * 3600e3) dedupe.delete(k);
    for (const [k, v] of liveViews) if (now - v.at > 2 * 3600e3) liveViews.delete(k);
    for (const [k, v] of rate) if (now - v.at > 60e3) rate.delete(k);
}
setInterval(cleanupMaps, 10 * 60e3).unref();

function clientIp(req) {
    return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function limited(req, max = 120) {
    const ip = clientIp(req);
    const now = Date.now();
    const r = rate.get(ip) || { n: 0, at: now };
    if (now - r.at > 60e3) { r.n = 0; r.at = now; }
    r.n++;
    rate.set(ip, r);
    return r.n > max;
}

// ---------- Perfil de intereses ----------
async function applyInterest(visitorId, post, delta) {
    const f = features();
    if (!visitorId || !f.interests || !delta || !post) return;
    const rows = [];
    if (post.category) rows.push(["category", categoryId(post.category), delta]);
    if (f.topics) {
        const topics = await q(`SELECT topic_id, weight FROM post_topics WHERE post_id = ?`, [post.id], [], "interests");
        for (const t of topics) rows.push(["topic", t.topic_id, delta * clamp(Number(t.weight) || 5, 1, 10) / 10]);
    }
    if (!rows.length) return;
    const values = rows.map(() => "(?, ?, ?, ?, NOW())").join(",");
    const params = rows.flatMap(r => [visitorId, r[0], r[1], r[2]]);
    await q(`
        INSERT INTO visitor_interests (visitor_id, kind, ref_id, score, updated_at)
        VALUES ${values}
        ON DUPLICATE KEY UPDATE
            score = score * POW(0.5, GREATEST(TIMESTAMPDIFF(SECOND, updated_at, NOW()), 0) / ${HALF_LIFE_SEC}) + VALUES(score),
            updated_at = NOW()
    `, params, null, "interests");
}

function computeEngagement(activeSeconds, scrollPct, readMin) {
    const expected = Math.max(30, readMin * 60);
    return +(0.6 * Math.min(activeSeconds / expected, 1) + 0.4 * clamp(scrollPct, 0, 100) / 100).toFixed(3);
}

// ---------- Rutas ----------
function register(app) {
    const express = require("express");
    const textJson = express.text({ type: ["text/plain", "application/json"], limit: "8kb" });
    const parseBody = (req) => {
        if (req.body && typeof req.body === "object") return req.body;
        try { return JSON.parse(req.body || "{}"); } catch { return {}; }
    };

    // Inicio/actualización/fin de una lectura
    app.post("/api/track", textJson, async (req, res) => {
        try {
            if (limited(req) || BOT_RE.test(String(req.headers["user-agent"] || ""))) return res.status(204).end();
            const b = parseBody(req);
            const postId = parseInt(b.pid, 10);
            if (!postId) return res.status(204).end();

            const f = features();
            const posts = await q(`SELECT id, category, content${f.readingTimeCol ? ", reading_time" : ""} FROM posts WHERE id = ? LIMIT 1`, [postId], [], "track");
            const post = posts[0];
            if (!post) return res.status(204).end();

            const readMin = readingMinutes(post);
            const cap = Math.min(MAX_SECONDS, readMin * 60 * 2);
            const active = clamp(parseInt(b.as, 10) || 0, 0, cap);
            const scroll = clamp(parseInt(b.sp, 10) || 0, 0, 100);
            const engagement = computeEngagement(active, scroll, readMin);

            if (b.t === "start") {
                // Deduplicación 24 h (visitante o huella ip+ua, esta última solo en memoria)
                const key = crypto.createHash("sha1").update((req.visitorId || clientIp(req) + req.headers["user-agent"]) + ":" + postId).digest("hex");
                const repeated = dedupe.has(key);
                if (!repeated) {
                    dedupe.set(key, Date.now());
                    await q(`UPDATE posts SET views = views + 1 WHERE id = ?`, [postId], null, "track");
                    if (req.visitorId && f.visitors) {
                        await ensureVisitor(req);
                        await q(`UPDATE visitors SET total_views = total_views + 1, last_seen_at = NOW() WHERE id = ?`, [req.visitorId], null, "track");
                    }
                }
                let viewId = null;
                if (f.tracking) {
                    const source = SOURCES.includes(b.src) ? b.src : "direct";
                    const fromId = parseInt(b.from, 10) || null;
                    const pos = parseInt(b.pos, 10);
                    const r = await q(`
                        INSERT INTO post_views (post_id, visitor_id, started_at, active_seconds, max_scroll_pct, engagement, source, source_post_id, rec_position)
                        VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?)
                    `, [postId, req.visitorId || null, active, scroll, engagement, source, fromId, Number.isInteger(pos) ? clamp(pos, 0, 127) : null], null, "track");
                    viewId = r && r.insertId ? r.insertId : null;
                }
                if (viewId) liveViews.set(String(viewId), { postId, applied: 0, visitorId: req.visitorId || null, at: Date.now() });
                return res.json({ ok: true, vid: viewId, counted: !repeated });
            }

            // ping / end
            const viewId = parseInt(b.vid, 10);
            if (f.tracking && viewId) {
                await q(`
                    UPDATE post_views
                    SET active_seconds = GREATEST(active_seconds, ?),
                        max_scroll_pct = GREATEST(max_scroll_pct, ?),
                        engagement = GREATEST(engagement, ?)
                    WHERE id = ? AND post_id = ?
                `, [active, scroll, engagement, viewId, postId], null, "track");
            }

            // Perfil: se aplica solo el incremento de engagement (idempotente)
            const live = liveViews.get(String(viewId));
            if (req.visitorId && live && live.postId === postId) {
                let delta = Math.max(0, engagement - live.applied);
                if (delta >= 0.05 || b.t === "end") {
                    live.applied += delta;
                    // Rebote: salida con < 10 s activos penaliza ligeramente
                    if (b.t === "end" && active < 10 && !live.bounced) { delta -= 0.5; live.bounced = true; }
                    // Lectura de calidad: bonus
                    if (engagement >= 0.6 && !live.bonus) { delta += 1; live.bonus = true; }
                    if (delta) await applyInterest(req.visitorId, post, +delta.toFixed(3));
                }
                live.at = Date.now();
            }
            res.status(204).end();
        } catch (error) {
            logError("track", error);
            res.status(204).end();
        }
    });

    // Impresiones de recomendaciones (se muestran realmente en pantalla)
    app.post("/api/rec/impressions", textJson, async (req, res) => {
        try {
            if (limited(req) || !features().impressions) return res.json({ ids: [] });
            const b = parseBody(req);
            const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30)
                .map(i => ({ pid: parseInt(i.pid, 10), pl: PLACEMENTS.includes(i.pl) ? i.pl : null, pos: clamp(parseInt(i.pos, 10) || 0, 0, 127) }))
                .filter(i => i.pid && i.pl);
            if (!items.length) return res.json({ ids: [] });

            const ids = [];
            for (const i of items) {
                const r = await q(`INSERT INTO rec_impressions (visitor_id, post_id, placement, position, clicked, shown_at) VALUES (?, ?, ?, ?, 0, NOW())`,
                    [req.visitorId || null, i.pid, i.pl, i.pos], null, "impressions");
                ids.push(r && r.insertId ? r.insertId : null);
            }
            res.json({ ids });
        } catch (error) {
            logError("impressions", error);
            res.json({ ids: [] });
        }
    });

    app.post("/api/rec/click", textJson, async (req, res) => {
        const b = parseBody(req);
        const id = parseInt(b.id, 10);
        if (id && features().impressions) {
            await q(`UPDATE rec_impressions SET clicked = 1 WHERE id = ?`, [id], null, "impressions");
        }
        res.status(204).end();
    });

    // Borrar datos del visitante (derecho de supresión desde la página de cookies)
    app.post("/api/privacy/forget", async (req, res) => {
        const vid = req.cookies && req.cookies.sf_vid;
        if (vid && /^[0-9a-f-]{36}$/i.test(vid)) {
            const f = features();
            if (f.interests) await q(`DELETE FROM visitor_interests WHERE visitor_id = ?`, [vid], null, "privacy");
            if (f.tracking) await q(`UPDATE post_views SET visitor_id = NULL WHERE visitor_id = ?`, [vid], null, "privacy");
            if (f.impressions) await q(`UPDATE rec_impressions SET visitor_id = NULL WHERE visitor_id = ?`, [vid], null, "privacy");
            if (f.visitors) await q(`DELETE FROM visitors WHERE id = ?`, [vid], null, "privacy");
        }
        res.clearCookie("sf_vid");
        res.json({ ok: true });
    });
}

module.exports = { consentMiddleware, ensureVisitor, register, parseConsent };
