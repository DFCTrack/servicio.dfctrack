# Resumen técnico — Traslados/Reinstalación, evidencias y persona que recibe

## Archivos modificados
- `servicio.js` — único archivo tocado. 289 líneas agregadas, 24 modificadas. Todo lo demás (`server.js`, `alegra-cliente.js`, `chat.js`, `registro.js`, `push.js`) se auditó pero no se tocó.

## Migración de base de datos (NO ejecutada todavía — ver "Bloqueo" abajo)
Archivo `migracion_traslados.sql` en la raíz del repo. 9 columnas nuevas en `servicios_gps`, todas `NULL` por defecto, aditivas, sin tocar columnas ni filas existentes:
`vehiculo_destino_marca`, `vehiculo_destino_modelo`, `vehiculo_destino_color`, `vehiculo_destino_placa`, `vehiculo_destino_anio`, `persona_recibe_nombre`, `persona_recibe_telefono`, `persona_recibe_nota`, `foto_gps_path`.

No reutilicé tabla nueva para evidencias: agregué `foto_gps_path` y dejé `foto_path` (ya existente) haciendo el papel de "foto del vehículo" — evita duplicar una columna que ya cumplía ese propósito.

## Endpoints afectados
- `POST /api/servicio/autoguardar` — ahora guarda también persona que recibe y vehículo destino (append condicional, mismo patrón que ya usaba para correo/pago_tecnico).
- `POST /api/servicio/foto` — ahora recibe un campo `tipo` (`vehiculo` o `gps`) y escribe en la columna correspondiente. Compatible hacia atrás: si no llega `tipo`, se comporta como antes (foto de vehículo).
- `POST /api/servicio/terminar` — **antes no validaba nada en el backend, solo hacía el UPDATE directo.** Ahora consulta el registro real en BD antes de cerrar y rechaza si falta: foto de vehículo, foto de GPS, o (si es traslado) marca/placa del vehículo destino. Responde `ok:false` con el detalle de qué falta.
- `POST /api/servicio/crear-alegra` — la descripción de la factura ahora incluye el vehículo destino cuando aplica, para que quede trazable en la factura.
- `POST /api/servicio/aplicar-wox-traslado` (nuevo) — mismo patrón que el `aplicar-wox` que ya existía para Instalación, pero para traslados: busca el device por IMEI y actualiza `name`/`plate_number`/`comment` con los datos del vehículo destino. La nota (`comment`) guarda una referencia al vehículo anterior y al número de servicio, para no perder trazabilidad. No toca `user_device_pivot` porque confirmaste que el destino es del mismo cliente.

## Frontend (formulario del técnico/admin)
- Nueva sección "Cliente" (nombre, celular siempre; correo solo admin — se mantuvo la regla que ya existía).
- Nueva sección "Persona que recibe el servicio" (nombre, teléfono, nota) — visible para todos, independiente del cliente titular.
- Bloque "Vehículo origen" (el ya existente, re-etiquetado) + bloque nuevo "Vehículo destino" que solo aparece cuando el servicio es Reinstalación (1 o 2 traslados).
- Dos campos de foto separados (vehículo / ubicación del GPS), cada uno con su propio indicador de "ya subida".
- El botón "Terminar y Enviar" ahora bloquea en el navegador si faltan fotos o destino — pero el candado real está en el backend, como pediste.
- Vista de resumen (post-cierre) actualizada: muestra cliente, persona que recibió, vehículo origen y destino, y las dos fotos.

## Contradicción que encontré en tu propia especificación (sin resolver, decide tú)
El punto 3 dice que el correo es "solo visible para el admin". El punto 7 (vista del técnico) lista "Correo" dentro de lo que debería ver el técnico. Dejé el comportamiento actual: correo admin-only, porque coincide con el punto 3 y con cómo ya funcionaba el sistema antes de este cambio. Si quieres que el técnico también vea el correo, es un cambio de una línea.

## Resultado de las pruebas
No pude correr las 5 pruebas reales (A-E) porque necesitan la base de datos en vivo y el servidor corriendo, y no tengo acceso de red a `154.38.189.98` desde este entorno. Lo que sí verifiqué:
- `node -c servicio.js` — sintaxis correcta.
- El módulo carga sin errores (`require('./servicio.js')`) una vez instaladas las dependencias.
- Simulé una petición HTTP real a `GET /servicio?tecnico=2110` (formulario del técnico, sin admin) y a `GET /nuevo` — ambas responden 200 con HTML completo, sin errores de plantilla.
- Revisión manual línea por línea de los 4 endpoints nuevos/modificados.

Las pruebas reales (Caso A normal, Caso B traslado completo, Caso C evidencia faltante, Caso D historial, Caso E regresión) las tienes que correr tú una vez esté desplegado, porque necesitan WhatsApp conectado y la base de datos real.

## Riesgo importante — bloqueo antes de desplegar
El código nuevo asume que las 9 columnas ya existen. Si esto se despliega en el servidor **antes** de correr la migración, el autoguardado se rompe para **todos** los servicios (no solo traslados), porque el formulario ahora siempre manda los campos de persona que recibe en cada autoguardado. Por eso:

1. Primero correr `migracion_traslados.sql` contra `gpswox_web` en `154.38.189.98`.
2. Después desplegar este `servicio.js`.

No hice push a GitHub todavía ni sé cómo se despliega al servidor real (¿pm2 + git pull manual? ¿algo automático?). Necesito que me digas eso antes de mover esto a producción.
