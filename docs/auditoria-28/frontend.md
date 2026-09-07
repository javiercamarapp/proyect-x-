# Frontend — auditoría 28

**Nota: 4/10** (antes 4). **La nota se queda igual y lo digo con esas palabras**:
ninguna de las tres razones alcanza a moverla, porque las dos que aplican se
cancelan otra vez.

- **Se atacó y subió.** `4de95a0` —el único commit con código de producto de
  toda la ventana, y cae entero en este rubro— cerró **dos** cosas mías, y las
  cerró de verdad: el MEDIO REINCIDENTE de la cartera de Rentabilidad (el gate
  ahora mira `cobranza.total`, `vista.tsx:114`) y el punto de la tarjeta
  Actividad que arrastraba **cuatro rondas** (`inicio-contenido.tsx:725` ya no
  colapsa el `null` con `?? []`; `Actividad` distingue las tres situaciones,
  `actividad.tsx:46`). Verifiqué los dos abriendo los archivos y siguiendo el
  `null` desde `safe()` hasta el render, no por el mensaje del commit.
- **Deuda que cobró factura, dentro del propio arreglo.** El mismo commit
  **destapó una cifra inventada** en la pantalla que venía a arreglar: al
  sustituir el `EstadoVacio` por la tabla condicional, dejó vivo el renglón de
  paginación, que en una página fuera de rango imprime **«Facturas 0–9,800 de
  350»**. Y el comentario que lo justifica (`vista.tsx:40-42`) afirma que ese
  renglón dice «0–0 de N, que es la verdad» — el código no hace eso.
- Y el **CRÍTICO de la 27 está intacto, línea por línea**: el despacho sigue sin
  ofrecer el Anticipo, `viaje.anticipo` sigue sin un solo escritor después de la
  creación (`name="anticipo"` sigue existiendo en **un** input de todo `src/`),
  y `/dashboard/[id]` sigue pintando `$0.00 · entregado al operador` junto a
  «faltante · a favor del operador».

El ancla del rubro es explícita —«4 o menos si el comprador puede ver una cifra
mal formateada»— y hoy hay **dos** caminos así, uno de ellos nuevo. Subir sería
mentir; bajar sería negar dos cierres reales.

**Riesgo mayor de hoy:** sigue siendo el anticipo en cero. Todo viaje que
despache un jefe de tráfico nace con `anticipo = 0`, el motor concluye que la
empresa le debe al chofer lo que ya le pagó, y el PDF que el chofer guarda en su
teléfono lo dice con todas sus letras.

---

## Veredicto sobre los puntos que traía abiertos

| Hallazgo de la 27 | Hoy |
|---|---|
| CRÍTICO — el despacho no ofrece el Anticipo | **REINCIDENTE**, sin un carácter de cambio |
| ALTO — Cotizador con neutros de Tailwind | **REINCIDENTE**, las mismas 17 apariciones y las mismas 4 `dark:` |
| MEDIO — cartera de Rentabilidad dice «aún no hay facturas» | **CERRADO** (`vista.tsx:114`), pero abrió el ALTO nuevo de abajo |
| MEDIO — pie de «Por confirmar» afirma una razón falsa | **REINCIDENTE** (`detalle.tsx:88`, palabra por palabra) |
| MEDIO — los tres botones de firma sin anillo de foco | **REINCIDENTE** (`revision-panel.tsx:126-137`; `grep focus` = 0) |
| MEDIO — mensaje crudo de PostgREST en el Mapa | **REINCIDENTE** (`mapa/vista.tsx:141`, y también `:132`) |
| BAJO — el guardarraíl de tokens cubre un solo archivo | **REINCIDENTE** (`tokens.test.ts:24`) |
| BAJO — comentario de cabecera de `revision-panel.tsx` | **REINCIDENTE** (`:19` vs `:144`) |
| (heredado de la 25) Actividad con `porMes={viajesPorMes ?? []}` | **CERRADO** por `4de95a0` |

---

## Hallazgos

### [CRÍTICO] REINCIDENTE — el despacho del jefe de tráfico sigue sin ofrecer el Anticipo: el viaje nace en 0 y la pantalla de firma presenta ese cero como una medición
`src/app/dashboard/forma-viaje.tsx:90` (el campo, condicionado a
`puedeCapturarDinero`) y `:174` (los Kilómetros que lo sustituyen),
`src/app/dashboard/despacho/page.tsx:80` y `:155` (`… : 0`),
`src/lib/auth/visibilidad.ts:41` (`encargado: ['operacion']`), contra
`src/lib/likida/cuadre/engine.ts:1241,1250-1252` y
`src/app/dashboard/[id]/detalle.tsx:212` y `:219`.

Escenario, con valores (lo reverifiqué entero, no lo copié). Flota con jefe de
tráfico (`rol = 'encargado'`). Despacha `VJ-2026-0845` Silao → Monterrey con
**$20,000** de anticipo en efectivo al chofer.

1. `puedeVerArea('encargado','dinero')` es `false` (`visibilidad.ts:41`
   declara `encargado: ['operacion']`) → `forma-viaje.tsx:90` **no pinta el
   campo Anticipo**; en su lugar `:174` pinta «Kilómetros». Nada en pantalla
   dice que el anticipo lo captura alguien más.
2. `despacho/page.tsx:154-155`: `fd.get('anticipo')` es `null` → `anticipo = 0`,
   y se escribe. La columna es `NOT NULL DEFAULT 0`: 0 tecleado y 0 por
   ausencia son indistinguibles para siempre.
3. Comprobantes por **$18,400** → `diferencia = round2(0 − 18400) = −18400` →
   el motor emite «El operador puso $18,400.00 de su bolsa — a favor del
   operador.»
4. `/dashboard/[id]` pinta, uno junto al otro, `Anticipo $0.00 · entregado al
   operador` (`detalle.tsx:212`) y `Diferencia $18,400.00 · faltante · a favor
   del operador` en tono `bad` (`:215-220`).
5. **No hay dónde arreglarlo después.** `grep -rn 'name="anticipo"' src/`
   devuelve **una** línea (`forma-viaje.tsx:92`), y no existe ningún `update`
   de `viaje.anticipo` en `src/lib` ni en `src/app`. El único escritor es la
   creación.

Consecuencia: el contralor firma una liquidación cuya cifra principal está mal
por el monto entero del anticipo, y el PDF que el chofer conserva afirma que la
empresa le debe $18,400 que ya cobró. La flota que más se parece al comprador
—la que tiene jefe de tráfico dedicado— es exactamente la que cae.

Causa raíz probable: el bloqueo de la captura financiera se resolvió ocultando
el campo en el render, sin decidir quién captura entonces el dato que el motor
necesita ni cómo se representa «no capturado» en una columna `NOT NULL DEFAULT 0`.

---

### [ALTO] NUEVO — REGRESIÓN de `4de95a0`: al arreglar el vacío de la cartera se destapó un rango inventado, «Facturas 0–9,800 de 350»
`src/app/dashboard/rentabilidad/vista.tsx:45` (`hasta = (pagina − 1) * porPagina
+ facturas.length`) y `:189` (donde se imprime), habilitados por el cambio de
`:114` (`cobranza.total === 0`) y `:139-146` (la rama nueva); el comentario que
lo documenta al revés está en `:40-42`; el clamp que permite `p` hasta 1000 en
`src/app/dashboard/rentabilidad/page.tsx:34`; `Cobranza` en
`src/lib/likida/comercial.ts:294-309`.

Escenario, con valores. Cartera de **350** facturas, `COBRANZA_POR_PAGINA = 100`,
`porCobrar = 480,000`, `vencido = 120,000`. El contralor abre
`/dashboard/rentabilidad?p=99` (enlace guardado, back del navegador, o tecleado).

1. `page.tsx:34` acepta `pagina = 99` (el clamp es `1..1000`).
   `getCobranza` pide `p_desplazamiento = 9800` → `facturas: []`, `total: 350`.
   Verifiqué que esto **no** es un error: `postgrest-js` implementa `.range()`
   como `offset`/`limit` en el query string (`node_modules/@supabase/
   postgrest-js/dist/index.cjs:1044-1049`), no como cabecera `Range`, así que un
   desplazamiento fuera de rango devuelve arreglo vacío con el `count` intacto.
2. `vista.tsx:114` ya **no** dispara el `EstadoVacio` (bien: eso es el arreglo).
   Se entra a la `<section>`, `:139` detecta la página vacía y pinta el aviso
   nuevo, y **el renglón de paginación de `:187-206` se pinta también** — antes
   del 6-sep ese renglón era inalcanzable en este caso, porque el `EstadoVacio`
   sustituía la sección entera.
3. `desde = 0` (`:43-44`), `hasta = (99−1)·100 + 0 = 9800` (`:45`). El renglón
   renderiza, literal (lo calculé con `toLocaleString('es-MX')`, que es lo que
   hace `numero()` en `lib/formato.ts:246-248`):

   > **Facturas 0–9,800 de 350, las vencidas primero. Por cobrar y vencido de
   > arriba son de la cartera completa.**

   Con `?p=1000` dice **«Facturas 0–99,900 de 350»**.
4. El link **«Anteriores»** (`:194-197`) va a `?p=98`, que también está fuera de
   rango: para volver a datos hacen falta **98 clics**, uno por página, cada uno
   con su propio rango inventado.
5. Nada se pone rojo. La prueba que el mismo commit añadió
   (`vista.test.tsx:29-38`) afirma `expect(html).toMatch(/350/)` — y `"0–9,800
   de 350"` **contiene** `350`, así que pasa. `tsc` y `eslint` no ven aritmética
   de rangos.

Consecuencia: en la pantalla que responde «¿cuánto me deben?», el contralor lee
un rango de facturas que no existe y un tope (9,800) veintiocho veces mayor que
su cartera real. Es exactamente la regla que define al producto —nunca una cifra
que nadie midió— rota por el commit que venía a hacerla cumplir, y con un
comentario en `:40-42` que le dice al siguiente lector que el renglón «dice 0–0
de N, que es la verdad»: quien arregle esto va a creer que ya está bien.

Causa raíz probable: `hasta` se derivó de la página PEDIDA (`pagina − 1) *
porPagina`) en vez de la página SERVIDA; mientras la rama era inalcanzable el
error no se veía, y el arreglo la volvió alcanzable sin revisar lo que quedaba
adentro.

---

### [ALTO] REINCIDENTE (sexta ronda) — el Cotizador se pinta con neutros de Tailwind cableados; con el tema oscuro elegido y el SO en claro, su chip de estado queda a 1.01:1
`src/app/dashboard/cotizaciones/page.tsx:274` (el chip) y
`:160,163,181,197,219,252,253,254,262,280,284,298,307,312` (los catorce
`text-neutral-500/600`), más `src/app/dashboard/cotizaciones/acciones.tsx:27-28`,
contra `src/app/globals.css:1` (`@import "tailwindcss"` pelón), `:143`/`:150`
(`:root[data-theme="dark"]`, `--ink: #f4f4f5`), `:219-222` y
`src/app/selector-tema.tsx:20`.

Reverificado hoy con `grep`: `page.tsx:274` y `acciones.tsx:27-28` siguen siendo
las **únicas cuatro** `dark:` de todo `src/app`, `src/app/dashboard/cotizaciones`
sigue siendo el **único** directorio con neutros de Tailwind cableados (17
apariciones en dos archivos), y **no hay** `@custom-variant dark` ni
`tailwind.config.*` en el repo — así que en Tailwind v4 `dark:` **es**
`@media (prefers-color-scheme: dark)`, un eje distinto del `data-theme` que usa
el producto. De las cuatro combinaciones, dos rompen:

- **SO en claro + tema oscuro elegido con el 🌙**: `--ink: #f4f4f5` hereda al
  chip, `dark:bg-neutral-800` no aplica, el fondo se queda en `bg-neutral-100`
  = `#f5f5f5`. **1.01:1** — el chip que dice si la cotización está `borrador`,
  `enviada`, `ganada` o `perdida` desaparece. En la misma pantalla
  `text-neutral-500` (`#737373`) sobre `--surface` `#131316` mide **3.9:1** y
  `text-neutral-600` (`#525252`) **2.4:1**: ahí viven «falta el precio» y el
  supuesto de cada renglón del desglose citable.
- **SO en oscuro + tema por omisión (`claro`)**: el caso que la 24 midió, chip
  a 1.24:1. Intacto.

Consecuencia: la pantalla donde se decide a cuánto se vende un flete es
ilegible en dos de sus cuatro combinaciones de tema, y quien *elige* el tema
oscuro en una laptop de oficina con el SO en claro la ve peor que quien no lo
elige.

Causa raíz probable: la pantalla se escribió con utilidades de color en vez del
sistema de tokens, y el `dark:` que le pusieron encima responde a un eje
distinto del que el producto usa para cambiar de tema.

---

### [MEDIO] NUEVO — el mismo bug que se arregló en Rentabilidad sigue vivo en Despacho, y ahí no hay ni link para volver: «Ningún viaje en curso ahora mismo» con 140 viajes rodando
`src/app/dashboard/despacho/vista.tsx:174-177` (la guarda por
`activos.filas.length === 0` y su leyenda) contra `:232` (el renglón que
**sí** sabe el total y vive dentro de la rama que la guarda apaga) y `:239` (el
único «← Anterior», también dentro de esa rama); alimentado por
`src/app/dashboard/despacho/page.tsx:83` (`paginaPedida`, `Math.max(1, …)` **sin
tope superior**) y `:105`, y por `src/lib/likida/repo_paginado.ts:66` (clamp a
`paginaMax = 200`), `:77` (el `count: 'exact'` que sí llega).

Escenario, con valores. Flota con **140** viajes vivos (`abierto`/`en_cuadre`),
`POR_PAGINA_VIAJES_EN_CURSO = 25` → 6 páginas. El jefe de tráfico abre
`/dashboard/despacho?p=8` (un enlace guardado de cuando había más carga, el
botón «atrás» del navegador, o tecleado):

1. `page.tsx:83` acepta `8`; `repo_paginado.ts:66` lo deja en 8 (≤ 200) y pide
   `.range(175, 199)`. Igual que arriba, `postgrest-js` traduce eso a
   `offset=175&limit=25`, no a una cabecera `Range`: PostgREST devuelve
   **`[]` sin error**, y `count` sigue valiendo **140** (`:77`).
2. `vista.tsx:170` no entra (`error === null`), `:174` sí
   (`filas.length === 0`), y la pantalla afirma:
   **«Ningún viaje en curso ahora mismo.»**
3. La afirmación es falsa —hay 140— y el archivo **tiene el dato**:
   `activos.total = 140` está en el objeto, pero el renglón que lo imprime
   (`:232`) y el «← Anterior» (`:239`) viven en el `else`, que esta rama apaga.
   No queda un solo control en pantalla para volver: el jefe de tráfico tiene
   que editar la URL a mano.

Consecuencia: es palabra por palabra el hallazgo que la 27 marcó en Rentabilidad
y que `4de95a0` arregló — pero solo ahí. Aquí pega en la pantalla operativa: un
jefe de tráfico que lea «ningún viaje en curso» deja de avisar, de asignar
unidad y de escalar los que nadie aceptó, mientras 140 camiones ruedan. Y a
diferencia de Rentabilidad, aquí no queda ni el link de vuelta.

Causa raíz probable: la misma de siempre —el vacío de la CONSULTA y el vacío del
NEGOCIO se deciden con la misma expresión—, corregida en un llamador y no en el
patrón; `Pagina.total` existe justamente para distinguirlos y esta rama no lo
mira.

---

### [MEDIO] REINCIDENTE — el pie de «Por confirmar» del panel sigue afirmando una razón falsa, y la excusa que lo justificaba ya no existe
`src/app/dashboard/[id]/detalle.tsx:88` (la llamada, sin `gastos`) contra
`src/lib/likida/liquidacion/deducibilidad.ts:46-52` (la degradación
documentada y la firma opcional `gastos?`), `:85-95` (la rama) y
`src/lib/likida/liquidacion/pdf.ts:355` (el llamador que sí pasa el objeto
completo).

Reverificado hoy: `detalle.tsx:88` sigue siendo
`filasDeducibilidad({ ...d.deducibilidad, totalComprobado, diferencias })` —sin
`gastos`— palabra por palabra.

Escenario, con valores. `VJ-2026-0845` trae una caseta de CAPUFE de **$240** con
`forma_pago = '99'` y sin REP → `totalPorConfirmar = 240`.

- **PDF** (`pdf.ts:355`, objeto completo): `hayPagoPendiente = true`, el pie dice
  «A crédito (forma de pago 99) y sin complemento de pago…».
- **Pantalla** (`detalle.tsx:88`): `liq.gastos ?? []` colapsa a `[]`
  (`deducibilidad.ts:86`), `hayPagoPendiente = false`, y el pie de `:91-93` dice
  **«Falta timbrar la factura o acreditar el medio de pago. Se puede recuperar.»**

Ni una de las dos cosas que afirma es cierta. Y la premisa que
`deducibilidad.ts:49` invoca para tolerarlo —«el panel puede no traerlos»—
está muerta desde `fc98bbf6`: `LiquidacionDetalle['gastos']`
(`analytics.ts:1311-1315`) ya trae `monto`, `formaPago` y `pagadoEn`, que es
exactamente el `Pick<Gasto, …>` que la firma pide.

Consecuencia: el contralor que cruza pantalla contra PDF —que es lo que hace—
encuentra dos explicaciones distintas para el mismo peso, y la de la pantalla lo
manda a pedir una factura que ya existe.

Causa raíz probable: un parámetro opcional cuya ausencia cambia una afirmación
en vez de callarla.

---

### [MEDIO] REINCIDENTE — los tres botones que firman una liquidación son radios `sr-only` y no hay anillo de foco en ninguna hoja del repo
`src/app/dashboard/[id]/revision-panel.tsx:126-137` (el `<label>` sin
`has-[:focus-visible]` ni `peer-focus-visible`, con
`<input type="radio" … className="sr-only">` en `:133-134`), contra
`src/app/globals.css:381` — que es la **única** regla `:focus-visible` con
`outline` de todo el repo (`grep -n "outline\|focus" globals.css` devuelve
`:381-383` y `:439`, nada más) y solo cubre `.sb-aside a/button`. `grep focus`
en `revision-panel.tsx`: **cero** ocurrencias.

Escenario, con valores. El contralor navega con teclado. El foco aterriza en
`<input type="radio" value="aprobar">`, que es `sr-only` (1×1 px, `clip`), así
que el anillo del navegador se dibuja sobre un pixel invisible; la píldora
seleccionada sigue pintada en `var(--marca)` y nada cambia. Pulsa `→` para
moverse dentro del `radiogroup`, **no ve** que pasó de «Aprobar» a «Ajustar»,
pulsa Enter y firma la acción equivocada sobre `VJ-2026-0845`.

Consecuencia: el único control irreversible del producto —la firma humana sobre
una liquidación— no tiene indicador de foco visible. WCAG 2.4.7 (AA) reprobado
en la pantalla donde se firma dinero.

Causa raíz probable: el patrón `sr-only` + `<label>` estilizado se copió sin la
mitad que devuelve el foco a la vista.

---

### [MEDIO] REINCIDENTE — el mensaje crudo de PostgREST llega a la pantalla del cliente en el Mapa, por dos vías
`src/app/dashboard/mapa/vista.tsx:141` (`${p.error.slice(0, 100)}`) **y `:132`**
(`{rastreo.error.slice(0, 140)}`, que la 27 no citó y es la vía más directa),
alimentadas por `src/app/dashboard/mapa/page.tsx:129`
(`const err = e instanceof Error ? e.message : String(e)`, devuelto tal cual en
`:131`) y por `src/lib/likida/comercial.ts:579`;
el otro extremo lo arma `src/lib/likida/conectores/sincronizar_gps.ts:182`.

Escenario, con valores. Un `GRANT` que no alcanzó sobre `unidad` tras aplicar la
0324. `getEstadoRastreo` lanza; `page.tsx:129` captura y devuelve el texto de
Postgres; `vista.tsx:132` lo pinta en el panel del jefe de tráfico:

> No se pudo leer el rastreo de esta flota (**permission denied for table
> unidad**). Recarga en un momento — mientras tanto esta sección no afirma nada
> sobre tus unidades.

Y por la otra vía, con el poller: `sincronizar_gps.ts:182` arma
`no se pudieron leer las unidades: permission denied for table unidad`, que se
guarda en `conector_poll_estado.ultimo_error` y sale en `:141` como
`hikvision · posiciones: … backlog pendiente (no se pudieron leer las unidades:
permission denied for table unidad).`

Consecuencia: el cliente lee el nombre de una tabla interna y un mensaje de
Postgres en su panel, y no puede accionar nada con eso. El código hermano
demuestra que la casa sabe hacerlo bien: `conectores/tipos.ts:498-500` documenta
que `ultimo_error` «sí se lee desde el panel» y por eso nunca copia la respuesta
cruda del proveedor.

Causa raíz probable: dos escritores con contratos distintos sobre el mismo campo
de error, y solo uno sabe que su texto termina en pantalla.

---

### [MEDIO] REINCIDENTE, y son DOS archivos, no uno — las flechas que cambian el periodo de los KPI miden 16×16 px y van pegadas
`src/app/dashboard/kpi-periodo.tsx:10` y
`src/app/dashboard/motor-fiscal-periodo.tsx:7` — el **mismo** literal
`'w-4 h-4 rounded flex items-center justify-center …'`, usado en
`motor-fiscal-periodo.tsx:44-55` (los dos `<button>`, `:46` y `:50`, dentro de un
`flex items-center gap-0`) y en los equivalentes de `kpi-periodo.tsx`.
La 27 solo citó `kpi-periodo.tsx`; hoy conté los dos con `grep`.

Escenario, con valores. `w-4 h-4` es **16×16 CSS px**; los dos botones son
hermanos con `gap-0`, o sea dos blancos de 16 px pegados. WCAG 2.5.8 (AA,
Target Size Minimum) exige 24×24 CSS px, y la excepción de «spacing» no aplica
porque no hay separación. El contralor abre el Resumen en una tablet, quiere ver
«En riesgo / perdido» del mes y toca «›»; el dedo cae sobre «‹», el KPI se queda
en «últimos 7 días» y él lee $84,000 creyendo que es el mes.

Consecuencia: en la primera pantalla del panel, los controles que deciden **qué
periodo** representa cada cifra fiscal reprueban el tamaño de toque mínimo. La
etiqueta sí dice la ventana (`ETIQUETA_MODO`, `motor-fiscal-periodo.tsx:11-13`),
así que la cifra no miente — pero es texto de 12 px al lado de un número de 20,
y el modo de falla es leer el número sin releer la etiqueta.

Causa raíz probable: el tamaño se eligió por densidad visual dentro de la
tarjeta y el literal se copió a un segundo archivo sin que nadie mida un blanco
de toque.

---

### [BAJO] NUEVO — `Pagina.truncada` existe para declarar que la lista no alcanza, y ninguna pantalla lo lee: en Despacho el botón «Siguiente →» de la página 200 no avanza y no explica por qué
`src/lib/likida/repo_paginado.ts:37-39` (el campo y su contrato: «`true` cuando
`total` rebasa `paginaMax * porPagina`… Se declara, no se esconde»), `:66` (el
clamp a `paginaMax`) y `:78` (dónde se calcula), contra
`src/app/dashboard/despacho/vista.tsx:243-244` (la condición del link
«Siguiente»). `grep -rn truncada src/app --include=*.tsx` devuelve
`descarga-sat` y `jornada`, que sí lo pintan; **`despacho/vista.tsx` y
`agentes/conductores/vista.tsx` no lo mencionan**.

Escenario, con valores. `PAGINA_MAX_VIAJES_EN_CURSO = 200`,
`POR_PAGINA_VIAJES_EN_CURSO = 25` → el tope recorrible son **5,000** viajes
vivos. Flota con **6,000**: en `?p=200`, `filas.length === 25` y
`200 * 25 = 5000 < 6000`, así que `:243-244` **sí** pinta «Siguiente →» hacia
`?p=201`; `repo_paginado.ts:66` lo clampa de vuelta a 200 y devuelve la misma
página. El botón queda vivo para siempre y siempre devuelve lo mismo, mientras
`activos.truncada` vale `true` y nadie lo pinta.

Consecuencia: para el jefe de tráfico, un control que se puede pulsar
indefinidamente sin que pase nada, sobre 1,000 viajes vivos que la pantalla no
puede alcanzar y no declara. Para quien mantenga: un campo con contrato escrito
(«se declara, no se esconde») que dos de sus cuatro consumidores ignoran, lo que
lo vuelve deuda que ya nadie va a notar.

Causa raíz probable: `leerPagina` calcula `truncada` como servicio opcional y no
hay nada —tipo, prueba ni lint— que obligue a un llamador a consumirlo.

---

### [BAJO] REINCIDENTE — el guardarraíl de tokens CSS sigue cubriendo un solo archivo
`src/app/mcp/autorizar/tokens.test.ts:24`
(`readFileSync('src/app/mcp/autorizar/page.tsx')`) y `:47-53` (la aserción,
sobre esa única fuente).

Escenario: es el que ya ocurrió **dos veces** —`var(--fg)` en el botón que
concede acceso MCP (1.00:1) y `var(--ok-bg)`/`--warn-bg`/`--bad-bg` en los tres
pills de la cola de firma—. Las dos veces la única señal fue un auditor mirando
el archivo: una declaración CSS *invalid at computed-value time* no produce
error de ningún tipo, y ni `tsc` ni `eslint` ven dentro de la cadena
`'var(--okbg)'`. Hoy el repo está limpio; el hallazgo es que la tercera vez se
va a descubrir igual que las dos primeras.

Consecuencia: para el equipo que mantiene, una clase de defecto invisible sigue
sin red fuera de `/mcp/autorizar`.

Causa raíz probable: la prueba se escribió para blindar la pantalla del
hallazgo, no la regla.

---

### [BAJO] REINCIDENTE — el comentario de cabecera de `revision-panel.tsx` sigue documentando lo contrario de lo que el archivo hace
`src/app/dashboard/[id]/revision-panel.tsx:19` («Mueve `gasto.monto` y el total
por la delta; **NO vuelve a cuadrar, y lo dice**») contra `:144` (el texto que
de verdad sale: «El sistema recalcula el cuadre con los montos corregidos antes
de guardar el ajuste con tu firma») y `src/lib/likida/revision.ts:496`.

Consecuencia: para quien mantenga. No llega al contralor, pero es el mismo
mecanismo con el que nació el ALTO original (`d914e74` cambió lo que ajustar
HACE sin tocar lo que la pantalla DICE); hoy la deuda está del otro lado del
mismo archivo.

---

## Lo que revisé y está bien

- **`4de95a0` completo, hunk por hunk.** El arreglo de `Actividad` es correcto y
  cierra un hallazgo de cuatro rondas: `inicio-contenido.tsx:141` lanza
  `getViajesPorMes` bajo `safe()` (→ `null` real, no `[]`), `:725` ya no
  colapsa, `panel-periodo.tsx:41-42` propaga el tipo, y `actividad.tsx:46`
  distingue las tres situaciones con la misma regla que ya tenía `porDia`.
  Comprobé además que **no rompió el llamador de al lado**: `estado.ts:52-53`
  cuenta `viajesPorMes` entre las `secundarias`, así que la caída también
  enciende el banner de «pantalla incompleta» (`inicio-contenido.tsx:569` la
  decisión, `:599` el texto),
  y `panel-periodo.test.tsx` (que pasa `porMes={[]}`) sigue compilando y
  pasando. Corrí las 5 pruebas del vecindario: **37/37 pasan**
  (`actividad`, `rentabilidad/vista`, `panel-periodo`, `estado`,
  `ventana-periodo`). `npx tsc --noEmit -p .` **exit 0**.
- **El trabajo obligatorio del rubro —cada mapa literal del panel contra su
  dominio real— rehecho sobre TODO `src/app`, no solo `/dashboard`.** Censé los
  ~90 `Record<…>` literales y revisé uno por uno los que se indexan; los que
  usan `Record<string, …>` **todos** llevan `??` con un fallback que muestra la
  clave cruda en vez de un hueco: `unidades/vista.tsx:227`
  (`ESTADO_UNIDAD[u.estado] ?? u.estado`), `agentes/liquidacion/vista.tsx:454`,
  `jornada/vista.tsx:280,389` (`?? TONO.dato_insuficiente`),
  `jornada/formas.tsx:200,235,299`, `chrome.tsx:107`
  (`ROL_BADGE[rol] ?? rol.toUpperCase()`),
  `agentes/notificaciones-forma.tsx:206,262,285`. Los que no llevan `??` están
  tipados al dominio y no compilan si falta una clave:
  `unidades/vista.tsx:16` (`Record<EstadoVigencia, …>`, 4/4),
  `soporte/estatus.ts:21` (`Record<EstadoTicket, …>`, 5/5, con
  `pillTicket()` como fallback explícito en `:33`),
  `descarga-sat/bandeja/vista.tsx:45` (`Record<EstatusCfdi, …>`).
  `admin/mapa-prospectos/[id]/detalle.tsx:161` —que la 27 dejó sin verificar—
  indexa `CONFIANZA_COLOR` sin `??`, pero el dominio es
  `'alta' | 'media' | 'baja'` (`lib/admin/prospectos-mapa-client.ts:125`) y el
  mapa (`:26`) cubre **3/3**.
- **La otra mitad de las paginaciones del panel, buscando el gemelo del ALTO
  nuevo.** `paginar-registro.ts:79-81` es el patrón correcto y el que había que
  copiar: clampa `pagina` a `Math.min(pCruda, paginas)` **calculado sobre las
  filas filtradas**, así que un `?p=99` cae en la última página con datos y el
  rango nunca se inventa. `agentes/conductores/vista.tsx:228-230` declara el
  recorte con el total real («Se listan N de M, los más urgentes primero»).
  `descarga-sat/bandeja/vista.tsx:334` sí pinta el `truncada`.
  `viajes/vista.tsx:258-266` evita el problema de raíz: pagina por cursor y a
  propósito **no** dice «página N de M».
- **La cadena de honestidad de las series del Resumen**, que era el vecindario
  del commit: `gastosFiscalesSeries === null` → `pResumenPerdidasSeries` resuelve
  `null` (`inicio-contenido.tsx:162-170`) → `MotorFiscalPeriodo`
  (`motor-fiscal-periodo.tsx:39-41`) dice «No se pudo leer el motor fiscal en
  este momento» en vez de pintar ceros. Igual `PanelPeriodo` en sus cinco
  bloques (`:86-95`, `:111-117`, `:126-136`, `:146-154`): el `null` siempre tiene
  su propia frase, distinta de la del vacío real.
- **No hay `outline: none` global.** Grepeé `outline` y `focus` en
  `globals.css`: solo `:381-383` y `:439`. Es decir, el foco por omisión del
  navegador **sí** funciona en el resto de la app; el MEDIO de
  `revision-panel.tsx` es por el `sr-only`, no por un reset — refutación que
  intenté y que confirma el hallazgo en vez de tumbarlo.
- **Los `key={i}` del panel** (~50 apariciones): los revisé buscando el modo de
  falla que el rubro nombra («un `key` inestable que reordena filas de dinero»)
  y no lo encontré. Todas las tablas con dinero llevan el id real
  (`rentabilidad/vista.tsx:163` `key={f.id}`, `despacho/vista.tsx:193`
  `key={v.id}`); los `key={i}` viven en listas estáticas de server components
  (notas, supuestos, burbujas de demo, ejes de gráfica) que no se reordenan ni
  tienen estado interno.

---

## Lo que NO alcancé a revisar

- **Sigo sin mirar un render.** `npm run build` está prohibido y no hay
  credenciales. Los contrastes del Cotizador (1.01:1, 3.9:1, 2.4:1) están
  **calculados** sobre la regla CSS resuelta, no vistos; el rango inventado
  («Facturas 0–9,800 de 350») está **computado** con la misma aritmética y el
  mismo `toLocaleString('es-MX')` del archivo, no capturado en pantalla. Los dos
  merecen una captura antes de arreglarse.
- **Ninguno de los tres hallazgos nuevos lo fijé con una prueba**, porque no
  puedo escribir en el repo fuera de este entregable. Intenté correr un render
  real de `VistaRentabilidad` desde el scratchpad y vitest no lo recoge (solo
  escanea bajo la raíz), así que la evidencia del ALTO es lectura de cada
  eslabón más la aritmética ejecutada aparte. Los tres son deterministas y
  fáciles de fijar: el de Rentabilidad con un `expect(html).not.toMatch(/0–9,800/)`,
  el de Despacho con `filas: [], total: 140, pagina: 8`.
- **`/portal`, `/demo`, `/vendedor` y `/pago/[token]`: sin abrir**, salvo el
  censo de mapas literales. `/admin` solo lo recorrí para ese censo y para
  `mapa-prospectos`.
- **Responsive**: no revisado en ninguna pantalla. Ningún ancho medido, ningún
  `overflow-x` verificado más allá de ver que las tablas de dinero lo declaran.
- **Orden de foco fuera de `revision-panel.tsx`**: sin revisar. Solo verifiqué
  que no existe un reset global de `outline`.
- **El resto del inventario heredado de la 25 que solo reverifiqué de fuente y
  no vuelvo a argumentar**: los rótulos de rol divergentes en seis copias,
  `conversaciones/page.tsx:51` y `arco/page.tsx:159` con el `e.message` crudo,
  `secundarias` sin `pasos` ni `viajesPorDia` en `estado.ts:27-41` (una caída de
  esas dos no enciende el banner de «pantalla incompleta», aunque cada bloque sí
  dice lo suyo), el script anti-parpadeo, y el chat con 11 de 13 tools.
