// Servidor de ProyectoLithos: salas (PeerJS) + cuentas/guardado en la nube (/api).
const http = require('http');
const { PeerServer } = require('peer');
const accounts = require('./accounts');
const port = process.env.PORT || 9000;

PeerServer({ port, path: '/', proxied: true, allow_discovery: false, corsOptions: { origin: true } }, (server) => {
  // Se intercepta /api/* antes que PeerJS; todo lo demás sigue funcionando igual.
  const old = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (accounts.handle(req, res)) return;
    for (const l of old) l.call(server, req, res);
  });
  console.log('PeerServer + cuentas escuchando en el puerto ' + port);
});
