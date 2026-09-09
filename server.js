const express = require("express");
const db = require("./db");
const path = require("path");
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));










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










app.listen(process.env.PORT || 3000, () => {
    console.log("SocialsForce funcionando.");
});