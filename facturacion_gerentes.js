'use strict';

/**
 * Facturación mensual automática para los gerentes/revendedores en GPSWOX
 * que pagan por cantidad de vehículos en la plataforma.
 *
 * Cada vez que corre (pensado para ejecutarse por cron todos los días):
 *   1. Revisa si hoy es día de facturación (día 30, o el último día del
 *      mes si el mes no tiene día 30, como febrero).
 *   2. Si lo es, por cada gerente: busca su usuario en GPSWOX por correo,
 *      cuenta cuántos vehículos tiene vinculados hoy, crea la factura en
 *      Alegra por esa cantidad (precio = precio actual del item en
 *      Alegra) y la envía por correo al gerente con copia a info@dfctrack.com.
 *
 * No depende de ningún paquete nuevo: usa mysql2 (ya instalado) y fetch
 * nativo de Node (ya usado en alegra-cliente.js).
 *
 * Variables de entorno requeridas (en /opt/baileys-servicio/.env):
 *   DB_PASS_WSC_REGISTRO  -> contraseña del usuario MySQL wsc_registro
 *   ALEGRA_EMAIL / ALEGRA_TOKEN -> ya usadas por alegra-cliente.js
 *
 * Crontab sugerido (corre todos los días a las 8:05am, el script decide
 * internamente si hoy toca facturar o no):
 *   5 8 * * * cd /opt/baileys-servicio && /usr/bin/node facturacion_gerentes.js >> facturacion_gerentes.log 2>&1
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { crearFacturaCantidad, enviarFacturaPorEmail } = require('./alegra-cliente');

(function cargarEnvLocal() {
  try {
    const envPath = path.join(__dirname, '.env');
    const contenido = fs.readFileSync(envPath, 'utf8');
    contenido.split('\n').forEach((linea) => {
      const match = linea.match(/^\s*([^=:#\s]+)\s*[=:]\s*(.*)\s*$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    });
  } catch (e) {
    // sin .env -- fallará más abajo con mensaje claro si hace falta
  }
})();

const DB_CONFIG = {
  host: '154.38.189.98',
  user: 'wsc_registro',
  password: process.env.DB_PASS_WSC_REGISTRO,
  database: 'gpswox_web'
};

const COPIA_CORREO = 'info@dfctrack.com';

// Gerentes a facturar mensualmente por cantidad de vehículos.
// alegraContactoId e itemId se sacaron del historial real de facturas de cada uno en Alegra.
const GERENTES = [
  {
    nombre: 'Josue Vasquez',
    emailWox: 'vasquezsegura150880@gmail.com',
    alegraContactoId: '868',
    itemId: '188' // Plataforma Rastreo Maintrack GPS
  },
  {
    nombre: 'Joel Mena',
    emailWox: 'elprototipo1714@gmail.com',
    alegraContactoId: '337',
    itemId: '158' // Plataforma DFC Track Pro
  }
];

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function esDiaDeFacturacion(hoy) {
  const dia = hoy.getDate();
  const ultimoDiaMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  return dia === 30 || (ultimoDiaMes < 30 && dia === ultimoDiaMes);
}

async function contarVehiculos(email) {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const [userRows] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (!userRows.length) {
      throw new Error(`No existe usuario en GPSWOX con correo ${email}`);
    }
    const userId = userRows[0].id;
    const [countRows] = await conn.execute(
      'SELECT COUNT(*) AS total FROM user_device_pivot WHERE user_id = ?',
      [userId]
    );
    return countRows[0].total;
  } finally {
    await conn.end();
  }
}

async function facturarGerente(gerente, mesTexto) {
  log(`--- ${gerente.nombre} ---`);
  let cantidad;
  try {
    cantidad = await contarVehiculos(gerente.emailWox);
  } catch (e) {
    log(`${gerente.nombre}: ERROR consultando vehículos en GPSWOX: ${e.message}`);
    return;
  }

  if (!cantidad || cantidad <= 0) {
    log(`${gerente.nombre}: 0 vehículos en la plataforma, se omite la factura este mes.`);
    return;
  }

  log(`${gerente.nombre}: ${cantidad} vehículo(s) en GPSWOX. Creando factura en Alegra...`);
  const resultado = await crearFacturaCantidad({
    contactoId: gerente.alegraContactoId,
    itemId: gerente.itemId,
    cantidad,
    descripcion: `Plataforma de rastreo GPS - ${cantidad} vehículo(s) - ${mesTexto}`
  });

  if (!resultado.ok) {
    log(`${gerente.nombre}: ERROR creando factura en Alegra: ${resultado.error}`);
    return;
  }

  const factura = resultado.factura;
  const numero = (factura.numberTemplate && factura.numberTemplate.fullNumber) || factura.id;
  log(`${gerente.nombre}: factura ${numero} creada (RD$${factura.total}). Enviando por correo...`);

  const envio = await enviarFacturaPorEmail(factura.id, [gerente.emailWox, COPIA_CORREO]);
  if (!envio.ok) {
    log(`${gerente.nombre}: factura creada pero ERROR al enviar el correo: ${envio.error}`);
    return;
  }

  log(`${gerente.nombre}: correo enviado a ${gerente.emailWox} con copia a ${COPIA_CORREO}. Listo.`);
}

async function main() {
  const hoy = new Date();

  if (!esDiaDeFacturacion(hoy)) {
    log(`Hoy (${hoy.toISOString().slice(0, 10)}) no es día de facturación. Nada que hacer.`);
    return;
  }

  if (!process.env.DB_PASS_WSC_REGISTRO) {
    log('ERROR: falta DB_PASS_WSC_REGISTRO en el .env, no se puede consultar GPSWOX.');
    return;
  }

  const mesTexto = `${MESES[hoy.getMonth()]} ${hoy.getFullYear()}`;
  log(`=== Facturación mensual de gerentes -- ${mesTexto} ===`);

  for (const gerente of GERENTES) {
    await facturarGerente(gerente, mesTexto);
  }

  log('=== Fin del proceso ===');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR FATAL:', e);
    process.exit(1);
  });
