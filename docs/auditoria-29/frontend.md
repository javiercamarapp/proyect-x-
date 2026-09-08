# Frontend — auditoría 29

**Nota: 6/10** (antes 4). Razón del movimiento: **se atacó y subió**. De los
nueve puntos que traía abiertos, **ocho se cerraron de verdad** —los abrí uno
por uno, leí el archivo y leí la prueba, y en los ocho la prueba **falla si se
revierte el arreglo**, no es una aserción decorativa. Además el guardarraíl de
tokens dejó de mirar un archivo y pasó a barrer **todo `src/app`**
(`tokens_definidos.test.ts`, 4 casos, verde hoy). Lo que impide pasar de 6 es
que el **CRÍTICO del Anticipo sigue intacto, línea por línea, cuarta ronda**, y
que la única mitad del ALTO del Cotizador que quedó viva quedó **en el archivo
que el commit dice haber arreglado**.

**Riesgo mayor del rubro, hoy:** sigue siendo el anticipo en cero. Todo viaje
que despacha un jefe de tráfico nace con `anticipo = 0`, el motor concluye que
la empresa le debe al chofer lo que ya le pagó, y `/dashboard/[id]` pinta
`Anticipo $0.00 · entregado al operador` junto a `faltante · a favor del
operador`. Es la única cifra del producto que un contralor puede desmentir con
su propio recibo de caja.

---

## Estado de los hallazgos abiertos de la 28

| Hallazgo de la 28 | Hoy | Ancla |
|---|---|---|
| **CRÍTICO** — el despacho no ofrece el Anticipo (FE-1) | **REINCIDENTE** | ver FE-C1 abajo; reescrito con los mismos valores |
| **ALTO** — «Facturas 0–9,800 de 350» (FE-2) | **CERRADO** en la 28 (`a28c7bb`), reverificado hoy | `rentabilidad/vista.tsx:46-51`: `desde`/`hasta` son 0 cuando `facturas.length === 0`; `hayMas` va sobre `consumidas`. Con `p=99`, `total=350` imprime «Facturas 0–0 de 350» |
| **ALTO** — Cotizador con neutros de Tailwind (FE-A2) | **MUTADO** | el chip y los 17 `text-neutral-*` se fueron (`ebe1372`); sobrevive `acciones.tsx:28` — ver FE-M1 |
| **MEDIO** — Despacho: «Ningún viaje en curso» con 140 rodando (FE-M1) | **CERRADO** | `despacho/vista.tsx:75-78` decide por `activos.total`, no por `filas.length`; `vista.test.tsx:100-125` siembra `{filas:[], pagina:8, total:140}` y exige `not.toContain('Ningún viaje en curso')` + `'0–0'` + «Anterior». Corrí el archivo: **8/8 pasan** |
| **MEDIO** — el pie de «Por confirmar» afirma una razón falsa (FE-M2) | **CERRADO** | `detalle.tsx:100-103` ya pasa `gastos: d.gastos`; `deducibilidad_panel.test.tsx:52-79` compara contra `LEYENDA_PAGO_PENDIENTE` **importada de `engine.ts`**, y el segundo caso (`gastos: []`) prueba que la diferencia SÍ es `gastos` |
| **MEDIO** — los tres botones de firma sin anillo de foco (FE-M3) | **CERRADO** | `globals.css:398-401` (`label:has(> input.sr-only:focus-visible)`, mismo anillo que `.sb-aside`); el `<input>` es hijo DIRECTO del `<label>` (`revision-panel.tsx:135-136`). La prueba tiene las dos mitades: el markup (regex sobre el orden exacto) y la regla CSS leída de `globals.css`. Cubre también `agentes/cobranza/estrategia.tsx:102-108`, el otro `sr-only` del panel |
| **MEDIO** — mensaje crudo de PostgREST en el Mapa (FE-M4) | **CERRADO en el Mapa** | `mapa/page.tsx:136-138` loguea el `e.message` y devuelve una frase fija; `mapa/vista.tsx:129-140` ya no lee `rastreo.error` para pintarlo. El otro extremo (`sincronizar_gps.ts:128-138`, `motivoParaPanel`) escribe frases nuestras por etapa. **El patrón NO se generalizó** — ver FE-M2 |
| **MEDIO** — flechas de periodo de 16×16 px (FE-M5) | **CERRADO** | `admin/ui/kit.tsx:111-112` (`BOTON_PERIODO`, `w-6 h-6 -m-1`) importado por los DOS archivos (`kpi-periodo.tsx:5`, `motor-fiscal-periodo.tsx:6`); `gap-3` deja 4px netos entre las dos cajas de 24px, así que no se pisan. El `-m-1` es margen, no `clip`: la caja de impacto sigue midiendo 24×24 |
| **BAJO** — `Pagina.truncada` sin consumidor (FE-B1) | **CERRADO** | `despacho/vista.tsx:92-95` apaga «Siguiente» al tope (`:305`, `:312`) y `:326-333` declara el recorte; `agentes/conductores/vista.tsx:50-57,248-257` idem. Con `pagina=200, porPagina=25, truncada=true` la prueba exige que NO haya «Siguiente» |
| **BAJO** — el guardarraíl de tokens cubre un solo archivo (FE-B2) | **CERRADO, y bien** | `mcp/autorizar/tokens.test.ts` se **borró** y lo sustituye `src/app/tokens_definidos.test.ts`: barre todos los `.ts/.tsx/.css` de producción de `src/app`, junta los tokens que definen **todos** los `.css` (globals + login) y exige 0 `var(--x)` huérfanos. Trae su propio anti-ceguera (`≥100 archivos con var(--`). Verifiqué además que fuera de `src/app` solo hay `var(--` **en comentarios** (`proxy.ts:39`, `correo/plantilla.ts:12`, `credenciales.ts:409`) |
| **BAJO** — comentario de cabecera de `revision-panel.tsx` (FE-B3) | **CERRADO** | `:19` ya dice «RECALCULA el cuadre»; la prueba asserta `not.toContain('NO vuelve a cuadrar')` **y** `toMatch(/RECALCULA el cuadre/)` |

Corrí los seis archivos de prueba que anclan estos cierres:
`deducibilidad_panel`, `revision_panel`, `motor-fiscal-periodo`,
`tokens_definidos`, `mapa/vista`, `rentabilidad/vista` → **27/27 pasan**; y
`despacho/vista.test.tsx` → **8/8**.

---

## Hallazgos

### [CRÍTICO] FE-C1 · REINCIDENTE (cuarta ronda) — el despacho sigue sin ofrecer el Anticipo: el viaje nace en 0 y la pantalla de firma presenta ese cero como una medición
`src/app/dashboard/forma-viaje.tsx:90-93` (el campo, tras
`{puedeCapturarDinero && …}`) y `:174-179` (los Kilómetros que lo sustituyen),
`src/app/dashboard/despacho/page.tsx:163-164` (`… : 0`) y `:198`,
`src/lib/auth/visibilidad.ts:41` (`encargado: ['operacion']`), contra
`src/app/dashboard/[id]/detalle.tsx:242` y `:245-249`.

Escenario, con valores (lo reescribí entero contra el árbol de hoy, no lo
copié de la 28). Flota con jefe de tráfico (`rol = 'encargado'`). Despacha
`VJ-2026-0845` Silao → Monterrey con **$20,000** de anticipo en efectivo al
chofer.

1. `puedeVerArea('encargado','dinero')` es `false` → `forma-viaje.tsx:90` **no
   pinta el campo Anticipo**; `:174` pinta «Kilómetros» en su lugar. Nada en
   pantalla dice que el anticipo lo captura alguien más.
2. `despacho/page.tsx:163-164`: `fd.get('anticipo')` es `null` → `anticipo = 0`
   y se escribe (`:198`). La columna es `NOT NULL DEFAULT 0`: 0 tecleado y 0
   por ausencia son indistinguibles para siempre.
3. Comprobantes por **$18,400** → `diferencia = round2(0 − 18400) = −18400`.
4. `/dashboard/[id]` pinta, uno junto al otro, `Anticipo $0.00 · entregado al
   operador` (`detalle.tsx:242`) y `Diferencia $18,400.00 · faltante · a favor
   del operador` en tono `bad` (`:245-249`).
5. **No hay dónde arreglarlo después.** `grep -rn 'name="anticipo"' src/`
   devuelve **una** línea (`forma-viaje.tsx:92`) y no existe ningún `update` de
   `viaje.anticipo` en `src/lib` ni en `src/app`: el único escritor es la
   creación (`repo.ts` lo LEE en `:76`/`:91`; `api/v1/viajes/route.ts:278` es
   el otro creador, no un editor).

Consecuencia: el contralor firma una liquidación cuya cifra principal está mal
por el monto entero del anticipo, y el PDF que el chofer conserva afirma que la
empresa le debe $18,400 que ya cobró. La flota que más se parece al comprador
—la que tiene jefe de tráfico dedicado— es exactamente la que cae.

Causa raíz probable: el bloqueo de la captura financiera se resolvió ocultando
el campo en el render, sin decidir quién captura entonces el dato que el motor
necesita ni cómo se representa «no capturado» en una columna `NOT NULL DEFAULT 0`.
Es una decisión de producto pendiente, no un defecto de render — y por eso
lleva cuatro rondas sin moverse.

---

### [MEDIO] FE-M1 · MUTADO de FE-A2 — el commit que quitó los neutros del Cotizador dejó vivo el `dark:` del botón que crea el viaje: 3.45:1 en tema oscuro, 2.82:1 al pasarle el ratón encima en tema claro
`src/app/dashboard/cotizaciones/acciones.tsx:28` (`BTN_VERDE`), usado en `:59`
(«Crear viaje»), contra `src/app/globals.css:1` (`@import "tailwindcss"` pelón,
sin `@custom-variant dark`), `:143-151` (`:root[data-theme="dark"]`,
`--surface: #131316`) y `src/app/layout.tsx:53` (el script que estampa
`data-theme`).

El commit `ebe1372` lista en su propio mensaje: «Botón `BTN` de acciones
(`hover:bg-neutral-50 dark:hover:bg-neutral-800`) → `hover:bg-[var(--canvas)]`,
sin necesidad de variante `dark:` manual». Cambió `BTN` (`:27`) y dejó
`BTN_VERDE` (`:28`) **intacto**, con el mismo defecto y en la línea de abajo.
Hoy `acciones.tsx:28` es la **única** `dark:` que queda en todo `src/app`
(`grep -rn "dark:" src/app --include=*.tsx` → una línea de código y un
comentario en `aviso/[tenant]/page.tsx:83`).

Escenario, con valores. Los colores los calculé convirtiendo el oklch de la
paleta por defecto de Tailwind v4 a sRGB y aplicando la fórmula de luminancia
de WCAG (`@theme` en `globals.css:9-46` no redefine `emerald-*`, así que aplica
la de fábrica): `emerald-700` = `#007a55`, `emerald-950` = `#002c22`,
`emerald-50` = `#ecfdf5`.

- **Tema oscuro elegido con el 🌙** (`data-theme="dark"`): el fondo de la
  tarjeta es `--surface #131316` y el texto del botón sigue siendo
  `text-emerald-700` → **3.45:1**. Reprueba AA (4.5:1) en el único botón de la
  pantalla que convierte una cotización en un viaje con precio.
- **Tema claro (el de fábrica) con el SO en oscuro** — el caso más común en
  una laptop de oficina: `layout.tsx:53` estampa `data-theme="light"` (sin
  `localStorage`, `t = null` → `d = false`), pero `dark:` en Tailwind v4 **es**
  `@media (prefers-color-scheme: dark)`, otro eje. Al pasar el ratón sobre
  «Crear viaje», `dark:hover:bg-emerald-950` SÍ dispara: el botón se pinta
  `#002c22` (casi negro) dentro de una tabla blanca y su texto queda en
  **2.82:1**. El rótulo se apaga justo mientras el dedo está encima de él.
- El caso simétrico (tema oscuro + SO claro) pinta `hover:bg-emerald-50`
  (`#ecfdf5`): un bloque casi blanco dentro de un panel negro.

Consecuencia: en la pantalla donde se decide a cuánto se vende un flete, el
botón que materializa la venta o es ilegible o parpadea al color contrario del
tema. Y para quien mantenga: el hallazgo se marcó cerrado con un commit que
tocó la línea de arriba.

Causa raíz probable: el arreglo se hizo por búsqueda de `neutral-*` y `BTN_VERDE`
usa `emerald-*`; nada —ni `tokens_definidos.test.ts`, que solo mira `var(--x)`
huérfanos, ni `contraste.test.ts`, que solo mide los tokens de `globals.css`—
ve una utilidad de paleta fija ni un `dark:` sobre el eje equivocado.
(MUTADO: venía de la ronda anterior como ALTO.)

---

### [MEDIO] FE-M2 — el mensaje crudo de PostgREST se quitó del Mapa y sigue vivo en Privacidad (ARCO) y en Conversaciones, con el nombre de la función y el de la tabla
`src/app/dashboard/arco/page.tsx:166` (el `catch`) y **`:210`** (donde se
pinta), y `src/app/dashboard/conversaciones/page.tsx:51` y **`:90`**, contra
`src/lib/likida/pg.ts:33-36` (`exigir`, que arma
`` `${consulta}: ${res.error.message}` ``) y
`src/lib/likida/repo.ts:1627-1641` (`listarSolicitudesArco`, que llama
`traerTodo` con `'listarSolicitudesArco'` como nombre de consulta).

Escenario, con valores. Un `GRANT` que no alcanzó sobre `solicitud_arco` tras
aplicar una migración. `traerTodo` → `exigir` lanza
`Error('listarSolicitudesArco: permission denied for table solicitud_arco')`;
`arco/page.tsx:166` guarda `e.message` en `errorCarga` y `:210` lo imprime
dentro del recuadro ámbar del panel del cliente, literal:

> No se pudieron leer las solicitudes ahora mismo (**listarSolicitudesArco:
> permission denied for table solicitud_arco**). Recarga en un momento — no hay
> forma de saber si hay solicitudes pendientes hasta que la base responda.

Igual en `/dashboard/conversaciones` (`:90`, `getHilosDeFlota`/`contarHilosDeFlota`).

Consecuencia: el cliente lee el nombre de una función interna y el de una tabla
en la pantalla de **privacidad** —la que se enseña cuando alguien pregunta cómo
se tratan los datos de sus choferes— y no puede accionar nada con eso. La casa
ya decidió que esto no se hace: `mapa/page.tsx:129-138` lo documenta en tres
párrafos («la frase que sale de aquí tiene que ser NUESTRA siempre») y
`conectores/tipos.ts:498-500` lo escribió antes. El arreglo de FE-M4 se aplicó
al llamador, no al patrón.

Causa raíz probable: `exigir()` concatena a propósito el nombre de la consulta
para el log, y dos pantallas usan ese mismo string como texto de UI. No hay
nada —tipo, lint ni prueba— que separe «mensaje para el log» de «mensaje para
la pantalla».

---

### [MEDIO] FE-M3 — Rentabilidad ya dice la verdad pero sigue sin salida: desde `?p=99` hacen falta 95 clics para volver a ver una factura, y Despacho —arreglado en esta misma ventana— sí ofrece el atajo
`src/app/dashboard/rentabilidad/vista.tsx:144-152` (la rama de página vacía) y
`:197-210` (los dos únicos links: «Anteriores» a `pagina − 1`, y «Siguientes»
solo si `hayMas`), contra `src/app/dashboard/rentabilidad/page.tsx:34` (el
clamp acepta `1..1000` **sin mirar el total**) y
`src/lib/likida/comercial.ts:322-323` (`getCobranza` devuelve la página PEDIDA:
`Math.max(Math.trunc(pagina), 1)`, sin clamp contra `total`), frente al patrón
que `29354d0` estableció en `src/app/dashboard/despacho/vista.tsx:82-83` y
`:239-241` («Ir a la última página (N)»).

Escenario, con valores. Cartera de **350** facturas, `COBRANZA_POR_PAGINA = 100`
→ 4 páginas reales. El contralor abre `/dashboard/rentabilidad?p=99` (enlace
guardado, «atrás» del navegador, o tecleado).

1. `page.tsx:34` acepta `99`; `getCobranza` pide `p_desplazamiento = 9800` →
   `facturas: []`, `total: 350`, `pagina: 99`.
2. `vista.tsx:144-152` pinta, correctamente, «Esta página no tiene facturas —
   hay 350 en la cartera completa», y `:194` imprime «Facturas 0–0 de 350».
   **Eso está bien y es el arreglo de FE-2.**
3. `hayMas = consumidas(9800) < 350` → `false`, así que no hay «Siguientes».
   Queda **un solo control**: «← Anteriores» → `?p=98`, que también está fuera
   de rango y repite la misma pantalla. Para llegar a `?p=4` (la última con
   datos) son **95 clics**. Con `?p=1000` son **996**.
4. La pantalla **tiene el dato** para el atajo: `cobranza.total` y
   `cobranza.porPagina` están en el objeto — `Math.ceil(350/100) = 4` es la
   misma aritmética que `despacho/vista.tsx:82-83` ya hace.

Consecuencia: en la pantalla que responde «¿cuánto me deben?», el contralor
queda encerrado y tiene que editar la URL a mano. La ronda que arregló este
callejón en Despacho —con nombre y todo: «Ir a la última página (N)»— no lo
llevó a su gemelo, que es la pantalla de dinero.

Causa raíz probable: FE-2 (la 28) se acotó a propósito a «lo que se imprime»
y FE-M1 (esta ventana) se acotó a Despacho; nadie unió los dos y el patrón
quedó a medias en el llamador más visible.

---

### [BAJO] FE-B1 — el formulario de onboarding presenta como «sin contestar» cuatro declaraciones fiscales que la flota ya declaró, con el lector de esas respuestas importado tres líneas más arriba
`src/app/dashboard/onboarding/forma.tsx:102` (`dedicacion`), `:104`
(`regimenSat`), `:106` (`dedicado`) y `:108` (`hombreCamion`) — los cuatro
`<Selector>` **sin `valorInicial`**, contra `:52-62` (el tipo de `inicial`, que
solo trae `ingresos, parte, gps, erp, tag, monedero, pagoOperador`),
`src/app/admin/ui/forma.tsx:258` (`defaultValue={valorInicial ?? ''}` → «Elige
una») y `src/app/dashboard/onboarding/page.tsx:9` + `:69`, donde
`facilidad15Declarada(perfil)` —el lector que devuelve exactamente
`{dedicacionExclusivaCarga, regimenElegible}`— **ya está importado y en uso en
el mismo archivo**.

Escenario, con valores. Una flota contesta la entrevista conversacional:
dedicación exclusiva a carga federal = **sí**, régimen SAT = **624**
(Coordinados) → `regimenElegible = true` (`perfil/onboarding.ts:19,50-51`), y
el motor abre la facilidad del 15% en efectivo. Semanas después el dueño entra
a `/dashboard/onboarding` para corregir su proveedor de GPS, abre «Prefiero el
formulario» (`page.tsx:94-96`) y ve:

> ¿Dedicación exclusiva al autotransporte terrestre de carga federal? → **Elige una**
> Régimen fiscal (clave SAT c_RegimenFiscal) → **Elige una**

Las dos preguntas de las que depende la deducción del combustible en efectivo
se le presentan como si nunca las hubiera contestado. Manda el formulario:
`declararOnboarding` (`preguntas.ts:238-239`) **no** las mete al patch cuando
vienen `undefined`, así que la declaración guardada sobrevive —el bug no
borra— pero la pantalla mintió sobre el estado y el dueño no tiene forma de
saber cuál de los dos está pasando.

Consecuencia: para el dueño de la flota, la única pantalla donde puede leer su
propia declaración fiscal no se la enseña; el camino natural es volver a
contestar de memoria. Para quien mantenga: siete campos sí se prellenan y
cuatro no, sin una línea que diga por qué — la próxima persona va a asumir que
`declararOnboarding` sí clobbera y a escribir una defensa que ya existe.

Causa raíz probable: `inicial` se armó cuando el formulario solo tenía la parte
de stack y umbral; los cuatro selectores fiscales se agregaron después (el de
`regimenSat`, en esta misma ventana) sin extender el objeto.

---

## Lo que revisé y está bien

- **El trabajo obligatorio del rubro: cada mapa literal del panel contra
  `src/types/likida.ts`, rehecho.** Automaticé el censo (script en el
  scratchpad: declara `NOMBRE: Record<K, …>`, busca `NOMBRE[` en todo
  `src/app`, marca los accesos sin `??`) y revisé a mano los 14 que salieron
  sin fallback. **Ninguno puede quedar en blanco:**
  - `rotulo-diferencia.ts:18` — comparé por script las **43** claves de
    `TipoDiferencia` contra las **43** del mapa: `faltan: ∅`, `sobran: ∅`. Y
    `rotuloDiferencia()` (`:47-52`) degrada a la clave legible, nunca a vacío.
  - `[id]/vista.tsx:190` `ETIQUETA_CAPTURA` se indexa con
    `tipos.find((t) => t in ETIQUETA_CAPTURA)` (`:229`) — la clave sale del
    propio mapa. `TIPOS_TOPE` (`:195`) son 4 valores que existen en
    `TipoDiferencia`.
  - `facturacion/vista.tsx:395` `PILL_ESTATUS[f.estatus]` no lleva `??` **a
    propósito**: el render lo guarda con `{pill && …}` (`:408`) porque
    `'emitida'` no tiene chip.
  - `conexiones/seccion-integraciones.tsx:62-63` encadena
    `ESTADO_INTEGRACION[i.estado]` → `TONO[e.tono]` sin `??`, pero
    `integraciones.ts:50` es `Record<EstadoIntegracion, …>` **exhaustivo** y
    `tono` es una unión de las 4 claves de `TONO`: un estado nuevo rompe `tsc`.
  - `agentes/peajes/vista.tsx:376` `EVIDENCIA_LEGIBLE[evidencia.motivo]`
    cubre 4/4 de `MotivoSinEvidencia` (`evidencia_gps.ts:41-49`), y
    `porMotivo: Record<MotivoSinEvidencia, number>` (`:91`) pone `tsc` en rojo
    si crece.
  - `carta-porte/vista.tsx:116-123` cubre 3/3 de
    `necesita: 'si'|'no'|'falta_declarar'` (`carta_porte.ts:78`);
    `top-rutas.tsx:19-21` degrada a `var(--muted)` declarado.
  - `dashboard/estatus.ts:26` (`etiquetaEstatus`) y `soporte/estatus.ts`
    (`pillTicket`) tienen fallback explícito.
  - **`chrome.tsx` dejó de ser la quinta copia del dominio de roles**:
    `7292f9d` movió `ROL_BADGE` a `lib/auth/provisionar.ts:65` como
    `Record<RolAppUser, string>` exhaustivo (5/5: superadmin, flota_admin,
    contador, encargado, vendedor), junto a `ROL_LABEL`.
- **`estadoRenglon` ya no reconstruye las cubetas del motor**
  (`[id]/vista.tsx:226`, `cubetaDe` importada). Seguí el cambio rama por rama
  contra `engine.ts:478-494` buscando una regresión de orden y **no la hay**:
  `sin_cfdi` y los tipos de tope siguen ganando sobre `por_confirmar` porque
  su rama está antes (`:230-232`); el único comportamiento que cambia es el
  ticket sin CFDI y sin diferencias, que pasa de «Ticket» neutral a «Por
  confirmar» ámbar — que es exactamente lo que el bloque de deducibilidad de
  la misma hoja ya decía. Verifiqué que la etiqueta «Ticket» eliminada **no la
  referencia ninguna otra pantalla ni leyenda** (`grep` en `src/app`).
- **El corte del PDF de una liquidación rechazada, por las dos puntas**
  (`03feb95`): `[id]/page.tsx:200-219` separa «no hay revisión» de «no se pudo
  leer la revisión» (antes un `.catch(() => null)` ciego), `:313-315` apaga
  `pdfHref` en los dos casos, `detalle.tsx:185-194` pinta un aviso rojo que va
  **primero** y explica por qué no hay descarga, y
  `api/export/pdf/[id]/route.ts:115-121` vuelve a comprobar `revision` por su
  cuenta (409, con log). El estado «rechazada» sí tiene su propia frase en
  pantalla (`revision-panel.tsx:57-62`).
- **Formato de cifras: una sola fuente, intacta.** `grep` de
  `toLocaleString|Intl.NumberFormat|toFixed(2)` en `src/app` devuelve tres
  comentarios, `calculadora/calc.tsx:28` (un `String()` de un valor por
  defecto, no una cifra fiscal) y `api/export/poliza/route.ts:130` (texto de
  un error de API, no de pantalla). Ni una cifra de dinero del panel se
  formatea fuera de `lib/formato.ts`.
- **`key` de React en tablas de dinero:** revisé las ~25 apariciones de
  `key={i}`/`key={idx}` en `/dashboard` buscando el modo de falla que el rubro
  nombra y no lo encontré. Toda tabla con dinero lleva el id real
  (`facturacion/vista.tsx:353` `key={f.id}`, `:679`
  `key={\`${h.viajeId}-${h.cubeta}\`}`, `agentes/liquidacion/cola.tsx:246`
  `key={l.id}`, `rentabilidad/vista.tsx` y `despacho/vista.tsx` igual); los
  `key={i}` viven en listas estáticas de server components (notas, supuestos,
  ejes de gráfica, esqueletos de carga) que no se reordenan ni tienen estado.
- **Desbordamiento horizontal de tablas:** de los archivos de `src/app` con
  `<table>`, **todos** los del panel del cliente declaran su
  `overflow-x-auto`; el único con menos wrappers que tablas es
  `admin/qa/[id]/medicion-corrida.tsx` (consola interna de Javier, no del
  comprador).
- **El foco por omisión sigue vivo:** `grep -n "outline"` en `globals.css`
  devuelve solo `:381-386` (`.sb-aside`), `:398-401` (la regla nueva de FE-M3)
  y `:454`. **No hay ningún `outline: none` global** — refutación que intenté
  y que confirma que FE-M3 estaba bien diagnosticado y bien cerrado.
- **`/pago/[token]`** (la pantalla que ve un tercero, el cliente de la flota):
  el botón `text-white` sobre `var(--marca)` **no** rompe, porque
  `layout.tsx:53` solo estampa `data-theme` bajo `/dashboard` — fuera de ahí
  `--marca` es siempre `#c2410c`, **5.37:1** contra blanco. Lo verifiqué
  precisamente porque parecía un hallazgo y no lo es. `forma.tsx:16-20`
  documenta bien que la validación real vive en el servidor.

---

## Lo que NO alcancé a revisar

- **Sigo sin mirar un render.** `npm run build` está prohibido en este entorno
  y no hay credenciales. Los contrastes de FE-M1 (3.45:1 y 2.82:1) están
  **calculados** —convertí el oklch de Tailwind v4 a sRGB y apliqué la fórmula
  de luminancia WCAG, con el script en el scratchpad— no vistos en pantalla.
  Los 95 clics de FE-M3 están **derivados** de `COBRANZA_POR_PAGINA = 100` y
  del clamp de `page.tsx:34`, no cronometrados.
- **Ninguno de los cinco hallazgos lo fijé con una prueba**, porque no puedo
  escribir en el repo fuera de este entregable. Los cinco son deterministas:
  FE-M3 se fija con `{facturas: [], total: 350, pagina: 99}` y
  `expect(html).toMatch(/última página/)`; FE-M2 con un mock que lance
  `Error('listarSolicitudesArco: permission denied…')` y
  `expect(html).not.toContain('permission denied')`; FE-M1 y FE-B1 con lectura
  de fuente, como el barrido de `tokens_definidos.test.ts`.
- **Responsive: sigue sin revisar de verdad.** Solo verifiqué que las tablas
  del panel declaran `overflow-x-auto` y que existe el `<meta viewport>`
  (`layout.tsx:44`). Ningún ancho medido, ningún breakpoint recorrido, ningún
  `min-w-[…]` verificado contra 375 px — y `motor-fiscal-periodo.tsx:60,75`
  usa `min-w-[190px]` en dos tarjetas que comparten fila.
- **Orden de foco y navegación por teclado fuera de `revision-panel.tsx`:**
  sin revisar. Verifiqué que la regla nueva de `globals.css:398` cubre los dos
  `sr-only` interactivos que existen hoy (firma y días de cobranza), nada más.
- **`/admin` completo:** solo lo recorrí para el censo de mapas literales y
  para `admin/ui/kit.tsx`. `admin/copiloto.tsx`, `admin/qa/*` y
  `admin/vendedores/tablero.tsx` (que pasa `transiciones`/`rotulos` como
  `Record<string, …>` por prop) quedaron sin abrir.
- **`/vendedor`, `/demo`, `/login`, `/aviso/[tenant]`, `/calculadora`:** leí
  `demo/page.tsx` entero (122 líneas, sin hallazgo: el `catch` de `cerrar()`
  ya evita que el demo se cuelgue) y solo grepeé los otros cuatro.
- **La superficie nueva no-frontend de la ventana** (`processor.ts +469`,
  `calcom_webhook.ts +242`, `openrouter.ts +101`): fuera de mi rubro, no la
  abrí. De los 228 archivos tocados, los que caen aquí son 32 y los recorrí
  todos por `git diff`; los `.test.` los leí solo cuando anclaban un cierre.
