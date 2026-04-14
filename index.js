const express = require('express');
const cors = require('cors');
const pool = require('./db'); // Importamos nuestra conexión
require('dotenv').config();

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

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});