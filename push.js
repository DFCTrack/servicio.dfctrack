'use strict';
const mysql = require('mysql2');
const webpush = require('web-push');
const url = require('url');

const DB_CONFIG = {
  host: '154.38.189.98',
  user: 'wsc_registro',
  password: 'Wr8Kd3mNpQ7fXz2LtY9bVc4H',
  database: 'gpswox_web'
};
function db() { return mysql.createConnection(DB_CONFIG); }

webpush.setVapidDetails(
  'mailto:diocuma@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const ORIGENES_PERMITIDOS = ['https://setgps.dfctrack.com', 'https://servicio.dfctrack.com'];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ORIGENES_PERMITIDOS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function pushHandler(req, res) {
  const parsed = url.parse(req.url, true);
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && parsed.pathname === '/api/push/vapid-public-key') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ publicKey: process.env.VAPID_PUBLIC_KEY }));
  }

  if (req.method === 'POST' && parsed.pathname === '/api/push/subscribe') {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      let data;
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400); return res.end('{}'); }
      const sub = data.subscription;
      if (!sub || !sub.endpoint || !sub.keys) {
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ ok:false, error:'Falta subscription' }));
      }
      const conn = db();
      conn.query(
        'INSERT INTO push_subscriptions (endpoint, p256dh, auth, creado_en) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh), auth=VALUES(auth)',
        [sub.endpoint, sub.keys.p256dh, sub.keys.auth],
        function(err) {
          conn.end();
          if (err) console.log('Error guardando push_subscription:', err.message);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: !err, error: err ? err.message : null }));
        }
      );
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function enviarPushATodos(payload) {
  const conn = db();
  conn.query('SELECT endpoint, p256dh, auth FROM push_subscriptions', [], function(err, rows) {
    conn.end();
    if (err || !rows || !rows.length) return;
    rows.forEach(function(r) {
      const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      webpush.sendNotification(subscription, JSON.stringify(payload)).catch(function(e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          const c2 = db();
          c2.query('DELETE FROM push_subscriptions WHERE endpoint=?', [r.endpoint], function() { c2.end(); });
        }
      });
    });
  });
}

module.exports = pushHandler;
module.exports.enviarPushATodos = enviarPushATodos;
