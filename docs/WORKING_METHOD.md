# WORKING_METHOD.md — Método operativo del proyecto TheUGC.life / UGCI

**Versión:** 1.0  
**Fecha:** 2026-08-18  
**Estado:** BINDING / protocolo operativo por defecto  
**Alcance:** estrategia, investigación crítica, arquitectura, implementación, auditoría, correcciones, merge, documentación y continuidad  
**Vigencia:** aplica hasta que el dueño del proyecto lo reemplace explícitamente por otro método (por ejemplo, una orquestación con Codex u otro sistema)  
**Repositorio:** `brianblisniuk/theugc-life`

---

## 0. Qué es este documento

Este archivo define **cómo trabajamos**.

No define qué debe hacer el producto. Eso vive en `DECISIONS.md`, contratos, PRD y specs.

Define el proceso para pasar de una idea o decisión a software confiable:

```text
ENTENDER
→ FIJAR EL CONTRATO
→ IMPLEMENTAR UN BLOQUE ACOTADO
→ INSPECCIONAR LA IMPLEMENTACIÓN REAL
→ AUDITAR ADVERSARIALMENTE
→ CORREGIR EN EL MISMO PR
→ REPETIR HASTA CERRAR
→ GATE FINAL
→ MERGE
→ DOCUMENTAR EL NUEVO ESTADO
→ SIGUIENTE BLOQUE
```

La regla central es:

> **No confiamos en que algo está bien porque el agente que lo implementó dice que está bien. Verificamos el repositorio, el diff, la base, los tests y el CI reales.**

Este método prioriza **corrección, trazabilidad y consistencia** sobre velocidad aparente.

---

# 1. Principio rector

El proyecto no se construye mediante prompts vagos como:

> “Implementá entity resolution.”

Se construye mediante **contratos ejecutables**.

Antes de pedir código, se intenta cerrar:

- qué pregunta responde el bloque;
- qué no responde;
- qué datos son fuente de verdad;
- qué estados existen;
- qué estados NO significan;
- qué invariantes deben ser imposibles de violar;
- qué evidencia/provenance debe preservarse;
- qué puede escribir;
- qué no puede escribir;
- qué comportamiento queda para una fase futura;
- qué tests demostrarían que el contrato se cumple;
- qué datos reales deben recomputarse al final;
- qué condiciones habilitan merge.

El agente de implementación recibe una **frontera clara**.

---

# 2. Roles actuales

## 2.1 ChatGPT — arquitecto crítico, investigador y auditor externo

Responsabilidades:

1. entender el estado actual;
2. leer las fuentes de verdad;
3. investigar decisiones críticas cuando hace falta;
4. transformar una decisión en un contrato implementable;
5. escribir el prompt de implementación;
6. esperar la implementación;
7. inspeccionar el **SHA real** del PR;
8. revisar el código real, no sólo el informe del implementador;
9. revisar DB/schema/migrations/tests/CI cuando corresponda;
10. buscar interacciones y edge cases que el primer prompt no podía anticipar;
11. emitir amendments acotados;
12. volver a auditar el nuevo head;
13. decidir PASS / BLOCKED;
14. mergear sólo cuando el gate está satisfecho y el dueño autoriza;
15. definir el siguiente bloque.

ChatGPT no debe usar el reporte del implementador como sustituto del repositorio.

## 2.2 Claude Code — línea principal de implementación

Claude Code implementa bloques acotados del repo.

Responsabilidades:

- trabajar desde el SHA/base indicado;
- usar la rama indicada;
- crear un PR nuevo sólo cuando el prompt lo pide;
- continuar en el mismo PR cuando se trata de una corrección;
- no inventar comportamiento de producto;
- preservar invariantes existentes;
- escribir tests;
- ejecutar gates locales;
- reportar los resultados;
- esperar CI real cuando el prompt lo exige;
- **no mergear** salvo instrucción explícita.

Claude Code es implementador, no fuente final de verdad sobre su propia implementación.

## 2.3 Gemini u otros modelos

Se pueden usar para exploración amplia, brainstorm, discovery y tareas de bajo riesgo.

No son autoridad final para seguridad, OAuth, compliance, legal, privacidad, source semantics críticos, arquitectura irreversible o reglas de canonicalización.

La evidencia crítica se verifica con fuentes primarias y/o auditoría directa.

## 2.4 Codex u otro sistema futuro

Cuando se adopte Codex u otro orquestador, **el método sobrevive aunque cambie el agente**.

La futura automatización debería conservar funciones separadas:

```text
ARCHITECT / CONTRACT
→ IMPLEMENTER
→ TEST / CI
→ INDEPENDENT AUDITOR
→ CORRECTION LOOP
→ HUMAN MERGE GATE
```

No reemplazar este método por “un agente hace todo y se autoaprueba”.

---

# 3. Jerarquía de fuentes de verdad

Antes de implementar:

1. `docs/DECISIONS.md` — decisiones cerradas explícitas.
2. Contratos/specs específicos del dominio.
3. `docs/PRD.md` — producto actual / built reality.
4. `docs/MASTER_PLAN.md` — visión y secuencia de largo plazo.
5. `docs/MASTER_PLAN_TRACKER.md` — estado vivo de ejecución.
6. Este documento — **proceso de trabajo**, no producto.

Si un prompt o reporte contradice una decisión cerrada, **la decisión cerrada gana** hasta que sea deliberadamente modificada.

Nunca se “corrige” silenciosamente una decisión histórica para que coincida con el código nuevo.

---

# 4. Regla de no invención

Si para implementar hace falta una decisión que no está cerrada:

```text
STOP
```

El agente debe reportar:

1. decisión faltante;
2. por qué bloquea;
3. opciones reales;
4. tradeoffs;
5. recomendación.

No se permite “elegí X porque parecía razonable” cuando X cambia producto, permisos, verdad canónica, privacidad, seguridad, pricing, identidad o semántica de datos.

---

# 5. Tamaño del bloque de trabajo

Un PR debe contestar **una pregunta principal**.

Ejemplos buenos:

```text
¿Cómo resolvemos star classification?
¿Cómo preservamos lifecycle closure evidence?
```

Ejemplo malo:

```text
Implementá todo el pipeline de hoteles, Gmail, intelligence y UI.
```

Un bloque acotado mejora auditabilidad, claridad del contrato, testabilidad, reversibilidad y calidad de correcciones.

La investigación puede correr en paralelo.

La implementación de una cadena de dependencias debe ser preferentemente secuencial:

```text
A
→ auditar
→ mergear
→ B
```

---

# 6. Cómo se prepara un prompt de implementación

## 6.1 Identidad exacta

Siempre que sea posible:

```text
Repository:
owner/repo

START FROM EXACT MAIN:
<sha>

Create branch:
<name>

Create PR.

DO NOT MERGE.
```

Para una corrección:

```text
Continue on SAME branch.
Continue on SAME PR.
Current audited head:
<sha>

DO NOT create another PR.
DO NOT merge.
```

## 6.2 GOAL

Una frase precisa:

```text
GOAL

Implement the pre-publication lifecycle evidence layer needed to answer:

“Does the latest complete provider evidence contain a current property-level
closure window for this source property, as of an explicit date?”
```

Si el goal no cabe en pocas líneas, el bloque probablemente está demasiado grande.

## 6.3 Qué debe leer primero

```text
READ FIRST

docs/DECISIONS.md
<domain contract>
docs/DATABASE.md
<relevant migrations>
<relevant code/tests>
```

El agente debe construir sobre el sistema existente.

## 6.4 Contrato semántico

Ejemplo:

```text
HOTEL + CLOSED
→ may represent a property-level closure window

SPA + CLOSED
→ does NOT close the hotel

NO_KNOWN_CLOSURE
≠ ACTIVE
```

Las negaciones son tan importantes como las afirmaciones.

Patrones útiles:

```text
UNKNOWN != ZERO
NO EVIDENCE != NEGATIVE EVIDENCE
OBSERVATION != CANONICAL TRUTH
BLOCKING != MATCH
DISCOVERED != PUBLISHED
```

## 6.5 Estados y vocabulario

Cada estado se define por **means / does not mean**.

Ejemplo:

```text
KNOWN_CLOSED
means:
provider reports a property-level closure window covering the explicit date

does NOT mean:
permanently closed
inactive forever
canonical exclusion
```

## 6.6 Provenance

Todo hecho importante debe poder reconstruirse.

Preguntas obligatorias:

```text
¿De qué source vino?
¿De qué provider record?
¿De qué run?
¿De qué observation?
¿Con qué policy version?
¿Con qué as-of?
¿Con qué human authorization, si hubo una?
```

Una decisión que no puede explicar de dónde salió no es durable.

## 6.7 Persistencia vs derivación

Antes de crear una columna:

```text
¿Esto es evidencia?
¿Es verdad canónica?
¿Es un resultado derivado?
¿Es temporal?
¿Puede cambiar sin nueva evidencia?
```

Ejemplo:

```text
closure interval = durable evidence
“closed today” = derived from interval + explicit date
```

## 6.8 Invariantes de DB

Cuando una regla importa, se evalúa si debe estar respaldada por:

- CHECK;
- UNIQUE;
- FK / composite FK;
- trigger;
- generated column;
- RLS;
- ACL explícito;
- append-only enforcement.

> **Una regla importante que sólo existe en un comentario es una regla que un script futuro puede romper.**

Pero no toda regla de producto debe ser constraint: sólo lo que la DB puede expresar correctamente.

## 6.9 Idempotencia

Para cualquier pipeline/importer/resolver:

```text
first run
→ writes expected state

exact replay
→ zero semantic change
```

Se prueba que no haya duplicados, drift, counters inflados ni history rewrite.

## 6.10 Seguridad

Se revisa:

- RLS;
- grants;
- anon/authenticated/service role;
- admin/editor;
- security invoker/definer;
- bypass;
- exposición de datos sensibles.

No se acepta:

```text
“RLS está habilitado, entonces está seguro.”
```

ACL y RLS son capas distintas.

## 6.11 Non-goals

Cada prompt importante debe decir qué **NO** implementar.

```text
NOT IN THIS PR

No canonical hotel creation
No D062 Apply
No Provider B
No UI
No Gmail
No LLM interpretation
No permanent-closure inference
```

Los non-goals reducen “trabajo útil” inventado por el agente.

## 6.12 Preservar hechos aprobados

Una corrección debe decir qué no puede romper:

```text
PRESERVE

- existing pair orientation
- current policy semantics
- canonical safety
- no automatic match
- approved parity unless the corrected rule legitimately changes it
```

## 6.13 Real-data stress

Cuando existe evidencia real:

```text
RECOMPUTE
DO NOT COPY THE OLD REPORT
```

Los números previos son referencia, no target.

```text
We currently expect approximately 2 KNOWN_CLOSED.
Do NOT hard-code 2.
If the cache says something else, STOP and explain.
```

## 6.14 Tests mínimos

Los tests deben probar el contrato, no sólo el happy path.

Casos típicos:

```text
A exists
A disappears
A reappears
manual state exists
machine state overlaps
unknown input
malformed input
boundary date
reverse pair
historical evidence
current evidence
cross-destination key
replay
```

Especialmente:

> **Probar la interacción entre dos reglas correctas.**

Muchos bugs reales aparecen en la intersección entre reglas.

## 6.15 Gates

Normalmente:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Y cuando corresponde:

- migration replay empty → latest;
- previous migration → new migration;
- RLS/ACL direct SQL probes;
- real cached stress;
- checksum/replay;
- canonical snapshot;
- parity counts.

## 6.16 Reporte obligatorio

El prompt termina diciendo qué debe reportar.

```text
REPORT

1. SHA
2. branch
3. PR
4. schema changes
5. exact semantics
6. real counts
7. replay
8. canonical snapshot
9. test totals
10. GitHub CI conclusion
11. ambiguity refused
```

Esto ayuda a auditar, pero el reporte **no sustituye** la auditoría.

---

# 7. Plantilla base de prompt

```text
<NAME OF BLOCK> — IMPLEMENTATION CONTRACT

Repository:
brianblisniuk/theugc-life

START FROM EXACT MAIN:
<SHA>

Create branch:
<BRANCH>

Create NEW PR.

DO NOT MERGE.

==================================================
GOAL
==================================================

<One exact question this block answers.>

==================================================
READ FIRST
==================================================

<authoritative docs>
<relevant migrations>
<relevant code/tests>

==================================================
CONTRACT
==================================================

<exact semantics>

==================================================
MEANS / DOES NOT MEAN
==================================================

<state vocabulary>

==================================================
PROVENANCE
==================================================

<how every decision is reconstructable>

==================================================
DB / SECURITY / IDEMPOTENCY
==================================================

<constraints, RLS, ACL, replay>

==================================================
PRESERVE
==================================================

<approved invariants that must not regress>

==================================================
NOT IN THIS PR
==================================================

<explicit non-goals>

==================================================
REAL STRESS
==================================================

<recompute against real/cached evidence>

Do NOT copy expected counts.
If evidence disagrees, STOP and report.

==================================================
TESTS
==================================================

<minimum semantic and adversarial tests>

==================================================
VALIDATION
==================================================

format
lint
typecheck
tests
build
migration replay
CI

==================================================
REPORT
==================================================

<exact report fields>

DO NOT MERGE.

External audit will inspect the real GitHub head.
```

---

# 8. Cómo se hace la auditoría externa

## Paso 1 — verificar identidad real

Primero:

- PR real;
- branch;
- base;
- head SHA;
- open/merged;
- mergeable;
- changed files;
- CI del head exacto.

Nunca auditar “el PR que creemos que es”.

## Paso 2 — inspeccionar implementación real

Se leen los archivos de mayor riesgo:

- migration;
- core algorithm;
- writer;
- loader;
- review/evaluator;
- tests;
- security changes;
- docs contract.

Se inspeccionan especialmente los seams donde una regla puede romper otra.

## Paso 3 — comparar código contra contrato

Preguntas:

```text
¿El código hace exactamente lo que el contrato dice?
¿Hace algo adicional?
¿Hay una inferencia silenciosa?
¿Unknown se convierte en false/zero?
¿Observation se convierte accidentalmente en canonical truth?
¿Un human state puede ser adquirido por machine state?
¿Historical puede parecer current?
¿Falta de extracción puede parecer “no evidence”?
```

## Paso 4 — buscar invariantes que existen sólo en la app

Ejemplo:

```text
app orders pair A/B
```

pero DB permite:

```text
A/B
B/A
```

Entonces la regla no está cerrada.

## Paso 5 — atacar lifecycle y stale state

```text
¿Qué pasa si la evidencia cambia?
¿Qué pasa con el row viejo?
¿Sigue pareciendo actionable?
¿Se supersede?
¿Se reactiva?
¿Quién tiene autoridad para reactivarlo?
¿Una decisión humana puede ser reescrita?
```

## Paso 6 — current vs historical

Revisar especialmente:

```text
first_seen
latest_seen
latest observation
historical snapshot
current discovery
persisted state
```

Muchos bugs nacen de usar “alguna evidencia existente” cuando el contrato requiere “la evidencia vigente”.

## Paso 7 — provenance exacta

Preguntar si la evidencia puede quedar pegada al objeto equivocado.

Ejemplo inseguro:

```text
old cached record
→ sourcePropertyId
→ latest observation
```

si el cached record produjo una observation anterior.

La provenance debe identificar el record/evento correcto.

## Paso 8 — normalización peligrosa

Provider codes e IDs son identificadores.

Auditar:

```text
trim
lowercase
numeric coercion
substring
fallback
average
default
```

Ejemplo:

```text
"HOTEL "
→ trim
→ "HOTEL"
```

puede adquirir una policy que el valor original no tenía.

## Paso 9 — malformed data

Probar si un valor malo:

- se conserva;
- desaparece;
- rompe toda la transacción;
- se convierte silenciosamente en uno válido;
- termina interpretado como ausencia.

Patrón seguro frecuente:

```text
bad evidence
→ preserve or explicitly fail extraction
→ UNRESOLVED
```

No:

```text
bad evidence
→ discard
→ “nothing known”
```

## Paso 10 — interacción entre reglas

Ejemplo:

```text
Rule A:
manual rows are protected

Rule B:
one pair = one row

Rule C:
machine discovery may later find the same pair
```

Por separado son correctas.

La interacción puede producir:

```text
machine INSERT conflicts with manual row
→ fallback UPDATE
→ machine hijacks manual row
```

La auditoría intenta deliberadamente construir estas interacciones.

## Paso 11 — CI real

```text
local tests green
≠
GitHub CI green
```

Se espera la conclusión real del workflow asociado al **SHA exacto**.

## Paso 12 — documentación

Después de cambios, revisar que no haya quedado un contrato viejo diciendo lo contrario.

Código y docs deben contar la misma historia.

---

# 9. Cómo se escriben los prompts de corrección

Una corrección no reinicia el trabajo.

```text
EXTERNAL AUDIT AMENDMENT #N — PR #X

Continue on SAME branch.
Continue on SAME PR.
Current audited head: <sha>

DO NOT create another PR.
DO NOT merge.
```

Luego:

1. decir qué está aprobado;
2. nombrar el blocker;
3. mostrar el escenario que falla;
4. definir la semántica correcta;
5. exigir prueba específica;
6. decir qué preservar;
7. volver a correr gates;
8. pedir nuevo SHA;
9. volver a auditar.

---

# 10. Qué es un blocker

Un blocker es algo que puede:

- producir verdad incorrecta;
- corromper identidad;
- perder provenance;
- publicar algo que no debe;
- reescribir una decisión humana;
- confundir unknown con zero/false;
- romper idempotencia;
- dejar estado stale como current;
- abrir exposición de seguridad;
- hacer divergir replay y producción;
- hacer que docs futuras ordenen conducta equivocada;
- volver imposible reconstruir por qué se tomó una decisión.

No toda mejora estética o refactor es blocker.

El método evita convertir una preferencia de implementación en una ronda infinita.

---

# 11. Gate de merge

Un PR está listo cuando:

```text
CONTRACT CORRECT
+
NO KNOWN BLOCKERS
+
REAL HEAD AUDITED
+
CI GREEN ON EXACT HEAD
+
TESTS REPRESENT IMPORTANT FAILURE MODES
+
DB INVARIANTS HOLD
+
SECURITY HOLDS
+
REPLAY / IDEMPOTENCY HOLDS WHERE APPLICABLE
+
CANONICAL SAFETY HOLDS
+
DOCS MATCH REALITY
```

El implementador no se auto-mergea.

El merge ocurre cuando el dueño autoriza o cuando un protocolo futuro explícito lo permita.

---

# 12. Después del merge

1. registrar merge commit;
2. confirmar nuevo `main`;
3. marcar tracker si corresponde;
4. no reabrir decisiones cerradas sin evidencia nueva;
5. definir siguiente bloque desde el nuevo main;
6. actualizar backup/continuidad cuando el tramo fue importante.

El siguiente prompt comienza desde el **merge commit real**, no desde el viejo head del PR.

---

# 13. Metodología de investigación crítica

Cuando una decisión depende de información cambiante o de alto riesgo:

- usar fuente primaria actual;
- diferenciar hecho de interpretación;
- citar;
- no convertir marketing de proveedor en garantía técnica;
- no inferir permisos/licencias/compliance por ausencia de prohibición;
- separar:
  - técnicamente posible;
  - permitido contractualmente;
  - apropiado para producto;
  - seguro para producción.

Obligatorio para:

- Gmail OAuth;
- Google Restricted Scopes;
- retention/deletion;
- provider media rights;
- términos de API;
- privacidad;
- seguridad;
- regulación;
- data licensing.

---

# 14. Metodología de diseño / producto

El mismo patrón se aplica a diseño:

```text
HIPÓTESIS
→ 2–3 DIRECCIONES
→ COMPARACIÓN
→ SELECCIÓN
→ ITERACIÓN
→ GATE
→ TOKENS / SISTEMA
→ PRODUCCIÓN
```

Una exploración visual no se convierte automáticamente en design system.

Distinguir:

```text
prototype pixel
≠ token

demo content
≠ production data

exploration image
≠ licensed production asset
```

---

# 15. Por qué pueden existir varias correcciones antes del merge

Muchas correcciones no significan automáticamente que el proceso falló.

La pregunta correcta es:

> **¿Los problemas se descubrieron antes de convertirse en dependencia de otros veinte bloques?**

El primer prompt trabaja contra una implementación todavía hipotética.

La auditoría posterior puede ver:

- SQL exacto;
- constraints;
- queries;
- fixture assumptions;
- lifecycle;
- CI;
- interacción con código viejo.

Cada corrección puede crear estados que antes no existían, por lo que una auditoría siguiente puede descubrir un seam nuevo.

La señal saludable es que los problemas bajan de nivel:

```text
arquitectura
→ invariantes DB
→ lifecycle
→ current-state semantics
→ integración
→ fixtures
→ docs
```

Una menor cantidad de correcciones puede significar simplemente **menos auditoría**.

El objetivo no es:

```text
cero correcciones
```

El objetivo es:

```text
cero blockers conocidos al merge
```

---

# 16. Principios de estilo para prompts

## Ser explícito

Preferir:

```text
UNKNOWN != ZERO.
```

a una explicación ambigua.

## Usar ejemplos concretos

```text
SPA + CLOSED
≠ HOTEL CLOSED
```

## Escribir el caso peligroso

```text
manual row
→ later machine discovery
→ INSERT conflict
→ fallback UPDATE
```

## Decir qué NO hacer

```text
Do NOT fix this by adding a threshold.
Do NOT silently filter disagreement.
Do NOT auto-run the writer from review.
```

## No preservar números artificialmente

```text
Current expected count = 266.
Correction MAY change it.
Recompute.
```

## Pedir evidencia

El reporte debe permitir comprobar cada afirmación importante.

---

# 17. Continuidad entre conversaciones

Una nueva conversación no debe reconstruir el proyecto desde memoria parcial.

Antes de continuar un bloque importante:

1. leer el backup de continuidad más reciente si se proporciona;
2. leer `docs/WORKING_METHOD.md`;
3. leer `docs/DECISIONS.md`;
4. leer el contrato específico del bloque;
5. verificar el estado real del repo/PR;
6. continuar desde el SHA real.

Prompt mínimo para un chat nuevo:

```text
Lee primero:

1. docs/WORKING_METHOD.md
2. docs/DECISIONS.md
3. docs/MASTER_PLAN.md
4. docs/MASTER_PLAN_TRACKER.md
5. el contrato específico del bloque actual
6. el backup de continuidad que te adjunto

Después verificá el estado real del repo/PR antes de proponer el siguiente paso.

No reinventes decisiones cerradas.
Aplicá el método de WORKING_METHOD.md.
```

---

# 18. Archivos de entrada para agentes

Para que el método no dependa de una conversación:

- `docs/WORKING_METHOD.md` = documento canónico completo.
- `AGENTS.md` = instrucción de entrada para agentes compatibles con ese mecanismo.
- `CLAUDE.md` = instrucción de entrada para Claude Code.
- backups de continuidad = estado temporal del proyecto, no fuente de producto.

Los archivos de agente deben **apuntar** a este documento, no duplicarlo entero.

Una metodología duplicada en cinco archivos termina divergiendo.

---

# 19. Regla para modificar este método

No editar silenciosamente este documento para justificar una forma distinta de trabajar.

Si el método cambia:

1. explicar qué problema del método actual se quiere resolver;
2. describir el nuevo proceso;
3. preservar lo que siga siendo útil;
4. registrar fecha/version;
5. actualizar `AGENTS.md` / `CLAUDE.md` si corresponde.

Una futura automatización con Codex puede reemplazar herramientas y roles, pero debe declarar explícitamente qué gates elimina o conserva.

---

# 20. Resumen operativo

```text
1. VERIFICAR ESTADO REAL
2. LEER FUENTES DE VERDAD
3. IDENTIFICAR UNA PREGUNTA ACOTADA
4. CERRAR CONTRATO Y NON-GOALS
5. ESCRIBIR PROMPT CON SHA/RAMA/PR/GATES/REPORT
6. IMPLEMENTAR
7. RECIBIR REPORTE
8. IGNORAR EL REPORTE COMO PRUEBA FINAL
9. AUDITAR HEAD REAL + CODE + DB + TESTS + CI
10. ENCONTRAR BLOCKERS / INTERACCIONES
11. AMEND SAME PR
12. RE-AUDIT NEW HEAD
13. REPETIR HASTA PASS
14. DOC-SYNC
15. MERGE CON GATE HUMANO
16. REGISTRAR MERGE COMMIT
17. SIGUIENTE BLOQUE DESDE NUEVO MAIN
18. BACKUP DE CONTINUIDAD
```

La frase que resume el método:

> **Contrato explícito → implementación acotada → auditoría adversarial independiente → corrección en el mismo PR → gate real → merge.**
