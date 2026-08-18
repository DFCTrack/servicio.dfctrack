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
 *
 * Prueba manual (ignora el chequeo de fecha, crea factura real):
 *   FORZAR_FACTURACION=1 node facturacion_gerentes.js
 *
 * Prueba manual mandando el correo solo a una dirección de prueba en vez
 * de al cliente real (la factura en Alegra sí se crea real, solo cambia
 * a quién se le manda el correo):
 *   FORZAR_FACTURACION=1 CORREO_PRUEBA=diocuma@gmail.com node facturacion_gerentes.js
 *
 * Además del correo, se manda un WhatsApp de texto avisando que la
 * factura ya está en su correo (sin PDF ni link, solo el aviso), usando
 * el mismo bot de WhatsApp que ya corre en este servidor (POST /send en
 * localhost:3001). En modo prueba (FORZAR_FACTURACION=1) el WhatsApp NO
 * se manda al número real del cliente salvo que definas WHATSAPP_PRUEBA
 * con un número de prueba:
 *   FORZAR_FACTURACION=1 CORREO_PRUEBA=diocuma@gmail.com WHATSAPP_PRUEBA=18092064925 node facturacion_gerentes.js
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

async function buscarUsuarioWoxYContar(email) {
  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    const [userRows] = await conn.execute('SELECT id, phone_number FROM users WHERE email = ?', [email]);
    if (!userRows.length) {
      throw new Error(`No existe usuario en GPSWOX con correo ${email}`);
    }
    const userId = userRows[0].id;
    const [countRows] = await conn.execute(
      'SELECT COUNT(*) AS total FROM user_device_pivot WHERE user_id = ?',
      [userId]
    );
    return { cantidad: countRows[0].total, telefono: userRows[0].phone_number || null };
  } finally {
    await conn.end();
  }
}

function normalizarNumeroWhatsapp(numero) {
  const digitos = String(numero || '').replace(/[^0-9]/g, '');
  if (!digitos) return null;
  // Números dominicanos guardados sin código de país (10 dígitos) -> agregar el 1
  if (digitos.length === 10) return '1' + digitos;
  return digitos;
}

async function avisarPorWhatsapp(numero, mensaje) {
  try {
    const res = await fetch('http://127.0.0.1:3001/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero, mensaje })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.enviado === false) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function facturarGerente(gerente, mesTexto) {
  log(`--- ${gerente.nombre} ---`);
  let cantidad, telefono;
  try {
    const info = await buscarUsuarioWoxYContar(gerente.emailWox);
    cantidad = info.cantidad;
    telefono = info.telefono;
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

  const correoPrueba = process.env.CORREO_PRUEBA;
  const destinatarios = correoPrueba ? [correoPrueba] : [gerente.emailWox, COPIA_CORREO];
  if (correoPrueba) {
    log(`${gerente.nombre}: CORREO_PRUEBA activo -- se envía solo a ${correoPrueba} (no a ${gerente.emailWox} ni a ${COPIA_CORREO}).`);
  }

  const envio = await enviarFacturaPorEmail(factura.id, destinatarios);
  if (!envio.ok) {
    log(`${gerente.nombre}: factura creada pero ERROR al enviar el correo: ${envio.error}`);
    return;
  }

  log(`${gerente.nombre}: correo enviado a ${destinatarios.join(', ')}. Listo.`);

  // Aviso por WhatsApp (solo texto, sin PDF ni link) de que la factura ya está en su correo.
  const whatsappPrueba = process.env.WHATSAPP_PRUEBA;
  let numeroDestino = null;
  if (correoPrueba) {
    // En modo prueba no se manda al número real del cliente salvo que se indique WHATSAPP_PRUEBA.
    numeroDestino = whatsappPrueba ? normalizarNumeroWhatsapp(whatsappPrueba) : null;
    if (!numeroDestino) {
      log(`${gerente.nombre}: modo prueba sin WHATSAPP_PRUEBA -- se omite el aviso por WhatsApp.`);
    }
  } else {
    numeroDestino = normalizarNumeroWhatsapp(telefono);
    if (!numeroDestino) {
      log(`${gerente.nombre}: no tiene teléfono registrado en GPSWOX -- se omite el aviso por WhatsApp.`);
    }
  }

  if (numeroDestino) {
    const mensajeWs = `Hola ${gerente.nombre}, tu factura de la plataforma DFC Track GPS de ${mesTexto} ya está en tu correo (${gerente.emailWox}). Cualquier duda, escríbenos aquí mismo. Gracias por confiar en DFC Track GPS.`;
    const avisoWs = await avisarPorWhatsapp(numeroDestino, mensajeWs);
    if (!avisoWs.ok) {
      log(`${gerente.nombre}: ERROR al enviar el aviso por WhatsApp a ${numeroDestino}: ${avisoWs.error}`);
    } else {
      log(`${gerente.nombre}: aviso por WhatsApp enviado a ${numeroDestino}.`);
    }
  }
}

async function main() {
  const hoy = new Date();
  const forzado = process.env.FORZAR_FACTURACION === '1';

  if (!esDiaDeFacturacion(hoy) && !forzado) {
    log(`Hoy (${hoy.toISOString().slice(0, 10)}) no es día de facturación. Nada que hacer.`);
    return;
  }
  if (forzado) {
    log('FORZAR_FACTURACION=1 -- ignorando el chequeo de fecha (modo prueba).');
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
