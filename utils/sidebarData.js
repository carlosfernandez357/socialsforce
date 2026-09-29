/**
 * Datos compartidos del sidebar público.
 *
 * Devuelve:
 *  - sidebarCategory:   categoría aleatoria con sus 5 posts más recientes
 *  - sidebarTrending:   top 4 posts por trend_score
 *  - sidebarCategories: todas las categorías publicadas (A-Z)
 *
 * Nunca lanza: ante un error devuelve una estructura vacía para
 * no romper la página que lo usa.
 */

const POST_FIELDS = "id, title, slug, image, category, excerpt, views, published_at";

const toSlug = (category) => String(category || "").toLowerCase();

async function getSidebarData(db, excludePostId = null) {

    const excludeId = excludePostId || 0;

    const empty = {
        sidebarCategory: null,
        sidebarTrending: [],
        sidebarCategories: []
    };

    try {

        const [categoryRows] = await db.query(`
            SELECT category
            FROM posts
            WHERE category IS NOT NULL
              AND category != ''
              AND published_at <= NOW()
            GROUP BY category
            ORDER BY category ASC
        `);

        const sidebarCategories = categoryRows.map(row => row.category);

        let sidebarCategory = null;

        if (sidebarCategories.length > 0) {

            const name = sidebarCategories[
                Math.floor(Math.random() * sidebarCategories.length)
            ];

            const [posts] = await db.query(`
                SELECT ${POST_FIELDS}
                FROM posts
                WHERE category = ?
                  AND id != ?
                  AND published_at <= NOW()
                ORDER BY published_at DESC
                LIMIT 5
            `, [name, excludeId]);

            sidebarCategory = {
                name,
                slug: toSlug(name),
                posts
            };
        }

        const [sidebarTrending] = await db.query(`
            SELECT ${POST_FIELDS},
                   views / POW(
                       TIMESTAMPDIFF(HOUR, published_at, NOW()) + 2,
                       1.5
                   ) AS trend_score
            FROM posts
            WHERE published_at <= NOW()
              AND id != ?
            ORDER BY trend_score DESC
            LIMIT 4
        `, [excludeId]);

        return {
            sidebarCategory,
            sidebarTrending,
            sidebarCategories
        };

    } catch (error) {

        console.error("getSidebarData error:", error);

        return empty;
    }
}

module.exports = { getSidebarData, toSlug };
