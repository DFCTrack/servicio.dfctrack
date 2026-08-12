const mysql = require('mysql2');
const url = require('url');

const DB_CONFIG = {
  host: '154.38.189.98',
  user: 'wsc_registro',
  password: 'Wr8Kd3mNpQ7fXz2LtY9bVc4H',
  database: 'gpswox_web'
};
function db() { return mysql.createConnection(DB_CONFIG); }

function renderChatPanel() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat WhatsApp - Soporte</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; height:100vh; overflow:hidden; }
  .wrap { display:flex; height:100vh; }
  .sidebar { width:320px; background:#fff; border-right:1px solid #e5e5e5; display:flex; flex-direction:column; }
  .sidebar-header { padding:14px 16px; border-bottom:1px solid #eee; display:flex; align-items:center; gap:10px; }
  .sidebar-header img { height:28px; }
  .sidebar-header b { color:#128C7E; font-size:15px; }
  .lista { flex:1; overflow-y:auto; }
  .conv { padding:12px 16px; border-bottom:1px solid #f2f2f2; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  .conv:hover { background:#f7faf9; }
  .conv.activa { background:#eafaf3; }
  .conv-info { min-width:0; flex:1; }
  .conv-nombre { font-weight:600; font-size:14px; color:#222; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .conv-msg { font-size:13px; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
  .conv-meta { display:flex; flex-direction:column; align-items:flex-end; gap:4px; font-size:11px; color:#999; }
  .badge { background:#128C7E; color:#fff; border-radius:10px; min-width:18px; height:18px; padding:0 5px; font-size:11px; display:flex; align-items:center; justify-content:center; }
  .main { flex:1; display:flex; flex-direction:column; background:#e9edef; }
  .main-header { padding:14px 20px; background:#fff; border-bottom:1px solid #eee; font-weight:600; color:#222; display:flex; align-items:center; gap:10px; }
  .btn-volver { display:none; background:none; border:none; font-size:20px; cursor:pointer; color:#128C7E; }
  .mensajes { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width:65%; padding:8px 12px; border-radius:10px; font-size:14px; line-height:1.4; word-wrap:break-word; }
  .msg.in { background:#fff; align-self:flex-start; border-bottom-left-radius:2px; }
  .msg.out { background:#d9fdd3; align-self:flex-end; border-bottom-right-radius:2px; }
  .msg-hora { font-size:10px; color:#999; margin-top:4px; text-align:right; }
  .input-bar { padding:12px 16px; background:#fff; display:flex; gap:10px; align-items:center; }
  .input-bar textarea { flex:1; resize:none; border:1px solid #ddd; border-radius:20px; padding:10px 16px; font-size:14px; font-family:inherit; max-height:100px; }
  .input-bar button { background:#128C7E; color:#fff; border:none; border-radius:50%; width:42px; height:42px; font-size:18px; cursor:pointer; flex-shrink:0; }
  .vacio { flex:1; display:flex; align-items:center; justify-content:center; color:#999; font-size:14px; }
  @media(max-width:768px){
    .sidebar { width:100%; }
    .main { display:none; }
    .wrap.chat-abierto .sidebar { display:none; }
    .wrap.chat-abierto .main { display:flex; }
    .btn-volver { display:inline-block; }
  }
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <div class="sidebar">
    <div class="sidebar-header">
      <img src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC">
      <b>Chat Soporte</b>
    </div>
    <div class="lista" id="lista">Cargando...</div>
  </div>
  <div class="main">
    <div class="main-header" id="main-header" style="display:none;">
      <button class="btn-volver" id="btn-volver">&larr;</button>
      <span id="nombre-activo"></span>
    </div>
    <div class="mensajes" id="mensajes"></div>
    <div class="vacio" id="vacio">Selecciona una conversacion</div>
    <div class="input-bar" id="input-bar" style="display:none;">
      <textarea id="txt-mensaje" rows="1" placeholder="Escribe un mensaje..."></textarea>
      <button id="btn-enviar">&#10148;</button>
    </div>
  </div>
</div>
<script>
let numeroActivo = null;
let conversaciones = [];

function fmtHora(fecha) {
  const d = new Date(fecha);
  const hoy = new Date();
  const esHoy = d.toDateString() === hoy.toDateString();
  if (esHoy) return d.toLocaleTimeString('es-DO', {hour:'2-digit', minute:'2-digit'});
  return d.toLocaleDateString('es-DO', {day:'2-digit', month:'2-digit'});
}

async function cargarConversaciones() {
  try {
    const r = await fetch('/api/chat/conversaciones');
    const data = await r.json();
    conversaciones = data.conversaciones || [];
    renderLista();
  } catch(e) {}
}

function renderLista() {
  const cont = document.getElementById('lista');
  if (!conversaciones.length) { cont.innerHTML = '<div style="padding:20px;color:#999;font-size:13px;">Sin conversaciones.</div>'; return; }
  cont.innerHTML = conversaciones.map(function(c) {
    const nombre = escapeHtml(c.nombre || c.numero);
    const activa = c.numero === numeroActivo ? 'activa' : '';
    const badge = c.no_leidos > 0 ? '<span class="badge">' + c.no_leidos + '</span>' : '';
    const prefijo = c.ultima_direccion === 'out' ? 'Tu: ' : '';
    return '<div class="conv ' + activa + '" onclick="abrirConversacion(\'' + c.numero + '\')">' +
      '<div class="conv-info">' +
        '<div class="conv-nombre">' + nombre + '</div>' +
        '<div class="conv-msg">' + prefijo + escapeHtml(c.ultimo_mensaje || '') + '</div>' +
      '</div>' +
      '<div class="conv-meta"><span>' + fmtHora(c.ultimo_en) + '</span>' + badge + '</div>' +
    '</div>';
  }).join('');
}

async function abrirConversacion(numero) {
  numeroActivo = numero;
  document.getElementById('wrap').classList.add('chat-abierto');
  document.getElementById('main-header').style.display = 'flex';
  document.getElementById('input-bar').style.display = 'flex';
  document.getElementById('vacio').style.display = 'none';
  const c = conversaciones.find(function(x){ return x.numero === numero; });
  document.getElementById('nombre-activo').textContent = (c && c.nombre) || numero;
  document.getElementById('mensajes').dataset.iniciado = '';
  renderLista();
  await cargarMensajes();
}

async function cargarMensajes() {
  if (!numeroActivo) return;
  try {
    const r = await fetch('/api/chat/mensajes?numero=' + encodeURIComponent(numeroActivo));
    const data = await r.json();
    const cont = document.getElementById('mensajes');
    const abajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;
    cont.innerHTML = (data.mensajes || []).map(function(m) {
      const hora = new Date(m.creado_en).toLocaleTimeString('es-DO', {hour:'2-digit', minute:'2-digit'});
      return '<div class="msg ' + m.direccion + '">' + escapeHtml(m.mensaje) + '<div class="msg-hora">' + hora + '</div></div>';
    }).join('');
    if (abajo || !cont.dataset.iniciado) { cont.scrollTop = cont.scrollHeight; cont.dataset.iniciado = '1'; }
  } catch(e) {}
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function enviarMensaje() {
  const txt = document.getElementById('txt-mensaje');
  const mensaje = txt.value.trim();
  if (!mensaje || !numeroActivo) return;
  txt.value = '';
  try {
    await fetch('/api/chat/enviar', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ numero: numeroActivo, mensaje: mensaje })
    });
  } catch(e) {}
  await cargarMensajes();
  await cargarConversaciones();
}

document.getElementById('btn-enviar').addEventListener('click', enviarMensaje);
document.getElementById('txt-mensaje').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensaje(); }
});
document.getElementById('btn-volver').addEventListener('click', function() {
  document.getElementById('wrap').classList.remove('chat-abierto');
  numeroActivo = null;
});

cargarConversaciones();
setInterval(cargarConversaciones, 6000);
setInterval(function(){ if (numeroActivo) cargarMensajes(); }, 4000);
</script>
</body>
</html>`;
}

function renderChatPanel() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat WhatsApp - Soporte</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Arial, sans-serif; background:#f2f4f7; margin:0; height:100vh; overflow:hidden; }
  .wrap { display:flex; height:100vh; }
  .sidebar { width:320px; background:#fff; border-right:1px solid #e5e5e5; display:flex; flex-direction:column; }
  .sidebar-header { padding:14px 16px; border-bottom:1px solid #eee; display:flex; align-items:center; gap:10px; }
  .sidebar-header img { height:28px; }
  .sidebar-header b { color:#128C7E; font-size:15px; }
  .lista { flex:1; overflow-y:auto; }
  .conv { padding:12px 16px; border-bottom:1px solid #f2f2f2; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  .conv:hover { background:#f7faf9; }
  .conv.activa { background:#eafaf3; }
  .conv-info { min-width:0; flex:1; }
  .conv-nombre { font-weight:600; font-size:14px; color:#222; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .conv-msg { font-size:13px; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
  .conv-meta { display:flex; flex-direction:column; align-items:flex-end; gap:4px; font-size:11px; color:#999; }
  .badge { background:#128C7E; color:#fff; border-radius:10px; min-width:18px; height:18px; padding:0 5px; font-size:11px; display:flex; align-items:center; justify-content:center; }
  .main { flex:1; display:flex; flex-direction:column; background:#e9edef; }
  .main-header { padding:14px 20px; background:#fff; border-bottom:1px solid #eee; font-weight:600; color:#222; display:flex; align-items:center; gap:10px; }
  .btn-volver { display:none; background:none; border:none; font-size:20px; cursor:pointer; color:#128C7E; }
  .mensajes { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width:65%; padding:8px 12px; border-radius:10px; font-size:14px; line-height:1.4; word-wrap:break-word; }
  .msg.in { background:#fff; align-self:flex-start; border-bottom-left-radius:2px; }
  .msg.out { background:#d9fdd3; align-self:flex-end; border-bottom-right-radius:2px; }
  .msg-hora { font-size:10px; color:#999; margin-top:4px; text-align:right; }
  .input-bar { padding:12px 16px; background:#fff; display:flex; gap:10px; align-items:center; }
  .input-bar textarea { flex:1; resize:none; border:1px solid #ddd; border-radius:20px; padding:10px 16px; font-size:14px; font-family:inherit; max-height:100px; }
  .input-bar button { background:#128C7E; color:#fff; border:none; border-radius:50%; width:42px; height:42px; font-size:18px; cursor:pointer; flex-shrink:0; }
  .vacio { flex:1; display:flex; align-items:center; justify-content:center; color:#999; font-size:14px; }
  @media(max-width:768px){
    .sidebar { width:100%; }
    .main { display:none; }
    .wrap.chat-abierto .sidebar { display:none; }
    .wrap.chat-abierto .main { display:flex; }
    .btn-volver { display:inline-block; }
  }
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <div class="sidebar">
    <div class="sidebar-header">
      <img src="https://admin.dfctrack.com/images/logo-main.png" alt="DFC">
      <b>Chat Soporte</b>
    </div>
    <div class="lista" id="lista">Cargando...</div>
  </div>
  <div class="main">
    <div class="main-header" id="main-header" style="display:none;">
      <button class="btn-volver" id="btn-volver">&larr;</button>
      <span id="nombre-activo"></span>
    </div>
    <div class="mensajes" id="mensajes"></div>
    <div class="vacio" id="vacio">Selecciona una conversacion</div>
    <div class="input-bar" id="input-bar" style="display:none;">
      <textarea id="txt-mensaje" rows="1" placeholder="Escribe un mensaje..."></textarea>
      <button id="btn-enviar">&#10148;</button>
    </div>
  </div>
</div>
<script>
let numeroActivo = null;
let conversaciones = [];

function fmtHora(fecha) {
  const d = new Date(fecha);
  const hoy = new Date();
  const esHoy = d.toDateString() === hoy.toDateString();
  if (esHoy) return d.toLocaleTimeString('es-DO', {hour:'2-digit', minute:'2-digit'});
  return d.toLocaleDateString('es-DO', {day:'2-digit', month:'2-digit'});
}

async function cargarConversaciones() {
  try {
    const r = await fetch('/api/chat/conversaciones');
    const data = await r.json();
    conversaciones = data.conversaciones || [];
    renderLista();
  } catch(e) {}
}

function renderLista() {
  const cont = document.getElementById('lista');
  if (!conversaciones.length) { cont.innerHTML = '<div style="padding:20px;color:#999;font-size:13px;">Sin conversaciones.</div>'; return; }
  cont.innerHTML = conversaciones.map(function(c) {
    const nombre = escapeHtml(c.nombre || c.numero);
    const activa = c.numero === numeroActivo ? 'activa' : '';
    const badge = c.no_leidos > 0 ? '<span class="badge">' + c.no_leidos + '</span>' : '';
    const prefijo = c.ultima_direccion === 'out' ? 'Tu: ' : '';
    return '<div class="conv ' + activa + '" onclick="abrirConversacion(\'' + c.numero + '\')">' +
      '<div class="conv-info">' +
        '<div class="conv-nombre">' + nombre + '</div>' +
        '<div class="conv-msg">' + prefijo + escapeHtml(c.ultimo_mensaje || '') + '</div>' +
      '</div>' +
      '<div class="conv-meta"><span>' + fmtHora(c.ultimo_en) + '</span>' + badge + '</div>' +
    '</div>';
  }).join('');
}

async function abrirConversacion(numero) {
  numeroActivo = numero;
  document.getElementById('wrap').classList.add('chat-abierto');
  document.getElementById('main-header').style.display = 'flex';
  document.getElementById('input-bar').style.display = 'flex';
  document.getElementById('vacio').style.display = 'none';
  const c = conversaciones.find(function(x){ return x.numero === numero; });
  document.getElementById('nombre-activo').textContent = (c && c.nombre) || numero;
  document.getElementById('mensajes').dataset.iniciado = '';
  renderLista();
  await cargarMensajes();
}

async function cargarMensajes() {
  if (!numeroActivo) return;
  try {
    const r = await fetch('/api/chat/mensajes?numero=' + encodeURIComponent(numeroActivo));
    const data = await r.json();
    const cont = document.getElementById('mensajes');
    const abajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;
    cont.innerHTML = (data.mensajes || []).map(function(m) {
      const hora = new Date(m.creado_en).toLocaleTimeString('es-DO', {hour:'2-digit', minute:'2-digit'});
      return '<div class="msg ' + m.direccion + '">' + escapeHtml(m.mensaje) + '<div class="msg-hora">' + hora + '</div></div>';
    }).join('');
    if (abajo || !cont.dataset.iniciado) { cont.scrollTop = cont.scrollHeight; cont.dataset.iniciado = '1'; }
  } catch(e) {}
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function enviarMensaje() {
  const txt = document.getElementById('txt-mensaje');
  const mensaje = txt.value.trim();
  if (!mensaje || !numeroActivo) return;
  txt.value = '';
  try {
    await fetch('/api/chat/enviar', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ numero: numeroActivo, mensaje: mensaje })
    });
  } catch(e) {}
  await cargarMensajes();
  await cargarConversaciones();
}

document.getElementById('btn-enviar').addEventListener('click', enviarMensaje);
document.getElementById('txt-mensaje').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensaje(); }
});
document.getElementById('btn-volver').addEventListener('click', function() {
  document.getElementById('wrap').classList.remove('chat-abierto');
  numeroActivo = null;
});

cargarConversaciones();
setInterval(cargarConversaciones, 6000);
setInterval(function(){ if (numeroActivo) cargarMensajes(); }, 4000);
</script>
</body>
</html>`;
}

module.exports = function chatHandler(req, res, sock) {
  const parsed = url.parse(req.url, true);

  if (req.method === 'GET' && parsed.pathname === '/chat') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    return res.end(renderChatPanel());
  }
  if (req.method === 'GET' && parsed.pathname === '/chat') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    return res.end(renderChatPanel());
  }
  if (req.method === 'GET' && parsed.pathname === '/api/chat/conversaciones') {
    const conn = db();
    conn.query(
      `SELECT wc.numero,
              (SELECT mensaje FROM whatsapp_chat w2 WHERE w2.numero = wc.numero ORDER BY w2.id DESC LIMIT 1) AS ultimo_mensaje,
              (SELECT direccion FROM whatsapp_chat w3 WHERE w3.numero = wc.numero ORDER BY w3.id DESC LIMIT 1) AS ultima_direccion,
              MAX(wc.creado_en) AS ultimo_en,
              SUM(CASE WHEN wc.direccion='in' AND wc.leido=0 THEN 1 ELSE 0 END) AS no_leidos
       , (SELECT push_name FROM whatsapp_chat w5 WHERE w5.numero = wc.numero AND push_name IS NOT NULL ORDER BY w5.id DESC LIMIT 1) AS push_name
       FROM whatsapp_chat wc
       GROUP BY wc.numero
       ORDER BY ultimo_en DESC
       LIMIT 200`,
      [],
      (err, rows) => {
        if (err || !rows || !rows.length) {
          conn.end();
          res.writeHead(200,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({ conversaciones: [] }));
        }
        const numeros = rows.map(r => r.numero);
        conn.query(
          `SELECT phone_number, email FROM users WHERE REPLACE(REPLACE(REPLACE(phone_number,'-',''),' ',''),'+','') IN (${numeros.map(()=>'?').join(',')})`,
          numeros,
          (err2, userRows) => {
            conn.end();
            const mapa = {};
            (userRows||[]).forEach(u => {
              const norm = (u.phone_number||'').replace(/[^0-9]/g,'').slice(-10);
              if (norm) mapa[norm] = u.email;
            });
            rows.forEach(r => {
              const norm = (r.numero||'').replace(/[^0-9]/g,'').slice(-10);
              r.nombre = mapa[norm] || r.push_name || null;
            });
            res.writeHead(200,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ conversaciones: rows }));
          }
        );
      }
    );
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/chat/mensajes') {
    const numero = parsed.query.numero;
    if (!numero) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({mensajes:[]})); }
    const conn = db();
    conn.query(
      'SELECT id, jid, direccion, mensaje, leido, creado_en FROM whatsapp_chat WHERE numero=? ORDER BY id ASC LIMIT 500',
      [numero],
      (err, rows) => {
        if (err) { conn.end(); res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({mensajes:[]})); }
        conn.query('UPDATE whatsapp_chat SET leido=1 WHERE numero=? AND direccion="in" AND leido=0', [numero], () => {
          conn.end();
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ mensajes: rows }));
        });
      }
    );
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/chat/enviar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      const numero = (data.numero||'').trim();
      const mensaje = (data.mensaje||'').trim();
      if (!numero || !mensaje) { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'Faltan datos'})); }
      const conn = db();
      conn.query('SELECT jid FROM whatsapp_chat WHERE numero=? ORDER BY id DESC LIMIT 1', [numero], async (err, rows) => {
        conn.end();
        const jid = (rows && rows.length) ? rows[0].jid : (numero + '@s.whatsapp.net');
        if (!sock) { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'WhatsApp no disponible'})); }
        try {
          await sock.sendMessage(jid, { text: mensaje });
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true }));
        } catch (e2) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok:false, error: e2.message }));
        }
      });
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
};
