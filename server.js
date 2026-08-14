const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const http = require('http');
const fs = require('fs');
const mysql = require('mysql2');
(function cargarEnvLocal() {
    try {
        const envPath = require('path').join(__dirname, '.env');
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
    } catch (e) {}
})();
const DB_CONFIG_CHAT = {
    host: '154.38.189.98',
    user: 'wsc_registro',
    password: process.env.DB_PASS_WSC_REGISTRO,
    database: 'gpswox_web'
};
function dbChat() { return mysql.createConnection(DB_CONFIG_CHAT); }
let sock = null;
async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState('/opt/baileys-servicio/session');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n✅ QR generado — escanea desde WhatsApp\n');
            qrcode.generate(qr, { small: false });
            // Guardar QR como imagen
            const QRCode = require('qrcode');
            await QRCode.toFile('/opt/baileys/qr.png', qr, { width: 400 });
            console.log('📲 QR guardado en http://85.239.231.210:3000/qr');
        }
        if (connection === 'open') {
            console.log('✅ WhatsApp conectado - DFC Track GPS 809-372-5888');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Reconectando...');
                conectar();
            }
        }
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                const jid = msg.key.remoteJid || '';
                if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
                const jidAlt = msg.key.remoteJidAlt || jid; const numero = jidAlt.split('@')[0];
                const direccion = msg.key.fromMe ? 'out' : 'in';
                const texto = (msg.message && (
                    msg.message.conversation ||
                    (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
                    (msg.message.imageMessage && msg.message.imageMessage.caption) ||
                    (msg.message.videoMessage && msg.message.videoMessage.caption) ||
                    (msg.message.documentMessage && msg.message.documentMessage.caption)
                )) || '[mensaje no textual]';
                const messageId = msg.key.id || null;
                const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
                const conn = dbChat();
                conn.query(
                    'INSERT IGNORE INTO whatsapp_chat (jid, numero, direccion, mensaje, message_id, leido, creado_en, push_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [jid, numero, direccion, texto, messageId, direccion === 'out' ? 1 : 0, ts, msg.pushName || null],
                    () => conn.end()
                );
                if (direccion === 'in') {
                    try {
                        require('./push').enviarPushATodos({
                            title: msg.pushName || numero,
                            body: texto,
                            numero: numero
                        });
                    } catch (ePush) {
                        console.log('Error enviando push:', ePush.message);
                    }
                }
            } catch (eMsg) {
                console.log('Error guardando mensaje de chat:', eMsg.message);
            }
        }
    });
}
conectar();
// Servidor HTTP
const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/send') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const numero = data.numero.replace(/[^0-9]/g, '');
                if (data.archivo) {
                    const buf = Buffer.from(data.archivo.data, 'base64');
                    const mime = data.archivo.mime || 'application/octet-stream';
                    const nombre = data.archivo.nombre || 'archivo';
                    if (mime.startsWith('image/')) {
                        await sock.sendMessage(`${numero}@s.whatsapp.net`, { image: buf, caption: data.mensaje });
                    } else {
                        await sock.sendMessage(`${numero}@s.whatsapp.net`, { document: buf, mimetype: mime, fileName: nombre, caption: data.mensaje });
                    }
                } else {
                    await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: data.mensaje });
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ enviado: true }));
            } catch(e) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ enviado: false, error: e.message }));
            }
        });
    } else if (req.url === "/qr?token=" + (process.env.QR_ACCESS_TOKEN || '__sin_configurar__')) {
        try {
            const qr = fs.readFileSync('/opt/baileys/qr.png');
            res.writeHead(200, {'Content-Type': 'image/png'});
            res.end(qr);
        } catch(e) {
            res.writeHead(404);
            res.end('QR no disponible aun');
        }
    } else if (req.url.startsWith('/api/renovacion')) {
        require('./renovacion')(req, res, sock);
    } else if (req.url.startsWith('/servicio') || req.url.startsWith('/api/servicio') || req.url.startsWith('/nuevo') || req.url.startsWith('/buscar') || req.url.startsWith('/uploads/servicios')) {
        require('./servicio')(req, res, sock);
    } else if (req.method === 'POST' && req.url === '/registro_wsc') {
        require('./registro')(req, res, sock);
    } else if (req.url.startsWith('/chat') || req.url.startsWith('/api/chat')) {
        require('./chat')(req, res, sock);
    } else if (req.url.startsWith('/api/push')) {
        require('./push')(req, res);
    } else if (req.method === 'POST' && req.url === '/verificar') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const numero = data.numero.replace(/[^0-9]/g, '');
                const [result] = await sock.onWhatsApp(numero + '@s.whatsapp.net');
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ existe: result?.exists || false }));
            } catch(e) {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ existe: false, error: e.message }));
            }
        });
    } else if (req.url === '/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ status: sock ? 'online' : 'offline' }));
    } else if (req.url === '/groups?token=' + (process.env.QR_ACCESS_TOKEN || '__sin_configurar__')) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            const list = Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(list, null, 2));
        } catch(e) {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ error: e.message }));
        }
    } else {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html><body><h2>DFC Track GPS - WhatsApp</h2><img src="/qr" style="width:350px"><br><button onclick="location.reload()">Actualizar QR</button></body></html>');
    }
});
server.listen(3001, () => console.log('🚀 Servidor en puerto 3000'));
