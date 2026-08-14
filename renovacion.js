'use strict';

const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');
const { buscarOCrearContacto } = require('./alegra-cliente');

(function cargarEnvLocal() {
  try {
    const envPath = path.join(__dirname, '.env');
    const contenido = fs.readFileSync(envPath, 'utf8');
    contenido.split('\n').forEach((linea) => {
      const match = linea.match(/^\s*([^=:#\s]+)\s*[=:]\s*(.*)\s*$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) process.env[key] = value;
      }
    });
  } catch (e) {}
})();

const ALEGRA_BASE_URL = 'https://api.alegra.com/api/v1';
const ITEM_RENOVACION = '150'; // "Renovación Servicio DFC Track GPS" en Alegra, RD$3,800 c/u

const DB_CONFIG = {
  host: '154.38.189.98',
  user: 'wsc_registro',
  password: 'Wr8Kd3mNpQ7fXz2LtY9bVc4H',
  database: 'gpswox_web'
};
function db() { return mysql.createConnection(DB_CONFIG); }

function getAuthHeader() {
  const email = process.env.ALEGRA_EMAIL;
  const token = process.env.ALEGRA_TOKEN;
  if (!email || !token) throw new Error('Faltan ALEGRA_EMAIL o ALEGRA_TOKEN -- revisa /opt/baileys-servicio/.env');
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function limpiarNumeroWA(num) {
  num = String(num || '').replace(/[^0-9]/g, '');
  if (num.length === 10) num = '1' + num;
  if (num.length === 11 && num.startsWith('1')) return num;
  return null;
}

async function crearFacturaRenovacion({ contactoId, cantidad, descripcion }) {
  const hoy = new Date().toISOString().slice(0, 10);
  const body = {
    date: hoy,
    dueDate: hoy,
    client: { id: contactoId },
    items: [{ id: ITEM_RENOVACION, price: 3800, quantity: cantidad, description: descripcion || undefined, tax: [] }],
    paymentForm: 'CASH',
    numberTemplate: { id: '18' },
    status: 'open'
  };
  const res = await fetch(`${ALEGRA_BASE_URL}/invoices`, {
    method: 'POST',
    headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detalle = await res.text();
    return { ok: false, error: `Alegra respondio ${res.status}: ${detalle}` };
  }
  const factura = await res.json();
  return { ok: true, factura };
}

module.exports = async function (req, res, sock) {
  if (req.method === 'POST' && req.url === '/api/renovacion/facturar') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let conn;
      try {
        const data = JSON.parse(body || '{}');
        const referencia = String(data.referencia || '').trim();
        if (!referencia) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Falta referencia' }));
        }
        conn = db();
        const row = await new Promise((resolve, reject) => {
          conn.query('SELECT * FROM renovaciones_tarjeta_pendientes WHERE referencia=? LIMIT 1', [referencia], (err, rows) => err ? reject(err) : resolve(rows && rows[0]));
        });
        if (!row) {
          conn.end();
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Referencia no encontrada' }));
        }
        if (row.estado === 'pagado_facturado') {
          conn.end();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, yaFacturado: true, factura: { number: row.alegra_invoice_number } }));
        }

        const contactoRes = await buscarOCrearContacto({ nombre: row.cliente_correo, correo: row.cliente_correo, whatsapp: row.cliente_whatsapp });
        if (!contactoRes.ok) {
          conn.end();
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Alegra contacto: ' + contactoRes.error }));
        }
        const contactoId = contactoRes.contacto.id;

        let vehiculosTxt = '';
        try { vehiculosTxt = JSON.parse(row.vehiculos || '[]').join(', '); } catch (e) { vehiculosTxt = row.vehiculos || ''; }
        const descripcion = `Renovacion 12 meses GPS - ${row.cantidad} vehiculo(s): ${vehiculosTxt}`.slice(0, 500);

        const facturaRes = await crearFacturaRenovacion({ contactoId, cantidad: row.cantidad, descripcion });
        if (!facturaRes.ok) {
          conn.end();
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Alegra factura: ' + facturaRes.error }));
        }
        const factura = facturaRes.factura;
        const numeroFactura = factura.numberTemplate ? factura.numberTemplate.fullNumber : factura.id;

        await new Promise((resolve, reject) => {
          conn.query(
            'UPDATE renovaciones_tarjeta_pendientes SET estado="pagado_facturado", alegra_invoice_id=?, alegra_invoice_number=?, azul_aprobacion=?, pagado_at=NOW() WHERE id=?',
            [factura.id, numeroFactura, data.azul_aprobacion || null, row.id],
            (err) => err ? reject(err) : resolve()
          );
        });
        conn.end();

        const numero = limpiarNumeroWA(row.cliente_whatsapp);
        if (numero && sock) {
          try {
            const msg = `✅ *Pago recibido - DFC Track GPS*\n\nTu renovacion fue confirmada y facturada.\n\n🧾 Factura: ${numeroFactura}\n🚗 Vehiculos: ${row.cantidad}\n💵 Total: RD$${Number(row.monto_sin_itbis).toLocaleString()}\n\nGracias por tu pago. Tu servicio GPS quedo renovado por 12 meses.`;
            await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: msg });
          } catch (eWA) { console.log('Error enviando WA renovacion:', eWA.message); }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, factura: { id: factura.id, number: numeroFactura } }));
      } catch (e) {
        if (conn) { try { conn.end(); } catch (e2) {} }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
};
