# Backend y API — auditoría 26

**Nota: 7/10** (antes 6). Razón del movimiento: **se atacó y subió**. De los once
hallazgos abiertos que traía este rubro, **nueve están cerrados de verdad** —los
verifiqué uno por uno abriendo el archivo, no la línea del commit— y ocho de
ellos traen prueba propia que corrí (`revision.test.ts`,
`revision_recalculo.test.ts`, `conv_lock_dueno_aud24.test.ts`,
`factura_orden.test.ts`, `suscripcion_tenant_plan.test.ts`: 52 casos, verdes) o
un bloque de `verificaciones.sql` contra Postgres real (bloques 251 y 252). Los
dos caminos de concurrencia que la 25 dejó abiertos —el mutex de viaje que caía
por gravedad a `'obtenido'` y el sello de orden de Stripe— ahora fallan cerrado y
tienen su caso nombrado. Eso es lo que justifica la subida.

Lo que impide llegar a 8: el CRÍTICO reincidente se cerró **a medias**. La 0306
regeneró el desglose y el PDF —la mitad que el hallazgo enumeraba— pero no
contestó la pregunta que hacía: **después de un ajuste, la póliza contable sigue
sin cuadrar**, porque el término que se mueve (`comprobado`) y los dos que no
(`sub_total` del comprobante e `iva_acreditable` derivado del XML) siguen
entrando a la misma resta. Y sigue sin haber una sola prueba del seam
ajuste → póliza: el bloque 251 de `verificaciones.sql` prueba que la RPC
persiste el recálculo, no que el recálculo cuadre con lo que el contador
importa.

El riesgo mayor del rubro hoy: **el único artefacto que sale de Likida hacia el
ERP del cliente —la póliza ContPAQi/SAP— sigue derivando un «IVA/IEPS no
acreditable» de una resta cuyos tres términos ya no describen el mismo hecho en
cuanto el contralor firma un ajuste**; o inventa la cifra, o tira el export del
periodo entero con 409.

## Hallazgos

### [CRÍTICO · REINCIDENTE de la 24 y la 25, cierre PARCIAL] Tras `ajustar`, la póliza sigue inventando un «IVA/IEPS no acreditable» o tirando el periodo entero con 409

`src/lib/likida/contabilidad/poliza.ts:203-205,230` · `src/app/api/export/poliza/route.ts:170,354-369` · `src/lib/likida/cuadre/engine.ts:1636` · `src/lib/likida/revision_recalculo.ts:16-21` · `supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:227-237`

Qué SÍ cerró el commit `d914e74`: `revisar_liquidacion(… 'ajustar')` ya no mueve
el total por una delta; exige `p_recalculo` (LR021), lo cuadra contra la delta
(LR020) y sustituye `diferencia`, `estatus`, `diferencias`,
`ieps/iva/peaje_acreditable` y `litros_diesel_acreditables` con lo que devolvió
el motor (`0306:227-237`). Verificado, y con prueba (bloque 251).

Qué NO cerró: el recálculo lo produce el MISMO motor, y el motor deriva
`ivaAcreditable` de `g.ivaTraslado` —el importe leído del XML—, no de `g.monto`
(`engine.ts:1636`). La decisión está escrita y es deliberada:
`sub_total`/`iva_traslado`/`ieps_traslado` «son el HECHO del CFDI y no se tocan»
(`revision_recalculo.ts:16-21`, y el mismo párrafo en `0306:32-40`). Correcto
como decisión fiscal — y exactamente por eso la póliza queda descuadrada, porque
`poliza.ts` deriva su residuo de una identidad que mezcla las dos cosas:

- `comprobado = anticipo − diferencia` (`poliza.ts:205`) → **sí se mueve** con el ajuste;
- `subtotalDeclarado` = suma de `porConcepto[].subtotal` (`poliza.ts:203-204`), que sale de `montoBase = g.subTotal − g.descuento` (`route.ts:170`), o sea `gasto.sub_total` crudo → **no se mueve**;
- `liq.ivaAcreditable` = `liquidacion.iva_acreditable`, ahora recalculado… **al mismo valor de antes** → no se mueve;
- `impuestoNoAcreditado = comprobado + retenciones − subtotalDeclarado − ivaAcreditable` (`poliza.ts:230`).

Escenario con valores, V-119, anticipo $10,000, los dos comprobantes con XML
(que es la única población que llega a la póliza: `route.ts:333-340` bloquea
cualquier liquidación en la que algún gasto traiga `sub_total` nulo):

- diésel: `sub_total` 6,896.55, `iva_traslado` 1,103.45, `monto` 8,000
- caseta: `sub_total` 1,724.14, `iva_traslado` 275.86, `monto` 2,000
- hoy cuadra: 10,000 − 8,620.69 − 1,379.31 = 0.

**A la baja** (el CFDI de diésel era el consumo del mes; el de este viaje eran
$800): firma «ajustar» 8,000 → 800. El motor devuelve `totalComprobado` 2,800 y
`diferencia` 7,200; `ivaAcreditable` vuelve 1,379.31 porque ningún
`iva_traslado` cambió. La póliza calcula 2,800 − 8,620.69 − 1,379.31 =
**−7,200** → `poliza.ts:249-259` empuja «la póliza no cuadra… revisar la
liquidación a mano», `route.ts:354` lo mete a `bloqueos` y la ruta contesta
**409 `polizas_incompletas` tirando el periodo ENTERO** (`route.ts:357-369`).

**Al alza** (el caso canónico del feature, WA-3: el OCR leyó $800 de un
comprobante de $8,000 que sí trae CFDI, `sub_total` 689.66 / `iva` 110.34):
`impuestoNoAcreditado` = 10,000 − 2,413.80 − 386.20 = **+7,200** →
`poliza.ts:239-248` agrega el movimiento «IVA/IEPS no acreditable — viaje V-119»
por $7,200 a la cuenta del catálogo, y el archivo ContPAQi sale 200.

Consecuencia: el contador de la flota importa un asiento con un impuesto de
$7,200 que no existe en ningún CFDI, o no puede exportar el mes y el mensaje le
dice que el dato de origen está roto — sin que nada nombre al ajuste que la
propia app le ofreció. Es la regla «nunca inventar una cifra» rota en el
artefacto que va al ERP del cliente.

Causa raíz probable: el arreglo movió la frontera al desglose de la
LIQUIDACIÓN y dejó intacto el desglose por COMPROBANTE, que es de donde la
póliza saca dos de los tres términos de su resta; nadie volvió a `poliza.ts`
después de la 0306.

Prueba que lo cubra: **ninguna**. `grep -rn "ajust" src/lib/likida/contabilidad/*.test.ts
src/app/api/export/poliza/*.test.ts` → 0 resultados; el bloque 251 de
`verificaciones.sql:17182-17277` prueba LR020/LR021 y la sustitución del
desglose, y nunca llama a `poliza_datos_tenant` después de ajustar.

### [ALTO] Si la subida del PDF del contralor falla y la del operador no, los dos ejemplares de la misma liquidación quedan con cifras distintas — y nadie se entera

`src/lib/likida/revision_recalculo.ts:186-197` · `src/lib/likida/revision.ts:492-501` · `src/app/dashboard/[id]/page.tsx:242-247` · `src/lib/likida/processor.ts:1056`

`regenerarPdfTrasAjuste` imprime y sube los dos ejemplares en un `Promise.all`
(`:188-191`) y **solo después** mira el resultado: si el del contralor no subió,
`return { regenerado: false }` en `:193-197` — sin deshacer el del operador, que
ya se sobrescribió en la ruta canónica `${tenant}/${viaje}-operador.pdf`, y sin
tocar `pdf_url` ni los sellos de entrega.

Entra: ajuste firmado de $800 → $8,000 sobre V-119; `subir()` del contralor
devuelve `false` por un 5xx transitorio de Storage (`:119`), el del operador
devuelve `true`. Sale mal: `${tenant}/${viaje}.pdf` —el que sirve
`/api/export/pdf/[id]` leyendo `pdf_url`— sigue diciendo **$800**, y
`${tenant}/${viaje}-operador.pdf` —el que `entregarCierrePendiente` le manda al
chofer (`processor.ts:1056`)— dice **$8,000**. Los dos ejemplares de la misma
liquidación se contradicen.

Y la persona no se entera por ningún lado: `ResultadoRevision` no lleva el
`regenerado`, el único rastro es `logger.warn('revision.pdf_no_regenerado')`
(`revision.ts:499`) —que no dispara `alertarOperador`—, y la pantalla contesta
«F-119: se corrigió 1 comprobante. El comprobado quedó en $8,000.00…»
(`page.tsx:242-247`), con el enlace al PDF pintado como siempre.

Consecuencia: el contralor descarga y le manda a su contador un papel con la
cifra que él mismo acaba de corregir, mientras el chofer tiene el otro número;
es la falla que la 24 y la 25 llamaron CRÍTICA, confinada ahora al camino de
error pero **silenciosa**, que es la definición de ALTO en esta tabla.

Causa raíz probable: `regenerado` se diseñó como valor de retorno para el log y
no como parte del acuse a la persona, y las dos subidas se lanzan juntas sin que
el fallo de una condicione a la otra.

Prueba que lo cubra: existe una que fija el comportamiento —
`revision.test.ts:332-342` («un PDF que no se pudo regenerar no tumba el ajuste
— se dice, no se revierte») afirma solo `r.revision === 'ajustada'`; el «se
dice» no se comprueba porque no ocurre. `revision_recalculo.test.ts:177-189`
cubre el `regenerado:false` del contralor, y no mira qué pasó con el ejemplar
del operador.

### [MEDIO] LR019 apunta al comprobante equivocado: bloquea el original (que sí cuenta) y deja pasar la copia (que no), y esa acaba en un LR020 que dice «vuelve a intentar» y nunca funciona

`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:200-207` (con `:218-225`) · `src/lib/likida/cuadre/engine.ts:641-643,1188-1200` · `src/app/dashboard/[id]/page.tsx:279-282`

La guardia LR019 busca en `liquidacion.diferencias` una entrada de tipo
`duplicado` cuyo `gastoId` sea el que se quiere ajustar (`0306:200-203`). Pero el
motor emite esa diferencia con **`gastoId: originalId`** (`engine.ts:1198`) —el
id de la PRIMERA aparición— mientras que del total se excluyen las COPIAS
(`engine.ts:641-643`, `duplicados` es el conjunto de las copias). La guardia
señala justo la fila contraria a la que describe.

Entra: V-207, el chofer manda dos veces el mismo ticket de diésel (mismo
`concepto`, mismo `folioNorm`, mismo monto 8,000, sin CFDI). El motor deja la
segunda fuera del total y anota `{tipo:'duplicado', gastoId: <id de la
PRIMERA>}`. El contralor ve que el ticket real decía $800 y ajusta:

- si ajusta **el original** (el que sí suma al comprobado): LR019 rebota con «el
  comprobante X está fuera del total (duplicado o monto inválido): no se ajusta,
  se rechaza la liquidación» — **falso sobre esa fila**;
- si ajusta **la copia** (la única que el rebote quería proteger): pasa LR019,
  `update gasto set monto = 800`, delta −7,200; el motor recalcula y ahora las
  dos filas tienen montos distintos, dejan de ser copias y el total sube a
  8,800, contra el `v_liq.total_comprobado + v_delta` = 800 que exige LR020
  (`0306:218-225`) → excepción «algo cambió los gastos de este viaje entre el
  cálculo y el guardado — vuelve a intentar». Determinista: **el reintento nunca
  va a funcionar**.

La pantalla ofrece las dos filas por igual (`page.tsx:279-282` filtra solo por
tener `id`).

Consecuencia: sobre una liquidación con un comprobante duplicado —el escenario
más común de una ráfaga de WhatsApp— la corrección del contralor es
inalcanzable por las dos puertas, y el mensaje que recibe le miente en las dos:
una le dice que la fila está fuera del total cuando está dentro, la otra le pide
reintentar algo que no depende del tiempo. Le queda «rechazar», sin que nada se
lo diga.

Causa raíz probable: LR019 se escribió leyendo la lista de `diferencias` como si
`gastoId` señalara al gasto EXCLUIDO, y en el tipo `duplicado` señala al que
sobrevive.

Prueba que lo cubra: **ninguna**. `verificaciones.sql` no ejercita LR019 (`grep
LR019` → 0), y el bloque 251 solo prueba LR020 con un desajuste fabricado a
mano, no con el que produce este camino real.

### [MEDIO] El único camino del bucle de la cadena del webhook que NO corta es el que no sabe qué pasó con el mensaje anterior

`src/app/api/webhook/whatsapp/route.ts:438-442` (contra `:390`, `:420`, `:425`, `:434`)

Dentro de `after()`, los mensajes de un mismo chofer se procesan **en serie y en
orden** a propósito, y todas las salidas anómalas cortan la cadena: claim
perdido → `break` (`:390`), pospuesto → `break` (`:420`), sello «fenced» →
`break` (`:425`), `processInbound` que lanza → `break` (`:434`). El `catch`
exterior de `:438-442` —el de «ni el claim se pudo leer», que es el ÚNICO caso
en el que no consta nada sobre el mensaje anterior— solo hace
`logger.error('wa.claim_fallo')` y **sigue con el siguiente**.

Entra: el chofer manda una nota de voz («la talacha fueron 800, se me ponchó una
llanta») y enseguida «listo». Las dos filas se persisten; `reclamarPendiente` de
la nota de voz lanza porque `acotada` corta la RPC a los 8 s (Supabase
degradado). Sale: el bucle no corta, reclama el «listo» y `processInbound` cierra
el viaje sin la incidencia. La nota se queda pendiente y el cron la retoma
minutos después, cuando el viaje ya está `liquidado`.

Está parcialmente cubierto y hay que decirlo: la guardia AGEN-6
(`processor.ts:3653`) pregunta antes de cerrar si hay una **foto** anterior sin
procesar, así que la cadena `[foto, listo]` sí se salva. La consulta filtra
`evento->>type = 'image'` (`conv.ts:958`), de modo que un audio, un texto o un
botón anteriores al «listo» no entran.

Consecuencia: un cierre sobre datos incompletos —justo lo que el agrupamiento
por chofer se escribió para impedir— disparado por un blip de la base, y con la
liquidación ya irreversible (0036/0300 rebotan el gasto tardío con CU001).

Causa raíz probable: el `catch` se escribió pensando en «no tumbar el pool» y
quedó fuera del razonamiento de orden que sí gobierna los otros cuatro
`break`.

Prueba que lo cubra: no encontré ninguna que fuerce a `reclamarPendiente` a
lanzar dentro de una cadena de dos mensajes; el drenado del cron
(`cron/wa-pendientes/drenado.ts:95-102`) tiene el mismo bucle y ahí el `throw`
sí sale del worker en vez de continuar.

### [BAJO · REINCIDENTE de la 24 y la 25] La sonda de OCR del panel no registra el costo cuando aborta, y el tope diario no lo ve

`src/app/api/dashboard/ingesta/route.ts:98,101,124-127`

Sin cambios desde la 24: `extraerComprobante` corre con
`AbortSignal.timeout(45_000)` (`:98`) y `registrarCosto` está DESPUÉS (`:101`),
así que el `catch` de `:124-127` contesta 502 sin registrar un gasto de IA que ya
ocurrió, y `gastoSondaHoyUsd` (`:87`) no lo ve. Entra: diez sondas seguidas que
abortan a los 45 s → sale: `$0.00` gastados según el tope, y el tablero de costo
de IA de `/admin` cuenta menos de lo que se pagó. `processor.ts:3929-3936` sí
registra el costo del `PartialExecutionError` antes de decidir nada; esta ruta
no.

### [BAJO] `sincronizar_gps` reporta como «guardadas» las filas que mandó, no las que el upsert insertó

`src/lib/likida/conectores/sincronizar_gps.ts:226-237` · `src/app/api/cron/gps/route.ts:97,118,166`

El upsert lleva `ignoreDuplicates: true` sobre `(tenant_id, unidad_id,
medida_en)` (`:229`) y el conteo suma `tanda.length` (`:237`, vía el `ok` del
pool). Entra: 200 unidades paradas cuya última posición es la misma que la
corrida anterior → sale `guardadas: 200` habiendo insertado 0, y esa cifra viaja
al JSON del cron (`route.ts:118`) y al latido `gps` (`route.ts:166`), que es
justo lo que alguien mira para decidir si la fuente de GPS está entrando. Es el
mismo patrón que `b609b22` acaba de arreglar en `marcarExportadas` con
`.select('id')`, en el módulo de al lado.

## Lo que revisé y está bien

**Los nueve abiertos que SÍ se cerraron** (abrí el archivo, no el diff):

- `382365e` — `conv.ts:865-887`: la segunda llamada del fallback distingue «la
  otra firma tampoco existe» (abre, como siempre) de un error transitorio, que
  ahora reintenta y termina en `'indeterminado'` (`:872-885`). El fail-open que
  la 24 y la 25 reportaron ya no existe; `conv_lock_dueno_aud24.test.ts` cubre
  el cuarto caso (corrido: verde).
- `670a348` — `relojes_legales.ts:346-351`: `flotaDeclaraHazmat` lanza ante
  `error` y el `try/catch` del barrido lo cuenta como `fallo` (`:225-232`) en vez
  de sellar `sin_relojes_aplicables`. El reloj legal ya no se apaga por un blip.
- `893e347` — `suscripcion.ts:955-961`: la anulación sin fila **sí sella el
  orden** antes de `return 'sin_factura'`, así que el `invoice.paid` reentregado
  después se descarta por `:857-864`. Los otros dos returns tempranos
  (`'ya_cancelada'`, `'parcial'`) no sellan, y en los dos casos es correcto: el
  primero ya tiene sello de la anulación que lo dejó cancelado, el segundo no
  anula nada.
- `5b80e6a` — `suscripcion.ts:723`: el segundo write (`tenant.plan`) **lanza**;
  el webhook contesta 500 y Stripe reintenta, con el razonamiento de por qué el
  reintento es seguro escrito arriba. `suscripcion_tenant_plan.test.ts` lo fija
  (corrido: verde).
- `bcb766b` — `chat/tenant.ts:71-82`: la validación se movió al final, sobre el
  `tenantId` que de verdad se devuelve; la rama del `?tenant=` que no encuentra
  fila cae ahí y también se verifica. Ya no hay gemela abierta.
- `b2cd1a2` — `0307:119` (`and l.revision <> 'rechazada'` en
  `poliza_datos_tenant`) y `:135` (el trigger de reasignación). Con su bloque 252
  de `verificaciones.sql` contra Postgres real, que además prueba que una
  `pendiente` SÍ sigue entrando.
- `9ed7e78` — `cron/wa-outbox/route.ts:117-131`: el 200 de Meta sin `wamid` se
  sella como enviado con el marcador `sin_wamid:<id>` (que no puede confundirse
  con un wamid real) en vez de reencolar un mensaje que ya salió.
- `b609b22` — `proveedores.ts:516-529`: el `update` lleva `.select('id')` y se
  cuenta `data.length`.
- `62840b3` — `mcp/oauth.ts:385-400`: si `emitirPar` falla, el código se
  destraba **solo si sigue trayendo nuestro sello** (`.eq('usado_en', selloUso)`),
  así que un canje que ganó la carrera en medio no se pisa.

**La mitad buena de la 0306** (el CRÍTICO de arriba es la otra): la RPC exige el
recálculo (LR021), lo cuadra al centavo contra la delta que ella misma aplicó
(LR020, `:218-225`) y **no deja nada movido cuando rebota** —es una sola
transacción, y el bloque 251 lo asevera contra Postgres real—; la firma vieja de
7 argumentos se DROPEA antes del `create or replace` (`:83`), que es la lección
de la 0158 aplicada; `agregar_pdf_historial` empuja con `jsonb ||` en vez de un
read-modify-write en TS; y `revision.ts:435-445` no llama a la RPC si el motor
no pudo recalcular.

**El claim de autofactura** (`facturacion/al_vuelo.ts:820-852`): el UPDATE
condicional (`.is('cfdi_uuid', null)`, `.is('autofactura_bloqueada_en', null)`,
`autofactura_intentada_en` nulo o vencido) con `.select('id')` es la carrera
resuelta por Postgres, falla CERRADO ante error (`:844-850`), y la marca de
«emisión en curso» se pone ANTES de abrir el portal y solo se levanta con el
UUID ya escrito (`:660-698`, `:310-314`). El TTL del claim (10 min) está
razonado contra el cron de 15 min.

**La idempotencia de /v1** (`api/v1/_escritura.ts:705-793`): tres capas en el
orden correcto (memoria → recuerdo durable → llave natural), huella sobre el
cuerpo YA normalizado —así un `tenant_id` colado no puede cambiarla—, misma
llave con otro contenido → 400 explícito, folio ocupado con otro contenido → 409
en vez del 200 silencioso de antes, y la carrera contra el unique se resuelve
releyendo (`:775-782`). Las dos funciones de la capa durable no lanzan y
explican por qué (`:464-536`).

**El dinero del portal de pago**: `registrarPago` va entero por
`registrar_pago_tx` con la factura `for update` y el 23505 de
`pago_recibido_propuesta_unica` sale como `AbonoYaRegistrado`, nunca como un
segundo abono (`facturacion_escritura.ts:567-628`); `cancelarFactura` cuenta y
cancela dentro de `cancelar_factura_tx` y revoca las ligas DESPUÉS, lanzando si
no pudo (`:672-706`); `marcarEmitida` está anclada a `estatus = 'borrador'` con
`.select('id')` y dice cuántas filas tocó (`:478-492`). `/api/pago/registrar` no
tiene camino hacia `pago_recibido` y lo declara.

**El webhook de WhatsApp, salvo el `catch` que reporté**: persistir ANTES del
acuse con 503 si no se pudo (`route.ts:249-262`), dedup antes de cobrar cupo
(`:202-221`), 429 con `Retry-After` mientras quede algo diferido (`:507-512`),
pool acotado por la razón medida (`:47-72`), y el sello solo para lo que de
verdad terminó (`quedoPendiente`, `:85-87`).

**`marcarEmisionEnCurso`/`escribirUuid`**: un fallo al guardar el UUID no se
traga ni se reintenta — bloquea el ticket con el motivo escrito para una persona
y distingue CU001 de la violación de `uq_gasto_cfdi_uuid`
(`al_vuelo.ts:596-625`).

## Lo que NO alcancé a revisar

- `src/middleware.ts` **sigue sin existir** (`find . -name "middleware.*" -not
  -path "*/node_modules/*"` → vacío). El rubro lo lista como superficie mía por
  segunda ronda seguida; si la puerta vive en `requireSessionTenant` /
  `v1/_comun.ts`, el mapa está desactualizado y alguien puede creer que hay un
  middleware revisando lo que no revisa nadie.
- `src/app/api/cron/{descarga-sat,jornada,asistencia,portales-vivos,runner,escalar}`
  — tercera ronda sin abrirlos.
- `src/app/api/admin/qa/*` (BE-26/BE-27 de la 22 siguen sin verificar) y
  `admin/{copiloto,mapa-prospectos,palette}`; de `worker/bus/[accion]` solo leí
  el claim y el cierre de corrida, no `lib/worker/llaves.ts`.
- `src/app/api/correo/{entrante,eventos,baja}` y `auth/correo` — confié en lo que
  la 25 verificó de `entrante`; los otros tres no los abrí.
- `facturarLoteConAgente` y los adaptadores de portal (`guion.ts`,
  `playwright_base.ts`): leí el contrato de `emisionSinConfirmar` desde
  `al_vuelo.ts`, no su implementación.
- `duplicados.ts` sí lo releí entero (es cross-viaje y está correcto);
  `pg_errores.ts` no lo abrí en esta ronda.
- No corrí `verificaciones.sql`: no hay Postgres aquí. Cada vez que digo que un
  bloque prueba algo, es lectura del bloque, no una corrida. Lo que sí corrí es
  `npx vitest run` sobre los cinco archivos que nombro arriba (52 casos, verdes).
