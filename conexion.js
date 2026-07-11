const mysql = require('mysql2/promise');

// Crear el pool directamente - mysql2/promise ya devuelve promesas
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mecatron_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Exportar el pool directamente (no necesitas pool.promise())
module.exports = pool;