# Frontend — auditoría 30

**Nota: 5/10** (antes 6). Razón del movimiento: **mirada más profunda — el
código de mi rubro casi no cambió y la nota anterior estaba inflada.** En los
38 commits de la ventana solo **dos** archivos de producción de mi superficie
se tocaron (`admin/crons/vista.tsx` y `dashboard/arco/page.tsx`, y el segundo
por un hallazgo legal). **Los cinco hallazgos que dejé abiertos en la 29 siguen
los cinco, línea por línea** — cero cierres, contra ocho de diez en la ronda
anterior. Y el barrido nuevo encontró un **ALTO** que llevaba ahí desde antes:
`/dashboard/chat` contesta «todavía no hay datos» cuando lo que pasó es que la
base no respondió — exactamente el modo de falla que CLAUDE.md nombra por su
nombre — y la prueba que entró en esta ventana **lo dejó escrito como
comportamiento esperado** en vez de cazarlo.

Lo que evita que baje más: no encontré ninguna pantalla que le enseñe al
comprador una cifra mal formateada ni una pantalla en blanco (el ancla de «4 o
menos»). El responsive resultó estar mejor de lo que la 29 temía, el censo de
mapas salió limpio, y `descarga-sat/bandeja/vista.tsx` es el mejor ejemplo del
repo de una pantalla con sus cuatro estados pintados a propósito.

**Riesgo mayor del rubro, hoy:** sigue siendo el anticipo en cero (FE-C1,
**quinta ronda**), y detrás de él, que «no pude leer» se siga traduciendo a «no
hay» en la pantalla que el comprador va a usar en la sala para preguntarle a la
IA por sus acreditables.

---

## Foco obligatorio de la ronda: ¿la cobertura nueva cubre los cuatro estados?

Medí los 49 `page.test.tsx` nuevos (`git log --name-only 7bcc319..HEAD --
'src/app/**/page.test.tsx'`). **La respuesta es: la mayoría muerde de verdad,
dos de las tres pantallas más caras del comprador no.**

Las que muerden — abiertas y leídas, no inferidas:

- `src/app/admin/analitica/page.test.tsx:25-46` — siembra `porDia` con **un**
  punto y exige `'Sin historial suficiente todavía'`; con dos exige que
  desaparezca. Y `:37` siembra `facturasPorDia: [{n:0},{n:0}]` y exige «Aún sin
  datos suficientes» en vez de una barra en cero. Eso es el estado vacío
  probado como estado, no como render.
- `src/app/admin/flotas/page.test.tsx:140` y `:147` — separa explícitamente
  «lectura de teléfonos caída (`sin_medir`)» de «teléfono realmente ausente
  (`pendiente`)». Es el corazón de la regla del repo, probado.
- `src/app/admin/costos-facturacion/page.test.tsx:171` — «un "por cobrar"
  caído se DICE — nunca se confunde con "nada pendiente"».
- `src/app/dashboard/clientes/page.test.tsx:160` — «una lectura del panel caída
  no finge "sin clientes" — pasa `panel: null` a la vista».

Las que no:

- `src/app/dashboard/descarga-sat/page.test.tsx` — **el commit que «cierra la
  campaña» (`8f55ce0`)**. Son 2 casos y los dos comprueban cableado de props
  (`props.type === VistaDescargaSat`, `props.props.tenantExiste`). La pantalla
  real son las **396 líneas** de `descarga-sat/vista.tsx` con cuatro server
  actions y las **441** de `descarga-sat/bandeja/vista.tsx`, y **ninguna de las
  dos tiene un solo `.test.`** (`find src/app/dashboard/descarga-sat -name
  '*.test.*'` → un archivo). Cero de los cuatro estados cubiertos.
- `src/app/dashboard/chat/page.test.tsx:75-80` — cubre el error, y lo cubre
  **al revés**: ver FE-A1.
- `src/app/dashboard/suscripcion/page.test.tsx` — 13 casos, todos de server
  actions (contratar, datos fiscales, portal de cobro). Ni uno del render:
  ninguno sobre `suscripcion === null`, ninguno sobre `ESTADO_PILL` (`:242`).
  Es el dinero que la flota le paga a Likida y su vista está sin arnés.

**Veredicto:** la campaña subió el piso real en `/admin` y en la mitad de
`/dashboard`; pero las tres pantallas que quedan sin estados probados son
`descarga-sat` (fiscal), `suscripcion` (dinero de la cuenta) y `chat` (la que
se enseña en el demo). No regalo el punto.

---

## Estado de los cinco hallazgos abiertos de la 29

| Hallazgo de la 29 | Hoy | Ancla de hoy |
|---|---|---|
| **FE-C1** CRÍTICO — el despacho no ofrece el Anticipo | **REINCIDENTE (5ª ronda)** | `grep -rn 'name="anticipo"' src/` sigue devolviendo **una** línea: `forma-viaje.tsx:92`. Ver abajo |
| **FE-M1** MEDIO — `BTN_VERDE` con `dark:` sobre el eje equivocado | **REINCIDENTE** | `cotizaciones/acciones.tsx:28`, intacta. `grep -rn "dark:" src/app --include=*.tsx` (sin pruebas) devuelve **esa línea y un comentario** — sigue siendo la única |
| **FE-M2** MEDIO — mensaje crudo de PostgREST en pantalla | **REINCIDENTE y EXTENDIDO** | `arco/page.tsx:211` y `conversaciones/page.tsx:90` siguen; encontré un **tercer** sitio, en una pantalla de dinero. Ver abajo |
| **FE-M3** MEDIO — Rentabilidad sin salida desde `?p=99` | **REINCIDENTE** | `rentabilidad/vista.tsx:197-208`: los dos únicos links siguen siendo «Anteriores» (`pagina − 1`) y «Siguientes» (solo si `hayMas`). `hayMas` (`:51`) es `false` en la página fuera de rango |
| **FE-B1** BAJO — onboarding no prellena 4 declaraciones fiscales | **REINCIDENTE** | `onboarding/forma.tsx:54-62` (el tipo de `inicial`, 7 campos) contra los `<Selector>` de `:102`, `:104`, `:106`, `:108`, los cuatro **sin `valorInicial`** |

---

## Hallazgos

### [CRÍTICO] FE-C1 · REINCIDENTE (QUINTA ronda) — el despacho sigue sin ofrecer el Anticipo: el viaje nace en 0 y la pantalla de firma presenta ese cero como una medición
`src/app/dashboard/forma-viaje.tsx:90` (el campo, tras `{puedeCapturarDinero &&
…}`) y `:174-177` (los Kilómetros que lo sustituyen),
`src/app/dashboard/despacho/page.tsx:163-164` (`… : 0`) y `:198`,
`src/lib/auth/visibilidad.ts:41` (`encargado: ['operacion']`), contra
`src/app/dashboard/[id]/detalle.tsx:242` y `:245-249`.

Escenario, con valores (reverificado contra el árbol de hoy, archivo por
archivo). Flota con jefe de tráfico (`rol = 'encargado'`). Despacha
`VJ-2026-0845` Silao → Monterrey con **$20,000** de anticipo en efectivo al
chofer.

1. `puedeVerArea('encargado','dinero')` es `false` → `forma-viaje.tsx:90` **no
   pinta el campo Anticipo**; `:175` pinta «Kilómetros» en su lugar. Nada en
   pantalla dice que el anticipo lo captura alguien más.
2. `despacho/page.tsx:163-164`: `fd.get('anticipo')` es `null` → `anticipo = 0`,
   y se escribe en `:198`. La columna es `NOT NULL DEFAULT 0`: un 0 tecleado y
   un 0 por ausencia son indistinguibles para siempre.
3. Comprobantes por **$18,400** → `diferencia = round2(0 − 18400) = −18400`.
4. `/dashboard/[id]` pinta, uno junto al otro, `Anticipo $0.00 · entregado al
   operador` (`detalle.tsx:242`) y `Diferencia $18,400.00 · faltante · a favor
   del operador` en tono `bad` (`:245-249`).
5. **Sigue sin haber dónde arreglarlo después.** `grep -rn 'name="anticipo"'
   src/` devuelve una sola línea (`forma-viaje.tsx:92`). Recorrí hoy todos los
   `anticipo:` de `src/app` y `src/lib` fuera de pruebas: los únicos escritores
   siguen siendo los dos **creadores** (`despacho/page.tsx:198` y
   `api/v1/viajes/route.ts:278`); `repo.ts:80`/`:95` lo LEE. No existe un solo
   `update` de `viaje.anticipo`.

Consecuencia: el contralor firma una liquidación cuya cifra principal está mal
por el monto entero del anticipo, y el PDF que el chofer conserva afirma que la
empresa le debe $18,400 que ya cobró. La flota que más se parece al comprador
—la que tiene jefe de tráfico dedicado— es exactamente la que cae.

Causa raíz probable: el bloqueo de la captura financiera se resolvió ocultando
el campo en el render, sin decidir quién captura entonces el dato que el motor
necesita ni cómo se representa «no capturado» en una columna `NOT NULL DEFAULT
0`. Es una decisión de producto pendiente, no un defecto de render — y por eso
lleva cinco rondas sin moverse.

(REINCIDENTE, 5ª ronda.)

---

### [ALTO] FE-A1 — «Preguntar a la IA» afirma «todavía no hay datos de acreditables» cuando lo que pasó es que la base no contestó; y la prueba nueva de esta ventana bendice el fail-open en vez de cazarlo
`src/app/dashboard/chat/page.tsx:49-50` (los dos `.catch(() => null)`) contra
`src/app/dashboard/chat.tsx:94` (`sinLiq`), `:126` y `:146`, y contra
`src/lib/likida/analytics.ts:219` / `:687` (las firmas) y `:226` / `:694` (los
`throw`). La prueba que lo congela:
`src/app/dashboard/chat/page.test.tsx:75-80`.

Escenario, con valores. Sábado por la noche, Supabase con el pooler saturado.

1. `getKpis` y `getAcreditables` están declarados `Promise<DashboardKpis>` y
   `Promise<Acreditables>` — **nunca devuelven `null`**. Fallan cerrado y
   lanzan: `analytics.ts:226` (`throw new Error('getKpis: …')`) y `:694`. Está
   escrito a propósito, con comentario: *«Fail-closed: un 0 inventado sobre una
   forma inesperada se ve exactamente igual que una flota que de verdad no ha
   liquidado nada»*.
2. `chat/page.tsx:49-50` vuelve a abrir esa puerta:
   `getAcreditables(tenantId, vl.dias).catch((): Acreditables | null => null)`.
   Después de esa línea, **`acred === null` significa una sola cosa: la lectura
   falló.** No existe el caso «leyó y no había nada»: en ese caso vienen ceros
   medidos.
3. El contralor teclea la pregunta sugerida de la propia caja
   (`chat.tsx:24`, «¿Cuánto llevo de acreditables?»). El analista también corre
   contra la misma base caída y devuelve `{t:'error'}`, así que el flujo entra
   al paracaídas (`chat.tsx:566`) → `respuestaLocal` → `responder`.
4. `chat.tsx:146`: `if (!acred) return { texto: 'Todavía no hay datos de
   acreditables este periodo.' }`. En pantalla:

   > No se pudo conectar con el analista. Esto es lo que puedo contestarte con
   > lo último que ya tenía cargado, no una lectura nueva de tu operación:
   >
   > **Todavía no hay datos de acreditables este periodo.**

   El prefijo declara que el *analista* falló y promete que lo que sigue sale
   «de lo último que ya tenía cargado» — o sea, presenta la frase como un dato.
   Y la frase es una afirmación sobre el IVA y el peaje acreditables de la
   flota, hecha estando ciego. Igual con «¿cuánto llevo comprobado?» →
   `chat.tsx:94`, **«Todavía no hay liquidaciones para calcular esto.»**
5. **Hay un camino peor, sin ni siquiera el prefijo.** `chat.tsx:566`: el
   `motivo` solo se pone si `d.t === 'error'`. Si la respuesta llega `200` pero
   sin `bloques` (o el `resp.json()` de `:552` revienta y `d` queda `null`), el
   `motivo` es `null`, `respuestaLocal` devuelve la base sin aviso
   (`chat.tsx:180`) y el contralor lee, a secas: *«Todavía no hay datos de
   acreditables este periodo.»*
6. **La cobertura nueva lo dejó escrito como correcto.** `chat/page.test.tsx:75`
   se titula literalmente *«un fallo de KPIs no tumba el chat — pasa null, no
   rompe la página (fail-open del lado de disponibilidad)»*, siembra
   `mockRejectedValueOnce(new Error('caída'))` y afirma
   `expect(chat.props.kpis).toBeNull()` — y ahí se detiene. Nunca pregunta qué
   se le dice al usuario. Y `responder()` **no tiene una sola prueba**: `grep
   -rn 'Todavía no hay liquidaciones para calcular'` en todo `src/` devuelve
   **una** línea, la del propio `chat.tsx:94`.

Consecuencia: en la pantalla del demo, con la base a medias, el comprador
pregunta por sus acreditables y Likida le contesta que no tiene ninguno. Es
falso y es sobre materia fiscal. Y es exactamente la falla que CLAUDE.md
describe con esas palabras: *«una base caída se lee como "no hay nada", y el
panel afirma "aún no hay liquidaciones" estando ciego»*. Las dos fallas
(lectura de la página y analista) no son independientes: comparten causa —la
base—, así que se dan juntas.

Causa raíz probable: la página convierte una excepción en `null` por
disponibilidad, y el respondedor local ya usaba `null` con el significado
opuesto («no hay datos todavía»); nadie unió los dos significados en un tercer
estado. El `Respuesta` que devuelve `responder()` no tiene forma de decir «no
pude leer».

---

### [MEDIO] FE-M2 · REINCIDENTE y EXTENDIDO — el mensaje crudo de PostgREST sigue en Privacidad y Conversaciones, y ahora también en la bandeja de conciliación del SAT, que es pantalla de dinero
`src/app/dashboard/arco/page.tsx:166` (el `catch`) y **`:211`** (donde se
pinta); `src/app/dashboard/conversaciones/page.tsx:51` y **`:90`**; y el sitio
nuevo: `src/lib/likida/sat_descarga/bandeja.ts:251` (`throw new
Error(error.message)`) → `:256-258` (`return { ...vacia, error: detalle }`) →
`src/app/dashboard/descarga-sat/bandeja/vista.tsx:277`.

Escenario, con valores. Se aplica una migración y un `GRANT` no alcanza sobre
`sat_cfdi_descargado`. El contralor entra a
`/dashboard/descarga-sat/bandeja?estatus=ambiguo`, que es donde decide a qué
gasto se liga cada CFDI deducible. `leerBandeja` atrapa, **loguea bien**
(`logger.warn('sat_descarga.bandeja_no_leida', …)`) y además devuelve el mismo
string a la pantalla, que lo imprime literal:

> No se pudo leer esta lista, así que NO significa que esté vacía: **permission
> denied for table sat_cfdi_descargado**

El molde es el mismo en ARCO (`listarSolicitudesArco: permission denied for
table solicitud_arco`, en la pantalla de **privacidad**) y en Conversaciones.

Consecuencia: el cliente lee el nombre de una tabla interna dentro de la
pantalla donde decide una deducción fiscal, y no puede accionar nada con eso.
La casa ya decidió que esto no se hace: `mapa/page.tsx:129-138` lo documenta en
tres párrafos («la frase que sale de aquí tiene que ser NUESTRA siempre»). El
arreglo de la 28 se aplicó al llamador, no al patrón, y desde entonces el
patrón **creció** en vez de encogerse.

Causa raíz probable: el mismo string sirve de mensaje de log y de texto de UI;
no hay tipo, lint ni prueba que separe los dos usos. (REINCIDENTE, con un
tercer sitio nuevo.)

---

### [MEDIO] FE-M3 · REINCIDENTE — la columna «Estado» de Descarga del SAT imprime el valor crudo del dominio (`en_proceso`, `descargada`) y un `error` con el mismo tono que un éxito
`src/app/dashboard/descarga-sat/vista.tsx:353` (`<td className="py-1">
{s.estado}</td>`), contra `src/lib/likida/sat_descarga/lectura.ts:117`
(`estado: s.estado as string`) y el dominio de
`supabase/migrations/0231_descarga_masiva_sat.sql:169-170` (`check (estado in ('solicitada',
'en_proceso', 'lista', 'descargada', 'error', 'expirada'))`).

Escenario, con valores. El contralor pide un rango a mano (sección 4 de la
misma pantalla). El SAT tarda. Abre «Tus solicitudes» y lee, en la columna
rotulada **Estado**:

| Periodo | Buzón | Estado | CFDI nuevos |
|---|---|---|---|
| 01/08/2026 → 31/08/2026 | recibidos | `en_proceso` | — |
| 01/07/2026 → 31/07/2026 | recibidos | `error` | — |

`en_proceso` con guion bajo es un identificador de base, no una frase; y
`error` se pinta con exactamente el mismo color y peso que `descargada`, en un
panel donde **todas** las demás listas usan `StatusPill` con su mapa de rótulo
y tono (`resumen-visual.tsx:103`, `crons/vista.tsx:77-82`,
`unidades/vista.tsx:16`, `facturacion/vista.tsx:395`). Esta tabla no tiene mapa
de etiquetas: seis estados de dominio y cero rótulos.

Consecuencia: la única pantalla donde el contralor ve si el SAT le contestó
enseña seis estados en el idioma de la migración, y el que importa —`error`—
no se distingue del que no. Es la pantalla que se abre para contestar «¿por qué
no me han llegado mis facturas?».

Causa raíz probable: la pantalla se construyó alrededor de la configuración y
las cinco tarjetas de conteo (que sí distinguen `null` de `0` con `sinDato="no
se pudo leer"`, `:245-259`); la tabla de solicitudes se agregó como volcado
directo y nunca pasó por el kit.

---

### [BAJO] FE-B1 — `/admin/crons`: cuando un reloj no late, la corrida parcial de otro desaparece del resumen; el card solo la menciona si todo lo demás está verde
`src/app/admin/crons/vista.tsx:199` (`const malos = [...sinLatir,
...conFallo]`), `:216` (`{malos.length === 0 ? …`), `:220-224` (la única
mención de `parciales`) y `:226-243` (la rama mala, que nunca los nombra),
contra `:186-194` (`resumenRelojes`, que **sí** los calcula) y contra el
renglón nuevo de `94de18f` en `:170-171`.

Escenario, con valores. `gps` late puntual y reporta `parcial` con
`{conError: 2, backlogPendiente: 431}`; `purgar` lleva 9 horas sin latir
(`estado: 'vencido'`). `resumenRelojes` devuelve `sinLatir: ['purgar']`,
`conFallo: []`, `parciales: ['gps']` → `malos.length === 1` → se toma la rama
de `:226`, que solo sabe imprimir `sinLatir` y `conFallo`:

> ⚠ **1** de 11 relojes no están latiendo como deberían: purgar.

Ni una palabra de `gps`. Con `purgar` sano, la misma corrida de `gps` sí
saldría: *«(gps reportó corrida parcial — el detalle está abajo.)»*. O sea: la
señal parcial se calla precisamente cuando hay más cosas rotas a la vez. El
detalle sí está en la tabla de abajo (y ahí el arreglo de `94de18f` funciona —
verifiqué el archivo y corrí `vista.test.tsx`: 13/13 pasan), pero el card de
arriba es lo que se lee de un golpe.

Consecuencia: Javier (y el turno de guardia) pierden un aviso de degradación
parcial justo en la corrida que ya viene mal. Es la consola interna, no la del
comprador — por eso BAJO.

Causa raíz probable: `resumenRelojes` se extendió a tres ejes (`sinLatir`,
`conFallo`, `parciales`) y solo dos de los tres se cablearon a la rama mala del
render. La prueba de `:50-63` cubre la **función** con los tres ejes; ninguna
renderiza `VistaCrons` con un `vencido` **y** un `parcial` a la vez.

---

### [BAJO] FE-B2 — la migración `0351` agregó dos fases de costo y las cuatro copias del diccionario de rótulos no se enteraron: la dona de costo de IA pinta `copiloto` y `runner` al lado de «Agente OCR»
`src/lib/likida/costos.ts:41` (`type FaseCosto = 'ocr' | 'cuadre' |
'escalacion' | 'chat' | 'router' | 'whatsapp' | 'transcripcion' | 'copiloto' |
'runner'` — nueve) contra las **cuatro** copias de `FASE_LABEL`, todas
declaradas `Record<string, string>` y todas con **seis** claves o menos:
`src/app/admin/consola.tsx:29-32`, `src/app/admin/analitica/page.tsx:12-15`,
`src/app/admin/costos-facturacion/page.tsx:65-68` (con el comentario «Mismo
diccionario de admin/consola.tsx (no se exporta de ahí)») y
`src/app/admin/model-ops/page.tsx:11` (solo **tres** claves).

Escenario, con valores. El runner de agentes y el copiloto gastan en el mes.
`getResumenNegocio().porFase` trae
`[{fase:'ocr',…},{fase:'runner',…},{fase:'copiloto',…},{fase:'transcripcion',…}]`.
Los cuatro llamadores hacen `FASE_LABEL[f.fase] ?? f.fase`
(`consola.tsx:508`, `analitica:81`, `costos-facturacion:249`,
`model-ops:95`) → la leyenda de la dona de «Costo por fase» sale mezclada:
*Agente OCR · Agente de Cuadre · `runner` · `copiloto` · `transcripcion`*. En
`/admin/model-ops` es peor: solo tres de las nueve tienen rótulo.

Consecuencia: cosmético y de consola interna — por eso BAJO. Lo que sí cobra
factura es la forma: `Record<string, string>` con `??` significa que **`tsc`
nunca se va a poner en rojo** cuando el dominio crezca otra vez, y ya creció en
esta ventana sin que nadie lo notara. Cuatro copias, cuatro veces la misma
deuda.

Causa raíz probable: el mapa se copió tres veces en vez de exportarse (el
comentario de `costos-facturacion:63-64` lo admite por escrito), y el `??` al
usarlo convierte el desfase en algo que no falla nunca, solo se ve feo.

---

## Lo que revisé y está bien

- **El trabajo obligatorio del rubro, rehecho hoy con script propio** (en el
  scratchpad): recorrí los `.ts/.tsx` de producción de `src/app`, junté los
  **81** `const NOMBRE: Record<…>` literales, busqué sus **130** usos indexados
  y aparté los que se indexan **sin `??`/`||`**. Revisé a mano los que salieron
  y **ninguno puede quedar en blanco ni reventar**. Los que costaron:
  - `facturacion/vista.tsx:687` `ROTULO_CUBETA[h.cubeta].rotulo` **accede a una
    propiedad** del resultado (`.rotulo`), así que un hueco sería un
    `TypeError`, no un blanco. No lo hay: `ROTULO_CUBETA` (`:598-601`) se
    **deriva** de `CUBETAS_AUDITOR` (`auditor_cobranza.ts:122-135`), que cubre
    **8/8** de `CubetaAuditor` (`:96-118`); lo crucé una por una, y
    `cubetasAuditorEnCero()` (`:440`) es el tercer testigo exhaustivo.
  - `descarga-sat/bandeja/vista.tsx:180` y `:210` `COLAS[estatus]` — `COLAS`
    (`:45`) es `Record<EstatusCfdi, …>` con las 4 claves, y `estatus` sale de
    `esEstatusCfdi()` (`:386`), que valida contra la misma unión.
  - `facturacion/estadias.tsx:104`
    `ROTULO_SIN_MONTO[d.motivoSinMonto as MotivoSinMonto]` — el `as` silencia
    el `| null` del tipo (`estadias/motor.ts:122`). Intenté romperlo: recorrí
    las **cinco** ramas de `calcularDetencion` (`motor.ts:138-173`) y en todas
    `monto === null` ⟺ `motivoSinMonto !== null`, así que la rama que lo pinta
    (`monto === null`) nunca recibe el `null`. Es correcto **por invariante, no
    por tipo**; si llegara a romperse, degrada a texto vacío, no a crash.
  - `crons/vista.tsx:129-130` `OFICIO[cron]`/`RUTA[cron]` — los dos son
    `Record<CronId, …>` exhaustivos, y `CronId` es la misma constante que
    `salud.test.ts` cruza contra `vercel.json`. Con el 11º cron
    (`portales-vivos`) ya dentro, `tsc` obliga.
  - `admin/copiloto.tsx:493` `PANTALLA_UI[t]` es `Record<string, …>` sin `??`,
    pero el `.filter((p): p is … => Boolean(p))` de `:494` tira los huecos.
- **Formato de cifras: una sola fuente, intacta.** `grep -rn
  "toLocaleString|Intl.NumberFormat|toFixed("` en `src/app` sin pruebas
  devuelve **solo** geometría de SVG (`charts.tsx:22,115,116,119`,
  `graficas.tsx:141`, `mapa/page.tsx:116,200,201`, `mapa/mapa-vivo.tsx:62`),
  coordenadas (`mapa/vista.tsx:221`), textos de error de API
  (`export/poliza/route.ts:130`, `qa/*/route.ts`) y un `String()` de un valor
  por defecto (`calculadora/calc.tsx:28`). **Ni una cifra de dinero del panel
  se formatea fuera de `lib/formato.ts`.** `src/app/dashboard/formato.ts:27` es
  un re-export puro.
- **`src/app/tokens_definidos.test.ts` sigue verde** (lo corrí: 4/4). Cero
  `var(--x)` huérfanos en todo `src/app`.
- **Responsive: mejor de lo que la 29 temía, y ahora sí medido.** `grep` de
  `min-w-[Npx]` en `src/app` da 22 apariciones y **el máximo es 260px** — cero
  por encima de 360. Y de los `grid-cols-3..9` sin prefijo responsive en todo
  `/dashboard` queda **uno**: `[id]/detalle.tsx:241`, que es
  `grid-cols-2 min-[1100px]:grid-cols-5` — o sea 2 columnas en móvil, correcto.
  El `min-w-[190px]` que la 29 dejó señalado (`motor-fiscal-periodo.tsx:60,75`)
  cabe dos veces en 375 px solo si no comparten fila; no lo pude confirmar sin
  render, lo dejo abajo.
- **`descarga-sat/bandeja/vista.tsx` es el patrón a copiar:** los cuatro
  estados, cada uno a propósito y con su razón escrita — error (`:274-278`),
  parcial (`:267-272` y `:334-341` y `:346-352`), vacío que distingue «esta
  cola está vacía» de «nunca ha bajado nada» (`:279-289`), conteos `null` que
  pintan guion y lo declaran (`:199-223`), y un pie que dice «no se pudo
  contar» en vez de un total inventado (`:313-315`).
- **`rentabilidad/vista.tsx:37-38` aguanta el ataque obvio:** intenté que
  `sinNada` se disparara con las dos lecturas caídas —lo que habría pintado
  «tu cuenta todavía no tiene estos datos» estando ciego— y no se puede:
  exige `rentabilidad !== null && cobranza !== null` antes de mirar los ceros.
  Las dos ramas de error van primero (`:71` y `:117`) con `EstadoError`.
- **`notificaciones/page.tsx:38-56`** hace bien lo que `chat/page.tsx` hace
  mal: cinco `.catch(() => null)` independientes, y `calcularAlertasFlota`
  recibe los `null` como tercer estado (`porRevisar: kpis ? … : null`) para
  confesar lo que no pudo revisar. El comentario de `:22-25` lo dice: «se lee
  con `catch → null`, no con `catch → 0`».
- **El error boundary del panel está bien hecho** (`dashboard/error.tsx:32-91`):
  registra con `logger` (`:43-48`), pinta el `digest` seleccionable (`:80-84`) y
  separa explícitamente «hubo un problema al leer los datos» de «no hay datos»
  (`:73`). Las páginas sin `try/catch` propio (`admin/analitica`,
  `admin/cobranza`, `dashboard/descarga-sat`) caen ahí y fallan cerrado. Existe
  también `admin/error.tsx`, `admin/loading.tsx`, `dashboard/loading.tsx`,
  `admin/flotas|qa|observabilidad|mapa-prospectos/error.tsx`.
- **El arreglo `94de18f` de `/admin/crons` es real y está anclado.** Leí
  `resumenDetalle` (`vista.tsx:108-120`) y su cableado (`:170-171`), y corrí
  `vista.test.tsx`: **13/13**. Las cuatro pruebas nuevas cubren número, arreglo,
  `fallo` sin código, y `detalle: {}` → guion. La rama vieja del `codigo` de
  `fallo` (`:156`) sigue ganando, que es lo correcto.
- **`key` de React en tablas de dinero:** re-revisado sobre los archivos que
  esta ventana tocó. `facturacion/vista.tsx:353` `key={f.id}`, `:679`
  `key={\`${h.viajeId}-${h.cubeta}\`}`, `rentabilidad/vista.tsx:168`
  `key={f.id}`, `descarga-sat/vista.tsx:350` `key={s.id}`,
  `bandeja/vista.tsx:295` `key={f.id}`, `crons/vista.tsx:268` `key={x.cron}`.
  Los `key={i}` que quedan están en listas estáticas de server component
  (`descarga-sat/vista.tsx:380`, el CHECKLIST de 4 elementos constantes).

---

## Lo que NO alcancé a revisar

- **Sigo sin mirar un render.** `npm run build` está prohibido en este entorno y
  no hay credenciales. Todo lo de arriba es lectura de fuente más aritmética.
  Los contrastes de FE-M1 (3.45:1 y 2.82:1) siguen siendo los **calculados** de
  la 29, no vistos.
- **Ningún hallazgo lo fijé con prueba**, porque no puedo escribir en el repo
  fuera de este entregable. Los tres deterministas se fijan así: FE-A1 con
  `responder('acreditables', null, null)` y
  `expect(r.texto).not.toMatch(/Todavía no hay/)`; FE-M2 con un doble que lance
  `Error('permission denied for table sat_cfdi_descargado')` y
  `expect(html).not.toContain('permission denied')`; FE-B1 con
  `<VistaCrons>` sembrando un `vencido` y un `parcial` a la vez y
  `expect(html).toMatch(/parcial/)` sobre el card.
- **`/dashboard/suscripcion/vista`, `/dashboard/timbrado` y
  `/dashboard/emergencias`:** solo los recorrí por el censo de mapas y por el
  conteo de estados; no abrí sus vistas completas. Son tres de los
  `page.test.tsx` nuevos y los tres cubren server actions, no render.
- **Orden de foco y navegación por teclado:** sin revisar, igual que la 29.
  Verifiqué solo que `globals.css` no tiene ningún `outline: none` global.
- **Tamaños de toque:** no los medí. Solo sé que las flechas de periodo siguen
  en 24×24 (`admin/ui/kit.tsx`, cerrado en la 29).
- **`/admin` en profundidad:** `admin/qa/*`, `admin/vendedores/tablero.tsx` y
  `admin/observabilidad` quedaron sin abrir salvo por el censo de mapas.
- **`/portal`, `/vendedor`, `/demo`, `/login`, `/aviso/[tenant]`,
  `/calculadora`:** solo grepeados.
- **Las 9 migraciones de la ventana** no las leí: ninguna toca render. La 0351
  la miré solo por FE-B2 (el dominio de `FaseCosto`).
