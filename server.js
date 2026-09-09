const express = require("express");
const db = require("./db");
const path = require("path");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));










app.get("/", async (req, res) => {
    try {
        const [posts] = await db.query(
            "SELECT * FROM posts ORDER BY published_at DESC"
        );

        res.render("home", { posts });

    } catch (error) {
        console.error(error);
        res.status(500).send("Error al cargar los posts");
    }
});









app.listen(process.env.PORT || 3000, () => {
    console.log("SocialsForce funcionando");
});