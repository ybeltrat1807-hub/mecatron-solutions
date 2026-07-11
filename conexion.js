const mysql = require('mysql2');

// Creamos un "Pool" (piscina de conexiones). Es la forma más eficiente 
// porque permite que múltiples usuarios consulten el inventario al tiempo.
const pool = mysql.createPool({
    host: 'localhost',       // Tu propia computadora
    user: 'root',            // El usuario por defecto que te da XAMPP
    password: '',            // En XAMPP viene sin contraseña por defecto
    database: 'mecatron_db', // La base de datos que acabas de crear
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Exportamos el puente en formato de "Promesas" para que el código sea moderno y rápido
const poolPromise = pool.promise();

console.log("🔌 Puente de conexión a mecatron_db configurado con éxito.");

module.exports = poolPromise;