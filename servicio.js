const mysql = require('mysql2');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const formidable = require('formidable');
const { buscarOCrearContacto, crearFactura, consultarEstadoFactura, buscarContactoPorCorreo } = require('./alegra-cliente');
const ALEGRA_ITEMS_POR_TRABAJO = {
  'Instalación': '275',
  'Desinstalación': '166',
  'Mantenimiento': '288',
  'Reinstalación (1 traslado)': '151',
  'Reinstalación (2 traslados)': '175'
};

const DB_CONFIG = {
  host: '154.38.189.98',
  user: 'wsc_registro',
  password: process.env.DB_PASS_WSC_REGISTRO,
  database: 'gpswox_web'
};

const TECNICOS = {
  '2110': { nombre: 'Rafael Araujo', grupo_imei: 2110, whatsapp: '120363424390358074@g.us' },
  '2153': { nombre: 'Eudy Araujo', grupo_imei: 2153, whatsapp: '120363411686202992@g.us' },
  '1185': { nombre: 'Antonio Lorenzo', grupo_imei: 1185, whatsapp: '120363399361152969@g.us' },
  '1498': { nombre: 'Jhonson Higüey', grupo_imei: 1498, whatsapp: '120363202486052181@g.us' },
  '2087': { nombre: 'Raydi zona norte', grupo_imei: 2087, whatsapp: '120363425366804100@g.us' },
  '2099': { nombre: 'Jimmy San Juan', grupo_imei: 2099, whatsapp: '120363421362794585@g.us' },
};

const CLAVE_NUEVO = process.env.SERVICIO_CLAVE || '';
const ADMIN_USER = process.env.SERVICIO_ADMIN_USER || 'admin';
const ADMIN_PASS_HASH = process.env.SERVICIO_ADMIN_PASS_HASH || '';
const UPLOAD_DIR = '/opt/baileys-servicio/uploads/servicios';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Sesion real (cookie), ademas de la clave por URL, para no romper enlaces existentes ---
const SESIONES = new Map(); // sessionId -> expiraEn (ms)
const SESION_DURACION_MS = 12 * 60 * 60 * 1000; // 12 horas
function crearSesion() {
  const id = crypto.randomBytes(32).toString('hex');
  SESIONES.set(id, Date.now() + SESION_DURACION_MS);
  return id;
}
function destruirSesion(id) { if (id) SESIONES.delete(id); }
function leerCookie(req, nombre) {
  const raw = req.headers.cookie || '';
  const partes = raw.split(';');
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i].trim();
    const idx = p.indexOf('=');
    if (idx > -1 && p.slice(0, idx) === nombre) return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}
function idSesion(req) { return leerCookie(req, 'dfc_sesion'); }
function sesionValida(req) {
  const id = idSesion(req);
  if (!id || !SESIONES.has(id)) return false;
  if (Date.now() > SESIONES.get(id)) { SESIONES.delete(id); return false; }
  return true;
}
function accesoAdminValido(req, query) {
  if (sesionValida(req)) return true;
  const recibida = (query && (query.clave || query.admin)) || '';
  return !!CLAVE_NUEVO && recibida === CLAVE_NUEVO;
}

// Busca el grupo de dispositivos (device_groups) que ya tiene un usuario de WOX; si no tiene, crea uno con el nombre del cliente.
function resolverGrupoCliente(userId, nombreCliente, cb) {
  const conn = db();
  conn.query(
    "SELECT id FROM device_groups WHERE user_id=? AND (deleted_at IS NULL OR deleted_at='') ORDER BY id ASC LIMIT 1",
    [userId],
    (err, rows) => {
      if (!err && rows && rows.length) {
        conn.end();
        return cb(null, rows[0].id);
      }
      const titulo = (nombreCliente || ('Cliente ' + userId)).toString().trim().slice(0, 255) || ('Cliente ' + userId);
      conn.query(
        'INSERT INTO device_groups (user_id, title, open, updated_at) VALUES (?, ?, 0, NOW())',
        [userId, titulo],
        (err2, result) => {
          conn.end();
          if (err2) return cb(err2);
          cb(null, result.insertId);
        }
      );
    }
  );
}

function db() { return mysql.createConnection(DB_CONFIG); }
function generarToken() { return crypto.randomBytes(6).toString('hex'); }
function esc(v) { return (v === null || v === undefined) ? '' : String(v).replace(/"/g, '&quot;'); }
function renderWoxBox(p, isAdmin) {
  if (!isAdmin || p.estado !== 'terminado') return '';
  const esTrasladoServ = p.trabajo === 'Reinstalación (1 traslado)' || p.trabajo === 'Reinstalación (2 traslados)';
  if (p.trabajo !== 'Instalación' && !esTrasladoServ) return '';
  if (p.aplicado_wox) {
    return '<div style="margin-top:16px;padding:12px;background:#eafaf3;border-radius:8px;color:#128C7E;font-weight:600;">✅ Ya aplicado a GPSWOX' + (p.aplicado_wox_at ? (' — ' + esc(String(p.aplicado_wox_at))) : '') + '</div>';
  }
  if (esTrasladoServ) {
    if (!p.vehiculo_destino_marca || !p.vehiculo_destino_placa) return '';
    return '' +
      '<div id="wox-box" style="margin-top:16px;padding:14px;background:#eef6ff;border-radius:8px;">' +
      '<div style="font-size:13px;color:#666;margin-bottom:8px;">Esto actualizará en GPSWOX el vehículo del IMEI ' + esc(p.imei) + ' con los datos del vehículo destino (mismo cliente).</div>' +
      '<button type="button" id="btn-aplicar-wox-traslado" style="background:#f5a623;">Aplicar traslado a GPSWOX</button>' +
      '</div>';
  }
  var nombreSugerido = ((p.vehiculo_marca || '') + ' ' + (p.vehiculo_modelo || '') + ' ' + (p.color_vehiculo || '')).replace(/\s+/g, ' ').trim();
  return '' +
    '<div id="wox-box" style="margin-top:16px;padding:14px;background:#eef6ff;border-radius:8px;">' +
    '<label>Nombre del vehículo en GPSWOX</label>' +
    '<input type="text" id="wox_name" value="' + esc(nombreSugerido) + '">' +
    '<label>Cliente en GPSWOX</label>' +
    '<div id="wox-cliente-box" style="font-size:13px;color:#666;padding:6px 0;">Buscando por celular...</div>' +
    '<input type="text" id="wox_cliente_buscar" placeholder="Buscar cliente por email..." style="display:none;margin-top:6px;">' +
    '<div id="wox-cliente-resultados" style="display:none;font-size:13px;border:1px solid #ddd;border-radius:6px;margin-top:4px;max-height:140px;overflow:auto;"></div>' +
    '<button type="button" id="btn-aplicar-wox" style="background:#f5a623;margin-top:10px;" disabled>Aplicar a GPSWOX</button>' +
    '</div>';
}

function renderForm(tecnicoId, recordId, prefill, isAdmin) {
  const t = TECNICOS[tecnicoId];
  const nombreTecnico = t ? t.nombre : 'Técnico desconocido';
  const p = prefill || {};
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Servicio GPS</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; padding:16px; }
  .card { background:#fff; border-radius:10px; padding:20px; max-width:480px; margin:0 auto; box-shadow:0 1px 4px rgba(0,0,0,.1); }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#666; font-size:13px; margin-bottom:16px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
  input, select, textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:6px; font-size:15px; font-family:inherit; }
  .row2 { display:flex; gap:10px; }
  .row2 > div { flex:1; }
  button { width:100%; margin-top:22px; padding:14px; background:#128C7E; color:#fff; border:none; border-radius:8px; font-size:16px; font-weight:600; }
  button:disabled { background:#9bbcb7; }
  #status { text-align:center; font-size:12px; color:#888; margin-top:8px; }
  #foto-preview { margin-top:8px; max-width:100%; border-radius:6px; display:none; }
  .logo { display:block; max-width:160px; margin:0 auto 14px; }
  .gps-box { margin-top:10px; padding:12px; border-radius:8px; background:#f7f7f7; font-size:13px; }
  .gps-online { color:#128C7E; font-weight:600; }
  .gps-offline { color:#c53030; font-weight:600; }
  .seccion { margin-top:20px; padding-top:14px; border-top:2px solid #eee; }
  .seccion-titulo { font-size:12px; font-weight:700; color:#128C7E; text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
  .falta-evidencia { color:#c53030; font-weight:600; font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<div class="card">
  <img class="logo" src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC Track GPS">
  <h1>🛰 Servicio GPS</h1>
  <div class="sub">Técnico: <b>${nombreTecnico}</b> · Actividad: <b>${new Date().toLocaleDateString('es-DO')}</b></div>
  ${isAdmin ? ('<label>Reasignar técnico</label><select id="tecnico_id_admin">' + Object.entries(TECNICOS).map(function(e){ return '<option value="' + e[0] + '" ' + (e[0] === tecnicoId ? 'selected' : '') + '>' + e[1].nombre + '</option>'; }).join('') + '</select>') : ''}

  <div class="seccion">
    <div class="seccion-titulo">Cliente</div>
    <label>Nombre del cliente</label>
    <input type="text" id="cliente" value="${esc(p.cliente)}" placeholder="Nombre del cliente">
    <label>Celular / WhatsApp</label>
    <input type="tel" id="celular" value="${esc(p.celular)}" placeholder="809-000-0000">
    ${isAdmin ? ('<label>Correo (solo admin)</label><input type="email" id="correo" value="' + esc(p.correo) + '" placeholder="correo@ejemplo.com">' +
      '<button type="button" id="btn-sincronizar-alegra" style="width:auto;margin-top:8px;padding:8px 14px;background:#0b76ef;font-size:13px;">🔄 Sincronizar con Alegra</button>' +
      '<div id="sync-alegra-resultado" style="display:none;margin-top:8px;padding:10px;background:#f7f7f7;border-radius:6px;font-size:13px;"></div>' +
      '<label>Pago a técnico</label><select id="pago_tecnico"><option value="pendiente" ' + (p.pago_tecnico!=='pagado'?'selected':'') + '>Pendiente</option><option value="pagado" ' + (p.pago_tecnico==='pagado'?'selected':'') + '>Pagado</option></select>') : ''}
  </div>

  <div class="seccion">
    <div class="seccion-titulo">Persona que recibe el servicio</div>
    <label>Nombre de quien recibe</label>
    <input type="text" id="persona_recibe_nombre" value="${esc(p.persona_recibe_nombre)}" placeholder="Si es distinto al cliente titular">
    <label>Teléfono de quien recibe</label>
    <input type="tel" id="persona_recibe_telefono" value="${esc(p.persona_recibe_telefono)}" placeholder="809-000-0000">
    <label>Relación / nota</label>
    <input type="text" id="persona_recibe_nota" value="${esc(p.persona_recibe_nota)}" placeholder="Ej: hermano, empleado, encargado del vehículo">
  </div>

  <div class="row2">
    <div>
      <label>Fecha del servicio</label>
      <input type="date" id="fecha" value="${esc(p.fecha ? String(p.fecha).substring(0,10) : '')}">
    </div>
    <div>
      <label>Hora del servicio</label>
      <input type="time" id="hora" value="${esc(p.hora)}">
    </div>
  </div>

  <label>Servicio a realizar</label>
  <select id="trabajo">
    <option value="">Selecciona...</option>
    <option value="Instalación" ${p.trabajo==='Instalación'?'selected':''}>Instalación</option>
    <option value="Desinstalación" ${p.trabajo==='Desinstalación'?'selected':''}>Desinstalación</option>
    <option value="Mantenimiento" ${p.trabajo==='Mantenimiento'?'selected':''}>Mantenimiento</option>
    <option value="Reinstalación (1 traslado)" ${p.trabajo==='Reinstalación (1 traslado)'?'selected':''}>Reinstalación (1 traslado)</option>
    <option value="Reinstalación (2 traslados)" ${p.trabajo==='Reinstalación (2 traslados)'?'selected':''}>Reinstalación (2 traslados)</option>
  </select>

  <div class="seccion" id="titulo-vehiculo-origen-wrap" style="display:none;">
    <div class="seccion-titulo">🔻 Retirar GPS de (vehículo origen)</div>
  </div>

  <div class="row2">
    <div>
      <label>Vehículo (marca)</label>
      <input type="text" id="vehiculo_marca" value="${esc(p.vehiculo_marca)}">
    </div>
    <div>
      <label>Modelo</label>
      <input type="text" id="vehiculo_modelo" value="${esc(p.vehiculo_modelo)}">
    </div>
  </div>

  <div id="fila-color" style="display:none;">
    <label>Color del vehículo</label>
    <input type="text" id="color_vehiculo" value="${esc(p.color_vehiculo)}">
  </div>

  <label>Placa o chasis</label>
  <input type="text" id="placa_chasis" value="${esc(p.placa_chasis)}">

  <label>Zona de instalación</label>
  <input type="text" id="zona_instalacion" value="${esc(p.zona_instalacion)}">

  <div class="seccion" id="bloque-vehiculo-destino" style="display:none;">
    <div class="seccion-titulo">🔺 Instalar GPS en (vehículo destino)</div>
    <div class="row2">
      <div>
        <label>Vehículo (marca)</label>
        <input type="text" id="vehiculo_destino_marca" value="${esc(p.vehiculo_destino_marca)}">
      </div>
      <div>
        <label>Modelo</label>
        <input type="text" id="vehiculo_destino_modelo" value="${esc(p.vehiculo_destino_modelo)}">
      </div>
    </div>
    <div class="row2">
      <div>
        <label>Año</label>
        <input type="text" id="vehiculo_destino_anio" value="${esc(p.vehiculo_destino_anio)}">
      </div>
      <div>
        <label>Color</label>
        <input type="text" id="vehiculo_destino_color" value="${esc(p.vehiculo_destino_color)}">
      </div>
    </div>
    <label>Placa</label>
    <input type="text" id="vehiculo_destino_placa" value="${esc(p.vehiculo_destino_placa)}">
  </div>

  <label>¿Posee apagado?</label>
  <select id="posee_apagado">
    <option value="">Selecciona...</option>
    <option value="1" ${p.posee_apagado==1?'selected':''}>Sí</option>
    <option value="0" ${p.posee_apagado==0?'selected':''}>No</option>
  </select>

  <label>Ubicación (link de Google Maps)</label>
  <input type="url" id="ubicacion_url" value="${esc(p.ubicacion_url)}" placeholder="Ubicación del cliente">

  <label>Nota</label>
  <textarea id="nota" rows="2" placeholder="Notas importantes, observaciones (check-in, luces tablero, etc.)">${esc(p.nota)}</textarea>

  <div id="fila-imei-select">
    <label>IMEI del equipo instalado</label>
    <select id="imei_select"><option value="">Cargando...</option></select>
  </div>
  <div id="fila-imei-manual" style="display:none;">
    <label>IMEI</label>
    <input type="text" id="imei_manual" value="${esc(p.imei)}" placeholder="Escribe el IMEI del equipo">
  </div>

  <div class="gps-box" id="gps-box" style="display:none;">
    <div id="gps-estado">📡 Consultando estado...</div>
  </div>

  <div class="seccion">
    <div class="seccion-titulo">Evidencias fotográficas (obligatorias)</div>
    <label>Foto 1 — Vehículo</label>
    <input type="file" id="foto" accept="image/*" capture="environment">
    <img id="foto-preview">
    <div id="foto-estado" style="font-size:12px;color:#888;margin-top:4px;">${p.foto_path ? '✅ Ya subida' : 'Falta subir'}</div>

    <label>Foto 2 — Ubicación del GPS (zona de instalación) — opcional</label>
    <input type="file" id="foto_gps" accept="image/*" capture="environment">
    <img id="foto-gps-preview">
    <div id="foto-gps-estado" style="font-size:12px;color:#888;margin-top:4px;">${p.foto_gps_path ? '✅ Ya subida' : 'Falta subir'}</div>
  </div>

  <label>Estado de cierre</label>
  <select id="estado_cierre">
    <option value="">Selecciona...</option>
    <option value="Instalado">Instalado</option>
    <option value="Terminado">Terminado</option>
  </select>

  <div id="falta-evidencia-msg" class="falta-evidencia" style="display:none;"></div>
  <button id="btn-terminar">Terminar y Enviar</button>
  ${(isAdmin && p.estado !== 'terminado') ? '<button type="button" id="btn-guardar-admin" style="background:#555;">💾 Guardar</button>' : ''}
  ${isAdmin ? '<button type="button" id="btn-reenviar" style="background:#0b76ef;">🔄 Reenviar WS al técnico</button>' : ''}
  ${(isAdmin && p.estado === 'terminado') ? ('<button type="button" id="btn-crear-alegra" style="background:#f0932b;" ' + (p.alegra_invoice_id ? 'disabled' : '') + '>🧾 ' + (p.alegra_invoice_id ? ('Facturado ✓ #' + esc(p.alegra_invoice_number)) : 'Crear en Alegra') + '</button>') : ''}
  ${isAdmin ? '<a href="/servicio/login?logout=1" style="display:block; text-align:center; margin-top:14px; color:#c53030; font-size:13px; font-weight:600; text-decoration:none;">🚪 Cerrar sesión</a>' : ''}
  ${renderWoxBox(p, isAdmin)}
  <div id="status">Guardado automático activado</div>
</div>

<script>
const TECNICO_ID = "${tecnicoId}";
let RECORD_ID = ${recordId ? recordId : 'null'};
const IMEI_PREFILL = "${esc(p.imei)}";
const IS_ADMIN = ${isAdmin ? 'true' : 'false'};
const CLAVE_ADMIN = "${isAdmin ? CLAVE_NUEVO : ''}";

function getImeiValue() {
  return (val('trabajo') === 'Instalación') ? val('imei_select') : val('imei_manual');
}

function esTraslado(trabajo) {
  return trabajo === 'Reinstalación (1 traslado)' || trabajo === 'Reinstalación (2 traslados)';
}
function campos() {
  const tecnicoSelectAdmin = document.getElementById('tecnico_id_admin');
  const correoEl = document.getElementById('correo');
  const pagoTecnicoEl = document.getElementById('pago_tecnico');
  return {
    tecnico_id: (IS_ADMIN && tecnicoSelectAdmin) ? tecnicoSelectAdmin.value : TECNICO_ID,
    fecha: val('fecha'), hora: val('hora'), cliente: val('cliente'), celular: val('celular'),
    trabajo: val('trabajo'), vehiculo_marca: val('vehiculo_marca'), vehiculo_modelo: val('vehiculo_modelo'),
    color_vehiculo: val('color_vehiculo'),
    placa_chasis: val('placa_chasis'), zona_instalacion: val('zona_instalacion'),
    posee_apagado: val('posee_apagado'), ubicacion_url: val('ubicacion_url'), nota: val('nota'), imei: getImeiValue(),
    correo: correoEl ? correoEl.value : undefined,
    pago_tecnico: pagoTecnicoEl ? pagoTecnicoEl.value : undefined,
    persona_recibe_nombre: val('persona_recibe_nombre'),
    persona_recibe_telefono: val('persona_recibe_telefono'),
    persona_recibe_nota: val('persona_recibe_nota'),
    vehiculo_destino_marca: esTraslado(val('trabajo')) ? val('vehiculo_destino_marca') : undefined,
    vehiculo_destino_modelo: esTraslado(val('trabajo')) ? val('vehiculo_destino_modelo') : undefined,
    vehiculo_destino_color: esTraslado(val('trabajo')) ? val('vehiculo_destino_color') : undefined,
    vehiculo_destino_placa: esTraslado(val('trabajo')) ? val('vehiculo_destino_placa') : undefined,
    vehiculo_destino_anio: esTraslado(val('trabajo')) ? val('vehiculo_destino_anio') : undefined
  };
}
function val(id) { return document.getElementById(id).value; }

let imeiCargado = false;
async function cargarImei() {
  const sel = document.getElementById('imei_select');
  try {
    const r = await fetch('/api/servicio/imei?tecnico=' + TECNICO_ID);
    const data = await r.json();
    var opts = '<option value="">Selecciona IMEI...</option>';
    for (var i = 0; i < data.length; i++) {
      var d = data[i];
      var sel_attr = (d.imei === IMEI_PREFILL) ? 'selected' : '';
      opts += '<option value="' + d.imei + '" ' + sel_attr + '>' + d.imei + ' (' + (d.device_model || '') + ')</option>';
    }
    sel.innerHTML = opts;
  } catch(e) {
    sel.innerHTML = '<option value="">Error cargando IMEI</option>';
  }
}

function actualizarCamposPorTrabajo() {
  const trabajo = val('trabajo');
  const filaColor = document.getElementById('fila-color');
  const filaImeiSelect = document.getElementById('fila-imei-select');
  const filaImeiManual = document.getElementById('fila-imei-manual');
  const bloqueDestino = document.getElementById('bloque-vehiculo-destino');
  const tituloOrigenWrap = document.getElementById('titulo-vehiculo-origen-wrap');
  if (trabajo === 'Instalación') {
    filaColor.style.display = 'block';
    filaImeiSelect.style.display = 'block';
    filaImeiManual.style.display = 'none';
    if (!imeiCargado) { imeiCargado = true; cargarImei(); }
  } else if (trabajo === 'Desinstalación' || trabajo === 'Mantenimiento' || trabajo === 'Reinstalación (1 traslado)' || trabajo === 'Reinstalación (2 traslados)') {
    filaColor.style.display = 'none';
    filaImeiSelect.style.display = 'none';
    filaImeiManual.style.display = 'block';
  } else {
    filaColor.style.display = 'none';
    filaImeiSelect.style.display = 'block';
    filaImeiManual.style.display = 'none';
    if (!imeiCargado) { imeiCargado = true; cargarImei(); }
  }
  const traslado = esTraslado(trabajo);
  bloqueDestino.style.display = traslado ? 'block' : 'none';
  tituloOrigenWrap.style.display = traslado ? 'block' : 'none';
}
document.getElementById('trabajo').addEventListener('change', actualizarCamposPorTrabajo);

let autosaveTimer = null;
function programarAutoguardado() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autoguardar, 1200);
}

async function autoguardar() {
  document.getElementById('status').innerText = 'Guardando...';
  const body = campos();
  if (RECORD_ID) body.id = RECORD_ID;
  const r = await fetch('/api/servicio/autoguardar', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (data.id) RECORD_ID = data.id;
  document.getElementById('status').innerText = 'Guardado automático ✓';
}

document.querySelectorAll('input, select, textarea').forEach(function(el) {
  if (el.id === 'foto') return;
  el.addEventListener('input', programarAutoguardado);
  el.addEventListener('change', programarAutoguardado);
});

let FOTO_VEHICULO_OK = ${p.foto_path ? 'true' : 'false'};
let FOTO_GPS_OK = ${p.foto_gps_path ? 'true' : 'false'};

async function subirFoto(inputId, previewId, estadoId, tipo) {
  const input = document.getElementById(inputId);
  const fotoFile = input.files[0];
  if (!fotoFile) return;
  const preview = document.getElementById(previewId);
  preview.src = URL.createObjectURL(fotoFile);
  preview.style.display = 'block';
  if (!RECORD_ID) { await autoguardar(); }
  const fd = new FormData();
  fd.append('foto', fotoFile);
  fd.append('id', RECORD_ID);
  fd.append('tipo', tipo);
  document.getElementById('status').innerText = 'Subiendo foto...';
  const r = await fetch('/api/servicio/foto', { method: 'POST', body: fd });
  const data = await r.json();
  if (data.ok) {
    if (tipo === 'gps') { FOTO_GPS_OK = true; } else { FOTO_VEHICULO_OK = true; }
    document.getElementById(estadoId).innerText = '✅ Ya subida';
  }
  document.getElementById('status').innerText = 'Foto subida ✓';
}
document.getElementById('foto').addEventListener('change', () => subirFoto('foto', 'foto-preview', 'foto-estado', 'vehiculo'));
document.getElementById('foto_gps').addEventListener('change', () => subirFoto('foto_gps', 'foto-gps-preview', 'foto-gps-estado', 'gps'));

document.getElementById('btn-terminar').addEventListener('click', async () => {
  const estado_cierre = val('estado_cierre');
  const faltaMsg = document.getElementById('falta-evidencia-msg');
  faltaMsg.style.display = 'none';
  if (!estado_cierre) { alert('Selecciona el estado de cierre (Instalado/Terminado)'); return; }
  const faltantes = [];
  if (!val('cliente')) faltantes.push('Cliente');
  if (!getImeiValue()) faltantes.push('IMEI');
  if (!val('vehiculo_marca')) faltantes.push('Vehículo (marca)');
  if (!val('vehiculo_modelo')) faltantes.push('Modelo');
  if (val('trabajo') === 'Instalación' && !val('color_vehiculo')) faltantes.push('Color del vehículo');
  if (!val('zona_instalacion')) faltantes.push('Zona de instalación');
  if (!FOTO_VEHICULO_OK) faltantes.push('Foto del vehículo');
  if (esTraslado(val('trabajo')) && (!val('vehiculo_destino_marca') || !val('vehiculo_destino_placa'))) faltantes.push('Vehículo destino (marca y placa)');
  if (faltantes.length) {
    faltaMsg.innerText = 'Faltan campos obligatorios: ' + faltantes.join(', ');
    faltaMsg.style.display = 'block';
    return;
  }
  const btn = document.getElementById('btn-terminar');
  btn.disabled = true; btn.innerText = 'Enviando...';
  await autoguardar();
  const body = campos();
  body.id = RECORD_ID;
  body.estado_cierre = estado_cierre;
  const r = await fetch('/api/servicio/terminar', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (data.ok) {
    btn.innerText = '✅ Información enviada';
    document.getElementById('status').innerText = 'Información enviada — DFC Track GPS';
  } else {
    btn.disabled = false; btn.innerText = 'Terminar y Enviar';
    faltaMsg.innerText = data.error || 'Error desconocido';
    faltaMsg.style.display = 'block';
  }
});

async function consultarEstado(imei) {
  const box = document.getElementById('gps-box');
  const estadoDiv = document.getElementById('gps-estado');
  if (!imei) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  estadoDiv.innerHTML = '📡 Consultando estado...';
  try {
    const r = await fetch('/api/servicio/estado?imei=' + encodeURIComponent(imei));
    const d = await r.json();
    if (d.online) {
      estadoDiv.innerHTML = '<span class="gps-online">🟢 Online</span> · última señal hace ' + (d.minutos_offline||0) + ' min';
    } else if (d.minutos_offline !== undefined && d.minutos_offline !== null) {
      var horas = Math.floor(d.minutos_offline / 60);
      estadoDiv.innerHTML = '<span class="gps-offline">🔴 Offline</span> · última señal hace ' + horas + 'h';
    } else {
      estadoDiv.innerHTML = '<span class="gps-offline">🔴 Sin señal registrada</span>';
    }
  } catch(e) {
    estadoDiv.innerHTML = 'No se pudo consultar el estado.';
  }
}

document.getElementById('imei_select').addEventListener('change', function() {
  consultarEstado(this.value);
});
document.getElementById('imei_manual').addEventListener('change', function() {
  consultarEstado(this.value);
});

if (IMEI_PREFILL) { consultarEstado(IMEI_PREFILL); }
actualizarCamposPorTrabajo();

if (IS_ADMIN) {
  const btnSyncAlegra = document.getElementById('btn-sincronizar-alegra');
  if (btnSyncAlegra) {
    btnSyncAlegra.addEventListener('click', async () => {
      const cont = document.getElementById('sync-alegra-resultado');
      const correoActual = document.getElementById('correo').value.trim();
      if (!correoActual) {
        cont.style.display = 'block';
        cont.innerHTML = 'Escribe el correo del cliente primero.';
        return;
      }
      btnSyncAlegra.disabled = true; btnSyncAlegra.innerText = 'Consultando...';
      cont.style.display = 'block';
      cont.innerHTML = 'Buscando en Alegra...';
      try {
        const r = await fetch('/api/servicio/sincronizar-alegra?clave=' + CLAVE_ADMIN + '&correo=' + encodeURIComponent(correoActual) + '&id=' + RECORD_ID);
        const data = await r.json();
        if (!data.ok) {
          cont.innerHTML = 'Error: ' + (data.error || 'desconocido');
        } else if (!data.existe) {
          cont.innerHTML = 'No existe todavía en Alegra con ese correo. Se creará automáticamente cuando factures.';
        } else if (data.coincide) {
          cont.innerHTML = '✅ Coincide con Alegra — ' + data.alegra_nombre + (data.alegra_telefono ? (' · ' + data.alegra_telefono) : '');
        } else {
          cont.innerHTML =
            '<div>Los datos no coinciden:</div>' +
            '<div style="margin-top:6px;"><b>En Alegra:</b> ' + (data.alegra_nombre || '-') + (data.alegra_telefono ? (' · ' + data.alegra_telefono) : '') + '</div>' +
            '<div><b>En el ticket:</b> ' + (document.getElementById('cliente').value || '-') + ' · ' + (document.getElementById('celular').value || '-') + '</div>' +
            '<div style="margin-top:8px;display:flex;gap:8px;">' +
            '<button type="button" id="btn-usar-alegra" style="width:auto;padding:6px 12px;background:#128C7E;font-size:12px;">Usar datos de Alegra</button>' +
            '<button type="button" id="btn-usar-ticket" style="width:auto;padding:6px 12px;background:#888;font-size:12px;">Dejar como está</button>' +
            '</div>';
          const btnUsarAlegra = document.getElementById('btn-usar-alegra');
          const btnUsarTicket = document.getElementById('btn-usar-ticket');
          if (btnUsarAlegra) btnUsarAlegra.addEventListener('click', () => {
            if (data.alegra_nombre) document.getElementById('cliente').value = data.alegra_nombre;
            if (data.alegra_telefono) document.getElementById('celular').value = data.alegra_telefono;
            programarAutoguardado();
            cont.innerHTML = '✅ Datos de Alegra aplicados al ticket. Se guardará automáticamente.';
          });
          if (btnUsarTicket) btnUsarTicket.addEventListener('click', () => {
            cont.innerHTML = 'Se dejó el ticket como estaba.';
          });
        }
      } catch (e) {
        cont.innerHTML = 'Error de conexión al consultar Alegra.';
      }
      btnSyncAlegra.disabled = false; btnSyncAlegra.innerText = '🔄 Sincronizar con Alegra';
    });
  }
  const btnGuardarAdmin = document.getElementById('btn-guardar-admin');
  if (btnGuardarAdmin) {
    btnGuardarAdmin.addEventListener('click', async () => {
      btnGuardarAdmin.disabled = true; btnGuardarAdmin.innerText = 'Guardando...';
      await autoguardar();
      btnGuardarAdmin.disabled = false; btnGuardarAdmin.innerText = '💾 Guardar';
      document.getElementById('status').innerText = 'Guardado ✓';
      const cerrar = confirm('Datos guardados. ¿Quieres además marcar este servicio como TERMINADO ahora? (cierre manual/contingencia, sin exigir fotos ni vehículo destino — úsalo solo si el trabajo se hizo por otra vía)');
      if (!cerrar) return;
      const body = campos();
      body.id = RECORD_ID;
      body.estado_cierre = val('estado_cierre') || 'Terminado';
      body.cierre_manual = true;
      const r = await fetch('/api/servicio/terminar?clave=' + CLAVE_ADMIN, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      const data = await r.json();
      if (data.ok) {
        alert('Servicio cerrado manualmente ✓');
        location.reload();
      } else {
        alert('Error: ' + (data.error || 'desconocido'));
      }
    });
  }
  const btnAlegra = document.getElementById('btn-crear-alegra');
  if (btnAlegra) {
    btnAlegra.addEventListener('click', async () => {
      btnAlegra.disabled = true;
      const textoOriginal = btnAlegra.innerText;
      btnAlegra.innerText = 'Facturando...';
      await autoguardar();
      try {
        const r = await fetch('/api/servicio/crear-alegra?clave=' + CLAVE_ADMIN, {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: RECORD_ID })
        });
        const data = await r.json();
        if (data.ok) {
          btnAlegra.innerText = '🧾 Facturado ✓ #' + (data.numero || data.facturaId);
        } else if (data.requiereConfirmacion) {
          if (confirm(data.error + ' ¿Facturar de todas formas?')) {
            const r2 = await fetch('/api/servicio/crear-alegra?clave=' + CLAVE_ADMIN, {
              method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: RECORD_ID, forzar: true })
            });
            const data2 = await r2.json();
            if (data2.ok) {
              btnAlegra.innerText = '🧾 Facturado ✓ #' + (data2.numero || data2.facturaId);
            } else {
              btnAlegra.disabled = false; btnAlegra.innerText = textoOriginal;
              alert('Error: ' + (data2.error || 'desconocido'));
            }
          } else {
            btnAlegra.disabled = false; btnAlegra.innerText = textoOriginal;
          }
        } else {
          btnAlegra.disabled = false; btnAlegra.innerText = textoOriginal;
          alert('Error: ' + (data.error || 'desconocido'));
        }
      } catch (eAlegra) {
        btnAlegra.disabled = false; btnAlegra.innerText = textoOriginal;
        alert('Error de conexión al facturar.');
      }
    });
  }
  const btnR = document.getElementById('btn-reenviar');
  if (btnR) {
    btnR.addEventListener('click', async () => {
      btnR.disabled = true; btnR.innerText = 'Enviando...';
      await autoguardar();
      try {
        const r = await fetch('/api/servicio/reenviar', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: RECORD_ID })
        });
        const data = await r.json();
        if (data.ok) { alert('Reenviado por WhatsApp ✓'); } else { alert('Error: ' + (data.error || 'desconocido')); }
      } catch(e) {
        alert('Error: ' + e.message);
      }
      btnR.disabled = false; btnR.innerText = '🔄 Reenviar WS al técnico';
    });
  }
}

if (IS_ADMIN) {
  const btnAplicarTraslado = document.getElementById('btn-aplicar-wox-traslado');
  if (btnAplicarTraslado) {
    btnAplicarTraslado.addEventListener('click', async () => {
      btnAplicarTraslado.disabled = true; btnAplicarTraslado.innerText = 'Aplicando...';
      try {
        const r = await fetch('/api/servicio/aplicar-wox-traslado?clave=' + encodeURIComponent(CLAVE_ADMIN), {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ id: RECORD_ID })
        });
        const data = await r.json();
        if (data.ok) {
          alert('Traslado aplicado a GPSWOX ✓');
          document.getElementById('wox-box').innerHTML = '<div style="color:#128C7E;font-weight:600;">✅ Aplicado a GPSWOX</div>';
        } else {
          alert('Error: ' + (data.error || 'desconocido'));
          btnAplicarTraslado.disabled = false; btnAplicarTraslado.innerText = 'Aplicar traslado a GPSWOX';
        }
      } catch (e) {
        alert('Error: ' + e.message);
        btnAplicarTraslado.disabled = false; btnAplicarTraslado.innerText = 'Aplicar traslado a GPSWOX';
      }
    });
  }
  const boxCliente = document.getElementById('wox-cliente-box');
  const btnAplicar = document.getElementById('btn-aplicar-wox');
  let clienteSeleccionadoId = null;
  let clienteSeleccionadoEmail = null;
  async function buscarClienteAuto() {
    if (!boxCliente) return;
    try {
      const r = await fetch('/api/servicio/buscar-cliente?celular=' + encodeURIComponent(val('celular')) + '&clave=' + encodeURIComponent(CLAVE_ADMIN));
      const data = await r.json();
      if (data.matches && data.matches.length === 1) {
        clienteSeleccionadoId = data.matches[0].id;
        clienteSeleccionadoEmail = data.matches[0].email;
        boxCliente.innerHTML = '✅ ' + data.matches[0].email;
        if (btnAplicar) btnAplicar.disabled = false;
      } else if (data.matches && data.matches.length > 1) {
        boxCliente.innerHTML = 'Varias coincidencias, escribe el correo exacto abajo:';
        document.getElementById('wox_cliente_buscar').style.display = 'block';
      } else {
        boxCliente.innerHTML = 'No se encontró cliente por ese celular. Búscalo por correo:';
        document.getElementById('wox_cliente_buscar').style.display = 'block';
      }
    } catch (e) {
      boxCliente.innerHTML = 'Error buscando cliente.';
    }
  }
  const buscarInput = document.getElementById('wox_cliente_buscar');
  if (buscarInput) {
    let buscarTimer = null;
    buscarInput.addEventListener('input', function() {
      clearTimeout(buscarTimer);
      const q = buscarInput.value;
      buscarTimer = setTimeout(async () => {
        if (q.length < 3) return;
        const r = await fetch('/api/servicio/buscar-cliente?email=' + encodeURIComponent(q) + '&clave=' + encodeURIComponent(CLAVE_ADMIN));
        const data = await r.json();
        const cont = document.getElementById('wox-cliente-resultados');
        if (!data.matches || !data.matches.length) {
          cont.style.display = 'block';
          cont.innerHTML = '<div style="padding:6px;">Sin resultados</div>';
          return;
        }
        cont.style.display = 'block';
        cont.innerHTML = data.matches.map(function(m) {
          return '<div class="wox-opt" data-id="' + m.id + '" data-email="' + m.email + '" style="padding:6px;cursor:pointer;border-bottom:1px solid #eee;">' + m.email + '</div>';
        }).join('');
        cont.querySelectorAll('.wox-opt').forEach(function(el) {
          el.addEventListener('click', function() {
            clienteSeleccionadoId = parseInt(el.getAttribute('data-id'));
            clienteSeleccionadoEmail = el.getAttribute('data-email');
            boxCliente.innerHTML = '✅ ' + clienteSeleccionadoEmail;
            cont.style.display = 'none';
            buscarInput.style.display = 'none';
            if (btnAplicar) btnAplicar.disabled = false;
          });
        });
      }, 400);
    });
  }
  if (boxCliente) buscarClienteAuto();
  if (btnAplicar) {
    btnAplicar.addEventListener('click', async () => {
      if (!clienteSeleccionadoId) { alert('Selecciona el cliente primero'); return; }
      btnAplicar.disabled = true; btnAplicar.innerText = 'Aplicando...';
      try {
        const r = await fetch('/api/servicio/aplicar-wox?clave=' + encodeURIComponent(CLAVE_ADMIN), {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ id: RECORD_ID, name: val('wox_name'), cliente_user_id: clienteSeleccionadoId })
        });
        const data = await r.json();
        if (data.ok) {
          alert('Aplicado a GPSWOX ✓ Vencimiento: ' + data.expiration_date);
          document.getElementById('wox-box').innerHTML = '<div style="color:#128C7E;font-weight:600;">✅ Aplicado a GPSWOX</div>';
        } else {
          alert('Error: ' + (data.error || 'desconocido'));
          btnAplicar.disabled = false; btnAplicar.innerText = 'Aplicar a GPSWOX';
        }
      } catch (e) {
        alert('Error: ' + e.message);
        btnAplicar.disabled = false; btnAplicar.innerText = 'Aplicar a GPSWOX';
      }
    });
  }
}
</script>
</body>
</html>`;
}

function renderResumen(s) {
  const t = TECNICOS[String(s.tecnico_id)];
  const fotoHtml = s.foto_path ? ('<div class="row"><b>Foto vehículo</b></div><img src="/uploads/servicios/' + s.foto_path + '?token=' + encodeURIComponent(s.token) + '" style="width:100%;border-radius:8px;margin-top:6px;">') : '';
  const fotoGpsHtml = s.foto_gps_path ? ('<div class="row" style="margin-top:14px;"><b>Foto ubicación del GPS</b></div><img src="/uploads/servicios/' + s.foto_gps_path + '?token=' + encodeURIComponent(s.token) + '" style="width:100%;border-radius:8px;margin-top:6px;">') : '';
  const esTrasladoServ = s.trabajo === 'Reinstalación (1 traslado)' || s.trabajo === 'Reinstalación (2 traslados)';
  const personaRecibeHtml = s.persona_recibe_nombre ? (
    '<div class="row"><b>Persona que recibió</b>' + esc(s.persona_recibe_nombre) +
    (s.persona_recibe_telefono ? (' · ' + esc(s.persona_recibe_telefono)) : '') +
    (s.persona_recibe_nota ? (' · ' + esc(s.persona_recibe_nota)) : '') + '</div>'
  ) : '';
  const destinoHtml = esTrasladoServ ? (
    '<div class="row" style="margin-top:10px;"><b>🔺 Vehículo destino</b>' +
    esc(s.vehiculo_destino_marca) + ' ' + esc(s.vehiculo_destino_modelo) + (s.vehiculo_destino_anio ? (' ' + esc(s.vehiculo_destino_anio)) : '') +
    (s.vehiculo_destino_color ? (' (' + esc(s.vehiculo_destino_color) + ')') : '') +
    (s.vehiculo_destino_placa ? (' · Placa: ' + esc(s.vehiculo_destino_placa)) : '') + '</div>'
  ) : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Servicio GPS - Completado</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; padding:16px; }
  .card { background:#fff; border-radius:10px; padding:20px; max-width:480px; margin:0 auto; box-shadow:0 1px 4px rgba(0,0,0,.1); }
  h1 { font-size:20px; margin:0 0 2px; }
  .marca { color:#888; font-size:13px; margin-bottom:14px; }
  .badge { display:inline-block; background:#128C7E; color:#fff; padding:4px 10px; border-radius:12px; font-size:12px; margin-bottom:12px; }
  .row { margin:10px 0; font-size:14px; }
  .row b { display:block; font-size:11px; color:#888; text-transform:uppercase; }
  .logo { display:block; max-width:160px; margin:0 auto 14px; }
  .gps-online { color:#128C7E; font-weight:600; }
  .gps-offline { color:#c53030; font-weight:600; }
</style>
</head>
<body>
<div class="card">
  <img class="logo" src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC Track GPS">
  <h1>✅ Información enviada</h1>
  <div class="marca">DFC Track GPS</div>
  <div class="badge">${esc(s.estado_cierre) || 'Terminado'}</div>
  <div class="row"><b>Código</b>${esc(s.token)}</div>
  <div class="row"><b>Estado GPS</b><span id="gps-estado">📡 Consultando...</span></div>
  <div class="row"><b>Técnico</b>${t ? t.nombre : esc(s.tecnico_nombre)}</div>
  <div class="row"><b>Fecha / Hora</b>${esc(s.fecha)} ${esc(s.hora)}</div>
  <div class="row"><b>Cliente</b>${esc(s.cliente) || '-'}</div>
  <div class="row"><b>Celular</b>${esc(s.celular) || '-'}</div>
  ${personaRecibeHtml}
  <div class="row"><b>Servicio</b>${esc(s.trabajo) || '-'}</div>
  <div class="row"><b>${esTrasladoServ ? '🔻 Vehículo origen' : 'Vehículo'}</b>${esc(s.vehiculo_marca)} ${esc(s.vehiculo_modelo)}</div>
  ${s.color_vehiculo ? ('<div class="row"><b>Color</b>' + esc(s.color_vehiculo) + '</div>') : ''}
  <div class="row"><b>Placa/Chasis</b>${esc(s.placa_chasis) || '-'}</div>
  ${destinoHtml}
  <div class="row"><b>Zona</b>${esc(s.zona_instalacion) || '-'}</div>
  <div class="row"><b>IMEI</b>${esc(s.imei) || '-'}</div>
  ${s.ubicacion_url ? ('<div class="row"><b>Ubicación</b><a href="' + esc(s.ubicacion_url) + '" target="_blank">' + esc(s.ubicacion_url) + '</a></div>') : ''}
  ${s.nota ? ('<div class="row"><b>Nota</b>' + esc(s.nota) + '</div>') : ''}
  ${fotoHtml}
  ${fotoGpsHtml}
</div>
<script>
(async function() {
  const el = document.getElementById('gps-estado');
  const imei = ${JSON.stringify(s.imei || '')};
  if (!imei) { el.innerHTML = '-'; return; }
  try {
    const r = await fetch('/api/servicio/estado?imei=' + encodeURIComponent(imei));
    const d = await r.json();
    if (d.online) {
      el.innerHTML = '<span class="gps-online">🟢 Online</span> (hace ' + (d.minutos_offline||0) + ' min)';
    } else if (d.minutos_offline !== undefined && d.minutos_offline !== null) {
      el.innerHTML = '<span class="gps-offline">🔴 Offline</span> (hace ' + Math.floor(d.minutos_offline/60) + 'h)';
    } else {
      el.innerHTML = '<span class="gps-offline">🔴 Sin señal registrada</span>';
    }
  } catch(e) {
    el.innerHTML = 'No disponible';
  }
})();
</script>
</body>
</html>`;
}

function renderNuevo() {
  const opciones = Object.entries(TECNICOS).map(([id, t]) => '<option value="' + id + '">' + t.nombre + '</option>').join('');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nuevo Servicio</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; padding:16px; }
  .card { background:#fff; border-radius:10px; padding:20px; max-width:480px; margin:0 auto; box-shadow:0 1px 4px rgba(0,0,0,.1); }
  h1 { font-size:20px; margin:0 0 16px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
  input, select, textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:6px; font-size:15px; font-family:inherit; }
  button { width:100%; margin-top:22px; padding:14px; background:#128C7E; color:#fff; border:none; border-radius:8px; font-size:16px; font-weight:600; }
  #resultado { margin-top:16px; padding:12px; background:#eafaf3; border-radius:8px; font-size:14px; display:none; word-break:break-all; white-space:pre-wrap; }
  .logo { display:block; max-width:160px; margin:0 auto 14px; }
</style>
</head>
<body>
<div class="card">
  <img class="logo" src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC Track GPS">
  <h1>➕ Nuevo Servicio</h1>
  <label>Técnico</label>
  <select id="tecnico_id">${opciones}</select>
  <label>Cliente</label>
  <input type="text" id="cliente">
  <label>Celular</label>
  <input type="tel" id="celular">
  <label>Servicio a realizar</label>
  <select id="trabajo">
    <option value="Instalación">Instalación</option>
    <option value="Desinstalación">Desinstalación</option>
    <option value="Mantenimiento">Mantenimiento</option>
    <option value="Reinstalación (1 traslado)">Reinstalación (1 traslado)</option>
    <option value="Reinstalación (2 traslados)">Reinstalación (2 traslados)</option>
  </select>
  <label>Vehículo (marca / modelo)</label>
  <input type="text" id="vehiculo_marca" placeholder="Marca">
  <input type="text" id="vehiculo_modelo" placeholder="Modelo" style="margin-top:6px">
  <label>Zona instalación</label>
  <input type="text" id="zona_instalacion">
  <label>Ubicación (link de Google Maps)</label>
  <input type="url" id="ubicacion_url" placeholder="Ubicación del cliente">
  <label>Nota</label>
  <textarea id="nota" rows="2" placeholder="Notas importantes, observaciones (check-in, luces tablero, etc.)"></textarea>
  <button id="btn-crear">Crear y enviar al técnico</button>
  <div id="resultado"></div>
</div>
<script>
const CLAVE = new URLSearchParams(location.search).get('clave') || '';
document.getElementById('btn-crear').addEventListener('click', async () => {
  const body = {
    tecnico_id: document.getElementById('tecnico_id').value,
    cliente: document.getElementById('cliente').value,
    celular: document.getElementById('celular').value,
    trabajo: document.getElementById('trabajo').value,
    vehiculo_marca: document.getElementById('vehiculo_marca').value,
    vehiculo_modelo: document.getElementById('vehiculo_modelo').value,
    zona_instalacion: document.getElementById('zona_instalacion').value,
    ubicacion_url: document.getElementById('ubicacion_url').value,
    nota: document.getElementById('nota').value
  };
  const r = await fetch('/api/servicio/crear?clave=' + encodeURIComponent(CLAVE), {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await r.json();
  const div = document.getElementById('resultado');
  div.style.display = 'block';
  if (data.ok) {
    div.innerText = 'Creado y enviado al técnico:\\n' + data.link;
  } else {
    div.innerText = 'Error: ' + (data.error || 'desconocido');
  }
});
</script>
</body>
</html>`;
}

function renderBuscar() {
  const opciones = Object.entries(TECNICOS).map(([id, t]) => '<option value="' + id + '">' + t.nombre + '</option>').join('');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Servicios GPS</title>
<link rel="manifest" href="/buscar/manifest.json">
<link rel="apple-touch-icon" href="/buscar/apple-touch-icon.png">
<meta name="theme-color" content="#128C7E">
<style>
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; padding:16px; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:20px; margin-bottom:14px; }
  input, select, textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:6px; font-size:15px; font-family:inherit; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; }
  th, td { padding:8px 10px; font-size:13px; text-align:left; border-bottom:1px solid #eee; }
  th { background:#f7f7f7; }
  .estado-terminado { color:#128C7E; font-weight:600; }
  .estado-asignado, .estado-en_progreso { color:#c77700; font-weight:600; }
  a { color:#128C7E; text-decoration:none; }
  .btn { display:inline-block; padding:10px 16px; background:#128C7E; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  .card { background:#fff; border-radius:8px; padding:16px; margin-bottom:20px; display:none; }
  .row2 { display:flex; gap:10px; }
  .row2 > div { flex:1; }
  #resultado-nuevo { margin-top:10px; padding:10px; background:#eafaf3; border-radius:6px; font-size:13px; display:none; word-break:break-all; white-space:pre-wrap; }
  .logo { display:block; max-width:160px; margin:0 auto 14px; }
  .fecha-header { font-size:15px; font-weight:700; margin:18px 0 8px; padding:8px 12px; border-radius:6px; background:#e8f5f1; color:#128C7E; }
  .fecha-header.hoy { background:#128C7E; color:#fff; }
</style>
</head>
<body>
<div class="wrap">
  <img class="logo" src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC Track GPS">
  <h1>🛠 Servicios GPS</h1>
  <div id="inventario-tecnicos" style="background:#fff;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">Cargando inventario...</div>
  <button class="btn" id="btn-toggle-nuevo" style="margin-bottom:20px;">➕ Nuevo Servicio</button>
  <button class="btn" id="btn-limpiar" style="margin-bottom:20px; margin-left:8px; background:#888;">🧹 Limpiar</button>
  <a href="/servicio/login?logout=1" style="display:inline-block; margin-bottom:20px; margin-left:8px; padding:10px 16px; background:#c53030; color:#fff; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none;">🚪 Cerrar sesión</a>

  <div class="card" id="card-nuevo">
    <label>Técnico</label>
    <select id="n-tecnico_id">${opciones}</select>
    <label>Cliente</label>
    <input type="text" id="n-cliente">
    <label>Celular</label>
    <div style="display:flex;gap:8px;">
      <input type="tel" id="n-celular" style="flex:1;">
      <button type="button" class="btn" id="btn-sincronizar-wox" style="width:auto;padding:10px 14px;background:#0b76ef;">🔄 Sincronizar</button>
    </div>
    <div id="n-sync-wox-resultado" style="font-size:12px;margin-top:4px;"></div>
    <label>Servicio a realizar</label>
    <select id="n-trabajo">
      <option value="Instalación">Instalación</option>
      <option value="Desinstalación">Desinstalación</option>
      <option value="Mantenimiento">Mantenimiento</option>
      <option value="Reinstalación (1 traslado)">Reinstalación (1 traslado)</option>
      <option value="Reinstalación (2 traslados)">Reinstalación (2 traslados)</option>
    </select>
    <div class="row2">
      <div><label>Fecha de la cita</label><input type="date" id="n-fecha"></div>
      <div><label>Hora de la cita</label><input type="time" id="n-hora"></div>
    </div>
    <div id="fila-cantidad-vehiculos" style="display:none;">
      <label>Cantidad de vehículos</label>
      <select id="n-cantidad-vehiculos">
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
        <option value="6">6</option>
        <option value="7">7</option>
        <option value="8">8</option>
        <option value="9">9</option>
        <option value="10">10</option>
      </select>
    </div>
    <div id="campos-vehiculo-manual">
      <label>Agregar vehículo</label>
      <div class="row2">
        <div><label>Vehículo (marca)</label><input type="text" id="n-manual-marca"></div>
        <div><label>Modelo</label><input type="text" id="n-manual-modelo"></div>
      </div>
      <div class="row2">
        <div><label>Color</label><input type="text" id="n-manual-color"></div>
        <div><label>IMEI</label><input type="text" id="n-manual-imei"></div>
      </div>
      <button type="button" class="btn" id="btn-agregar-manual" style="width:auto;padding:8px 16px;background:#0b76ef;">➕ Agregar vehículo</button>
      <div id="n-manual-seleccionados" style="margin-top:10px;"></div>
      <label>Zona de instalación</label>
      <input type="text" id="n-zona_instalacion">
    </div>
    <div id="campos-vehiculo-wox" style="display:none;">
      <label>Buscar cliente en GPSWOX (IMEI, correo, telefono o nombre del vehiculo)</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="n-wox-buscar" placeholder="IMEI, correo, telefono o nombre" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();buscarClienteWoxServicio();}">
        <button type="button" class="btn" style="width:auto;padding:10px 16px;" onclick="buscarClienteWoxServicio()">Buscar</button>
      </div>
      <div id="n-wox-resultados" style="margin-top:8px;"></div>
      <div id="n-wox-seleccionados" style="margin-top:10px;"></div>
    </div>
    <div id="n-bloque-destino" style="display:none;margin-top:14px;padding-top:14px;border-top:2px solid #eee;">
      <div style="font-size:12px;font-weight:700;color:#128C7E;text-transform:uppercase;">🔺 Vehículo destino (opcional aquí, lo puede completar el técnico después)</div>
      <div class="row2">
        <div><label>Vehículo (marca)</label><input type="text" id="n-destino-marca"></div>
        <div><label>Modelo</label><input type="text" id="n-destino-modelo"></div>
      </div>
      <div class="row2">
        <div><label>Año</label><input type="text" id="n-destino-anio"></div>
        <div><label>Color</label><input type="text" id="n-destino-color"></div>
      </div>
      <label>Placa</label>
      <input type="text" id="n-destino-placa">
    </div>
    <label>Ubicación (link de Google Maps)</label>
    <input type="url" id="n-ubicacion_url" placeholder="Ubicación del cliente">
    <label>Nota</label>
    <textarea id="n-nota" rows="2" placeholder="Notas importantes, observaciones (check-in, luces tablero, etc.)"></textarea>
    <button class="btn" id="btn-crear" style="width:100%;">Crear y enviar al técnico</button>
    <div id="resultado-nuevo"></div>
  </div>

  <input type="text" id="q" placeholder="Buscar por cliente, celular, IMEI, técnico, placa, código...">
  <div style="display:flex; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
    <select id="f-estado" style="width:auto; flex:1; min-width:140px; margin-bottom:0;">
      <option value="">Todos los estados</option>
      <option value="asignado">Asignado</option>
      <option value="en_progreso">En progreso</option>
      <option value="terminado">Terminado</option>
    </select>
    <input type="date" id="f-fecha" style="width:auto; flex:1; min-width:140px; margin-bottom:0;">
    <select id="f-pago" style="width:auto; flex:1; min-width:140px; margin-bottom:0;">
      <option value="">Pago técnico: Todos</option>
      <option value="pendiente">Pago técnico: Pendiente</option>
      <option value="pagado">Pago técnico: Pagado</option>
    </select>
    <select id="f-alegra" style="width:auto; flex:1; min-width:140px; margin-bottom:0;">
      <option value="">Alegra: Todos</option>
      <option value="sin_facturar">Sin facturar</option>
      <option value="facturado">Facturado</option>
    </select>
  </div>
  <div id="resultados">Escribe para buscar, o crea un servicio nuevo arriba.</div>
</div>
<script>
const CLAVE = new URLSearchParams(location.search).get('clave') || '';
document.getElementById('n-fecha').value = new Date().toISOString().slice(0,10);
let VEHICULOS_WOX_SELECCIONADOS = [];
let VEHICULOS_MANUAL_SELECCIONADOS = [];
let ULTIMA_BUSQUEDA_WOX = [];
let SYNC_WOX_USER_ID = null;
let SYNC_WOX_CORREO = null;
let SYNC_WOX_ESTADO = null;
async function sincronizarClienteWox() {
  const celular = document.getElementById('n-celular').value.trim();
  const cont = document.getElementById('n-sync-wox-resultado');
  SYNC_WOX_USER_ID = null; SYNC_WOX_CORREO = null; SYNC_WOX_ESTADO = null;
  if (!celular) { cont.innerHTML = '<span style="color:#c53030;">Escribe el celular primero.</span>'; return; }
  cont.innerHTML = 'Sincronizando...';
  try {
    const r = await fetch('/api/servicio/buscar-cliente?celular=' + encodeURIComponent(celular) + '&clave=' + encodeURIComponent(CLAVE));
    const data = await r.json();
    if (data.matches && data.matches.length === 1) {
      SYNC_WOX_USER_ID = data.matches[0].id;
      SYNC_WOX_CORREO = data.matches[0].email;
      SYNC_WOX_ESTADO = 'encontrado';
      cont.innerHTML = '<span style="color:#128C7E;">✅ Cliente existente en WOX — ' + escHtmlServicio(SYNC_WOX_CORREO) + '</span>';
    } else if (data.matches && data.matches.length > 1) {
      SYNC_WOX_ESTADO = 'ambiguo';
      cont.innerHTML = '<span style="color:#f5a623;">⚠️ Varias coincidencias por ese celular (' + data.matches.length + ') — se enlazará manualmente al aplicar a GPSWOX.</span>';
    } else {
      SYNC_WOX_ESTADO = 'nuevo';
      cont.innerHTML = '<span style="color:#888;">🆕 Cliente nuevo — no encontrado en WOX.</span>';
    }
  } catch (e) {
    cont.innerHTML = '<span style="color:#c53030;">Error sincronizando.</span>';
  }
}
document.getElementById('btn-sincronizar-wox').addEventListener('click', sincronizarClienteWox);
function escHtmlServicio(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function esTrasladoServicio(trabajo) {
  return trabajo === 'Reinstalación (1 traslado)' || trabajo === 'Reinstalación (2 traslados)';
}
function actualizarModoTrabajoServicio() {
  const trabajo = document.getElementById('n-trabajo').value;
  const manual = document.getElementById('campos-vehiculo-manual');
  const wox = document.getElementById('campos-vehiculo-wox');
  const cantidadFila = document.getElementById('fila-cantidad-vehiculos');
  const bloqueDestino = document.getElementById('n-bloque-destino');
  cantidadFila.style.display = trabajo ? 'block' : 'none';
  if (trabajo === 'Mantenimiento' || trabajo === 'Desinstalación' || trabajo === 'Reinstalación (1 traslado)' || trabajo === 'Reinstalación (2 traslados)') {
    manual.style.display = 'none';
    wox.style.display = 'block';
  } else {
    manual.style.display = 'block';
    wox.style.display = 'none';
  }
  bloqueDestino.style.display = esTrasladoServicio(trabajo) ? 'block' : 'none';
}
document.getElementById('n-trabajo').addEventListener('change', actualizarModoTrabajoServicio);
async function buscarClienteWoxServicio() {
  const q = document.getElementById('n-wox-buscar').value.trim();
  const cont = document.getElementById('n-wox-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  cont.innerHTML = 'Buscando...';
  try {
    const r = await fetch('/api/servicio/buscar-cliente-wox?q=' + encodeURIComponent(q));
    const data = await r.json();
    if (!data.ok || !data.vehiculos.length) { cont.innerHTML = '<div style="font-size:12px;color:#888;">Sin resultados.</div>'; return; }
    ULTIMA_BUSQUEDA_WOX = data.vehiculos;
    cont.innerHTML = ULTIMA_BUSQUEDA_WOX.map(function(v, idx) {
      const yaEsta = VEHICULOS_WOX_SELECCIONADOS.some(function(s){ return s.imei === v.imei; });
      return '<div style="padding:8px;border:1px solid #eee;border-radius:6px;margin-top:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span style="font-size:13px;"><b>' + escHtmlServicio(v.name||'-') + '</b><br><span style="color:#888;">' + escHtmlServicio(v.email||'-') + ' &middot; IMEI: ' + escHtmlServicio(v.imei) + (v.object_owner ? (' &middot; ' + escHtmlServicio(v.object_owner)) : '') + '</span></span>' +
        '<button type="button" class="btn" style="width:auto;padding:6px 12px;' + (yaEsta ? 'background:#888;' : '') + '" onclick="agregarVehiculoWoxIdx(' + idx + ')">' + (yaEsta ? 'Agregado' : 'Agregar') + '</button>' +
        '</div>';
    }).join('');
  } catch(e) {
    cont.innerHTML = '<div style="font-size:12px;color:#c53030;">Error buscando.</div>';
  }
}
function agregarVehiculoWoxIdx(idx) {
  const v = ULTIMA_BUSQUEDA_WOX[idx];
  if (!v) return;
  if (VEHICULOS_WOX_SELECCIONADOS.some(function(s){ return s.imei === v.imei; })) return;
  VEHICULOS_WOX_SELECCIONADOS.push(v);
  renderSeleccionadosWox();
  buscarClienteWoxServicio();
}
function quitarVehiculoWox(imei) {
  VEHICULOS_WOX_SELECCIONADOS = VEHICULOS_WOX_SELECCIONADOS.filter(function(s){ return s.imei !== imei; });
  renderSeleccionadosWox();
}
function renderSeleccionadosWox() {
  const cont = document.getElementById('n-wox-seleccionados');
  if (!VEHICULOS_WOX_SELECCIONADOS.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = '<b style="font-size:13px;">Vehiculos seleccionados (' + VEHICULOS_WOX_SELECCIONADOS.length + '):</b>' +
    VEHICULOS_WOX_SELECCIONADOS.map(function(v) {
      return '<div style="padding:6px 10px;background:#eafaf3;border-radius:6px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;font-size:13px;">' +
        '<span>' + escHtmlServicio(v.name||v.imei) + ' &middot; IMEI: ' + escHtmlServicio(String(v.imei||'').slice(-6)) + (v.object_owner ? (' &middot; ' + escHtmlServicio(v.object_owner)) : '') + '</span>' +
        '<button type="button" onclick="quitarVehiculoWox(&#39;' + v.imei + '&#39;)" style="border:none;background:none;color:#c53030;cursor:pointer;font-weight:600;">Quitar</button>' +
        '</div>';
    }).join('');
}
function renderSeleccionadosManual() {
  const cont = document.getElementById('n-manual-seleccionados');
  if (!VEHICULOS_MANUAL_SELECCIONADOS.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = '<b style="font-size:13px;">Vehiculos agregados (' + VEHICULOS_MANUAL_SELECCIONADOS.length + '):</b>' +
    VEHICULOS_MANUAL_SELECCIONADOS.map(function(v, idx) {
      return '<div style="padding:6px 10px;background:#eafaf3;border-radius:6px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;font-size:13px;">' +
        '<span>' + escHtmlServicio(v.marca||'') + ' ' + escHtmlServicio(v.modelo||'') + (v.color ? (' &middot; ' + escHtmlServicio(v.color)) : '') + (v.imei ? (' &middot; IMEI: ' + escHtmlServicio(String(v.imei).slice(-6))) : '') + '</span>' +
        '<button type="button" onclick="quitarVehiculoManual(' + idx + ')" style="border:none;background:none;color:#c53030;cursor:pointer;font-weight:600;">Quitar</button>' +
        '</div>';
    }).join('');
}
function quitarVehiculoManual(idx) {
  VEHICULOS_MANUAL_SELECCIONADOS.splice(idx, 1);
  renderSeleccionadosManual();
}
document.getElementById('btn-agregar-manual').addEventListener('click', function() {
  const cant = parseInt(document.getElementById('n-cantidad-vehiculos').value, 10) || 1;
  if (VEHICULOS_MANUAL_SELECCIONADOS.length >= cant) {
    alert('Ya agregaste los ' + cant + ' vehiculos indicados. Sube la cantidad si necesitas agregar mas.');
    return;
  }
  const marca = document.getElementById('n-manual-marca').value.trim();
  if (!marca) { alert('Escribe al menos la marca del vehiculo.'); return; }
  VEHICULOS_MANUAL_SELECCIONADOS.push({
    marca: marca,
    modelo: document.getElementById('n-manual-modelo').value.trim(),
    color: document.getElementById('n-manual-color').value.trim(),
    imei: document.getElementById('n-manual-imei').value.trim()
  });
  document.getElementById('n-manual-marca').value = '';
  document.getElementById('n-manual-modelo').value = '';
  document.getElementById('n-manual-color').value = '';
  document.getElementById('n-manual-imei').value = '';
  renderSeleccionadosManual();
});
fetch('/api/servicio/inventario').then(r => r.json()).then(data => {
  const cont = document.getElementById('inventario-tecnicos');
  if (!Array.isArray(data) || !data.length) { cont.textContent = 'Sin datos de inventario.'; return; }
  cont.innerHTML = '<b style="color:#128C7E;">\ud83d\udce6 Inventario por tecnico:</b>' + data.map(t =>
    '<span style="background:#eef6ff;padding:4px 10px;border-radius:14px;">' + t.nombre + ' <b>(' + t.total + ')</b></span>'
  ).join('');
}).catch(() => { document.getElementById('inventario-tecnicos').textContent = 'No se pudo cargar el inventario.'; });

document.getElementById('btn-toggle-nuevo').addEventListener('click', () => {
  const c = document.getElementById('card-nuevo');
  c.style.display = (c.style.display === 'block') ? 'none' : 'block';
});

function limpiarCampos() {
  document.getElementById('n-tecnico_id').selectedIndex = 0;
  document.getElementById('n-cliente').value = '';
  document.getElementById('n-celular').value = '';
  document.getElementById('n-trabajo').selectedIndex = 0;
  document.getElementById('n-cantidad-vehiculos').selectedIndex = 0;
  document.getElementById('n-fecha').value = new Date().toISOString().slice(0,10);
  document.getElementById('n-hora').value = '';
  document.getElementById('n-manual-marca').value = '';
  document.getElementById('n-manual-modelo').value = '';
  document.getElementById('n-manual-color').value = '';
  document.getElementById('n-manual-imei').value = '';
  document.getElementById('n-zona_instalacion').value = '';
  document.getElementById('n-ubicacion_url').value = '';
  document.getElementById('n-nota').value = '';
  document.getElementById('n-wox-buscar').value = '';
  document.getElementById('n-wox-resultados').innerHTML = '';
  document.getElementById('n-destino-marca').value = '';
  document.getElementById('n-destino-modelo').value = '';
  document.getElementById('n-destino-color').value = '';
  document.getElementById('n-destino-placa').value = '';
  document.getElementById('n-destino-anio').value = '';
  VEHICULOS_WOX_SELECCIONADOS = [];
  VEHICULOS_MANUAL_SELECCIONADOS = [];
  renderSeleccionadosWox();
  renderSeleccionadosManual();
  actualizarModoTrabajoServicio();
}
function limpiarFormulario() {
  limpiarCampos();
  SYNC_WOX_USER_ID = null; SYNC_WOX_CORREO = null; SYNC_WOX_ESTADO = null;
  const syncCont = document.getElementById('n-sync-wox-resultado'); if (syncCont) syncCont.innerHTML = '';
  const div = document.getElementById('resultado-nuevo');
  div.style.display = 'none';
  div.innerText = '';
}
document.getElementById('btn-limpiar').addEventListener('click', limpiarFormulario);

document.getElementById('btn-crear').addEventListener('click', async () => {
  const trabajoVal = document.getElementById('n-trabajo').value;
  const esWox = (trabajoVal === 'Mantenimiento' || trabajoVal === 'Desinstalación' || trabajoVal === 'Reinstalación (1 traslado)' || trabajoVal === 'Reinstalación (2 traslados)');
  const esManualMulti = (trabajoVal === 'Instalación');
  const cantidadVehiculos = parseInt(document.getElementById('n-cantidad-vehiculos').value, 10) || 1;
  if (esWox && VEHICULOS_WOX_SELECCIONADOS.length !== cantidadVehiculos) {
    alert('Agregaste ' + VEHICULOS_WOX_SELECCIONADOS.length + ' de ' + cantidadVehiculos + ' vehiculos indicados.');
    return;
  }
  if (esManualMulti && VEHICULOS_MANUAL_SELECCIONADOS.length !== cantidadVehiculos) {
    alert('Agregaste ' + VEHICULOS_MANUAL_SELECCIONADOS.length + ' de ' + cantidadVehiculos + ' vehiculos indicados.');
    return;
  }
  const esTraslado = esTrasladoServicio(trabajoVal);
  const body = {
    tecnico_id: document.getElementById('n-tecnico_id').value,
    cliente: document.getElementById('n-cliente').value,
    celular: document.getElementById('n-celular').value,
    wox_user_id: SYNC_WOX_USER_ID,
    wox_correo: SYNC_WOX_CORREO,
    wox_sync_estado: SYNC_WOX_ESTADO,
    trabajo: trabajoVal,
    fecha: document.getElementById('n-fecha').value,
    hora: document.getElementById('n-hora').value,
    zona_instalacion: document.getElementById('n-zona_instalacion').value,
    ubicacion_url: document.getElementById('n-ubicacion_url').value,
    nota: document.getElementById('n-nota').value,
    vehiculos: esWox ? VEHICULOS_WOX_SELECCIONADOS : (esManualMulti ? VEHICULOS_MANUAL_SELECCIONADOS : []),
    vehiculo_destino_marca: esTraslado ? document.getElementById('n-destino-marca').value : undefined,
    vehiculo_destino_modelo: esTraslado ? document.getElementById('n-destino-modelo').value : undefined,
    vehiculo_destino_color: esTraslado ? document.getElementById('n-destino-color').value : undefined,
    vehiculo_destino_placa: esTraslado ? document.getElementById('n-destino-placa').value : undefined,
    vehiculo_destino_anio: esTraslado ? document.getElementById('n-destino-anio').value : undefined
  };
  const r = await fetch('/api/servicio/crear?clave=' + encodeURIComponent(CLAVE), {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await r.json();
  const div = document.getElementById('resultado-nuevo');
  div.style.display = 'block';
  if (data.ok) {
    div.innerText = 'Creado y enviado al técnico:\\n' + data.link;
    limpiarCampos();
    buscar();
  } else {
    div.innerText = 'Error: ' + (data.error || 'desconocido');
  }
});

let timer;
document.getElementById('q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(buscar, 350);
});

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function fechaKey(d) {
  var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function etiquetaFecha(key) {
  var hoy = new Date();
  var ayer = new Date();
  ayer.setDate(hoy.getDate() - 1);
  if (key === fechaKey(hoy)) return '🟢 Hoy';
  if (key === fechaKey(ayer)) return '🕗 Ayer';
  var partes = key.split('-');
  if (partes.length === 3) {
    var dia = parseInt(partes[2], 10);
    var mes = MESES[parseInt(partes[1], 10) - 1] || '';
    return dia + ' de ' + mes + ' ' + partes[0];
  }
  return key || 'Sin fecha';
}

async function buscar() {
  const q = document.getElementById('q').value.trim();
  const div = document.getElementById('resultados');
  div.innerHTML = 'Buscando...';
  const r = await fetch('/api/servicio/buscar?clave=' + encodeURIComponent(CLAVE) + '&q=' + encodeURIComponent(q));
  let data = await r.json();
  const fEstado = document.getElementById('f-estado').value;
  const fFecha = document.getElementById('f-fecha').value;
  const fPago = document.getElementById('f-pago').value;
  if (fEstado) data = data.filter(function(s) { return s.estado === fEstado; });
  if (fFecha) data = data.filter(function(s) { return s.fecha && String(s.fecha).slice(0,10) === fFecha; });
  if (fPago) data = data.filter(function(s) { return (s.pago_tecnico || 'pendiente') === fPago; });
  const fAlegra = document.getElementById('f-alegra').value;
  if (fAlegra === 'sin_facturar') data = data.filter(function(s) { return !s.alegra_invoice_id; });
  if (fAlegra === 'facturado') data = data.filter(function(s) { return !!s.alegra_invoice_id; });
  if (!data.length) { div.innerHTML = 'Sin resultados.'; return; }

  var grupos = {};
  var orden = [];
  for (var i = 0; i < data.length; i++) {
    var s = data[i];
    var key = (s.fecha || '').substring(0, 10);
    if (!grupos[key]) { grupos[key] = []; orden.push(key); }
    grupos[key].push(s);
  }
  orden.sort(function(a, b) { return a < b ? 1 : (a > b ? -1 : 0); });

  var html = '';
  for (var g = 0; g < orden.length; g++) {
    var key = orden[g];
    var grupo = grupos[key];
    var esHoy = key === fechaKey(new Date());
    html += '<div class="fecha-header' + (esHoy ? ' hoy' : '') + '">' + etiquetaFecha(key) + ' · ' + grupo.length + ' servicio' + (grupo.length === 1 ? '' : 's') + '</div>';
    html += '<table><thead><tr><th>Técnico</th><th>Cliente</th><th>Servicio</th><th>IMEI</th><th>Estado</th><th>Visto</th><th>Pago técnico</th><th>Alegra</th><th></th><th></th><th></th></tr></thead><tbody>';
    for (var j = 0; j < grupo.length; j++) {
      var s = grupo[j];
      html += '<tr>';
      html += '<td>' + (s.tecnico_nombre||'') + '</td>';
      html += '<td>' + (s.cliente||'') + '</td>';
      html += '<td>' + (s.trabajo||'') + '</td>';
      html += '<td>' + (s.imei||'') + '</td>';
      html += '<td class="estado-' + s.estado + '">' + s.estado + (s.estado_cierre ? (' - ' + s.estado_cierre) : '') + '</td>';
      html += '<td>' + (s.visto ? ('👁 Visto (' + (s.visto_at||'') + ')') : '— No visto') + '</td>';
      html += '<td style="padding-left:14px; padding-right:14px;"><select class="sel-pago-tecnico" data-id="' + s.id + '" style="font-size:12px; font-weight:600; padding:5px 14px; min-width:110px; border-radius:4px; border:none; color:#fff; background:' + (s.pago_tecnico==='pagado' ? '#128C7E' : '#c53030') + ';"><option value="pendiente" ' + (s.pago_tecnico!=='pagado'?'selected':'') + '>Pendiente</option><option value="pagado" ' + (s.pago_tecnico==='pagado'?'selected':'') + '>Pagado</option></select> <span class="pago-guardado" style="font-size:11px; color:#128C7E; display:none;">✓ Guardado</span></td>';
      html += '<td class="celda-alegra" data-id="' + s.id + '">' + (s.alegra_invoice_number ? ('<a href="https://app.alegra.com/invoice/view/id/' + s.alegra_invoice_id + '" target="_blank">#' + s.alegra_invoice_number + '</a> · ' + (s.alegra_pago === 'pagada' ? '<span style="color:#128C7E;font-weight:600;">Pagada</span>' : (s.alegra_pago === 'pendiente' ? '<span style="color:#c77700;font-weight:600;">Pendiente</span>' : '?'))) : (s.estado === 'terminado' ? ('Sin facturar <button type="button" class="btn-crear-alegra-fila" data-id="' + s.id + '" style="font-size:11px; padding:4px 8px; background:#f0932b; color:#fff; border:none; border-radius:4px; cursor:pointer; margin-left:4px;">🧾 Crear</button>') : 'Sin facturar')) + '</td>';
      html += '<td><a href="/servicio?token=' + s.token + '" target="_blank">Abrir</a></td>';
      html += '<td><a href="/servicio?token=' + s.token + '&admin=' + encodeURIComponent(CLAVE) + '" target="_blank">✏️ Editar</a></td>';
      html += '<td><a href="#" class="btn-eliminar" data-token="' + s.token + '" style="color:#c53030;">🗑️ Eliminar</a></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  div.innerHTML = html;
}
document.getElementById('resultados').addEventListener('click', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('btn-eliminar')) {
    e.preventDefault();
    eliminarServicio(e.target.getAttribute('data-token'));
  } else if (e.target && e.target.classList && e.target.classList.contains('btn-crear-alegra-fila')) {
    crearAlegraDesdeLista(e.target, false);
  }
});
async function crearAlegraDesdeLista(btn, forzar) {
  const id = btn.getAttribute('data-id');
  btn.disabled = true;
  const textoOriginal = btn.innerText;
  btn.innerText = 'Facturando...';
  try {
    const r = await fetch('/api/servicio/crear-alegra?clave=' + encodeURIComponent(CLAVE), {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: id, forzar: !!forzar })
    });
    const data = await r.json();
    if (data.ok) {
      const celda = btn.closest('.celda-alegra');
      celda.innerHTML = '<a href="https://app.alegra.com/invoice/view/id/' + (data.facturaId||'') + '" target="_blank">#' + (data.numero||data.facturaId) + '</a> · <span style="color:#c77700;font-weight:600;">Pendiente</span>';
    } else if (data.requiereConfirmacion) {
      if (confirm(data.error + ' ¿Facturar de todas formas?')) {
        await crearAlegraDesdeLista(btn, true);
      } else {
        btn.disabled = false; btn.innerText = textoOriginal;
      }
    } else {
      btn.disabled = false; btn.innerText = textoOriginal;
      alert('Error: ' + (data.error || 'desconocido'));
    }
  } catch (eAlegra) {
    btn.disabled = false; btn.innerText = textoOriginal;
    alert('Error de conexión al facturar.');
  }
}
document.getElementById('resultados').addEventListener('change', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('sel-pago-tecnico')) {
    const id = e.target.getAttribute('data-id');
    const valor = e.target.value;
    e.target.style.background = (valor === 'pagado') ? '#128C7E' : '#c53030';
    const check = e.target.nextElementSibling;
    fetch('/api/servicio/pago-tecnico?clave=' + encodeURIComponent(CLAVE), {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: id, pago_tecnico: valor })
    }).then(r => r.json()).then(d => {
      if (d.ok) {
        if (check) { check.style.display = 'inline'; setTimeout(function(){ check.style.display = 'none'; }, 1500); }
      } else {
        alert('Error guardando pago: ' + (d.error||''));
      }
    });
  }
});
async function eliminarServicio(token) {
  if (!confirm('¿Eliminar este servicio? No se puede deshacer.')) return;
  const r = await fetch('/api/servicio/eliminar?clave=' + encodeURIComponent(CLAVE) + '&token=' + encodeURIComponent(token), { method: 'POST' });
  const data = await r.json();
  if (data.ok) { buscar(); } else { alert('Error: ' + (data.error || 'desconocido')); }
}
document.getElementById('f-estado').addEventListener('change', buscar);
document.getElementById('f-fecha').addEventListener('change', buscar);
document.getElementById('f-pago').addEventListener('change', buscar);
document.getElementById('f-alegra').addEventListener('change', buscar);
buscar();
</script>
</body>
</html>`;
}

function renderLogin() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceso Servicio GPS</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; padding:16px; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .card { background:#fff; border-radius:10px; padding:24px; max-width:360px; width:100%; box-shadow:0 1px 4px rgba(0,0,0,.1); }
  h1 { font-size:18px; margin:0 0 16px; text-align:center; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:6px; font-size:15px; }
  button { width:100%; margin-top:18px; padding:12px; background:#128C7E; color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; }
  .logo { display:block; max-width:150px; margin:0 auto 14px; }
  #err { color:#c53030; font-size:13px; text-align:center; margin-top:10px; display:none; }
</style>
</head>
<body>
<div class="card">
  <img class="logo" src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC Track GPS">
  <h1>Acceso Servicio Tecnico</h1>
  <label>Usuario</label>
  <input type="text" id="usuario" autocomplete="username">
  <label>Contrasena</label>
  <input type="password" id="password" autocomplete="current-password">
  <button id="btn-login">Entrar</button>
  <div id="err">Usuario o contrasena incorrectos.</div>
</div>
<script>
async function intentarLogin() {
  const usuario = document.getElementById('usuario').value;
  const password = document.getElementById('password').value;
  const err = document.getElementById('err');
  err.style.display = 'none';
  const r = await fetch('/servicio/login', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ usuario, password })
  });
  const data = await r.json();
  if (data.ok) {
    location.href = data.redirect;
  } else {
    err.style.display = 'block';
  }
}
document.getElementById('btn-login').addEventListener('click', intentarLogin);
document.getElementById('password').addEventListener('keydown', function(e) { if (e.key === 'Enter') intentarLogin(); });
</script>
</body>
</html>`;
}
module.exports = function servicioHandler(req, res, sock) {
  const parsed = url.parse(req.url, true);

  if (req.method === 'GET' && parsed.pathname === '/servicio/login') {
    if (parsed.query.logout === '1') {
      destruirSesion(idSesion(req));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'dfc_sesion=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/'
      });
      return res.end(renderLogin());
    }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(renderLogin());
  }
  if (req.method === 'POST' && parsed.pathname === '/servicio/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      const claveOk = ADMIN_PASS_HASH && data.usuario === ADMIN_USER && bcrypt.compareSync(String(data.password || ''), ADMIN_PASS_HASH);
      if (claveOk) {
        const sid = crearSesion();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'dfc_sesion=' + sid + '; HttpOnly; Secure; SameSite=Lax; Max-Age=' + (SESION_DURACION_MS / 1000) + '; Path=/'
        });
        return res.end(JSON.stringify({ ok: true, redirect: '/buscar?clave=' + encodeURIComponent(CLAVE_NUEVO) }));
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ ok: false }));
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/buscar/manifest.json') {
    try {
      const data = fs.readFileSync('/opt/baileys-servicio/public-icons/manifest.json');
      res.writeHead(200, {'Content-Type': 'application/manifest+json'});
      return res.end(data);
    } catch (e) {
      res.writeHead(404);
      return res.end('No encontrado');
    }
  }
  if (req.method === 'GET' && (parsed.pathname === '/buscar/icon-192.png' || parsed.pathname === '/buscar/icon-512.png' || parsed.pathname === '/buscar/apple-touch-icon.png')) {
    try {
      const nombre = parsed.pathname.split('/').pop();
      const data = fs.readFileSync('/opt/baileys-servicio/public-icons/' + nombre);
      res.writeHead(200, {'Content-Type': 'image/png'});
      return res.end(data);
    } catch (e) {
      res.writeHead(404);
      return res.end('No encontrado');
    }
  }
  if (req.method === 'GET' && parsed.pathname === '/nuevo') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403); return res.end('No autorizado'); }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(renderNuevo());
  }

  if (req.method === 'GET' && parsed.pathname === '/buscar') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403); return res.end('No autorizado'); }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(renderBuscar());
  }

  if (req.method === 'GET' && parsed.pathname.startsWith('/uploads/servicios/')) {
    const filename = path.basename(parsed.pathname);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('No encontrado'); }
    const servir = function () {
      const ext = path.extname(filename).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
      res.writeHead(200, {'Content-Type': mime});
      res.end(fs.readFileSync(filePath));
    };
    if (sesionValida(req)) return servir();
    const tokenQuery = parsed.query.token || '';
    if (!tokenQuery) { res.writeHead(403); return res.end('No autorizado'); }
    const conn = db();
    conn.query('SELECT id FROM servicios_gps WHERE token=? AND (foto_path=? OR foto_gps_path=?) LIMIT 1', [tokenQuery, filename, filename], (err, rows) => {
      conn.end();
      if (err || !rows || !rows.length) { res.writeHead(403); return res.end('No autorizado'); }
      servir();
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/servicio/buscar') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403); return res.end('[]'); }
    const q = '%' + (parsed.query.q || '') + '%';
    const conn = db();
    conn.query(
      `SELECT id, fecha, tecnico_nombre, cliente, celular, trabajo, vehiculo_marca, vehiculo_modelo,
       placa_chasis, imei, estado, estado_cierre, token, visto, visto_at, pago_tecnico,
       alegra_contact_id, alegra_invoice_id, alegra_invoice_number, alegra_invoice_status
       FROM servicios_gps
       WHERE cliente LIKE ? OR celular LIKE ? OR imei LIKE ? OR tecnico_nombre LIKE ?
          OR vehiculo_marca LIKE ? OR vehiculo_modelo LIKE ? OR placa_chasis LIKE ? OR token LIKE ?
       ORDER BY created_at DESC LIMIT 100`,
      [q,q,q,q,q,q,q,q],
      async (err, rows) => {
        conn.end();
        if (err) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify([]));
        }
        const filas = rows || [];
        await Promise.all(filas.map(async (r) => {
          if (r.alegra_invoice_id) {
            const estFactura = await consultarEstadoFactura(r.alegra_invoice_id);
            r.alegra_pago = estFactura.ok ? (estFactura.balance === 0 ? 'pagada' : 'pendiente') : null;
          } else {
            r.alegra_pago = null;
          }
        }));
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(filas));
      }
    );
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/pago-tecnico') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta id'})); }
      const valor = data.pago_tecnico === 'pagado' ? 'pagado' : 'pendiente';
      const conn = db();
      conn.query('UPDATE servicios_gps SET pago_tecnico=? WHERE id=?', [valor, data.id], (err) => {
        conn.end();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: !err, error: err ? err.message : undefined }));
      });
    });
    return;
  }
  if (req.method === 'POST' && parsed.pathname === '/api/servicio/pago-tecnico') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta id'})); }
      const valor = data.pago_tecnico === 'pagado' ? 'pagado' : 'pendiente';
      const conn = db();
      conn.query('UPDATE servicios_gps SET pago_tecnico=? WHERE id=?', [valor, data.id], (err) => {
        conn.end();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: !err, error: err ? err.message : undefined }));
      });
    });
    return;
  }
  if (req.method === 'POST' && parsed.pathname === '/api/servicio/eliminar') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    const token = parsed.query.token;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta token'})); }
    const conn = db();
    conn.query('DELETE FROM servicios_gps WHERE token=?', [token], (err) => {
      conn.end();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: !err, error: err ? err.message : undefined }));
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/crear') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      const t = TECNICOS[data.tecnico_id];
      if (!t) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Técnico inválido'})); }

      const esTrasladoCrear = data.trabajo === 'Reinstalación (1 traslado)' || data.trabajo === 'Reinstalación (2 traslados)';
      function insertarServicio(campos) {
        return new Promise((resolve) => {
          const token = generarToken();
          const conn = db();
          conn.query(
            `INSERT INTO servicios_gps (tecnico_id, tecnico_nombre, fecha, hora, cliente, celular, trabajo,
             vehiculo_marca, vehiculo_modelo, color_vehiculo, placa_chasis, zona_instalacion, ubicacion_url, nota, imei, correo, token, estado,
             vehiculo_destino_marca, vehiculo_destino_modelo, vehiculo_destino_color, vehiculo_destino_placa, vehiculo_destino_anio,
             wox_user_id, wox_sync_estado)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'asignado', ?, ?, ?, ?, ?, ?, ?)`,
            [data.tecnico_id, t.nombre, data.fecha||new Date().toISOString().slice(0,10), data.hora||null,
             data.cliente||null, data.celular||null, data.trabajo||null,
             campos.vehiculo_marca||null, campos.vehiculo_modelo||null, campos.color_vehiculo||null, campos.placa_chasis||null,
             campos.zona_instalacion||null, data.ubicacion_url||null, data.nota||null, campos.imei||null, campos.correo||data.wox_correo||null, token,
             esTrasladoCrear ? (data.vehiculo_destino_marca||null) : null,
             esTrasladoCrear ? (data.vehiculo_destino_modelo||null) : null,
             esTrasladoCrear ? (data.vehiculo_destino_color||null) : null,
             esTrasladoCrear ? (data.vehiculo_destino_placa||null) : null,
             esTrasladoCrear ? (data.vehiculo_destino_anio||null) : null,
             data.wox_user_id||null, data.wox_sync_estado||null],
            (err, result) => {
              conn.end();
              if (err) { resolve({ ok:false, error: err.message }); return; }
              resolve({ ok:true, token, id: result.insertId, link: 'https://servicio.dfctrack.com/servicio?token=' + token, campos });
            }
          );
        });
      }

      const tieneVehiculosWox = Array.isArray(data.vehiculos) && data.vehiculos.length > 0 && data.trabajo !== 'Instalación';
      const tieneVehiculosManual = Array.isArray(data.vehiculos) && data.vehiculos.length > 0 && data.trabajo === 'Instalación';
      const creados = [];

      if (tieneVehiculosWox) {
        for (const v of data.vehiculos) {
          const r = await insertarServicio({
            vehiculo_marca: v.name || null,
            vehiculo_modelo: null,
            color_vehiculo: null,
            placa_chasis: v.plate_number || null,
            zona_instalacion: v.object_owner || null,
            imei: v.imei || null,
            correo: v.email || null
          });
          creados.push(r);
        }
      } else if (tieneVehiculosManual) {
        for (const v of data.vehiculos) {
          const r = await insertarServicio({
            vehiculo_marca: v.marca || null,
            vehiculo_modelo: v.modelo || null,
            color_vehiculo: v.color || null,
            placa_chasis: null,
            zona_instalacion: data.zona_instalacion || null,
            imei: v.imei || null
          });
          creados.push(r);
        }
      } else {
        const r = await insertarServicio({
          vehiculo_marca: data.vehiculo_marca,
          vehiculo_modelo: data.vehiculo_modelo,
          color_vehiculo: data.color_vehiculo,
          placa_chasis: null,
          zona_instalacion: data.zona_instalacion,
          imei: null
        });
        creados.push(r);
      }

      const exitosos = creados.filter(c => c.ok);
      if (!exitosos.length) {
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error: creados[0] ? creados[0].error : 'Error desconocido' }));
      }

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, link: exitosos[0].link, id: exitosos[0].id, creados: exitosos.length }));

      try {
        let mensaje = '🛠 *Nuevo servicio asignado*\n\n' +
          '👤 Cliente: ' + (data.cliente || '-') + '\n' +
          '📱 Celular: ' + (data.celular || '-') + '\n' +
          '🔧 Servicio: ' + (data.trabajo || '-') + '\n' +
          (data.fecha || data.hora ? ('📅 Cita: ' + (data.fecha ? data.fecha.split('-').reverse().join('-') : '-') + (data.hora ? (' · Hora: ' + data.hora) : '') + '\n') : '');

        if (tieneVehiculosWox || tieneVehiculosManual) {
          mensaje += '\n🚗 *Vehículos a trabajar (' + exitosos.length + '):*\n';
          exitosos.forEach(function(c, i) {
            const imeiCorto = c.campos.imei ? ('...' + String(c.campos.imei).slice(-6)) : '-';
            mensaje += (i+1) + '. ' + (c.campos.vehiculo_marca || '-') + (c.campos.vehiculo_modelo ? (' ' + c.campos.vehiculo_modelo) : '') + (c.campos.color_vehiculo ? (' (' + c.campos.color_vehiculo + ')') : '') +
              ' · IMEI: ' + imeiCorto + (c.campos.zona_instalacion ? (' · ' + c.campos.zona_instalacion) : '') + '\n' +
              '   👉 ' + c.link + '\n';
          });
        } else {
          const c = exitosos[0];
          mensaje += '🚗 Vehículo: ' + (c.campos.vehiculo_marca || '') + ' ' + (c.campos.vehiculo_modelo || '') + (c.campos.color_vehiculo ? (' (' + c.campos.color_vehiculo + ')') : '') + '\n' +
            '📍 Zona: ' + (c.campos.zona_instalacion || '-') + '\n';
        }

        mensaje += (data.ubicacion_url ? ('🗺 Ubicación: ' + data.ubicacion_url + '\n') : '') +
          (data.nota ? ('📝 Nota: ' + data.nota + '\n') : '');

        if (!tieneVehiculosWox && !tieneVehiculosManual) {
          mensaje += '📌 Código: ' + exitosos[0].token + '\n\n👉 Completa el servicio aquí:\n' + exitosos[0].link;
        }

        if (sock) await sock.sendMessage(t.whatsapp, { text: mensaje });
      } catch (e) {
        console.log('Error enviando WhatsApp de nuevo servicio:', e.message);
      }
    });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/servicio') {
    if (parsed.query.token) {
      const conn = db();
      conn.query('SELECT * FROM servicios_gps WHERE token=?', [parsed.query.token], (err, rows) => {
        conn.end();
        if (err || !rows || !rows.length) {
          res.writeHead(404, {'Content-Type':'text/html'});
          return res.end('Servicio no encontrado');
        }
        const s = rows[0];
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        const esAdminAqui = accesoAdminValido(req, parsed.query);
        if (s.estado === 'terminado' && !esAdminAqui) {
          res.end(renderResumen(s));
        } else {
          res.end(renderForm(String(s.tecnico_id), s.id, s, esAdminAqui));
        }
        if (!esAdminAqui && !s.visto) {
          const connVisto = db();
          connVisto.query('UPDATE servicios_gps SET visto=1, visto_at=NOW() WHERE token=? AND visto=0', [s.token], () => connVisto.end());
        }
      });
      return;
    }
    const tecnico = parsed.query.tecnico;
    const recordId = parsed.query.id || null;
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(renderForm(tecnico, recordId, null, false));
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/reenviar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta id'})); }
      const conn = db();
      conn.query('SELECT * FROM servicios_gps WHERE id=?', [data.id], async (err, rows) => {
        conn.end();
        if (err || !rows || !rows.length) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'Servicio no encontrado'}));
        }
        const s = rows[0];
        const t = TECNICOS[String(s.tecnico_id)];
        if (!t || !sock) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'No se pudo enviar (técnico o WhatsApp no disponible)'}));
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));

        const mensaje = '🔄 *Servicio actualizado / reenviado*\n\n' +
          '👨‍🔧 Técnico: ' + t.nombre + '\n' +
          '📅 Fecha: ' + s.fecha + '  🕐 Hora: ' + (s.hora || '-') + '\n' +
          '👤 Cliente: ' + (s.cliente || '-') + '\n' +
          '📱 Celular: ' + (s.celular || '-') + '\n' +
          '🔧 Servicio: ' + (s.trabajo || '-') + '\n' +
          '🚗 Vehículo: ' + (s.vehiculo_marca || '-') + ' ' + (s.vehiculo_modelo || '') + '\n' +
          (s.color_vehiculo ? ('🎨 Color: ' + s.color_vehiculo + '\n') : '') +
          '🪪 Placa/Chasis: ' + (s.placa_chasis || '-') + '\n' +
          '📍 Zona: ' + (s.zona_instalacion || '-') + '\n' +
          '🔌 Posee apagado: ' + (s.posee_apagado == 1 ? 'Sí' : 'No') + '\n' +
          '🛰 IMEI: ' + (s.imei || '-') + '\n' +
          (s.ubicacion_url ? ('🗺 Ubicación: ' + s.ubicacion_url + '\n') : '') +
          (s.nota ? ('📝 Nota: ' + s.nota + '\n') : '') +
          '📌 Código: ' + s.token +
          (s.estado_cierre ? ('\n\n📌 *Estado de cierre: ' + s.estado_cierre + '*') : '') +
          '\n\n👉 Link: https://servicio.dfctrack.com/servicio?token=' + s.token;
        try {
          if (s.foto_path) {
            const buf = fs.readFileSync(path.join(UPLOAD_DIR, s.foto_path));
            await sock.sendMessage(t.whatsapp, { image: buf, caption: mensaje });
          } else {
            await sock.sendMessage(t.whatsapp, { text: mensaje });
          }
        } catch (e2) {
          console.log('Error reenviando WhatsApp:', e2.message);
        }
      });
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/crear-alegra') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta id'})); }
      const conn = db();
      conn.query('SELECT * FROM servicios_gps WHERE id=?', [data.id], async (err, rows) => {
        conn.end();
        if (err || !rows || !rows.length) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'Servicio no encontrado'}));
        }
        const s = rows[0];
        if (s.alegra_invoice_id) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'Ya facturado: #' + s.alegra_invoice_number}));
        }
        if (!s.correo) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'Falta el correo del cliente. Agregalo antes de facturar.'}));
        }
        const itemId = ALEGRA_ITEMS_POR_TRABAJO[s.trabajo];
        if (!itemId) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'No hay item de Alegra configurado para "' + s.trabajo + '"'}));
        }
        const resultadoContacto = await buscarOCrearContacto({ nombre: s.cliente, correo: s.correo, whatsapp: s.celular, identificacion: undefined });
        if (!resultadoContacto.ok) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'Alegra (contacto): ' + resultadoContacto.error}));
        }
        const contacto = resultadoContacto.contacto;
        const nombreAlegra = String(contacto.name || '').trim().toLowerCase();
        const nombreTicket = String(s.cliente || '').trim().toLowerCase();
        if (nombreAlegra && nombreTicket && nombreAlegra !== nombreTicket && !data.forzar) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, requiereConfirmacion:true, error: 'El contacto en Alegra existe como "' + contacto.name + '", distinto al cliente del ticket ("' + s.cliente + '").' }));
        }
        const esTrasladoFactura = s.trabajo === 'Reinstalación (1 traslado)' || s.trabajo === 'Reinstalación (2 traslados)';
        let deviceId = null;
        if (s.imei) {
          try {
            deviceId = await new Promise((resolve) => {
              const connDev = db();
              connDev.query('SELECT id FROM devices WHERE imei=? LIMIT 1', [s.imei], (errDev, rowsDev) => {
                connDev.end();
                resolve(rowsDev && rowsDev[0] ? rowsDev[0].id : null);
              });
            });
          } catch (eDev) { deviceId = null; }
        }
        const imei6 = s.imei ? ('...' + String(s.imei).slice(-6)) : '';
        const descripcion = 'Vehiculo: ' + (s.vehiculo_marca || '') + ' ' + (s.vehiculo_modelo || '') +
          (deviceId ? (' - ID: ' + deviceId) : '') + (imei6 ? (' - IMEI: ' + imei6) : '') +
          (esTrasladoFactura && s.vehiculo_destino_marca ? (' -> Destino: ' + s.vehiculo_destino_marca + ' ' + (s.vehiculo_destino_modelo || '') + (s.vehiculo_destino_placa ? (' placa ' + s.vehiculo_destino_placa) : '')) : '');
        const resultadoFactura = await crearFactura({ contactoId: contacto.id, itemId: itemId, descripcion: descripcion });
        if (!resultadoFactura.ok) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false, error:'Alegra (factura): ' + resultadoFactura.error}));
        }
        const factura = resultadoFactura.factura;
        const numero = factura.numberTemplate ? factura.numberTemplate.fullNumber : null;
        const connGuardar = db();
        connGuardar.query(
          'UPDATE servicios_gps SET alegra_contact_id=?, alegra_invoice_id=?, alegra_invoice_number=?, alegra_invoice_status=? WHERE id=?',
          [contacto.id, factura.id, numero, factura.status || null, s.id],
          () => connGuardar.end()
        );
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok:true, facturaId: factura.id, numero: numero }));
      });
    });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/api/servicio/estado') {
    const imei = parsed.query.imei;
    if (!imei) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Falta imei'})); }
    const conn = db();
    conn.query(
      `SELECT d.id, d.name, td.server_time, TIMESTAMPDIFF(MINUTE, td.server_time, NOW()) as minutos_offline
       FROM devices d JOIN traccar_devices td ON td.id = d.traccar_device_id
       WHERE d.imei = ? AND d.deleted = 0 LIMIT 1`,
      [imei],
      (err, rows) => {
        conn.end();
        if (err || !rows || !rows.length) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ online: false, minutos_offline: null }));
        }
        const r = rows[0];
        const online = r.minutos_offline !== null && r.minutos_offline < 120;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ online, minutos_offline: r.minutos_offline, device_id: r.id }));
      }
    );
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/servicio/inventario') {
    const grupos = Object.values(TECNICOS).map(t => t.grupo_imei);
    const placeholders = grupos.map(() => '?').join(',');
    const conn = db();
    conn.query(
      `SELECT udp.group_id AS group_id, COUNT(*) AS total
       FROM user_device_pivot udp
       JOIN devices d ON d.id = udp.device_id
       WHERE udp.group_id IN (${placeholders})
       GROUP BY udp.group_id`,
      grupos,
      (err, rows) => {
        conn.end();
        const mapa = {};
        (rows || []).forEach(r => { mapa[r.group_id] = r.total; });
        const resultado = Object.entries(TECNICOS).map(([id, t]) => ({
          id, nombre: t.nombre, total: mapa[t.grupo_imei] || 0
        }));
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(err ? [] : resultado));
      }
    );
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/api/servicio/buscar-cliente-wox') {
    const q = (parsed.query.q || '').trim();
    if (!q) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta busqueda'})); }
    const digitos = q.replace(/[^0-9]/g, '');
    const base = "SELECT d.id, d.name, d.imei, d.device_model, d.plate_number, d.object_owner, u.email, u.phone_number " +
                 "FROM devices d JOIN user_device_pivot udp ON udp.device_id = d.id JOIN users u ON u.id = udp.user_id WHERE ";
    let sql, params;
    if (q.indexOf('@') !== -1) {
      sql = base + "u.email LIKE ? ORDER BY u.email LIMIT 30";
      params = ['%' + q + '%'];
    } else if (digitos.length >= 13) {
      sql = base + "d.imei LIKE ? ORDER BY u.email LIMIT 30";
      params = ['%' + digitos + '%'];
    } else if (digitos.length >= 7) {
      const ultimos10 = digitos.slice(-10);
      sql = base + "REPLACE(REPLACE(REPLACE(u.phone_number,'-',''),' ',''),'+','') LIKE ? ORDER BY u.email LIMIT 30";
      params = ['%' + ultimos10];
    } else {
      sql = base + "(d.name LIKE ? OR d.plate_number LIKE ?) ORDER BY u.email LIMIT 30";
      params = ['%' + q + '%', '%' + q + '%'];
    }
    const conn = db();
    conn.query(sql, params, function(err, rows) {
      conn.end();
      if (err) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error: err.message})); }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, vehiculos: rows }));
    });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/api/servicio/imei') {
    const t = TECNICOS[parsed.query.tecnico];
    if (!t) { res.writeHead(400); return res.end(JSON.stringify([])); }
    const conn = db();
    conn.query(
      `SELECT d.imei, d.device_model FROM user_device_pivot udp
       JOIN devices d ON d.id = udp.device_id
       WHERE udp.group_id = ? ORDER BY d.imei`,
      [t.grupo_imei],
      (err, rows) => {
        conn.end();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(err ? [] : rows));
      }
    );
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/autoguardar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      const t = TECNICOS[data.tecnico_id] || { nombre: 'Desconocido' };
      const conn = db();
      if (data.id) {
        let sqlUpdate = `UPDATE servicios_gps SET tecnico_id=?, tecnico_nombre=?, fecha=?, hora=?, cliente=?, celular=?, trabajo=?, vehiculo_marca=?, vehiculo_modelo=?, color_vehiculo=?,
           placa_chasis=?, zona_instalacion=?, posee_apagado=?, ubicacion_url=?, nota=?, imei=?`;
        const paramsUpdate = [data.tecnico_id||null, t.nombre||null, data.fecha||null, data.hora||null, data.cliente||null, data.celular||null, data.trabajo||null, data.vehiculo_marca||null,
           data.vehiculo_modelo||null, data.color_vehiculo||null, data.placa_chasis||null, data.zona_instalacion||null,
           (data.posee_apagado===''||data.posee_apagado===undefined)?null:data.posee_apagado, data.ubicacion_url||null, data.nota||null, data.imei||null];
        if (data.correo !== undefined) { sqlUpdate += ', correo=?'; paramsUpdate.push(data.correo||null); }
        if (data.pago_tecnico !== undefined) { sqlUpdate += ', pago_tecnico=?'; paramsUpdate.push(data.pago_tecnico||null); }
        if (data.persona_recibe_nombre !== undefined) { sqlUpdate += ', persona_recibe_nombre=?'; paramsUpdate.push(data.persona_recibe_nombre||null); }
        if (data.persona_recibe_telefono !== undefined) { sqlUpdate += ', persona_recibe_telefono=?'; paramsUpdate.push(data.persona_recibe_telefono||null); }
        if (data.persona_recibe_nota !== undefined) { sqlUpdate += ', persona_recibe_nota=?'; paramsUpdate.push(data.persona_recibe_nota||null); }
        if (data.vehiculo_destino_marca !== undefined) { sqlUpdate += ', vehiculo_destino_marca=?'; paramsUpdate.push(data.vehiculo_destino_marca||null); }
        if (data.vehiculo_destino_modelo !== undefined) { sqlUpdate += ', vehiculo_destino_modelo=?'; paramsUpdate.push(data.vehiculo_destino_modelo||null); }
        if (data.vehiculo_destino_color !== undefined) { sqlUpdate += ', vehiculo_destino_color=?'; paramsUpdate.push(data.vehiculo_destino_color||null); }
        if (data.vehiculo_destino_placa !== undefined) { sqlUpdate += ', vehiculo_destino_placa=?'; paramsUpdate.push(data.vehiculo_destino_placa||null); }
        if (data.vehiculo_destino_anio !== undefined) { sqlUpdate += ', vehiculo_destino_anio=?'; paramsUpdate.push(data.vehiculo_destino_anio||null); }
        sqlUpdate += ' WHERE id=?';
        paramsUpdate.push(data.id);
        conn.query(sqlUpdate, paramsUpdate, (err) => {
          conn.end();
          if (err) console.log('Error autoguardar UPDATE id=' + data.id + ':', err.message);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ id: data.id, ok: !err }));
        });
      } else {
        conn.query(
          `INSERT INTO servicios_gps (tecnico_id, tecnico_nombre, fecha, hora, cliente, celular, trabajo,
           vehiculo_marca, vehiculo_modelo, color_vehiculo, placa_chasis, zona_instalacion, posee_apagado, ubicacion_url, nota, imei)
           VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [data.tecnico_id, t.nombre, data.hora||null, data.cliente||null, data.celular||null, data.trabajo||null,
           data.vehiculo_marca||null, data.vehiculo_modelo||null, data.color_vehiculo||null, data.placa_chasis||null,
           data.zona_instalacion||null, data.posee_apagado===''?null:data.posee_apagado,
           data.ubicacion_url||null, data.nota||null, data.imei||null],
          (err, result) => {
            conn.end();
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ id: err ? null : result.insertId, ok: !err }));
          }
        );
      }
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/foto') {
    const form = new formidable.IncomingForm({ uploadDir: UPLOAD_DIR, keepExtensions: true, multiples: false });
    form.parse(req, (err, fields, files) => {
      if (err || !files.foto) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error: 'upload failed' }));
      }
      const file = Array.isArray(files.foto) ? files.foto[0] : files.foto;
      const idVal = Array.isArray(fields.id) ? fields.id[0] : fields.id;
      const tipoVal = Array.isArray(fields.tipo) ? fields.tipo[0] : fields.tipo;
      const esGps = tipoVal === 'gps';
      const columna = esGps ? 'foto_gps_path' : 'foto_path';
      const prefijo = esGps ? 'servicio_gps_' : 'servicio_';
      const finalName = prefijo + idVal + '_' + Date.now() + path.extname(file.originalFilename || file.newFilename || '.jpg');
      const finalPath = path.join(UPLOAD_DIR, finalName);
      fs.renameSync(file.filepath, finalPath);
      const conn = db();
      conn.query('UPDATE servicios_gps SET ' + columna + '=? WHERE id=?', [finalName, idVal], (errUpd) => {
        conn.end();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: !errUpd, path: finalName, tipo: esGps ? 'gps' : 'vehiculo' }));
      });
    });
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/servicio/terminar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id) {
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error:'Falta id' }));
      }
      const t = TECNICOS[data.tecnico_id];
      const esCierreManualAdmin = data.cierre_manual === true && accesoAdminValido(req, parsed.query);
      if (esCierreManualAdmin) {
        return finalizarServicio(true);
      }
      const connCheck = db();
      connCheck.query('SELECT foto_path, foto_gps_path, trabajo, vehiculo_destino_marca, vehiculo_destino_placa FROM servicios_gps WHERE id=?', [data.id], (errCheck, rowsCheck) => {
        connCheck.end();
        if (errCheck || !rowsCheck || !rowsCheck.length) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Servicio no encontrado' }));
        }
        const actual = rowsCheck[0];
        const trabajoFinal = data.trabajo || actual.trabajo;
        const esTrasladoServ = trabajoFinal === 'Reinstalación (1 traslado)' || trabajoFinal === 'Reinstalación (2 traslados)';
        const faltantes = [];
        if (!actual.foto_path) faltantes.push('foto del vehículo');
        const destinoMarca = data.vehiculo_destino_marca !== undefined ? data.vehiculo_destino_marca : actual.vehiculo_destino_marca;
        const destinoPlaca = data.vehiculo_destino_placa !== undefined ? data.vehiculo_destino_placa : actual.vehiculo_destino_placa;
        if (esTrasladoServ && (!destinoMarca || !destinoPlaca)) faltantes.push('vehículo destino (marca y placa)');
        if (faltantes.length) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error: 'No se puede finalizar, falta: ' + faltantes.join(', ') }));
        }
        finalizarServicio(false);
      });

      function finalizarServicio(esManual) {
      const conn = db();
      const marcaManual = esManual ? ('\n[Cerrado manual por admin - contingencia, ' + new Date().toISOString().slice(0,16).replace('T',' ') + ']') : '';
      conn.query(
        `UPDATE servicios_gps SET estado='terminado', estado_cierre=?, nota = CONCAT(IFNULL(nota,''), ?) WHERE id=?`,
        [data.estado_cierre || 'Terminado', marcaManual, data.id],
        async (err) => {
          if (err) {
            conn.end();
            res.writeHead(200, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ ok:false, error: err.message }));
          }
          conn.query('SELECT * FROM servicios_gps WHERE id=?', [data.id], async (e2, rows) => {
            conn.end();
            const s = rows && rows[0];
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ ok: true }));

            if (t && sock && s) {
              const mensaje = '✅ *Servicio completado*\n\n' +
                '👨‍🔧 Técnico: ' + t.nombre + '\n' +
                '📅 Fecha: ' + s.fecha + '  🕐 Hora: ' + (s.hora || '-') + '\n' +
                '👤 Cliente: ' + (s.cliente || '-') + '\n' +
                '📱 Celular: ' + (s.celular || '-') + '\n' +
                '🔧 Servicio: ' + (s.trabajo || '-') + '\n' +
                '🚗 Vehículo: ' + (s.vehiculo_marca || '-') + ' ' + (s.vehiculo_modelo || '') + '\n' +
                (s.color_vehiculo ? ('🎨 Color: ' + s.color_vehiculo + '\n') : '') +
                '🪪 Placa/Chasis: ' + (s.placa_chasis || '-') + '\n' +
                '📍 Zona: ' + (s.zona_instalacion || '-') + '\n' +
                '🔌 Posee apagado: ' + (s.posee_apagado == 1 ? 'Sí' : 'No') + '\n' +
                '🛰 IMEI: ' + (s.imei || '-') + '\n' +
                (s.ubicacion_url ? ('🗺 Ubicación: ' + s.ubicacion_url + '\n') : '') +
                (s.nota ? ('📝 Nota: ' + s.nota + '\n') : '') +
                '📌 Código: ' + s.token + '\n' +
                '\n📌 *Estado de cierre: ' + data.estado_cierre + '*';
              try {
                if (s.foto_path) {
                  const buf = fs.readFileSync(path.join(UPLOAD_DIR, s.foto_path));
                  await sock.sendMessage(t.whatsapp, { image: buf, caption: mensaje });
                } else {
                  await sock.sendMessage(t.whatsapp, { text: mensaje });
                }
              } catch (e3) {
                console.log('Error enviando WhatsApp servicio:', e3.message);
              }
            }
          });
        }
      );
      }
    });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/servicio/buscar-cliente') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({matches:[]})); }
    const conn = db();
    if (parsed.query.email) {
      const q = '%' + parsed.query.email + '%';
      conn.query('SELECT id, email FROM users WHERE email LIKE ? ORDER BY email LIMIT 10', [q], (err, rows) => {
        conn.end();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ matches: err ? [] : rows }));
      });
      return;
    }
    const celularRaw = (parsed.query.celular || '').replace(/[^0-9]/g, '');
    const ultimos10 = celularRaw.slice(-10);
    if (!ultimos10) {
      conn.end();
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ matches: [] }));
    }
    conn.query(
      "SELECT id, email FROM users WHERE REPLACE(REPLACE(REPLACE(phone_number,'-',''),' ',''),'+','') LIKE ?",
      ['%' + ultimos10],
      (err, rows) => {
        conn.end();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ matches: err ? [] : rows }));
      }
    );
    return;
  }
  if (req.method === 'POST' && parsed.pathname === '/api/servicio/aplicar-wox') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id || !data.cliente_user_id) {
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error:'Falta id o cliente_user_id' }));
      }
      const conn = db();
      conn.query('SELECT * FROM servicios_gps WHERE id=?', [data.id], (err, rows) => {
        if (err || !rows || !rows.length) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Servicio no encontrado' }));
        }
        const s = rows[0];
        if (s.trabajo !== 'Instalación' || s.estado !== 'terminado') {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Solo aplica a instalaciones terminadas' }));
        }
        if (s.aplicado_wox) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Ya fue aplicado antes' }));
        }
        if (!s.imei) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'El servicio no tiene IMEI' }));
        }
        conn.query('SELECT id FROM devices WHERE imei=?', [s.imei], (err2, devRows) => {
          if (err2 || !devRows || !devRows.length) {
            conn.end();
            res.writeHead(200, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ ok:false, error:'IMEI no existe en GPSWOX' }));
          }
          const deviceId = devRows[0].id;
          const nombreFinal = (data.name || '').trim() || ((s.vehiculo_marca || '') + ' ' + (s.vehiculo_modelo || ''));
          let fechaVenc = null;
          try {
            const d = new Date(s.fecha);
            d.setFullYear(d.getFullYear() + 1);
            fechaVenc = d.toISOString().slice(0, 10);
          } catch (eDate) {}
          conn.query(
            "UPDATE devices SET name = ?, plate_number = ?, object_owner = ?, additional_notes = ?, comment = ?, installation_date = ?, expiration_date = ? WHERE id = ?",
            [nombreFinal, s.placa_chasis, s.zona_instalacion, s.tecnico_nombre, s.nota || '', s.fecha, fechaVenc, deviceId],
            (err3) => {
              if (err3) {
                conn.end();
                res.writeHead(200, {'Content-Type':'application/json'});
                return res.end(JSON.stringify({ ok:false, error:'Error actualizando device: ' + err3.message }));
              }
              resolverGrupoCliente(data.cliente_user_id, s.cliente, (errGrupo, groupId) => {
                if (errGrupo) {
                  conn.end();
                  res.writeHead(200, {'Content-Type':'application/json'});
                  return res.end(JSON.stringify({ ok:false, error:'Error resolviendo grupo del cliente: ' + errGrupo.message }));
                }
                conn.query(
                  'SELECT user_id, group_id FROM user_device_pivot WHERE device_id=? LIMIT 1',
                  [deviceId],
                  (err4, pivotRows) => {
                    const yaEnDestino = !err4 && pivotRows && pivotRows.length && pivotRows[0].user_id === data.cliente_user_id && pivotRows[0].group_id === groupId;
                    const marcarAplicado = () => {
                      conn.query(
                        'UPDATE servicios_gps SET aplicado_wox=1, aplicado_wox_at=NOW() WHERE id=?',
                        [data.id],
                        () => {
                          conn.end();
                          res.writeHead(200, {'Content-Type':'application/json'});
                          res.end(JSON.stringify({ ok: true, device_id: deviceId, expiration_date: fechaVenc, group_id: groupId, ya_vinculado: !!yaEnDestino }));
                        }
                      );
                    };
                    if (yaEnDestino) {
                      marcarAplicado();
                    } else if (!err4 && pivotRows && pivotRows.length) {
                      // El IMEI ya tiene una fila (normalmente en el grupo del tecnico) -> se mueve al usuario/grupo del cliente.
                      conn.query(
                        'UPDATE user_device_pivot SET user_id=?, group_id=?, active=1 WHERE device_id=?',
                        [data.cliente_user_id, groupId, deviceId],
                        () => { marcarAplicado(); }
                      );
                    } else {
                      conn.query(
                        'INSERT INTO user_device_pivot (user_id, device_id, group_id, active) VALUES (?, ?, ?, 1)',
                        [data.cliente_user_id, deviceId, groupId],
                        () => { marcarAplicado(); }
                      );
                    }
                  }
                );
              });
            }
          );
        });
      });
    });
    return;
  }
  if (req.method === 'POST' && parsed.pathname === '/api/servicio/aplicar-wox-traslado') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      if (!data.id) {
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error:'Falta id' }));
      }
      const conn = db();
      conn.query('SELECT * FROM servicios_gps WHERE id=?', [data.id], (err, rows) => {
        if (err || !rows || !rows.length) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Servicio no encontrado' }));
        }
        const s = rows[0];
        const esTrasladoServ = s.trabajo === 'Reinstalación (1 traslado)' || s.trabajo === 'Reinstalación (2 traslados)';
        if (!esTrasladoServ || s.estado !== 'terminado') {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Solo aplica a traslados terminados' }));
        }
        if (s.aplicado_wox) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Ya fue aplicado antes' }));
        }
        if (!s.imei) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'El servicio no tiene IMEI' }));
        }
        if (!s.vehiculo_destino_marca || !s.vehiculo_destino_placa) {
          conn.end();
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:false, error:'Falta el vehículo destino (marca y placa)' }));
        }
        conn.query('SELECT id FROM devices WHERE imei=?', [s.imei], (err2, devRows) => {
          if (err2 || !devRows || !devRows.length) {
            conn.end();
            res.writeHead(200, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ ok:false, error:'IMEI no existe en GPSWOX' }));
          }
          const deviceId = devRows[0].id;
          const nombreFinal = ((s.vehiculo_destino_marca || '') + ' ' + (s.vehiculo_destino_modelo || '') + ' ' + (s.vehiculo_destino_color || '')).replace(/\s+/g, ' ').trim();
          // No se toca user_device_pivot: el vehículo destino es del mismo cliente, solo cambian los datos descriptivos del device.
          // La nota conserva referencia al vehículo/servicio anterior para no perder trazabilidad.
          const notaHistorico = 'Traslado ' + s.fecha + ' (servicio #' + s.id + '): antes ' + (s.vehiculo_marca || '') + ' ' + (s.vehiculo_modelo || '') + ' placa ' + (s.placa_chasis || '-') + '. ' + (s.nota || '');
          conn.query(
            "UPDATE devices SET name = ?, plate_number = ?, comment = ? WHERE id = ?",
            [nombreFinal, s.vehiculo_destino_placa, notaHistorico, deviceId],
            (err3) => {
              conn.end();
              if (err3) {
                res.writeHead(200, {'Content-Type':'application/json'});
                return res.end(JSON.stringify({ ok:false, error:'Error actualizando device: ' + err3.message }));
              }
              const connMarcar = db();
              connMarcar.query(
                'UPDATE servicios_gps SET aplicado_wox=1, aplicado_wox_at=NOW() WHERE id=?',
                [data.id],
                () => {
                  connMarcar.end();
                  res.writeHead(200, {'Content-Type':'application/json'});
                  res.end(JSON.stringify({ ok: true, device_id: deviceId }));
                }
              );
            }
          );
        });
      });
    });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/api/servicio/sincronizar-alegra') {
    if (!accesoAdminValido(req, parsed.query)) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'No autorizado'})); }
    const correo = (parsed.query.correo || '').trim();
    const idVal = parsed.query.id;
    if (!correo) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Falta correo'})); }
    (async () => {
      try {
        const contacto = await buscarContactoPorCorreo(correo);
        if (!contacto) {
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ ok:true, existe:false }));
        }
        const conn = db();
        conn.query('SELECT cliente, celular FROM servicios_gps WHERE id=?', [idVal], (err, rows) => {
          conn.end();
          const s = (rows && rows[0]) || {};
          const nombreAlegra = String(contacto.name || '').trim();
          const telAlegra = String(contacto.phonePrimary || '').trim();
          const nombreTicket = String(s.cliente || '').trim();
          const telTicket = String(s.celular || '').trim();
          const coincide = nombreAlegra.toLowerCase() === nombreTicket.toLowerCase() &&
            (!telAlegra || !telTicket || telAlegra.replace(/\D/g,'').slice(-10) === telTicket.replace(/\D/g,'').slice(-10));
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({
            ok:true, existe:true, coincide,
            alegra_nombre: nombreAlegra, alegra_telefono: telAlegra
          }));
        });
      } catch (e) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok:false, error: e.message }));
      }
    })();
    return;
  }
  res.writeHead(404);
  res.end('Not found');
};
