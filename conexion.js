const mysql = require('mysql2/promise');

// 🔥 LEER LAS VARIABLES DE ENTORNO (Render las inyecta automáticamente)
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mecatron_db',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
// Exportamos el puente en formato de "Promesas" para que el código sea moderno y rápido
const poolPromise = pool.promise();

console.log("🔌 Puente de conexión a mecatron_db configurado con éxito.");

module.exports = poolPromise;