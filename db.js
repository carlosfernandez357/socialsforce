const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: "localhost",
    user: "u256818095_admin",
    password: "Juegoscuenta.1",
    database: "u256818095_socialsforce"
});

module.exports = pool;