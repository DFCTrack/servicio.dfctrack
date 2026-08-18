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

/*
 * DFC Track - Global WhatsApp Rate Limiter
 *
 * Una sola cola FIFO para TODAS las llamadas sock.sendMessage()
 * realizadas dentro de este proceso.
 *
 * Regla:
 * - máximo un inicio de envío cada 60 segundos;
 * - SETGPS, CRM, renovaciones, registro y chat comparten la cola;
 * - la cola vive fuera del socket y sobrevive a reconexiones;
 * - cada nuevo socket recibe el mismo wrapper.
 */

const GLOBAL_WHATSAPP_INTERVAL_MS = 60000;

let globalWhatsAppQueueTail = Promise.resolve();
let globalWhatsAppLastSendStartedAt = 0;
let globalWhatsAppQueueDepth = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function installGlobalWhatsAppRateLimit(waSocket) {
    if (!waSocket || typeof waSocket.sendMessage !== 'function') {
        throw new Error('No se puede instalar rate limit: sendMessage no disponible');
    }

    if (waSocket.__dfcGlobalRateLimitInstalled) {
        return waSocket;
    }

    const originalSendMessage = waSocket.sendMessage.bind(waSocket);

    waSocket.sendMessage = function (...args) {
        globalWhatsAppQueueDepth++;

        const execute = async () => {
            try {
                const now = Date.now();

                const waitMs = Math.max(
                    0,
                    GLOBAL_WHATSAPP_INTERVAL_MS -
                    (now - globalWhatsAppLastSendStartedAt)
                );

                if (waitMs > 0) {
                    console.log(JSON.stringify({
                        event: 'whatsapp_global_rate_wait',
                        waitMs,
                        queueDepth: globalWhatsAppQueueDepth
                    }));

                    await sleep(waitMs);
                }

                globalWhatsAppLastSendStartedAt = Date.now();

                console.log(JSON.stringify({
                    event: 'whatsapp_global_send_start',
                    queueDepth: globalWhatsAppQueueDepth
                }));

                return await originalSendMessage(...args);

            } finally {
                globalWhatsAppQueueDepth--;
            }
        };

        const result = globalWhatsAppQueueTail.then(
            execute,
            execute
        );

        globalWhatsAppQueueTail = result.then(
            () => undefined,
            () => undefined
        );

        return result;
    };

    Object.defineProperty(
        waSocket,
        '__dfcGlobalRateLimitInstalled',
        {
            value: true,
            enumerable: false,
            configurable: false,
            writable: false
        }
    );

    console.log(JSON.stringify({
        event: 'whatsapp_global_rate_limit_installed',
        intervalMs: GLOBAL_WHATSAPP_INTERVAL_MS
    }));

    return waSocket;
}

// Estado operativo real de WhatsApp.
// IMPORTANTE: que sock exista NO significa que WhatsApp este conectado.
let whatsappConnection = 'starting';
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let lastDisconnectCode = null;
let lastDisconnectError = null;

async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState('/opt/baileys-servicio/session');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });

    installGlobalWhatsAppRateLimit(sock);
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
            whatsappConnection = 'open';
            lastConnectedAt = new Date().toISOString();
            lastDisconnectCode = null;
            lastDisconnectError = null;

            const connectedId = sock?.user?.id || state?.creds?.me?.id || 'desconocido';
            console.log(`✅ WhatsApp conectado - DFC Track GPS - ${connectedId}`);
        }
        if (connection === 'close') {
            whatsappConnection = 'close';
            lastDisconnectedAt = new Date().toISOString();

            const statusCode =
                lastDisconnect?.error?.output?.statusCode ??
                lastDisconnect?.error?.statusCode ??
                null;

            const errorMessage =
                lastDisconnect?.error?.message ??
                lastDisconnect?.error?.output?.payload?.message ??
                'Connection closed';

            lastDisconnectCode = statusCode;
            lastDisconnectError = errorMessage;

            console.error('❌ WhatsApp connection CLOSE', {
                statusCode,
                error: errorMessage
            });

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log('Reconectando...');
                conectar();
            } else {
                console.error('⛔ WhatsApp logged out - requiere nueva vinculacion');
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

        const expectedApiKey = process.env.DFC_CRM_API_KEY;
        const receivedApiKey = req.headers['x-api-key'];

        if (
            !expectedApiKey ||
            !receivedApiKey ||
            receivedApiKey !== expectedApiKey
        ) {
            res.writeHead(401, {
                'Content-Type': 'application/json'
            });

            res.end(JSON.stringify({
                enviado: false,
                error: 'Unauthorized'
            }));

            return;
        }

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
        const readyToSend = whatsappConnection === 'open';

        const connectedId =
            sock?.user?.id ||
            null;

        res.writeHead(readyToSend ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });

        res.end(JSON.stringify({
            service: 'dfctrack-servicio',
            api: 'online',
            whatsapp: readyToSend ? 'connected' : 'disconnected',
            connection: whatsappConnection,
            readyToSend,
            account: connectedId,
            port: 3001,
            lastConnectedAt,
            lastDisconnectedAt,
            lastDisconnectCode,
            lastDisconnectError,
            uptimeSeconds: Math.floor(process.uptime())
        }));
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
server.listen(3001, () => console.log('🚀 Servidor DFC Track en puerto 3001'));
