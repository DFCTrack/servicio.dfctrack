'use strict';

/**
 * Integración mínima: busca o crea un contacto (cliente) en Alegra.
 * Se llama desde registro.js justo después de crear (o encontrar) el
 * usuario en GPSWOX.
 *
 * Requiere Node 18+ (usa fetch nativo). El servidor tiene Node 20.20 -> OK.
 *
 * Variables de entorno requeridas, puestas en /opt/baileys-servicio/.env
 * (este archivo las carga solo, sin depender del paquete npm "dotenv"):
 *   ALEGRA_EMAIL  -> el correo con el que entras a Alegra
 *   ALEGRA_TOKEN  -> se genera en Alegra: Configuración > Usuarios > API
 */

const fs = require('fs');
const path = require('path');

// Carga variables desde .env (formato KEY=valor, una por línea) sin
// depender de ningún paquete nuevo. Si el archivo no existe, no falla
// aquí -- las funciones de abajo fallarán con un mensaje claro cuando
// falten las variables, sin tumbar el resto del servicio.
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
    // sin .env todavía -- se avisa solo si de verdad se intenta usar Alegra
  }
})();

const ALEGRA_BASE_URL = 'https://api.alegra.com/api/v1';

function getAuthHeader() {
  const email = process.env.ALEGRA_EMAIL;
  const token = process.env.ALEGRA_TOKEN;
  if (!email || !token) {
    throw new Error('Faltan ALEGRA_EMAIL o ALEGRA_TOKEN -- revisa /opt/baileys-servicio/.env');
  }
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${auth}`;
}

function normalizarCorreo(correo) {
  return String(correo || '').trim().toLowerCase();
}

async function buscarContactoPorCorreo(correo) {
  const correoNormalizado = normalizarCorreo(correo);
  const url = `${ALEGRA_BASE_URL}/contacts?email=${encodeURIComponent(correoNormalizado)}`;
  const res = await fetch(url, {
    headers: { Authorization: getAuthHeader() }
  });
  if (!res.ok) {
    throw new Error(`Alegra respondió ${res.status} al buscar contacto por correo`);
  }
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function crearContacto({ nombre, correo, whatsapp, identificacion }) {
  const correoNormalizado = normalizarCorreo(correo);
  const body = {
    name: nombre,
    email: correoNormalizado,
    phonePrimary: whatsapp,
    type: ['client']
  };
  if (identificacion) {
    body.identification = identificacion;
  }

  const res = await fetch(`${ALEGRA_BASE_URL}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const detalle = await res.text();
    throw new Error(`Alegra respondió ${res.status} al crear contacto: ${detalle}`);
  }
  return res.json();
}

async function buscarOCrearContacto({ nombre, correo, whatsapp, identificacion }) {
  try {
    const existente = await buscarContactoPorCorreo(correo);
    if (existente) {
      return { ok: true, creado: false, contacto: existente };
    }
    const nuevo = await crearContacto({ nombre, correo, whatsapp, identificacion });
    return { ok: true, creado: true, contacto: nuevo };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function obtenerPrecioItem(itemId) {
  const res = await fetch(`${ALEGRA_BASE_URL}/items/${itemId}`, {
    headers: { Authorization: getAuthHeader() }
  });
  if (!res.ok) {
    throw new Error(`Alegra respondio ${res.status} al consultar el item ${itemId}`);
  }
  const item = await res.json();
  const precioGeneral = Array.isArray(item.price) ? (item.price.find(p => p.main) || item.price[0]) : null;
  if (!precioGeneral) {
    throw new Error(`El item ${itemId} no tiene precio configurado en Alegra`);
  }
  return precioGeneral.price;
}
async function crearFactura({ contactoId, itemId, descripcion }) {
  try {
    const precio = await obtenerPrecioItem(itemId);
    const hoy = new Date().toISOString().slice(0, 10);
    const body = {
      date: hoy,
      dueDate: hoy,
      client: { id: contactoId },
      items: [
        { id: itemId, price: precio, quantity: 1, description: descripcion || undefined, tax: [] }
      ],
      paymentForm: 'CASH',
      numberTemplate: { id: '18' },
      status: 'open'
    };
    const res = await fetch(`${ALEGRA_BASE_URL}/invoices`, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detalle = await res.text();
      return { ok: false, error: `Alegra respondio ${res.status} al crear factura: ${detalle}` };
    }
    const factura = await res.json();
    return { ok: true, factura };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function consultarEstadoFactura(invoiceId) {
  try {
    const res = await fetch(`${ALEGRA_BASE_URL}/invoices/${invoiceId}`, {
      headers: { Authorization: getAuthHeader() }
    });
    if (!res.ok) {
      return { ok: false, error: `Alegra respondio ${res.status}` };
    }
    const factura = await res.json();
    return { ok: true, status: factura.status, balance: Number(factura.balance), total: Number(factura.total) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
module.exports = { buscarOCrearContacto, crearFactura, consultarEstadoFactura, buscarContactoPorCorreo };
