# theugc.life · V12.2 · Handoff UX/UI para Cursor

## Objetivo

Convertir el **prototipo visual V12.2** en una sola experiencia de creador UGC para hoteles sin perder el contexto de una tarea al cambiar de pantalla. El código HTML es la **referencia de interfaz y lenguaje visual**: no debe asumirse que sus controles ya ejecutan acciones, ni copiar valores de demostración a producción.

## 1. Conceptos canónicos de producto

| Entidad | Identidad conceptual | Qué comparte y qué NO |
|---|---|---|
| Creator | Usuario y portfolio | Datos personales / trabajos / preferencias; controla sus Trips, iniciativas y oportunidades |
| Hotel | `hotelId` | Único catálogo, datos descriptivos y contactos autorizados; no contiene el estado de una negociación específica |
| Contact | Contacto profesional asociado al hotel | Nombre, rol, email, calidad/procedencia, fechas de comprobación; **no** se divulga antes del desbloqueo autorizado |
| Contact Unlock | `creatorId + hotelId` | Estado de acceso al conjunto elegible de contactos de ese hotel; 1 crédito al primer desbloqueo exitoso |
| Trip | `tripId` | Destino, fechas y shortlist; puede existir sin outreach o acuerdos |
| Outreach Initiative | `outreachId` | Motivo o grupo de contactos por destino, con Trip opcional; agrupa oportunidades, no duplica hoteles |
| Opportunity | `opportunityId` | **Intento comercial específico** entre un creador y un hotel; contexto de Outreach y Trip opcionales, etapa e historial propios |
| Pitch | `pitchId`, `opportunityId` | Estrategia, tono, destinatario, asunto, cuerpo, revisión, borrador y procedencia de las afirmaciones |
| Conversation | `threadId`, `opportunityId` | Mensajes y estado del hilo; visibilidad y permisos definidos por creador |
| Collaboration | `collaborationId`, `opportunityId` | Acuerdo confirmado, entregables, revisiones, fechas y compensaciones |
| Contract Review | `documentId`, `opportunityId` | Documento original, fragmentos citados y observaciones; no equivale a verificación jurídica |
| Credit Event | `creatorId`, `hotelId`, resultado | Saldo y movimientos; distingue éxito, error y reapertura; nunca doble cargo por el mismo hotel desbloqueado |

**Regla de oro:** `hotelId` mantiene información del alojamiento; `opportunityId` mantiene el estado de **cada acercamiento comercial**. Un mismo hotel puede figurar en OP-1042 y OP-1084 con fechas, iniciativas y etapas distintas.

## 2. Recorridos que deben funcionar de verdad

### A. Voy a viajar
`My Trips` → agregar hoteles desde `Discover` → `Start outreach` → precargar shortlist de ese Trip → `Pitch Studio` con destino, fechas y perfil → `Pipeline` → `Inbox` cuando responda.

- Crear un Trip no exige iniciar outreach.
- `Start outreach` no exige re-seleccionar hoteles ya guardados.
- Si aparecen nuevos hoteles en el Trip, ofrecer **Import new hotels**; no modificarlos silenciosamente en una iniciativa ya en marcha.
- Abrir Hotel Detail y volver devuelve al usuario sus filtros, mapa, orden, Trip y posición.

### B. No sé cuándo viajaré
`Discover` → shortlist/opportunity → `Outreach` **sin Trip** → hotel y pitch → `Pipeline`. Nunca pedir fechas ficticias.

### C. Me respondió un hotel
`Home` prioritiza respuesta real → `Inbox` abre hilo específico → responder o preparar respuesta → `Pipeline` mismo `opportunityId` → seguimiento y estado. Separar enviada/recibida por Gmail de entrada manual.

### D. Me confirmaron una colaboración
`Pipeline` Agreement → `Contract Review` documento de **esa oportunidad** → `Collaborations` entregables y plazos → `My Trips` noches confirmadas sólo tras confirmación → `Home` próxima entrega.

### E. Estoy en Free
`Onboarding` → `Discover` → `Hotel Detail` → vista previa sin PII → `Unlock hotel contacts · 1 credit` al lograrlo → `Pitch Studio` manual → Upsell Pro contextual al necesitar funciones restringidas.

## 3. Responsabilidad por pantalla

| Pantalla | Pregunta que resuelve | CTA principal |
|---|---|---|
| Home | ¿Qué merece mi atención hoy? | Resolver la prioridad del momento |
| Discover | ¿Qué hotel vale la pena investigar? | Ver hotel / guardar oportunidad |
| Hotel Detail | ¿Tiene sentido contactarlo y quién es la persona correcta? | Desbloquear contacto / preparar pitch |
| My Trips | ¿Qué alojamiento necesito asegurar para mis fechas? | Continuar outreach del viaje |
| Outreach | ¿Qué hoteles contacto en esta iniciativa? | Preparar/revisar siguiente pitch |
| Pipeline | ¿En qué etapa está cada intento comercial? | Abrir oportunidad y decidir próximo paso |
| Pitch Studio | ¿Qué propuesta concreta mando a este hotel? | Guardar borrador / revisar y continuar |
| Inbox | ¿A quién debo responder o seguir? | Atender conversación pendiente |
| Collaborations | ¿Qué debo entregar y cuándo? | Completar siguiente entregable |
| Contract Review | ¿Qué términos debo entender antes de aceptar? | Revisar cláusula concreta |
| My Profile | ¿Cómo demuestro mi capacidad? | Completar y previsualizar portfolio |
| Plans & Credits | ¿Qué gano al pagar o subir de plan? | Elegir capacidad adecuada |
| Billing & Activity | ¿Qué pasó con mis créditos y pagos? | Consultar movimiento / gestionar plan |
| Getting Started | ¿Cómo consigo mi primer progreso? | Completar primera acción significativa |

## 4. Estados y origen de información

### Etapas de Opportunity
`Saved` → `Pitch ready` → `Sent` → `Replied` → `Negotiating` → `Agreed` o `Closed`. Un rebote es un **evento de salud del contacto**, no sinónimo de que la oportunidad terminó. Acciones de etapa pueden producirse desde Inbox o Pipeline, pero **un solo registro** debe proyectarse en todas las pantallas.

### Entregables
`To do` → `In progress` → `Submitted` → `Revision requested` → `Approved`. `Agreed` en Pipeline nunca pone todos los entregables en `Approved`.

### Evidencia
Distinguir siempre:
- `Verified via Gmail`: evento autorizado que corresponde a la cuenta conectada.
- `Manually recorded`: afirmación registrada por el creador, útil para su organización, no para estadísticas agregadas verificadas.
- `Sample only`: datos inventados para el prototipo (ver `scenario.json`).
- `Insufficient data`: no hay evidencia publicable; nunca mostrar `0%` en su lugar.
- `Verification pending`: contacto, documento o evento todavía no comprobado.

**No inferir** acceptance probability, deal strength, rank predictivo ni score de calidad si no existe método probado.

## 5. Contactos y créditos

- El producto vale por llegar al equipo **responsable** de colaboraciones, marketing, PR o ventas. No garantizar siempre al decisor final.
- Calidad de contacto: persona nombrada y verificada / persona nombrada provisional / contacto departamental / ninguno disponible.
- Bloqueado: dibujar solo placeholders sin nombre/correo en DOM, JSON ni respuestas de red.
- Cobro: 1 crédito **por hotel** en la revelación exitosa; si el proveedor sólo obtiene un email válido, mostrarlo sin prometer varios contactos. El caché puede mostrar otros ya obtenidos sin coste extra si son elegibles.
- Lookup fallido 0; segundo acceso al mismo hotel 0; nunca presentar una operación de demo como cargo real.
- Créditos orientativos de UX usados: Free 5 por 7 días, Pro 150/mes, Max 500/mes; precios no definidos aquí.
- Free puede crear propuesta manual; Gmail directo es una función restringida hasta decisión formal del producto.

## 6. Sistemas de diseño

Archivo, fondo editorial claro, sidebar oscura, lime `#D1FF02` como *acento de acción principal*. Referencia exacta: `styles.css` y `design-system.html`. Priorizar cuerpo 14px+, secundarios 12–14px en contextos relevantes, h1 30–41px. En responsive, lista → detalle → contexto sin comprimir tres columnas. Las acciones premium deben informar por qué desbloquear, sin convertir cada tarjeta en un anuncio.

### Componentes obligatorios
Sidebar, topbar, breadcumbs, barra contextual, hotel list item, intelligence card, metric ring, empty/skeleton/error states, contact teaser, credit ledger, Trip night coverage, outreach leads, pipeline board/list/timeline, opportunity detail panel, pitch editor + review, inbox message and hotel context, deliverable item, source-linked contract observation, portfolio preview, plan comparison, confirmation dialog.

### Estados obligatorios
`Loading`, `Empty`, `Insufficient data`, `Locked`, `Insufficient credits`, `Success`, `Partial success`, `Failed / Retry`, `Saved / Unsaved`, `Verification pending`, `Access changed`, `Disconnected email`, `Manual only`.

## 7. Qué representa el material entregado

- HTML = apariencia, copy, jerarquía, rutas del recorrido y prioridades visuales.
- `scenario.json` = datos ilustrativos compartidos y referencias de la misma oportunidad entre páginas. **No** migrar como catálogo real.
- Botones sin lógica = intenciones de interacción para implementar; no asumir acciones reales.
- `ui.js` = únicamente abrir/cerrar navegación móvil en la preview.
- Imágenes abstractas = placeholders intencionales; no asumir que corresponden a hoteles reales o fotos licenciadas.
- Saldo de créditos, actividad, fechas y tasas de respuesta = valores de muestra.

## 8. Criterios de aceptación para Cursor / QA

1. Un mismo hotel puede tener **dos oportunidades** sin que cambiar una modifique otra.
2. Del Trip a Outreach, la shortlist se reutiliza **sin paso duplicado**.
3. Outreach se puede iniciar **sin Trip**.
4. Hotel Detail conserva la búsqueda completa al volver.
5. Home identifica una acción urgente en menos de diez segundos.
6. Una respuesta Gmail válida cambia la prioridad de Inbox y Pipeline de la oportunidad correcta.
7. Entrada manual y evento verificado mantienen origen diferente visible.
8. Guardar un draft no lo marca como enviado.
9. Verificar desbloqueo válido consume 1 crédito por hotel; fallo o reapertura no consumen.
10. Free nunca recibe valores premium o emails ocultos por CSS en el cliente.
11. Una oportunidad acordada puede tener entregables pendientes; contrato permanece asociado a la misma oportunidad.
12. My Trips no cuenta dos veces noches superpuestas y no trata `Pending` como confirmado.
13. Las acciones y los estados de plan son consistentes en Plans, Hotel Detail y Billing.
14. A 390px y 1440px toda tarea clave tiene salida y no hay overflow horizontal.
15. Navegación accesible con teclado, foco evidente y sin señales apoyadas solo en el color.

## 9. Pendientes de validación humana UX

Las pantallas están diseñadas, pero faltan pruebas de usabilidad observadas con creadores nuevos y experimentados; feedback de contexto real, comparaciones Free/Pro/Max, casos de hotel sin contacto y pruebas de errores/respuesta Gmail. No declarar UX sign-off final solo por captura y HTML.

## Fuera de alcance explícito

Offer Builder, portal Hotel Claim, machine learning predictivo, estadísticas inventadas, Gmail real, cobros, provider Hunter/Snov, despliegue, y arquitectura técnica definitiva de base de datos. Este documento guía el comportamiento esperado sin prescribir una implementación tecnológica.


> **Visual theme update (V12.2):** Midnight Studio dark mode is the approved design. Brand primary `#D1FF02`, dark canvas `#0C1110`, dark sidebar `#0A0E0D`, light accessible text. See `THEME_SPEC.md` and `design-system.html`. Original V12.1 screenshots are not part of this delivery.
