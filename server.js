const express = require("express");
const fs = require("fs");
const db = require("./db");
const path = require("path");
const app = express();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());









app.get("/", async (req, res) => {
    try {


        const [featuredRows] = await db.query(`
            SELECT posts.*
            FROM posts
            INNER JOIN home_featured
                ON posts.id = home_featured.post_id
            WHERE home_featured.id = 1
            AND posts.published_at <= NOW()
            LIMIT 1
        `);

        const featuredPost = featuredRows[0] || null;


        const [trendingPosts] = await db.query(`
            SELECT *
            FROM posts
            WHERE published_at <= NOW()
            ORDER BY views DESC
            LIMIT 6
        `);

        const [latestPosts] = await db.query(`
            SELECT *
            FROM posts
            WHERE published_at <= NOW()
            AND id != ?
            ORDER BY published_at DESC
            LIMIT 3
        `, [featuredPost?.id || 0]);



        const [randomCategoryRows] = await db.query(`
            SELECT category
            FROM posts
            WHERE category IS NOT NULL
            AND category != ''
            AND published_at <= NOW()
            GROUP BY category
            ORDER BY RAND()
            LIMIT 1
        `);

        let randomCategory = null;
        let randomCategoryPosts = [];

        if (randomCategoryRows.length > 0) {

            randomCategory = randomCategoryRows[0].category;

            const [categoryPosts] = await db.query(`
                SELECT *
                FROM posts
                WHERE category = ?
                AND published_at <= NOW()
                ORDER BY published_at DESC
                LIMIT 3
            `, [randomCategory]);

            randomCategoryPosts = categoryPosts;
        }

        res.render("home", {
            featuredPost,
            trendingPosts,
            latestPosts,
            randomCategory,
            randomCategoryPosts
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error al cargar los posts");
    }
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
            return res.status(404).send("Article not found");
        }

        const post = rows[0];


        // Incrementar visitas
        await db.query(`
            UPDATE posts
            SET views = views + 1
            WHERE id = ?
        `, [post.id]);

        post.views += 1;


        // Contenido relacionado
        const [relatedPosts] = await db.query(`
            SELECT *
            FROM posts
            WHERE category = ?
              AND id != ?
              AND published_at <= NOW()
            ORDER BY RAND()
            LIMIT 3
        `, [post.category, post.id]);


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


        res.render("article", {
            post,
            relatedPosts,
            backDestination
        });


        
    } catch (error) {

        console.error(error);

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
        `);

        res.render("recent", {
            posts
        });

    } catch (error) {

        console.error(error);

        res.status(500).send("Error al cargar las noticias");

    }

});


// TRENDING

app.get("/trending", async (req, res) => {

    try {

        const [posts] = await db.query(`
            SELECT *
            FROM posts
            WHERE published_at <= NOW()
            ORDER BY views DESC
        `);

        res.render("trending", {
            posts
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


        res.render("categories", {
            categories
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

            return res.status(404).send("Category not found");

        }


        const category = categoryRows[0].category;


        const [posts] = await db.query(`
            SELECT *
            FROM posts
            WHERE category = ?
              AND published_at <= NOW()
            ORDER BY published_at DESC
        `, [category]);


        res.render("category", {
            category,
            posts
        });


    } catch (error) {

        console.error(error);

        res.status(500).send("Error al cargar la categoría");

    }

});




app.get("/search", async (req, res) => {

    const query = (req.query.q || "").trim();

    if (!query) {
        return res.render("search", {
            query: "",
            results: []
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

    const [results] = await db.query(`
        SELECT *,
            MATCH(title, excerpt, content)
            AGAINST(? IN BOOLEAN MODE) AS score
        FROM posts
        WHERE MATCH(title, excerpt, content)
            AGAINST(? IN BOOLEAN MODE)
        ORDER BY score DESC, created_at DESC
        LIMIT 50
    `, [
        booleanQuery,
        booleanQuery
    ]);

    res.render("search", {
        query,
        results
    });

});





async function generateSitemap(db) {

    const baseUrl = 'https://socialsforce.com';

    const [posts] = await db.query(`
        SELECT slug, updated_at
        FROM posts
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






app.post("/createArticle", async (req, res) => {
    console.log("BODY:", req.body);
    try {

        const prompt = req.body.prompt;
        if (!prompt) {
            return res.status(400).json({
                success: false,
                error: "Prompt is required"
            });
        }

        const systemPrompt = fs.readFileSync(
            path.join(__dirname, "prompts", "article-system.txt"),
            "utf8"
        );

        const aiResponse = await fetch("https://n8n.legion.software/webhook/socialsForceLlm", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                systemPrompt,
                prompt
            })

        });

        if (!aiResponse.ok) {

            const errorText = await aiResponse.text();

            throw new Error(
                `AI API error ${aiResponse.status}: ${errorText}`
            );
        }

        let article = await aiResponse.json();
        article = article.output;
        console.log(article)
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

        const randomImageText = "images/ai/1.jpg"

        const currentDate = new Date();

        const [result] = await db.query(`
            INSERT INTO posts (
                title,
                slug,
                excerpt,
                content,
                image,
                category,
                published_at,
                views
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            article.title,
            article.slug,
            article.excerpt,
            article.content,
            article.image,
            article.category,
            currentDate,
            0
        ]);

        res.status(201).json({
            success: true,
            post_id: result.insertId,
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



const ADMIN_USERNAME = "kenzo";

const ADMIN_PASSWORD = "juegoscuenta";

const JWT_SECRET = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.example-signature";

app.get("/admin", async (req, res) => {

    const token = req.cookies.admin_token;


    // --------------------------------
    // NO HAY SESIÓN
    // --------------------------------

    if (!token) {

        return res.render("admin/login", {
            error: null
        });

    }


    // --------------------------------
    // COMPROBAR JWT
    // --------------------------------

    let admin;

    try {

        admin = jwt.verify(
            token,
            JWT_SECRET
        );

    } catch (error) {

        res.clearCookie("admin_token");

        return res.render("admin/login", {
            error: "La sesión ha expirado"
        });

    }


    // --------------------------------
    // QUERIES DEL DASHBOARD
    // --------------------------------

    try {

        const [[posts]] = await db.query(`
            SELECT COUNT(*) AS totalPosts
            FROM posts
        `);


        const [[views]] = await db.query(`
            SELECT COALESCE(SUM(views), 0) AS totalViews
            FROM posts
        `);


        const [[categories]] = await db.query(`
            SELECT COUNT(DISTINCT category) AS totalCategories
            FROM posts
        `);


        const [[today]] = await db.query(`
            SELECT COUNT(*) AS todayPosts
            FROM posts
            WHERE DATE(created_at) = CURDATE()
        `);


        const [latestPosts] = await db.query(`
            SELECT
                id,
                title,
                slug,
                category,
                views,
                created_at
            FROM posts
            ORDER BY created_at DESC
            LIMIT 10
        `);


        // --------------------------------
        // MOSTRAR PANEL
        // --------------------------------

        res.render("admin/dashboard", {

            admin,

            stats: {

                totalPosts: posts.totalPosts,

                totalViews: views.totalViews,

                totalCategories: categories.totalCategories,

                todayPosts: today.todayPosts

            },

            latestPosts

        });


    } catch (error) {

        console.error(error);

        res.status(500).send(
            "Error al cargar el panel"
        );

    }

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









app.listen(process.env.PORT || 3000, () => {
    console.log("SocialsForce funcionando.");
});