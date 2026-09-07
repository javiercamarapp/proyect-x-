# Frontend — auditoría 27

**Nota: 4/10** (antes 4). Razón del movimiento: **la nota no se mueve porque dos
fuerzas del mismo tamaño se cancelan, y hay que decir las dos.**

- **Se atacó y subió.** Por primera vez en seis rondas, los tres puntos que se
  me asignaron están cerrados **de verdad** — los abrí uno por uno y reconstruí
  el escenario, no me fié del commit. FE-1b (`fc98bbf6`) llegó esta vez al
  camino que corre; el par de PDF divergentes ya no existe porque `uploads.every`
  bloquea la publicación del puntero; los tres tokens de `cola.tsx` están
  arreglados y mi barrido propio de los ~1,100 archivos de `src/` encuentra
  **cero** `var(--x)` huérfanos. Y de propina cayeron los otros dos ALTOS que la
  26 dejó abiertos: el texto de Ajustar y el PDF pendiente, éste último con una
  afordancia nueva («Reintentar PDF») en vez de un mensaje. Eso solo valía un 6.
- **Deuda que cobró factura, otra vez el mismo día.** En la misma ventana entró
  un CRÍTICO de la clase exacta que el rubro nombra —«un estado que la UI no
  sabe pintar», aquí «un campo que la UI dejó de ofrecer y el motor sigue
  necesitando»—: el despacho del jefe de tráfico ya no tiene el Anticipo, nada
  lo sustituye, y la pantalla donde se firma presenta el cero resultante como si
  fuera una medición. Entró bajo un asunto de commit que dice `test:`.

**Riesgo mayor de hoy:** todo viaje que despache el jefe de tráfico nace con
`anticipo = 0`, y `/dashboard/[id]` lo lee como «$0.00 entregado al operador» y
declara el comprobado completo «faltante · a favor del operador». Es la regla que
define al producto —nunca un cero que parezca medición— rota en la pantalla que
el producto existe para producir.

---

## Veredicto sobre los tres puntos que traía abiertos

### `fc98bbf6` — FE-1b: **CERRADO, y contesta la pregunta, no las líneas**

Abierto y comprobado: `analytics.ts:1553` declara ahora `pagadoEn?: string` en
`FilaImprimibleConFiscal`, y el `.map()` del camino que gana —el de
`reconstruir`, el que elige el `??` de `:1383`— lo copia en `:1651`
(`pagadoEn: x.pagadoEn || undefined`). El dato existe río arriba (`repo.ts:995`
lo mapea desde `pagado_en`, `filasImprimibles` devuelve los `Gasto` del motor tal
cual), y `LiquidacionDetalle['gastos']` (`analytics.ts:1311-1315`) lo declara. Con eso
`pagoPendiente` (`vista.tsx:215`) vuelve a tener sus dos mitades y la caseta de
$240 a crédito con REP del 2026-08-20 deja de salir «Por confirmar» mientras el
bloque de Deducibilidad la cuenta como deducible. **Los dos caminos que llenan la
misma tabla vuelven a contestar igual**, que era la pregunta de fondo del
hallazgo, no solo las líneas que enumeraba.

### Los dos ejemplares del PDF con cifras distintas: **CERRADO**

`revision_recalculo.ts:143-147`: los dos `generarLiquidacionPDF(...).then(subir)`
van en un `Promise.all`, y `if (!uploads.every(Boolean)) return { regenerado:
false }` **antes** de llamar `publicar_pdf_liquidacion`. El puntero `pdf_url` solo
lo mueve esa RPC, así que una subida a medias deja objetos huérfanos en Storage
pero **nunca** un par publicado con cifras distintas. `rutasPdfVersionadas`
(`rutas_pdf.ts:4-7`) sortea un `randomUUID()` nuevo en cada intento, así que el
`upsert: false` no puede envenenar el reintento con un objeto ya existente —el
modo de falla que este arreglo podía haber introducido y no introdujo. Y el
resultado llega a pantalla: `ResultadoRevision.pdfPendiente` (`revision.ts:368`,
puesto en `:503`) → mensaje en `page.tsx:248` → banner y botón en
`detalle.tsx:166-171`, gateados por `!d.pdfPath && revision === 'ajustada' &&
puedeFirmar` (`page.tsx:286`).

### Los tres tokens CSS de `cola.tsx`: **CERRADO el síntoma, el guardarraíl sigue en un solo directorio**

`cola.tsx:49-53` ya pide `var(--okbg)` / `var(--badbg)` / `var(--warnbg)`, que
`globals.css:111/113/115` (claro) y `:165-167` (oscuro) sí declaran. **Barrido
propio, hecho hoy, no heredado**: extraje todos los `var(--x)` de los `.ts`,
`.tsx` y `.css` de `src/` y los crucé contra las definiciones de `globals.css`,
`login/login.css` y las inline de los `.tsx`. Resultado: **cero huérfanos sin
fallback** (las tres únicas menciones de `--fg`/`--typo`/`--x` que quedan viven
en comentarios de `mcp/autorizar/tokens.test.ts`), y dos con fallback declarado
—`var(--card, transparent)` en `admin/tu-turno/vista.tsx:106` y
`var(--shadow-card-hover, var(--shadow-card))` en `globals.css:405`—, que
degradan bien. Lo que **no** cambió: el arreglo (`3d973998`) son tres líneas y
**cero pruebas**, y `tokens.test.ts:24` sigue leyendo un solo archivo
(`src/app/mcp/autorizar/page.tsx`). Ver el BAJO de abajo.

---

## Hallazgos

### [CRÍTICO] El despacho del jefe de tráfico ya no ofrece el Anticipo y nada lo sustituye: el viaje nace en 0 y la pantalla de firma presenta ese cero como una medición
`src/app/dashboard/forma-viaje.tsx:90` (el campo, ahora condicionado) y `:174`
(lo que se puso en su lugar), `src/app/dashboard/despacho/page.tsx:80` (quién es
`puedeCapturarDinero`) y `:155` (`… : 0`), contra
`src/lib/likida/cuadre/engine.ts:1241` y `:1250-1252` (lo que el motor concluye),
`src/app/dashboard/[id]/detalle.tsx:212` y `:219` (lo que el contralor lee) y
`src/app/dashboard/primera-liquidacion.tsx:25-27` renderizado desde
`src/app/dashboard/inicio-operacion.tsx:238` (lo que al encargado se le pide
hacer).

Escenario, con valores. Flota con un jefe de tráfico (`rol = 'encargado'`, el rol
para el que `/dashboard/despacho` existe: `puedeAsignar` lo incluye,
`permisos.ts:18`). El lunes despacha `VJ-2026-0845` Silao → Monterrey con
anticipo real de **$20,000** entregados en efectivo al chofer.

1. En su Resumen (`inicio-operacion.tsx:238`) la guía de arranque le dice, paso
   2: **«Crea un viaje con su anticipo — Ruta, operador y anticipo»**, con el
   botón «Crear viaje» que lleva a `/dashboard/despacho`.
2. Allí, `puedeVerArea('encargado','dinero')` es `false`
   (`visibilidad.ts:41`) → `puedeCapturarDinero = false` → `forma-viaje.tsx:90`
   **no pinta el campo Anticipo**. En su lugar, `:174` pinta «Kilómetros». No hay
   una sola línea en pantalla que diga que el anticipo lo tiene que capturar
   alguien más.
3. `despacho/page.tsx:155`: `fd.get('anticipo')` es `null` → `anticipo = 0`, y
   `crearViaje` lo escribe (`operacion.ts:658`, `v.anticipo ?? 0`). La columna es
   `NOT NULL DEFAULT 0` (0001, lo dice `api/v1/_escritura.ts:887`), así que **no
   existe un valor que signifique «no capturado»**: 0 tecleado y 0 por ausencia
   son indistinguibles para siempre.
4. El viernes el chofer manda sus comprobantes por **$18,400**. El motor:
   `diferencia = round2(0 − 18400) = −18400`, `|−18400| ≥ 0.5` → emite la
   diferencia `tipo: 'anticipo'` con la nota **«El operador puso $18,400.00 de su
   bolsa — a favor del operador.»** (`engine.ts:1241`, `:1251`).
5. El contralor abre `/dashboard/[id]` y lee, uno junto al otro:
   `<Kpi titulo="Anticipo" valor="$0.00" nota="entregado al operador">`
   (`detalle.tsx:212`) y `Diferencia $18,400.00 · «faltante · a favor del
   operador»` en tono `bad` (`:217-219`), más la nota completa del motor en el
   bloque de diferencias (`:316`). El PDF que se le manda al chofer lleva la
   misma frase.
6. **No hay dónde arreglarlo.** `name="anticipo"` existe en UN solo input de todo
   `src/` (`forma-viaje.tsx:91`), y no hay ni un `update` de `viaje.anticipo` en
   `src/lib` ni en `src/app`. El único escritor es la creación.

Refutaciones que intenté y no aguantan: (a) el aviso de WhatsApp **sí** es
honesto —`notificar.ts:85-86` trata el 0 como «sin anticipo registrado»—, lo que
prueba que el resto del sistema sabe que 0 no es un dato, y aun así el motor y el
panel lo tratan como uno; (b) la importación CSV **sí** falla cerrado y lo dice
(`importar_viajes.ts:158-163` rechaza el archivo entero con «Tu rol sólo puede
importar datos operativos…»), o sea que la puerta de al lado resolvió bien el
mismo problema y ésta no; (c) `permisos-dinero.test.tsx:51-54` no es un
guardarraíl contra esto: **fija la conducta** (`expect(m.crear)
.toHaveBeenCalledWith('t1', expect.objectContaining({ anticipo: 0 }))`), así que
el cero quedó escrito como el resultado esperado.

Consecuencia: el contralor firma una liquidación cuya cifra principal —la
diferencia, que es el producto entero— está mal por el monto del anticipo, y el
papel que el chofer guarda en su teléfono afirma que la empresa le debe $18,400
que ya cobró. La flota que más se parece al comprador (una con jefe de tráfico
dedicado, o sea toda la que tiene más de diez unidades) es exactamente la que
cae. Y para quien mantenga: el cero no se puede corregir después ni distinguir
del cero real.

Causa raíz probable: el bloqueo de la captura financiera se resolvió ocultando el
campo en el render, sin decidir quién captura entonces el dato que el motor
necesita ni cómo se representa «no capturado» en una columna `NOT NULL DEFAULT 0`.

---

### [ALTO] REINCIDENTE (quinta ronda) — el Cotizador se pinta con neutros de Tailwind cableados; con el tema oscuro elegido y el SO en claro, su chip de estado queda a 1.01:1
`src/app/dashboard/cotizaciones/page.tsx:274` (el chip) y `:160,163,181,197,219,
252,253,254,262,280,284,298,307,312` (los catorce `text-neutral-500/600`), más
`src/app/dashboard/cotizaciones/acciones.tsx:27-28`, contra
`src/app/globals.css:1` (`@import "tailwindcss"` pelón), `:143` y `:150`
(`:root[data-theme="dark"]`, `--ink: #f4f4f5`), `:219-222` (`html, body { color:
var(--ink) }`) y `src/app/selector-tema.tsx:20,27-29`.

Verificado hoy de fuente: siguen siendo **las únicas cuatro** `dark:` de todo
`src/app`, y `src/app/cotizaciones` es el **único** directorio de `src/app` con
neutros de Tailwind cableados (17 apariciones en dos archivos; el resto de la app
usa tokens). No hay `@custom-variant dark` en ningún `.css` ni `tailwind.config.*`
—lo confirmé— así que en Tailwind v4 `dark:` **es** `@media (prefers-color-scheme:
dark)`, mientras el tema del producto vive en `data-theme`. Los dos ejes son
independientes, y de sus cuatro combinaciones **dos** están rotas:

- **SO en claro + tema oscuro elegido con el 🌙** (el caso que ninguna ronda
  anterior midió): `data-theme="dark"` pone `--ink: #f4f4f5` y `body` hereda ese
  color; `dark:bg-neutral-800` **no** se aplica, así que el chip conserva
  `bg-neutral-100` = `#f5f5f5`. Texto `#f4f4f5` sobre `#f5f5f5` → **1.01:1**
  (fórmula de luminancia relativa WCAG, recalculada a mano). El chip que dice si
  la cotización está `borrador`, `enviada`, `ganada` o `perdida` desaparece por
  completo. En la misma pantalla, `text-neutral-500` (`#737373`) sobre `--surface`
  `#131316` mide **3.9:1** y `text-neutral-600` (`#525252`) mide **2.4:1** —
  ambos reprueban AA (4.5:1), y ahí es donde vive la línea «falta el precio» y el
  supuesto de cada renglón del desglose citable.
- **SO en oscuro + tema por omisión** (`claro`, `selector-tema.tsx:20`): el caso
  que la 24 midió, chip a 1.24:1 y «Crear viaje» a 2.76:1 al hover. Intacto.

Consecuencia: el Cotizador es la pantalla donde se decide a cuánto se vende un
flete, y en dos de sus cuatro combinaciones de tema el estado de la cotización es
invisible y los supuestos del precio son ilegibles. Quien elige el tema oscuro en
un equipo con el SO en claro —lo más común en una laptop de oficina— ve la
pantalla peor que quien no lo elige.

Causa raíz probable: la pantalla se escribió con utilidades de color en vez del
sistema de tokens, y el `dark:` que le pusieron encima responde a un eje distinto
del que el producto usa para cambiar de tema.

---

### [MEDIO] REINCIDENTE (quinta ronda) — la cartera de Rentabilidad afirma «Aún no hay facturas emitidas registradas» sobre una página vacía de una cartera con saldo, y se lleva por delante el link para volver
`src/app/dashboard/rentabilidad/vista.tsx:114-119` (la guarda por
`facturas.length`) contra `:37-38` (donde el mismo archivo sí usa
`cobranza.total`), `:43-45` (el comentario que anticipa el caso `?p=99`) y
`:182-192` (los links de paginación, que viven **dentro** de la rama que la
guarda apaga); alimentado por `src/app/dashboard/rentabilidad/page.tsx:34`
(`sp.p`, clamp 1..1000) y `src/lib/likida/comercial.ts:322-323`.

Escenario, con valores. Flota con **50** facturas emitidas y **$412,000** por
cobrar, de los cuales **$88,000** vencidos. `COBRANZA_POR_PAGINA` es 100, así que
todo cabe en la página 1. El contralor entra por un enlace guardado, o teclea,
`/dashboard/rentabilidad?p=2`:

1. `page.tsx:34` acepta `pagina = 2`; `getCobranza` pide
   `p_desplazamiento = 100` → `facturas: []`, pero `total = 50` y los agregados
   siguen siendo `porCobrar: 412000`, `vencido: 88000` (se calculan en SQL sobre
   **toda** la cartera, `comercial.ts:328-334`).
2. `vista.tsx:114`: `cobranza.facturas.length === 0` → se pinta el `EstadoVacio`
   **«Aún no hay facturas emitidas registradas — al registrar la primera, aquí
   aparece la cartera…»**.
3. Ese `EstadoVacio` sustituye a la `<section>` entera: se van también las dos
   StatCards de $412,000 y $88,000, el renglón «Facturas X–Y de 50» y —lo que
   convierte el error en un callejón— el link **«Anteriores»** (`:184-187`), que
   solo se pinta dentro de esa misma rama. No hay forma de volver a la página 1
   desde la pantalla.

Consecuencia: la pantalla que responde «¿cuánto me deben?» afirma que no hay ni
una factura mientras hay 50 con $412,000 pendientes, y el contralor queda sin
salida salvo editar la URL. El propio archivo demuestra que sabe cuál es la señal
correcta: `:37` distingue el vacío real con `cobranza.total === 0`.

Causa raíz probable: el vacío de la CONSULTA (esta página) y el vacío del NEGOCIO
(no hay facturas) se decidieron con la misma expresión.

---

### [MEDIO] REINCIDENTE — el pie de «Por confirmar» del panel sigue afirmando una razón falsa, y la excusa que lo justificaba ya no existe
`src/app/dashboard/[id]/detalle.tsx:88` (la llamada, sin `gastos`) contra
`src/lib/likida/liquidacion/deducibilidad.ts:47-53` (la degradación documentada),
`:86-93` (la rama) y `src/lib/likida/liquidacion/pdf.ts:355` (el llamador que sí
pasa el objeto completo).

Verificado hoy: `detalle.tsx:88` sigue siendo
`filasDeducibilidad({ ...d.deducibilidad, totalComprobado, diferencias })` — sin
`gastos` — palabra por palabra.

Escenario, con valores. `VJ-2026-0845` trae una caseta de CAPUFE de **$240** con
`forma_pago = '99'` y sin REP: `cubetaDe` la manda a `por_confirmar` sin emitir
diferencia, `totalPorConfirmar = 240`.

- **PDF** (`pdf.ts:355`, con el objeto completo): `hayPagoPendiente` es `true` y
  el pie dice «A crédito (forma de pago 99) y sin complemento de pago…».
- **Pantalla** (`detalle.tsx:88`): `liq.gastos ?? []` colapsa a `[]`,
  `hayPagoPendiente` es `false`, y el pie dice **«Falta timbrar la factura o
  acreditar el medio de pago. Se puede recuperar.»**

Ni una de las dos cosas que afirma es cierta: la factura ya está timbrada y el
medio de pago no es lo que falta. Y la premisa que `deducibilidad.ts:50-52`
invoca para tolerarlo —«el panel puede no traerlos»— **está muerta desde
`fc98bbf6`**: `LiquidacionDetalle['gastos']` (`analytics.ts:1311-1315`) trae ahora
`monto`, `formaPago` y `pagadoEn`, que es exactamente el `Pick<Gasto, …>` que la
firma pide. El panel sí puede pasarlos; simplemente no los pasa. La rama `false`
además no **omite** la razón: **afirma otra**.

Consecuencia: el contralor que cruza la pantalla contra el PDF —que es lo que
hace— encuentra dos explicaciones distintas para el mismo peso, y la de la
pantalla lo manda a pedir una factura que ya existe.

Causa raíz probable: un parámetro opcional cuya ausencia cambia una afirmación en
vez de callarla.

---

### [MEDIO] REINCIDENTE — los tres botones que firman una liquidación son radios `sr-only` y no hay anillo de foco en ninguna hoja del repo
`src/app/dashboard/[id]/revision-panel.tsx:126-137` (el `<label>` sin
`has-[:focus-visible]` ni `peer-focus-visible`, con el `<input type="radio"
className="sr-only">` en `:133-134`), contra `src/app/globals.css:381`
(`:focus-visible` existe **solo** para `.sb-aside a/button`) y `:439`
(`.pildora`). Grepeé `focus` en `revision-panel.tsx`: **cero** ocurrencias.

Escenario, con valores. El contralor navega con teclado (o con un lector de
pantalla y teclado, que es como se audita una firma). Tabula desde el campo de
motivo hacia atrás: el foco aterriza en `<input type="radio" value="aprobar">`,
que está `sr-only` —posición absoluta, 1×1 px, `clip`—, así que el anillo del
navegador se dibuja sobre un pixel invisible. Nada en pantalla cambia: la píldora
seleccionada sigue siendo la que ya estaba en `var(--marca)`. Pulsa `→` para
moverse dentro del `radiogroup` y **no ve** que pasó de «Aprobar» a «Ajustar»;
pulsa Enter y envía la acción equivocada sobre `VJ-2026-0845`.

Consecuencia: el único control irreversible del producto —la firma humana sobre
una liquidación— no tiene indicador de foco visible. WCAG 2.4.7 (AA) reprobado en
la pantalla donde se firma dinero.

Causa raíz probable: el patrón `sr-only` + `<label>` estilizado se copió sin la
mitad que devuelve el foco a la vista.

---

### [MEDIO] NUEVO — el mensaje crudo de PostgREST llega a la pantalla del cliente en el Mapa
`src/app/dashboard/mapa/vista.tsx:141` (`${p.error.slice(0, 100)}`), alimentado
por `src/lib/likida/comercial.ts:579` (el mapeo) (`error: esTextoONulo(f.error) ? f.error :
null`), `supabase/migrations/0324_gps_poll_durable.sql:240`
(`ultimo_error = … left(coalesce(p_error, 'poll incompleto'), 1000)`) y
`src/lib/likida/repo.ts:1798` (`p_error: resultado.error?.slice(0, 1000)`), cuyo
contenido lo arma `src/lib/likida/conectores/sincronizar_gps.ts:182`, `:238` y
`:258`.

Escenario, con valores. La 0324 se aplica y algo queda a medias en `unidad` (un
`GRANT` que no alcanzó, una columna renombrada). El poller de GPS corre,
`admin.from('unidad').select('id, gps_device_id')` devuelve error, y
`sincronizar_gps.ts:182` construye
`error: 'no se pudieron leer las unidades: permission denied for table unidad'`.
Ese texto viaja tal cual a `finalizar_poll_conector`, que lo guarda en
`conector_poll_estado.ultimo_error` y pone `backlog_pendiente = not p_completo`
= `true` (mig. 0324:239-240). `estado_poll_gps_tenant` lo devuelve como `error`
(`:750`), y `mapa/vista.tsx:141` —que pinta el `p.error` **precisamente cuando
`backlogPendiente` es true**— renderiza en el panel del jefe de tráfico:

> `hikvision · posiciones: poll 6 sep 2026 10:15; medida ninguna; backlog pendiente (no se pudieron leer las unidades: permission denied for table unidad).`

Consecuencia: el cliente lee el nombre de una tabla y un mensaje de Postgres en
su panel — el mismo defecto que la 25 marcó en `conversaciones/page.tsx:51` y
`arco/page.tsx:159` (los dos siguen abiertos, los reverifiqué), pero éste es
nuevo y no le dice al encargado nada que pueda accionar. El código hermano
demuestra que la casa sabe hacerlo bien: `conectores/tipos.ts:498-500` documenta
que `ultimo_error` «sí se lee desde el panel» y por eso nunca copia la respuesta
cruda del proveedor; esa disciplina no se extendió a los errores de la base.

Causa raíz probable: la columna `ultimo_error` tiene dos escritores con
contratos distintos y solo uno sabe que su texto termina en pantalla.

---

### [BAJO] El guardarraíl de tokens CSS sigue cubriendo un solo archivo, y el arreglo de `cola.tsx` no dejó ninguno
`src/app/mcp/autorizar/tokens.test.ts:24` (`readFileSync('src/app/mcp/autorizar/
page.tsx')`) y `:47-53` (la aserción, sobre esa única fuente), contra el commit
`3d973998` — tres líneas de `cola.tsx`, cero archivos de prueba.

Escenario, con valores: es el que ya ocurrió **dos veces**. En la 24 fue
`var(--fg)` en el botón que concede acceso MCP (1.00:1); en la 25-26 fue
`var(--ok-bg)`/`--warn-bg`/`--bad-bg` en los tres pills de la cola de firma
(fondo transparente en los tres estados válidos, mientras el estatus DESCONOCIDO
—que sí usaba un token real— conservaba el suyo). Las dos veces la única señal
fue un auditor mirando el archivo; ninguna prueba se puso roja, y `tsc` y
`eslint` no ven dentro de una cadena `'var(--okbg)'`. Hoy el repo está limpio
(lo barrí), así que el hallazgo no es un token roto: es que la tercera vez se va
a descubrir igual que las dos primeras.

Consecuencia: para el equipo que mantiene, una clase de defecto invisible —una
declaración CSS *invalid at computed-value time* no produce error de ningún
tipo— sigue sin red fuera de `/mcp/autorizar`.

Causa raíz probable: la prueba se escribió para blindar la pantalla del hallazgo,
no la regla.

---

### [BAJO] El comentario de cabecera de `revision-panel.tsx` sigue documentando lo contrario de lo que el archivo hace desde que se arregló el ALTO
`src/app/dashboard/[id]/revision-panel.tsx:19` («Mueve `gasto.monto` y el total
por la delta; **NO vuelve a cuadrar, y lo dice**») contra `:144` (el texto que de
verdad sale en pantalla: «El sistema recalcula el cuadre con los montos
corregidos antes de guardar el ajuste con tu firma») y
`src/lib/likida/revision.ts:496` (`if (p.accion === 'ajustar' &&
cuadreRecalculado)`).

Escenario: el arreglo del ALTO de la 26 cambió la frase de pantalla y dejó el
comentario. El siguiente que abra este archivo lee en la cabecera —el lugar donde
este repo pone su contrato— que ajustar no recalcula, y la línea 144 doce
pantallas abajo dice lo opuesto. Es exactamente el mecanismo con el que nació el
ALTO original: `d914e74` cambió lo que ajustar HACE sin tocar lo que la pantalla
DICE. Hoy la deuda está del otro lado del mismo archivo.

Consecuencia: para quien mantenga. No llega al contralor, pero es la mecha de la
próxima ronda de esta pantalla, que ya lleva seis contradiciéndose.

---

## Lo que revisé y está bien

- **La cadena completa del PDF pendiente, extremo a extremo**, y no solo la línea
  citada: `revision.ts:496-506` → `resultado.pdfPendiente` → `page.tsx:248` (el
  mensaje) → `page.tsx:286` (el gate) → `detalle.tsx:166-171` (el banner y el
  botón) → `page.tsx:256-270` (`reintentarPdf`, con su propia doble guarda
  `puedeVerArea(rol,'dinero') && puedeFirmarLiquidacion(rol)`) →
  `revision_recalculo.ts:166-172` (`reintentarPdfAjustado`, que se niega si la
  revisión no es `ajustada` y devuelve `regenerado: true` si el PDF ya existe).
  Es el mejor trabajo de este rubro en varias rondas: convierte un `logger.warn`
  en una afordancia.
- **El barrido de tokens `var(--x)` usados-vs-definidos, rehecho de cero** sobre
  todo `src/` (`.ts`, `.tsx`, `.css`), incluidas las definiciones inline de los
  `.tsx`: cero huérfanos sin fallback, dos con fallback declarado. Resultados en
  el veredicto de arriba.
- **Cada mapa literal `Record<string, …>` del panel que se indexa SIN `??`**, uno
  por uno contra su dominio real (es el trabajo obligatorio del rubro):
  `carta-porte/vista.tsx:116-120` cubre 3/3 de `DecisionCcp['necesita']`
  (`carta_porte.ts:78`); `agentes/peajes/vista.tsx:357-362` cubre 4/4 de
  `MotivoSinEvidencia` (`peajes/evidencia_gps.ts:41-49`);
  `agentes/ficha-corridas.tsx:15-19` cubre 3/3 de `EstadoCorrida`
  (`agentes/corridas.ts:72`, con constraint en `0102:48`);
  `conexiones/seccion-integraciones.tsx:27-32` cubre los cuatro tonos de
  `ESTADO_INTEGRACION`. `facturacion/vista.tsx:395` indexa sin `??` pero el
  resultado se pinta bajo `{pill && …}` (`:407-412`), que es deliberado: solo
  `borrador` y `cancelada` llevan chip.
- **Los tres mapas gemelos de `ConceptoGasto`**, que el repo dice que se han roto
  dos veces: `dashboard/[id]/page.tsx:31-35`, `gasto-semanal-chart.tsx:13-17` y
  `politicas/page.tsx:20` cubren **9/9** contra `types/likida.ts:20-25`, y
  `etiquetas_sincronizadas.test.ts` los vigila clave por clave.
- **Los mapas de estatus con fallback explícito**: `dashboard/estatus.ts:17-26`
  (`etiquetaEstatus` devuelve la clave cruda en gris), `resumen-visual.tsx:103`
  con `??` en sus tres llamadores (`:144`, `viajes/vista.tsx:193`,
  `tablero-operacion.tsx:171`), y `cola.tsx:253` con su fallback (`?? { rotulo: l.estatus, fg:
  'var(--muted)', bg: 'var(--canvas)' }`) para el estatus desconocido.
- **La guardia del despacho contra un POST manual** (que es lo único que la
  ronda sí resolvió bien de ese cambio): `despacho/page.tsx:146` valida
  PRESENCIA antes de leer valores, así que un `fd.append('anticipo','')` seguido
  de `fd.append('anticipo','900')` se rechaza igual; y la re-verificación es
  contra la sesión VIVA, no contra el render — `permisos-dinero.test.tsx:60-64`
  ejercita la revocación entre render y POST y pasa.
- **La importación CSV falla cerrado y lo dice**: `importar_viajes.ts:158-163`
  rechaza el archivo ENTERO —antes de descartar filas— si trae columnas de
  anticipo, cliente o ingreso y el rol no ve dinero, con un mensaje que dice qué
  quitar.
- **El aviso de WhatsApp al chofer no inventa el anticipo**: `notificar.ts:85-86`
  trata `0` como ausente y escribe «sin anticipo registrado» en vez de
  «anticipo $0.00».
- **`tsc --noEmit -p .` limpio (exit 0)**, corrido hoy completo. Las 12 pruebas
  de `src/app/dashboard/despacho`, `src/app/dashboard/[id]` y
  `src/app/mcp/autorizar` pasan (53/53).

---

## Lo que NO alcancé a revisar

- **Sigo sin mirar un render.** `npm run build` está prohibido y no hay
  credenciales. Los contrastes del Cotizador (1.01:1, 3.9:1, 2.4:1) están
  **calculados** con la fórmula de luminancia relativa sobre la regla CSS
  resuelta, no vistos. El chip a 1.01:1 merece una captura antes de arreglarse, y
  la combinación «tema oscuro + SO en claro» merece la captura más que ninguna,
  porque es la que nadie ha mirado en cinco rondas.
- **El CRÍTICO no lo reproduje con una prueba.** No puedo escribir archivos fuera
  de este entregable. La cadena está verificada por lectura de cada eslabón
  (render → `fd.get` → `crearViaje` → columna → `engine.ts:1241` → `detalle.tsx:
  212`) y es determinista, pero conviene que quien lo arregle lo fije con una
  prueba que mida la liquidación resultante, no el `objectContaining({anticipo:
  0})` que hoy la fija al revés.
- **No ejercité el flujo del PDF pendiente.** No simulé un `upload` fallido de
  Storage ni un `publicar_pdf_liquidacion` rechazado; el cierre lo verifiqué de
  fuente, siguiendo cada rama.
- **`/admin` a fondo, `/portal`, `/demo` y `/vendedor`**: sin abrir, salvo los
  mapas literales que el censo tocó. `admin/mapa-prospectos/[id]/detalle.tsx:161`
  indexa `CONFIANZA_COLOR` sin `??` y no verifiqué su dominio.
- **Responsive y orden de foco fuera de `revision-panel.tsx`**: sin revisar.
- **El resto del inventario abierto que heredé de la 25 y que solo reverifiqué de
  fuente, sin volver a argumentar** — siguen abiertos y no los repito como
  hallazgos: los tres rótulos de rol divergentes (seis copias),
  `conversaciones/page.tsx:51` y `arco/page.tsx:159` con el `e.message` crudo, la
  tarjeta Actividad (`inicio-contenido.tsx:725`, `porMes={viajesPorMes ?? []}`,
  cuarta ronda), las flechas de 16×16 de `kpi-periodo.tsx:10` (WCAG 2.5.8 pide
  24×24), `secundarias` sin `pasos` (`estado.ts:26-40`), el script anti-parpadeo
  y el chat con 11 de 13 tools.
