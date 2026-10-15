# theugc.life — UX V3: Discover + Hotel Detail

**Estado:** propuesta visual final para revisión del MVP; NO integrada con Next.js ni producción.
**Color:** #DFFF4F. **Estética:** Light/editorial con sidebar oscura.
**Repositorio:** brianblisniuk/theugc-life. Solo se modificó esta rama de diseño; main queda intacta.

## HTML listos para abrir o pegar

- [discover-standalone.html](./discover-standalone.html) — HTML autocontenido con CSS y JS incorporados.
- [hotel-standalone.html](./hotel-standalone.html) — HTML autocontenido con CSS y JS incorporados.

En GitHub: abrir cada archivo y hacer clic en "Download raw file" (icono de descarga). Guardar AMBOS en la misma carpeta. Abrir discover-standalone.html en Chrome, Safari o Firefox. Al seleccionar un hotel se abre hotel-standalone.html. También se puede copiar su código completo a un visualizador HTML.

Internet es necesario para la tipografía de Google Fonts, Leaflet y la base cartográfica CARTO/OpenStreetMap. Sin conexión, la UI sigue operativa y el mapa muestra fallback.

## Despliegue modular opcional (Netlify)

- index.html (entrada por defecto), discover.html y hotel.html
- styles.css (diseño responsive)
- app.js (interacciones de demostración)

Desplegar toda la carpeta ux-v3, conservando rutas relativas.

## Qué permite probar

1. Sidebar persistente en desktop y menú lateral móvil: Home, Discover, My Trips, Pipeline, Inbox, Collaborations, My Profile y Plans & Credits, con descripción de cada función.
2. Mapa destacado arriba de Discover, con agrupación interactiva de marcadores; zoom sobre clusters de hoteles ilustrativos. Este prototipo usa Leaflet; en la app real se debe reutilizar Google Maps existente y añadir @googlemaps/markerclusterer si se implementa clustering.
3. Filtros por destino, tipo y actividad; selección de un Trip opcional.
4. Save abre elección entre guardar en Pipeline (Save for later) o añadir a la shortlist de un Trip (Add to a trip).
5. Crear un Trip desde Discover con nombre, destino y fechas; se simulan restricciones Free.
6. Selector Free/Pro/Max. Paywall visible en clasificación de respuestas, tiempos de respuesta y Creator Fit.
7. Creator Activity Radar en forma de propuesta premium; SIN heatmap falso ni tasas inferidas. Pro/Max indican que la cobertura todavía está en construcción.
8. Hotel Detail con mapa pequeño, Creator Intelligence, Creator Fit, contacto independiente de la suscripción, y próxima acción.
9. El estado de demo se guarda exclusivamente en localStorage; no toca cuentas ni datos reales.

## Advertencia sobre datos

TODOS los hoteles, localizaciones, números, clasificaciones, actividades y tasas son datos de muestra completamente ficticios. Las coordenadas se sitúan aproximadamente en ciudades reales, no corresponden a hoteles reales. Por ello la demo nunca envía correos, no cobra créditos y no consulta proveedores de contacto.

**Nunca incorporar datos premium reales en JS enviado a Free.** En producción, los entitlements y umbrales de confianza deben aplicarse en servidor. Aquí las métricas son completamente falsas y se usan para demostrar interacciones.

## Integración con código actual — trabajo pendiente

- Sustituir arrays de ejemplo por searchHotels/getHotelById, lecturas públicas y premium con autorización.
- Conectar saveHotelAction, addTripHotelAction y createTripAction. Mantener errores y límites del servidor.
- Usar Google Maps real y clustering consistente con la paginación de Discover.
- Integrar fotos reales con atribución/permisos. No simular fotos de hoteles.
- Crear estados de carga, sin resultados, permisos y errores por superficie.
- Conectar enlaces de sidebar a rutas reales.
- Reemplazar Sun #FFE01B por #DFFF4F en tokens y documentación después de aprobar diseño.
- Testear accesibilidad, mobile, pago, datos privados, errores y navegación de Trips.
- Radar de calor solo después de reunir datos geográficos públicos suficientes y umbrales anti-reidentificación.

## Decisión de paywall pendiente

El repositorio actual permite descubrir TODOS los hoteles publicados desde Free y limita la inteligencia premium. Limitar a Free a un catálogo parcial como Hotel Collab AI requeriría un cambio explícito en la estrategia, los derechos de acceso, los servicios y las pruebas. Este prototipo no impone esa modificación silenciosamente, pero incluye varios paywalls de alto valor para datos y capacidades.

## Aclaración

Esta rama entrega prototipos de diseño listos para validación y handoff. No equivale a código Next.js integrado ni a un MVP listo para despliegue de producción.
