// Conexión con Socket IO y referencias a los elementos visuales de la página.
const socket = io();
const status = document.querySelector('#connection-status');
const statusText = status.querySelector('span:last-child');
const canvas = document.querySelector('#drawing-board');
const context = canvas.getContext('2d');
const clearButton = document.querySelector('#clear-canvas');
const undoButton = document.querySelector('#undo-action');
const colorButtons = document.querySelectorAll('[data-color]');
const drawToolButton = document.querySelector('#draw-tool');
const fillToolButton = document.querySelector('#fill-tool');
const participantsList = document.querySelector('#participants');
const participantCount = document.querySelector('#participant-count');
const identityForm = document.querySelector('#identity-form');
const displayNameInput = document.querySelector('#display-name');
const activity = document.querySelector('#activity');

// Estado local de la herramienta y del usuario actual.
let isDrawing = false;
let previousPoint = null;
let currentUserId = null;
let selectedColor = '#e31b23';
let selectedTool = 'draw';
let activityTimer = null;
let currentActionId = null;

// Genera un identificador simple para agrupar los segmentos de un mismo trazo.
function createActionId() {
  return (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

context.lineWidth = 4;
context.lineCap = 'round';
context.lineJoin = 'round';

// Convierte las coordenadas del puntero a la resolución interna del canvas.
// Mantiene el dibujo alineado aunque el lienzo cambie de tamaño con CSS.
function getCanvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();

  return {
    x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
    y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
  };
}

function setActivity(message, temporary = false) {
  window.clearTimeout(activityTimer);
  activity.textContent = message;

  if (temporary) {
    activityTimer = window.setTimeout(() => {
      activity.textContent = 'Todos los trazos están sincronizados.';
    }, 1800);
  }
}

function startDrawing(event) {
  // Solo se procesa el puntero principal para evitar trazos con varios dedos.
  if (!event.isPrimary || event.button !== 0) return;

  event.preventDefault();

  if (selectedTool === 'fill') {
    const point = getCanvasPoint(event);
    const fill = { x: point.x, y: point.y, color: selectedColor, actionId: createActionId() };

    if (fillArea(fill)) {
      socket.emit('canvas:fill', fill);
      setActivity('Relleno sincronizado con todos.', true);
    }
    return;
  }

  // La captura permite continuar el trazo aunque el puntero salga del canvas.
  canvas.setPointerCapture(event.pointerId);
  isDrawing = true;
  previousPoint = getCanvasPoint(event);
  currentActionId = createActionId();
  socket.emit('drawing:state', { isDrawing: true, color: selectedColor });
  setActivity('Estás dibujando…');
}

function drawSegment(segment) {
  context.strokeStyle = segment.color || '#172033';
  context.beginPath();
  context.moveTo(segment.x0, segment.y0);
  context.lineTo(segment.x1, segment.y1);
  context.stroke();
}

// Utilidades de color usadas por el algoritmo de la cubeta.
function hexToRgba(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

function pixelMatches(data, index, color) {
  return (
    data[index] === color[0]
    && data[index + 1] === color[1]
    && data[index + 2] === color[2]
    && data[index + 3] === color[3]
  );
}

function paintPixel(data, index, color) {
  data[index] = color[0];
  data[index + 1] = color[1];
  data[index + 2] = color[2];
  data[index + 3] = color[3];
}

// Flood fill por columnas, se reemplazan los píxeles conectados que tengan el mismo
// color que el punto inicial. Devuelve false si el área ya tiene el color elegido.
function fillArea(fill) {
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(fill.x)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(fill.y)));
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  const targetIndex = (y * canvas.width + x) * 4;
  const targetColor = Array.from(data.slice(targetIndex, targetIndex + 4));
  const replacementColor = hexToRgba(fill.color);

  if (targetColor.every((channel, index) => channel === replacementColor[index])) {
    return false;
  }

  const pending = [[x, y]];

  while (pending.length > 0) {
    const [column, startRow] = pending.pop();
    let row = startRow;
    let index = (row * canvas.width + column) * 4;

    // Busca el primer píxel del bloque vertical que contiene el punto pendiente.
    while (row >= 0 && pixelMatches(data, index, targetColor)) {
      row -= 1;
      index -= canvas.width * 4;
    }

    row += 1;
    let reachesLeft = false;
    let reachesRight = false;

    // Pinta el bloque y agenda las regiones aledañas de izquierda y derecha.
    while (row < canvas.height) {
      index = (row * canvas.width + column) * 4;
      if (!pixelMatches(data, index, targetColor)) break;

      paintPixel(data, index, replacementColor);

      if (column > 0) {
        const leftMatches = pixelMatches(data, index - 4, targetColor);
        if (leftMatches && !reachesLeft) pending.push([column - 1, row]);
        reachesLeft = leftMatches;
      }

      if (column < canvas.width - 1) {
        const rightMatches = pixelMatches(data, index + 4, targetColor);
        if (rightMatches && !reachesRight) pending.push([column + 1, row]);
        reachesRight = rightMatches;
      }

      row += 1;
    }
  }

  context.putImageData(image, 0, 0);
  return true;
}

// El historial mezcla trazos y rellenos, cada operación indica su tipo.
function applyCanvasOperation(operation) {
  if (operation.type === 'fill') {
    fillArea(operation);
    return;
  }

  drawSegment(operation);
}

function draw(event) {
  if (!isDrawing) return;

  event.preventDefault();

  if ((event.buttons & 1) !== 1) {
    stopDrawing();
    return;
  }

  const currentPoint = getCanvasPoint(event);
  const segment = {
    x0: previousPoint.x,
    y0: previousPoint.y,
    x1: currentPoint.x,
    y1: currentPoint.y,
    color: selectedColor,
    actionId: currentActionId,
  };

  // Se pinta primero de forma local.
  // Luego el servidor retransmite el mismo segmento a los demás clientes.
  drawSegment(segment);
  socket.emit('drawing:segment', segment);
  previousPoint = currentPoint;
}

function stopDrawing() {
  if (!isDrawing) return;

  isDrawing = false;
  previousPoint = null;
  socket.emit('drawing:state', { isDrawing: false, color: selectedColor });
  setActivity('Tu trazo quedó sincronizado.', true);
}

function clearCanvas() {
  stopDrawing();
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function selectColor(button) {
  selectedColor = button.dataset.color;
  colorButtons.forEach((colorButton) => {
    const isSelected = colorButton === button;
    colorButton.classList.toggle('color-swatch--selected', isSelected);
    colorButton.setAttribute('aria-pressed', String(isSelected));
  });
  socket.emit('drawing:state', { isDrawing, color: selectedColor });
}

function selectTool(tool) {
  stopDrawing();
  selectedTool = tool;
  const isFill = tool === 'fill';

  drawToolButton.classList.toggle('tool-button--selected', !isFill);
  drawToolButton.setAttribute('aria-pressed', String(!isFill));
  fillToolButton.classList.toggle('tool-button--selected', isFill);
  fillToolButton.setAttribute('aria-pressed', String(isFill));
  canvas.classList.toggle('canvas--fill', isFill);
  setActivity(isFill ? 'Cubeta activa: haz clic dentro de un área cerrada.' : 'Lápiz activo: arrastra para dibujar.');
}

function renderParticipants(users) {
  participantCount.textContent = users.length;
  participantsList.replaceChildren();

  users.forEach((user) => {
    const item = document.createElement('li');
    const badge = document.createElement('span');
    const details = document.createElement('span');
    const name = document.createElement('strong');
    const state = document.createElement('small');

    item.className = `participant${user.isDrawing ? ' participant--drawing' : ''}`;
    badge.className = 'participant__badge';
    badge.style.backgroundColor = user.color;
    badge.textContent = user.name.slice(0, 1).toUpperCase();
    name.textContent = `${user.name}${user.id === currentUserId ? ' (tú)' : ''}`;
    state.textContent = user.isDrawing ? 'Dibujando ahora' : 'En línea';
    details.append(name, state);
    item.append(badge, details);
    participantsList.append(item);
  });
}

// Se permite compartir esta lógica entre mouse, touch y lápiz digital, de tal forma de que el ambiente touch esté abarcado
canvas.addEventListener('pointerdown', startDrawing);
canvas.addEventListener('pointermove', draw);
canvas.addEventListener('pointerup', stopDrawing);
canvas.addEventListener('pointercancel', stopDrawing);
canvas.addEventListener('lostpointercapture', stopDrawing);
canvas.addEventListener('dragstart', (event) => event.preventDefault());
drawToolButton.addEventListener('click', () => selectTool('draw'));
fillToolButton.addEventListener('click', () => selectTool('fill'));

colorButtons.forEach((button) => {
  button.style.backgroundColor = button.dataset.color;
  button.addEventListener('click', () => selectColor(button));
});

clearButton.addEventListener('click', () => {
  clearCanvas();
  socket.emit('clearCanvas');
  setActivity('Limpiaste la pizarra para todos.', true);
});

undoButton.addEventListener('click', () => {
  socket.emit('undo:request', (response) => {
    if (!response || !response.undone) {
      setActivity('No tienes trazos propios para deshacer.', true);
      return;
    }

    setActivity('Deshiciste tu última acción.', true);
  });
});

identityForm.addEventListener('submit', (event) => {
  event.preventDefault();
  socket.emit('user:rename', displayNameInput.value, (response) => {
    if (!response.updated) {
      displayNameInput.focus();
      return;
    }

    displayNameInput.value = response.name;
    setActivity(`Ahora apareces como ${response.name}.`, true);
  });
});

// Eventos recibidos desde el servidor ws.
socket.on('connect', () => {
  status.classList.add('connection-status--online');
  statusText.textContent = 'Conectado';
  socket.emit('client:ready');
});

socket.on('session:info', (session) => {
  currentUserId = session.id;
  displayNameInput.value = session.name;
});

socket.on('server:ready', (message) => {
  console.log(message);
});

socket.on('presence:update', renderParticipants);

function renderHistory(operations) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  operations.forEach(applyCanvasOperation);
}

socket.on('canvas:history', (operations) => {
  // Un usuario que llega después reconstruye la pizarra en el orden original de creación.
  renderHistory(operations);
  setActivity(
    operations.length > 0
      ? `Recuperamos ${operations.length} acciones anteriores.`
      : 'La ciudad está tranquila. Empieza a dibujar.',
  );
});

socket.on('canvas:sync', (operations) => {
  // El servidor reenvía el historial completo tras un "deshacer" para mantener a todos sincronizados.
  renderHistory(operations);
});

socket.on('drawing:segment', (segment) => {
  drawSegment(segment);
  setActivity(`${segment.userName} está dibujando.`, true);
});

socket.on('canvas:fill', (fill) => {
  fillArea(fill);
  setActivity(`${fill.userName} usó la cubeta.`, true);
});

socket.on('clearCanvas', ({ userName } = {}) => {
  clearCanvas();
  setActivity(`${userName || 'Otro usuario'} limpió la pizarra.`, true);
});

socket.on('disconnect', () => {
  status.classList.remove('connection-status--online');
  statusText.textContent = 'Reconectando…';
  setActivity('Se perdió la conexión con el servidor.');
});

socket.on('connect_error', () => {
  status.classList.remove('connection-status--online');
  statusText.textContent = 'Sin conexión';
});
