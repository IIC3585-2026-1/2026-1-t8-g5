const path = require('node:path');
const http = require('node:http');

const express = require('express');
const { Server } = require('socket.io');

// Express provee el frontend y Socket IO comparte el mismo server HTTP.
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const publicPath = path.join(__dirname, '..', 'public');
const DEFAULT_COLOR = '#e31b23';
const MAX_HISTORY_OPERATIONS = 50_000;

// Estado compartido en la memoria. Se reinicia cuando se detiene el servidor.
let nextUserNumber = 1;
let canvasHistory = [];
const users = new Map();

app.use(express.static(publicPath));

// Comprueba que el trazo tenga coordenadas iniciales y finales válidas.
function isValidSegment(segment) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    return false;
  }

  return ['x0', 'y0', 'x1', 'y1'].every(
    (coordinate) => Number.isFinite(segment[coordinate]),
  );
}

// Comprueba que el color tenga un formato hexadecimal.
function isValidColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
}

// Comprueba que el punto de la cubeta esté dentro del canvas y tenga un color válido.
function isValidFill(fill) {
  return (
    fill
    && typeof fill === 'object'
    && Number.isFinite(fill.x)
    && Number.isFinite(fill.y)
    && fill.x >= 0
    && fill.x < 1200
    && fill.y >= 0
    && fill.y < 700
    && isValidColor(fill.color)
  );
}

// Guarda cada trazo o relleno para los usuarios que se conecten más tarde.
function saveOperation(operation) {
  canvasHistory.push(operation);
  
  // El límite evita que una sesión muy larga consuma memoria indefinidamente.
  if (canvasHistory.length > MAX_HISTORY_OPERATIONS) canvasHistory.shift();
}

// Prepara la información de los usuarios que se mostrará en el frontend.
function publicUsers() {
  return [...users.values()].map(({ id, name, color, isDrawing }) => ({
    id,
    name,
    color,
    isDrawing,
  }));
}

// Envía la lista cambiada de participantes a todos los clientes.
function emitPresence() {
  io.emit('presence:update', publicUsers());
}

// Limpia el nombre ingresado y limita su largo a 24 caracteres.
function normalizeName(name) {
  if (typeof name !== 'string') return null;

  const normalized = name.trim().replace(/\s+/g, ' ').slice(0, 24);
  return normalized || null;
}

// Se ejecuta una vez por cada pestaña que establece una conexión.
io.on('connection', (socket) => {
  const user = {
    id: socket.id,
    name: `Usuario ${nextUserNumber}`,
    color: DEFAULT_COLOR,
    isDrawing: false,
  };

  nextUserNumber += 1;
  users.set(socket.id, user);
  console.log(`${user.name} conectado: ${socket.id}`);

  // El frontend avisa cuando ya instaló sus listeners. Entonces recibe identidad,
  // historial y presencia sin la posibilidad de perder esos eventos iniciales.
  socket.on('client:ready', () => {
    socket.emit('session:info', { id: user.id, name: user.name });
    socket.emit('canvas:history', canvasHistory);
    socket.emit('server:ready', 'Conexión en tiempo real establecida');
    emitPresence();
  });

  // Actualiza el nombre visible y responde mediante acknowledge al formulario.
  socket.on('user:rename', (requestedName, acknowledge) => {
    const name = normalizeName(requestedName);

    if (!name) {
      if (typeof acknowledge === 'function') acknowledge({ updated: false });
      return;
    }

    user.name = name;
    console.log(`${socket.id} es ${user.name}`);
    emitPresence();
    if (typeof acknowledge === 'function') acknowledge({ updated: true, name });
  });

  // Mantiene actualizados el color y el indicador de "Dibujando ahora" del usuario.
  socket.on('drawing:state', (state = {}) => {
    const nextColor = isValidColor(state.color) ? state.color.toLowerCase() : user.color;
    const nextIsDrawing = Boolean(state.isDrawing);

    if (user.color === nextColor && user.isDrawing === nextIsDrawing) return;

    user.color = nextColor;
    user.isDrawing = nextIsDrawing;
    emitPresence();
  });

  // Recibe un segmento, le agrega datos del autor, lo guarda y lo retransmite.
  socket.on('drawing:segment', (segment, acknowledge) => {
    if (!isValidSegment(segment)) {
      console.warn(`Trazo inválido de ${socket.id}`);
      if (typeof acknowledge === 'function') acknowledge({ received: false });
      return;
    }

    user.color = isValidColor(segment.color) ? segment.color.toLowerCase() : user.color;

    const sharedSegment = {
      type: 'segment',
      x0: segment.x0,
      y0: segment.y0,
      x1: segment.x1,
      y1: segment.y1,
      color: user.color,
      userId: user.id,
      userName: user.name,
      // Agrupa todos los segmentos de un mismo trazo para poder deshacerlo de una vez.
      actionId: typeof segment.actionId === 'string' ? segment.actionId : `${user.id}-${Date.now()}`,
    };

    saveOperation(sharedSegment);

    // broadcast excluye al emisor porque este ya pintó el segmento localmente.
    socket.broadcast.emit('drawing:segment', sharedSegment);
    if (typeof acknowledge === 'function') acknowledge({ received: true });
  });

  // Procesa una cubeta del mismo modo que un trazo para conservar su orden.
  socket.on('canvas:fill', (fill, acknowledge) => {
    if (!isValidFill(fill)) {
      console.warn(`Relleno inválido de ${socket.id}`);
      if (typeof acknowledge === 'function') acknowledge({ received: false });
      return;
    }

    user.color = fill.color.toLowerCase();

    const sharedFill = {
      type: 'fill',
      x: fill.x,
      y: fill.y,
      color: user.color,
      userId: user.id,
      userName: user.name,
      actionId: typeof fill.actionId === 'string' ? fill.actionId : `${user.id}-${Date.now()}`,
    };

    saveOperation(sharedFill);
    socket.broadcast.emit('canvas:fill', sharedFill);
    if (typeof acknowledge === 'function') acknowledge({ received: true });
  });

  // Deshace la última acción (trazo o relleno) de quien lo solicita.
  // Se busca de atrás hacia adelante la operación más reciente de ese usuario,
  // se elimina todo lo que comparta su actionId (un trazo puede tener varios
  // segmentos) y se reenvía el historial actualizado a todos para mantener
  // la pizarra sincronizada, incluso si hay varios usuarios dibujando a la vez.
  socket.on('undo:request', (acknowledge) => {
    const lastOwnOperation = [...canvasHistory]
      .reverse()
      .find((operation) => operation.userId === user.id);

    if (!lastOwnOperation) {
      if (typeof acknowledge === 'function') acknowledge({ undone: false });
      return;
    }

    const { actionId } = lastOwnOperation;
    canvasHistory = canvasHistory.filter((operation) => operation.actionId !== actionId);

    console.log(`${user.name} deshizo su última acción (${actionId})`);
    io.emit('canvas:sync', canvasHistory);
    if (typeof acknowledge === 'function') acknowledge({ undone: true });
  });

  // Vacía la pizarra actual y la que recibirán los usuarios futuros.
  socket.on('clearCanvas', () => {
    canvasHistory = [];
    console.log(`Pizarra limpiada por ${user.name}`);
    socket.broadcast.emit('clearCanvas', { userId: user.id, userName: user.name });
  });

  // Socket IO entrega el motivo de desconexión, para logs.
  socket.on('disconnect', (reason) => {
    users.delete(socket.id);
    console.log(`${user.name} desconectado: ${socket.id} (${reason})`);
    emitPresence();
  });
});

// Se aceptan conexiones HTTP y WebSocket en el puerto configurado.
server.listen(PORT, () => {
  console.log(`Pizarra disponible en http://localhost:${PORT}`);
});
