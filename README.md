# Pizarra collab

App construida con Node.js, Express, Socket.IO y Canvas HTML5. Se permite que varias personas dibujen simultáneamente y vean los cambios en tiempo real.

## Funcionamiento general

- El cliente captura eventos de mouse, touch, etc y convierte su posición a coordenadas del canvas.
- Cada trazo se divide en segmentos entre dos puntos consecutivos y se envía al servidor como JSON.
- El servidor valida los datos y usa `broadcast` para retransmitirlos a los demás clientes.
- La cubeta utiliza un algoritmo **Flood Fill** para rellenar píxeles contiguos hasta encontrar los límites de una figura.
- Trazos y rellenos se guardan en un historial ordenado en memoria, permitiendo reconstruir la pizarra para usuarios que llegan después.
- También se sincronizan colores, participantes, estados de dibujo y la limpieza del canvas.

## Archivos principales

| Archivo | Responsabilidad |
| --- | --- |
| `server/index.js` | Inicia Express y Socket.IO, administra usuarios e historial, valida eventos y retransmite trazos, rellenos y limpieza. |
| `public/index.html` | Define la interfaz, canvas, herramientas, colores, identidad y participantes. |
| `public/client.js` | Maneja el Canvas 2D, Pointer Events, Flood Fill y la comunicación Socket.IO del navegador. |
| `public/styles.css` | Contiene el diseño responsive, colores y estados visuales de la aplicación. |
| `package.json` | Define dependencias y comandos para iniciar el proyecto. |
| `package-lock.json` | Fija las versiones exactas de las dependencias instaladas. |

## Uso de IA

Se utilizó IA en los siguientes aspectos:

- **Planificación:** ayudó a dividir el trabajo en tarjetas de JIRA, con descripción, subtareas y criterios de aceptación.
- **Algoritmo Flood Fill:** ayudó a comprender e implementar el algoritmo usado por la cubeta. Este comienza en el píxel seleccionado, identifica su color y recorre los píxeles contiguos que comparten ese color, reemplazándolos hasta encontrar los límites dibujados en el canvas.
- **Corrección de errores:** apoyó la detección del problema donde un segundo usuario solo veía los trazos nuevos. La solución fue guardar trazos y rellenos en un historial ordenado en el servidor y enviarlo al cliente cuando se conecta.
- **Diseño:** ayudó a organizar una interfaz inspirada en Paint, con herramientas visibles, selector de colores, cubeta, botón de limpieza y área de dibujo.

## Ejecutar localmente

```bash
npm install
npm start
```
