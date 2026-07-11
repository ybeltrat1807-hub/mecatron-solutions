const mysql = require('mysql2/promise');

// Usar el pool directamente, ya que mysql2/promise ya devuelve promesas
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mecatron_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
// Exportamos el puente en formato de "Promesas" para que el código sea moderno y rápido
const poolPromise = pool.promise();

console.log("🔌 Puente de conexión a mecatron_db configurado con éxito.");

module.exports = poolPromise;