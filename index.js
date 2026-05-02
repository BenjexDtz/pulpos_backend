const express = require('express');
const cors = require('cors');
const pool = require('./db');
require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// ── MIDDLEWARE JWT ─────────────────────────────────────────────────────────────
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ error: '🚫 Acceso denegado.' });
    try {
        const tokenLimpio = token.split(' ')[1] || token;
        req.usuario = jwt.verify(tokenLimpio, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: '🚫 Token inválido o expirado.' });
    }
};

app.get('/', (req, res) => res.json({ mensaje: '📡 Central de Radio Taxis Pulpos en línea' }));

// ═══════════════════════════════════════════════════════════════════════════════
// PARÁMETROS TOPOGRÁFICOS
// ═══════════════════════════════════════════════════════════════════════════════

// Público — Flutter descarga estos valores al iniciar
app.get('/api/parametros', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM parametros_topograficos ORDER BY id LIMIT 1');
        res.json(r.rows[0] || null);
    } catch (e) {
        res.status(500).json({ error: 'Error al leer parámetros.' });
    }
});

// Admin — editar parámetros desde el panel
app.put('/api/admin/parametros/:id', verificarToken, async (req, res) => {
    const { id } = req.params;
    const { zona_ciudad, costo_base_km, factor_altitud, factor_superficie, costo_minuto_detencion } = req.body;
    if (!costo_base_km || !factor_altitud || !factor_superficie || !costo_minuto_detencion)
        return res.status(400).json({ error: '⚠️ Todos los campos son obligatorios.' });
    try {
        const r = await pool.query(
            `UPDATE parametros_topograficos
             SET zona_ciudad=$1, costo_base_km=$2, factor_altitud=$3,
                 factor_superficie=$4, costo_minuto_detencion=$5, fecha_actualizacion=NOW()
             WHERE id=$6 RETURNING *`,
            [zona_ciudad, costo_base_km, factor_altitud, factor_superficie, costo_minuto_detencion, id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
        console.log('⚙️ Parámetros actualizados por gerencia.');
        res.json({ mensaje: '✅ Parámetros actualizados. Los conductores los recibirán al iniciar la app.', parametros: r.rows[0] });
    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: 'Error al actualizar parámetros.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// APP MÓVIL — SINCRONIZACIÓN DE VIAJES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/viajes/sincronizar', async (req, res) => {
    const {
        chofer_id,
        distancia_km,
        tiempo_detencion_min,
        tarifa_cobrada,
        fecha_hora_viaje,
        // Parámetros topográficos aplicados (nuevos campos)
        tipo_superficie           = 'asfalto',
        factor_altitud_aplicado   = 1.40,
        factor_superficie_aplicado = 1.00,
        costo_base_aplicado       = 2.00,
        costo_minuto_aplicado     = 0.50
    } = req.body;

    if (!chofer_id || distancia_km === undefined)
        return res.status(400).json({ error: 'Faltan datos del viaje.' });

    try {
        const r = await pool.query(
            `INSERT INTO viajes_historial (
                chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada,
                tipo_superficie, factor_altitud_aplicado, factor_superficie_aplicado,
                costo_base_aplicado, costo_minuto_aplicado, fecha_hora_viaje
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id_servidor`,
            [
                chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada,
                tipo_superficie, factor_altitud_aplicado, factor_superficie_aplicado,
                costo_base_aplicado, costo_minuto_aplicado, fecha_hora_viaje
            ]
        );
        console.log(`📥 Viaje chofer=${chofer_id} | ${distancia_km}km | ${tipo_superficie} | Bs${tarifa_cobrada} → ID:${r.rows[0].id_servidor}`);
        res.status(201).json({ success: true, id_servidor: r.rows[0].id_servidor });
    } catch (e) {
        console.error('❌ Error sincronizando viaje:', e.message);
        res.status(500).json({ error: 'Error al guardar en la base central.' });
    }
});

// GPS en tiempo real (cada ~10 segundos durante el viaje)
app.post('/api/posicion', verificarToken, async (req, res) => {
    const { lat, lng } = req.body;
    const chofer_id = req.usuario.id;
    if (lat === undefined || lng === undefined)
        return res.status(400).json({ error: 'Se requieren lat y lng.' });
    if (lat < -23 || lat > -9 || lng < -70 || lng > -57)
        return res.status(400).json({ error: 'Coordenadas fuera de Bolivia.' });
    try {
        const r = await pool.query(
            `UPDATE choferes SET ultima_lat=$1, ultima_lng=$2, ultima_actualizacion=NOW()
             WHERE id=$3 RETURNING nombre_completo`,
            [lat, lng, chofer_id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Chofer no encontrado.' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Error al actualizar posición.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN APP MÓVIL
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {
    const { placa_vehiculo, password } = req.body;
    try {
        const r = await pool.query('SELECT * FROM choferes WHERE placa_vehiculo = $1', [placa_vehiculo]);
        if (!r.rows.length)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });

        const chofer = r.rows[0];
        if (!chofer.estado_activo)
            return res.status(403).json({ error: '🚫 Tu cuenta está desactivada. Contacta a la central.' });
        if (!chofer.password_hash)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });

        const valida = await bcrypt.compare(password, chofer.password_hash);
        if (!valida)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });

        const token = jwt.sign(
            { id: chofer.id, placa: chofer.placa_vehiculo },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({
            mensaje: '🔓 Login exitoso',
            token,
            chofer: { id: chofer.id, nombre_completo: chofer.nombre_completo, placa_vehiculo: chofer.placa_vehiculo }
        });
    } catch (e) {
        console.error('Error en login:', e);
        res.status(500).json({ error: 'Error interno.' });
    }
});

app.post('/api/choferes/registro', async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const r = await pool.query(
            `INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
             VALUES ($1,$2,$3) RETURNING id, nombre_completo, placa_vehiculo`,
            [nombre_completo, placa_vehiculo, hash]
        );
        res.status(201).json({ mensaje: '✅ Chofer registrado', chofer: r.rows[0] });
    } catch {
        res.status(500).json({ error: 'Error al registrar.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL ADMIN — LOGIN (ahora usa tabla administradores)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', async (req, res) => {
    const { usuario, password } = req.body;
    // "usuario" puede ser el email o el nombre de usuario
    try {
        const r = await pool.query(
            `SELECT * FROM administradores
             WHERE (email = $1 OR nombre = $1) AND activo = TRUE
             LIMIT 1`,
            [usuario]
        );

        if (!r.rows.length)
            return res.status(401).json({ error: '❌ Usuario o contraseña incorrecta.' });

        const admin = r.rows[0];
        const valida = await bcrypt.compare(password, admin.password_hash);
        if (!valida)
            return res.status(401).json({ error: '❌ Usuario o contraseña incorrecta.' });

        const token = jwt.sign(
            { id: admin.id, rol: admin.rol, nombre: admin.nombre },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );
        console.log(`🔑 Login admin: ${admin.nombre} (${admin.rol})`);
        res.json({ mensaje: `✅ Bienvenido, ${admin.nombre}`, token, rol: admin.rol });
    } catch (e) {
        console.error('Error en login admin:', e.message);
        res.status(500).json({ error: 'Error interno.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL ADMIN — ENDPOINTS PROTEGIDOS
// ═══════════════════════════════════════════════════════════════════════════════

// Viajes con filtro opcional por fecha + columnas de auditoría topográfica
app.get('/api/admin/viajes', verificarToken, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let query = `
            SELECT
                v.id_servidor                    AS id,
                c.nombre_completo                AS chofer,
                c.placa_vehiculo,
                v.distancia_km,
                v.tiempo_detencion_min,
                v.tarifa_cobrada                 AS tarifa_total,
                -- Evidencia topográfica del viaje
                v.tipo_superficie,
                v.factor_altitud_aplicado,
                v.factor_superficie_aplicado,
                v.costo_base_aplicado,
                v.costo_minuto_aplicado,
                v.fecha_hora_viaje               AS fecha_hora
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
        `;
        const params = [];
        if (desde && hasta) {
            query += ` WHERE v.fecha_hora_viaje BETWEEN $1 AND $2`;
            params.push(desde, hasta);
        }
        query += ` ORDER BY v.fecha_hora_viaje DESC`;

        const r = await pool.query(query, params);
        res.json(r.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error cargando viajes.' });
    }
});

// Exportar CSV con todos los campos de auditoría
app.get('/api/admin/viajes/exportar', verificarToken, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let query = `
            SELECT
                v.id_servidor                               AS "ID",
                c.nombre_completo                           AS "Conductor",
                c.placa_vehiculo                            AS "Placa",
                ROUND(v.distancia_km::numeric, 3)           AS "Distancia (km)",
                ROUND(v.tiempo_detencion_min::numeric, 2)   AS "Detención (min)",
                v.tipo_superficie                           AS "Superficie",
                v.factor_altitud_aplicado                   AS "FH Altitud",
                v.factor_superficie_aplicado                AS "FR Superficie",
                v.costo_base_aplicado                       AS "Cb (Bs/km)",
                v.costo_minuto_aplicado                     AS "Ct (Bs/min)",
                ROUND(v.tarifa_cobrada::numeric, 2)         AS "Tarifa Total (Bs)",
                TO_CHAR(v.fecha_hora_viaje,'DD/MM/YYYY HH24:MI') AS "Fecha Viaje"
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
        `;
        const params = [];
        if (desde && hasta) { query += ` WHERE v.fecha_hora_viaje BETWEEN $1 AND $2`; params.push(desde, hasta); }
        query += ` ORDER BY v.fecha_hora_viaje DESC`;

        const r = await pool.query(query, params);
        if (!r.rows.length) return res.status(404).json({ error: 'Sin datos.' });

        const cols = Object.keys(r.rows[0]);
        const csv = [
            cols.join(','),
            ...r.rows.map(row => cols.map(c => `"${(row[c] ?? '').toString().replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        const fecha = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pulpos_auditoria_${fecha}.csv"`);
        res.send('\uFEFF' + csv);
    } catch (e) {
        res.status(500).json({ error: 'Error generando CSV.' });
    }
});

// Choferes con GPS
app.get('/api/admin/choferes', verificarToken, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT id, nombre_completo, placa_vehiculo, estado_activo,
                   ultima_lat, ultima_lng, ultima_actualizacion
            FROM choferes ORDER BY nombre_completo ASC
        `);
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Error obteniendo choferes.' }); }
});

app.post('/api/admin/choferes', verificarToken, async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;
    if (!nombre_completo || !placa_vehiculo || !password)
        return res.status(400).json({ error: '⚠️ Faltan datos.' });
    try {
        const hash = await bcrypt.hash(password, 10);
        const r = await pool.query(
            `INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
             VALUES ($1,$2,$3) RETURNING id, nombre_completo, placa_vehiculo, estado_activo`,
            [nombre_completo, placa_vehiculo, hash]
        );
        res.status(201).json({ mensaje: '✅ Chofer registrado.', chofer: r.rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: '❌ Placa ya registrada.' });
        res.status(500).json({ error: 'Error interno.' });
    }
});

app.patch('/api/admin/choferes/:id/password', verificarToken, async (req, res) => {
    const { nueva_password } = req.body;
    if (!nueva_password || nueva_password.length < 4)
        return res.status(400).json({ error: '⚠️ Mínimo 4 caracteres.' });
    try {
        const hash = await bcrypt.hash(nueva_password, 10);
        const r = await pool.query(
            'UPDATE choferes SET password_hash=$1 WHERE id=$2 RETURNING nombre_completo',
            [hash, req.params.id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
        res.json({ mensaje: `✅ Contraseña actualizada para ${r.rows[0].nombre_completo}.` });
    } catch { res.status(500).json({ error: 'Error.' }); }
});

app.patch('/api/admin/choferes/:id/estado', verificarToken, async (req, res) => {
    const { estado_activo } = req.body;
    try {
        const r = await pool.query(
            `UPDATE choferes SET estado_activo=$1 WHERE id=$2
             RETURNING id, nombre_completo, estado_activo`,
            [estado_activo, req.params.id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
        res.json({ mensaje: `✅ Chofer ${estado_activo ? 'activado' : 'desactivado'}.`, chofer: r.rows[0] });
    } catch { res.status(500).json({ error: 'Error.' }); }
});

// Gestión de administradores (solo para gerente)
app.get('/api/admin/administradores', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'gerente')
        return res.status(403).json({ error: 'Solo gerencia puede ver esto.' });
    try {
        const r = await pool.query(
            `SELECT id, nombre, email, rol, activo, fecha_registro
             FROM administradores ORDER BY fecha_registro ASC`
        );
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Error.' }); }
});

app.post('/api/admin/administradores', verificarToken, async (req, res) => {
    if (req.usuario.rol !== 'gerente')
        return res.status(403).json({ error: 'Solo gerencia puede hacer esto.' });
    const { nombre, email, password, rol = 'supervisor' } = req.body;
    if (!nombre || !email || !password)
        return res.status(400).json({ error: '⚠️ Faltan datos.' });
    try {
        const hash = await bcrypt.hash(password, 10);
        const r = await pool.query(
            `INSERT INTO administradores (nombre, email, password_hash, rol)
             VALUES ($1,$2,$3,$4) RETURNING id, nombre, email, rol`,
            [nombre, email, hash, rol]
        );
        res.status(201).json({ mensaje: '✅ Administrador creado.', admin: r.rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: '❌ Email ya registrado.' });
        res.status(500).json({ error: 'Error interno.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));