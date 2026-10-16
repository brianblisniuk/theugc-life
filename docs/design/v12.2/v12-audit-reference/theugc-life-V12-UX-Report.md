# theugc.life · V12 — UX/UI Audit

**Veredicto:** identidad visual sólida; la UX no está lista para cierre integral hasta resolver continuidad y navegación.

## Evidencia y alcance

Se revisaron 11 HTML de V7–V11 y se renderizaron a 1440×900 y 390×844 en Chromium. No hubo overflow horizontal ni errores JS durante carga. Esto NO constituye una prueba E2E entre pantallas. V3/Discover/Hotel y V6 se consideran por capturas/decisiones anteriores, no como auditoría de HTML contemporáneo.

Se hallaron estados de demostración diferenciados por versión (V7, V8, V9, V10 y V11), navegación creciente e instancias de tipografía de 10–10,5 px. Se conservarán las buenas decisiones: Home enfocada en prioridades, Profile orientado a calidad del trabajo, Trip con noches confirmadas, contactos profesionales y créditos transparentes.

## Decisiones de diseño cerradas

* Hotel: identidad única. Opportunity: cada intento comercial, con su propio contexto y estado.
* Trip: destino y fechas; Outreach: iniciativa comercial opcionalmente relacionada; Pipeline: vista global de oportunidades.
* Home: solo las tareas que necesitan atención; nada de noticias genéricas ni métricas ficticias.
* Contacto: 1 crédito por hotel si el desbloqueo tiene éxito. Fail y consulta repetida no cobran.
* Manual, Sample y Verified se presentan siempre como estados diferentes.
* Datos insuficientes no son 0% y métricas premium no se publican si no hay evidencia.
* Offer Builder y predicciones sin base estadística quedan fuera del alcance.

## Backlog por prioridad

### P0

- **UX-01 · Una sola oportunidad comercial de punta a punta** (Continuidad; Observado). Establecer Hotel → Opportunity → Outreach opcional → Trip opcional. Propagar opportunityId al abrir Pitch, Inbox, Pipeline, Contract Review y Collaborations. **Prueba:** Abrir dos oportunidades del mismo hotel, modificar una y comprobar que la otra conserva su estado.
- **UX-02 · Unificar la navegación en TODAS las pantallas** (Navegación; Observado). Una navegación global estable con Home, Discover, My Trips, Outreach, Pipeline, Inbox, Collaborations, Pitch Studio, Contract Review, Profile y Plans & Credits; Billing subordinado al plan. **Prueba:** Desde cualquier módulo, llegar a cualquier otro en un máximo de dos interacciones y conservar la vista previa sin perder trabajo.
- **UX-03 · Trip y Outreach sin duplicar hoteles ni iniciativas** (Flujo comercial; Decisión de producto). Start outreach desde un Trip debe reutilizar su shortlist; al añadir nuevos hoteles mostrar «Import 3 new hotels», sin alterar silenciosamente la iniciativa. **Prueba:** Guardar 8 hoteles en Trip; iniciar outreach; aparecen 8 sin re-selección. Crear outreach sin Trip también funciona.
- **UX-04 · Distinguir eventos verificados, declarados y de muestra** (Confianza; Observado). Etiquetas consistentes: Verified via Gmail, Manually recorded, Sample only, Awaiting verification. Mismos nombres en Home, Inbox, Pipeline y Collaborations. **Prueba:** Registrar «sent manually»: Inbox y Pipeline muestran origen manual; Home no lo cuenta como verified send.
- **UX-05 · Contactos de decisores, con preview segura y cobro inequívoco** (Contactos; Decisión de producto). Tarjeta visible, campos esquemáticos sin datos reales, calidad del contacto y procedencia, «Unlock hotel contacts · 1 credit»; fallos 0 créditos, reapertura 0. **Prueba:** Comparar contacto directo, buzón departamental, insuficiente y fallo; mensaje de resultado correcto en Free/Pro/Max.
- **UX-06 · Volver exactamente a la búsqueda anterior** (Continuidad; Documentado). Restaurar destino, filtros, orden, mapa, Trip y scroll; mostrar «Continue exploring Bangkok» en Home y Discover. **Prueba:** Filtrar 80 hoteles, abrir uno, volver; no cambia la búsqueda ni la posición. Repetir tras cerrar sesión y volver.

### P1

- **UX-07 · Elevar el tamaño de datos críticos** (Legibilidad; Observado). Cuerpo 14–15 px, secundaria 13–14 px, captions 12 px; limitar 10–11 px a metadata decorativa. Priorizar contraste y jerarquía. **Prueba:** Revisar a 100% y zoom 200%, desktop 1440 y móvil 390; ninguna decisión depende de texto inferior a 12 px.
- **UX-08 · Home solo muestra atención, no toda la plataforma** (Home; Observado). Máximo 3 prioridades visibles, respuesta nueva, seguimiento pendiente, campaña principal, próximo viaje y Continuar donde quedé; datos propios con fecha y fuente. **Prueba:** Un usuario identifica la acción más urgente en ≤10 segundos sin scrollear; cuenta nueva no muestra cifras inventadas.
- **UX-09 · Vocabulario único de etapas** (Estados; Inferencia UX). Opportunity: Saved→Draft→Sent→Replied→Negotiating→Agreed/Closed. Deliverable: To do→In progress→Submitted→Revision requested→Approved. Mostrar Manual/Verified por separado. **Prueba:** Abrir una negociación y comprobar que cambiar a Agreed no marca automáticamente entregables aprobados.
- **UX-10 · Pitches personalizables, sin repetir el contexto** (Pitch Studio; Observado). Autorrellenar lo conocido, con etiqueta de procedencia y confirmación para afirmaciones; conservar strategy, tone, subject, draft y destinatario. **Prueba:** Abrir desde la oportunidad: hotel y Trip correctos; volver sin perder borrador; cambiar a otro hotel sin sobrescribirlo.
- **UX-11 · Inbox es una cola de decisiones, no otro Gmail** (Inbox; Observado). Una vista tri-panel en desktop y stack en móvil; prioridad por «Needs reply», «Follow-up due», «Waiting»; quick actions en contexto. **Prueba:** Leer respuesta, preparar contestación, actualizar oportunidad y establecer seguimiento sin perder la conversación.
- **UX-12 · Contrato y entregables asociados a la oportunidad correcta** (Contratos; Observado). Identidad en encabezado: hotel, oportunidad, Trip, acuerdo, etapa; acceso recíproco Contract Review↔Collaborations. **Prueba:** Dos oportunidades del mismo hotel con contratos distintos; abrir uno nunca presenta el documento del otro.
- **UX-13 · Listas comerciales comparables antes del clic** (Discover; Decisión de producto). Tres columnas comparables: identidad, inteligencia publicable, acción/estado; filtros premium Pro/Max y «Insufficient data» separado de 0%. **Prueba:** Comparar tres hoteles sin entrar; ninguna cifra premium se muestra sin evidencia, ningún Free recibe datos ocultos.
- **UX-14 · Navegación y paneles móviles coherentes** (Móvil; Observado). Bottom actions contextuales o menú compacto consistente; Inbox lista→conversación→contexto; detalles como drawer full-screen accesible. **Prueba:** Recorrer el flujo completo con una sola mano a 390 px, teclado virtual abierto, y vuelta siempre disponible.
- **UX-15 · Free / Pro / Max y ledger con los mismos términos** (Plan y créditos; Observado). Un solo modelo de preview de crédito, upgrade contextual, transacción idempotente y explicación de acceso; no afirmar precios no aprobados. **Prueba:** Mismo hotel desbloqueado por segunda vez = 0; búsqueda fallida = 0; AI exitoso = 1 donde aplique; ledger concordante.
- **UX-16 · Diseñar estados vacíos, error, loading y datos insuficientes por tarea** (Estados; Inferencia UX). Para cada tarea: Loading, No data, Locked, Failed, Retry, Saved, Insufficient sample y Access changed, con acción siguiente explícita. **Prueba:** Simular error de contacto, respuesta parcial, sesión caducada y pago rechazado; siempre existe salida segura.
- **UX-17 · Noches cubiertas: confirmado no significa solicitado** (My Trips; Observado). Calendario de noches: Confirmed / Pending / Gap, tooltip sobre fuente del registro, advertencia de superposición y fechas consistentes. **Prueba:** Dos estancias solapadas se cuentan una sola vez; una estancia pendiente nunca se suma como confirmada.
- **UX-18 · Foco, etiquetas y contraste comprobados en flujos dinámicos** (Accesibilidad; Inferencia UX). Foco inicial y restauración, Escape, scroll lock, roles, nombres accesibles, sin información exclusivamente cromática; probar zoom. **Prueba:** Completitud con teclado en principales journeys; lectura de estado y errores por tecnología asistiva.

### P2

- **UX-19 · Reducir banners demo repetitivos en primer viewport** (Consistencia visual; Observado). En entorno de pruebas, un único indicador de «Demo data» en topbar con detalle expandible. En producción mostrar procedencia junto a cada cifra. **Prueba:** Primera pantalla conserva prioridad visual y el usuario siempre entiende si está viendo datos de muestra.
- **UX-20 · De guía de componentes a contrato visual común** (UI System; Observado). Diseñar una biblioteca de patrones: sidebar, cards, toolbar, table, board, metric, drawer, dialog, premium teaser, input, toast, empty state. **Prueba:** Cinco patrones auditados se ven y comportan igual en todo el paquete de UX.
- **UX-21 · Portfolio presenta el trabajo, no un perfil de redes sociales** (Portfolio; Observado). Distinguir «hotel-facing preview» y modo edición. Añadir casos reales con resultados atribuibles, sin forzar seguidores ni impresiones no verificadas. **Prueba:** Creador con 0 métricas sociales puede completar el portfolio y adjuntarlo en Pitch Studio sin inventar alcance.
- **UX-22 · Onboarding orientado a primer éxito, no completitud de perfil** (Onboarding; Observado). Elegir objetivo → primer Trip o Discover → shortlist → primer pitch. Posponer lo accesorio y mostrar progreso por acciones reales. **Prueba:** Creador sin viaje confirmado ni portfolio perfecto llega a un primer draft sin bloqueo.

## Journeys de aceptación

- **Voy a Bali, necesito colaboraciones:** Home: Continue Trip → My Trips: fechas y noches pendientes → Discover: hoteles filtrados → Hotel Detail: inteligencia y contactos → Outreach: shortlist reutilizada → Pitch Studio: propuesta única → Pipeline: próximo paso. **Resultado:** Conseguir una shortlist y preparar el primer pitch sin seleccionar dos veces un hotel.
- **Quiero contactar hoteles, pero no sé cuándo viajaré:** Discover: destino → Guardar hotel → Outreach: iniciativa sin Trip → Contact: desbloqueo hotel → Pitch Studio → Pipeline: seguimiento. **Resultado:** Preparar propuestas sin inventar un Trip ni fechas de viaje.
- **Un hotel me respondió: ¿qué hago ahora?:** Home: Needs your attention → Inbox: Needs reply → Abrir conversación + contexto → Redactar respuesta / guardar → Pipeline: actualizar etapa → Seguimiento programado. **Resultado:** Responder y definir siguiente paso con el historial a la vista.
- **Me confirmaron una colaboración:** Inbox: acuerdo propuesto → Pipeline: negociar / agreed → Contract Review: revisar cláusulas → Collaborations: entregables → My Trips: noches confirmadas → Home: próxima entrega. **Resultado:** No olvidar fechas, derechos de uso ni obligaciones del acuerdo.
- **Estoy en Free y quiero ver el valor:** Onboarding: escoger objetivo → Discover: investigar → Hotel Detail: contacto personalizado → Unlock hotel contacts · 1 credit → Pitch Studio: borrador manual → Plans: capacidad y límites. **Resultado:** Entender qué gana desbloqueando el contacto y terminar un primer pitch.

## Orden de trabajo

1. P0: modelo de oportunidad, navegación, contexto y estado verificable.
2. P1: intención por pantalla, fuentes de métricas, interacción contextual y lectura.
3. P2: pulido, estados límite y QA de acceso.

## Criterio final

El UX sign-off ocurre cuando las 12 pruebas de aceptación del HTML estén completadas en un único entorno común y los cinco recorridos hayan sido observados con creadores nuevos/activos, Free/Pro/Max, desktop y móvil. Las casillas del HTML son una herramienta manual de revisión, no un resultado de pruebas ya realizado.

## Archivos

`v12-ux-audit.html`: auditoría interactiva; `v12-journey-lab.html`: pruebas de recorrido y mapa de contexto; `issues.csv/json`: backlog; HTML originales V7–V11 como material fuente.

No se accedió al repositorio ni se modificó código de producción.