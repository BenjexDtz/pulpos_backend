-- 1. Crear Tabla: Choferes
CREATE TABLE choferes (
    id SERIAL PRIMARY KEY,
    nombre_completo VARCHAR(100) NOT NULL,
    placa_vehiculo VARCHAR(20) UNIQUE NOT NULL,
    estado_activo BOOLEAN DEFAULT TRUE,
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Crear Tabla: Parámetros Topográficos
CREATE TABLE parametros_topograficos (
    id SERIAL PRIMARY KEY,
    zona_ciudad VARCHAR(100) NOT NULL,
    costo_base_km NUMERIC(5,2) NOT NULL,
    factor_altitud NUMERIC(4,2) NOT NULL,
    factor_superficie NUMERIC(4,2) NOT NULL,
    costo_minuto_detencion NUMERIC(5,2) NOT NULL,
    fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Crear Tabla: Historial de Viajes (Sincronización)
CREATE TABLE viajes_historial (
    id_servidor SERIAL PRIMARY KEY,
    chofer_id INTEGER REFERENCES choferes(id),
    distancia_km NUMERIC(8,3) NOT NULL,
    tiempo_detencion_min NUMERIC(8,2) NOT NULL,
    tarifa_cobrada NUMERIC(8,2) NOT NULL,
    fecha_hora_viaje TIMESTAMP NOT NULL,
    fecha_sincronizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Insertar Datos de Prueba (Semilla)
INSERT INTO parametros_topograficos (zona_ciudad, costo_base_km, factor_altitud, factor_superficie, costo_minuto_detencion)
VALUES ('El Alto - Topografía Compleja', 2.00, 1.40, 2.50, 0.50);

INSERT INTO choferes (nombre_completo, placa_vehiculo)
VALUES ('Boris Benjamín Barboza', '1234-PUL');


ALTER TABLE choferes ADD COLUMN password_hash VARCHAR(255);