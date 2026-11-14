// Servidor de salas (signaling) para ProyectoLithos. Solo reparte códigos; el juego va directo entre celulares.
const { PeerServer } = require('peer');
const port = process.env.PORT || 9000;
PeerServer({ port, path: '/', proxied: true, allow_discovery: false, corsOptions: { origin: true } });
console.log('PeerServer escuchando en el puerto ' + port);
