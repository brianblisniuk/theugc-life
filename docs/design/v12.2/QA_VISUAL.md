# UX/UI V12.2 — Comprobación visual

- **Material:** 17 HTML (16 vistas conceptuales más una vista contextual de Pitch), 1 CSS compartido y `ui.js` mínimo de navegación.
- **Viewport:** Chromium 1440×900 (desktop) y 390×844 (móvil).
- **Resultado de la última ejecución registrada:** cero errores JavaScript durante carga, cero overflow horizontal en todos los HTML en ambas resoluciones. Valores en `qa-results.json`.
- **Enlaces:** referencias HTML locales auditadas; no se detectaron rutas a archivos faltantes dentro del paquete.
- **Capturas:** `index`, `discover`, `hotel-detail`, `pipeline`, `inbox`, `pitch`, `plans` y `design-system` en escritorio; representativas móviles para Home, Hotel Detail, Inbox, Pipeline y Onboarding.

## Limitaciones

Es una comprobación de **renderizado y consistencia visual**, no una prueba del comportamiento del producto. Solo `ui.js` abre/cierra la sidebar en móviles. El resto de botones, filtros, créditos, formularios y estados son propuestas estáticas. No hubo tests con usuarios reales ni comprobación integral por lector de pantalla. La fuente web Archivo requiere conectividad para cargarse desde Google Fonts. No se ha hecho validación de integraciones ni proveedores externos.

## Checklist recomendado en la implementación

- Desktop 1440 y 1280; móvil 390 y 320; zoom 200%.
- Un mismo identificador de oportunidad en Home, Inbox, Pipeline, Pitch y Contract Review.
- Todos los menús, modales y detalles accesibles con teclado y escape.
- Comprensión de botones primarios y secundarios sin color.
- Estados de insuficiencia de muestra, acceso bloqueado, fallo de proveedor y crédito no cobrado.
- Contraste en subtítulos y badges pequeños.
- Vistas nuevas/free sin datos fantasma, y mobile Inbox con regreso a la lista.


> **Visual theme update (V12.2):** Midnight Studio dark mode is the approved design. Brand primary `#D1FF02`, dark canvas `#0C1110`, dark sidebar `#0A0E0D`, light accessible text. See `THEME_SPEC.md` and `design-system.html`. Original V12.1 screenshots are not part of this delivery.
