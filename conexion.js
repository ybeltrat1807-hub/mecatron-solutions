const mysql = require('mysql2/promise');

// ==========================================
// CONEXIÓN A LA BASE DE DATOS
// ==========================================

// Intentar usar la URL completa de Clever Cloud primero
const databaseUrl = null;

let pool;

if (databaseUrl) {
    // Usar la URL completa (para Render)
    pool = mysql.createPool({
        uri: databaseUrl,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
    console.log('✅ Conectando a la BD usando DATABASE_URL');
} else {
    // Usar variables individuales (para local o Render)
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'mecatron_db',
        port: 3306,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
    console.log('✅ Conectando a la BD usando variables individuales');
}

module.exports = pool;