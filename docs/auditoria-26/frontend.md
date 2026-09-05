# Frontend — auditoría 26

**Nota: 5/10** (antes 5). Razón del movimiento: **se atacó y subió, y la deuda
cobró factura el mismo día.** Las dos fuerzas se cancelan y hay que decir las
dos, porque la nota plana esconde un cambio real:

- **Subió**: por primera vez en cuatro rondas, los cuatro hallazgos asignados a
  este rubro se cerraron, y tres de los cuatro con una prueba que mide lo que el
  hallazgo preguntaba, no lo que enumeraba. El de contraste (`4b90b08`) es el
  mejor trabajo del rubro en meses: mueve los siete hex a tokens `--region-*`
  con pareja clara/oscura **y** extiende `contraste.test.ts` para medirlos
  contra el fondo COMPUESTO (`color-mix` al 12 % resuelto sobre `--surface`), que
  era exactamente el agujero que hizo invisible el defecto. Verifiqué las 12
  aserciones corriendo la prueba y recalculando los siete pares a mano.
- **Bajó**: el ALTO del Cotizador cumple su **cuarta ronda** intacto (las cuatro
  `dark:` siguen siendo las únicas cuatro de `src/app`), los otros 12
  reincidentes siguen palabra por palabra, y —lo que pesa— **el trabajo de esta
  misma ronda metió tres defectos nuevos en la pantalla donde el contralor firma
  dinero**: `74109dd` le puso a `estadoRenglon` una pregunta que el dato que
  recibe no puede contestar, y `d914e74` cambió lo que ajustar HACE sin cambiar
  lo que la pantalla DICE que hace.

**Riesgo mayor de hoy:** ya no es el contraste. Es que `/dashboard/[id]` —la
pantalla de firmar— hoy **se contradice a sí misma en dos sitios a la vez**: la
píldora del renglón dice «Por confirmar» sobre un comprobante que el bloque de
deducibilidad de doce centímetros arriba cuenta como deducible, y el texto de
Ajustar promete que el cuadre no se recalcula justo cuando sí se recalcula y se
reimprime el PDF.

---

## Hallazgos

### [ALTO] `estadoRenglon` pregunta por `pagadoEn` a un objeto que nunca lo trae: todo CFDI a crédito ya pagado se pinta «Por confirmar»
`src/app/dashboard/[id]/vista.tsx:200` (la firma) y `:215` (la guarda nueva),
contra `src/lib/likida/analytics.ts:1439` (el `select`), `:1299-1303` (el tipo de
`LiquidacionDetalle['gastos']`) y `:1534-1536` (el tipo de la reconstrucción).
Llamado desde `src/app/dashboard/[id]/detalle.tsx:364`.

Escenario, con valores. Una caseta de CAPUFE facturada a crédito: `forma_pago
= '99'`, CFDI vigente, y su REP llegó el mismo mes → `intake/rep.ts` sella
`gasto.pagado_en = '2026-08-20'` y `gasto.pagado_forma = '03'`. El motor
(`cuadre/engine.ts:1633-1636`) calcula `pagadoConRep = true`, acredita el IVA, y
`cubetaDe` (`:446-455`) la manda a **`deducible`**; como el mes del pago es el
mismo del comprobante, **no emite ninguna diferencia** (`iva_mes_del_pago` solo
sale si `pagadoEn.slice(0,7) !== fecha.slice(0,7)`, `:1641`).

En la tabla del detalle, `estadoRenglon(g, [])`:
- `tipos` viene vacío → cae hasta `:215`,
- `pagoPendiente(g)` es `g.formaPago === '99' && !g.pagadoEn`,
- y `g` es una fila de `leerGastos`, que selecciona
  `id, concepto, monto, folio, fecha, forma_pago, cfdi_uuid, estado_sat,
  cfdi_valido, ocr_extra, imagen_url` — **`pagado_en` no está**, y
  `LiquidacionDetalle['gastos']` ni siquiera declara el campo.

→ `g.pagadoEn === undefined` **siempre** → `pagoPendiente` colapsa a
`formaPago === '99'` → la píldora sale **«Por confirmar», ámbar**, mientras el
bloque «Deducibilidad» de la misma pantalla (`detalle.tsx:86-87`, alimentado por
`liquidacion.deducibilidad` persistida, que sí trae `pagadoEn` — mig.
`0281:130`) la cuenta en la cubeta deducible, y el PDF también.

Consecuencia: el contralor firma una liquidación donde el renglón y el resumen
de la misma pantalla dicen cosas distintas sobre el mismo comprobante — el
defecto que `74109dd` decía estar cerrando, ahora con el signo invertido y sobre
el caso COMÚN (una flota que cobra a crédito y recibe REP tiene esto en casi
todas sus casetas y su diésel de estación con convenio). Y para quien mantenga:
`estado_renglon.test.ts:92-96` afirma «a crédito pero YA pagado sí puede salir
verde» pasándole a mano `pagadoEn: '2026-08-01'` — una forma de dato que ningún
llamador de producción puede producir. La prueba está verde y prueba algo que no
existe.

Causa raíz probable: el parámetro de `estadoRenglon` es un tipo estructural con
campos opcionales (`:200`), así que agregar `pagadoEn?: string` compila sin que
TypeScript exija que alguien lo llene; el arreglo tocó la función y no la
consulta que la alimenta.

---

### [ALTO] El panel de Ajustar sigue prometiendo «el cuadre no se vuelve a calcular» — desde `d914e74` sí se recalcula, se reimprime el PDF y se le vuelve a mandar al chofer
`src/app/dashboard/[id]/revision-panel.tsx:144` (el texto en pantalla) y `:19`
(el comentario de cabecera que lo repite), contra
`src/lib/likida/revision.ts:424-444` y `:485-501`, y
`src/lib/likida/revision_recalculo.ts:1-38`.

Escenario, con valores. El contralor abre `VJ-2026-0845`, elige «Ajustar
montos», y lee literalmente:

> «Escribe el monto CORRECTO del comprobante que se leyó mal. Los que dejes
> vacíos no se tocan. **El total se mueve por la diferencia; el cuadre no se
> vuelve a calcular.**»

Corrige el diésel de $800 → $8,000 y firma. Lo que de verdad pasa:
`revisarLiquidacion` corre `recalcularParaAjuste` ANTES de la RPC —vuelve a
correr `cuadrarDesdeDB` completo sobre los gastos vivos— y le manda a
`revisar_liquidacion` un `p_recalculo` con `ivaAcreditable`, `iepsAcreditable`,
`litrosDieselAcreditables`, `peajeAcreditable`, `estatus` y `diferencias`
nuevos; después `regenerarPdfTrasAjuste` **imprime los dos ejemplares, los sube
a la ruta canónica, archiva el anterior en `pdf_historial` y borra
`entregada_operador_en` / `avisada_oficina_en`**, con lo que el mecanismo de
reentrega le vuelve a mandar el PDF al chofer por WhatsApp.

Consecuencia: el rótulo no es impreciso, es lo contrario del hecho — y es la
regla que define al producto («un rótulo tiene que ser verdad»). Un contralor
que necesita que el IVA acreditable se mueva creerá que tiene que corregirlo
aparte; uno que NO quiere que al chofer le llegue un PDF nuevo lo dispara sin
saberlo. En sala, con el comprador leyendo la frase en la pantalla y el PDF
regenerándose detrás, es un error de los que se ven.

Causa raíz probable: el arreglo del CRÍTICO de backend cambió el comportamiento
en `revision.ts` y no tocó la única pantalla que lo describe; nada ata las dos
—el texto es una cadena literal en un `.tsx` sin prueba que lo cruce contra el
módulo.

---

### [ALTO] Si el PDF ajustado no se puede regenerar, la pantalla dice «se corrigió 1 comprobante» y calla que el papel vigente quedó con la cifra vieja
`src/lib/likida/revision.ts:495-501` (el `regenerado` que solo se loguea) y
`:357-366` (`ResultadoRevision`, sin campo donde viajar), contra
`src/app/dashboard/[id]/page.tsx:242-247` (el mensaje de éxito) — y contra el
patrón correcto que ya vive **en el mismo archivo**, `page.tsx:125`.

Escenario, con valores. Se ajusta el diésel de $800 → $8,000. La RPC confirma:
la base queda con el desglose nuevo. `regenerarPdfTrasAjuste` falla en el
`upload` a Storage (5xx de Supabase, o `getDatosFiscales` sin responder) y
devuelve `{ regenerado: false }` — nunca lanza, a propósito. `revision.ts:499`
escribe `logger.warn('revision.pdf_no_regenerado', …)` y **ahí muere**:
`ResultadoRevision` no tiene ningún campo para ese booleano, así que la página
no puede enterarse. En pantalla sale:

> «VJ-2026-0845: se corrigió 1 comprobante. El comprobado quedó en $18,400.00 y
> la diferencia en $1,200.00.»

…y el PDF que el contralor descarga con «Ver PDF» (y el que el chofer ya tiene)
sigue diciendo $11,200.00, porque `pdf_url` apunta al viejo.

Consecuencia: el archivo que el contador va a subir a su contabilidad y el que
el chofer guarda en su teléfono contradicen a la base y a la pantalla, sin un
solo aviso. Es exactamente la clase de falla silenciosa que el producto
prohíbe — y el propio archivo demuestra que sabe hacerlo bien: la acción de
reabrir (`page.tsx:125`) sí concatena « El PDF anterior ya no es válido.» cuando
`pdfPerdido`. El comentario de `revision_recalculo.ts:37-38` incluso dice «el
llamador decide qué decirle a la persona con `regenerado: false`»; el llamador
no le dice nada.

Causa raíz probable: el contrato `ResultadoRevision` se diseñó antes de que
existiera el PDF versionado y no creció con él; el `logger.warn` se sintió
suficiente.

---

### [ALTO] En el consentimiento MCP, el botón «Autorizar lectura» se pinta con `var(--fg)`, que no existe en ningún CSS del repo: texto #fbfbfd sobre #fbfbfd, 1.00:1
`src/app/mcp/autorizar/page.tsx:255`, sobre el fondo que pone `Marco` en `:60`.

Escenario, con valores y sin tocar ningún ajuste. La página envuelve todo en
`<main style={{ background: 'var(--bg)' }}>`; `--bg` = `var(--color-bg)` =
**`#fbfbfd`** (`globals.css:12` y `:49`). El botón primario declara
`style={{ background: 'var(--fg)', color: 'var(--bg)' }}` y **no tiene ninguna
clase de fondo** (`className="rounded-full px-6 py-2.5 text-sm font-medium"`).

Barrí `var(--…)` en TODO `src/` contra las definiciones de TODOS los `.css` más
las inline de los `.tsx`: `--fg` **no está definida en ninguna parte** (los
únicos parientes son `--marca-fg`, `--accent-fg`, `--color-bad`…). Un `var()` sin
fallback y sin definición es *invalid at computed-value time*: `background` es
una propiedad no heredada, así que computa a su valor inicial → **transparente**.
Resultado pintado: rótulo `#fbfbfd` sobre `#fbfbfd`, contraste **1.00:1**, sin
borde. El botón hermano «No autorizar» (`:262`, `border: 1px solid var(--muted)`,
`color: var(--muted)`) es el ÚNICO visible.

Que es descuido y no decisión lo prueba el mismo archivo dos veces: `:241` y
`:81` sí escriben `var(--faint, var(--muted))` con fallback, y `:255` es la
única declaración del archivo que no lo hace.

Consecuencia: el contralor que conecta Claude o su ERP a Likida por MCP llega a
una pantalla donde la única acción que ve es **«No autorizar»**. La integración
se muere en el paso del consentimiento y se lee como un producto roto, no como
un botón mal pintado.

Causa raíz probable: el archivo se escribió con un vocabulario de tokens
`--fg`/`--bg` que el sistema de diseño nunca tuvo (`--ink`/`--bg`), y el fallo de
`var()` es silencioso por definición — ninguna prueba mide tokens fuera de
`globals.css` y ninguna verifica que un token USADO exista.

---

### [MEDIO] Cierre PARCIAL: `secundarias` sumó `escalados`/`huerfanos` y dejó fuera las cuatro que el hallazgo también nombraba — `pasos` sigue desapareciendo sin banda ni leyenda
`src/app/dashboard/estado.ts:26-41` (la lista) y
`src/app/dashboard/inicio-contenido.tsx:574-577` (lo que se le pasa), contra
`:138`, `:147`, `:152` y `:162-172` (las cuatro lecturas ausentes) y `:436-441`
(`BloqueArranque`). **REINCIDENTE PARCIAL** — `d68ecdd`.

El hallazgo de la 25 decía, con estas palabras: «ni `escalados` ni `huerfanos`
están en la lista. Tampoco `viajesPorDia`, `resumenPerdidasSeries`,
`gastosFiscalesSeries` ni `pasos`, agregadas después», y cerraba con «la lista de
`secundarias` es manual y nada obliga a que una lectura nueva entre en ella — la
tercera lectura que se agregue va a repetirlo». El arreglo agregó las **dos**
del título y dejó las **cuatro** que la frase siguiente enumeraba.

Escenario, con valores, sobre la que no tiene honestidad local. Una flota que se
acaba de dar de alta: `getPrimerosPasos` cae (`safe` → `null`, `:152`).
`BloqueArranque` hace `if (!pasos || pasos.completado) return null` (`:441`) —
**el mismo `return null` para «falló» y para «ya terminaste»** — y `pasos` no
está en `secundarias`, así que `estadoPanel` devuelve `datos` y la banda «Faltan
datos por cargar — esta pantalla está incompleta» (`:596-604`) no enciende.
Sale un Resumen sin la tarjeta «Tu primera liquidación» ni «Opera por WhatsApp»,
idéntico píxel por píxel al de una flota que ya completó el arranque, sin una
palabra. Es la única de las cuatro sin red: `viajesPorDia` sí dice «No se pudo
cargar esta gráfica» (`actividad.tsx:39-46`) y `gastosFiscalesSeries` sí dice «No
se pudo leer el motor fiscal» (`motor-fiscal-periodo.tsx:39`) — les falta solo la
banda, no la honestidad.

Consecuencia: la flota nueva —la única que ese bloque existe para guiar— se
queda sin sus dos tarjetas de arranque y sin saber que le faltó algo. Y para el
que mantenga: la ronda 26 acaba de demostrar en vivo la advertencia del hallazgo
(lista manual → se agregan dos, se olvidan cuatro).

---

## Reincidentes verificados abiertos, sin re-argumentar

Los abrí uno por uno en `ce6f462`; ninguno se tocó desde la 25 salvo donde digo.

- **[ALTO] FE-13b — el chip de estado del Cotizador a 1.24:1 y «Crear viaje» a
  2.76:1 al hover, con el tema POR OMISIÓN y el SO en oscuro. CUARTA RONDA.**
  Las cuatro `dark:` siguen siendo las **únicas cuatro** de todo `src/app`
  (`cotizaciones/page.tsx:274`, `cotizaciones/acciones.tsx:27-28`). Las tres
  premisas siguen en pie, reverificadas hoy: `globals.css:1` es
  `@import "tailwindcss"` pelón, no hay `@custom-variant dark` en ningún `.css`
  ni `tailwind.config.*` (en Tailwind v4 eso hace que `dark:` **sea**
  `@media (prefers-color-scheme: dark)`), `globals.css:136-141` borró ese media
  query a propósito, y `selector-tema.tsx:20` deja **`claro`** por omisión —
  `layout.tsx:52` estampa `data-theme="light"`, así que la tinta se queda en
  `--ink` #17100d mientras el fondo salta a `bg-neutral-800` #262626.
- **[MEDIO] Los tres pills de la cola de revisión piden `--ok-bg` / `--bad-bg` /
  `--warn-bg`, que no existen.** `cola.tsx:50-52` sigue con el guion; los tokens
  reales son `--okbg`/`--warnbg`/`--badbg` (`globals.css:110-115` y `:164-166`).
  Se pintan en `cola.tsx:259` (`style={{ color: e.fg, background: e.bg }}`) →
  fondo transparente en los tres estados válidos, mientras el fallback del
  estatus DESCONOCIDO (`:244`) sí usa un token real y conserva su píldora. Mi
  barrido de tokens usados-vs-definidos lo confirma: junto con `--fg` son los
  únicos cuatro rotos de todo `src/app`.
- **[MEDIO] Los rótulos de rol siguen divergiendo — cierre PARCIAL de
  `f128cd1`.** El commit fusionó cuatro copias literales de `ROL_LABEL` en
  `lib/auth/provisionar.ts:36-42` (bien: `Record<RolAppUser,…>`, exhaustiva). Lo
  que quedó fuera son las copias que se llaman de OTRA manera, y el barrido
  nuevo (`rol_label_unico.test.ts:23`) hace `grep -E '(const|let) ROL_LABEL'`,
  así que no puede verlas: `lib/auth/roles.ts:27` («Dueño de la flota»),
  `dashboard/chrome.tsx:30` («ADMIN FLOTA») y
  `agentes/notificaciones-forma.tsx:45-48` («Dueño de la flota» / «Jefe de
  tráfico» para `encargado`) contra el «Encargado» de la fuente única. Tres
  nombres para el mismo rol, en tres pantallas.
- **[MEDIO] El mensaje crudo del servidor llega a pantalla en tres páginas.**
  `conversaciones/page.tsx:51` (`errorCarga = e.message`, pintado en `:89-90`
  con `.slice(0,120)`), `arco/page.tsx:158` (pintado en `:201-202`) y
  `mapa/vista.tsx:119-121` (`.slice(0,140)`). Rebarrí `e instanceof Error ?
  e.message` en `src/app/dashboard` y `src/app/admin`: las demás van a `logger`
  o pasan por `mensajeParaPantalla` (`lib/likida/errores.ts:64-71`, buen
  guardarraíl); estas tres siguen siendo las únicas que imprimen el crudo de
  PostgREST.
- **[MEDIO] La cartera de Rentabilidad afirma «Aún no hay facturas emitidas
  registradas» en una página vacía.** `rentabilidad/vista.tsx:114` sigue
  gateando por `cobranza.facturas.length === 0` teniendo `cobranza.total` a la
  mano (lo usa en `:46` y lo imprime en `:179`). Con `?p=99` sobre 350 facturas:
  `facturas.length === 0`, `total === 350` → «Aún no hay facturas emitidas
  registradas». Quinta ronda abierto.
- **[MEDIO] Las ‹ › que cambian el periodo miden 16×16 px, y el par de la
  tarjeta FISCAL va con `gap-0`.** `kpi-periodo.tsx:10` (`BOTON = 'w-4 h-4 …'`,
  botones `:78-85`, contenedor `gap-0.5`) y `motor-fiscal-periodo.tsx:7` (mismo
  `w-4 h-4`) con contenedor `flex items-center gap-0` en `:43`. WCAG 2.2 SC
  2.5.8 pide 24×24; el vecino `selector-tema.tsx:73` ya usa `w-6 h-6`.
- **[MEDIO] Los tres botones que firman una liquidación son radios `sr-only` sin
  anillo de foco.** `revision-panel.tsx:126-137`: el `<input type="radio"
  className="sr-only">` sigue en `:134` y el `<label>` sigue sin
  `has-[:focus-visible]` ni `peer-focus-visible`. Confirmé el alcance del único
  `:focus-visible` del repo: `globals.css:381-383`, solo `.sb-aside a/button`.
  WCAG 2.4.7 sobre el control que firma dinero.
- **[MEDIO] En «Histórico», la tarjeta Actividad afirma «Aún no hay viajes
  registrados» cuando lo que falló fue la consulta.** `inicio-contenido.tsx:725`
  sigue siendo `porMes={viajesPorMes ?? []}`, y `actividad.tsx:53` sigue
  evaluando `porMes.every(d => d.valor === 0)` sobre ese `[]` (que en un arreglo
  vacío es `true`). El gemelo honesto (`porDia`, `:39-47`) sigue al lado, en la
  misma función. Cuarta ronda. Nota: la banda de «pantalla incompleta» SÍ
  enciende ahora (`viajesPorMes` está en `secundarias`), así que la pantalla se
  contradice consigo misma en vez de callarse.
- **[MEDIO] El script anti-parpadeo del tema solo corre en `/dashboard`.**
  `layout.tsx:52` sigue con `location.pathname.indexOf('/dashboard')!==0` y
  `SelectorTema` sigue montado en `admin/sidebar-nav.tsx:149`.
- **[MEDIO] En el Registro de Viajes la dirección de la diferencia la lleva solo
  el color.** `viajes/vista.tsx:216-218` sigue imprimiendo
  `mxn(Math.abs(v.diferencia))` con ámbar/rojo y la leyenda en el `tfoot`
  (`:243-251`).
- **[MEDIO] El chat rotula 11 tools y el analista declara 13.**
  `chat.tsx:43-55` (11 claves) contra `lib/agents/analista.ts:42-49`
  (`TOOLS_LECTURA`, 12) más `entregar_respuesta` (`:200`): faltan
  `consultar_carta_porte` y `consultar_normas`, que `chat.tsx:56` degrada a
  `t.replaceAll('_',' ')` → «consultar carta porte».
- **[BAJO] Categoría y prioridad del ticket, crudas.** `soporte/page.tsx:252` y
  `:253` siguen imprimiendo `t.categoria` y `t.prioridad` sin mapa, contra
  `('facturacion','operacion','tecnico','cuenta','otro')` y
  `('baja','media','alta','urgente')` (`0051:42-43`).
- **[BAJO] `cotizaciones/page.tsx:274` imprime `q.estado` crudo en mayúsculas**,
  contra el dominio `('borrador','enviada','ganada','perdida','vencida')`
  (`0051:95`).

---

## Lo que revisé y está bien

**Los cuatro asignados, verificados contra el código y no contra el asunto del
commit:**

- **`4b90b08` (Región) — CERRADO, y bien.** `top-rutas.tsx:14-22` ya no tiene un
  solo hex: `VAR_REGION` mapea a `--region-*` y `colorDe` devuelve
  `var(--region-x)` o `var(--muted)` para «Sin clasificar». Los siete tokens
  viven en `globals.css:127-133` (claro) y `:168-174` (oscuro).
  `contraste.test.ts:180-224` reproduce `color-mix(… 12%, transparent)` sobre
  `--surface` y mide los siete en los DOS temas — que es la pregunta correcta,
  no `--surface` a secas. Corrí la prueba: **12/12 verdes**. Rebarrí
  `#[0-9a-f]{6}` en todo `src/app/dashboard`: **cero ocurrencias fuera de
  pruebas** — el panel del cliente ya no pinta un solo color a mano.
- **`c46bd91` (tile «Sin CFDI») — CERRADO.** `sin-cfdi.ts:26-37` separa los tres
  estados (`error` / `sin_datos` / `ok`) y `combustible-casetas/page.tsx:231-240`
  les da tres mensajes distintos: «No se pudo leer si hay CFDI de estos
  conceptos» ya no es «Sin comprobantes de estos conceptos todavía». La `nota`
  con el «N de M» solo se pinta en `ok`, así que tampoco queda una explicación
  huérfana.
- **`d68ecdd` (escalados/huérfanos) — cerrado en su mitad; la otra es el MEDIO de
  arriba.** `AvisoEstado` (`inicio-contenido.tsx:533-563`) sí recibe
  `pEscalados`/`pHuerfanos` —las MISMAS promesas de `BloqueAlertas`, sin consulta
  nueva— y `estado.ts:36-40` los declara en `secundarias`.
- **`764c6f8` (badge de rol) — CERRADO.** `chrome.tsx:22-34`: se fue
  `operador: 'OPERADOR'`, entró `vendedor: 'VENDEDOR'`, y el comentario ahora
  cita las tres migraciones correctas (0044 abrió, 0086 retiró, 0105 agregó) en
  vez de afirmar completitud contra una sola.

**El trabajo obligatorio — cada mapa literal contra su dominio.** `src/types/`
**no cambió un byte** entre `4f94490` y `ce6f462` (`git diff --stat` vacío), así
que el censo de la 25 sigue vigente; reverifiqué los que ella dejó fuera por ser
`Record<string, …>` sin tipar y salieron **completos**:
`CONCEPTO` (`[id]/page.tsx:30-34`) y `CONCEPTO_LABEL`
(`gasto-semanal-chart.tsx:13-17`) — **9/9 los dos** contra `ConceptoGasto`
(`types/likida.ts:20-25`), y coinciden entre sí clave por clave;
`FORMA_PAGO` (`[id]/vista.tsx:149-153`) cubre las 9 claves que el motor admite,
con `etiqueta_forma_pago.test.ts` vigilándolo;
`ESTADO_UNIDAD` (`unidades/vista.tsx:27-32`) 4/4 contra `ESTADOS_UNIDAD`
(`operacion.ts:837-842`), que es el mismo dominio que valida el servidor en
`:880`; `PILL` de `carta-porte/vista.tsx:116-120` 3/3 contra la unión cerrada
`'si' | 'no' | 'falta_declarar'` (`carta_porte.ts:78`) — sin `??`, pero la unión
lo hace inalcanzable. `ROL_BADGE` (`chrome.tsx:29-34`) 5/5 con el dominio vivo.

**Un barrido nuevo que no existía: tokens USADOS contra tokens DEFINIDOS.**
Extraje todo `var(--x)` **sin fallback** de los ~1,100 `.ts/.tsx` de `src/app` y
lo crucé contra las definiciones de todos los `.css` del repo más las inline.
Resultado: **exactamente cuatro rotos** —`--fg` (hallazgo) y
`--ok-bg`/`--bad-bg`/`--warn-bg` (reincidente)—; `--font-sans-ui`,
`--font-display`, `--font-mono`, `--font-serif`, `--font-fraunces` y
`--font-instrument` los define `next/font` (`layout.tsx:17-19`,
`editorial.tsx:47`, `login/page.tsx:45,50`), `--crema` vive en
`login/login.css:36`, y `var(--card, transparent)`
(`admin/tu-turno/vista.tsx:106`) trae fallback a propósito. Este barrido es la
generalización del reincidente de `cola.tsx`: hoy son cuatro, y nada impide el
quinto.

**Estados de carga.** `src/app/cargando.tsx` (reexportado por
`dashboard/loading.tsx`, `dashboard/[id]/loading.tsx` y `admin/loading.tsx`) es
el logo respirando con `role="status" aria-label="Cargando"`, y
`globals.css:327-329` lo apaga bajo `prefers-reduced-motion` dejando
`opacity: .6` — igual que `.skeleton` en `:288-290`. Ninguno de los tres
`loading.tsx` promete una forma que no conoce.

**Redes de error y fallo cerrado.** Reverifiqué `mensajeParaPantalla`
(`lib/likida/errores.ts:64-71`): `DatoInvalido` verbatim, cualquier otra al
logger + una frase que distingue «no es por lo que capturaste». El error del
recálculo de ajuste (`revision.ts:441`) se envuelve en un `Error` pelón, así que
cae en esa rama y no llega crudo. `facturacion/estadias.tsx:120-142` levanta un
`leyoOk` en vez de un `[]` mudo. `viajes/vista.tsx:88` pinta `—` (no `0`) para
cada conteo `null`.

**Llaves de React en las tablas que llevan dinero.** Barrí `key={i|idx|index}`
en todo `src/app`: **ninguna** de las ocurrencias está en una lista que se
reordene o filtre con hijos con estado. Las tablas de dinero usan id estable:
`cola.tsx:243` (`key={l.id}`), `top-rutas.tsx:48`
(`key={origen→destino}`), `revision-panel.tsx:154` (`key={g.id}`, y los inputs
van con `name={monto:${g.id}}`, no por posición), `revision-panel.tsx:91`
(`key={a.gastoId}`). `detalle.tsx:363` usa `key={g.id ?? i}` — el `??` solo
aplica a gastos viejos sin id, que no se pueden ajustar.

**Contraste de los tokens, remedido hoy** con la fórmula de
`contraste.test.ts:24-34`: los pares `--ok/--okbg`, `--warn/--warnbg`,
`--bad/--badbg` y las siete regiones pasan AA en los dos temas. `npx tsc
--noEmit -p .` **limpio**.

---

## Lo que NO alcancé a revisar

- **Sigo sin mirar un render.** `npm run build` está prohibido y no hay
  credenciales: todo lo de arriba es lectura de fuente y aritmética. El 1.00:1
  de `/mcp/autorizar` y el 1.24:1 del Cotizador están **calculados** sobre la
  regla CSS resuelta, no vistos; el fondo transparente de `cola.tsx` está
  deducido de «invalid at computed-value time», no capturado. Los tres merecen
  una captura antes de arreglarse.
- **Responsive de verdad.** No abrí ninguna de las ~46 páginas a 390 px. Lo que
  hay es aritmética de anchos declarados, y la heredé de la 25 sin rehacerla.
  Sigo sin ver el Cotizador ni la cola de revisión en celular.
- **Los otros dos defectos que `d914e74` pudo haber dejado en pantalla.** Miré
  el texto de Ajustar y el mensaje de éxito; NO revisé si el detalle
  (`detalle.tsx`) enseña el historial de PDFs (`pdf_historial`) ni si el link
  «Ver PDF» dice cuál versión está sirviendo. Si el PDF ahora se versiona, la
  pantalla probablemente tenga que decirlo, y no lo verifiqué.
- **`/admin` a fondo.** Los `Record<string,string>` de `mapa-prospectos`, `qa`,
  `evals`, `marketing`, `vendedores`, `costos-facturacion`, `observabilidad`,
  `consola` y `analitica` siguen sin compararse contra sus dominios. Sí anoté
  que `/admin` conserva hex en línea (`contador-retro.tsx:38-48`,
  `mapa-prospectos/cerebro.tsx:271-323`, `dev/page.tsx:152`) — invisibles para
  `contraste.test.ts`, igual que lo estaba `top-rutas` — pero no los medí: el
  comprador no ve esas pantallas y preferí gastar el presupuesto en
  `/dashboard`. Tampoco medí sus áreas de toque (`mapa-actividad.tsx:32`, 11×11).
- **El orden de foco** de ninguna pantalla, ni la navegación por teclado del
  acordeón del sidebar (`sidebar-nav.tsx:57-66`).
- **`/vendedor`, `/cuenta`, `/aviso/[tenant]`, `/blog`, `/calculadora`,
  `/legal`, `/demo`** — solo lo suficiente para el barrido de tokens y de
  `key=`. `/demo` en particular no lo abrí, y es la pantalla que se enseña.
- **No corrí la suite completa.** Solo `contraste.test.ts` (12 verdes) y `tsc`.
