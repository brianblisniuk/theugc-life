# theugc.life — UX/UI V12.2 · Consolidación visual y de experiencia

**Estado:** prototipo **visual y navegable**, preparado para especificar la implementación a Cursor. **No es una aplicación funcional, no está integrado con backend y no realiza operaciones reales.**

## Abrir

Abrí `index.html` en el navegador. Todas las páginas comparten `styles.css` y un pequeño `ui.js` para abrir/cerrar la navegación móvil. Los enlaces HTML conectan las pantallas dentro de esta carpeta. Para la fuente Archivo es recomendable tener conexión a Internet; la tipografía de reserva funciona sin ella.

**Descarga:** conservá todos los archivos juntos y abrí `index.html`. Si lo servís desde un servidor estático también funciona; no requiere NPM.

## Qué contiene

| Área | Archivo | Función en el recorrido del creador |
|---|---|---|
| Inicio | `index.html` / `home.html` | Muestra solo prioridades, próximo viaje, campaña y último contexto |
| Búsqueda | `discover.html` | Encontrar hoteles y comparar señales antes del clic |
| Ficha hotel | `hotel-detail.html` | Inteligencia y contacto relevante como protagonistas |
| Viajes | `trips.html` | Destino, fechas, shortlist y cobertura de noches |
| Campañas | `outreach.html` | Organizar el acercamiento comercial, con o sin viaje |
| Oportunidades | `pipeline.html` | Vista global y estados de cada intento comercial |
| Propuesta | `pitch.html` | Preparación y revisión de un mensaje personalizado |
| Propuesta contextual | `pitch-op-1042.html` | Ejemplo ligado a una oportunidad específica |
| Mensajes | `inbox.html` | Atender respuestas y tomar decisiones con contexto |
| Acuerdos activos | `collaborations.html` | Entregables, plazos y siguiente tarea |
| Contratos | `contracts.html` | Lectura del documento y observaciones vinculadas al texto |
| Portfolio | `profile.html` | Presentación de capacidades y trabajos ante hoteles |
| Planes | `plans.html` | Entender Free, Pro y Max y el uso de créditos |
| Facturación | `billing.html` | Ver movimientos y estados de pago sin ambigüedad |
| Primer uso | `onboarding.html` | Empezar desde la intención comercial, no desde un formulario largo |
| Sistema visual | `design-system.html` | Patrones, tokens, tipografía, componentes y estados |

## Las decisiones UX que consolida

1. **Una navegación para todo.** Sidebar, topbar, breadcrumbs y sistema móvil consistente.
2. **Hotel ≠ Opportunity.** Un hotel tiene una identidad, perfil y contactos únicos. Dos negociaciones diferentes con ese hotel tienen IDs de oportunidad, estados y notas distintos.
3. **Trip ≠ Outreach ≠ Pipeline.** Trip es fecha y destino, Outreach es la iniciativa de contacto y Pipeline es el seguimiento global.
4. **Sin volver a empezar.** El Trip debe transferir su shortlist a Outreach; Discover debe recuperar filtros y posición; Pitch hereda contexto de hotel y oportunidad.
5. **Información confiable.** Diferenciar datos publicados con muestra suficiente, señales sin datos y eventos registrados manualmente. Los valores del prototipo son ilustrativos.
6. **Contacto profesional con valor comercial.** Revelación por hotel a 1 crédito cuando el desbloqueo sea exitoso. Sin cargo por fallos ni por reabrir lo previamente desbloqueado. La vista previa muestra bloques esquemáticos, no emails escondidos.
7. **Home sin ruido.** Próxima acción, conversaciones que necesitan respuesta, seguimiento, próximo viaje y continuidad.
8. **Tipografía y señales legibles.** Diseño editorial claro, Archivo, sidebar oscura y acento `#D1FF02` para la acción principal.
9. **Diseño no es evidencia de funcionalidad.** Los CTA, filtros, balances, mensajes, análisis de contrato y estados son ejemplos visuales; Cursor debe implementar y validar sus comportamientos.

## Prueba recomendada de continuidad visual

1. `index.html`: atención prioritaria sobre *Siam Canopy House*.
2. `inbox.html`: respuesta ilustrativa del mismo hotel / OP-1042.
3. `pipeline.html`: oportunidad **OP-1042**; identificar otra oportunidad del mismo hotel (**OP-1084**) y comprobar que no se confunden sus contextos.
4. `pitch-op-1042.html`: mismo hotel y misma oportunidad.
5. `trips.html` → `outreach.html`: el viaje es un contexto opcional, no un duplicado de la campaña.
6. `collaborations.html` → `contracts.html`: asociación correcta entre el trabajo confirmado y sus términos.
7. `plans.html` → `billing.html`: mismo significado de crédito en ambos lugares.

## Datos, pruebas y documentación

- `scenario.json`: un solo conjunto de datos ilustrativos compartidos por las pantallas. **No es una fuente real de hoteles ni de analítica.**
- `CURSOR_UX_HANDOFF.md`: contrato de UX, modelo conceptual, interacciones esperadas y criterios de aceptación para implementación.
- `QA_VISUAL.md`: metodología y alcance de las comprobaciones visuales realizadas.
- `qa-results.json`: resultados instrumentales de renderizado en 1440 y 390 px.
- Capturas `*-1440.png`, `*-390.png`: vistas de referencia en escritorio y móvil.

## No forma parte de V12.2

Gmail real, verificación de contactos, desbloqueo cobrado, facturación, conexión con IA, motor de contratos, persistencia entre pantallas, límites por plan, algoritmos predictivos, generación de emails y seguimiento automático. **La ingeniería, permisos, datos y lógica corresponden a Cursor.**

Tampoco se consultó ni modificó el repositorio del producto.


> **Visual theme update (V12.2):** Midnight Studio dark mode is the approved design. Brand primary `#D1FF02`, dark canvas `#0C1110`, dark sidebar `#0A0E0D`, light accessible text. See `THEME_SPEC.md` and `design-system.html`. Original V12.1 screenshots are not part of this delivery.
