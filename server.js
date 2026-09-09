const express = require("express");
const db = require("./db");

const app = express();

app.get("/", async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM posts");

        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).send("Error de conexión con la base de datos");
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("SocialsForce funcionando");
});