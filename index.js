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
  origin: ['https://mecatron-solutions.onrender.com'], // pon tu URL real del frontend
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

    try {
        // Generar ID de remisión usando el contador
        contadorRemisiones++;
        const idRemision = `REM-${String(contadorRemisiones).padStart(4, '0')}`;

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

            productosValidados.push({
                idProducto: item.idProducto,
                nombre: prod.nombre,
                cantidadCargadaInicial: item.cantidadSalida,
                cantidadVendidaEnCalle: 0,
                costoUnidadFijo: parseFloat(prod.costo || 0),
                precioVentaUnidadFijo: parseFloat(prod.precio_venta || 0),
                precioVentaRealCalle: 0
            });
        }

        // Descontar de la BD
        for (const item of productosValidados) {
            await db.query(
                'UPDATE inventario_venta SET stock = stock - ? WHERE id = ?',
                [item.cantidadCargadaInicial, item.idProducto]
            );
        }

        // Guardar en memoria activa
        const remision = {
            idRemision,
            productos: productosValidados,
            preFactura: { totalVentasEmitidas: 0, totalCostosOperativos: 0, gananciaPreviaCalculada: 0 },
            fechaCreacion: new Date().toISOString(),
            estado: 'ACTIVA'
        };

        remisionesVentaActivas[idRemision] = remision;

        // === Guardar en la base de datos ===
        // 1. Guardar la remisión
        await db.query(
            'INSERT INTO remisiones (id_remision, fecha_creacion, estado, usuario_creacion) VALUES (?, ?, ?, ?)',
            [idRemision, new Date(), 'ACTIVA', usuario || 'Sistema']
        );

        // 2. Guardar los productos de la remisión
        for (const item of productosValidados) {
            await db.query(
                `INSERT INTO remisiones_productos 
                 (id_remision, id_producto, nombre, cantidad_cargada, cantidad_vendida, costo_unidad, precio_venta_unidad) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

        res.json({ 
            mensaje: `✓ Remisión ${idRemision} generada con éxito con ${productosValidados.length} productos.`, 
            idRemision,
            remisionesActivas: Object.keys(remisionesVentaActivas)
        });

    } catch (error) {
        console.error("Error en salida de preventa:", error);
        res.status(500).json({ error: "Error en el servidor al despachar la remisión." });
    }
});

// 📋 LISTAR TODAS LAS REMISIONES ACTIVAS
app.get('/api/preventa/remisiones-activas', (req, res) => {
    const activas = Object.keys(remisionesVentaActivas).map(id => ({
        idRemision: id,
        productos: remisionesVentaActivas[id].productos.map(p => ({
            nombre: p.nombre,
            cargados: p.cantidadCargadaInicial,
            vendidos: p.cantidadVendidaEnCalle,
            disponibles: p.cantidadCargadaInicial - p.cantidadVendidaEnCalle
        })),
        totalVentas: remisionesVentaActivas[id].preFactura.totalVentasEmitidas || 0,
        fechaCreacion: remisionesVentaActivas[id].fechaCreacion
    }));
    res.json({ activas });
});

// 📋 OBTENER HISTORIAL COMPLETO
app.get('/api/preventa/historial', (req, res) => {
    res.json({ 
        total: historialRemisiones.length,
        remisiones: historialRemisiones.map(r => ({
            idRemision: r.idRemision,
            estado: r.estado,
            fechaCreacion: r.fechaCreacion,
            fechaCierre: r.fechaCierre || null,
            totalProductos: r.productos.length,
            totalVentas: r.preFactura.totalVentasEmitidas || 0
        }))
    });
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
        // 1. Guardar la venta individual
        await db.query(
            `INSERT INTO ventas_individuales 
             (id_remision, id_producto, nombre_producto, cantidad, precio_unitario, total, vendedor, fecha_venta) 
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
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
            'UPDATE remisiones_productos SET cantidad_vendida = cantidad_vendida + ? WHERE id_remision = ? AND id_producto = ?',
            [cantidad, idRemision, parseInt(idProducto)]
        );

        // 3. Actualizar total de la remisión
        await db.query(
            'UPDATE remisiones SET total_ventas = total_ventas + ? WHERE id_remision = ?',
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

// 🏁 SUBMÓDULO 3: CIERRE DE JORNADA (CORREGIDO)
app.post('/api/preventa/cierre-jornada', async (req, res) => {
    const { idRemision } = req.body;
    let remision = remisionesVentaActivas[idRemision];

    if (!remision) {
        return res.status(404).json({ error: "La remisión ya fue cerrada o no existe." });
    }

    try {
        // 1. Reingresar lo no vendido a MySQL
        for (const item of remision.productos) {
            let cantidadSobrante = item.cantidadCargadaInicial - item.cantidadVendidaEnCalle;
            if (cantidadSobrante > 0) {
                await db.query(
                    'UPDATE inventario_venta SET stock = stock + ? WHERE id = ?',
                    [cantidadSobrante, item.idProducto]
                );
            }
        }

        // 2. Actualizar estado de la remisión en BD
        const [result] = await db.query(
            'UPDATE remisiones SET estado = "CERRADA", fecha_cierre = ? WHERE id_remision = ?',
            [new Date(), idRemision]
        );

        // 3. Si no se actualizó, insertar la remisión en la BD
        if (result.affectedRows === 0) {
            await db.query(
                `INSERT INTO remisiones (id_remision, fecha_creacion, estado, usuario_creacion, total_ventas, fecha_cierre) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    idRemision,
                    remision.fechaCreacion || new Date(),
                    'CERRADA',
                    'Sistema',
                    remision.preFactura?.totalVentasEmitidas || 0,
                    new Date()
                ]
            );

            // Insertar los productos
            for (const item of remision.productos) {
                await db.query(
                    `INSERT INTO remisiones_productos 
                     (id_remision, id_producto, nombre, cantidad_cargada, cantidad_vendida, costo_unidad, precio_venta_unidad) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
// Dentro de /api/preventa/cierre-jornada, después de calcular balanceCierreFinal

// === AUTOMATIZAR: Registrar utilidad en el módulo financiero ===
try {
    const utilidad = remision.preFactura.gananciaPreviaCalculada || 0;
    if (utilidad > 0) {
        // 1. Registrar el movimiento
        await db.query(
            `INSERT INTO movimientos_financieros 
             (tipo, monto, descripcion, fecha_movimiento, usuario) 
             VALUES (?, ?, ?, NOW(), ?)`,
            ['UTILIDAD', utilidad, `Utilidad de remisión ${idRemision}`, 'Sistema']
        );

        // 2. Actualizar el balance
        const [balance] = await db.query('SELECT * FROM balance_financiero ORDER BY id DESC LIMIT 1');
        let total_ganado = parseFloat(balance[0].total_ganado || 0) + utilidad;
        let total_reinvertido = parseFloat(balance[0].total_reinvertido || 0);
        let total_disponible = total_ganado - total_reinvertido;

        await db.query(
            `UPDATE balance_financiero 
             SET total_ganado = ?, total_reinvertido = ?, total_disponible = ?, ultima_actualizacion = NOW() 
             WHERE id = ?`,
            [total_ganado, total_reinvertido, total_disponible, balance[0].id]
        );

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

// RECOMENDADOR DE HERRAMIENTAS POR TIPO DE SERVICIO
app.get('/api/servicios/recomendar', async (req, res) => {
    const { tipo_servicio } = req.query;

    if (!tipo_servicio) {
        return res.status(400).json({ error: "Debe especificar el tipo_servicio." });
    }

    try {
        const [filas] = await db.query(
            'SELECT id, nombre, disponibles, estado FROM inventario_uso_servicio WHERE tipo_servicio = ? AND estado = "DISPONIBLE" ORDER BY nombre',
            [tipo_servicio]
        );

        if (filas.length === 0) {
            return res.status(404).json({ 
                error: "No hay herramientas disponibles para este tipo de servicio",
                tipo_servicio: tipo_servicio
            });
        }

        res.json({
            tipo_servicio: tipo_servicio,
            totalHerramientas: filas.length,
            herramientas: filas.map(h => ({
                id: h.id,
                nombre: h.nombre,
                disponible: h.disponibles > 0,
                disponibles: h.disponibles,
                estado: h.estado
            }))
        });

    } catch (error) {
        console.error("Error al consultar la BD:", error);
        res.status(500).json({ error: "Error interno al conectar con la base de datos." });
    }
});

// ==========================================================
// DESPACHO DE HERRAMIENTAS (SALIDA) - COMPLETO Y CORREGIDO
// ==========================================================
app.post('/api/servicios/salida', async (req, res) => {
    console.log("DATOS RECIBIDOS EN EL SERVIDOR:", req.body);
    // 1. Recibimos lugarTrabajo desde tu nuevo frontend
    const { lugarTrabajo, idsSeleccionadas, idsAdicionales, usuario } = req.body;
    
    // Juntamos todas las herramientas en un solo array
    let todasLasHerramientas = [...(idsSeleccionadas || []), ...(idsAdicionales || [])];

    // Validamos que vengan los datos obligatorios
    if (!lugarTrabajo || todasLasHerramientas.length === 0) {
        return res.status(400).json({ error: "Faltan datos obligatorios (Lugar de trabajo o herramientas)." });
    }

    // ==========================================================
    // 🚀 CONTROL CONSECUTIVO FORZADO DESDE EL BACKEND
    // ==========================================================
    let finalIdOrden;
    try {
        // Buscamos el último registro real de la tabla ordenes_servicio ordenando cronológicamente
        const [lastRow] = await db.query(
            "SELECT id_orden FROM ordenes_servicio WHERE id_orden LIKE 'ORD-%' ORDER BY fecha_creacion DESC, id_orden DESC LIMIT 1"
        );
        
        let nextNum = 1; // Si es la primera orden de la base de datos, empieza en 1
        
        if (lastRow.length > 0) {
            // Quitamos el prefijo 'ORD-' para quedarnos solo con el número puro
            const lastNum = parseInt(lastRow[0].id_orden.replace('ORD-', ''), 10);
            if (!isNaN(lastNum)) {
                nextNum = lastNum + 1; // Sumamos 1 al consecutivo anterior
            }
        }
        
        // Formateamos para mantener la estructura limpia de 4 dígitos (Ej: ORD-0001, ORD-0461)
        finalIdOrden = `ORD-${String(nextNum).padStart(4, '0')}`;
        
    } catch (errCon) {
        console.error("❌ Error calculando el consecutivo:", errCon);
        // Resguardo de emergencia por si falla la consulta del consecutivo
        finalIdOrden = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
    }
    // ==========================================================

    try {
        // Verificar que no exista una orden repetida en la tabla
        const [existente] = await db.query('SELECT id_orden FROM ordenes_servicio WHERE id_orden = ?', [finalIdOrden]);
        if (existente.length > 0) {
            return res.status(409).json({ error: "Ya existe una orden con ese ID." });
        }

        let despachoExitoso = [];
        let erroresDespacho = [];

        // Procesar cada herramienta en el inventario
        for (const id of todasLasHerramientas) {
            const { rows } = await db.query('SELECT nombre, disponibles, estado FROM inventario_uso_servicio WHERE id = $1', [id]);
            
            if (rows.length === 0) {
                erroresDespacho.push(`El ID ${id} no existe en la bodega.`);
                continue; 
            }

            let herramienta = rows[0];

            if (herramienta.estado !== 'DISPONIBLE') {
                erroresDespacho.push(`La herramienta "${herramienta.nombre}" no está disponible (${herramienta.estado})`);
                continue;
            }

            if (herramienta.disponibles < 1) {
                erroresDespacho.push(`No hay unidades disponibles de: ${herramienta.nombre}`);
            } else {
                // Restamos 1 en el inventario
                await db.query(
                    'UPDATE inventario_uso_servicio SET disponibles = disponibles - 1 WHERE id = ?', 
                    [id]
                );
                despachoExitoso.push({ id: id, nombre: herramienta.nombre });
            }
        }

        // Si ninguna herramienta pudo ser despachada, cancelamos
        if (despachoExitoso.length === 0) {
            return res.status(400).json({ error: "No se pudo despachar ninguna herramienta.", detalles: erroresDespacho });
        }

        // 2. INSERT EN LA TABLA REAL usando tu columna 'lugarTrabajo'
        const queryOrden = `
            INSERT INTO ordenes_servicio (
                id_orden, 
                lugarTrabajo, 
                estado, 
                usuario_creacion, 
                fecha_creacion, 
                total_herramientas
            ) 
            VALUES (?, ?, ?, ?, NOW(), ?)
        `;

        const valoresOrden = [
            finalIdOrden,
            lugarTrabajo,
            'EN_CAMPO',
            usuario || 'Sistema',
            despachoExitoso.length 
        ];

        // Ejecutamos la inserción de la orden principal
        await db.query(queryOrden, valoresOrden);

        // 3. DETALLES: Guardar cada herramienta asignada en la tabla relacional
        for (const h of despachoExitoso) {
            await db.query(
                `INSERT INTO ordenes_servicio_herramientas (id_orden, id_herramienta, nombre_herramienta) 
                 VALUES (?, ?, ?)`,
                [finalIdOrden, h.id, h.nombre]
            );
        }

        if (typeof ordenesServicioActivas !== 'undefined') {
            ordenesServicioActivas[finalIdOrden] = {
                idOrden: finalIdOrden,
                lugarTrabajo: lugarTrabajo,
                herramientasAsignadas: despachoExitoso,
                estado: "EN_CAMPO",
                fechaCreacion: new Date().toISOString()
            };
        }

        // Respondemos con éxito al cliente
        res.json({
            mensaje: `🚀 Despacho operativo procesado con éxito para: ${lugarTrabajo}.`,
            idOrden: finalIdOrden,
            totalHerramientas: despachoExitoso.length,
            lugarTrabajo: lugarTrabajo,
            alertas: erroresDespacho.length > 0 ? erroresDespacho : "Ninguna. Todo el kit salió completo."
        });

    } catch (error) {
        console.error("❌ Error crítico en el despacho:", error);
        res.status(500).json({ error: "Error interno al procesar la salida.", detalle: error.message });
    }
});
// REINGRESO DE HERRAMIENTAS CON ESTADO
app.post('/api/servicios/reingreso', async (req, res) => {
    const { idOrden, novedades } = req.body;

    if (!idOrden) {
        return res.status(400).json({ error: "Falta el ID de la orden." });
    }

    try {
        // Cargar la orden desde BD
        const [ordenRows] = await db.query(
            'SELECT * FROM ordenes_servicio WHERE id_orden = ? AND estado = "EN_CAMPO"',
            [idOrden]
        );

        if (ordenRows.length === 0) {
            return res.status(404).json({ error: "Orden no encontrada o ya cerrada." });
        }

        // Cargar las herramientas de esa orden
        const [herramientas] = await db.query(
            'SELECT id_herramienta, nombre_herramienta FROM ordenes_servicio_herramientas WHERE id_orden = ?',
            [idOrden]
        );

        // Procesar cada herramienta según la novedad
        for (const hItem of herramientas) {
            const idH = hItem.id_herramienta;
            const novedad = novedades && novedades[idH] ? novedades[idH].toUpperCase() : "OK";

            if (novedad === "OK") {
                await db.query(
                    'UPDATE inventario_uso_servicio SET disponibles = disponibles + 1, estado = "DISPONIBLE" WHERE id = ?',
                    [idH]
                );
            } else if (novedad === "DAÑO") {
                await db.query(
                    `UPDATE inventario_uso_servicio 
                     SET estado = "EN_REPARACION",
                         observaciones = CONCAT(IFNULL(observaciones, ''), ' - En reparación desde ', NOW()) 
                     WHERE id = ?`,
                    [idH]
                );
            } else if (novedad === "PERDIDA") {
                await db.query(
                    `UPDATE inventario_uso_servicio 
                     SET stock_total = 0, disponibles = 0, estado = "DADO_BAJA",
                         observaciones = CONCAT(IFNULL(observaciones, ''), ' - Dado de baja por pérdida ', NOW()) 
                     WHERE id = ?`,
                    [idH]
                );
            }
        }

        // Marcar la orden como cerrada
        await db.query('UPDATE ordenes_servicio SET estado = "CERRADA", fecha_cierre = NOW() WHERE id_orden = ?', [idOrden]);

        res.json({
            mensaje: "Reingreso procesado correctamente.",
            estadoOrden: "CERRADA",
            totalProcesadas: herramientas.length
        });

    } catch (error) {
        console.error('Error en reingreso:', error);
        res.status(500).json({ error: "Error al procesar el reingreso." });
    }
});

// ==========================================
// INVENTARIO DE SERVICIOS (HERRAMIENTAS)
// ==========================================

app.get('/api/servicios/inventario', async (req, res) => {
    try {
        const [filas] = await db.query('SELECT * FROM inventario_uso_servicio ORDER BY nombre');
        res.json(filas);
    } catch (error) {
        console.error('Error al leer inventario de servicios:', error);
        res.status(500).json({ error: 'Error al leer el inventario de servicios' });
    }
});
// HERRAMIENTAS EN REPARACIÓN
app.get('/api/servicios/herramientas-reparacion', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, nombre, stock_total, disponibles, estado, observaciones 
             FROM inventario_uso_servicio 
             WHERE estado IN ('EN_REPARACION', 'DADO_BAJA')
             ORDER BY estado, nombre`
        );
        res.json({ herramientas: rows });
    } catch (error) {
        console.error('Error al obtener herramientas en reparación:', error);
        res.status(500).json({ error: "Error al consultar herramientas" });
    }
});

// HERRAMIENTA ESPECÍFICA
app.get('/api/servicios/herramienta/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, nombre, disponibles, estado, observaciones FROM inventario_uso_servicio WHERE id = $1',
            [req.params.id]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error('Error al obtener herramienta:', error);
        res.status(500).json({ error: "Error al consultar herramienta" });
    }
});

// PROCESAR REPARACIÓN
app.post('/api/servicios/procesar-reparacion', async (req, res) => {
    const { herramientaId, estadoFinal, observaciones, tecnico } = req.body;

    if (!herramientaId || !estadoFinal) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        // 👇 VALIDAR ESTADO ACTUAL ANTES DE PROCESAR
        const [checkRows] = await db.query(
            'SELECT nombre, estado FROM inventario_uso_servicio WHERE id = ?',
            [herramientaId]
        );

        if (checkRows.length === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        if (checkRows[0].estado === 'DADO_BAJA') {
            return res.status(400).json({ 
                error: `La herramienta "${checkRows[0].nombre}" ya fue dada de baja definitivamente` 
            });
        }

        if (checkRows[0].estado !== 'EN_REPARACION') {
            return res.status(400).json({ 
                error: `La herramienta "${checkRows[0].nombre}" no está en reparación (Estado: ${checkRows[0].estado})` 
            });
        }

        if (estadoFinal === 'REPARADO') {
            await db.query(
                `UPDATE inventario_uso_servicio 
                 SET disponibles = disponibles + 1, 
                     stock_total = stock_total + 1,
                     estado = "DISPONIBLE",
                     observaciones = CONCAT(IFNULL(observaciones, ''), " - Reparado: ", ?, " - ", NOW()) 
                 WHERE id = ?`,
                [observaciones || 'Reparación completada', herramientaId]
            );
        } else if (estadoFinal === 'NO_REPARABLE') {
            await db.query(
                `UPDATE inventario_uso_servicio 
                 SET stock_total = 0, 
                     disponibles = 0, 
                     estado = "DADO_BAJA",
                     observaciones = CONCAT(IFNULL(observaciones, ''), " - No reparable: ", ?, " - ", NOW()) 
                 WHERE id = ?`,
                [observaciones || 'No reparable, dado de baja', herramientaId]
            );
        } else {
            return res.status(400).json({ error: "Estado final no válido" });
        }

        res.json({
            mensaje: `Herramienta "${herramienta.nombre}" procesada exitosamente`,
            nombre: herramienta.nombre,
            estadoFinal: estadoFinal
        });

    } catch (error) {
        console.error('Error al procesar reparación:', error);
        res.status(500).json({ error: "Error al procesar la reparación" });
    }
});
// =================================================================
//      ENCENDIDO DEL SERVIDOR Y CAPTURADORES de EMERGENCIA
// =================================================================
// ENDPOINT AUXILIAR: Trae los productos de venta para los selectores del frontend
app.get('/api/preventa/productos-lista', async (req, res) => {
    try {
        const [filas] = await db.query('SELECT id, nombre, stock FROM inventario_venta WHERE stock > 0');
        res.json(filas);
    } catch (error) {
        res.status(500).json({ error: "Error al leer productos de venta." });
    }
});
// =================================================================
//   ENDPOINTS PARA SERVICIOS
// =================================================================

/// ==========================================
// OBTENER ÓRDENES ACTIVAS (SOLO BD)
// ==========================================
// OBTENER ÓRDENES ACTIVAS
app.get('/api/servicios/ordenes-activas', async (req, res) => {
    console.log('📋 Consultando órdenes activas...');
    
    try {
        const [ordenesBD] = await db.query(
            `SELECT 
                id_orden, 
                lugarTrabajo, 
                fecha_creacion, 
                estado,
                total_herramientas
             FROM ordenes_servicio 
             WHERE estado IN ('ACTIVA', 'EN_CAMPO')
             ORDER BY fecha_creacion DESC`
        );

        console.log(`📊 Encontradas ${ordenesBD.length} órdenes activas`);

        const ordenesFormateadas = ordenesBD.map(o => ({
            idOrden: o.id_orden,
            lugarTrabajo: o.lugarTrabajo,
            fechaCreacion: new Date(o.fecha_creacion).toLocaleString('es-CO'),
            estado: o.estado,
            totalHerramientas: o.total_herramientas || 0
        }));

        res.json({ ordenes: ordenesFormateadas });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ 
            error: 'Error al cargar órdenes activas',
            detalle: error.message 
        });
    }
});
// =================================================================
//   ENDPOINTS PARA ESTADÍSTICAS DEL PANEL (NUEVOS)
// =================================================================

// Servicios activos (ordenes en campo)
app.get('/api/servicios/activos', (req, res) => {
    const activos = Object.keys(ordenesServicioActivas).length;
    res.json({ total: activos });
});

// Ventas del día (desde la memoria de remisiones)
app.get('/api/preventa/ventas-hoy', (req, res) => {
    const totalRemisiones = Object.keys(remisionesVentaActivas).length;
    let totalVentas = 0;
    
    Object.values(remisionesVentaActivas).forEach(rem => {
        rem.productos.forEach(p => {
            totalVentas += p.cantidadVendidaEnCalle || 0;
        });
    });
    
    res.json({ 
        total: totalVentas,
        remisionesActivas: totalRemisiones
    });
});

// Productos con stock bajo (menos de 5)
app.get('/api/servicios/stock-bajo', async (req, res) => {
    try {
        const [filas] = await db.query(
            'SELECT id, nombre, disponibles FROM inventario_uso_servicio WHERE disponibles < 5'
        );
        res.json(filas);
    } catch (error) {
        res.status(500).json({ error: "Error al consultar stock bajo" });
    }
});
/// =================================================================
//   ENDPOINTS PARA ESTADÍSTICAS DEL PANEL (SOLO VENTAS)
// =================================================================

// 1. Contar productos en inventario_venta
app.get('/api/ventas/total-productos', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT COUNT(*) as total FROM inventario_venta');
        res.json({ total: rows[0].total || 0 });
    } catch (error) {
        console.error('Error al contar productos:', error);
        res.status(500).json({ error: "Error al consultar productos" });
    }
});

// 2. Productos con stock bajo (menos de 5) en inventario_venta
app.get('/api/ventas/stock-bajo', async (req, res) => {
    try {
        const { rows }   = await db.query('SELECT COUNT(*) as total FROM inventario_venta WHERE stock < 5');
        res.json({ total: rows[0].total || 0 });
    } catch (error) {
        console.error('Error al contar stock bajo:', error);
        res.status(500).json({ error: "Error al consultar stock bajo" });
    }
});

// 3. Ventas registradas (desde remisiones activas)
app.get('/api/ventas/ventas-hoy', (req, res) => {
    let totalVentas = 0;
    Object.values(remisionesVentaActivas).forEach(rem => {
        rem.productos.forEach(p => {
            totalVentas += p.cantidadVendidaEnCalle || 0;
        });
    });
    res.json({ total: totalVentas });
});

// 4. Remisiones activas (órdenes en ruta)
app.get('/api/ventas/remisiones-activas', (req, res) => {
    const activas = Object.keys(remisionesVentaActivas).length;
    res.json({ total: activas });
});
// =================================================================
// OBTENER UNA ORDEN DE SERVICIO ESPECÍFICA
// =================================================================
app.get('/api/servicios/orden/:idOrden', async (req, res) => {
    const { idOrden } = req.params;

    try {
        const [ordenRows] = await db.query(
            'SELECT * FROM ordenes_servicio WHERE id_orden = ?',
            [idOrden]
        );

        if (ordenRows.length === 0) {
            return res.status(404).json({ error: "Orden no encontrada." });
        }

        const orden = ordenRows[0];

        const [herramientas] = await db.query(
            'SELECT id_herramienta as id, nombre_herramienta as nombre FROM ordenes_servicio_herramientas WHERE id_orden = ?',
            [idOrden]
        );

        res.json({
            idOrden: orden.id_orden,
            colaboradorResponsable: orden.lugarTrabajo,
            estado: orden.estado,
            fechaCreacion: orden.fecha_creacion,
            herramientasAsignadas: herramientas
        });

    } catch (error) {
        console.error('Error al obtener orden:', error);
        res.status(500).json({ error: "Error al consultar la orden." });
    }
});
// =================================================================
// OBTENER HERRAMIENTAS EN REPARACIÓN O BAJA
// =================================================================
app.get('/api/servicios/herramientas-reparacion', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, nombre, stock_total, disponibles, estado, observaciones 
             FROM inventario_uso_servicio 
             WHERE estado IN ('EN_REPARACION', 'DADO_BAJA')
             ORDER BY estado, nombre`
        );
        res.json({ herramientas: rows });
    } catch (error) {
        console.error('Error al obtener herramientas en reparación:', error);
        res.status(500).json({ error: "Error al consultar herramientas" });
    }
});
// =================================================================
// OBTENER UNA HERRAMIENTA ESPECÍFICA
// =================================================================
app.get('/api/servicios/herramienta/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id, nombre, disponibles, estado, observaciones FROM inventario_uso_servicio WHERE id = $1',
            [req.params.id]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error('Error al obtener herramienta:', error);
        res.status(500).json({ error: "Error al consultar herramienta" });
    }
});
// =================================================================
// PROCESAR REPARACIÓN DE HERRAMIENTA
// =================================================================
app.post('/api/servicios/procesar-reparacion', async (req, res) => {
    const { herramientaId, estadoFinal, observaciones, tecnico } = req.body;

    if (!herramientaId || !estadoFinal) {
        return res.status(400).json({ error: "Datos incompletos" });
    }

    try {
        const { rows } = await db.query(
            'SELECT nombre, estado FROM inventario_uso_servicio WHERE id = $1',
            [herramientaId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Herramienta no encontrada" });
        }

        const herramienta = rows[0];

        if (estadoFinal === 'REPARADO') {
            await db.query(
                `UPDATE inventario_uso_servicio 
                 SET disponibles = disponibles + 1, 
                     stock_total = stock_total + 1,
                     estado = "DISPONIBLE",
                     observaciones = CONCAT(IFNULL(observaciones, ''), " - Reparado: ", ?, " - ", NOW()) 
                 WHERE id = ?`,
                [observaciones || 'Reparación completada', herramientaId]
            );
        } else if (estadoFinal === 'NO_REPARABLE') {
            await db.query(
                `UPDATE inventario_uso_servicio 
                 SET stock_total = 0, 
                     disponibles = 0, 
                     estado = "DADO_BAJA",
                     observaciones = CONCAT(IFNULL(observaciones, ''), " - No reparable: ", ?, " - ", NOW()) 
                 WHERE id = ?`,
                [observaciones || 'No reparable, dado de baja', herramientaId]
            );
        } else {
            return res.status(400).json({ error: "Estado final no válido" });
        }

        res.json({
            mensaje: `Herramienta "${herramienta.nombre}" procesada exitosamente`,
            nombre: herramienta.nombre,
            estadoFinal: estadoFinal
        });

    } catch (error) {
        console.error('Error al procesar reparación:', error);
        res.status(500).json({ error: "Error al procesar la reparación" });
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
        // CORRECCIÓN: Usamos llaves { rows } en vez de corchetes [rows] para Postgres
        // NOTA: Si tu columna 'activo' en Supabase es Boolean, cambiamos 'activo = 1' por 'activo = true'
        const { rows } = await db.query(
            'SELECT id, nombre, codigo, rol FROM usuarios WHERE codigo = $1 AND activo = true',
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

// Obtener datos del usuario actual (para el panel)
app.get('/api/auth/usuario', async (req, res) => {
    res.json({ mensaje: "Usuario autenticado" });
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
//   AGENDAMIENTO DE SERVICIOS
// =================================================================

// Obtener agendamientos
app.get('/api/servicios/agendamientos', async (req, res) => {
    const { estado } = req.query;
    let query = 'SELECT * FROM agendamientos';
    let params = [];

    if (estado && estado !== 'TODOS') {
        query += ' WHERE estado = ?';
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

// Crear agendamiento
app.post('/api/servicios/agendar', async (req, res) => {
    const { cliente, tipo_servicio, fecha, hora, tecnico, observaciones, usuario } = req.body;

    if (!cliente || !tipo_servicio || !fecha || !hora) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    try {
        await db.query(
            `INSERT INTO agendamientos 
             (cliente, tipo_servicio, fecha, hora, tecnico, observaciones, usuario_creacion) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [cliente, tipo_servicio, fecha, hora, tecnico, observaciones, usuario || 'Sistema']
        );
        res.json({ mensaje: 'Servicio agendado exitosamente' });
    } catch (error) {
        console.error('Error al agendar:', error);
        res.status(500).json({ error: 'Error al agendar servicio' });
    }
});

// Completar agendamiento
app.put('/api/servicios/agendamiento/:id/completar', async (req, res) => {
    const { id } = req.params;

    try {
        const [result] = await db.query(
            'UPDATE agendamientos SET estado = "COMPLETADO" WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Agendamiento no encontrado' });
        }

        res.json({ mensaje: 'Servicio completado' });
    } catch (error) {
        console.error('Error al completar:', error);
        res.status(500).json({ error: 'Error al completar servicio' });
    }
});

// Cancelar agendamiento
app.put('/api/servicios/agendamiento/:id/cancelar', async (req, res) => {
    const { id } = req.params;

    try {
        const [result] = await db.query(
            'UPDATE agendamientos SET estado = "CANCELADO" WHERE id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Agendamiento no encontrado' });
        }

        res.json({ mensaje: 'Servicio cancelado' });
    } catch (error) {
        console.error('Error al cancelar:', error);
        res.status(500).json({ error: 'Error al cancelar servicio' });
    }
});
// =================================================================
//   MÓDULO DE INVENTARIO (CON TABLAS EXISTENTES)
// =================================================================

// 1. Obtener inventario unificado (ventas + servicios)
app.get('/api/inventario', async (req, res) => {
    const { buscar, tipo, estado } = req.query;
    
    try {
        let queryParts = [];
        let params = [];

        // Consulta para productos de VENTA
        let queryVenta = 'SELECT id, nombre, "VENTA" as tipo, stock, costo, precio_venta, "DISPONIBLE" as estado FROM inventario_venta';
        let queryServicio = 'SELECT id, nombre, "SERVICIO" as tipo, disponibles as stock, 0 as costo, 0 as precio_venta, estado FROM inventario_uso_servicio';
        
        let conditions = [];
        
        if (buscar) {
            conditions.push(`nombre LIKE ?`);
            params.push(`%${buscar}%`);
        }
        
        if (tipo && tipo !== 'TODOS') {
            // Si se filtra por tipo, solo consultamos esa tabla
            if (tipo === 'VENTA') {
                const ventaQuery = `SELECT id, nombre, "VENTA" as tipo, stock, costo, precio_venta, "DISPONIBLE" as estado FROM inventario_venta`;
                const { rows } = await db.query(
                    buscar ? `${ventaQuery} WHERE nombre LIKE ?` : ventaQuery,
                    buscar ? [`%${buscar}%`] : []
                );
                return res.json({ productos: rows });
            } else if (tipo === 'SERVICIO') {
                const servicioQuery = `SELECT id, nombre, "SERVICIO" as tipo, disponibles as stock, 0 as costo, 0 as precio_venta, estado FROM inventario_uso_servicio`;
                const { rows } = await db.query(
                    buscar ? `${servicioQuery} WHERE nombre LIKE $1` : servicioQuery,
                    buscar ? [`%${buscar}%`] : []
                );
                return res.json({ productos: rows });
            }
        }
        
        // Si no hay filtro de tipo, unir ambas tablas
        let fullQuery = `
            SELECT id, nombre, tipo, stock, costo, precio_venta, estado FROM (
                SELECT id, nombre, "VENTA" as tipo, stock, costo, precio_venta, "DISPONIBLE" as estado FROM inventario_venta
                UNION ALL
                SELECT id, nombre, "SERVICIO" as tipo, disponibles as stock, 0 as costo, 0 as precio_venta, estado FROM inventario_uso_servicio
            ) as inventario_unificado
        `;
        
        if (buscar) {
            fullQuery += ` WHERE nombre LIKE ?`;
            params = [`%${buscar}%`];
        }
        
        fullQuery += ' ORDER BY nombre';
        
        const { rows } = await db.query(fullQuery, params);
        res.json({ productos: rows });
        
    } catch (error) {
        console.error('Error al obtener inventario:', error);
        res.status(500).json({ error: 'Error al obtener inventario' });
    }
});

// ==========================================
// HISTORIAL DE FACTURAS DE COMPRA (AGRUPADO)
// ==========================================
app.get('/api/inventario/historial', async (req, res) => {
    try {
        // Obtener el resumen de facturas
        const [facturas] = await db.query(`
            SELECT 
                fc.id as factura_id,
                fc.numero_factura,
                fc.proveedor,
                fc.fecha_factura,
                fc.fecha_registro,
                fc.usuario,
                fc.total_compra,
                fc.observaciones,
                COUNT(fd.id) as total_productos,
                SUM(fd.cantidad) as total_unidades
            FROM facturas_compra fc
            LEFT JOIN facturas_detalle fd ON fc.id = fd.factura_id
            GROUP BY fc.id
            ORDER BY fc.fecha_factura DESC, fc.id DESC
        `);

        if (facturas.length === 0) {
            return res.json({ 
                facturas: [],
                mensaje: 'No hay facturas de compra registradas aún.'
            });
        }

        // Formatear los datos
        const resultado = facturas.map(f => ({
            id: f.factura_id,
            numero: f.numero_factura || 'S/N',
            proveedor: f.proveedor || 'Sin proveedor',
            fecha: f.fecha_factura || f.fecha_registro,
            usuario: f.usuario || 'Sistema',
            total: parseFloat(f.total_compra || 0),
            productos: parseInt(f.total_productos || 0),
            unidades: parseInt(f.total_unidades || 0),
            observaciones: f.observaciones || ''
        }));

        res.json({ facturas: resultado });

    } catch (error) {
        console.error('Error al obtener historial de facturas:', error);
        res.status(500).json({ 
            error: 'Error al obtener historial de facturas',
            detalle: error.message 
        });
    }
});

// ==========================================
// OBTENER DETALLE DE UNA FACTURA ESPECÍFICA
// ==========================================
app.get('/api/inventario/factura/:id', async (req, res) => {
    const facturaId = req.params.id;

    try {
        // Obtener cabecera de la factura
        const [cabecera] = await db.query(`
            SELECT 
                fc.*,
                COUNT(fd.id) as total_productos,
                SUM(fd.cantidad) as total_unidades
            FROM facturas_compra fc
            LEFT JOIN facturas_detalle fd ON fc.id = fd.factura_id
            WHERE fc.id = ?
            GROUP BY fc.id
        `, [facturaId]);

        if (cabecera.length === 0) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        // Obtener detalles de la factura
        const [detalles] = await db.query(`
            SELECT 
                id,
                producto_nombre as nombre,
                producto_tipo as tipo,
                cantidad,
                costo_unitario as costo,
                precio_venta,
                subtotal
            FROM facturas_detalle
            WHERE factura_id = ?
            ORDER BY id
        `, [facturaId]);

        res.json({
            cabecera: cabecera[0],
            detalles: detalles
        });

    } catch (error) {
        console.error('Error al obtener detalle de factura:', error);
        res.status(500).json({ 
            error: 'Error al obtener detalle de factura',
            detalle: error.message 
        });
    }
});
const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor de Mecatron Solutions corriendo en'https://mecatron-solutions.onrender.com;${PORT}`);
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