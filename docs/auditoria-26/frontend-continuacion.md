# Frontend — continuación de la auditoría 26

**Nota: 4/10** (antes 5). Razón del movimiento: **deuda que cobró factura.** La
ronda declaró cerrados dos ALTOS de este rubro y solo uno lo está. El arreglo de
FE-1 (`75ec8629`) tocó el camino de RESPALDO de la tabla y dejó intacto el que
de verdad corre cuando la liquidación está sana: la pantalla donde el contralor
firma sigue contradiciéndose a sí misma sobre el caso común, y ahora además los
dos caminos que alimentan la MISMA tabla responden distinto a la misma pregunta.
Y la prueba que acompaña al arreglo comete —literalmente— el error epistémico
que su propio comentario denuncia: fabrica a mano una forma de dato que el
camino de producción sigue sin poder producir. Es el patrón `abf6921`→`8abb596`
otra vez, en otro rubro y el mismo día.

**Riesgo mayor de hoy:** `/dashboard/[id]` lleva cinco rondas contradiciéndose
en la misma pantalla, y esta ronda creyó haberlo cerrado. Un contralor que
compra a crédito con REP —lo normal en casetas y diésel de convenio— sigue
leyendo «Por confirmar» en el renglón y «Deducible para ISR» doce centímetros
arriba, sobre el mismo peso.

---

## Veredicto sobre los dos arreglos de esta ronda

### `273ecd95` — FE-4 (`/mcp/autorizar`, el botón `var(--fg)`) → **CERRADO de verdad, con el guardarraíl a medio alcance**

- El síntoma está resuelto y bien resuelto: `src/app/mcp/autorizar/page.tsx:260`
  ahora pinta `background: var(--ink)`, y `--ink` sí existe
  (`globals.css:51`, `--ink: var(--color-ink)` = `#17100d`; en oscuro
  `globals.css:150` lo pone `#f4f4f5`). Remedí el par con la fórmula de
  luminancia WCAG: **17.5:1** en claro (`#17100d` sobre `#fbfbfd`) y ~17.4:1 en
  oscuro. El botón que concede el acceso vuelve a existir en los dos temas.
- **No abrió nada nuevo.** El comentario `//` que el arreglo metió DENTRO del tag
  (`page.tsx:255-259`) es trivia válida para el parser de TSX: corrí
  `npx tsc --noEmit -p .` (limpio) y `npx eslint` sobre
  `src/app/mcp/autorizar` (limpio). La aserción de `tokens.test.ts:52-56` corta
  de `value="autorizar"` al primer `>` y el comentario nuevo no contiene ninguno,
  así que la prueba sigue midiendo lo que dice medir. **16/16 verdes** entre
  `tokens.test.ts`, `renglon_pagado_en.test.ts` y `estado_renglon.test.ts`.
- **Contesta la pregunta, no solo la línea** — a medias. La prueba nueva
  (`src/app/mcp/autorizar/tokens.test.ts:44-50`) cruza TODAS las referencias
  `var(--x)` sin fallback **de ese archivo** contra lo que `globals.css` declara;
  eso es más que blindar la línea. Pero la pregunta que el hallazgo hacía era
  «nada en el repo verifica que un token USADO exista», y el guardarraíl vive en
  el directorio de una sola pantalla. El propio commit lo admite en su último
  párrafo y deja tres tokens rotos sin red. Ver el hallazgo de `cola.tsx`.
- Detalle para quien mantenga: `DEFINIDOS` lee **solo** `globals.css`, así que si
  algún día esta pantalla usara un token de `login/login.css` la prueba lo
  reportaría como huérfano siendo válido. Hoy no pasa.

### `75ec8629` — FE-1 (`leerGastos` sin `pagado_en`) → **CERRADO A MEDIAS, y en la mitad equivocada**

El arreglo agregó `pagado_en` al `select` de `leerGastos`
(`src/lib/likida/analytics.ts:1450`) y `pagadoEn?: string` al tipo
(`:1306`). Las dos cosas son correctas. El problema es **cuál de los dos caminos
arregló**: el propio archivo declara en `:1426` que `leerGastos` «es el camino de
RESPALDO: se usa solo cuando el motor no pudo reconstruir el viaje». El camino
que corre en una liquidación sana —`reconstruir`— sigue sin el campo. Detalle en
el primer hallazgo.

La prueba `renglon_pagado_en.test.ts` **sí falla en rojo sin el arreglo** (su
`selectDeLeerGastos()` ancla en la cadena `'getLiquidacionDetalle/gastos'` y el
tipo no compilaría), pero mide exactamente el camino que no importa, y su caso de
comportamiento (`:56-66`) construye `pagadoEn: '2026-08-20'` **a mano** — la
misma crítica que su cabecera le hace a `estado_renglon.test.ts:92`. La prueba
está verde y sigue probando algo que el camino principal no puede producir.

---

## Hallazgos

### [ALTO] REINCIDENTE — el arreglo de FE-1 llegó al camino de respaldo; el renglón del camino PRINCIPAL sigue diciendo «Por confirmar» sobre un peso que la misma pantalla cuenta como deducible
`src/lib/likida/analytics.ts:1376` (qué camino gana), `:1546-1548`
(`FilaImprimibleConFiscal`, el tipo del mapeo) y `:1626-1645` (el mapeo, sin
`pagadoEn`), contra `:1450` (lo único que el arreglo tocó, en `leerGastos`,
documentado como respaldo en `:1426`) y
`src/app/dashboard/[id]/vista.tsx:215` (`pagoPendiente(g)`), llamado desde
`src/app/dashboard/[id]/detalle.tsx:364`.

Escenario, con valores. Caseta de CAPUFE de **$240**, CFDI vigente, `forma_pago
= '99'`, y su REP del **2026-08-20** ya ingerido → `gasto.pagado_en =
'2026-08-20'`, mismo mes que el comprobante.

1. `getLiquidacionDetalle` llama a `reconstruir(...)` (`:1366`). El motor cuadra,
   `|totalComprobado − totalPersistido| = 0` y no hay deriva de config → la
   reconstrucción **NO es null**.
2. `analytics.ts:1376` hace `const gastos = reconstruida?.filas ?? crudos ?? []`
   → gana `reconstruida.filas`. **`leerGastos` ni siquiera se ejecuta**
   (`:1375` es un ternario sobre `reconstruida`).
3. `reconstruida.filas` sale del `.map()` de `:1633-1644`, cuyo objeto literal
   tiene once claves —`id, concepto, monto, folio, fecha, formaPago, cfdiUuid,
   estadoSat, cfdiValido, ocrExtra, imagenUrl`— y **`pagadoEn` no está**. El dato
   sí venía: `filasImprimibles` (`liquidacion/omitidos.ts:94`) devuelve los
   `Gasto` del motor tal cual, y `repo.ts:995` les pone `pagadoEn`. Se pierde en
   el mapeo, y el cast `g as FilaImprimibleConFiscal` (`:1632`) apunta a un tipo
   que tampoco lo declara (`:1546-1548`), así que TypeScript no tiene de qué
   quejarse.
4. En la tabla, `tipos` está vacío —`cubetaDe` (`engine.ts:473`) manda el gasto a
   **`deducible`** y `engine.ts:1665` solo emite `iva_mes_del_pago` si el mes del
   pago difiere del del comprobante, y aquí no difiere—, así que
   `estadoRenglon` cae hasta `vista.tsx:215`, `pagoPendiente` colapsa a
   `formaPago === '99'` y la píldora sale **«Por confirmar», ámbar**.
5. El bloque «Deducibilidad» de la misma pantalla (`detalle.tsx:86-88`) se
   alimenta de `d.deducibilidad`, que viene de `liq.totalDeducible` calculado por
   el motor **con** `pagadoEn`, y cuenta esos $240 como **deducibles**. El PDF
   también.

Efecto colateral que el arreglo introdujo: los dos caminos que llenan la MISMA
tabla ahora contestan distinto. Si la reconstrucción falla (config cambiada,
gastos añadidos después del cierre) el renglón sale **verde**; si la
reconstrucción funciona sale **ámbar**. La misma liquidación, dos píldoras según
un portón que el contralor no ve.

Consecuencia: el contralor firma una hoja que se contradice a sí misma sobre el
caso común de cualquier flota que compre casetas y diésel con convenio, y lo hace
en la pantalla donde se firma. Para quien mantenga: la ronda anotó este ALTO como
cerrado, así que nadie va a volver a mirarlo — y la prueba que lo «cubre»
(`renglon_pagado_en.test.ts:56-66`) fabrica el `pagadoEn` a mano, exactamente
como la prueba de la 25 que su cabecera denuncia.

Causa raíz probable: el arreglo siguió el `select` que el hallazgo citaba en vez
del `??` que decide cuál de los dos caminos alimenta la tabla.

---

### [ALTO] REINCIDENTE — el panel de Ajustar sigue prometiendo «el cuadre no se vuelve a calcular», y desde `d914e74` sí se recalcula, se reimprime el PDF y se le vuelve a mandar al chofer
`src/app/dashboard/[id]/revision-panel.tsx:144` (el texto en pantalla) y `:19`
(el comentario de cabecera que lo repite), contra
`src/lib/likida/revision.ts:485-501` y
`src/lib/likida/revision_recalculo.ts:22-33`.

Verificado hoy palabra por palabra: **ni una línea cambió** desde que se escribió
`frontend.md`. `revision-panel.tsx:144` sigue diciendo «El total se mueve por la
diferencia; el cuadre **no** se vuelve a calcular», y `revision.ts:492-497` sigue
corriendo `regenerarPdfTrasAjuste` cuando `p.accion === 'ajustar' &&
cuadreRecalculado`, que —según el propio encabezado de
`revision_recalculo.ts:22-33`— imprime los dos ejemplares, los sube a la ruta
canónica, archiva el anterior en `pdf_historial` y **borra
`entregada_operador_en` / `avisada_oficina_en`** para que el mecanismo de
reentrega le vuelva a mandar el PDF al chofer.

Escenario, con valores: el contralor abre `VJ-2026-0845`, corrige el diésel de
$800 → $8,000, lee la frase, y firma creyendo que solo movió un total. Detrás se
recalculan `ivaAcreditable`, `iepsAcreditable`, `litrosDieselAcreditables`,
`peajeAcreditable`, `estatus` y `diferencias`, y al chofer le llega un PDF nuevo
por WhatsApp.

Consecuencia: el rótulo no es impreciso, es lo contrario del hecho, sobre la
regla que define al producto. En sala, con el comprador leyendo la frase mientras
el PDF se regenera detrás, es un error que se ve.

Causa raíz probable: nada ata la cadena literal del `.tsx` al módulo que describe.

---

### [ALTO] REINCIDENTE — si el PDF ajustado no se puede regenerar, la pantalla dice «se corrigió 1 comprobante» y calla que el papel vigente quedó con la cifra vieja
`src/lib/likida/revision.ts:498-500` (el `regenerado` que solo se loguea) y
`:357-366` (`ResultadoRevision`, sin campo donde viajar), contra
`src/app/dashboard/[id]/page.tsx:242-247` (el mensaje de éxito) — y contra el
patrón correcto que ya vive en el mismo archivo, `page.tsx:125`.

Verificado hoy: `ResultadoRevision` (`revision.ts:357-366`) sigue con siete campos
—`revision, viajeId, folio, totalComprobado, diferencia, ajustes,
choferAvisado`— y **ninguno para `regenerado`**. `revision.ts:499` sigue siendo
un `logger.warn('revision.pdf_no_regenerado', …)` que muere ahí.

Escenario, con valores. Ajuste de $800 → $8,000. La RPC confirma y la base queda
con el desglose nuevo. `regenerarPdfTrasAjuste` falla en el `upload` a Storage
(5xx de Supabase) y devuelve `{ regenerado: false }` — nunca lanza, a propósito.
En pantalla sale «`VJ-2026-0845`: se corrigió 1 comprobante. El comprobado quedó
en $18,400.00 y la diferencia en $1,200.00», y el PDF que el contralor descarga
con «Ver PDF» sigue diciendo $11,200.00.

Consecuencia: el archivo que el contador sube a su contabilidad y el que el chofer
guarda en su teléfono contradicen a la base y a la pantalla, sin un aviso. El
mismo archivo demuestra que sabe hacerlo bien: `page.tsx:125` concatena « El PDF
anterior ya no es válido.» cuando `pdfPerdido`.

Causa raíz probable: `ResultadoRevision` se diseñó antes del PDF versionado y no
creció con él.

---

### [MEDIO] REINCIDENTE — los tres pills de la cola de revisión piden `--ok-bg`, `--bad-bg` y `--warn-bg`, que no existen en ninguna hoja del repo
`src/app/dashboard/agentes/liquidacion/cola.tsx:49-53` (el mapa) y `:258-259`
(donde se pintan), contra `src/app/globals.css:110-115` (claro) y `:165-167`
(oscuro), que declaran `--okbg` / `--warnbg` / `--badbg`, **sin guion**.

**Barrido completo, hecho hoy y no heredado.** Extraje todo `var(--x)` de los
~1,100 `.ts/.tsx/.css` de `src/` y lo crucé contra las definiciones de
`globals.css` + `login/login.css` + las inline de los `.tsx`. Resultado, en dos
listas:

- **Sin fallback y sin definición: exactamente tres**, los tres en
  `cola.tsx:50`, `:51` y `:52`. `--fg` ya solo aparece en el comentario de
  `mcp/autorizar/tokens.test.ts:11` (el arreglo cerró su única referencia viva).
  `--font-sans-ui`, `--font-display`, `--font-mono`, `--font-serif`,
  `--font-fraunces` y `--font-instrument` los inyecta `next/font`, no
  `globals.css`.
- **Con fallback y token indefinido (degradan bien, no son defecto): dos** —
  `var(--card, transparent)` en `admin/tu-turno/vista.tsx:106` y
  `var(--shadow-card-hover, var(--shadow-card))` en `globals.css:405`.

Escenario, con valores. Una liquidación con `estatus = 'cuadrada'` renderiza
`cola.tsx:258-259` como `<span style={{ color: 'var(--ok)', background:
'var(--ok-bg)' }}>Cuadrada</span>`. `--ok-bg` no existe y no trae fallback:
`background` es propiedad no heredada, así que la declaración queda *invalid at
computed-value time* y computa a su valor inicial, **transparente**. Los tres
estados válidos —`cuadrada`, `con_diferencias`, `revisar`— pierden su píldora;
el fallback del estatus DESCONOCIDO (`:244`, `bg: 'var(--canvas)'`) usa un token
real y **sí conserva la suya**. En la columna «Cuadre» el único renglón con chip
relleno es el que el sistema no supo clasificar.

Consecuencia: la cola donde el contralor decide qué firmar pierde su semáforo y
le da el único énfasis visual al estado degradado. El mapa `ROTULO_ESTADO` sí
cubre 3/3 el dominio (`'cuadrada' | 'con_diferencias' | 'revisar'`,
`analytics_kpis_acreditables.test.ts:32`, `analytics.ts:1057`): el defecto es
puramente el nombre del token.

Causa raíz probable: la misma clase que FE-4 — un `var()` inexistente falla en
silencio, y el guardarraíl que `273ecd95` construyó vive en el directorio de
`/mcp/autorizar`, no en `src/app`.

---

### [MEDIO] REINCIDENTE PARCIAL — `secundarias` sigue sin las cuatro lecturas que el hallazgo enumeraba, y `pasos` desaparece sin banda ni leyenda
`src/app/dashboard/estado.ts:26-40` (la lista) y
`src/app/dashboard/inicio-contenido.tsx:574-576` (lo que se le pasa), contra
`:138` (`pGastosFiscalesSeries`), `:147` (`pViajesPorDia`), `:152` (`pPasos`) y
`:162` (`pResumenPerdidasSeries`), y `:436-441` (`BloqueArranque`).

Verificado hoy: `secundarias` tiene las nueve de siempre —`seriesKpis`,
`gastoSemanalSeries`, `liquidadoSemanalSeries`, `topRutasSeries`, `viajesPorMes`,
`cfgFiscal`, `gastosFiscales`, `escalados`, `huerfanos`— y **ninguna de las
cuatro** que la 25 nombró en la frase siguiente al título.

Escenario, con valores, sobre la única sin honestidad local. Flota recién dada de
alta: `getPrimerosPasos` cae y `safe` devuelve `null` (`:152`).
`inicio-contenido.tsx:441` hace `if (!pasos || pasos.completado) return null` —
**el mismo `return null` para «falló» y para «ya terminaste»**— y como `pasos` no
está en `secundarias`, `estadoPanel` devuelve `datos` y la banda «Faltan datos por
cargar — esta pantalla está incompleta» (`:596-604`) no enciende. Sale un Resumen
sin «Tu primera liquidación» ni «Opera por WhatsApp», idéntico al de una flota que
ya completó el arranque, sin una palabra.

Consecuencia: la flota nueva —la única que ese bloque existe para guiar— se queda
sin sus dos tarjetas de arranque y sin saber que le faltó algo.

Causa raíz probable: la lista de `secundarias` es manual y nada obliga a que una
lectura nueva entre en ella.

---

### [MEDIO] NUEVO — el pie de «Por confirmar» del panel afirma una razón falsa; el PDF de la misma liquidación afirma la correcta
`src/app/dashboard/[id]/detalle.tsx:87` (la llamada, sin `gastos`) contra
`src/lib/likida/liquidacion/deducibilidad.ts:86-93` (la rama) y
`src/lib/likida/liquidacion/pdf.ts:355` (el llamador que sí pasa el objeto
completo).

Escenario, con valores. `VJ-2026-0845` trae una sola caseta a crédito de $240
(`forma_pago = '99'`) sin REP: `cubetaDe` (`engine.ts:473-474`) la manda a
`por_confirmar` **sin emitir ninguna diferencia**, así que `totalPorConfirmar =
240`.

- En el **PDF**: `pdf.ts:355` llama `filasDeducibilidad(liq)` con el objeto
  completo, `hayPagoPendiente` (`deducibilidad.ts:86`) es `true` y el pie dice
  «A crédito (forma de pago 99) y sin complemento de pago: pendiente de pago
  comprobado…» (`engine.ts:167-169`).
- En la **pantalla**: `detalle.tsx:87` llama
  `filasDeducibilidad({ ...d.deducibilidad, totalComprobado, diferencias })` —
  **sin `gastos`**—, `liq.gastos ?? []` colapsa a `[]`, `hayPagoPendiente` es
  `false`, y el pie dice **«Falta timbrar la factura o acreditar el medio de
  pago. Se puede recuperar.»** (`deducibilidad.ts:93`).

Ni una de las dos cosas que afirma es cierta: la factura SÍ está timbrada y el
medio de pago no es lo que falta — falta el complemento de pago. La regla del
producto es que un rótulo tiene que ser verdad, y aquí el mismo importe tiene dos
explicaciones distintas según se lea en la pantalla o en el papel.

Refutación que intenté y no aguanta: `deducibilidad.ts:47-51` documenta la
degradación («el panel puede no traerlos — entonces el pie no afirma esa razón,
solo las de siempre»), pero la rama `false` no *omite* la razón: **afirma otra**.
Y la premisa ya no se sostiene: desde `75ec8629` el tipo
`LiquidacionDetalle['gastos']` declara `pagadoEn` (`analytics.ts:1306`), así que
el panel sí puede traerlos — salvo que, por el primer hallazgo, en el camino
principal vendrían siempre sin `pagadoEn` y el pie diría la razón de crédito
incluso cuando el REP ya llegó. Las dos mitades cuelgan del mismo campo perdido.

Consecuencia: el contralor que cruza la pantalla contra el PDF —que es
exactamente lo que hace— encuentra dos textos distintos para el mismo peso, y el
de la pantalla lo manda a pedir una factura que ya existe.

Causa raíz probable: `filasDeducibilidad` tiene un parámetro opcional cuya
ausencia cambia una afirmación, no solo su detalle.

---

## Lo que revisé y está bien

- **`273ecd95` no rompió la compilación ni el lint.** `npx tsc --noEmit -p .`
  **limpio** (corrida completa hoy) y `npx eslint src/app/mcp/autorizar
  src/lib/likida/analytics.ts 'src/app/dashboard/[id]'` **sin una advertencia**.
  El comentario `//` dentro del tag JSX (`page.tsx:255-259`) es trivia legal
  para el parser de TSX; no altera el `style` que le sigue.
- **El par de color del botón arreglado.** `--ink` está definido en
  `globals.css:51` (claro) y `:150` (oscuro); `--bg` en `:49` y `:150`. Medí los
  dos pares con la fórmula de luminancia relativa de WCAG: **17.5:1** y ~17.4:1.
  El botón hermano «No autorizar» (`page.tsx:267`, `color: var(--muted)`
  `#616876` sobre `#fbfbfd`) da **5.47:1**, AA para texto normal.
- **Las tres pruebas del área, verdes y con contenido.**
  `npx vitest run src/app/mcp/autorizar/tokens.test.ts
  'src/app/dashboard/[id]/renglon_pagado_en.test.ts'
  'src/app/dashboard/[id]/estado_renglon.test.ts'` → **16/16**. Reconstruí a mano
  que `tokens.test.ts` y `renglon_pagado_en.test.ts` fallan sin su arreglo (la
  primera por la lista de huérfanos, la segunda por el `toContain('pagado_en')`
  y por el tipo).
- **El `select` arreglado no pide una columna inexistente.** `gasto.pagado_en`
  existe y ya la leía `repo.ts:995`; `acotada()`/`exigir()` siguen envolviendo la
  consulta, así que el fallo cerrado no se debilitó.
- **El barrido de tokens usados-vs-definidos, rehecho de cero** (no heredado):
  las dos listas están en el hallazgo de `cola.tsx`. `--fg` ya no tiene ninguna
  referencia viva.
- **`ROTULO_ESTADO` y `ROTULO_REVISION` de `cola.tsx` cubren su dominio**: 3/3
  contra `'cuadrada' | 'con_diferencias' | 'revisar'` y 4/4 contra
  `RevisionLiquidacion` (`cola.tsx:32-38`, `:49-53`), con fallback explícito para
  el estatus desconocido en `:244`. El defecto de esa pantalla es el token, no el
  mapa.
- **`src/types/` no cambió** entre `ce6f462` y `HEAD` (`git diff --stat
  ce6f4621..HEAD -- src/` toca 7 archivos y ninguno es de `src/types/`), así que
  el censo de mapas literales de la ronda anterior sigue vigente sin rehacerse.
- **El alcance real de esta continuación es pequeño y lo verifiqué:** los únicos
  archivos de `src/` que se movieron desde `ce6f462` son
  `mcp/autorizar/page.tsx`, `mcp/autorizar/tokens.test.ts`,
  `dashboard/[id]/renglon_pagado_en.test.ts`, `analytics.ts`,
  `cuadre/desde_db.ts`, `cuadre/engine.ts` y una prueba de `desde_db` — o sea,
  ningún componente de pantalla salvo el botón del MCP.

---

## Lo que NO alcancé a revisar

- **Sigo sin mirar un render.** `npm run build` está prohibido y no hay
  credenciales. El 17.5:1 del botón arreglado y el fondo transparente de los
  pills de `cola.tsx` están **calculados y deducidos** de la regla CSS resuelta,
  no vistos. El de `cola.tsx` merece una captura antes de arreglarse.
- **No reproduje el primer hallazgo con una prueba.** No puedo escribir archivos
  fuera de este entregable; el camino de `reconstruir` está probado por lectura
  del literal de `:1633-1644` (once claves, `pagadoEn` ausente) y del `??` de
  `:1376`, no por ejecución. Es determinista y no depende de la base, pero
  conviene que quien lo arregle lo fije con una prueba sobre `reconstruir`, no
  sobre `leerGastos`.
- **Los otros dos reincidentes ALTOS los reverifiqué de fuente, sin ejercitar el
  flujo.** No simulé un `upload` fallido de Storage ni un ajuste real.
- **El resto del inventario abierto de `frontend.md`** —el ALTO del Cotizador en
  su cuarta ronda, los tres rótulos de rol divergentes, los tres `e.message`
  crudos, la cartera de Rentabilidad, las flechas de 16×16, los radios `sr-only`
  sin foco, la tarjeta Actividad, el script anti-parpadeo, `viajes/vista.tsx`, el
  chat con 11 de 13 tools y los dos BAJOS— **no lo retoqué**: ninguno de esos
  archivos se movió en esta ronda y el encargo era la reauditoría. Siguen
  abiertos tal como los dejó `frontend.md`.
- **Responsive, orden de foco, `/admin` a fondo y `/demo`**: igual que en la
  ronda, sin abrir.
