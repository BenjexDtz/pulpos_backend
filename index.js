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
    } catch (error) {
        return res.status(401).json({ error: '🚫 Token inválido o expirado.' });
    }
};

// ── RAÍZ ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ mensaje: '📡 Central de Radio Taxis Pulpos en línea' });
});

// ── PARÁMETROS TOPOGRÁFICOS ───────────────────────────────────────────────────
app.get('/api/parametros', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM parametros_topograficos');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Error en el servidor de base de datos');
    }
});

// ── REPORTE PÚBLICO ───────────────────────────────────────────────────────────
app.get('/api/viajes/reporte', async (req, res) => {
    try {
        const query = `
            SELECT c.nombre_completo, c.placa_vehiculo,
                COUNT(v.id_servidor) as total_viajes,
                SUM(v.distancia_km) as kilometros_recorridos,
                SUM(v.tarifa_cobrada) as dinero_recaudado
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
            GROUP BY c.nombre_completo, c.placa_vehiculo
            ORDER BY dinero_recaudado DESC;
        `;
        const resultado = await pool.query(query);
        if (resultado.rows.length === 0) return res.json({ mensaje: 'No hay viajes registrados aún.' });
        res.json({ mensaje: 'Reporte generado exitosamente', estadisticas: resultado.rows });
    } catch (error) {
        console.error('❌ Error al generar el reporte:', error.message);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MÓDULO APP MÓVIL: SINCRONIZACIÓN DE VIAJES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/viajes/sincronizar', async (req, res) => {
    const { chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje } = req.body;
    if (!chofer_id || distancia_km === undefined)
        return res.status(400).json({ error: 'Faltan datos del viaje.' });

    try {
        const query = `
            INSERT INTO viajes_historial (chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje)
            VALUES ($1, $2, $3, $4, $5) RETURNING id_servidor;
        `;
        const resultado = await pool.query(query, [
            chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje
        ]);
        console.log(`📥 Viaje recibido del chofer ${chofer_id} — ID: ${resultado.rows[0].id_servidor}`);
        res.status(201).json({
            success: true,
            mensaje: 'Viaje sincronizado',
            id_servidor: resultado.rows[0].id_servidor
        });
    } catch (error) {
        console.error('❌ Error sincronizando viaje:', error.message);
        res.status(500).json({ error: 'Error al guardar en la base central' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔥 NUEVO: POSICIÓN EN TIEMPO REAL (GPS VIVO)
// El conductor llama esto cada ~10 segundos durante el viaje.
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/posicion', verificarToken, async (req, res) => {
    const { lat, lng } = req.body;
    const chofer_id = req.usuario.id;

    if (lat === undefined || lng === undefined)
        return res.status(400).json({ error: 'Se requieren lat y lng.' });

    // Validación básica de rango geográfico (Bolivia)
    if (lat < -23 || lat > -9 || lng < -70 || lng > -57) {
        console.warn(`⚠️ Coordenadas fuera de Bolivia: chofer=${chofer_id} lat=${lat} lng=${lng}`);
        return res.status(400).json({ error: 'Coordenadas fuera de rango.' });
    }

    try {
        const resultado = await pool.query(
            `UPDATE choferes
             SET ultima_lat = $1,
                 ultima_lng = $2,
                 ultima_actualizacion = NOW()
             WHERE id = $3
             RETURNING id, nombre_completo`,
            [lat, lng, chofer_id]
        );

        if (resultado.rows.length === 0)
            return res.status(404).json({ error: 'Chofer no encontrado.' });

        console.log(`📍 ${resultado.rows[0].nombre_completo} → lat:${lat} lng:${lng}`);
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error actualizando posición:', error.message);
        res.status(500).json({ error: 'Error al actualizar posición.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MÓDULO WEB ADMIN (GERENCIA)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
    const { usuario, password } = req.body;
    if (usuario === 'admin' && password === 'pulpos2026') {
        const token = jwt.sign({ rol: 'gerente' }, process.env.JWT_SECRET, { expiresIn: '8h' });
        res.json({ mensaje: '✅ Bienvenido a la Gerencia', token });
    } else {
        res.status(401).json({ error: '❌ Usuario o contraseña incorrecta' });
    }
});

app.get('/api/admin/viajes', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT v.id_servidor AS id, c.nombre_completo AS chofer, c.placa_vehiculo,
                v.distancia_km, v.tiempo_detencion_min,
                v.tarifa_cobrada AS tarifa_total, v.fecha_hora_viaje AS fecha_hora
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
            ORDER BY v.fecha_hora_viaje DESC;
        `;
        const resultado = await pool.query(query);
        res.json(resultado.rows);
    } catch (error) {
        console.error('Error al obtener reporte:', error);
        res.status(500).json({ error: 'Error cargando el dashboard' });
    }
});

// 🔥 MODIFICADO: Ahora incluye ultima_lat, ultima_lng, ultima_actualizacion
app.get('/api/admin/choferes', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                id,
                nombre_completo,
                placa_vehiculo,
                estado_activo,
                ultima_lat,
                ultima_lng,
                ultima_actualizacion
            FROM choferes
            ORDER BY nombre_completo ASC
        `);
        res.json(resultado.rows);
    } catch (error) {
        console.error('Error al listar choferes:', error.message);
        res.status(500).json({ error: 'Error al obtener la lista de choferes.' });
    }
});

// Registrar nuevo chofer (desde panel admin)
app.post('/api/admin/choferes', verificarToken, async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;
    if (!nombre_completo || !placa_vehiculo || !password)
        return res.status(400).json({ error: '⚠️ Faltan datos obligatorios.' });

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const query = `
            INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, nombre_completo, placa_vehiculo, estado_activo;
        `;
        const resultado = await pool.query(query, [nombre_completo, placa_vehiculo, passwordHash]);
        res.status(201).json({
            mensaje: '✅ Chofer registrado exitosamente.',
            chofer: resultado.rows[0]
        });
    } catch (error) {
        if (error.code === '23505')
            return res.status(400).json({ error: '❌ Esta placa ya está registrada.' });
        res.status(500).json({ error: 'Error interno al registrar chofer.' });
    }
});

// Resetear contraseña
app.patch('/api/admin/choferes/:id/password', verificarToken, async (req, res) => {
    const { id } = req.params;
    const { nueva_password } = req.body;

    if (!nueva_password || nueva_password.length < 4)
        return res.status(400).json({ error: '⚠️ Contraseña mínimo 4 caracteres.' });

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(nueva_password, salt);
        const resultado = await pool.query(
            'UPDATE choferes SET password_hash = $1 WHERE id = $2 RETURNING id, nombre_completo',
            [passwordHash, id]
        );
        if (resultado.rows.length === 0)
            return res.status(404).json({ error: 'Chofer no encontrado.' });
        res.json({ mensaje: `✅ Contraseña actualizada para ${resultado.rows[0].nombre_completo}.` });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar la contraseña.' });
    }
});

// Activar / desactivar chofer
app.patch('/api/admin/choferes/:id/estado', verificarToken, async (req, res) => {
    const { id } = req.params;
    const { estado_activo } = req.body;

    try {
        const resultado = await pool.query(
            `UPDATE choferes
             SET estado_activo = $1
             WHERE id = $2
             RETURNING id, nombre_completo, estado_activo`,
            [estado_activo, id]
        );
        if (resultado.rows.length === 0)
            return res.status(404).json({ error: 'Chofer no encontrado.' });
        const estado = estado_activo ? 'activado' : 'desactivado';
        res.json({ mensaje: `✅ Chofer ${estado}.`, chofer: resultado.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar estado.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MÓDULO DE AUTENTICACIÓN (APP MÓVIL)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/choferes/registro', async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const query = `
            INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, nombre_completo, placa_vehiculo;
        `;
        const resultado = await pool.query(query, [nombre_completo, placa_vehiculo, password_hash]);
        res.status(201).json({ mensaje: '✅ Chofer registrado', chofer: resultado.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar chofer' });
    }
});

app.post('/api/login', async (req, res) => {
    const { placa_vehiculo, password } = req.body;
    try {
        const resultado = await pool.query(
            'SELECT * FROM choferes WHERE placa_vehiculo = $1', [placa_vehiculo]
        );
        if (resultado.rows.length === 0)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta' });

        const chofer = resultado.rows[0];

        if (!chofer.estado_activo)
            return res.status(403).json({ error: '🚫 Tu cuenta está desactivada. Contacta a la central.' });

        const passwordValida = await bcrypt.compare(password, chofer.password_hash);
        if (!passwordValida)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta' });

        const token = jwt.sign(
            { id: chofer.id, placa: chofer.placa_vehiculo },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({
            mensaje: '🔓 Login exitoso',
            token,
            chofer: {
                id: chofer.id,
                nombre_completo: chofer.nombre_completo,
                placa_vehiculo: chofer.placa_vehiculo
            }
        });
    } catch (error) {
        console.error('Error en Login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ── INICIO ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});