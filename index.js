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
// PARÁMETROS TOPOGRÁFICOS (incluye combustible)
// ═══════════════════════════════════════════════════════════════════════════════

// Público — Flutter lo descarga al iniciar
app.get('/api/parametros', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM parametros_topograficos ORDER BY id LIMIT 1');
        if (!r.rows.length) return res.status(404).json({ error: 'Sin parámetros.' });

        const p = r.rows[0];
        // Enviar también el costo de combustible por km calculado
        // para que Flutter pueda mostrarlo en pantalla
        res.json({
            ...p,
            costo_combustible_km: parseFloat(
                (parseFloat(p.consumo_litros_km) * parseFloat(p.precio_combustible_bs)).toFixed(3)
            ),
            costo_variable_km: parseFloat(
                (parseFloat(p.costo_base_km) +
                 parseFloat(p.consumo_litros_km) * parseFloat(p.precio_combustible_bs)).toFixed(3)
            )
        });
    } catch (e) {
        res.status(500).json({ error: 'Error al leer parámetros.' });
    }
});

// Admin — editar parámetros (incluyendo precio combustible)
app.put('/api/admin/parametros/:id', verificarToken, async (req, res) => {
    const { id } = req.params;
    const {
        zona_ciudad,
        costo_base_km,
        consumo_litros_km,
        precio_combustible_bs,
        factor_altitud,
        factor_superficie,
        costo_minuto_detencion
    } = req.body;

    if (!costo_base_km || !factor_altitud || !factor_superficie ||
        !costo_minuto_detencion || !consumo_litros_km || !precio_combustible_bs)
        return res.status(400).json({ error: '⚠️ Todos los campos son obligatorios.' });

    try {
        const r = await pool.query(
            `UPDATE parametros_topograficos
             SET zona_ciudad=$1, costo_base_km=$2,
                 consumo_litros_km=$3, precio_combustible_bs=$4,
                 factor_altitud=$5, factor_superficie=$6,
                 costo_minuto_detencion=$7, fecha_actualizacion=NOW()
             WHERE id=$8 RETURNING *`,
            [zona_ciudad, costo_base_km, consumo_litros_km, precio_combustible_bs,
             factor_altitud, factor_superficie, costo_minuto_detencion, id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });

        const p = r.rows[0];
        const costoCombu = parseFloat(p.consumo_litros_km) * parseFloat(p.precio_combustible_bs);
        console.log(`⚙️ Parámetros actualizados | combustible: Bs ${costoCombu.toFixed(3)}/km`);
        res.json({
            mensaje: '✅ Parámetros actualizados. Los conductores los recibirán al iniciar la app.',
            parametros: {
                ...p,
                costo_combustible_km: parseFloat(costoCombu.toFixed(3)),
                costo_variable_km:    parseFloat((parseFloat(p.costo_base_km) + costoCombu).toFixed(3))
            }
        });
    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: 'Error al actualizar parámetros.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// APP MÓVIL — SINCRONIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/viajes/sincronizar', async (req, res) => {
    const {
        chofer_id,
        distancia_km,
        tiempo_detencion_min,
        tarifa_cobrada,
        fecha_hora_viaje,
        tipo_superficie             = 'asfalto',
        factor_altitud_aplicado     = 1.40,
        factor_superficie_aplicado  = 1.00,
        costo_base_aplicado         = 2.00,
        costo_minuto_aplicado       = 0.50,
        consumo_litros_aplicado     = 0.100,
        precio_combustible_aplicado = 6.96,
    } = req.body;

    if (!chofer_id || distancia_km === undefined)
        return res.status(400).json({ error: 'Faltan datos del viaje.' });

    try {
        const r = await pool.query(
            `INSERT INTO viajes_historial (
                chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada,
                tipo_superficie, factor_altitud_aplicado, factor_superficie_aplicado,
                costo_base_aplicado, costo_minuto_aplicado,
                consumo_litros_aplicado, precio_combustible_aplicado,
                fecha_hora_viaje
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id_servidor`,
            [
                chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada,
                tipo_superficie, factor_altitud_aplicado, factor_superficie_aplicado,
                costo_base_aplicado, costo_minuto_aplicado,
                consumo_litros_aplicado, precio_combustible_aplicado,
                fecha_hora_viaje
            ]
        );

        const costoCombu = parseFloat(consumo_litros_aplicado) * parseFloat(precio_combustible_aplicado);
        console.log(
            `📥 Viaje #${r.rows[0].id_servidor} | chofer=${chofer_id} | ` +
            `${distancia_km}km | ${tipo_superficie} | ` +
            `combustible=Bs${costoCombu.toFixed(3)}/km | total=Bs${tarifa_cobrada}`
        );
        res.status(201).json({ success: true, id_servidor: r.rows[0].id_servidor });
    } catch (e) {
        console.error('❌ Error sincronizando:', e.message);
        res.status(500).json({ error: 'Error al guardar.' });
    }
});

// GPS en tiempo real
app.post('/api/posicion', verificarToken, async (req, res) => {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined)
        return res.status(400).json({ error: 'Se requieren lat y lng.' });
    if (lat < -23 || lat > -9 || lng < -70 || lng > -57)
        return res.status(400).json({ error: 'Fuera de Bolivia.' });
    try {
        await pool.query(
            `UPDATE choferes SET ultima_lat=$1, ultima_lng=$2, ultima_actualizacion=NOW() WHERE id=$3`,
            [lat, lng, req.usuario.id]
        );
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Error actualizando posición.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

// Login app móvil (choferes)
app.post('/api/login', async (req, res) => {
    const { placa_vehiculo, password } = req.body;
    try {
        const r = await pool.query('SELECT * FROM choferes WHERE placa_vehiculo = $1', [placa_vehiculo]);
        if (!r.rows.length)
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });
        const chofer = r.rows[0];
        if (!chofer.estado_activo)
            return res.status(403).json({ error: '🚫 Cuenta desactivada. Contacta a la central.' });
        if (!chofer.password_hash || !await bcrypt.compare(password, chofer.password_hash))
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta.' });
        const token = jwt.sign(
            { id: chofer.id, placa: chofer.placa_vehiculo },
            process.env.JWT_SECRET, { expiresIn: '30d' }
        );
        res.json({ mensaje: '🔓 Login exitoso', token,
            chofer: { id: chofer.id, nombre_completo: chofer.nombre_completo, placa_vehiculo: chofer.placa_vehiculo }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error interno.' });
    }
});

// Login panel admin (tabla administradores)
app.post('/api/admin/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const r = await pool.query(
            `SELECT * FROM administradores WHERE (email=$1 OR nombre=$1) AND activo=TRUE LIMIT 1`,
            [usuario]
        );
        if (!r.rows.length)
            return res.status(401).json({ error: '❌ Usuario o contraseña incorrecta.' });
        const admin = r.rows[0];
        if (!await bcrypt.compare(password, admin.password_hash))
            return res.status(401).json({ error: '❌ Usuario o contraseña incorrecta.' });
        const token = jwt.sign(
            { id: admin.id, rol: admin.rol, nombre: admin.nombre },
            process.env.JWT_SECRET, { expiresIn: '8h' }
        );
        console.log(`🔑 Admin login: ${admin.nombre} (${admin.rol})`);
        res.json({ mensaje: `✅ Bienvenido, ${admin.nombre}`, token, rol: admin.rol });
    } catch (e) {
        console.error(e.message);
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
    } catch { res.status(500).json({ error: 'Error.' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL ADMIN — ENDPOINTS PROTEGIDOS
// ═══════════════════════════════════════════════════════════════════════════════

// Viajes con auditoría completa incluyendo combustible
app.get('/api/admin/viajes', verificarToken, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let query = `
            SELECT
                v.id_servidor                AS id,
                c.nombre_completo            AS chofer,
                c.placa_vehiculo,
                v.distancia_km,
                v.tiempo_detencion_min,
                v.tarifa_cobrada             AS tarifa_total,
                v.tipo_superficie,
                v.factor_altitud_aplicado,
                v.factor_superficie_aplicado,
                v.costo_base_aplicado,
                v.costo_minuto_aplicado,
                v.consumo_litros_aplicado,
                v.precio_combustible_aplicado,
                -- Costo de combustible de ese viaje en Bs
                ROUND((v.consumo_litros_aplicado * v.precio_combustible_aplicado
                       * v.distancia_km * v.factor_altitud_aplicado
                       * v.factor_superficie_aplicado)::numeric, 2)
                    AS costo_combustible_total,
                v.fecha_hora_viaje           AS fecha_hora
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
        `;
        const params = [];
        if (desde && hasta) { query += ` WHERE v.fecha_hora_viaje BETWEEN $1 AND $2`; params.push(desde, hasta); }
        query += ` ORDER BY v.fecha_hora_viaje DESC`;
        const r = await pool.query(query, params);
        res.json(r.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error cargando viajes.' });
    }
});

// CSV con auditoría completa
app.get('/api/admin/viajes/exportar', verificarToken, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let query = `
            SELECT
                v.id_servidor                                     AS "ID",
                c.nombre_completo                                 AS "Conductor",
                c.placa_vehiculo                                  AS "Placa",
                ROUND(v.distancia_km::numeric,3)                  AS "Km",
                ROUND(v.tiempo_detencion_min::numeric,2)          AS "Min Espera",
                v.tipo_superficie                                 AS "Superficie",
                v.factor_altitud_aplicado                         AS "FH",
                v.factor_superficie_aplicado                      AS "FR",
                v.costo_base_aplicado                             AS "Cb (Bs/km)",
                v.consumo_litros_aplicado                         AS "Cl (L/km)",
                v.precio_combustible_aplicado                     AS "Pc (Bs/L)",
                ROUND((v.consumo_litros_aplicado * v.precio_combustible_aplicado)::numeric,3)
                                                                  AS "Cl×Pc (Bs/km)",
                ROUND((v.costo_base_aplicado + v.consumo_litros_aplicado * v.precio_combustible_aplicado)::numeric,3)
                                                                  AS "Cb+Cl×Pc",
                ROUND(v.tarifa_cobrada::numeric,2)                AS "Tarifa Total (Bs)",
                TO_CHAR(v.fecha_hora_viaje,'DD/MM/YYYY HH24:MI') AS "Fecha"
            FROM viajes_historial v JOIN choferes c ON v.chofer_id = c.id
        `;
        const params = [];
        if (desde && hasta) { query += ` WHERE v.fecha_hora_viaje BETWEEN $1 AND $2`; params.push(desde, hasta); }
        query += ` ORDER BY v.fecha_hora_viaje DESC`;

        const r = await pool.query(query, params);
        if (!r.rows.length) return res.status(404).json({ error: 'Sin datos.' });

        const cols = Object.keys(r.rows[0]);
        const csv = [
            cols.join(','),
            ...r.rows.map(row => cols.map(c => `"${(row[c]??'').toString().replace(/"/g,'""')}"`).join(','))
        ].join('\n');

        const fecha = new Date().toISOString().slice(0,10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pulpos_auditoria_${fecha}.csv"`);
        res.send('\uFEFF' + csv);
    } catch (e) {
        res.status(500).json({ error: 'Error generando CSV.' });
    }
});

// Choferes
app.get('/api/admin/choferes', verificarToken, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT id, nombre_completo, placa_vehiculo, estado_activo,
                   ultima_lat, ultima_lng, ultima_actualizacion
            FROM choferes ORDER BY nombre_completo ASC
        `);
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Error.' }); }
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
        res.status(500).json({ error: 'Error.' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));