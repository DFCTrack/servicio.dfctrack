const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { buscarOCrearContacto } = require('./alegra-cliente');
const GRUPO_WHATSAPP = '120363428645050233@g.us';
function generarClave(longitud = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let clave = '';
    for (let i = 0; i < longitud; i++) {
        clave += chars[crypto.randomInt(0, chars.length)];
    }
    return clave;
}
module.exports = function handleRegistro(req, res, sock) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        const params = new URLSearchParams(body);
        const token = params.get('token');
        const email = params.get('email');
        const nombre = params.get('nombre') || '';
        const celular = (params.get('celular') || '').replace(/[^0-9]/g, '');
        if (token !== 'DFC2026xRegistro' || !email) {
            res.writeHead(403, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({status: 0, message: 'No autorizado'}));
        }
        const db = mysql.createConnection({
            host: '154.38.189.98',
            user: 'wsc_registro',
            password: 'Wr8Kd3mNpQ7fXz2LtY9bVc4H',
            database: 'gpswox_web'
        });
        db.query('SELECT id FROM users WHERE email = ?', [email], (err, rows) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 0, message: 'Error DB: ' + err.message}));
                return db.end();
            }
            if (rows && rows.length > 0) {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({status: 2, message: 'Ya existe', id: rows[0].id}));
                buscarOCrearContacto({ nombre, correo: email, whatsapp: celular, identificacion: undefined })
                    .then(r => {
                        console.log(r.ok
                            ? (r.creado ? 'Alegra: contacto creado (usuario GPSWOX ya existia)' : 'Alegra: contacto ya existia')
                            : ('Alegra: fallo - ' + r.error));
                    })
                    .catch(e => console.log('Alegra: error inesperado -', e.message));
                return db.end();
            }
            const claveGenerada = generarClave(8);
            const hash = bcrypt.hashSync(claveGenerada, 10);
            const sql = `INSERT INTO users
                (email, password, phone_number, group_id, map_id, lang,
                 unit_of_capacity, duration_format, timezone_id,
                 ungrouped_open, available_maps, sms_gateway_params, sms_gateway_url, settings,
                 email_verified_at, phone_verified_at, bienvenida_enviada,
                 created_at, updated_at)
                VALUES (?, ?, ?, 2, 1, 'es',
                 'gl', 'standart', 41,
                 '{"geofence_group":1,"device_group":1,"poi_group":1}',
                 'a:5:{i:0;s:1:"3";i:1;s:1:"1";i:2;s:1:"4";i:3;s:1:"5";i:4;s:1:"2";}',
                 'a:11:{s:11:"sms_gateway";b:0;s:14:"request_method";s:3:"get";s:15:"sms_gateway_url";s:72:"https://dfctrack.com/job/customers.php?number=%NUMBER%&message=%MESSAGE%";s:14:"custom_headers";s:0:"";s:14:"authentication";s:1:"0";s:8:"username";s:17:"info@dfctrack.com";s:8:"password";s:8:"DFC7890@";s:8:"encoding";s:1:"0";s:7:"auth_id";s:0:"";s:10:"auth_token";s:0:"";s:13:"senders_phone";s:0:"";}',
                 'https://dfctrack.com/job/customers.php?number=%NUMBER%&message=%MESSAGE%',
                 '{"widgets":{"default":"0","status":"1","list":["device","sensors","streetview","gprs_command","recent_events","location"]},"listview":{"columns":[{"field":"name","class":"device"},{"field":"status","class":"device"},{"field":"time","class":"device"},{"field":"position","class":"device"}]}}',
                 NOW(), NOW(), 0,
                 NOW(), NOW())`;
            db.query(sql, [email, hash, celular], async (err2, result) => {
                if (err2) {
                    db.end();
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({status: 0, message: 'Error creando usuario: ' + err2.message}));
                    return;
                }
                const nuevoId = result.insertId;
                db.query(
                    'INSERT INTO user_permissions (user_id, name, view, edit, remove) SELECT ?, name, view, edit, remove FROM user_permissions WHERE user_id = 1692',
                    [nuevoId],
                    (err3) => {
                        db.end();
                        if (err3) {
                            console.log('Error copiando permisos para usuario', nuevoId, ':', err3.message);
                        }
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({status: 1, message: 'Usuario creado', id: nuevoId}));
                    }
                );
                try {
                    const mensaje = `🆕 *Nuevo usuario DFC Track GPS creado*\n\n` +
                        `👤 ${nombre || '(sin nombre)'}\n` +
                        `📧 Usuario: ${email}\n` +
                        `🔑 Clave: ${claveGenerada}\n` +
                        `📱 Tel: ${celular || '(no indicado)'}`;
                    if (sock) {
                        await sock.sendMessage(GRUPO_WHATSAPP, { text: mensaje });
                        console.log('WhatsApp enviado OK al grupo');
                    }
                } catch (e) {
                    console.log('Error enviando WhatsApp de registro:', e.message);
                }
                const resultadoAlegra = await buscarOCrearContacto({ nombre, correo: email, whatsapp: celular, identificacion: undefined });
                if (resultadoAlegra.ok) {
                    console.log(resultadoAlegra.creado ? 'Alegra: contacto creado' : 'Alegra: contacto ya existia');
                } else {
                    console.log('Alegra: fallo al crear/buscar contacto -', resultadoAlegra.error);
                }
            });
        });
    });
};
