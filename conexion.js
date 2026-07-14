const { Pool } = require('pg');

// ==========================================
// CONEXIÓN A LA BASE DE DATOS (SUPABASE)
// ==========================================

// Intentar usar la URL completa de Supabase primero (ConnectionString)
const databaseUrl = process.env.DATABASE_URL || null;

let pool;

if (databaseUrl) {
    // Usar la URL completa (Ideal para Render o producción)
    pool = new Pool({
        connectionString: databaseUrl,
        ssl: {
            rejectUnauthorized: false // Requerido por Supabase para conexiones seguras
        },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    console.log('✅ Conectando a Supabase usando DATABASE_URL');
} else {
    // Usar variables individuales (Para local)
    pool = new Pool({
        host: process.env.DB_HOST || 'aws-0-us-east-1.pooler.supabase.com', // Tu host de Supabase
        user: process.env.DB_USER || 'postgres.tu_id_de_proyecto',
        password: process.env.DB_PASSWORD || 'tu_contraseña_aqui',
        database: process.env.DB_NAME || 'postgres',
        port: process.env.DB_PORT || 6543, // Puerto del Pooler de Supabase (modo transaccional)
        ssl: {
            rejectUnauthorized: false
        },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    console.log('✅ Conectando a Supabase usando variables individuales');
}

module.exports = pool;