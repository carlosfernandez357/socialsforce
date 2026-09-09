const express = require("express");
const db = require("./db");
const path = require("path");
const fs = require("fs");


const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));





const viewsPath = path.join(__dirname, "views");

console.log("SERVER DIR:", __dirname);
console.log("VIEWS PATH:", viewsPath);

try {
    console.log("VIEWS CONTENTS:", fs.readdirSync(viewsPath));
} catch (error) {
    console.error("ERROR READING VIEWS:", error);
}




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