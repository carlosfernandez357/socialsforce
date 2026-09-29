// Utilidades de resiliencia: consultas que nunca rompen la página,
// detección del esquema real de la BD y registro de errores para el admin.

const db = require("../db");

const health = {
    startedAt: new Date(),
    errors: [],          // últimos errores (ring buffer)
    jobs: {},            // estado de tareas periódicas
    schemaCheckedAt: null
};

function logError(area, error) {
    const msg = (error && error.message) ? error.message : String(error);
    console.error(`[${area}]`, msg);
    health.errors.unshift({ area, message: msg.slice(0, 300), at: new Date() });
    if (health.errors.length > 50) health.errors.length = 50;
}

// Ejecuta una consulta; si falla devuelve `fallback` y registra el error.
async function q(sql, params = [], fallback = [], area = "db") {
    try {
        const [rows] = await db.query(sql, params);
        return rows;
    } catch (error) {
        logError(area, error);
        return fallback;
    }
}

// ---------- Detección de esquema ----------
const schema = { tables: new Set(), columns: {} };

async function refreshSchema() {
    try {
        const [rows] = await db.query(`
            SELECT TABLE_NAME AS t, COLUMN_NAME AS c
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
        `);
        const tables = new Set();
        const columns = {};
        for (const r of rows) {
            const t = String(r.t).toLowerCase();
            tables.add(t);
            (columns[t] = columns[t] || new Set()).add(String(r.c).toLowerCase());
        }
        schema.tables = tables;
        schema.columns = columns;
        health.schemaCheckedAt = new Date();
    } catch (error) {
        logError("schema", error);
    }
}

const has = (table) => schema.tables.has(table);
const hasCol = (table, col) => !!(schema.columns[table] && schema.columns[table].has(col));

// Estado de las funcionalidades según las tablas disponibles
function features() {
    return {
        tracking: has("post_views"),
        visitors: has("visitors"),
        interests: has("visitor_interests"),
        impressions: has("rec_impressions"),
        topics: has("topics") && has("post_topics"),
        stats: has("post_stats"),
        similarity: has("post_similarity"),
        postContext: hasCol("posts", "evergreen") && hasCol("posts", "depth"),
        readingTimeCol: hasCol("posts", "reading_time")
    };
}

// ---------- Helpers varios ----------
// Hash estable de categoría -> INT positivo (no existe tabla categories)
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function categoryId(name) {
    const s = Buffer.from(String(name || "").trim().toLowerCase(), "utf8");
    let crc = -1;
    for (const b of s) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return ((crc ^ -1) >>> 0) & 0x7FFFFFFF; // igual que CRC32(LOWER(x)) & 0x7FFFFFFF en MySQL
}

function slugify(text) {
    return String(text || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function readingMinutes(post) {
    if (post && post.reading_time) return Number(post.reading_time);
    const words = String((post && post.content) || "").replace(/<[^>]*>/g, " ").trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.ceil(words / 200));
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

module.exports = { db, q, health, logError, schema, refreshSchema, has, hasCol, features, categoryId, slugify, readingMinutes, clamp };
