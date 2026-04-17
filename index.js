const express = require('express');
const cors = require('cors');
const pool = require('./db'); // Importamos nuestra conexión
require('dotenv').config();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// Middlewares (Para que el servidor entienda JSON y permita conexiones externas)
app.use(cors());
app.use(express.json());

// --- RUTAS DE PRUEBA ---

// 1. Ruta base para saber si el servidor está vivo
app.get('/', (req, res) => {
    res.json({ mensaje: '📡 Central de Radio Taxis Pulpos en línea' });
});

// 2. Ruta para leer la base de datos (Tus parámetros topográficos)
app.get('/api/parametros', async (req, res) => {
    try {
        // Hacemos una consulta SQL desde Node
        const resultado = await pool.query('SELECT * FROM parametros_topograficos');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Error en el servidor de base de datos');
    }
});

// 3. Ruta POST para recibir los viajes desde el celular (Flutter)
app.post('/api/viajes/sincronizar', async (req, res) => {
    // req.body es lo que nos manda el celular (esperamos una lista/array de viajes)
    const viajes = req.body; 

    if (!viajes || viajes.length === 0) {
        return res.status(400).json({ error: 'La caja negra está vacía, no hay viajes.' });
    }

    try {
        // 🛡️ Iniciamos una TRANSACCIÓN. (Si un viaje falla, no guardamos nada a medias)
        await pool.query('BEGIN');

        let insertados = 0;

        for (let viaje of viajes) {
            // Preparamos la orden para PostgreSQL
            const query = `
                INSERT INTO viajes_historial 
                (chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje)
                VALUES ($1, $2, $3, $4, $5)
            `;
            
            // Inyectamos los datos del celular. 
            // OJO: Por ahora forzamos chofer_id = 1 (Boris) hasta que hagamos el Login real.
            const values = [
                1, 
                viaje.distancia_km, 
                viaje.tiempo_detencion_min, 
                viaje.tarifa_total, 
                viaje.fecha_hora
            ];

            await pool.query(query, values);
            insertados++;
        }

        // Si todo sale bien, confirmamos los cambios en la BD
        await pool.query('COMMIT');
        
        console.log(`📥 Sincronización exitosa: ${insertados} viajes recibidos.`);
        res.json({ 
            mensaje: 'Sincronización completada al 100%',
            viajesSincronizados: insertados 
        });

    } catch (error) {
        // Si hay un error (ej. se corta la luz), cancelamos todo para no corromper la BD
        await pool.query('ROLLBACK');
        console.error('❌ Error crítico al sincronizar:', error.message);
        res.status(500).json({ error: 'Error en la base de datos central.' });
    }
});

// 4. Ruta GET para el Panel de Administración: Ver todos los viajes y el total recaudado
app.get('/api/viajes/reporte', async (req, res) => {
    try {
        // Hacemos una consulta SQL que junta la tabla de viajes con la de choferes
        // Usamos SUM para calcular el dinero total y COUNT para contar los viajes
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
// MÓDULO WEB ADMIN (GERENCIA)
// ==========================================

// Ruta POST: Login de Gerencia
app.post('/api/admin/login', (req, res) => {
    const { usuario, password } = req.body;

    // 🔥 Credenciales maestras para tu defensa de grado
    if (usuario === 'admin' && password === 'pulpos2026') {
        const token = jwt.sign(
            { rol: 'gerente' },
            process.env.JWT_SECRET,
            { expiresIn: '8h' } // El gerente tiene un turno de 8 horas
        );
        res.json({ mensaje: '✅ Bienvenido a la Gerencia', token: token });
    } else {
        res.status(401).json({ error: '❌ Usuario o contraseña incorrecta' });
    }
});
// ==========================================
// MÓDULO DE AUTENTICACIÓN Y SEGURIDAD
// ==========================================

// 1. Ruta POST: Registrar un nuevo chofer con contraseña segura
app.post('/api/choferes/registro', async (req, res) => {
    const { nombre_completo, placa_vehiculo, password } = req.body;

    try {
        // Encriptar la contraseña (El número 10 es el nivel de seguridad/saltos)
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

// 2. Ruta POST: Iniciar Sesión (Login)
app.post('/api/login', async (req, res) => {
    const { placa_vehiculo, password } = req.body;

    try {
        // A) Buscar al chofer por su placa
        const query = 'SELECT * FROM choferes WHERE placa_vehiculo = $1';
        const resultado = await pool.query(query, [placa_vehiculo]);

        // Si no existe la placa, rechazamos
        if (resultado.rows.length === 0) {
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta' });
        }

        const chofer = resultado.rows[0];

        // B) Verificar si la contraseña coincide con la encriptada
        const passwordValida = await bcrypt.compare(password, chofer.password_hash);
        
        if (!passwordValida) {
            return res.status(401).json({ error: '❌ Placa o contraseña incorrecta' });
        }

        // C) Generar el Token JWT (El "Gafete" digital)
        const token = jwt.sign(
            { id: chofer.id, placa: chofer.placa_vehiculo },
            process.env.JWT_SECRET,
            { expiresIn: '30d' } // El chofer no tendrá que loguearse por 30 días
        );

        // D) Enviar el pase de entrada al celular
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

// Middleware de Seguridad: Verificar Token JWT
const verificarToken = (req, res, next) => {
    // Leemos el token que viene en la cabecera de la petición
    const token = req.headers['authorization'];
    
    if (!token) {
        return res.status(403).json({ error: '🚫 Acceso denegado. Se requiere un token de Gerencia.' });
    }

    try {
        // Quitamos la palabra "Bearer " si viene incluida
        const tokenLimpio = token.split(" ")[1] || token;
        const decodificado = jwt.verify(tokenLimpio, process.env.JWT_SECRET);
        req.usuario = decodificado; // Guardamos los datos del usuario en la petición
        next(); // ¡Pase libre!
    } catch (error) {
        return res.status(401).json({ error: '🚫 Token inválido o expirado.' });
    }
};


// ==========================================
// MÓDULO WEB ADMIN (GERENCIA)
// ==========================================

// Ruta GET: Obtener todos los viajes con el nombre del chofer
// Ruta GET: Obtener todos los viajes con el nombre del chofer
// 🔥 Fíjate en el "verificarToken" inyectado al medio
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


// ==========================================
// MÓDULO APP MÓVIL: SINCRONIZACIÓN
// ==========================================

// Ruta POST: Recibir viajes desde el celular del chofer
app.post('/api/viajes/sincronizar', async (req, res) => {
    const { chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje } = req.body;

    try {
        const query = `
            INSERT INTO viajes_historial 
            (chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje)
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id_servidor;
        `;
        const valores = [chofer_id, distancia_km, tiempo_detencion_min, tarifa_cobrada, fecha_hora_viaje];
        
        const resultado = await pool.query(query, valores);
        
        res.status(201).json({ 
            success: true, 
            mensaje: 'Viaje sincronizado', 
            id_servidor: resultado.rows[0].id_servidor 
        });
    } catch (error) {
        console.error('Error sincronizando viaje:', error);
        res.status(500).json({ error: 'Error al guardar en la base central' });
    }
});


// ==========================================
// MÓDULO WEB ADMIN: GESTIÓN DE CHOFERES
// ==========================================

// Ruta POST: Registrar un nuevo chofer
app.post('/api/admin/choferes', verificarToken, async (req, res) => {
    // 1. Recibimos los datos que nos mandará React
    const { nombre_completo, placa_vehiculo, password } = req.body;

    // Validación básica de que no nos manden campos vacíos
    if (!nombre_completo || !placa_vehiculo || !password) {
        return res.status(400).json({ error: '⚠️ Faltan datos obligatorios.' });
    }

    try {
        // 2. Encriptar la contraseña (Seguridad de alto nivel)
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // 3. Guardar en PostgreSQL
        const query = `
            INSERT INTO choferes (nombre_completo, placa_vehiculo, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, nombre_completo, placa_vehiculo, estado_activo;
        `;
        const valores = [nombre_completo, placa_vehiculo, passwordHash];
        
        const resultado = await pool.query(query, valores);
        
        // 4. Avisarle a React que todo fue un éxito
        res.status(201).json({ 
            mensaje: '✅ Chofer registrado exitosamente en la central.',
            chofer: resultado.rows[0] 
        });

    } catch (error) {
        console.error('Error al registrar chofer:', error);
        
        // Magia SQL: El código '23505' es cuando PostgreSQL detecta un valor UNIQUE repetido
        if (error.code === '23505') {
            return res.status(400).json({ error: '❌ Esta placa vehicular ya está registrada en el sistema.' });
        }
        res.status(500).json({ error: 'Error interno del servidor al registrar chofer.' });
    }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});