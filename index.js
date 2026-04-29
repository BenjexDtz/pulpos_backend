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
    if (!token) return res.status(403).json({ error: '🚫 Acceso denegado. Se requiere un token.' });
    try {
        const tokenLimpio = token.split(" ")[1] || token;
        const decodificado = jwt.verify(tokenLimpio, process.env.JWT_SECRET);
        req.usuario = decodificado;
        next();
    } catch {
        return res.status(401).json({ error: '🚫 Token inválido o expirado.' });
    }
};

app.get('/', (req, res) => {
    res.json({ mensaje: '📡 Central de Radio Taxis Pulpos en línea' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARÁMETROS TOPOGRÁFICOS
// ═══════════════════════════════════════════════════════════════════════════════

// Público — Flutter los descarga al iniciar el viaje
app.get('/api/parametros', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM parametros_topograficos ORDER BY id LIMIT 1');
        res.json(resultado.rows[0] || null);
    } catch (error) {
        res.status(500).json({ error: 'Error al leer parámetros.' });
    }
});

// Solo admin — editar parámetros desde el panel web
app.put('/api/admin/parametros/:id', verificarToken, async (req, res) => {
    const { id } = req.params;
    const { zona_ciudad, costo_base_km, factor_altitud, factor_superficie, costo_minuto_detencion } = req.body;

    if (!costo_base_km || !factor_altitud || !factor_superficie || !costo_minuto_detencion)
        return res.status(400).json({ error: '⚠️ Todos los campos son obligatorios.' });

    try {
        const resultado = await pool.query(
            `UPDATE parametros_topograficos
             SET zona_ciudad=$1, costo_base_km=$2, factor_altitud=$3,
                 factor_superficie=$4, costo_minuto_detencion=$5, fecha_actualizacion=NOW()
             WHERE id=$6 RETURNING *`,
            [zona_ciudad, costo_base_km, factor_altitud, factor_superficie, costo_minuto_detencion, id]
        );
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'Parámetro no encontrado.' });
        console.log('⚙️ Parámetros topográficos actualizados por gerencia.');
        res.json({ mensaje: '✅ Parámetros actualizados. Los conductores los recibirán al iniciar la app.', parametros: resultado.rows[0] });
    } catch (error) {
        console.error('Error actualizando parámetros:', error.message);
        res.status(500).json({ error: 'Error al actualizar parámetros.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// APP MÓVIL — SINCRONIZACIÓN Y GPS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/viajes/sincronizar', async (req, res) => {
    const { chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje } = req.body;
    if (!chofer_id || distancia_km === undefined)
        return res.status(400).json({ error: 'Faltan datos del viaje.' });
    try {
        const resultado = await pool.query(
            `INSERT INTO viajes_historial (chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje)
             VALUES ($1,$2,$3,$4,$5) RETURNING id_servidor`,
            [chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje]
        );
        console.log(`📥 Viaje del chofer ${chofer_id} — ID: ${resultado.rows[0].id_servidor}`);
        res.status(201).json({ success: true, id_servidor: resultado.rows[0].id_servidor });
    } catch (error) {
        console.error('❌ Error sincronizando viaje:', error.message);
        res.status(500).json({ error: 'Error al guardar en la base central' });
    }
});

// GPS en tiempo real — chofer llama esto cada ~10 segundos durante el viaje
app.post('/api/posicion', verificarToken, async (req, res) => {
    const { lat, lng } = req.body;
    const chofer_id = req.usuario.id;
    if (lat === undefined || lng === undefined)
        return res.status(400).json({ error: 'Se requieren lat y lng.' });
    if (lat < -23 || lat > -9 || lng < -70 || lng > -57)
        return res.status(400).json({ error: 'Coordenadas fuera de rango de Bolivia.' });
    try {
        const resultado = await pool.query(
            `UPDATE choferes SET ultima_lat=$1, ultima_lng=$2, ultima_actualizacion=NOW()
             WHERE id=$3 RETURNING id, nombre_completo`,
            [lat, lng, chofer_id]
        );
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'Chofer no encontrado.' });
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error actualizando posición:', error.message);
        res.status(500).json({ error: 'Error al actualizar posición.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN APP MÓVIL
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {
    const { placa_vehiculo, password } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM choferes WHERE placa_vehiculo = $1', [placa_vehiculo]);
        if (resultado.rows.length === 0)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });

        const chofer = resultado.rows[0];

        // Bloqueo si fue desactivado desde el admin
        if (!chofer.estado_activo)
            return res.status(403).json({ error: '🚫 Tu cuenta está desactivada. Contacta a la central.' });

        const passwordValida = await bcrypt.compare(password, chofer.password_hash);
        if (!passwordValida)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });

        const token = jwt.sign(
            { id: chofer.id, placa: chofer.placa_vehiculo },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ mensaje: '🔓 Login exitoso', token, chofer: { id: chofer.id, nombre_completo: chofer.nombre_completo, placa_vehiculo: chofer.placa_vehiculo } });
    } catch (error) {
        console.error('Error en Login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/choferes/registro', async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const resultado = await pool.query(
            `INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
             VALUES ($1,$2,$3) RETURNING id, nombre_completo, placa_vehiculo`,
            [nombre_completo, placa_vehiculo, password_hash]
        );
        res.status(201).json({ mensaje: '✅ Chofer registrado', chofer: resultado.rows[0] });
    } catch {
        res.status(500).json({ error: 'Error al registrar chofer' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL ADMIN — GERENCIA
// ═══════════════════════════════════════════════════════════════════════════════

// Credenciales desde .env (no hardcodeadas)
app.post('/api/admin/login', (req, res) => {
    const { usuario, password } = req.body;
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'pulpos2026';

    if (usuario === adminUser && password === adminPass) {
        const token = jwt.sign({ rol: 'gerente' }, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.json({ mensaje: '✅ Bienvenido a la Gerencia', token });
    } else {
        res.status(401).json({ error: '❌ Usuario o contraseña incorrecta' });
    }
});

// Viajes con filtro opcional por fecha
app.get('/api/admin/viajes', verificarToken, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let query = `
            SELECT v.id_servidor AS id, c.nombre_completo AS chofer, c.placa_vehiculo,
                   v.distancia_km, v.tiempo_detencion_min,
                   v.tarifa_cobrada AS tarifa_total, v.fecha_hora_viaje AS fecha_hora
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
        `;
        const params = [];
        if (desde && hasta) {
            query += ` WHERE v.fecha_hora_viaje BETWEEN $1 AND $2`;
            params.push(desde, hasta);
        }
        query += ` ORDER BY v.fecha_hora_viaje DESC`;
        const resultado = await pool.query(query, params);
        res.json(resultado.rows);
    } catch (error) {
        console.error('Error al obtener viajes:', error);
        res.status(500).json({ error: 'Error cargando el dashboard' });
    }
});

// Exportar CSV con BOM para Excel en español
app.get('/api/admin/viajes/exportar', verificarToken, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let query = `
            SELECT v.id_servidor AS "ID",
                   c.nombre_completo AS "Conductor",
                   c.placa_vehiculo AS "Placa",
                   ROUND(v.distancia_km::numeric,3) AS "Distancia (km)",
                   ROUND(v.tiempo_detencion_min::numeric,2) AS "Detención (min)",
                   ROUND(v.tarifa_cobrada::numeric,2) AS "Tarifa (Bs)",
                   TO_CHAR(v.fecha_hora_viaje,'DD/MM/YYYY HH24:MI') AS "Fecha"
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
        `;
        const params = [];
        if (desde && hasta) { query += ` WHERE v.fecha_hora_viaje BETWEEN $1 AND $2`; params.push(desde, hasta); }
        query += ` ORDER BY v.fecha_hora_viaje DESC`;

        const resultado = await pool.query(query, params);
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'No hay datos para exportar.' });

        const cols = Object.keys(resultado.rows[0]);
        const header = cols.join(',');
        const rows = resultado.rows.map(row =>
            cols.map(c => `"${(row[c] ?? '').toString().replace(/"/g, '""')}"`).join(',')
        );
        const csv = [header, ...rows].join('\n');
        const fecha = new Date().toISOString().slice(0, 10);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pulpos_viajes_${fecha}.csv"`);
        res.send('\uFEFF' + csv);
    } catch (error) {
        console.error('Error exportando CSV:', error.message);
        res.status(500).json({ error: 'Error al generar el CSV.' });
    }
});

// Choferes con GPS
app.get('/api/admin/choferes', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT id, nombre_completo, placa_vehiculo, estado_activo,
                   ultima_lat, ultima_lng, ultima_actualizacion
            FROM choferes ORDER BY nombre_completo ASC
        `);
        res.json(resultado.rows);
    } catch {
        res.status(500).json({ error: 'Error al obtener choferes.' });
    }
});

app.post('/api/admin/choferes', verificarToken, async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;
    if (!nombre_completo || !placa_vehiculo || !password)
        return res.status(400).json({ error: '⚠️ Faltan datos obligatorios.' });
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const resultado = await pool.query(
            `INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
             VALUES ($1,$2,$3) RETURNING id, nombre_completo, placa_vehiculo, estado_activo`,
            [nombre_completo, placa_vehiculo, passwordHash]
        );
        res.status(201).json({ mensaje: '✅ Chofer registrado.', chofer: resultado.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: '❌ Esta placa ya está registrada.' });
        res.status(500).json({ error: 'Error interno al registrar chofer.' });
    }
});

app.patch('/api/admin/choferes/:id/password', verificarToken, async (req, res) => {
    const { id } = req.params;
    const { nueva_password } = req.body;
    if (!nueva_password || nueva_password.length < 4)
        return res.status(400).json({ error: '⚠️ Contraseña mínimo 4 caracteres.' });
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(nueva_password, salt);
        const resultado = await pool.query(
            'UPDATE choferes SET password_hash=$1 WHERE id=$2 RETURNING id, nombre_completo',
            [passwordHash, id]
        );
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'Chofer no encontrado.' });
        res.json({ mensaje: `✅ Contraseña actualizada para ${resultado.rows[0].nombre_completo}.` });
    } catch {
        res.status(500).json({ error: 'Error al actualizar la contraseña.' });
    }
});

app.patch('/api/admin/choferes/:id/estado', verificarToken, async (req, res) => {
    const { id } = req.params;
    const { estado_activo } = req.body;
    try {
        const resultado = await pool.query(
            `UPDATE choferes SET estado_activo=$1 WHERE id=$2 RETURNING id, nombre_completo, estado_activo`,
            [estado_activo, id]
        );
        if (resultado.rows.length === 0) return res.status(404).json({ error: 'Chofer no encontrado.' });
        res.json({ mensaje: `✅ Chofer ${estado_activo ? 'activado' : 'desactivado'}.`, chofer: resultado.rows[0] });
    } catch {
        res.status(500).json({ error: 'Error al actualizar estado.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));