HEALTH=$(curl -s http://localhost:3000/health 2>/dev/null)
if echo "$HEALTH" | grep -q 'online'; then
    echo "$(date) - WhatsApp OK"
else
    echo "$(date) - WhatsApp CAIDO - reiniciando"
    pm2 restart dfctrack-whatsapp
    sleep 10
    curl -s -X POST http://localhost:3000/send       -H 'Content-Type: application/json'       -d '{"numero":"18295599999","mensaje":"⚠️ *DFC Track GPS — ALERTA*\n\nWhatsApp 809-372-5888 se desconectó y fue reiniciado.\n\nSi no reconecta entra a:\nhttp://85.239.231.210:3000/qr?token=DFC2026\n\n_Monitor DFC Track GPS_"}'
fi
