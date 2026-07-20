// =================================================================
//   MECATRON SOLUTIONS - SISTEMA DE CONTROL DE INVENTARIO CENTRAL
//   Desarrollado por: Beltrán Software Solutions
// =================================================================
const express = require('express');
const db = require('./conexion'); 
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
app.use(cors({
  origin: ['mecatron-solutions-production.up.railway.app'], // pon tu URL real del frontend
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
// Middleware de enrutamiento estático para Mecatron Solutions
app.use(express.json());
app.use(express.static('public'));
// ==========================================
// ENDPOINTS DE PRUEBA PARA LA BD
// ==========================================
app.get('/api/test', (req, res) => {
    res.json({ mensaje: 'Servidor de Mecatron Solutions funcionando correctamente', hora: new Date() });
});

app.get('/api/test-db', async (req, res) => {
    try {
        console.log('🔍 Probando conexión a la BD...');
        const { rows } = await db.query('SELECT 1 as test');
        res.json({ 
            success: true, 
            message: 'Conexión exitosa a la BD', 
            data: rows,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME
        });
    } catch (error) {
        console.error('❌ Error de conexión:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            code: error.code,
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            database: process.env.DB_NAME
        });
    }
});
// ==========================================
// ENDPOINT DE PRUEBA - PARA VERIFICAR QUE EL SERVIDOR FUNCIONA
// ==========================================
app.get('/api/test', (req, res) => {
    res.json({ 
        mensaje: 'Servidor de Mecatron Solutions funcionando correctamente',
        hora: new Date().toISOString(),
        estado: '✅ Activo'
    });
});
// CORS - Permitir peticiones del frontend
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});
// =================================================================
//   ESTRUCTURAS DE MEMORIA
// =================================================================
const ordenesServicioActivas = {}; 
const remisionesVentaActivas = {}; // Remisiones activas (en ruta)
const historialRemisiones = [];    // Historial de todas las remisiones creadas
let contadorRemisiones = 0;

// Función para inicializar el contador desde la BD
async function inicializarContadorRemisiones() {
    try {
        const {rows} = await db.query('SELECT COUNT(*) as total FROM remisiones');
        contadorRemisiones = rows[0].total || 0;
        console.log(`📊 Contador de remisiones inicializado en: ${contadorRemisiones}`);
    } catch (error) {
        console.error('Error al inicializar contador:', error);
        contadorRemisiones = 0;
    }
}

// Llamar a la función cuando arranca el servidor
inicializarContadorRemisiones();
// RF-01: Seguridad (Códigos de autorización para operaciones)
const codigosAutorizados = ["1234", "5678", "9999"];

const matrizRecomendaciones = {
    // MAPEANDO LOS BOTONES ELÉCTRICOS
    "MANTENIMIENTO_ELECTRICO": [1, 4, 6],
    "MONTAJE_ELECTRICO": [1, 4, 6],
    "REPARACIONES_ELECTRICAS": [1, 4, 6],

    // MAPEANDO LOS BOTONES DE AIRES / REFRIGERACIÓN
    "MANTENIMIENTO_AIRES": [2, 3, 5, 7],
    "MONTAJE_AIRES": [2, 3, 5, 7],
    "REPARACION_AIRES": [2, 3, 5, 7]
};
// =================================================================
//  UTIL: Generar id_remision único consultando la BD (evita ER_DUP_ENTRY)
// =================================================================
async function generarIdRemisionUnico(conn = null, maxAttempts = 10) {
    const query = conn ? conn.query.bind(conn) : db.query.bind(db);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Obtener la última remisión por orden lexicográfico (se asume formato REM-####)
        const { rows }  = await query("SELECT id_remision FROM remisiones ORDER BY id_remision DESC LIMIT 1");
        let nextNum = 1;
        if (rows && rows.length) {
            const last = rows[0].id_remision || '';
            const m = last.match(/(\d+)$/);
            if (m) {
                nextNum = parseInt(m[1], 10) + 1;
            }
        } else {
            // si no hay filas en la tabla, basarse en contador en memoria
            nextNum = Math.max(1, (typeof contadorRemisiones === 'number' ? contadorRemisiones + 1 : 1));
        }

        const candidate = `REM-${String(nextNum).padStart(4, '0')}`;

        // Comprobar que no exista (doble-check)
        const [exists] = await query("SELECT 1 FROM remisiones WHERE id_remision = ? LIMIT 1", [candidate]);
        if (!exists || exists.length === 0) {
            // actualizar contador en memoria para mantener consistencia
            contadorRemisiones = nextNum;
            return candidate;
        }

        // si existe, avanzamos y reintentamos
        contadorRemisiones = nextNum;
    }

    throw new Error('No se pudo generar un id_remision único después de varios intentos.');
}

// =================================================================
//      MÓDULO DE VENTAS Y PREVENTAS (OPTIMIZADO CON CARRITO)
// =================================================================

// 🧾 SUBMÓDULO 1: SALIDA DE BODEGA (CON GUARDADO EN BD)
app.post('/api/preventa/salida', async (req, res) => {
    const { productosCarrito, usuario } = req.body;

    if (!productosCarrito || productosCarrito.length === 0) {
        return res.status(400).json({ error: "El carrito está vacío." });
    }

    // Usamos un cliente de base de datos transaccional si es posible, o consultas seguras
    try {
        // 1. Obtener dinámicamente el último número de remisión directo de Supabase
        // Esto evita que se dupliquen IDs si el servidor de Railway se reinicia
        const { rows: ultimoRegistro } = await db.query(
            'SELECT id_remision FROM remisiones ORDER BY fecha_creacion DESC LIMIT 1'
        );
        
        let nuevoNumero = 1;
        if (ultimoRegistro.length > 0) {
            const ultimoId = ultimoRegistro[0].id_remision; // Ejemplo: "REM-0015"
            const numeroExtraido = parseInt(ultimoId.replace('REM-', ''), 10);
            if (!isNaN(numeroExtraido)) {
                nuevoNumero = numeroExtraido + 1;
            }
        }
        const idRemision = `REM-${String(nuevoNumero).padStart(4, '0')}`;

        let productosValidados = [];

        // Validar y obtener datos de la BD
        for (const item of productosCarrito) {
            const { rows } = await db.query(
                'SELECT nombre, stock, costo, precio_venta FROM inventario_venta WHERE id = $1',
                [item.idProducto]
            );
            
            if (rows.length === 0) {
                return res.status(404).json({ error: `El producto con ID ${item.idProducto} no existe.` });
            }

            let prod = rows[0];
            if (prod.stock < item.cantidadSalida) {
                return res.status(400).json({ error: `Stock insuficiente para "${prod.nombre}". Disponible: ${prod.stock}` });
            }

            // Aseguramos valores numéricos válidos para PostgreSQL (evitando NaNs)
            const costoFijo = Number(prod.costo) || 0;
            const precioFijo = Number(prod.precio_venta) || 0;

            productosValidados.push({
                idProducto: item.idProducto,
                nombre: prod.nombre,
                cantidadCargadaInicial: parseInt(item.cantidadSalida, 10),
                cantidadVendidaEnCalle: 0,
                costoUnidadFijo: costoFijo,
                precioVentaUnidadFijo: precioFijo,
                precioVentaRealCalle: 0
            });
        }

        // --- INICIO DE TRANSACCIÓN ---
        await db.query('BEGIN');

        // Descontar de la BD en Supabase
        for (const item of productosValidados) {
            await db.query(
                'UPDATE inventario_venta SET stock = stock - $1 WHERE id = $2',
                [item.cantidadCargadaInicial, item.idProducto]
            );
        }

        // Guardar la remisión en la tabla principal de Supabase
        await db.query(
            'INSERT INTO remisiones (id_remision, fecha_creacion, estado, usuario_creacion) VALUES ($1, $2, $3, $4)',
            [idRemision, new Date(), 'ACTIVA', usuario || 'Sistema']
        );

        // Guardar cada producto en la tabla de detalles en Supabase
        for (const item of productosValidados) {
            await db.query(
                `INSERT INTO remisiones_productos 
                 (id_remision, id_producto, nombre, cantidad_cargada, cantidad_vendida, costo_unidad, precio_venta_unidad) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    idRemision,
                    item.idProducto,
                    item.nombre,
                    item.cantidadCargadaInicial,
                    0,
                    item.costoUnidadFijo,
                    item.precioVentaUnidadFijo
                ]
            );
        }

        // Si todo salió bien, confirmamos los cambios en Supabase
        await db.query('COMMIT');

        // Guardar también en la memoria RAM por si acaso el frontend aún la utiliza para mapear
        const remisionMemoria = {
            idRemision,
            productos: productosValidados,
            preFactura: { totalVentasEmitidas: 0, totalCostosOperativos: 0, gananciaPreviaCalculada: 0 },
            fechaCreacion: new Date().toISOString(),
            estado: 'ACTIVA'
        };
        remisionesVentaActivas[idRemision] = remisionMemoria;

        res.json({ 
            mensaje: `✓ Remisión ${idRemision} generada con éxito con ${productosValidados.length} productos.`, 
            idRemision,
            remisionesActivas: Object.keys(remisionesVentaActivas)
        });

    } catch (error) {
        // Si algo falla, revertimos todos los cambios para no dejar datos corruptos
        await db.query('ROLLBACK');
        console.error("Error crítico en salida de preventa:", error);
        res.status(500).json({ error: "Error interno: " + error.message });
    }
});
// Ruta para el listado detallado en ventas.html
app.get('/api/preventa/remisiones-activas', async (req, res) => {
    try {
        const query = `
            SELECT r.id_remision, r.fecha_creacion, rp.nombre, rp.cantidad_cargada, rp.cantidad_vendida
            FROM remisiones r
            LEFT JOIN remisiones_productos rp ON r.id_remision = rp.id_remision
            WHERE r.estado = 'ACTIVA'
            ORDER BY r.fecha_creacion DESC
        `;
        const { rows } = await db.query(query);
        const remisionesAgrupadas = {};

        rows.forEach(row => {
            if (!remisionesAgrupadas[row.id_remision]) {
                remisionesAgrupadas[row.id_remision] = {
                    idRemision: row.id_remision,
                    fechaCreacion: row.fecha_creacion,
                    productos: [],
                    totalVentas: 0 
                };
            }
            if (row.nombre) {
                const cargados = parseInt(row.cantidad_cargada, 10) || 0;
                const vendidos = parseInt(row.cantidad_vendida, 10) || 0;
                remisionesAgrupadas[row.id_remision].productos.push({
                    nombre: row.nombre,
                    cargados: cargados,
                    vendidos: vendidos,
                    disponibles: cargados - vendidos
                });
            }
        });
        res.json({ activas: Object.values(remisionesAgrupadas) });
    } catch (error) {
        console.error("Error al obtener remisiones para ventas:", error);
        res.status(500).json({ error: "Error al obtener remisiones" });
    }
});
// Ruta para el contador rápido en panel.html
app.get('/ventas/remisiones-activas', async (req, res) => {
    try {
        const { rows } = await db.query("SELECT COUNT(*) as total FROM remisiones WHERE estado = 'ACTIVA'");
        const total = parseInt(rows[0].total, 10) || 0;
        res.json({ total });
    } catch (error) {
        console.error("Error en conteo de remisiones activas para panel:", error);
        res.status(500).json({ error: error.message });
    }
});

// 🚚 SUBMÓDULO 2: REGISTRO DE VENTA EXTERNA (CON GUARDADO EN BD)
app.post('/api/preventa/venta-externa', async (req, res) => {
    const { idRemision, idProducto, cantidadAVender, precioVentaReal, vendedor } = req.body;
    let remision = remisionesVentaActivas[idRemision];

    if (!remision) {
        return res.status(404).json({ error: "No se encontró la remisión especificada." });
    }

    let item = remision.productos.find(p => p.idProducto === parseInt(idProducto));
    if (!item) {
        return res.status(404).json({ error: "Este producto no fue cargado en esta remisión." });
    }

    let disponibleEnCamion = item.cantidadCargadaInicial - item.cantidadVendidaEnCalle;
    if (cantidadAVender > disponibleEnCamion) {
        return res.status(400).json({ error: `No puede vender más de lo que lleva. Disponible: ${disponibleEnCamion} uds.` });
    }

    // Guardar datos de la venta actual
    const cantidad = parseInt(cantidadAVender);
    const precio = parseFloat(precioVentaReal);
    const total = cantidad * precio;

    const ventaActual = {
        nombre: item.nombre,
        cantidad: cantidad,
        precio: precio,
        total: total
    };

    // Actualizar en memoria
    item.cantidadVendidaEnCalle += cantidad;
    item.precioVentaRealCalle = precio;

    // Recalcular
    let totalVentas = 0;
    let totalCostos = 0;

    remision.productos.forEach(p => {
        totalVentas += p.cantidadVendidaEnCalle * (p.precioVentaRealCalle || p.precioVentaUnidadFijo);
        totalCostos += p.cantidadVendidaEnCalle * p.costoUnidadFijo;
    });

    remision.preFactura = {
        totalVentasEmitidas: totalVentas,
        totalCostosOperativos: totalCostos,
        gananciaPreviaCalculada: totalVentas - totalCostos
    };

    // === GUARDAR EN LA BASE DE DATOS ===
    try {
    // 1. Guardar la venta individual (PostgreSQL utiliza $1, $2, etc.)
    await db.query(
        `INSERT INTO ventas_individuales 
         (id_remision, id_producto, nombre_producto, cantidad, precio_unitario, total, vendedor, fecha_venta) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
            idRemision,
            parseInt(idProducto),
            item.nombre,
            cantidad,
            precio,
            total,
            vendedor || 'Sistema'
        ]
    );

    // 2. Actualizar cantidad vendida en remisiones_productos
    await db.query(
        'UPDATE remisiones_productos SET cantidad_vendida = cantidad_vendida + $1 WHERE id_remision = $2 AND id_producto = $3',
        [cantidad, idRemision, parseInt(idProducto)]
    );

    // 3. Actualizar total de la remisión
    await db.query(
        'UPDATE remisiones SET total_ventas = total_ventas + $1 WHERE id_remision = $2',
        [total, idRemision]
    );

        console.log(`✅ Venta guardada en BD: ${item.nombre} x${cantidad} - $${total}`);

    } catch (error) {
        console.error('❌ Error al guardar venta en BD:', error);
        // No detenemos el proceso, solo logueamos
    }

    res.json({
        mensaje: `🧾 Venta registrada para ${item.nombre}.`,
        remisionActualizada: remision,
        ventaActual: ventaActual
    });
});
// === VENTA A CRÉDITO ===
function abrirModalCredito(){
  // Validamos que haya productos en tu variable que ya usas
  const lista = typeof productosVenta !== 'undefined' ? productosVenta : (typeof carrito !== 'undefined' ? carrito : []);
  if(lista.length===0) return alert('⚠️ Agrega productos a la venta primero');

  const remisionInput = document.getElementById('idRemision') || document.getElementById('inputRemisionId') || {value: 'REM-'+Date.now().toString().slice(-6)};
  const remisionId = remisionInput.value || 'REM-'+Date.now().toString().slice(-6);
  
  document.getElementById('creditoRemisionId').textContent = remisionId;
  document.getElementById('modalCredito').style.display='flex';

  const total = lista.reduce((s,p)=> s + (parseFloat(p.precio||p.precio_pactado||0) * parseInt(p.cantidad||1)),0);
  
  document.getElementById('listaCreditoProductos').innerHTML = `
    <strong>Productos (${lista.length}) - Total: $${total.toLocaleString()}</strong>
    ${lista.map((p,i)=>`
      <label style="display:flex; gap:0.5rem; align-items:center; margin-top:0.5rem; padding:0.4rem; background:white; border-radius:6px;">
        <input type="checkbox" class="chk-credito" data-index="${i}" checked style="width:18px; height:18px;">
        <span>${p.nombre || p.producto || 'Producto'} - ${p.cantidad} x $${parseFloat(p.precio||p.precio_pactado).toLocaleString()}</span>
      </label>`).join('')}
  `;
  
  actualizarSaldoFinanciar();
  // Escuchar abono
  document.getElementById('credito_abono').oninput = actualizarSaldoFinanciar;
}

function actualizarSaldoFinanciar(){
  const lista = typeof productosVenta !== 'undefined' ? productosVenta : (typeof carrito !== 'undefined' ? carrito : []);
  const total = lista.reduce((s,p)=> s + (parseFloat(p.precio||p.precio_pactado||0) * parseInt(p.cantidad||1)),0);
  const abono = parseFloat(document.getElementById('credito_abono').value)||0;
  document.getElementById('saldoFinanciar').textContent = `$${(total-abono).toLocaleString()}`;
}

function cerrarModalCredito(){ 
  document.getElementById('modalCredito').style.display='none'; 
}

async function guardarVentaCredito(){
  const lista = typeof productosVenta !== 'undefined' ? productosVenta : (typeof carrito !== 'undefined' ? carrito : []);
  if(!lista.length) return;

  const nombre = document.getElementById('cli_nombre').value.trim();
  if(!nombre) return alert('El nombre del cliente es obligatorio');

  const checks = document.querySelectorAll('.chk-credito:checked');
  if(checks.length===0) return alert('Selecciona al menos un producto a crédito');

  // Filtrar solo productos chequeados
  const productosCredito = Array.from(checks).map(c => lista[parseInt(c.dataset.index)]);
  const totalCredito = productosCredito.reduce((s,p)=> s + (parseFloat(p.precio||p.precio_pactado||0) * parseInt(p.cantidad||1)),0);
  
  const abono = parseFloat(document.getElementById('credito_abono').value)||0;
  const saldo = totalCredito - abono;

  const payload = {
    remision_id: document.getElementById('creditoRemisionId').textContent,
    cliente_nombre: nombre,
    cliente_cc: document.getElementById('cli_cc').value,
    cliente_telefono: document.getElementById('cli_tel').value,
    cliente_direccion: document.getElementById('cli_dir').value,
    total_venta: totalCredito,
    abono_inicial: abono,
    saldo_pendiente: saldo,
    productos: productosCredito,
    fecha_vencimiento: document.getElementById('credito_vence').value || null,
    usuario: 'Sistema'
  };

  try{
    const res = await fetch(`${typeof API_URL !== 'undefined' ? API_URL : ''}/api/ventas/credito`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Error');

    alert(`✅ Crédito guardado: ${payload.remision_id} - Saldo: $${saldo.toLocaleString()}`);
    cerrarModalCredito();
    
    // Limpia tu carrito (usa tu función existente)
    if(typeof vaciarCarrito === 'function') vaciarCarrito();
    if(typeof productosVenta !== 'undefined') { productosVenta = []; actualizarTablaVenta && actualizarTablaVenta(); }
    location.reload(); // para refrescar estado contable
    
  }catch(e){
    alert('❌ Error: '+e.message);
  }
}
// 🏁 SUBMÓDULO 3: CIERRE DE JORNADA (CORREGIDO)
app.post('/api/preventa/cierre-jornada', async (req, res) => {
    const { idRemision } = req.body;
    let remision = remisionesVentaActivas[idRemision];

    if (!remision) {
        return res.status(404).json({ error: "La remisión ya fue cerrada o no existe." });
    }

    try {
        // 1. Reingresar lo no vendido a Postgres (CORREGIDO: $1, $2)
        for (const item of remision.productos) {
            let cantidadSobrante = item.cantidadCargadaInicial - item.cantidadVendidaEnCalle;
            if (cantidadSobrante > 0) {
                await db.query(
                    'UPDATE inventario_venta SET stock = stock + $1 WHERE id = $2',
                    [cantidadSobrante, item.idProducto]
                );
            }
        }

        // 2. Actualizar estado de la remisión en BD (CORREGIDO: comillas simples, $1, $2 y desestructuración rowCount)
        const { rowCount } = await db.query(
            "UPDATE remisiones SET estado = 'CERRADA', fecha_cierre = $1 WHERE id_remision = $2",
            [new Date(), idRemision]
        );

        // 3. Si no se actualizó, insertar la remisión en la BD (CORREGIDO: rowCount en lugar de affectedRows)
        if (rowCount === 0) {
            await db.query(
                `INSERT INTO remisiones (id_remision, fecha_creacion, estado, usuario_creacion, total_ventas, fecha_cierre) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    idRemision,
                    remision.fechaCreacion || new Date(),
                    'CERRADA',
                    'Sistema',
                    remision.preFactura?.totalVentasEmitidas || 0,
                    new Date()
                ]
            );

            // Insertar los productos (CORREGIDO: $1 al $7)
            for (const item of remision.productos) {
                await db.query(
                    `INSERT INTO remisiones_productos 
                     (id_remision, id_producto, nombre, cantidad_cargada, cantidad_vendida, costo_unidad, precio_venta_unidad) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        idRemision,
                        item.idProducto,
                        item.nombre,
                        item.cantidadCargadaInicial,
                        item.cantidadVendidaEnCalle,
                        item.costoUnidadFijo || 0,
                        item.precioVentaUnidadFijo || 0
                    ]
                );
            }
        }

        // 4. Guardar en historial en memoria
        remision.estado = 'CERRADA';
        remision.fechaCierre = new Date().toISOString();
        historialRemisiones.push(remision);

        // 5. Calcular balance final
        let balanceCierreFinal = {
            idRemision,
            productosMovidos: remision.productos.map(p => ({
                nombre: p.nombre,
                cargados: p.cantidadCargadaInicial,
                vendidos: p.cantidadVendidaEnCalle,
                devueltos: p.cantidadCargadaInicial - p.cantidadVendidaEnCalle
            })),
            cierreFinancieroCaja: {
                ingresoEfectivoARecibir: `$${remision.preFactura.totalVentasEmitidas.toLocaleString()}`,
                costoMercancia: `$${remision.preFactura.totalCostosOperativos.toLocaleString()}`,
                gananciaLimpiaMecatron: `$${remision.preFactura.gananciaPreviaCalculada.toLocaleString()}`
            }
        };

        // 6. Eliminar de memoria activa
        delete remisionesVentaActivas[idRemision];

        // === AUTOMATIZAR: Registrar utilidad en el módulo financiero ===
        try {
            const utilidad = remision.preFactura.gananciaPreviaCalculada || 0;
            if (utilidad > 0) {
                // 1. Registrar el movimiento (CORREGIDO: $1 al $4 y CURRENT_TIMESTAMP de Postgres)
                await db.query(
                    `INSERT INTO movimientos_financieros 
                     (tipo, monto, descripcion, fecha_movimiento, usuario) 
                     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
                    ['UTILIDAD', utilidad, `Utilidad de remisión ${idRemision}`, 'Sistema']
                );

                // 2. Actualizar el balance (CORREGIDO: { rows } y LIMIT 1 de Postgres)
                const { rows: balanceRows } = await db.query('SELECT * FROM balance_financiero ORDER BY id DESC LIMIT 1');
                
                if (balanceRows.length > 0) {
                    let total_ganado = parseFloat(balanceRows[0].total_ganado || 0) + utilidad;
                    let total_reinvertido = parseFloat(balanceRows[0].total_reinvertido || 0);
                    let total_disponible = total_ganado - total_reinvertido;

                    // (CORREGIDO: $1 al $4 y CURRENT_TIMESTAMP de Postgres)
                    await db.query(
                        `UPDATE balance_financiero 
                         SET total_ganado = $1, total_reinvertido = $2, total_disponible = $3, ultima_actualizacion = CURRENT_TIMESTAMP 
                         WHERE id = $4`,
                        [total_ganado, total_reinvertido, total_disponible, balanceRows[0].id]
                    );
                }

                console.log(`💰 Utilidad de ${utilidad} registrada automáticamente en módulo financiero`);
            }
        } catch (error) {
            console.error('Error al registrar utilidad automática:', error);
            // No detenemos el proceso si falla
        }

        res.json({
            mensaje: "🏁 Cierre de ruta procesado con éxito.",
            auditoriaFinal: balanceCierreFinal
        });

    } catch (error) {
        console.error("❌ Error al procesar el cierre:", error);
        res.status(500).json({ 
            error: "Error al cerrar la remisión en la base de datos.",
            detalle: error.message 
        });
    }
});

// NUEVO ENDPOINT AUXILIAR: Para traer el carrito actual de una remisión en ruta
app.get('/api/preventa/consultar/:idRemision', (req, res) => {
    let remision = remisionesVentaActivas[req.params.idRemision];
    if (!remision) return res.status(404).json({ error: "Remisión no encontrada." });
    res.json(remision);
});

// =================================================================
//      MÓDULO DE SERVICIOS (RECOMENDADOR Y HERRAMIENTAS)
// =================================================================
// 💡 RECOMENDADOR DE HERRAMIENTAS POR TIPO DE SERVICIO (Versión PostgreSQL Relacional)
app.get('/api/servicios/recomendar', async (req, res) => {
  const { tipo_servicio } = req.query;
  
  const mapaColumnas = {
    'MANTENIMIENTO_ELECTRICO': 'usa_mantenimiento_electrico',
    'MANTENIMIENTO_AIRE': 'usa_mantenimiento_aire',
    'MONTAJE_ELECTRICO': 'usa_montaje_electrico',
    'MONTAJE_AIRE': 'usa_montaje_aire',
    'REPARACION_ELECTRICA': 'usa_reparacion_electrica',
    'REPARACION_AIRE': 'usa_reparacion_aire'
  };

  const columna = mapaColumnas[tipo_servicio];
  
  if (!columna) {
    return res.status(400).json({ error: `Tipo servicio no válido: ${tipo_servicio}` });
  }

  try {
    // Ahora filtra por la columna booleana, no por tipo_servicio repetido
    // Y como ya deduplicaste, trae 1 fila por herramienta
    const query = `
      SELECT id, nombre, stock_total, disponibles, estado,
             usa_mantenimiento_electrico, usa_mantenimiento_aire,
             usa_montaje_electrico, usa_montaje_aire,
             usa_reparacion_electrica, usa_reparacion_aire
      FROM inventario_uso_servicio
      WHERE ${columna} = true AND disponibles > 0
      ORDER BY nombre ASC
    `;
    
    const { rows } = await db.query(query);
    
    res.json({ 
      herramientas: rows,
      total: rows.length,
      servicio: tipo_servicio
    });
    
  } catch (error) {
    console.error('Error en recomendador:', error);
    res.status(500).json({ error: 'Error al obtener herramientas recomendadas' });
  }
});

// ENDPOINT DE INVENTARIO PARA SERVICIOS - ya devuelve todo sumado
app.get('/api/servicios/inventario', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, nombre, stock_total, disponibles, estado,
             usa_mantenimiento_electrico, usa_mantenimiento_aire,
             usa_montaje_electrico, usa_montaje_aire,
             usa_reparacion_electrica, usa_reparacion_aire
      FROM inventario_uso_servicio
      ORDER BY nombre ASC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error inventario servicios:', error);
    res.status(500).json({ error: 'Error al cargar inventario' });
  }
});
// ==========================================================
// DESPACHO DE HERRAMIENTAS (SALIDA) - COMPLETO Y CORREGIDO
// ==========================================================
app.post('/api/servicios/salida', async (req, res) => {
    console.log("DATOS RECIBIDOS EN EL SERVIDOR:", req.body);
    const { lugartrabajo, idsSeleccionadas, idsAdicionales, usuario } = req.body;
    
    let todasLasHerramientas = [...(idsSeleccionadas || []), ...(idsAdicionales || [])];

    if (!lugartrabajo || todasLasHerramientas.length === 0) {
        return res.status(400).json({ error: "Faltan datos obligatorios (Lugar de trabajo o herramientas)." });
    }

    // ==========================================================
    // 🚀 CONTROL CONSECUTIVO FORZADO DESDE EL BACKEND
    // ==========================================================
    let finalIdOrden;
    try {
        const result = await db.query(
            "SELECT id_orden FROM ordenes_servicio WHERE id_orden LIKE 'ORD-%' ORDER BY fecha_creacion DESC, id_orden DESC LIMIT 1"
        );
        
        let nextNum = 1;
        
        if (result.rows.length > 0) {
            const lastNum = parseInt(result.rows[0].id_orden.replace('ORD-', ''), 10);
            if (!isNaN(lastNum)) {
                nextNum = lastNum + 1;
            }
        }
        
        finalIdOrden = `ORD-${String(nextNum).padStart(4, '0')}`;
        
    } catch (errCon) {
        console.error("❌ Error calculando el consecutivo:", errCon);
        finalIdOrden = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
    }
    // ==========================================================

    try {
        // Verificar duplicado — $1 en vez de ?, result.rows en vez de [existente]
        const existenteResult = await db.query('SELECT id_orden FROM ordenes_servicio WHERE id_orden = $1', [finalIdOrden]);
        if (existenteResult.rows.length > 0) {
            return res.status(409).json({ error: "Ya existe una orden con ese ID." });
        }

        let despachoExitoso = [];
        let erroresDespacho = [];

                for (const id of todasLasHerramientas) {
            const result = await db.query('SELECT nombre, disponibles FROM inventario_uso_servicio WHERE id = $1', [id]);

            if (result.rows.length === 0) {
                erroresDespacho.push(`El ID ${id} no existe en la bodega.`);
                continue;
            }

            let herramienta = result.rows[0];

            // YA NO REVISAMOS EL ESTADO, SOLO DISPONIBLES
            if (herramienta.disponibles < 1) {
                erroresDespacho.push(`No hay unidades disponibles de: ${herramienta.nombre}`);
            } else {
                await db.query(
                    'UPDATE inventario_uso_servicio SET disponibles = disponibles - 1 WHERE id = $1',
                    [id]
                );
                despachoExitoso.push({ id: id, nombre: herramienta.nombre });
            }
        }

        if (despachoExitoso.length === 0) {
            return res.status(400).json({ error: "No se pudo despachar ninguna herramienta.", detalles: erroresDespacho });
        }

        // INSERT — $1..$5 en vez de ?
        const queryOrden = `
            INSERT INTO ordenes_servicio (
                id_orden, 
                lugartrabajo, 
                estado, 
                usuario_creacion, 
                fecha_creacion, 
                total_herramientas
            ) 
            VALUES ($1, $2, $3, $4, NOW(), $5)
        `;

        const valoresOrden = [
            finalIdOrden,
            lugartrabajo,
            'EN_CAMPO',
            usuario || 'Sistema',
            despachoExitoso.length 
        ];

        await db.query(queryOrden, valoresOrden);

        // Detalles — $1, $2, $3 en vez de ?
        for (const h of despachoExitoso) {
            await db.query(
                `INSERT INTO ordenes_servicio_herramientas (id_orden, id_herramienta, nombre_herramienta) 
                 VALUES ($1, $2, $3)`,
                [finalIdOrden, h.id, h.nombre]
            );
        }

        if (typeof ordenesServicioActivas !== 'undefined') {
            ordenesServicioActivas[finalIdOrden] = {
                idOrden: finalIdOrden,
                lugartrabajo: lugartrabajo,
                herramientasAsignadas: despachoExitoso,
                estado: "EN_CAMPO",
                fechaCreacion: new Date().toISOString()
            };
        }

        res.json({
            mensaje: `🚀 Despacho operativo procesado con éxito para: ${lugartrabajo}.`,
            idOrden: finalIdOrden,
            totalHerramientas: despachoExitoso.length,
            lugartrabajo: lugartrabajo,
            alertas: erroresDespacho.length > 0 ? erroresDespacho : "Ninguna. Todo el kit salió completo."
        });

    } catch (error) {
        console.error("❌ Error crítico en el despacho:", error);
        res.status(500).json({ error: "Error interno al procesar la salida.", detalle: error.message });
    }
});
// REINGRESO DE HERRAMIENTAS CON ESTADO - CORREGIDO
app.post('/api/servicios/reingreso', async (req, res) => {
    const { idOrden, novedades } = req.body;
    console.log(`🔄 Procesando reingreso de la orden: ${idOrden}`);

    try {
        const resultadoOrden = await db.query(
            `SELECT id_orden, estado FROM ordenes_servicio WHERE id_orden = $1`,
            [idOrden]
        );

        if (resultadoOrden.rows.length === 0) {
            return res.status(404).json({ error: 'La orden no existe' });
        }

        const listaNovedades = Object.entries(novedades || {});

        for (const [idHerramienta, estadoNovedad] of listaNovedades) {
            if (estadoNovedad === 'OK') {
                // OK: Devuelve 1 unidad a disponibles
                await db.query(
                    `UPDATE inventario_uso_servicio
                     SET disponibles = disponibles + 1
                     WHERE id = $1`,
                    [idHerramienta]
                );
            } else if (estadoNovedad === 'DAÑO') {
                // DAÑO: No devuelve a disponibles, lo manda al historial
                await db.query(
                    `INSERT INTO historial_reparaciones (herramienta_id, cantidad, estado_proceso, observaciones, tecnico_encargado)
                     VALUES ($1, 1, 'EN_REPARACION', 'Reportado en reingreso de ${idOrden}', 'Sistema')`,
                    [idHerramienta]
                );
                // OJO: No tocamos estado ni disponibles aquí, ya se descontó al salir
            } else if (estadoNovedad === 'PERDIDA') {
                // PERDIDA: Resta 1 del total y lo registra como baja
                await db.query('BEGIN');
                await db.query(
                    `UPDATE inventario_uso_servicio
                     SET stock_total = GREATEST(0, stock_total - 1)
                     WHERE id = $1`,
                    [idHerramienta]
                );
                await db.query(
                    `INSERT INTO historial_reparaciones (herramienta_id, cantidad, estado_proceso, observaciones, tecnico_encargado)
                     VALUES ($1, 1, 'DADO_BAJA', 'Perdida en orden ${idOrden}', 'Sistema')`,
                    [idHerramienta]
                );
                await db.query('COMMIT');
            }
        }

        await db.query(
            `UPDATE ordenes_servicio SET estado = 'FINALIZADA' WHERE id_orden = $1`,
            [idOrden]
        );

        console.log(`✅ Orden ${idOrden} finalizada correctamente.`);
        res.json({ success: true, message: 'Reingreso procesado exitosamente' });

    } catch (error) {
        await db.query('ROLLBACK').catch(()=>{});
        console.error('❌ Error al procesar el reingreso:', error);
        res.status(500).json({
            error: 'Error interno al procesar el reingreso',
            detalle: error.message
        });
    }
});

// =================================================================
//      ENCENDIDO DEL SERVIDOR Y CAPTURADORES de EMERGENCIA
// =================================================================
// ENDPOINT AUXILIAR: Trae los productos de venta para los selectores del frontend
app.get('/api/preventa/productos-lista', async (req, res) => {
    try {
        // CORRECCIÓN: Usamos exactamente "inventario_venta"
        const { rows } = await db.query('SELECT id, nombre, stock, costo, precio_venta FROM inventario_venta'); 
        
        res.json(rows);
    } catch (error) {
        console.error('Error en productos-lista:', error);
        res.status(500).json({ error: 'Error al obtener productos' });
    }
});
// =================================================================
//   ENDPOINTS PARA SERVICIOS
// =====================================================

/// ==========================================
// OBTENER ÓRDENES ACTIVAS (SOLO BD)
// ==========================================
// OBTENER ÓRDENES ACTIVAS
app.get('/api/servicios/ordenes-activas', async (req, res) => {
    console.log('📋 Consultando órdenes activas...');
    
    try {
        // En Postgres, guardamos el objeto de respuesta completo (resultado)
        const resultado = await db.query(
            `SELECT 
                id_orden, 
                lugartrabajo, 
                fecha_creacion, 
                estado,
                total_herramientas
             FROM ordenes_servicio 
             WHERE estado IN ('ACTIVA', 'EN_CAMPO')
             ORDER BY fecha_creacion DESC`
        );

        // En Postgres, las filas reales de la consulta están en resultado.rows
        const ordenesBD = resultado.rows || [];

        console.log(`📊 Encontradas ${ordenesBD.length} órdenes activas`);

        const ordenesFormateadas = ordenesBD.map(o => ({
            idOrden: o.id_orden,
            lugartrabajo: o.lugartrabajo,
            fechaCreacion: o.fecha_creacion ? new Date(o.fecha_creacion).toLocaleString('es-CO') : 'Sin fecha',
            estado: o.estado,
            totalHerramientas: o.total_herramientas || 0
        }));

        res.json({ ordenes: ordenesFormateadas });

    } catch (error) {
        console.error('❌ Error en órdenes activas:', error);
        res.status(500).json({ 
            error: 'Error al cargar órdenes activas',
            detalle: error.message 
        });
    }
});
/// =================================================================
//   ENDPOINTS PARA ESTADÍSTICAS DEL PANEL (SOLO VENTAS)
// =================================================================

// 📊 1. TOTAL DE PRODUCTOS EN INVENTARIO
app.get('/api/ventas/total-productos', async (req, res) => {
    try {
        // Cuenta el total de productos registrados en el inventario
        const { rows } = await db.query('SELECT COUNT(*) as total FROM inventario_venta');
        const total = parseInt(rows[0].total, 10) || 0;
        res.json({ total });
    } catch (error) {
        console.error("Error en total-productos:", error);
        res.status(500).json({ error: error.message });
    }
});

// ⚠️ 2. PRODUCTOS CON STOCK BAJO (Alertas de Stock)
app.get('/api/ventas/stock-bajo', async (req, res) => {
    try {
        // Cuenta cuántos productos tienen stock menor o igual a 5 (ajusta este número si usas otro límite)
        const { rows } = await db.query('SELECT COUNT(*) as total FROM inventario_venta WHERE stock <= 5');
        const total = parseInt(rows[0].total, 10) || 0;
        res.json({ total });
    } catch (error) {
        console.error("Error en stock-bajo:", error);
        res.status(500).json({ error: error.message });
    }
});

// 💰 3. VENTAS DE HOY (Suma de las ventas reales realizadas hoy)
app.get('/api/ventas/ventas-hoy', async (req, res) => {
    try {
        // Obtenemos el inicio del día de hoy en hora local/UTC
        const inicioHoy = new Date();
        inicioHoy.setHours(0, 0, 0, 0);

        // Si tienes una tabla de "ventas" o "facturas", haz la consulta allí. 
        // Si acumulas las ventas en las remisiones cerradas, podemos sumar el total de ventas de hoy:
        const query = `
            SELECT COALESCE(SUM(cantidad_vendida * precio_venta_unidad), 0) as total 
            FROM remisiones_productos rp
            JOIN remisiones r ON rp.id_remision = r.id_remision
            WHERE r.fecha_creacion >= $1
        `;
        
        const { rows } = await db.query(query, [inicioHoy]);
        const total = parseFloat(rows[0].total) || 0;
        res.json({ total });
    } catch (error) {
        console.error("Error en ventas-hoy:", error);
        res.status(500).json({ error: error.message });
    }
});
// 📋 4. TOTAL DE REMISIONES ACTIVAS (Para la estadística del dashboard)
app.get('/api/ventas/remisiones-activas', async (req, res) => {
    try {
        // Cuenta cuántas remisiones tienen estado 'ACTIVA' en Supabase
        const { rows } = await db.query("SELECT COUNT(*) as total FROM remisiones WHERE estado = 'ACTIVA'");
        const total = parseInt(rows[0].total, 10) || 0;
        res.json({ total });
    } catch (error) {
        console.error("Error en remisiones-activas estadistica:", error);
        res.status(500).json({ error: error.message });
    }
});
// =================================================================
// OBTENER UNA ORDEN DE SERVICIO ESPECÍFICA
// =================================================================
app.get('/api/servicios/orden/:idOrden', async (req, res) => {
    const { idOrden } = req.params;
    console.log(`🔍 Consultando detalles de la orden: ${idOrden}`);

    try {
        // 1. Consultamos los datos generales de la orden (Sin usar [ordenRows] para Postgres)
        const resultadoOrden = await db.query(
            `SELECT id_orden, lugartrabajo, estado 
             FROM ordenes_servicio 
             WHERE id_orden = $1`, 
            [idOrden]
        );

        const ordenRows = resultadoOrden.rows || [];

        if (ordenRows.length === 0) {
            return res.status(404).json({ error: "Orden no encontrada" });
        }

        const orden = ordenRows[0];

        // 2. Traemos las herramientas unidas relacionalmente (Sin desestructuración array)
        const resultadoHerramientas = await db.query(
            `SELECT h.id, h.nombre 
             FROM ordenes_servicio_herramientas oh
             JOIN inventario_uso_servicio h ON oh.id_herramienta = h.id
             WHERE oh.id_orden = $1`,
            [idOrden]
        );

        const herramientasRows = resultadoHerramientas.rows || [];

        // Mapeamos las herramientas de forma segura
        const herramientasAsignadas = herramientasRows.map(h => ({
            id: h.id,
            nombre: h.nombre
        }));

        // Devolvemos la estructura exacta que tu frontend espera leer
        res.json({
            idOrden: orden.id_orden,
            lugartrabajo: orden.lugartrabajo, // Se usa el lugar de trabajo como responsable en la interfaz
            estado: orden.estado,
            herramientasAsignadas: herramientasAsignadas
        });

    } catch (error) {
        console.error("❌ Error al obtener detalles de la orden:", error);
        res.status(500).json({ 
            error: "Error interno del servidor al consultar detalles de la orden", 
            detalle: error.message 
        });
    }
});
// ==========================================
// INVENTARIO DE SERVICIOS (HERRAMIENTAS)
// ==========================================

// 📦 OBTENER TODO EL INVENTARIO DE HERRAMIENTAS
app.get('/api/servicios/inventario', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM inventario_uso_servicio ORDER BY nombre');
        res.json(rows);
    } catch (error) {
        console.error('Error al leer inventario:', error);
        res.status(500).json({ error: 'Error al leer el inventario' });
    }
});

// 🛠️ OBTENER HERRAMIENTAS ACTIVAS EN TALLER (Consultando el Historial)
// 📋 VER HERRAMIENTAS ACTIVAS EN TALLER (Desde el historial)
app.get('/api/servicios/herramientas-reparacion', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT h.id as registro_id, i.id as id, i.nombre, h.cantidad, h.estado_proceso as estado, h.observaciones, h.fecha_ingreso
             FROM historial_reparaciones h
             JOIN inventario_uso_servicio i ON h.herramienta_id = i.id
             WHERE h.estado_proceso = 'EN_REPARACION'
             ORDER BY h.fecha_ingreso DESC`
        );
        res.json({ herramientas: rows });
    } catch (error) {
        console.error('Error al obtener herramientas en reparación:', error);
        res.status(500).json({ error: "Error al consultar herramientas" });
    }
});

// 🔍 HERRAMIENTA ESPECÍFICA
app.get('/api/servicios/herramienta/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, nombre, disponibles FROM inventario_uso_servicio WHERE id = $1',
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "No encontrada" });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: "Error al consultar herramienta" });
    }
});
// 🔧 ENVIAR HERRAMIENTA A REPARACIÓN (Resta 1 unidad e ingresa al historial)
app.post('/api/servicios/enviar-reparacion', async (req, res) => {
    const { herramientaId, observaciones, tecnico } = req.body;

    try {
        // 1. Verificar si hay stock disponible para enviar a reparar
        const { rows } = await db.query(
            'SELECT nombre, disponibles FROM inventario_uso_servicio WHERE id = $1',
            [herramientaId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        const herramienta = rows[0];

        if (herramienta.disponibles < 1) {
            return res.status(400).json({ error: `No hay unidades disponibles de "${herramienta.nombre}" para enviar a reparación.` });
        }

        // 2. Transacción en lote: Restar de disponibles e insertar en el historial
        await db.query('BEGIN');

        // Restamos solo 1 unidad del stock disponible
        await db.query(
            'UPDATE inventario_uso_servicio SET disponibles = disponibles - 1 WHERE id = $1',
            [herramientaId]
        );

        // Registramos la entrada en el taller en la nueva tabla
        await db.query(
            `INSERT INTO historial_reparaciones (herramienta_id, cantidad, estado_proceso, observaciones, tecnico_encargado)
             VALUES ($1, 1, 'EN_REPARACION', $2, $3)`,
            [herramientaId, observaciones || 'Envío a mantenimiento', tecnico || 'Administrador']
        );

        await db.query('COMMIT');

        res.json({ mensaje: `1 unidad de "${herramienta.nombre}" enviada a reparación.` });

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error al enviar a reparación:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// 🏁 PROCESAR REPARACIÓN (Actualiza el historial y devuelve/baja el stock)
app.post('/api/servicios/procesar-reparacion', async (req, res) => {
    const { herramientaId, estadoFinal, observaciones, tecnico } = req.body;

    if (!herramientaId || !estadoFinal) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        // 1. Buscar si hay una reparación activa para esta herramienta en el historial
        const { rows: reparacionRows } = await db.query(
            `SELECT id FROM historial_reparaciones 
             WHERE herramienta_id = $1 AND estado_proceso = 'EN_REPARACION' 
             ORDER BY fecha_ingreso ASC LIMIT 1`,
            [herramientaId]
        );

        if (reparacionRows.length === 0) {
            return res.status(404).json({ error: "No se encontró ningún registro activo en taller para esta herramienta." });
        }

        const reparacionId = reparacionRows[0].id;

        await db.query('BEGIN');

        if (estadoFinal === 'REPARADO') {
            // Devuelve la unidad al stock disponible e incrementa el stock total
            await db.query(
                `UPDATE inventario_uso_servicio 
                 SET disponibles = disponibles + 1, 
                     observaciones = COALESCE(observaciones, '') || ' - Reparado: ' || $1 || ' - ' || TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
                 WHERE id = $2`,
                [observaciones || 'Reparación completada', herramientaId]
            );

            // Actualiza el historial
            await db.query(
                `UPDATE historial_reparaciones 
                 SET estado_proceso = 'REPARADO', fecha_salida = NOW(), observaciones = $1, tecnico_encargado = $2
                 WHERE id = $3`,
                [observaciones || 'Se reparó con éxito', tecnico || 'Administrador', reparacionId]
            );

        } else if (estadoFinal === 'NO_REPARABLE') {
            // Como no se reparó, la unidad ya se restó de disponibles antes. 
            // Solo reducimos el stock total (ya que ya no existe físicamente en el taller)
            await db.query(
                `UPDATE inventario_uso_servicio 
                 SET stock_total = GREATEST(0, stock_total - 1), 
                     observaciones = COALESCE(observaciones, '') || ' - Baja: ' || $1 || ' - ' || TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
                 WHERE id = $2`,
                [observaciones || 'Dada de baja definitiva', herramientaId]
            );

            // Actualiza el historial a 'DADO_BAJA'
            await db.query(
                `UPDATE historial_reparaciones 
                 SET estado_proceso = 'DADO_BAJA', fecha_salida = NOW(), observaciones = $1, tecnico_encargado = $2
                 WHERE id = $3`,
                [observaciones || 'No tuvo reparación, chatarrizado', tecnico || 'Administrador', reparacionId]
            );
        }

        await db.query('COMMIT');

        res.json({ mensaje: `Procesamiento completado con éxito como: ${estadoFinal}` });

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error al procesar reparación:', error);
        res.status(500).json({ error: "Error interno al procesar la reparación" });
    }
});
// =================================================================
//   AUTENTICACIÓN DE USUARIOS
// =================================================================

// Verificar código de usuario
app.post('/api/auth/verificar', async (req, res) => {
    const { codigo } = req.body;

    if (!codigo) {
        return res.status(400).json({ error: "Debe ingresar un código." });
    }

    try {
        // CORRECCIÓN: Volvemos a colocar 'activo = 1' porque tu columna en Supabase es 'int4' (entero)
        const { rows } = await db.query(
            'SELECT id, nombre, codigo, rol FROM usuarios WHERE codigo = $1 AND activo = 1',
            [codigo]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: "Código incorrecto o usuario inactivo." });
        }

        const usuario = rows[0];
        
        res.json({
            valido: true,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                codigo: usuario.codigo,
                rol: usuario.rol
            }
        });

    } catch (error) {
        console.error('Error al verificar usuario:', error);
        res.status(500).json({ error: "Error interno al verificar." });
    }
});
// =================================================================
//   REPORTES DE COSTOS VS UTILIDAD
// =================================================================

app.post('/api/reportes/costos-utilidad', async (req, res) => {
    console.log('📊 Recibida solicitud de reporte');
    console.log('📦 Body:', req.body);

    const { periodo, fecha_inicio, fecha_fin } = req.body;

    if (!periodo || !fecha_inicio || !fecha_fin) {
        console.log('❌ Faltan parámetros');
        return res.status(400).json({ error: "Faltan parámetros: periodo, fecha_inicio, fecha_fin" });
    }

    try {
        // 1. Obtener ventas del periodo
        const [ventas] = await db.query(
            `SELECT 
                COUNT(*) as total_ventas,
                SUM(cantidad) as total_unidades,
                SUM(total) as total_ingresos
             FROM ventas_individuales 
             WHERE fecha_venta BETWEEN ? AND ?`,
            [fecha_inicio, fecha_fin]
        );

        console.log('📊 Ventas encontradas:', ventas);

        // 2. Obtener costos
        const [costos] = await db.query(
            `SELECT 
                SUM(rp.cantidad_vendida * rp.costo_unidad) as total_costos
             FROM remisiones_productos rp
             INNER JOIN ventas_individuales vi ON rp.id_remision = vi.id_remision AND rp.id_producto = vi.id_producto
             WHERE vi.fecha_venta BETWEEN ? AND ?`,
            [fecha_inicio, fecha_fin]
        );

        console.log('📊 Costos encontrados:', costos);

        // 3. Obtener remisiones cerradas
        const [remisiones] = await db.query(
            `SELECT COUNT(*) as total_remisiones 
             FROM remisiones 
             WHERE estado = 'CERRADA' 
             AND fecha_creacion BETWEEN ? AND ?`,
            [fecha_inicio, fecha_fin]
        );

        // 4. Calcular utilidad
        const totalIngresos = parseFloat(ventas[0]?.total_ingresos || 0);
        const totalCostos = parseFloat(costos[0]?.total_costos || 0);
        const utilidad = totalIngresos - totalCostos;
        const margen = totalIngresos > 0 ? (utilidad / totalIngresos) * 100 : 0;

        // 5. Productos más vendidos
        const [topProductos] = await db.query(
            `SELECT 
                nombre_producto,
                SUM(cantidad) as total_vendido,
                SUM(total) as total_ingreso
             FROM ventas_individuales 
             WHERE fecha_venta BETWEEN ? AND ?
             GROUP BY nombre_producto
             ORDER BY total_vendido DESC
             LIMIT 5`,
            [fecha_inicio, fecha_fin]
        );

        console.log('📊 Top productos:', topProductos);

        res.json({
            periodo: periodo,
            fecha_inicio: fecha_inicio,
            fecha_fin: fecha_fin,
            resumen: {
                total_ventas: parseInt(ventas[0]?.total_ventas || 0),
                total_unidades: parseInt(ventas[0]?.total_unidades || 0),
                total_ingresos: totalIngresos,
                total_costos: totalCostos,
                utilidad: utilidad,
                margen: margen,
                total_remisiones: parseInt(remisiones[0]?.total_remisiones || 0)
            },
            top_productos: topProductos || []
        });

    } catch (error) {
        console.error('❌ Error al generar reporte:', error);
        res.status(500).json({ 
            error: "Error al generar el reporte", 
            detalle: error.message,
            stack: error.stack 
        });
    }
});
// =================================================================
//   DETALLE DE VENTAS POR PERIODO
// =================================================================

app.post('/api/reportes/ventas-detalle', async (req, res) => {
    const { fecha_inicio, fecha_fin } = req.body;

    if (!fecha_inicio || !fecha_fin) {
        return res.status(400).json({ error: "Faltan fechas" });
    }

    try {
        const [ventas] = await db.query(
            `SELECT 
                id_remision,
                nombre_producto,
                cantidad,
                precio_unitario,
                total,
                vendedor,
                fecha_venta
             FROM ventas_individuales 
             WHERE fecha_venta BETWEEN ? AND ?
             ORDER BY fecha_venta DESC`,
            [fecha_inicio, fecha_fin]
        );

        res.json({ ventas });

    } catch (error) {
        console.error('Error al obtener detalle:', error);
        res.status(500).json({ error: "Error al obtener detalle de ventas" });
    }
});
// 🧾 VENTA MÚLTIPLE (VARIOS PRODUCTOS EN UN SOLO RECIBO)
app.post('/api/preventa/venta-multiple', async (req, res) => {
    console.log('📥 Solicitud recibida en /api/preventa/venta-multiple');
    console.log('📦 Body:', req.body);
    
    const { idRemision, productos, vendedor } = req.body;
    let remision = remisionesVentaActivas[idRemision];

    if (!remision) {
        return res.status(404).json({ error: "Remisión no encontrada." });
    }

    if (!productos || productos.length === 0) {
        return res.status(400).json({ error: "No se enviaron productos." });
    }

    try {
        const resultados = [];
        let totalVenta = 0;

        for (const prod of productos) {
            const idProducto = parseInt(prod.idProducto);
            const cantidad = parseInt(prod.cantidad);
            const precio = parseFloat(prod.precioUnitario);
            const total = cantidad * precio;

            // Buscar el producto en la remisión
            let item = remision.productos.find(p => p.idProducto === idProducto);
            if (!item) {
                return res.status(404).json({ error: `Producto ${idProducto} no encontrado en la remisión.` });
            }

            // Verificar stock disponible en el camión
            let disponible = item.cantidadCargadaInicial - item.cantidadVendidaEnCalle;
            if (cantidad > disponible) {
                return res.status(400).json({ 
                    error: `Stock insuficiente para ${item.nombre}. Disponible: ${disponible}` 
                });
            }

            // Actualizar en memoria
            item.cantidadVendidaEnCalle += cantidad;
            item.precioVentaRealCalle = precio;

            // Guardar en BD
            await db.query(
                `INSERT INTO ventas_individuales 
                 (id_remision, id_producto, nombre_producto, cantidad, precio_unitario, total, vendedor, fecha_venta) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [idRemision, idProducto, item.nombre, cantidad, precio, total, vendedor || 'Sistema']
            );

            await db.query(
                'UPDATE remisiones_productos SET cantidad_vendida = cantidad_vendida + ? WHERE id_remision = ? AND id_producto = ?',
                [cantidad, idRemision, idProducto]
            );

            await db.query(
                'UPDATE remisiones SET total_ventas = total_ventas + ? WHERE id_remision = ?',
                [total, idRemision]
            );

            resultados.push({ 
                nombre: item.nombre, 
                cantidad: cantidad, 
                precio: precio, 
                total: total 
            });
            totalVenta += total;
        }

        // Recalcular preFactura
        let totalVentas = 0;
        let totalCostos = 0;
        remision.productos.forEach(p => {
            totalVentas += p.cantidadVendidaEnCalle * (p.precioVentaRealCalle || p.precioVentaUnidadFijo);
            totalCostos += p.cantidadVendidaEnCalle * p.costoUnidadFijo;
        });
        remision.preFactura = {
            totalVentasEmitidas: totalVentas,
            totalCostosOperativos: totalCostos,
            gananciaPreviaCalculada: totalVentas - totalCostos
        };

        console.log('✅ Venta múltiple registrada:', resultados);
        console.log('💰 Total:', totalVenta);

        res.json({
            mensaje: `Venta múltiple registrada con ${resultados.length} productos.`,
            productos: resultados,
            totalVenta: totalVenta
        });

    } catch (error) {
        console.error('❌ Error en venta múltiple:', error);
        res.status(500).json({ 
            error: 'Error al procesar venta múltiple',
            detalle: error.message 
        });
    }
});
// ==========================================
// LOGS PARA REPORTES
// ==========================================
app.use((req, res, next) => {
    console.log(`📡 ${req.method} ${req.url} - IP: ${req.ip}`);
    next();
});

app.post('/api/reportes/costos-utilidad', async (req, res) => {
    console.log('📊 Reporte solicitado');
    console.log('📦 Body:', req.body);
    
    // ... resto del código del reporte
});
// =================================================================
//   MÓDULO FINANCIERO
// =================================================================

// 1. Obtener resumen financiero
app.get('/api/financiero/resumen', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM balance_financiero ORDER BY id DESC LIMIT 1');
        if (rows.length === 0) {
            return res.json({ total_ganado: 0, total_reinvertido: 0, total_disponible: 0 });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Error al obtener resumen:', error);
        res.status(500).json({ error: 'Error al obtener resumen financiero' });
    }
});

// 2. Registrar movimiento
app.post('/api/financiero/registrar', async (req, res) => {
    const { tipo, monto, descripcion } = req.body;

    if (!tipo || !monto || monto <= 0) {
        return res.status(400).json({ error: 'Datos incompletos' });
    }

    try {
        // Registrar movimiento
        await db.query(
            `INSERT INTO movimientos_financieros (tipo, monto, descripcion, fecha_movimiento, usuario) 
             VALUES (?, ?, ?, NOW(), ?)`,
            [tipo, monto, descripcion || '', 'Sistema']
        );

        // Actualizar balance
        const [balance] = await db.query('SELECT * FROM balance_financiero ORDER BY id DESC LIMIT 1');
        let total_ganado = parseFloat(balance[0].total_ganado || 0);
        let total_reinvertido = parseFloat(balance[0].total_reinvertido || 0);

        if (tipo === 'UTILIDAD') {
            total_ganado += monto;
        } else if (tipo === 'REINVERSION') {
            total_reinvertido += monto;
        }

        const total_disponible = total_ganado - total_reinvertido;

        await db.query(
            `UPDATE balance_financiero SET total_ganado = ?, total_reinvertido = ?, total_disponible = ?, ultima_actualizacion = NOW() 
             WHERE id = ?`,
            [total_ganado, total_reinvertido, total_disponible, balance[0].id]
        );

        res.json({ mensaje: 'Movimiento registrado exitosamente' });
    } catch (error) {
        console.error('Error al registrar movimiento:', error);
        res.status(500).json({ error: 'Error al registrar movimiento' });
    }
});

// 3. Reinvertir utilidad
app.post('/api/financiero/reinvertir', async (req, res) => {
    const { monto, descripcion } = req.body;

    if (!monto || monto <= 0) {
        return res.status(400).json({ error: 'Monto inválido' });
    }

    try {
        const [balance] = await db.query('SELECT * FROM balance_financiero ORDER BY id DESC LIMIT 1');
        const total_disponible = parseFloat(balance[0].total_disponible || 0);

        if (monto > total_disponible) {
            return res.status(400).json({ error: 'No tienes suficiente disponible para reinvertir' });
        }

        // Registrar reinversión
        await db.query(
            `INSERT INTO movimientos_financieros (tipo, monto, descripcion, fecha_movimiento, usuario) 
             VALUES ('REINVERSION', ?, ?, NOW(), ?)`,
            [monto, descripcion || 'Reinversión de utilidad', 'Sistema']
        );

        // Actualizar balance
        let total_reinvertido = parseFloat(balance[0].total_reinvertido || 0) + monto;
        let total_ganado = parseFloat(balance[0].total_ganado || 0);
        const nuevo_disponible = total_ganado - total_reinvertido;

        await db.query(
            `UPDATE balance_financiero SET total_reinvertido = ?, total_disponible = ?, ultima_actualizacion = NOW() 
             WHERE id = ?`,
            [total_reinvertido, nuevo_disponible, balance[0].id]
        );

        res.json({ mensaje: 'Reinversión registrada exitosamente' });
    } catch (error) {
        console.error('Error al reinvertir:', error);
        res.status(500).json({ error: 'Error al procesar reinversión' });
    }
});

// 4. Historial de movimientos
app.get('/api/financiero/historial', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT * FROM movimientos_financieros ORDER BY fecha_movimiento DESC LIMIT 100'
        );
        res.json({ movimientos: rows });
    } catch (error) {
        console.error('Error al obtener historial:', error);
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

// 5. Reporte por periodo
// 5. Reporte por periodo (CON DETALLE)
app.post('/api/financiero/reporte-periodo', async (req, res) => {
    const { periodo, fecha_inicio, fecha_fin } = req.body;

    if (!fecha_inicio || !fecha_fin) {
        return res.status(400).json({ error: 'Fechas requeridas' });
    }

    try {
        // 1. Totales
        const [result] = await db.query(
            `SELECT 
                SUM(CASE WHEN tipo = 'UTILIDAD' THEN monto ELSE 0 END) as total_utilidad,
                SUM(CASE WHEN tipo = 'REINVERSION' THEN monto ELSE 0 END) as total_reinversion
             FROM movimientos_financieros
             WHERE DATE(fecha_movimiento) BETWEEN ? AND ?`,
            [fecha_inicio, fecha_fin]
        );

        // 2. Detalle de movimientos (NUEVO)
        const [movimientos] = await db.query(
            `SELECT 
                tipo,
                monto,
                descripcion,
                fecha_movimiento,
                usuario
             FROM movimientos_financieros
             WHERE DATE(fecha_movimiento) BETWEEN ? AND ?
             ORDER BY fecha_movimiento DESC`,
            [fecha_inicio, fecha_fin]
        );

        const total_utilidad = parseFloat(result[0].total_utilidad || 0);
        const total_reinversion = parseFloat(result[0].total_reinversion || 0);
        const balance = total_utilidad - total_reinversion;

        res.json({
            periodo: periodo,
            fecha_inicio: fecha_inicio,
            fecha_fin: fecha_fin,
            total_utilidad,
            total_reinversion,
            balance,
            movimientos: movimientos  // 👈 NUEVO: Lista de movimientos
        });
    } catch (error) {
        console.error('Error al generar reporte financiero:', error);
        res.status(500).json({ error: 'Error al generar reporte' });
    }
});

// =================================================================
//   AGENDAMIENTO DE SERVICIOS (SOPORTE POSTGRESQL / SUPABASE)
// =================================================================

// Obtener agendamientos
app.get('/api/servicios/agendamientos', async (req, res) => {
    const { estado } = req.query;
    let query = 'SELECT * FROM agendamientos';
    let params = [];

    if (estado && estado !== 'TODOS') {
        query += ' WHERE estado = $1';
        params.push(estado);
    }

    query += ' ORDER BY fecha ASC, hora ASC';

    try {
        const { rows } = await db.query(query, params);
        res.json({ agendamientos: rows });
    } catch (error) {
        console.error('Error al obtener agendamientos:', error);
        res.status(500).json({ error: 'Error al obtener agendamientos' });
    }
});

// Crear agendamiento (Solución Definitiva para PostgreSQL / Supabase)
app.post('/api/servicios/agendar', async (req, res) => {
    // Extraemos los datos que vienen del frontend
    const { cliente, tipo_servicio, fecha, hora, tecnico, observaciones, valor, usuario } = req.body;

    // 1. Validar estrictamente los campos obligatorios
    if (!cliente || !tipo_servicio || !fecha || !hora) {
        return res.status(400).json({ 
            error: 'Faltan datos obligatorios: cliente, tipo_servicio, fecha y hora son necesarios.' 
        });
    }

    // 2. Limpiar y asegurar el valor numérico (si viene vacío, NaN o undefined, forzar 0)
    let valorNumerico = 0;
    if (valor !== undefined && valor !== null && valor !== '') {
        const parseado = parseFloat(valor);
        if (!isNaN(parseado)) {
            valorNumerico = parseado;
        }
    }

    // 3. Forzar valores por defecto si vienen vacíos para evitar que Postgres falle
    const tecnicoLimpio = (tecnico && tecnico.trim() !== '') ? tecnico.trim() : 'Sin asignar';
    const obsLimpias = (observaciones && observaciones.trim() !== '') ? observaciones.trim() : 'Sin observaciones';
    const usuarioLimpio = (usuario && usuario.trim() !== '') ? usuario.trim() : 'Sistema';
    const estadoInicial = 'PENDIENTE';

    try {
        // Ejecutar la consulta con parámetros limpios
        await db.query(
            `INSERT INTO agendamientos 
             (cliente, tipo_servicio, fecha, hora, tecnico, observaciones, estado, usuario_creacion, valor) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                cliente.trim(), 
                tipo_servicio, 
                fecha, 
                hora, 
                tecnicoLimpio, 
                obsLimpias, 
                estadoInicial, 
                usuarioLimpio, 
                valorNumerico
            ]
        );
        
        res.json({ mensaje: 'Servicio agendado exitosamente' });

    } catch (error) {
        // Esto se pintará en los logs de Railway para saber qué falló con exactitud
        console.error('--- ERROR CRÍTICO AL AGENDAR EN SUPABASE ---');
        console.error('Mensaje de error:', error.message);
        console.error('Código de error Postgres:', error.code);
        console.error('Detalle:', error.detail);
        console.error('Estructura enviada:', {
            cliente, tipo_servicio, fecha, hora, tecnicoLimpio, obsLimpias, estadoInicial, usuarioLimpio, valorNumerico
        });
        console.error('--------------------------------------------');
        
        res.status(500).json({ 
            error: 'Error interno al guardar en Supabase', 
            detalle: error.message 
        });
    }
});
// Actualizar/Editar/Liquidar agendamiento
app.put('/api/servicios/agendamiento/:id', async (req, res) => {
    const { id } = req.params;
    const { cliente, tipo_servicio, fecha, hora, tecnico, observaciones, valor } = req.body;

    if (!cliente || !tipo_servicio || !fecha || !hora) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    try {
        const { rowCount } = await db.query(
            `UPDATE agendamientos 
             SET cliente = $1, tipo_servicio = $2, fecha = $3, hora = $4, tecnico = $5, observaciones = $6, valor = $7
             WHERE id = $8`,
            [cliente, tipo_servicio, fecha, hora, tecnico, observaciones, valor || 0, id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Agendamiento no encontrado' });
        }

        res.json({ mensaje: 'Agendamiento actualizado exitosamente' });
    } catch (error) {
        console.error('Error al actualizar agendamiento:', error);
        res.status(500).json({ error: 'Error al actualizar agendamiento' });
    }
});

// Completar, Liquidar y reasignar Técnico en agendamiento (Supabase / Postgres)
app.put('/api/servicios/agendamiento/:id/completar', async (req, res) => {
    const { id } = req.params;
    const { valor, observaciones, tecnico } = req.body;

    const valorNumerico = isNaN(parseFloat(valor)) ? 0.00 : parseFloat(valor);
    const tecnicoFinal = (tecnico && tecnico.trim() !== '') ? tecnico.trim() : 'Sin asignar';

    try {
        const { rowCount } = await db.query(
            `UPDATE agendamientos 
             SET estado = 'COMPLETADO', valor = $1, observaciones = $2, tecnico = $3
             WHERE id = $4`,
            [valorNumerico, observaciones || null, tecnicoFinal, id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Agendamiento no encontrado' });
        }

        res.json({ mensaje: 'Servicio completado exitosamente' });
    } catch (error) {
        console.error('Error al completar y liquidar:', error);
        res.status(500).json({ error: 'Error al completar y liquidar el servicio' });
    }
});

// Cancelar agendamiento
app.put('/api/servicios/agendamiento/:id/cancelar', async (req, res) => {
    const { id } = req.params;

    try {
        const { rowCount } = await db.query(
            "UPDATE agendamientos SET estado = 'CANCELADO' WHERE id = $1",
            [id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Agendamiento no encontrado' });
        }

        res.json({ mensaje: 'Servicio cancelado' });
    } catch (error) {
        console.error('Error al cancelar:', error);
        res.status(500).json({ error: 'Error al cancelar servicio' });
    }
});
// =================================================================
// MÓDULO DE INVENTARIO - VERSIÓN LIMPIA POSTGRESQL
// =================================================================
app.get('/api/inventario', async (req, res) => {
  try {
    const buscar = req.query.buscar || req.query.q || '';
    const tipo = (req.query.tipo || 'VENTA').toUpperCase();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const buscarParam = `%${buscar}%`;

    // TODOS: combina inventario_venta + inventario_uso_servicio con paginación real
    if (tipo === 'TODOS') {
      const dataRes = await db.query(`
        SELECT *, COUNT(*) OVER() AS total_count FROM (
          SELECT id, nombre, 'VENTA' AS tipo, stock, costo, precio_venta,
                 'DISPONIBLE'::varchar AS estado
          FROM inventario_venta
          WHERE nombre ILIKE $1
          UNION ALL
          SELECT id, nombre, 'SERVICIO' AS tipo, disponibles AS stock,
                 NULL::numeric AS costo, NULL::numeric AS precio_venta, estado
          FROM inventario_uso_servicio
          WHERE nombre ILIKE $1
        ) combinado
        ORDER BY nombre ASC, id ASC
        LIMIT $2 OFFSET $3
      `, [buscarParam, limit, offset]);

      const total = dataRes.rows.length > 0 ? parseInt(dataRes.rows[0].total_count) : 0;
      const productos = dataRes.rows.map(({ total_count, ...resto }) => resto);

      return res.json({
        tipo,
        productos,
        paginacion: {
          pagina_actual: page,
          total_paginas: Math.ceil(total / limit),
          total_productos: total,
          por_pagina: limit
        }
      });
    }

    // Selecciona la tabla según el tipo de inventario
    const tabla = tipo === 'SERVICIO' || tipo === 'HERRAMIENTA'
      ? 'inventario_uso_servicio'
      : 'inventario_venta';

    let conditions = [];
    let params = [];
    let idx = 1;

    if (buscar) {
      conditions.push(`nombre ILIKE $${idx}`);
      params.push(`%${buscar}%`);
      idx++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.query(`SELECT COUNT(*) FROM ${tabla} ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count);

    const selectCols = tabla === 'inventario_uso_servicio'
      ? `id, nombre, 'SERVICIO' AS tipo, disponibles AS stock, estado, created_at`
      : `id, nombre, 'VENTA' AS tipo, stock, costo, precio_venta, created_at`;

    const dataRes = await db.query(
      `SELECT ${selectCols} FROM ${tabla} ${whereClause} ORDER BY nombre ASC, id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      tipo,
      productos: dataRes.rows,
      paginacion: {
        pagina_actual: page,
        total_paginas: Math.ceil(total / limit),
        total_productos: total,
        por_pagina: limit
      }
    });

  } catch (error) {
    console.error('Error inventario:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// HISTORIAL - FINAL CON NOMBRES REALES
app.get('/api/inventario/historial', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;
  const q = req.query.q || '';

  try {
    let where = '';
    let params = [];
    if (q) {
      where = `WHERE numero_factura ILIKE $1 OR proveedor ILIKE $1`;
      params.push(`%${q}%`);
    }

    const countRes = await db.query(`SELECT COUNT(*) FROM facturas_compra ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const rowsRes = await db.query(
      `SELECT * FROM facturas_compra ${where} ORDER BY fecha_factura DESC, id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );

    res.json({
      facturas: rowsRes.rows,
      paginacion: { pagina_actual: page, total_paginas: Math.ceil(total/limit), total_facturas: total }
    });
  } catch (e) {
    console.error('Historial error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DETALLE DE FACTURA - FINAL CON NOMBRES REALES
app.get('/api/inventario/factura/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const cab = await db.query(`SELECT * FROM facturas_compra WHERE id = $1`, [id]);
    if (cab.rows.length === 0) return res.status(404).json({ error: 'Factura no encontrada' });

    const det = await db.query(`
      SELECT
        producto_nombre,
        producto_tipo,
        cantidad,
        costo_unitario,
        precio_venta,
        subtotal
      FROM facturas_detalle
      WHERE factura_id = $1
      ORDER BY id ASC
    `, [id]);

    res.json({
      factura: {
        id: cab.rows[0].id,
        numero_factura: cab.rows[0].numero_factura,
        proveedor: cab.rows[0].proveedor,
        fecha: cab.rows[0].fecha_factura,
        fecha_registro: cab.rows[0].fecha_registro,
        usuario: cab.rows[0].usuario,
        total: cab.rows[0].total_compra,
        observaciones: cab.rows[0].observaciones
      },
      detalle: det.rows
    });

  } catch (error) {
    console.error('Detalle error:', error.message);
    res.status(500).json({ error: 'Error al cargar detalle: ' + error.message });
  }
});
// 4. REGISTRAR NUEVA FACTURA DE COMPRA - FALTABA ESTE
app.post('/api/inventario/ingresar', async (req, res) => {
    const { numero_factura, proveedor, fecha_factura, usuario, observaciones, productos } = req.body;
    if (!productos || productos.length === 0) return res.status(400).json({ error: 'Sin productos' });

    try {
        await db.query('BEGIN');
        const total_compra = productos.reduce((acc, p) => acc + (parseInt(p.cantidad) * parseFloat(p.costo)), 0);

        const { rows: facturaRows } = await db.query(`
            INSERT INTO facturas_compra (numero_factura, proveedor, fecha_factura, usuario, total_compra, observaciones)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
        `, [numero_factura, proveedor, fecha_factura || new Date(), usuario || 'Sistema', total_compra, observaciones]);

        const facturaId = facturaRows[0].id;

        for (const prod of productos) {
            await db.query(`
                INSERT INTO facturas_detalle (factura_id, producto_nombre, producto_tipo, cantidad, costo_unitario, precio_venta, subtotal)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [facturaId, prod.nombre, prod.tipo, prod.cantidad, prod.costo, prod.precio_venta, prod.cantidad * prod.costo]);

            if (prod.tipo === 'VENTA') {
                await db.query(`UPDATE inventario_venta SET stock = stock + $1 WHERE id = $2`, [prod.cantidad, prod.id]);
            } else {
                await db.query(`UPDATE inventario_uso_servicio SET stock_total = stock_total + $1, disponibles = disponibles + $1 WHERE id = $2`, [prod.cantidad, prod.id]);
            }
        }

        await db.query('COMMIT');
        res.json({ mensaje: 'Factura registrada', factura_id: facturaId });
    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error ingresar factura:', error);
        res.status(500).json({ error: 'Error al ingresar', detalle: error.message });
    }
});
// 4. REGISTRAR FACTURA - COMPATIBLE CON TU INVENTARIO.HTML
// POST /api/inventario/factura - VERSIÓN AJUSTADA A TUS TABLAS REALES
app.post('/api/inventario/factura', async (req, res) => {
    const { numero, proveedor, fecha, detalles, usuario } = req.body;
    if (!detalles || detalles.length === 0) {
        return res.status(400).json({ error: 'Sin productos en la factura' });
    }
    try {
        await db.query('BEGIN');

        const total_compra = detalles.reduce((acc, p) => acc + (parseInt(p.cantidad) * parseFloat(p.costo)), 0);

        // Ajustado a tu esquema: numero_factura, proveedor, fecha_factura, fecha_registro, usuario, total_compra, observaciones
        const { rows: facturaRows } = await db.query(`
            INSERT INTO facturas_compra (numero_factura, proveedor, fecha_factura, fecha_registro, usuario, total_compra, observaciones)
            VALUES ($1, $2, $3, NOW(), $4, $5, '') RETURNING id
        `, [
            numero || 'S/N',
            proveedor || 'Sin proveedor',
            fecha || new Date().toISOString().split('T')[0],
            usuario || 'Sistema',
            total_compra
        ]);

        const facturaId = facturaRows[0].id;

        for (const prod of detalles) {
            let productoId = prod.id;
            let nombreLimpio = prod.nombre.trim();
            // PRECIO REAL: respeta exactamente lo que escribes en el formulario
            let precioVentaReal = parseFloat(prod.precio_venta || prod.precio || 0) || 0;
            if (precioVentaReal <= 0) precioVentaReal = parseFloat(prod.costo); // sin margen automático

            if (!productoId) {
                if (prod.tipo === 'VENTA') {
                    const { rows } = await db.query(`SELECT id FROM inventario_venta WHERE nombre ILIKE $1 LIMIT 1`, [nombreLimpio]);
                    if (rows.length > 0) {
                        productoId = rows[0].id;
                        await db.query(
                            `UPDATE inventario_venta SET costo = $1, precio_venta = $2 WHERE id = $3`,
                            [parseFloat(prod.costo), precioVentaReal, productoId]
                        );
                    } else {
                        const { rows: newRows } = await db.query(`INSERT INTO inventario_venta (nombre, stock, costo, precio_venta) VALUES ($1, $2, $3, $4) RETURNING id`, [nombreLimpio, 0, prod.costo, precioVentaReal]);
                        productoId = newRows[0].id;
                    }
                } else {
                    const { rows } = await db.query(`SELECT id FROM inventario_uso_servicio WHERE nombre ILIKE $1 LIMIT 1`, [nombreLimpio]);
                    if (rows.length > 0) productoId = rows[0].id;
                    else {
                        const { rows: newRows } = await db.query(`INSERT INTO inventario_uso_servicio (nombre, stock_total, disponibles, estado) VALUES ($1, $2, $2, 'DISPONIBLE') RETURNING id`, [nombreLimpio, 0]);
                        productoId = newRows[0].id;
                    }
                }
            }

            await db.query(`
                INSERT INTO facturas_detalle (factura_id, producto_nombre, producto_tipo, cantidad, costo_unitario, precio_venta, subtotal)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                facturaId,
                nombreLimpio,
                prod.tipo,
                parseInt(prod.cantidad),
                parseFloat(prod.costo),
                precioVentaReal,
                parseInt(prod.cantidad) * parseFloat(prod.costo)
            ]);

            if (prod.tipo === 'VENTA') {
                await db.query(`UPDATE inventario_venta SET stock = stock + $1 WHERE id = $2`, [parseInt(prod.cantidad), productoId]);
            } else {
                await db.query(`UPDATE inventario_uso_servicio SET stock_total = stock_total + $1, disponibles = disponibles + $1 WHERE id = $2`, [parseInt(prod.cantidad), productoId]);
            }
        }

        await db.query('COMMIT');
        res.json({ mensaje: 'Factura registrada', factura_id: facturaId });

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('--- ERROR REAL AL GUARDAR FACTURA ---');
        console.error(error.message);
        console.error(error.detail);
        console.error('------------------------------------');
        res.status(500).json({ error: 'Error al guardar factura', detalle: error.message });
    }
});
const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor de Mecatron Solutions corriendo en'mecatron-solutions-production.up.railway.app;${PORT}`);
});

// Sincronizar contadorRemisiones con la BD al iniciar el servidor (opcional pero recomendable)
(async function syncContadorRemisiones() {
    try {
        const {rows} = await db.query("SELECT id_remision FROM remisiones ORDER BY id_remision DESC LIMIT 1");
        if (rows && rows.length) {
            const last = rows[0].id_remision || '';
            const m = last.match(/(\d+)$/);
            if (m) contadorRemisiones = parseInt(m[1], 10);
        } else {
            contadorRemisiones = 0;
        }
        console.log('contadorRemisiones sincronizado:', contadorRemisiones);
    } catch (e) {
        console.error('No se pudo sincronizar contadorRemisiones:', e);
    }
})();

process.on('unhandledRejection', (reason, promise) => {
    console.error('🛑 ¡Atención! Hubo un error no controlado en el backend:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🛑 El servidor sufrió una excepción y detuvo la marcha:', error);
});