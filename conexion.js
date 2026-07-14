const { Pool } = require('pg');

// ==========================================
// CONEXIÓN A LA BASE DE DATOS (SUPABASE)
// ==========================================

const databaseUrl = process.env.DATABASE_URL || null;

let pool;

// Configuración de SSL estándar y compatible con Supabase
const sslConfig = process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : { rejectUnauthorized: false }; // En ambos entornos evitamos la validación estricta de certificados autofirmados

if (databaseUrl) {
    // Usar la URL completa (Ideal para Render o producción)
    pool = new Pool({
        connectionString: databaseUrl,
        ssl: sslConfig,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000, // Aumentamos un poco el tiempo de espera
    });
    console.log('✅ Conectando a Supabase usando DATABASE_URL');
} else {
    // Usar variables individuales (Para local)
    pool = new Pool({
        host: process.env.DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'postgres',
        port: process.env.DB_PORT || 6543,
        ssl: sslConfig,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });
    console.log('✅ Conectando a Supabase usando variables individuales');
}

module.exports = pool;