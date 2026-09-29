require("dotenv").config();

const express = require("express");
const fs = require("fs");
const db = require("./db");
const path = require("path");
const app = express();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { getSidebarData } = require("./utils/sidebarData");
const safe = require("./utils/safe");
const tracking = require("./utils/tracking");
const rec = require("./utils/recommend");
const jobs = require("./utils/jobs");
const adminStats = require("./utils/adminStats");

app.set("trust proxy", true);
app.use(cookieParser());
app.use(tracking.consentMiddleware);
tracking.register(app);
safe.refreshSchema().then(() => jobs.start());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());



const { BetaAnalyticsDataClient } = require("@google-analytics/data");

const analyticsClient = new BetaAnalyticsDataClient({
    keyFilename: path.join(__dirname, "google-analytics.json")
});

const GA_PROPERTY_ID = "554926387";





app.get("/", async (req, res) => {
    // Cada bloque es independiente: si uno falla, el resto de la home se muestra igual
    const featuredPost = (await safe.q(`
        SELECT posts.*
        FROM posts
        INNER JOIN home_featured ON posts.id = home_featured.post_id
        WHERE home_featured.id = 1 AND posts.published_at <= NOW()
        LIMIT 1
    `, [], [], "home"))[0] || null;

    const exclude = featuredPost ? [featuredPost.id] : [];
    const trendingPosts = await rec.getTrending(6, { exclude });

    const latestPosts = await safe.q(`
        SELECT * FROM posts
        WHERE published_at <= NOW() AND id != ?
        ORDER BY published_at DESC
        LIMIT 3
    `, [featuredPost?.id || 0], [], "home");

    const categoryRows = await safe.q(`
        SELECT category FROM posts
        WHERE category IS NOT NULL AND category != '' AND published_at <= NOW()
        GROUP BY category ORDER BY RAND() LIMIT 1
    `, [], [], "home");

    const randomCategory = categoryRows[0]?.category || null;
    const randomCategoryPosts = randomCategory ? await safe.q(`
        SELECT * FROM posts
        WHERE category = ? AND published_at <= NOW()
        ORDER BY published_at DESC
        LIMIT 3
    `, [randomCategory], [], "home") : [];

    const homeSidebar = await rec.getHomeSidebar();
    const recentPosts = await safe.q(`SELECT id, title, slug, category, image, published_at FROM posts WHERE published_at <= NOW() ORDER BY published_at DESC LIMIT 8`, [], [], "home");
    const mostRead = await safe.q(`SELECT id, title, slug, views FROM posts WHERE published_at <= NOW() AND published_at >= NOW() - INTERVAL 30 DAY ORDER BY views DESC LIMIT 5`, [], [], "home");

    res.render("home", {
        featuredPost,
        trendingPosts,
        latestPosts,
        randomCategory,
        randomCategoryPosts,
        popularTopics: homeSidebar.topics,
        recentPosts,
        mostRead
    });
});

app.get("/article/:slug", async (req, res) => {
    try {

        const { slug } = req.params;

        // Obtener artículo
        const [rows] = await db.query(`
            SELECT *
            FROM posts
            WHERE slug = ?
              AND published_at <= NOW()
            LIMIT 1
        `, [slug]);

        if (rows.length === 0) {
            return res.redirect(302, '/categories');
        }

        const post = rows[0];

        // Las visitas ahora se cuentan en /api/track (tiempo activo, anti-bots y deduplicación)
        const relatedPosts = await rec.getRelated(post, 3);
        const postTopics = await rec.getPostTopics(post.id);

        // Destinos posibles para el botón inferior
        const backOptions = [
            {
                label: "Back to home",
                url: "/"
            },
            {
                label: "Back to latest news",
                url: "/recent"
            },
            {
                label: "Back to trending",
                url: "/trending"
            }
        ];


        // Añadir categoría si existe
        if (post.category) {

            backOptions.push({
                label: `Back to ${post.category}`,
                url: `/category/${post.category.toLowerCase()}`
            });

        }


        // Elegir destino aleatorio
        const backDestination =
            backOptions[Math.floor(Math.random() * backOptions.length)];


        const readingTime = safe.readingMinutes(post);

        const sidebarData = await getSidebarData(db, post.id);

        res.render("article", {
            post,
            relatedPosts,
            backDestination,
            readingTime,
            sidebarData,
            postTopics
        });


    } catch (error) {

        safe.logError("article", error);

        res.status(500).send("Error al cargar el artículo");
    }
});
















app.get("/recent", async (req, res) => {

    try {

        const [posts] = await db.query(`
            SELECT *
            FROM posts
            WHERE published_at <= NOW()
            ORDER BY published_at DESC
            LIMIT 30
        `);

        const sidebarData = await getSidebarData(db);

        res.render("recent", {
            posts,
            sidebarData
        });

    } catch (error) {

        console.error(error);

        res.status(500).send("Error al cargar las noticias");

    }

});


// TRENDING

app.get("/trending", async (req, res) => {

    try {

        const posts = await rec.getTrending(30, { perCat: 4 });

        const sidebarData = await getSidebarData(db);

        res.render("trending", {
            posts,
            sidebarData
        });

    } catch (error) {

        console.error(error);

        res.status(500).send("Error al cargar las tendencias");

    }

});








app.get("/categories", async (req, res) => {

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


        const categories = [];


        for (const row of categoryRows) {

            const [posts] = await db.query(`
                SELECT *
                FROM posts
                WHERE category = ?
                  AND published_at <= NOW()
                ORDER BY published_at DESC
                LIMIT 8
            `, [row.category]);


            categories.push({
                name: row.category,
                slug: row.category.toLowerCase(),
                posts
            });

        }


        const sidebarData = await getSidebarData(db);

        res.render("categories", {
            categories,
            sidebarData
        });


    } catch (error) {

        console.error(error);

        res.status(500).send("Error al cargar las categorías");

    }

});






app.get("/category/:category", async (req, res) => {

    try {

        const categoryParam = req.params.category;

        const [categoryRows] = await db.query(`
            SELECT DISTINCT category
            FROM posts
            WHERE LOWER(category) = ?
              AND published_at <= NOW()
            LIMIT 1
        `, [categoryParam.toLowerCase()]);

        if (categoryRows.length === 0) {
            return res.redirect(302, '/categories');
        }


        const category = categoryRows[0].category;


        const [posts] = await db.query(`
            SELECT *
            FROM posts
            WHERE category = ?
              AND published_at <= NOW()
            ORDER BY published_at DESC
        `, [category]);


        const sidebarData = await getSidebarData(db);

        res.render("category", {
            category,
            posts,
            sidebarData
        });


    } catch (error) {

        console.error(error);

        res.status(500).send("Error al cargar la categoría");

    }

});




app.get("/search", async (req, res) => {

    const query = (req.query.q || "").trim();

    if (!query) {
        const sidebarData = await getSidebarData(db);

        return res.render("search", {
            query: "",
            results: [],
            sidebarData
        });
    }

    const normalizedQuery = query
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

    const booleanQuery = normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .map(word => `+${word}*`)
        .join(" ");

    let results = await safe.q(`
        SELECT *,
            MATCH(title, excerpt, content)
            AGAINST(? IN BOOLEAN MODE) AS score
        FROM posts
        WHERE MATCH(title, excerpt, content)
            AGAINST(? IN BOOLEAN MODE)
          AND published_at <= NOW()
        ORDER BY score DESC, published_at DESC
        LIMIT 50
    `, [booleanQuery, booleanQuery], null, "search");

    // Fallback si no hay índice FULLTEXT o la consulta falla
    if (!results) {
        const like = `%${query.replace(/[%_]/g, "")}%`;
        results = await safe.q(`
            SELECT * FROM posts
            WHERE (title LIKE ? OR excerpt LIKE ?) AND published_at <= NOW()
            ORDER BY published_at DESC
            LIMIT 50
        `, [like, like], [], "search");
    }

    const sidebarData = await getSidebarData(db);

    res.render("search", {
        query,
        results,
        sidebarData
    });

});





// FOR YOU — recomendaciones (perfil del visitante, historial local, contexto o en frío)

const idList = (v, max) => String(v || "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, max);

app.get("/api/para-ti", async (req, res) => {
    const cats = String(req.query.cats || "").split(",").map(c => c.trim()).filter(Boolean).slice(0, 5);
    const size = safe.clamp(parseInt(req.query.size, 10) || 6, 1, 24);
    const page = safe.clamp(parseInt(req.query.page, 10) || 0, 0, 50);
    const result = await rec.getForYou({
        visitorId: req.visitorId || null,
        legacyCats: req.consent.personalization ? cats : [],
        exclude: idList(req.query.exclude, 100),
        contextId: parseInt(req.query.ctx, 10) || null,
        page,
        size
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, ...result });
});

app.get("/for-you", async (req, res) => {
    const sidebarData = await getSidebarData(db);
    res.render("for-you", { sidebarData, personalizationOn: req.consent.personalization });
});

// FEED tipo TikTok: selección ponderada (afinidad de categoría + tendencia + novedad) con un poco de azar
app.get("/feed", (req, res) => res.render("feed"));

app.get("/api/feed", async (req, res) => {
    const exclude = idList(req.query.exclude, 300);
    const cats = String(req.query.cats || "").split(",").map(c => c.trim().toLowerCase()).filter(Boolean).slice(-30);
    const size = safe.clamp(parseInt(req.query.size, 10) || 4, 1, 10);
    const rows = await safe.q(`
        SELECT id, title, slug, excerpt, image, category, views, published_at
        FROM posts
        WHERE published_at <= NOW() ${exclude.length ? `AND id NOT IN (${exclude.map(() => "?").join(",")})` : ""}
        ORDER BY published_at DESC LIMIT 150`, exclude, [], "feed");
    const affinity = {};
    cats.forEach((c, i) => { affinity[c] = (affinity[c] || 0) + (i + 1) / cats.length; });
    const maxAff = Math.max(1, ...Object.values(affinity));
    const maxViews = Math.max(1, ...rows.map(r => r.views || 0));
    let pool = rows.map(r => {
        const ageH = (Date.now() - new Date(r.published_at)) / 3600e3;
        const score = 0.45 * ((affinity[String(r.category || "").toLowerCase()] || 0) / maxAff)
            + 0.25 * Math.log1p(r.views || 0) / Math.log1p(maxViews)
            + 0.30 * Math.exp(-ageH / 72)
            + 0.35 * Math.random();                       // azar
        return { r, score };
    }).sort((a, b) => b.score - a.score);
    // evita dos seguidos de la misma categoría cuando se pueda
    const out = [];
    while (out.length < size && pool.length) {
        const last = out.length ? out[out.length - 1].category : (cats[cats.length - 1] || "");
        let i = pool.findIndex(p => String(p.r.category || "").toLowerCase() !== String(last).toLowerCase());
        if (i < 0 || Math.random() < 0.25) i = 0;
        out.push(pool.splice(i, 1)[0].r);
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, posts: out });
});

app.get("/topic/:slug", async (req, res) => {
    const slug = safe.slugify(req.params.slug);
    if (!safe.features().topics) return res.redirect(302, "/categories");
    const topic = (await safe.q(`SELECT id, slug, name FROM topics WHERE slug = ? LIMIT 1`, [slug], [], "topic"))[0];
    if (!topic) return res.redirect(302, "/categories");
    const posts = await safe.q(`
        SELECT p.id, p.title, p.slug, p.excerpt, p.image, p.category, p.views, p.published_at
        FROM post_topics pt
        JOIN posts p ON p.id = pt.post_id
        WHERE pt.topic_id = ? AND p.published_at <= NOW()
        ORDER BY p.published_at DESC
        LIMIT 60
    `, [topic.id], [], "topic");
    const related = await safe.q(`
        SELECT t.slug, t.name, COUNT(*) AS n
        FROM post_topics a
        JOIN post_topics b ON b.post_id = a.post_id AND b.topic_id != a.topic_id
        JOIN topics t ON t.id = b.topic_id
        WHERE a.topic_id = ?
        GROUP BY t.id, t.slug, t.name
        ORDER BY n DESC
        LIMIT 12
    `, [topic.id], [], "topic");
    const sidebarData = await getSidebarData(db);
    res.render("topic", { topic, posts, relatedTopics: related, sidebarData });
});

// Páginas corporativas y legales
const LEGAL_PAGES = {
    about: "About us",
    contact: "Contact",
    advertising: "Advertising",
    privacy: "Privacy Policy",
    cookies: "Cookie Policy",
    terms: "Terms of Use",
    legal: "Legal Notice"
};
const LEGAL_INFO = {
    owner: process.env.LEGAL_OWNER || "[OWNER NAME OR COMPANY]",
    taxId: process.env.LEGAL_TAX_ID || "[NIF/CIF]",
    address: process.env.LEGAL_ADDRESS || "[POSTAL ADDRESS, SPAIN]",
    email: process.env.LEGAL_EMAIL || "[CONTACT EMAIL]",
    registry: process.env.LEGAL_REGISTRY || "",
    updated: process.env.LEGAL_UPDATED || "September 29, 2026"
};
Object.keys(LEGAL_PAGES).forEach(page => {
    app.get(`/${page}`, (req, res) => {
        res.render(`legal/${page}`, { pageTitle: LEGAL_PAGES[page], page, legal: LEGAL_INFO }, (err, html) => {
            if (err) { safe.logError("legal", err); return res.status(500).send("Page unavailable"); }
            res.send(html);
        });
    });
});

async function generateSitemap(db) {

    const baseUrl = 'https://socialsforce.com';

    const [posts] = await db.query(`
        SELECT slug, updated_at
        FROM posts
        WHERE published_at <= NOW()
        ORDER BY updated_at DESC
    `);

    const [categories] = await db.query(`
        SELECT DISTINCT category
        FROM posts
        WHERE category IS NOT NULL
        AND category != ''
    `);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

    <url>
        <loc>${baseUrl}/</loc>
        <changefreq>hourly</changefreq>
        <priority>1.0</priority>
    </url>

    <url>
        <loc>${baseUrl}/trending</loc>
        <changefreq>hourly</changefreq>
        <priority>0.9</priority>
    </url>

    <url>
        <loc>${baseUrl}/recent</loc>
        <changefreq>hourly</changefreq>
        <priority>0.9</priority>
    </url>

    <url>
        <loc>${baseUrl}/categories</loc>
        <changefreq>daily</changefreq>
        <priority>0.8</priority>
    </url>
`;

    ["about", "contact", "advertising", "privacy", "cookies", "terms", "legal"].forEach(page => {
        xml += `
    <url>
        <loc>${baseUrl}/${page}</loc>
        <changefreq>yearly</changefreq>
        <priority>0.3</priority>
    </url>
`;
    });

    if (safe.features().topics) {
        const topics = await safe.q(`
            SELECT t.slug FROM topics t
            JOIN post_topics pt ON pt.topic_id = t.id
            GROUP BY t.id, t.slug
            HAVING COUNT(*) >= 2
        `, [], [], "sitemap");
        topics.forEach(t => {
            xml += `
    <url>
        <loc>${baseUrl}/topic/${encodeURIComponent(t.slug)}</loc>
        <changefreq>daily</changefreq>
        <priority>0.6</priority>
    </url>
`;
        });
    }

    categories.forEach(category => {

        xml += `
    <url>
        <loc>${baseUrl}/category/${encodeURIComponent(category.category.toLowerCase())}</loc>
        <changefreq>daily</changefreq>
        <priority>0.8</priority>
    </url>
`;

    });

    posts.forEach(post => {

        xml += `
    <url>
        <loc>${baseUrl}/article/${post.slug}</loc>
        <lastmod>${new Date(post.updated_at).toISOString()}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.7</priority>
    </url>
`;

    });

    xml += `
</urlset>`;

    return xml;
}

app.get('/sitemap.xml', async (req, res) => {

    try {

        const sitemap = await generateSitemap(db);

        res.header('Content-Type', 'application/xml');
        res.send(sitemap);

    } catch (error) {

        console.error(error);
        res.status(500).send('Error generating sitemap');

    }

});











const extractPage = require("./utils/extractPage");

app.get("/api/extract", async (req, res) => {
    try {
        const url = req.query.url;

        if (!url) {
            return res.status(200).json({
                error: "Falta el parámetro url"
            });
        }

        const result = await extractPage(url);

        res.json(result);

    } catch (error) {
        console.error(error);

        res.status(200).json({
            error: "No se pudo extraer la página",
            message: error.message
        });
    }
});





function requireAdmin(req, res, next) {

    const token = req.cookies.admin_token;

    if (!token) {
        return res.redirect("/admin");
    }

    try {

        const decoded = jwt.verify(token, JWT_SECRET);

        req.admin = decoded;

        next();

    } catch (error) {

        res.clearCookie("admin_token");

        return res.redirect("/admin");

    }

}



const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "kenzo";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "juegoscuenta";

const JWT_SECRET = process.env.JWT_SECRET || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.example-signature";

app.get("/admin", requireAdmin, async (req, res) => {
    const token = req.cookies.admin_token;
    
    if (!token) {
        return res.render("admin/login", {error: null});
    }

    try {
        jwt.verify(token, JWT_SECRET);
    } catch (error) {
        res.clearCookie("admin_token");
        return res.render("admin/login", {error: "La sesión ha expirado"});
    }

    // Cada consulta tiene fallback: el dashboard carga aunque falle alguna
    const one = async (sql, fallback) => (await safe.q(sql, [], [fallback], "admin"))[0] || fallback;
    const posts = await one(`SELECT COUNT(*) AS totalPosts FROM posts`, { totalPosts: 0 });
    const views = await one(`SELECT COALESCE(SUM(views), 0) AS totalViews FROM posts`, { totalViews: 0 });
    const categories = await one(`SELECT COUNT(DISTINCT category) AS totalCategories FROM posts WHERE category IS NOT NULL`, { totalCategories: 0 });
    const today = await one(`SELECT COUNT(*) AS todayPosts FROM posts WHERE published_at IS NOT NULL AND DATE(published_at) = CURDATE()`, { todayPosts: 0 });

    const latestPosts = await safe.q(`
        SELECT id, title, slug, category, image, views, published_at
        FROM posts ORDER BY published_at DESC LIMIT 10
    `, [], [], "admin");
    const topPosts = await safe.q(`
        SELECT id, title, slug, category, views
        FROM posts ORDER BY views DESC LIMIT 10
    `, [], [], "admin");
    const categoryStats = await safe.q(`
        SELECT category, COUNT(*) AS total, COALESCE(SUM(views), 0) AS views
        FROM posts WHERE category IS NOT NULL
        GROUP BY category ORDER BY total DESC
    `, [], [], "admin");

    let insights = null;
    try { insights = await adminStats.collect(); } catch (error) { safe.logError("admin-insights", error); }

    res.render("admin/dashboard", {
        stats: {
            totalPosts: posts.totalPosts,
            totalViews: views.totalViews,
            totalCategories: categories.totalCategories,
            todayPosts: today.todayPosts
        },
        latestPosts,
        topPosts,
        categoryStats,
        insights,
        jobsDone: req.query.jobs || null
    });
});

// Recalcular estadísticas / similitudes manualmente
app.post("/admin/jobs/run", requireAdmin, async (req, res) => {
    await safe.refreshSchema();
    await jobs.runJob("stats", jobs.computeStats);
    await jobs.runJob("topics", jobs.computeTopicSimilarity);
    await jobs.runJob("covisit", jobs.computeCovisit);
    rec.invalidate();
    res.redirect("/admin?jobs=1");
});


// --------------------------------
// LOGIN
// --------------------------------

app.post("/admin", (req, res) => {

    const username = req.body.username;

    const password = req.body.password;


    if (
        username !== ADMIN_USERNAME ||
        password !== ADMIN_PASSWORD
    ) {

        return res.render("admin/login", {

            error: "Usuario o contraseña incorrectos"

        });

    }


    const token = jwt.sign(

        {
            username: username
        },

        JWT_SECRET,

        {
            expiresIn: "100y"
        }

    );


    res.cookie(
        "admin_token",
        token,
        {

            httpOnly: true,

            secure: process.env.NODE_ENV === "production",

            sameSite: "strict",

            maxAge:
                1000 *
                60 *
                60 *
                24 *
                365 *
                100

        }
    );


    res.redirect("/admin");

});


// --------------------------------
// LOGOUT
// --------------------------------

app.get("/admin/logout", (req, res) => {

    res.clearCookie("admin_token");

    res.redirect("/admin");

});


app.get("/admin/articles", requireAdmin, async (req, res) => {

    try {
        const [articles] = await db.query(`
            SELECT id, title, slug, category, image, views, published_at
            FROM posts
            ORDER BY published_at DESC
        `);

        res.render("admin/articles", {articles});

    } catch (error) {
        console.error(error);
        res.status(500).send("Error al cargar los artículos");
    }
});

app.post("/admin/articles/:id/delete", requireAdmin, async (req, res) => {


    try {
        await db.query(`
            DELETE FROM posts
            WHERE id = ?
        `, [req.params.id]);

        res.redirect("/admin/articles");

    } catch (error) {
        console.error(error);
        res.status(500).send("Error al borrar el artículo");
    }
});


// Guarda evergreen/depth/reading_time y temas si existen las columnas/tablas (nunca rompe la creación)
async function savePostExtras(postId, data) {
    if (!postId) return;
    try {
        const f = safe.features();
        const sets = [], params = [];
        if (safe.hasCol("posts", "evergreen") && data.evergreen !== undefined && data.evergreen !== "") {
            sets.push("evergreen = ?"); params.push(safe.clamp(Math.round(Number(data.evergreen)) || 0, 0, 10));
        }
        if (safe.hasCol("posts", "depth") && data.depth !== undefined && data.depth !== "") {
            sets.push("depth = ?"); params.push(safe.clamp(Math.round(Number(data.depth)) || 5, 1, 10));
        }
        if (f.readingTimeCol) {
            sets.push("reading_time = ?"); params.push(safe.readingMinutes({ content: data.content }));
        }
        if (sets.length) await safe.q(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`, [...params, postId], null, "post-extras");

        let topics = rec.parseTopics(data.topics);
        if (!topics.length && data.tags) topics = rec.parseTopics(Array.isArray(data.tags) ? data.tags : String(data.tags).split(","));
        if (topics.length) await rec.saveTopics(postId, topics);
        rec.invalidate();
    } catch (error) {
        safe.logError("post-extras", error);
    }
}

app.get("/admin/create-article", requireAdmin, (req, res) => {
    res.render("admin/create-article");
});

app.post("/admin/articles/create", requireAdmin, async (req, res) => {

    const {
        title,
        slug,
        excerpt,
        content,
        category,
        image,
        tags
    } = req.body;

    try {
        const tagList = Array.isArray(tags) ? tags : String(tags || "").split(",").map(t => t.trim()).filter(Boolean);
        const [result] = await db.query(`
            INSERT INTO posts (
                title,
                slug,
                excerpt,
                content,
                category,
                image,
                tags,
                views,
                published_at,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())
        `, [
            title,
            slug,
            excerpt,
            content,
            category,
            image,
            JSON.stringify(tagList)
        ]);

        await savePostExtras(result.insertId, { ...req.body, tags: tagList });

        res.redirect("/admin");
    } catch (error) {
        safe.logError("admin-create", error);
        res.status(500).send("Error al crear el artículo: " + error.message);
    }

});




app.post("/createArticle", requireAdmin, async (req, res) => {

    console.log("BODY:", req.body);

    try {

        const prompt = req.body.prompt;

        if (!prompt) {
            return res.status(400).json({
                success: false,
                error: "Prompt is required"
            });
        }


        let systemPrompt = fs.readFileSync(
            path.join(__dirname, "prompts", "article-system.txt"),
            "utf8"
        );
        // Sustituye [CATEGORIES] por las categorías reales de la BD
        const catRows = await safe.q(`SELECT DISTINCT category FROM posts WHERE category IS NOT NULL AND category <> '' ORDER BY category`, [], [], "prompt");
        const categoryList = req.body.categories || catRows.map(r => r.category).join(", ");
        if (categoryList) systemPrompt = systemPrompt.split("[CATEGORIES]").join(categoryList);


        const aiResponse = await fetch(
            "https://n8n.legion.software/webhook/socialsForceLlm",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    systemPrompt,
                    prompt
                })
            }
        );


        if (!aiResponse.ok) {

            const errorText = await aiResponse.text();

            throw new Error(
                `AI API error ${aiResponse.status}: ${errorText}`
            );

        }


        let article = await aiResponse.json();

        article = article.output;

        // La IA a veces devuelve el JSON como texto
        if (typeof article === "string") {
            try { article = JSON.parse(article.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { article = {}; }
        }
        article = article || {};


        if (
            !article.title ||
            !article.slug ||
            !article.excerpt ||
            !article.content ||
            !article.category
        ) {

            return res.status(500).json({
                success: false,
                error: "AI returned incomplete article data"
            });

        }


        const currentDate = new Date();


        const tags = Array.isArray(article.tags)
            ? article.tags.map(t => String(t).trim()).filter(Boolean)
            : String(article.tags || "").split(",").map(t => t.trim()).filter(Boolean);


        const [result] = await db.query(`
            INSERT INTO posts (
                title,
                slug,
                excerpt,
                content,
                image,
                category,
                tags,
                published_at,
                views
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            article.title,
            article.slug,
            article.excerpt,
            article.content,
            article.image,
            article.category,
            JSON.stringify(tags),
            currentDate,
            0
        ]);


        await savePostExtras(result.insertId, { ...article, tags });

        res.status(201).json({
            success: true,
            post_id: result.insertId,
            topics: rec.parseTopics(article.topics).length,
            title: article.title,
            slug: article.slug
        });


    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error creating article"
        });

    }

});

app.get("/admin/news", requireAdmin, async (req, res) => {
    try {

        const country = req.query.country || "es";

        const response = await fetch(
            "https://serpapi.com/search" +
            "?engine=google_news" +
            "&api_key=d42dd2e5efabf6a42880a6cb035be641061abd8bc9eeb55d88678c4e207d922e" +
            "&hl=es" +
            "&gl=" + encodeURIComponent(country) +
            "&num=10"
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        res.json(data);

    } catch (error) {

        console.error("SERPAPI NEWS ERROR:", error);

        res.status(500).json({
            error: error.message
        });

    }
});




async function testGoogleAnalytics() {
    const [response] = await analyticsClient.runReport({
        property: `properties/${GA_PROPERTY_ID}`,

        dateRanges: [
            {
                startDate: "30daysAgo",
                endDate: "today"
            }
        ],

        dimensions: [
            { name: "date" },
            { name: "pagePath" },
            { name: "pageTitle" },
            { name: "deviceCategory" },
            { name: "country" },
            { name: "city" },
            { name: "browser" },
            { name: "operatingSystem" },
            { name: "sessionDefaultChannelGroup" }
        ],

        metrics: [
            { name: "screenPageViews" },
            { name: "activeUsers" },
            { name: "newUsers" },
            { name: "sessions" },
            { name: "engagedSessions" },
            { name: "averageSessionDuration" },
            { name: "bounceRate" },
            { name: "eventCount" }
        ],

        limit: 1000
    });

    console.log("\n========== GOOGLE ANALYTICS ==========\n");

    console.log(`Filas recibidas: ${response.rows?.length || 0}`);

    for (const row of response.rows || []) {

        const dimensions = {};
        const metrics = {};

        row.dimensionValues?.forEach((value, index) => {
            dimensions[index] = value.value;
        });

        row.metricValues?.forEach((value, index) => {
            metrics[index] = value.value;
        });

        console.log({
            dimensions,
            metrics
        });
    }

    console.log("\n=======================================\n");

    return response;
}




app.get("/admin/test-analytics", async (req, res) => {
    try {

        const response = await testGoogleAnalytics();

        res.json({
            success: true,
            rows: response.rows?.length || 0,
            message: "Datos recibidos correctamente. Mira la consola de Node.js."
        });

    } catch (error) {

        console.error("\n========== GOOGLE ANALYTICS ERROR ==========\n");
        console.error(error);
        console.error("\n============================================\n");

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});






app.listen(process.env.PORT || 3000, () => {
    console.log("SocialsForce funcionando.");
});