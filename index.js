const express = require('express');
const cors = require('cors');
const pool = require('./db');
require('dotenv').config();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

app.use(cors());
app.use(express.json());

// Middleware JWT — declarado aquí arriba para que todas las rutas puedan usarlo
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    
    if (!token) {
        return res.status(403).json({ error: '🚫 Acceso denegado. Se requiere un token de Gerencia.' });
    }

    try {
        const tokenLimpio = token.split(" ")[1] || token;
        const decodificado = jwt.verify(tokenLimpio, process.env.JWT_SECRET);
        req.usuario = decodificado;
        next();
    } catch (error) {
        return res.status(401).json({ error: '🚫 Token inválido o expirado.' });
    }
};

// --- RUTAS ---

// 1. Ruta base
app.get('/', (req, res) => {
    res.json({ mensaje: '📡 Central de Radio Taxis Pulpos en línea' });
});

// 2. Parámetros topográficos
app.get('/api/parametros', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM parametros_topograficos');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Error en el servidor de base de datos');
    }
});

// 3. Reporte general
app.get('/api/viajes/reporte', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.nombre_completo,
                c.placa_vehiculo,
                COUNT(v.id_servidor) as total_viajes,
                SUM(v.distancia_km) as kilometros_recorridos,
                SUM(v.tarifa_cobrada) as dinero_recaudado
            FROM viajes_historial v
            JOIN choferes c ON v.chofer_id = c.id
            GROUP BY c.nombre_completo, c.placa_vehiculo
            ORDER BY dinero_recaudado DESC;
        `;
        const resultado = await pool.query(query);

        if (resultado.rows.length === 0) {
            return res.json({ mensaje: 'No hay viajes registrados aún.' });
        }

        res.json({
            mensaje: 'Reporte generado exitosamente',
            estadisticas: resultado.rows
        });
    } catch (error) {
        console.error('❌ Error al generar el reporte:', error.message);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// MÓDULO APP MÓVIL: SINCRONIZACIÓN
// ==========================================

// 🔥 ÚNICA ruta de sincronización — recibe UN viaje por llamada (objeto, no array)
app.post('/api/viajes/sincronizar', async (req, res) => {
    const { chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje } = req.body;

    if (!chofer_id || distancia_km === undefined) {
        return res.status(400).json({ error: 'Faltan datos del viaje.' });
    }

    try {
        const query = `
            INSERT INTO viajes_historial 
            (chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje)
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id_servidor;
        `;
        const valores = [chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje];
        
        const resultado = await pool.query(query, valores);
        
        console.log(`📥 Viaje recibido del chofer ${chofer_id} — ID asignado: ${resultado.rows[0].id_servidor}`);
        
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

// ==========================================
// MÓDULO WEB ADMIN (GERENCIA)
// ==========================================

app.post('/api/admin/login', (req, res) => {
    const { usuario, password } = req.body;

    if (usuario === 'admin' && password === 'pulpos2026') {
        const token = jwt.sign(
            { rol: 'gerente' },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ mensaje: '✅ Bienvenido a la Gerencia', token: token });
    } else {
        res.status(401).json({ error: '❌ Usuario o contraseña incorrecta' });
    }
});

app.get('/api/admin/viajes', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                v.id_servidor AS id, 
                c.nombre_completo AS chofer, 
                c.placa_vehiculo,
                v.distancia_km, 
                v.tiempo_detencion_min, 
                v.tarifa_cobrada AS tarifa_total, 
                v.fecha_hora_viaje AS fecha_hora 
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

app.post('/api/admin/choferes', verificarToken, async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;

    if (!nombre_completo || !placa_vehiculo || !password) {
        return res.status(400).json({ error: '⚠️ Faltan datos obligatorios.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const query = `
            INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, nombre_completo, placa_vehiculo, estado_activo;
        `;
        const valores = [nombre_completo, placa_vehiculo, passwordHash];
        const resultado = await pool.query(query, valores);
        
        res.status(201).json({ 
            mensaje: '✅ Chofer registrado exitosamente en la central.',
            chofer: resultado.rows[0] 
        });
    } catch (error) {
        console.error('Error al registrar chofer:', error);
        if (error.code === '23505') {
            return res.status(400).json({ error: '❌ Esta placa vehicular ya está registrada en el sistema.' });
        }
        res.status(500).json({ error: 'Error interno del servidor al registrar chofer.' });
    }
});

// ==========================================
// MÓDULO DE AUTENTICACIÓN
// ==========================================

app.post('/api/choferes/registro', async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const query = `
            INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
            VALUES ($1, $2, $3) RETURNING id, nombre_completo, placa_vehiculo;
        `;
        const valores = [nombre_completo, placa_vehiculo, password_hash];
        const resultado = await pool.query(query, valores);

        res.status(201).json({ 
            mensaje: '✅ Chofer registrado con éxito', 
            chofer: resultado.rows[0] 
        });
    } catch (error) {
        console.error('Error al registrar:', error);
        res.status(500).json({ error: 'Error al registrar chofer en la base de datos' });
    }
});

app.post('/api/login', async (req, res) => {
    const { placa_vehiculo, password } = req.body;

    try {
        const query = 'SELECT * FROM choferes WHERE placa_vehiculo = $1';
        const resultado = await pool.query(query, [placa_vehiculo]);

        if (resultado.rows.length === 0) {
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta' });
        }

        const chofer = resultado.rows[0];
        const passwordValida = await bcrypt.compare(password, chofer.password_hash);
        
        if (!passwordValida) {
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta' });
        }

        const token = jwt.sign(
            { id: chofer.id, placa: chofer.placa_vehiculo },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: '🔓 Login exitoso',
            token: token,
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

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});