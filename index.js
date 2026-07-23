// =================================================================
//   MECATRON SOLUTIONS - SISTEMA DE CONTROL DE INVENTARIO CENTRAL
//   Desarrollado por: Beltrán Software Solutions
// =================================================================
const express = require('express');
const db = require('./conexion'); 
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({
  origin: true, // Permitir todos los orígenes para desarrollo
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
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
// CORS - Permitir peticiones del frontend (solo una vez)
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

    try {
        // Obtener último ID de remisión
        const { rows: ultimoRegistro } = await db.query(
            'SELECT id_remision FROM remisiones ORDER BY fecha_creacion DESC LIMIT 1'
        );
        
        let nuevoNumero = 1;
        if (ultimoRegistro.length > 0) {
            const ultimoId = ultimoRegistro[0].id_remision;
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

            const costoFijo = Number(prod.costo) || 0;
            const precioFijo = Number(prod.precio_venta) || 0;

            productosValidados.push({
                idProducto: item.idProducto,
                nombre: prod.nombre,
                cantidadSacada: parseInt(item.cantidadSalida, 10),
                cantidadDevuelta: 0, // Inicialmente 0, se actualiza en cierre
                costoUnidadFijo: costoFijo,
                precioVentaUnidadFijo: precioFijo,
                precioVentaRealCalle: 0
            });
        }

        await db.query('BEGIN');

        // Descontar stock
        for (const item of productosValidados) {
            await db.query(
                'UPDATE inventario_venta SET stock = stock - $1 WHERE id = $2',
                [item.cantidadSacada, item.idProducto]
            );
        }

        // Guardar remisión con id_vendedor
        await db.query(
            `INSERT INTO remisiones (id_remision, fecha_creacion, estado, usuario_creacion, id_vendedor) 
             VALUES ($1, $2, $3, $4, $5)`,
            [idRemision, new Date(), 'ACTIVA', usuario || 'Sistema', usuario || 'Sistema']
        );

        // Guardar productos con nuevos nombres de columnas
        for (const item of productosValidados) {
            await db.query(
                `INSERT INTO remisiones_productos 
                 (id_remision, id_producto, nombre, cantidad_sacada, cantidad_devuelta, costo_unidad, precio_venta_unidad) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    idRemision,
                    item.idProducto,
                    item.nombre,
                    item.cantidadSacada,
                    0, // cantidad_devuelta inicial
                    item.costoUnidadFijo,
                    item.precioVentaUnidadFijo
                ]
            );
        }

        await db.query('COMMIT');

        // Guardar en memoria
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
        await db.query('ROLLBACK');
        console.error("Error crítico en salida de preventa:", error);
        res.status(500).json({ error: "Error interno: " + error.message });
    }
});
// Ruta para el listado detallado en ventas.html - FIX REAL TABLA
app.get('/api/preventa/remisiones-activas', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id_remision, total_ventas, fecha_creacion, id_vendedor 
             FROM remisiones WHERE estado = 'ACTIVA' 
             ORDER BY fecha_creacion DESC LIMIT 20`
        );

        const activas = await Promise.all(rows.map(async r => {
            const { rows: prods } = await db.query(
                `SELECT id_producto, nombre, cantidad_sacada, cantidad_devuelta 
                 FROM remisiones_productos WHERE id_remision = $1`,
                [r.id_remision]
            );
            return {
                idRemision: r.id_remision,
                productos: prods.map(p => ({
                    idProducto: p.id_producto,
                    nombre: p.nombre,
                    vendidos: Number(p.cantidad_devuelta || 0), // devuelta = vendida
                    cargados: Number(p.cantidad_sacada || 0)
                })),
                totalVentas: Number(r.total_ventas || 0),
                fechaCreacion: r.fecha_creacion,
                idVendedor: r.id_vendedor || 'Sin asignar'
            };
        }));

        res.json({ activas });
    } catch (e) {
        console.error(e);
        // Fallback a memoria
        res.json({
            activas: Object.values(remisionesVentaActivas).map(r => ({
                idRemision: r.idRemision,
                productos: r.productos.map(p => ({
                    vendidos: p.cantidadVendidaEnCalle || 0,
                    cargados: p.cantidadSacada || 0
                })),
                totalVentas: r.preFactura?.totalVentasEmitidas || 0,
                fechaCreacion: r.fechaCreacion
            }))
        });
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

    let disponibleEnCamion = item.cantidadSacada - (item.cantidadVendidaEnCalle || 0);
    if (cantidadAVender > disponibleEnCamion) {
        return res.status(400).json({ error: `No puede vender más de lo que lleva. Disponible: ${disponibleEnCamion} uds.` });
    }

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
    item.cantidadVendidaEnCalle = (item.cantidadVendidaEnCalle || 0) + cantidad;
    item.precioVentaRealCalle = precio;

    // Recalcular
    let totalVentas = 0;
    let totalCostos = 0;
    remision.productos.forEach(p => {
        totalVentas += (p.cantidadVendidaEnCalle || 0) * (p.precioVentaRealCalle || p.precioVentaUnidadFijo);
        totalCostos += (p.cantidadVendidaEnCalle || 0) * p.costoUnidadFijo;
    });

    remision.preFactura = {
        totalVentasEmitidas: totalVentas,
        totalCostosOperativos: totalCostos,
        gananciaPreviaCalculada: totalVentas - totalCostos
    };

    try {
        await db.query('BEGIN');

        // 1. Crear cabecera de venta contado
        const { rows: cabeceraRows } = await db.query(
            `INSERT INTO ventas_contado_cabecera 
             (id_remision, id_cliente, fecha_venta, total_venta, usuario_creacion, estado) 
             VALUES ($1, NULL, NOW(), $2, $3, 'COMPLETADA') 
             RETURNING id_venta`,
            [idRemision, total, vendedor || 'Sistema']
        );
        const idVentaCabecera = cabeceraRows[0].id_venta;

        // 2. Guardar detalle de venta
        await db.query(
            `INSERT INTO ventas_contado_detalle 
             (id_venta_cabecera, id_producto, nombre_producto, cantidad, precio_unitario, total, fecha_venta) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                idVentaCabecera,
                parseInt(idProducto),
                item.nombre,
                cantidad,
                precio,
                total
            ]
        );

        // 3. Actualizar remisiones_productos (usando cantidad_devuelta como control)
        await db.query(
            `UPDATE remisiones_productos SET cantidad_devuelta = cantidad_devuelta + $1 
             WHERE id_remision = $2 AND id_producto = $3`,
            [cantidad, idRemision, parseInt(idProducto)]
        );

        // 4. Actualizar total de la remisión
        await db.query(
            'UPDATE remisiones SET total_ventas = total_ventas + $1 WHERE id_remision = $2',
            [total, idRemision]
        );

        await db.query('COMMIT');
        console.log(`✅ Venta contado guardada en BD: ${item.nombre} x${cantidad} - $${total}`);

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('❌ Error al guardar venta en BD:', error);
        return res.status(500).json({ error: 'Error al guardar venta: ' + error.message });
    }

    res.json({
        mensaje: `🧾 Venta registrada para ${item.nombre}.`,
        remisionActualizada: remision,
        ventaActual: ventaActual
    });
});

// ==========================================
// CIERRE DE JORNADA - CORREGIDO (sin total_ventas)
// ==========================================
app.post('/api/preventa/cierre-jornada', async (req, res) => {
    const { idRemision } = req.body;
    if (!idRemision) return res.status(400).json({ error: "Falta idRemision" });

    try {
        // Cargar remision desde memoria o BD
        let remision = remisionesVentaActivas[idRemision];
        if (!remision) {
            const { rows } = await db.query(`SELECT * FROM remisiones WHERE id_remision = $1`, [idRemision]);
            if (rows.length === 0) return res.status(404).json({ error: "Remisión no encontrada" });

            const { rows: prods } = await db.query(
                `SELECT * FROM remisiones_productos WHERE id_remision = $1`,
                [idRemision]
            );

            remision = {
                idRemision: idRemision,
                productos: prods.map(p => ({
                    idProducto: p.id_producto,
                    nombre: p.nombre,
                    cantidadSacada: Number(p.cantidad_sacada || 0),
                    cantidadDevuelta: Number(p.cantidad_devuelta || 0),
                    cantidadVendidaEnCalle: Number(p.cantidad_devuelta || 0),
                    costoUnidadFijo: Number(p.costo_unidad || 0),
                    precioVentaUnidadFijo: Number(p.precio_venta_unidad || 0),
                    precioVentaRealCalle: null
                })),
                fechaCreacion: rows[0].fecha_creacion
            };
        }

        // Calcular totales
        let totalVentasEfectivo = 0;
        let totalCostos = 0;
        let totalCredito = 0;
        let totalAbono = 0;
        let totalSaldo = 0;

        // Ventas de contado (sumar desde ventas_contado_detalle)
        const { rows: contadoRows } = await db.query(
            `SELECT COALESCE(SUM(total), 0) as total FROM ventas_contado_detalle vcd
             JOIN ventas_contado_cabecera vcc ON vcd.id_venta_cabecera = vcc.id_venta
             WHERE vcc.id_remision = $1`,
            [idRemision]
        );
        totalVentasEfectivo = Number(contadoRows[0]?.total || 0);

        // Créditos de esta remisión
        const { rows: creditos } = await db.query(
            `SELECT COALESCE(SUM(total_venta), 0) as total, 
                    COALESCE(SUM(abono_inicial), 0) as abono, 
                    COALESCE(SUM(saldo_pendiente), 0) as saldo 
             FROM ventas_credito WHERE id_remision = $1`,
            [idRemision]
        );
        totalCredito = Number(creditos[0]?.total || 0);
        totalAbono = Number(creditos[0]?.abono || 0);
        totalSaldo = Number(creditos[0]?.saldo || 0);

        // Sumar abonos adicionales
        const { rows: abonosRows } = await db.query(
            `SELECT COALESCE(SUM(monto), 0) as total_abonos FROM abonos_credito ac
             JOIN ventas_credito vc ON ac.venta_credito_id = vc.id
             WHERE vc.id_remision = $1`,
            [idRemision]
        );
        const totalAbonosAdicionales = Number(abonosRows[0]?.total_abonos || 0);

        const efectivoTotal = totalVentasEfectivo + totalAbono + totalAbonosAdicionales;

        let productosMovidos = [];
        for (const item of remision.productos) {
            const vendido = item.cantidadSacada - (item.cantidadDevuelta || 0);
            const sobrante = item.cantidadSacada - vendido;

            // Devolver sobrante a bodega
            if (sobrante > 0) {
                await db.query(
                    'UPDATE inventario_venta SET stock = stock + $1 WHERE id = $2',
                    [sobrante, item.idProducto]
                );
            }

            totalCostos += vendido * (item.costoUnidadFijo || 0);
            productosMovidos.push({
                nombre: item.nombre,
                cargados: item.cantidadSacada,
                vendidos: vendido,
                devueltos: sobrante
            });
        }

        // 🔥 CORREGIDO: Ya no usamos total_ventas en remisiones
        await db.query(
            "UPDATE remisiones SET estado = 'CERRADA', fecha_cierre = NOW() WHERE id_remision = $1",
            [idRemision]
        );

        const ganancia = efectivoTotal - totalCostos;

        // Registrar en memoria
        remision.estado = 'CERRADA';
        historialRemisiones.push(remision);
        delete remisionesVentaActivas[idRemision];

        // Registrar movimiento financiero
        try {
            if (ganancia > 0) {
                await db.query(
                    `INSERT INTO movimientos_financieros (tipo, monto, descripcion, fecha_movimiento, usuario) 
                     VALUES ($1, $2, $3, NOW(), $4)`,
                    ['UTILIDAD', ganancia,
                     `Cierre remisión ${idRemision} (Efectivo $${efectivoTotal} + Crédito $${totalCredito} - Costo $${totalCostos})`,
                     'Sistema']
                );

                const { rows: bal } = await db.query('SELECT * FROM balance_financiero ORDER BY id DESC LIMIT 1');
                if (bal.length > 0) {
                    const tg = parseFloat(bal[0].total_ganado || 0) + ganancia;
                    const tr = parseFloat(bal[0].total_reinvertido || 0);
                    await db.query(
                        `UPDATE balance_financiero SET total_ganado = $1, total_disponible = $2, ultima_actualizacion = NOW() WHERE id = $3`,
                        [tg, tg - tr, bal[0].id]
                    );
                }
            }
        } catch (e) {
            console.error('Error financiero', e.message);
        }

        res.json({
            mensaje: "🏁 Cierre procesado",
            auditoriaFinal: {
                idRemision,
                productosMovidos,
                resumen: {
                    ventasContadoEfectivo: totalVentasEfectivo,
                    ventasCreditoTotal: totalCredito,
                    abonoRecibido: totalAbono + totalAbonosAdicionales,
                    saldoPorCobrar: totalSaldo,
                    devoluciones: productosMovidos.reduce((s, p) => s + p.devueltos, 0)
                },
                cierreFinancieroCaja: {
                    ingresoEfectivoARecibir: `$${totalVentasEfectivo.toLocaleString()}`,
                    abonosCredito: `$${(totalAbono + totalAbonosAdicionales).toLocaleString()}`,
                    creditoOtorgado: `$${totalCredito.toLocaleString()} (Saldo $${totalSaldo.toLocaleString()})`,
                    costoMercancia: `$${totalCostos.toLocaleString()}`,
                    gananciaLimpiaMecatron: `$${ganancia.toLocaleString()}`
                }
            }
        });

    } catch (error) {
        console.error("❌ Error cierre:", error);
        res.status(500).json({ error: "Error al cerrar", detalle: error.message });
    }
});

// NUEVO ENDPOINT AUXILIAR: Para traer el carrito actual de una remisión en ruta - FIX COLUMNAS REALES
app.get('/api/preventa/consultar/:idRemision', async (req, res) => {
    const id = req.params.idRemision.trim();
    console.log('🔍 Consultando remisión:', id);

    if (remisionesVentaActivas[id]) {
        return res.json({ remision: remisionesVentaActivas[id] });
    }

    try {
        const { rows } = await db.query(`SELECT * FROM remisiones WHERE id_remision = $1 LIMIT 1`, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: `Remisión ${id} no encontrada.` });
        }

        const remisionDB = rows[0];

        // Usando NUEVOS NOMBRES de columnas: cantidad_sacada y cantidad_devuelta
        const { rows: prods } = await db.query(
            `SELECT id_producto, nombre, cantidad_sacada, cantidad_devuelta, costo_unidad, precio_venta_unidad 
             FROM remisiones_productos WHERE id_remision = $1`,
            [id]
        );

        if (prods.length === 0) {
            console.log(`⚠️ Remisión ${id} existe pero sin productos en remisiones_productos`);
        }

        const productosFormateados = prods.map(p => ({
            idProducto: p.id_producto,
            nombre: p.nombre,
            cantidadSacada: Number(p.cantidad_sacada || 0),
            cantidadDevuelta: Number(p.cantidad_devuelta || 0),
            // cantidadVendidaEnCalle = cantidadSacada - cantidadDevuelta
            cantidadVendidaEnCalle: Number(p.cantidad_sacada || 0) - Number(p.cantidad_devuelta || 0),
            costoUnidadFijo: Number(p.costo_unidad || 0),
            precioVentaUnidadFijo: Number(p.precio_venta_unidad || 0),
            precioVentaRealCalle: null
        }));

        // Calcular total de ventas desde los productos
        let totalVentas = 0;
        productosFormateados.forEach(p => {
            totalVentas += p.cantidadVendidaEnCalle * (p.precioVentaUnidadFijo || 0);
        });

        const remision = {
            idRemision: remisionDB.id_remision,
            productos: productosFormateados,
            fechaCreacion: remisionDB.fecha_creacion || remisionDB.fecha || new Date(),
            totalVentas: Number(remisionDB.total_ventas || totalVentas || 0),
            preFactura: {
                totalVentasEmitidas: Number(remisionDB.total_ventas || totalVentas || 0),
                totalCostosOperativos: 0,
                gananciaPreviaCalculada: 0
            }
        };

        remisionesVentaActivas[id] = remision;
        console.log(`♻️ Remisión ${id} restaurada con ${productosFormateados.length} productos`);

        return res.json({ remision });

    } catch (error) {
        console.error('❌ ERROR en consultar remisión:', error.message);
        return res.status(500).json({ error: `Error: ${error.message}` });
    }
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
        await db.query('BEGIN');
        
        let totalVenta = 0;
        let resultados = [];

        // 1. Crear una sola cabecera para todos los productos
        const { rows: cabeceraRows } = await db.query(
            `INSERT INTO ventas_contado_cabecera 
             (id_remision, id_cliente, fecha_venta, total_venta, usuario_creacion, estado) 
             VALUES ($1, NULL, NOW(), $2, $3, 'COMPLETADA') 
             RETURNING id_venta`,
            [idRemision, 0, vendedor || 'Sistema'] // total se actualiza después
        );
        const idVentaCabecera = cabeceraRows[0].id_venta;

        let totalCalculado = 0;

        for (const prod of productos) {
            const idProducto = parseInt(prod.idProducto);
            const cantidad = parseInt(prod.cantidad);
            const precio = parseFloat(prod.precioUnitario);
            const total = cantidad * precio;
            totalCalculado += total;

            // Buscar el producto en la remisión
            let item = remision.productos.find(p => p.idProducto === idProducto);
            if (!item) {
                throw new Error(`Producto ${idProducto} no encontrado en la remisión.`);
            }

            // Verificar stock disponible en el camión
            let disponible = item.cantidadSacada - (item.cantidadVendidaEnCalle || 0);
            if (cantidad > disponible) {
                throw new Error(`Stock insuficiente para ${item.nombre}. Disponible: ${disponible}`);
            }

            // Actualizar en memoria
            item.cantidadVendidaEnCalle = (item.cantidadVendidaEnCalle || 0) + cantidad;
            item.precioVentaRealCalle = precio;

            // Guardar detalle
            await db.query(
                `INSERT INTO ventas_contado_detalle 
                 (id_venta_cabecera, id_producto, nombre_producto, cantidad, precio_unitario, total, fecha_venta) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [idVentaCabecera, idProducto, item.nombre, cantidad, precio, total]
            );

            // Actualizar remisiones_productos (cantidad_devuelta)
            await db.query(
                `UPDATE remisiones_productos SET cantidad_devuelta = cantidad_devuelta + $1 
                 WHERE id_remision = $2 AND id_producto = $3`,
                [cantidad, idRemision, idProducto]
            );

            resultados.push({ 
                nombre: item.nombre, 
                cantidad: cantidad, 
                precio: precio, 
                total: total 
            });
        }

        // Actualizar total en cabecera
        await db.query(
            `UPDATE ventas_contado_cabecera SET total_venta = $1 WHERE id_venta = $2`,
            [totalCalculado, idVentaCabecera]
        );

        // Actualizar total de la remisión
        await db.query(
            'UPDATE remisiones SET total_ventas = total_ventas + $1 WHERE id_remision = $2',
            [totalCalculado, idRemision]
        );

        await db.query('COMMIT');

        // Recalcular preFactura
        let totalVentas = 0;
        let totalCostos = 0;
        remision.productos.forEach(p => {
            totalVentas += (p.cantidadVendidaEnCalle || 0) * (p.precioVentaRealCalle || p.precioVentaUnidadFijo);
            totalCostos += (p.cantidadVendidaEnCalle || 0) * p.costoUnidadFijo;
        });
        remision.preFactura = {
            totalVentasEmitidas: totalVentas,
            totalCostosOperativos: totalCostos,
            gananciaPreviaCalculada: totalVentas - totalCostos
        };

        console.log('✅ Venta múltiple registrada:', resultados);
        console.log('💰 Total:', totalCalculado);

        res.json({
            mensaje: `Venta múltiple registrada con ${resultados.length} productos.`,
            productos: resultados,
            totalVenta: totalCalculado
        });

    } catch (error) {
        await db.query('ROLLBACK');
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

// =================================================================
// MÓDULO VENTA A CRÉDITO - OPTIMIZADO Y BLINDADO
// =================================================================
app.post('/api/ventas/credito', async (req, res) => {
    try {
        const { remision_id, cliente_nombre, cliente_cc, cliente_telefono, cliente_direccion, total_venta, abono_inicial, saldo_pendiente, productos, fecha_vencimiento, usuario } = req.body;

        if (!remision_id || !cliente_nombre || !productos || productos.length === 0) {
            return res.status(400).json({ error: "Datos de crédito incompletos" });
        }

        // Verificar si la remisión existe
        const { rows: remCheck } = await db.query(`SELECT id_remision, estado FROM remisiones WHERE id_remision = $1`, [remision_id]);
        if (remCheck.length === 0) {
            return res.status(404).json({ error: `Remisión ${remision_id} no existe` });
        }
        if (remCheck[0].estado === 'CERRADA') {
            return res.status(400).json({ error: "La remisión ya está cerrada, no se puede agregar crédito" });
        }

        // Asegurar que las tablas existan
        await db.query(`CREATE TABLE IF NOT EXISTS ventas_credito (
            id SERIAL PRIMARY KEY,
            remission_id VARCHAR(50),
            cliente_nombre VARCHAR(200),
            cliente_cc VARCHAR(50),
            cliente_telefono VARCHAR(50),
            cliente_direccion TEXT,
            total_venta NUMERIC DEFAULT 0,
            abono_inicial NUMERIC DEFAULT 0,
            saldo_pendiente NUMERIC DEFAULT 0,
            fecha_vencimiento DATE,
            estado VARCHAR(20) DEFAULT 'PENDIENTE',
            id_remision VARCHAR(50),
            fecha_venta TIMESTAMP DEFAULT NOW(),
            usuario_creacion VARCHAR(100),
            fecha_credito TIMESTAMP DEFAULT NOW()
        )`);

        await db.query('BEGIN');

        // 1. Insertar la cabecera del crédito CON LAS NUEVAS COLUMNAS
        const { rows: creditoRows } = await db.query(
            `INSERT INTO ventas_credito 
             (remission_id, cliente_nombre, cliente_cc, cliente_telefono, cliente_direccion, 
              total_venta, abono_inicial, saldo_pendiente, fecha_vencimiento, estado, 
              id_remision, fecha_venta, usuario_creacion, fecha_credito)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, NOW()) 
             RETURNING id`,
            [
                remision_id,
                cliente_nombre,
                cliente_cc || '',
                cliente_telefono || '',
                cliente_direccion || '',
                Number(total_venta || 0),
                Number(abono_inicial || 0),
                Number(saldo_pendiente || 0),
                fecha_vencimiento || null,
                Number(saldo_pendiente || 0) <= 0 ? 'PAGADO' : 'PENDIENTE',
                remision_id, // id_remision (la nueva columna)
                usuario || 'Sistema'
            ]
        );
        const creditoId = creditoRows[0].id;

        // 2. Insertar productos
        for (const prod of productos) {
            const cantidad = parseInt(prod.cantidad || prod.cantidadCargadaInicial || 1);
            const precio = parseFloat(prod.precio || prod.precioVentaUnidadFijo || 0);
            const nombreProd = prod.nombre || prod.nombre_producto || 'Producto';
            const idProd = prod.idProducto || prod.id_producto || prod.id || null;
            const subtotal = cantidad * precio;

            // Validar stock en remisión
            if (idProd) {
                const { rows: dispRows } = await db.query(
                    `SELECT cantidad_sacada, cantidad_devuelta FROM remisiones_productos 
                     WHERE id_remision = $1 AND id_producto = $2`,
                    [remision_id, idProd]
                );
                if (dispRows.length > 0) {
                    const disponible = Number(dispRows[0].cantidad_sacada || 0) - Number(dispRows[0].cantidad_devuelta || 0);
                    if (cantidad > disponible) {
                        throw new Error(`Stock insuficiente en remisión para ${nombreProd}. Disponible: ${disponible}`);
                    }
                }
            }

            await db.query(
                `INSERT INTO ventas_credito_productos 
                 (credito_id, id_producto, nombre, cantidad, precio_unitario, subtotal) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [creditoId, idProd, nombreProd, cantidad, precio, subtotal]
            );

            // Actualizar remisiones_productos (usando cantidad_devuelta)
            if (idProd) {
                await db.query(
                    `UPDATE remisiones_productos SET cantidad_devuelta = cantidad_devuelta + $1 
                     WHERE id_remision = $2 AND id_producto = $3`,
                    [cantidad, remision_id, idProd]
                );
            }
        }

        // 3. Actualizar total de la remisión (solo el abono inicial como ingreso efectivo)
        await db.query(
            `UPDATE remisiones SET total_ventas = COALESCE(total_ventas, 0) + $1 
             WHERE id_remision = $2`,
            [Number(abono_inicial || 0), remision_id]
        );

        await db.query('COMMIT');

        // Actualizar memoria
        if (remisionesVentaActivas[remision_id]) {
            for (const prod of productos) {
                const idProd = prod.idProducto || prod.id_producto;
                const p = remisionesVentaActivas[remision_id].productos.find(x => x.idProducto == idProd);
                if (p) {
                    p.cantidadVendidaEnCalle = (p.cantidadVendidaEnCalle || 0) + parseInt(prod.cantidad || 1);
                }
            }
        }

        console.log(`💳 Crédito ${remision_id} creado exitosamente con ID ${creditoId}`);
        res.json({ 
            mensaje: `Crédito guardado exitosamente`, 
            credito_id: creditoId, 
            remision_id,
            saldo_pendiente: Number(saldo_pendiente || 0)
        });

    } catch (error) {
        try { await db.query('ROLLBACK'); } catch (_) { }
        console.error('❌ Error crítico al procesar crédito:', error);
        res.status(500).json({ error: error.message });
    }
});


// =================================================================
// MÓDULO VENTA A CRÉDITO - UNIFICADO (NO BORRA REMISION, NO RESTA INVENTARIO VENTA)
// =================================================================
app.post('/api/ventas/credito', async (req,res)=>{
  try{
    const {remision_id, cliente_nombre, cliente_cc, cliente_telefono, cliente_direccion, total_venta, abono_inicial, saldo_pendiente, productos, fecha_vencimiento, usuario} = req.body;
    if(!remision_id || !cliente_nombre || !productos || productos.length===0) return res.status(400).json({error:"Datos crédito incompletos: cliente, remisión y productos obligatorios"});

    const {rows: remCheck}= await db.query(`SELECT id_remision, estado FROM remisiones WHERE id_remision=$1`,[remision_id]);
    if(remCheck.length===0) return res.status(404).json({error:`Remisión ${remision_id} no existe`});
    if(remCheck[0].estado==='CERRADA') return res.status(400).json({error:"La remisión ya está cerrada, no se puede agregar crédito"});

    await db.query('BEGIN');

    try{
      await db.query(`
        CREATE TABLE IF NOT EXISTS ventas_credito (
          id SERIAL PRIMARY KEY,
          remision_id VARCHAR(50),
          cliente_nombre VARCHAR(200),
          cliente_cc VARCHAR(50),
          cliente_telefono VARCHAR(50),
          cliente_direccion TEXT,
          total_venta NUMERIC DEFAULT 0,
          abono_inicial NUMERIC DEFAULT 0,
          saldo_pendiente NUMERIC DEFAULT 0,
          fecha_vencimiento DATE,
          estado VARCHAR(20) DEFAULT 'PENDIENTE',
          usuario_creacion VARCHAR(100),
          fecha_creacion TIMESTAMP DEFAULT NOW()
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS ventas_credito_productos (
          id SERIAL PRIMARY KEY,
          credito_id INTEGER,
          id_producto INTEGER,
          nombre VARCHAR(200),
          cantidad INTEGER DEFAULT 1,
          precio_unitario NUMERIC DEFAULT 0,
          subtotal NUMERIC DEFAULT 0
        )`);
    }catch(e){}

    const {rows: creditoRows}= await db.query(
      `INSERT INTO ventas_credito (remision_id, cliente_nombre, cliente_cc, cliente_telefono, cliente_direccion, total_venta, abono_inicial, saldo_pendiente, fecha_vencimiento, estado, usuario_creacion, fecha_creacion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING id`,
      [remision_id, cliente_nombre, cliente_cc||'', cliente_telefono||'', cliente_direccion||'', Number(total_venta||0), Number(abono_inicial||0), Number(saldo_pendiente||0), fecha_vencimiento||null, 'PENDIENTE', usuario||'Sistema']
    );
    const creditoId= creditoRows[0].id;

    for(const prod of productos){
      const cantidad= parseInt(prod.cantidad||1);
      const precio= parseFloat(prod.precio||0);
      const nombreProd= (prod.nombre||'Producto').substring(0,200);
      const idProd= prod.idProducto||prod.id_producto||null;
      if(!idProd) continue;
      const {rows: dispRows} = await db.query(`SELECT cantidad_cargada, cantidad_vendida FROM remisiones_productos WHERE id_remision=$1 AND id_producto=$2`,[remision_id, idProd]);
      if(dispRows.length>0){
        const disponible = Number(dispRows[0].cantidad_cargada||0) - Number(dispRows[0].cantidad_vendida||0);
        if(cantidad > disponible){ throw new Error(`Stock insuficiente en remisión para ${nombreProd}. Disponible: ${disponible}`); }
      }
      await db.query(`INSERT INTO ventas_credito_productos (credito_id, id_producto, nombre, cantidad, precio_unitario, subtotal) VALUES ($1,$2,$3,$4,$5,$6)`,[creditoId, idProd, nombreProd, cantidad, precio, cantidad*precio]);
      await db.query(`UPDATE remisiones_productos SET cantidad_vendida = cantidad_vendida + $1 WHERE id_remision=$2 AND id_producto=$3`,[cantidad, remision_id, idProd]);
      try{
        await db.query(`INSERT INTO ventas_individuales (id_remision, id_producto, nombre_producto, cantidad, precio_unitario, total, vendedor, fecha_venta) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,[remision_id, idProd, nombreProd, cantidad, precio, cantidad*precio, usuario||'Sistema']);
      }catch(e){}
    }

    await db.query(`UPDATE remisiones SET total_ventas = COALESCE(total_ventas,0) + $1 WHERE id_remision=$2`,[Number(abono_inicial||0), remision_id]);
    await db.query('COMMIT');

    if(remisionesVentaActivas[remision_id]){
      for(const prod of productos){
        const idProd = prod.idProducto||prod.id_producto;
        const p = remisionesVentaActivas[remision_id].productos.find(x=> x.idProducto==idProd);
        if(p){ p.cantidadVendidaEnCalle = Number(p.cantidadVendidaEnCalle||0) + parseInt(prod.cantidad||1); }
      }
    }

    console.log(`💳 Crédito ${remision_id} creado ID ${creditoId}`);
    res.json({mensaje:`Crédito guardado`, credito_id:creditoId, remision_id, saldo_pendiente});
  }catch(error){
    try{await db.query('ROLLBACK');}catch{}
    console.error('Error crédito', error);
    res.status(500).json({error:error.message});
  }
});

app.get('/api/ventas/creditos', async (req,res)=>{
  try{
    const {rows}= await db.query(`SELECT * FROM ventas_credito ORDER BY fecha_creacion DESC LIMIT 100`);
    res.json({creditos:rows});
  }catch(e){ res.json({creditos:[]}); }
});

app.get('/api/ventas/credito/:remisionId', async (req,res)=>{
  try{
    const {rows}= await db.query(`SELECT * FROM ventas_credito WHERE remision_id=$1 ORDER BY fecha_creacion DESC`,[req.params.remisionId]);
    res.json({creditos:rows});
  }catch(e){ res.json({creditos:[]}); }
});



// =================================================================
// NUEVO ENDPOINT UNIFICADO: FINALIZAR VENTA MIXTA (CONTADO + CREDITO)
// =================================================================
// ==========================================
// FINALIZAR VENTA MIXTA - CON PRECIO PACTADO
// ==========================================
app.post('/api/preventa/finalizar-mixta', async (req, res) => {
    const { idRemision, items, cliente, vendedor } = req.body;
    // items = [{idProducto, nombre, cantidad, precio, tipo:'CONTADO'|'CREDITO'}]
    
    try {
        console.log('🧩 Finalizar mixta', idRemision, 'items:', items?.length, 'cliente:', cliente?.nombre);
        
        if (!idRemision || !items || items.length === 0) {
            return res.status(400).json({ error: "Datos incompletos: remisión y productos" });
        }

        const { rows: remRows } = await db.query(
            `SELECT id_remision, estado FROM remisiones WHERE id_remision = $1`,
            [idRemision]
        );
        
        if (remRows.length === 0) {
            return res.status(404).json({ error: "Remisión no existe" });
        }
        if (remRows[0].estado === 'CERRADA') {
            return res.status(400).json({ error: "Remisión ya cerrada" });
        }

        const tieneCredito = items.some(i => i.tipo === 'CREDITO');
        if (tieneCredito && (!cliente || !cliente.nombre)) {
            return res.status(400).json({ error: "Para crédito debe indicar cliente" });
        }

        await db.query('BEGIN');

        // Crear tablas si faltan
        await db.query(`CREATE TABLE IF NOT EXISTS ventas_credito (
            id SERIAL PRIMARY KEY,
            remission_id VARCHAR(50),
            cliente_nombre VARCHAR(200),
            cliente_cc VARCHAR(50),
            cliente_telefono VARCHAR(50),
            cliente_direccion TEXT,
            total_venta NUMERIC DEFAULT 0,
            abono_inicial NUMERIC DEFAULT 0,
            saldo_pendiente NUMERIC DEFAULT 0,
            fecha_vencimiento DATE,
            estado VARCHAR(20) DEFAULT 'PENDIENTE',
            id_remision VARCHAR(50),
            fecha_venta TIMESTAMP DEFAULT NOW(),
            usuario_creacion VARCHAR(100),
            fecha_credito TIMESTAMP DEFAULT NOW()
        )`);

        await db.query(`CREATE TABLE IF NOT EXISTS ventas_credito_productos (
            id SERIAL PRIMARY KEY,
            credito_id INTEGER,
            id_producto INTEGER,
            nombre VARCHAR(200),
            cantidad INTEGER DEFAULT 1,
            precio_unitario NUMERIC DEFAULT 0,
            subtotal NUMERIC DEFAULT 0
        )`);

        let totalContado = 0;
        let totalCredito = 0;
        const productosCredito = items.filter(i => i.tipo === 'CREDITO');

        // Validar stock
        for (const it of items) {
            const { rows: st } = await db.query(
                `SELECT cantidad_sacada, cantidad_devuelta FROM remisiones_productos 
                 WHERE id_remision = $1 AND id_producto = $2`,
                [idRemision, it.idProducto]
            );
            if (st.length > 0) {
                const disp = Number(st[0].cantidad_sacada || 0) - Number(st[0].cantidad_devuelta || 0);
                if (it.cantidad > disp) {
                    throw new Error(`Stock insuficiente para ${it.nombre}. Disponible ${disp}`);
                }
            }
        }

        // Guardar contado con el PRECIO PACTADO
        for (const it of items.filter(i => i.tipo === 'CONTADO')) {
            // 🔥 IMPORTANTE: Usar el precio que viene del frontend (el que pactó el vendedor)
            const precio = parseFloat(it.precio) || 0;
            const cantidad = parseInt(it.cantidad) || 1;
            const total = cantidad * precio;
            totalContado += total;

            // 1. Crear cabecera de venta contado
            const { rows: cabeceraRows } = await db.query(
                `INSERT INTO ventas_contado_cabecera 
                 (id_remision, id_cliente, fecha_venta, total_venta, usuario_creacion, estado) 
                 VALUES ($1, NULL, NOW(), $2, $3, 'COMPLETADA') 
                 RETURNING id_venta`,
                [idRemision, total, vendedor || 'Sistema']
            );
            const idVentaCabecera = cabeceraRows[0].id_venta;

            // 2. Guardar detalle con el precio pactado
            await db.query(
                `INSERT INTO ventas_contado_detalle 
                 (id_venta_cabecera, id_producto, nombre_producto, cantidad, precio_unitario, total, fecha_venta) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [idVentaCabecera, it.idProducto, it.nombre, cantidad, precio, total]
            );

            // 3. Actualizar remisiones_productos (cantidad_devuelta = vendido)
            await db.query(
                `UPDATE remisiones_productos SET cantidad_devuelta = cantidad_devuelta + $1 
                 WHERE id_remision = $2 AND id_producto = $3`,
                [cantidad, idRemision, it.idProducto]
            );
        }

        let creditoId = null;
        let abono = 0;
        let saldo = 0;

        if (tieneCredito) {
            totalCredito = productosCredito.reduce((s, i) => s + Number(i.cantidad) * Number(i.precio), 0);
            abono = Number(cliente.abono || 0);
            saldo = totalCredito - abono;
            
            if (abono < 0 || abono > totalCredito) {
                throw new Error(`Abono inválido. Total crédito $${totalCredito}, abono $${abono}`);
            }

            const { rows: credRows } = await db.query(
                `INSERT INTO ventas_credito 
                 (remission_id, cliente_nombre, cliente_cc, cliente_telefono, cliente_direccion, 
                  total_venta, abono_inicial, saldo_pendiente, fecha_vencimiento, estado, 
                  id_remision, fecha_venta, usuario_creacion) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12) 
                 RETURNING id`,
                [
                    idRemision,
                    cliente.nombre,
                    cliente.cc || '',
                    cliente.telefono || '',
                    cliente.direccion || '',
                    totalCredito,
                    abono,
                    saldo,
                    cliente.fecha_vencimiento || null,
                    'PENDIENTE',
                    idRemision,
                    vendedor || 'Sistema'
                ]
            );
            creditoId = credRows[0].id;

            // Guardar productos de crédito
            for (const it of productosCredito) {
                const precio = parseFloat(it.precio) || 0;
                const cantidad = parseInt(it.cantidad) || 1;
                const tot = cantidad * precio;

                await db.query(
                    `INSERT INTO ventas_credito_productos 
                     (credito_id, id_producto, nombre, cantidad, precio_unitario, subtotal) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [creditoId, it.idProducto, it.nombre, cantidad, precio, tot]
                );

                await db.query(
                    `UPDATE remisiones_productos SET cantidad_devuelta = cantidad_devuelta + $1 
                     WHERE id_remision = $2 AND id_producto = $3`,
                    [cantidad, idRemision, it.idProducto]
                );
            }
        }

        // 🔥 ELIMINADO: Ya no actualizamos total_ventas en remisiones
        // Simplemente registramos que la remisión tiene movimientos

        await db.query('COMMIT');

        // Actualizar memoria
        if (remisionesVentaActivas[idRemision]) {
            for (const it of items) {
                const p = remisionesVentaActivas[idRemision].productos.find(x => x.idProducto == it.idProducto);
                if (p) {
                    p.cantidadVendidaEnCalle = (p.cantidadVendidaEnCalle || 0) + Number(it.cantidad);
                    p.precioVentaRealCalle = parseFloat(it.precio) || p.precioVentaRealCalle || p.precioVentaUnidadFijo;
                }
            }
        }

        const efectivoRecaudado = totalContado + abono;
        console.log(`✅ Mixta OK ${idRemision} contado $${totalContado} credito $${totalCredito} abono $${abono} efectivo $${efectivoRecaudado}`);

        res.json({
            ok: true,
            mensaje: "Venta mixta guardada",
            resumen: {
                totalContado,
                totalCredito,
                abono,
                saldo,
                efectivoRecaudado,
                creditoId
            }
        });

    } catch (e) {
        try { await db.query('ROLLBACK'); } catch (_) { }
        console.error('❌ Error finalizar-mixta', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET para evitar Cannot GET
app.get('/api/preventa/finalizar-mixta', (req,res)=> res.json({msg:"Usar POST"}));
app.get('/api/preventa/venta-multiple', (req,res)=> res.json({msg:"Usar POST /api/preventa/venta-multiple o mejor /api/preventa/finalizar-mixta"}));

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