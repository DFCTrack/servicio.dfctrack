-- Migración aditiva para servicios_gps (traslado/reinstalación + evidencias + persona que recibe)
-- Segura: solo agrega columnas nuevas, todas NULL por defecto. No toca columnas ni filas existentes.
-- Ejecutar contra: gpswox_web @ 154.38.189.98 (la base que usa servicio.js en producción)
-- Recomendado: hacer backup/snapshot de servicios_gps antes de correrla, aunque es no-destructiva.

ALTER TABLE servicios_gps
  ADD COLUMN vehiculo_destino_marca  VARCHAR(120) NULL AFTER placa_chasis,
  ADD COLUMN vehiculo_destino_modelo VARCHAR(120) NULL AFTER vehiculo_destino_marca,
  ADD COLUMN vehiculo_destino_color  VARCHAR(60)  NULL AFTER vehiculo_destino_modelo,
  ADD COLUMN vehiculo_destino_placa  VARCHAR(60)  NULL AFTER vehiculo_destino_color,
  ADD COLUMN vehiculo_destino_anio   VARCHAR(10)  NULL AFTER vehiculo_destino_placa,
  ADD COLUMN persona_recibe_nombre    VARCHAR(150) NULL AFTER nota,
  ADD COLUMN persona_recibe_telefono  VARCHAR(40)  NULL AFTER persona_recibe_nombre,
  ADD COLUMN persona_recibe_nota      VARCHAR(255) NULL AFTER persona_recibe_telefono,
  ADD COLUMN foto_gps_path            VARCHAR(255) NULL AFTER foto_path;

-- Verificación rápida después de correrla:
-- DESCRIBE servicios_gps;
-- Debe mostrar las 9 columnas nuevas, todas nullable, sin haber tocado nada más.
