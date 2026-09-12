# Backend y API — auditoría 30

**Nota: 7/10** (antes 6). Razón del movimiento: **se atacó y subió**. BE-3 —los
seis agregados que sumaban dinero de liquidaciones rechazadas, el reincidente de
3ª ronda que era la razón escrita del tope de la 29— **cerró de verdad**: abrí
las seis definiciones de `0348`, el `supabase/tests/0348_*.sql` que las
acompaña y los seis llamadores TS, y el test SQL **sí contiene el caso que hace
divergir la función vieja de la nueva** (una rechazada de $9,000 con
`diferencia = 500` en el mismo día y semana que las vigentes: revertir cualquiera
de los seis `WHERE` pone en rojo un `raise exception` distinto). El arreglo de
`e2038a5` (keyset por cursor) también viene con prueba RED→GREEN real. **No sube
a 8** porque tres de los cinco hallazgos de la 29 siguen idénticos —dos de ellos
ALTO— y porque la superficie que la 29 declaró sin revisar trajo un camino nuevo
donde el dinero se revierte solo y la única prueba que lo toca bendice la mitad
inofensiva.

**El riesgo mayor del rubro, hoy:** la guardia de orden de eventos de Stripe es
una LECTURA, no una escritura condicional, y **falla abierta** — si esa lectura
se cae, un `invoice.payment_failed` viejo marca `fallida` una mensualidad que ya
se cobró, y deja el sello de orden envenenado con la marca del evento viejo.

---

## Estado de los hallazgos abiertos de la 29

| # | Hallazgo de la 29 | Veredicto |
|---|---|---|
| BE-A1 | `pdfEstadoDe` sella «encolado» un rechazo que nunca se encoló | **REINCIDENTE**, idéntico |
| BE-A2 (=BE-3) | Seis agregados suman liquidaciones rechazadas | **CERRADO** con prueba que lo ancla |
| BE-A3 | El corte por presupuesto de `ingerirRep` no deja marcador | **REINCIDENTE**, idéntico |
| BE-M1 | URL firmada de 15 min dentro de una cola de ~63 min | **REINCIDENTE**, idéntico |
| BE-B1 | Doce cartas muertas ⇒ doce mensajes al chofer | **REINCIDENTE**, idéntico |

### BE-3 — dictamen pedido explícitamente: **CERRADO**, y sin agregados fuera

Lo verifiqué en cuatro planos, no por el asunto del commit:

1. **La migración cubre las seis, y solo esas seis.**
   `supabase/migrations/0348_analytics_sin_rechazadas_2.sql` reescribe
   `liquidaciones_por_dia_tenant` (`:19`), `liquidado_semanal_tenant` (`:34`),
   `operadores_detalle_tenant` (`:51`), `rentabilidad_tenant` (`:92`),
   `serie_comparativa_tenant` (`:137`) y `stats_operador_tenant` (`:180`) —
   exactamente la lista del hallazgo. Cada una añade `revision <> 'rechazada'`
   **solo** sobre `liquidacion`, y deja intactas las columnas que vienen de
   `viaje` (`viajes`, `anticipoTotal`, `ingreso`), que es lo correcto.
2. **El test SQL ejercita la divergencia, no el camino feliz.**
   `supabase/tests/0348_analytics_sin_rechazadas_2.sql:14-21` siembra tres
   liquidaciones del mismo día (aprobada 980, **rechazada 8500 con
   `diferencia=500`**, ajustada 500) y afirma `n=2`, `total=1480`,
   `comprobadoTotal=1480`, `costoComprobado=1480`, `liquidado=1480`,
   `diferencias=1`. Sin el `WHERE` esos seis valores serían 3, 9980, 9980, 9980,
   9980 y 2: **cada assert cae por separado**. Además comprueba que las columnas
   de `viaje` NO se movieron (`viajes=3`, `anticipoTotal=900`, `ingreso=2000`) y
   que leer no mutó el historial.
3. **Los seis llamadores TS pasan por la RPC**, no por una reimplementación:
   `analytics.ts:438`, `:626`, `:1273`, `:369`, `:147` y `comercial.ts:250`.
4. **Los dos espejos JS que bendecían el defecto están corregidos**:
   `espejo_0152.pruebas.ts:77` (`&& x.revision !== 'rechazada'`) y
   `analytics_rpc_0150.fixture.ts:181,202,231,280`.

**Salvedad honesta, que le toca a `datos`/`pruebas`, no a mí:** el fixture TS
avisa en `analytics_rpc_0150.fixture.ts:251-256` que «ninguna fila de este
archivo pone `revision`, así que hoy es un no-op» — la equivalencia TS↔SQL no
ejercita el filtro. Quien lo ancla es el test SQL, que aquí no se puede correr
(no hay Postgres). Lo doy por cerrado sobre la lectura del SQL, no sobre su
ejecución.

**Lo que NO cerró es la clase.** La misma cifra sigue saliendo sin filtrar por
otro camino, en `libro_viaje` — ver el primer hallazgo. Sigue sin existir un
predicado compartido: se arregló la lista del hallazgo, no la causa.

---

## Hallazgos

### [ALTO] La guardia de orden de Stripe falla ABIERTA: una lectura caída revierte a «fallida» una mensualidad ya cobrada, y envenena el sello

`src/lib/saas/suscripcion.ts:787-796` (`ordenAplicado`) ·
`:859-868` (la guardia de `aplicarFactura`) · `:875-901` (el upsert que fija
`estado`) · `:800-813` (`sellarOrden`, upsert incondicional) ·
`src/lib/saas/factura_orden.test.ts:143-149` (la prueba que bendice solo la
mitad inofensiva).

**Escenario, con valores.** Flota «Transportes del Bajío», invoice
`in_1QabcXYZ`, mensualidad de **$14,500 MXN**.

1. 10:02:00 Stripe emite `invoice.payment_failed` (`created = 1_757_000_520`).
   La entrega rebota (un 500 nuestro) y Stripe la reprograma.
2. 10:20:07 llega `invoice.paid` (`created = 1_757_001_607`). Se aplica:
   `factura_saas.estado = 'pagada'`, `pagada_en = 2026-09-04T16:20:07Z`, y
   `sellarOrden` graba `orden:in_1QabcXYZ → {created: 1_757_001_607}`.
3. 13:40 Stripe reintenta el `payment_failed` de las 10:02. En ese instante la
   lectura de `evento_stripe` devuelve `{error:'fetch failed'}` (pooler
   saturado, la clase de bache que el propio repo documenta en todos lados).
4. `ordenAplicado:790-793` **loguea `warn` y devuelve `null`**. `:861`
   (`ultimo !== null && ...`) es falso ⇒ **la guardia no se aplica**.
5. El upsert de `:875` escribe `estado: 'fallida'`, `pagada_en: null` sobre el
   cobro real. Después `:907` llama `sellarOrden(..., 1_757_000_520, ...)`, que
   **no compara nada**: el sello queda con el `created` del evento VIEJO.
6. A partir de ahí la guardia está invertida: el siguiente reintento del
   `invoice.paid` (created 1_757_001_607 > 1_757_000_520) sí pasa, pero
   cualquier reentrega intermedia vuelve a poder revertirla.

**Consecuencia.** El portal del cliente y la pantalla de cobranza vuelven a
pedir $14,500 ya pagados, y la flota queda «morosa» — exactamente el modo de
falla que el comentario BACK-C4-1 de `:844-849` dice haber cerrado. Nadie se
entera: el único rastro es un `logger.warn('stripe.orden_ilegible')`.

**El mismo camino, sin fallo de lectura, por concurrencia.** La guardia es
`read` → `upsert` sin `if_version` ni `WHERE` condicional. Stripe no serializa
entregas: si el `payment_failed` de las 10:02 y el `paid` de las 10:20 llegan
con 150 ms de diferencia, los dos leen el sello (`null`), los dos pasan, y el
último `upsert` en commitear fija el estado. No hay lock, no hay
`.eq('estado', …)` de ancla, no hay `evento_stripe` tomado como llave.

**Prueba que lo cubra: ninguna, y la que hay cubre la dirección opuesta.**
`factura_orden.test.ts:143` («si la marca no se puede LEER, en la duda se
aplica») monta `errorLectura` y corre `aplicarFactura(factura(**true**, …))` —
el `invoice.paid`, donde aplicar en la duda es correcto. El caso destructivo
(`factura(false, …)` con la marca ilegible) no existe en ningún archivo. Lo
mismo en `suscripcion_orden.test.ts:122` para `aplicarSuscripcion`, que comparte
`ordenAplicado` y cuyo caso destructivo es un `customer.subscription.deleted`
reentregado.

**Causa raíz probable.** «En la duda se aplica» se razonó para una sola de las
dos direcciones y se implementó para las dos; y el orden se guarda en una fila
aparte que se lee y se pisa, en vez de ser una condición del propio write.

---

### [ALTO · REINCIDENTE] `pdfEstadoDe` sigue sellando «encolado» un rechazo que nunca se encoló

`src/lib/likida/avisar_cierre.ts:115` · `src/lib/meta/client.ts:566-571` ·
`:153-158` (`errorDeMeta`) · `:195-199` (`esReintentableMeta`) ·
`src/lib/likida/processor.ts:1192-1199` (chofer) · `:4912-4926` (contralor).

**Verificado hoy, línea por línea: cero cambios.** `avisar_cierre.ts:115` sigue
siendo `if (r.codigo === undefined) return 'encolado';` y
`client.ts:569-571` sigue devolviendo `{ok:false, error, codigo}` **sin
encolar** cuando `esReintentableMeta(codigo, res.status)` es falso.

**Escenario, con valores.** Viaje `F-1042`, cierre 10:00,
`pdf_url = 't-1/F-1042.pdf'`. El borde de Meta contesta **HTTP 403 con cuerpo
HTML** (bloqueo de WAF/IP). `errorDeMeta` (`:153-158`) no puede hacer
`JSON.parse` ⇒ devuelve `{}` ⇒ `codigo = undefined`.
`esReintentableMeta(undefined, 403)` = `false` (`:195-199` solo acepta 429 o
≥500) ⇒ **`encolarSalidaWhatsApp` no se llama**. Vuelve
`{ok:false, error:'HTTP 403', codigo: undefined}` ⇒ `pdfEstadoDe` dice
`'encolado'` ⇒ `processor.ts:1197` sella `entregada_operador_en` con
`logger.info('pdf.encolado')` — ni `warn`, ni `alertarOperador`.

**Consecuencia.** El PDF no está en Meta, no está en `wa_outbox`, y el sello es
justo lo que apaga el reintento (`processor.ts:2286-2289` contesta
`MENSAJE_CIERRE_YA_ENTREGADO` al siguiente mensaje del chofer). El chofer y el
contralor se quedan sin ejemplar mientras la base afirma que se entregó.

**Causa raíz probable.** `sendDocument` no devuelve **si encoló**; `pdfEstadoDe`
lo infiere del `codigo` y nunca ve el `status`, que es con lo que
`esReintentableMeta` decidió de verdad.

---

### [ALTO · REINCIDENTE] `ingerirRep` sigue cortando por presupuesto sin marcador: un complemento grande no termina de ingerirse NUNCA

`src/lib/likida/intake/rep.ts:207-216` (el corte) · `:221-231` (el upsert que
vuelve a pagar lo ya hecho) · `:246-251` y `:260-262` (la segunda pasada, *más
cara por docto* que la primera) · `:288` (lo que se le promete al chofer).

**Verificado hoy: cero cambios.** El bucle sigue arrancando siempre en
`rep.pagos[0].doctos[0]` (`:207-209`); no hay lectura previa de
`cfdi_pago(cfdi_uuid, docto_relacionado_uuid)` ni índice de corte guardado.

**Escenario, con valores (los de la propia prueba del repo).** REP consolidado
de un proveedor de diésel con **150 documentos relacionados**,
`finPresupuesto = ahora + 57 s`. Primera entrega: corta antes del docto #64 ⇒
`{doctos: 63, pendientes: 87}` (el caso fijado en `intake/rep.test.ts:244-258`).
El correo contesta 503 para que Resend reintente; la segunda pasada reprocesa
los 63 primeros —cada uno con su `upsert` de red y, para los ya sellados, la
consulta extra de `:260-262`— y corta en el mismo punto o antes. Los 87 no
entran nunca. Por WhatsApp es peor: `:288` le promete al chofer «reenvía el
mismo complemento para que termine», y reenviarlo produce el mismo corte.

**Consecuencia.** El IVA de esas 87 facturas nunca se sella `gasto.pagado_en`,
así que no se acredita en el mes del pago (LIVA 5-III). El único rastro es un
`logger.info` con `pendientes: 87` y un 503 que se lee como «se cayó la red».

**Prueba que lo cubra: ninguna, y la que hay documenta el defecto.**
`intake/rep.test.ts:265-284` corre la segunda pasada **sin `venceEn`** y afirma
`expect(upsert).toHaveBeenCalledTimes(150)`. No existe una prueba de dos pasadas
*con* presupuesto donde la segunda avance más que la primera.

---

### [MEDIO] El margen por viaje de `/v1` y del copiloto se calcula con el costo que el contralor RECHAZÓ — el mismo defecto que la 0348 acaba de cerrar, un nivel más abajo

`src/lib/likida/libro_viaje.ts:590` (la lectura, sin `revision` en el `select`
ni en el filtro) · `:501` (`comprobado`) · `:525` (`falta`) ·
`src/app/api/v1/viajes/[id]/contribucion/route.ts:86,96-98` ·
`src/app/api/v1/viajes/[id]/route.ts:66` ·
`src/lib/mcp/herramientas/dinero.ts:39-40,81`.

**Escenario, con valores.** Viaje `F-1042`, `ingreso_flete = $20,000`.
Liquidación cerrada con `total_comprobado = $18,500`; el contralor la
**rechaza** (`revision = 'rechazada'`, el viaje vuelve a `en_cuadre`, 0306:252).

- `getLibroViaje` lee la liquidación **sin pedir `revision`**
  (`libro_viaje.ts:590` selecciona `id, total_comprobado, diferencias`), así que
  `armarRenglon` no tiene con qué distinguirla: `comprobado = 18500`,
  `contribucion = 1500`, `margenPct = 7.5`, y
  `faltaParaLaContribucion(20000, 18500)` devuelve **`null`** (`:525`) — «no
  falta nada».
- `GET /v1/viajes/F-1042/contribucion` contesta
  `{"comprobado":18500,"contribucion":1500,"margenPct":7.5,"falta":null,"estatus":"en_cuadre"}`.
- El copiloto, por MCP, imprime «• Contribución: $1,500.00 (margen 7.5 %)»
  (`dinero.ts:39-40`).
- La **misma flota**, en la **misma sesión**, ve `rentabilidad_tenant` ya
  corregida por la 0348: ese viaje aporta $0 de costo comprobado. Dos cifras del
  mismo hecho, en dos superficies del mismo producto.

**Consecuencia.** La ruta está gateada por área `dinero` y su cabecera promete
que `falta` «distingue "falta el ingreso" de "falta cerrar la liquidación"»
(`route.ts:20-22`): un TMS integrado grafica el margen de un viaje cuyo cuadre
el contralor invalidó, y el campo que existe para avisarlo dice que no falta
nada. Es la clase de cifra que el contralor cruza contra su PDF y no cuadra.

**Prueba que lo cubra: ninguna.** `grep revision` sobre
`src/lib/likida/libro_viaje.test.ts` y
`src/app/api/v1/viajes/[id]/contribucion/route.test.ts` no devuelve una sola
línea: `revision` no aparece en ninguno de los dos archivos.

**Causa raíz probable.** La misma que BE-3 y por eso es su mutación: no existe
un predicado compartido de «liquidación vigente»; la 0348 arregló la lista de
seis RPC del hallazgo anterior, y este camino nunca estuvo en esa lista.

---

### [MEDIO] El keyset nuevo (`traerTodoDesdeId`) pierde la ÚLTIMA fila cuando el corte por `count` cae en frontera de página — y el `LecturaIncompleta` no se entera

`src/lib/likida/pg.ts:267` (`if (esperadas !== null && filas.length >= esperadas) return filas;`,
antes de comprobar si la página venía llena) · `:274` (el avance del cursor) ·
`src/lib/likida/intake/consolidado.ts:342-356` (`candidatosDeGasto`) ·
`src/lib/likida/pg.test.ts` (la prueba del insert concurrente, comentario
«sobrar no es el fallo que se persigue, faltar sí»).

**Escenario, con valores. Lo simulé con la lógica exacta de `:259-275` y la
tabla viva de la propia prueba, no lo deduje:** tenant con **exactamente 2,000**
gastos sin CFDI en el rango del estado de cuenta, `PAGINA = 1000`.

1. Página 0 (`despuesDe = null`, `count: 'exact'`): 1,000 filas,
   `esperadas = 2000`, `cursor = '00009990'`.
2. Entre página y página el chofer manda una foto por WhatsApp y entra un gasto
   nuevo sin CFDI con `id` **posterior al cursor** (`'00010005'`).
3. Página 1 (`gt('id','00009990')`): PostgREST tiene 1,001 filas que cumplen y
   devuelve las primeras 1,000 — **`'00019990'` se queda fuera**.
4. `filas.length = 2000 >= esperadas = 2000` ⇒ `return filas` en `:267`.

Salida de la simulación: `leidas 2000 · motivo count · FILAS QUE EXISTEN Y NUNCA
SE LEYERON: [ '00019990' ]`. Como `leidas === esperadas`, **`LecturaIncompleta`
no se lanza y no hay `logger.error`**.

**Consecuencia.** Ese gasto no entra al fondo de candidatos que
`conciliarLineas` cruza contra el XML, así que su línea del consolidado sale
`por_conciliar`/`sin_match`: el mismo «fraude aparente por truncamiento» que el
comentario de `consolidado.ts` cita como la razón de paginar, y el gasto se queda
con `cfdi_uuid = null` (IVA no acreditable). Alcance honesto: la pérdida exige
que los inserts concurrentes **posteriores al cursor** superen el relleno hasta
el siguiente múltiplo de página; con un total exacto en múltiplo de 1,000 basta
UNO. Es un borde, no el caso común — por eso MEDIO y no ALTO.

**Prueba que lo cubra: ninguna, y el comentario declara que no se buscó.** La
prueba del insert concurrente lo mete **antes** del cursor (`splice(501, …)`,
valor `'00005005'`), el caso en el que el keyset sí es inmune, y remata: «La
fila nueva … no se exige — sobrar no es el fallo que se persigue, faltar sí».
El insert *después* del cursor —el que hace faltar— no se prueba.

**Nota del mismo archivo, BAJO, no la cuento aparte.** El bloque de página vacía
diverge de `traerTodo` sin decirlo: `pg.ts:268-273` hace `return filas`
**siempre**, mientras `traerTodo:206-213` hace `break` (⇒ lanza) cuando
`esperadas` se conoce y faltan filas. El comportamiento nuevo es defendible
(una fila que salió del filtro ya no es candidata), pero el docblock de
`:245-246` afirma «Mismo contrato de `traerTodo`: … o se LANZA
`LecturaIncompleta` — nunca una cifra parcial», y eso ya no es cierto.

---

### [MEDIO · REINCIDENTE] El sello «encolado» sigue descansando en una URL firmada de 15 min metida en una cola que reintenta hasta ~63 min

`src/lib/likida/processor.ts:1184` (la firma) · `:1307`
(`TTL_FIRMA_PDF_SEGUNDOS = 900`) · `src/lib/meta/client.ts:562` (encola el
payload **con esa misma URL**) · `src/lib/likida/wa_outbox.ts:93`
(`RETRASO_AMBIGUO_SEGUNDOS`) ·
`supabase/migrations/0180_reservas_agente_y_outbox_wa.sql:112-113` (backoff
`15 · 2^intentos`, muerte a los 8) · `src/app/api/cron/wa-outbox/route.ts:51`
(«Solo reintenta la misma carga serializada»).

**Verificado hoy: `TTL_FIRMA_PDF_SEGUNDOS` sigue en 900 y el outbox sigue
reenviando el payload serializado.** Escenario sin cambios: URL firmada a las
10:00:00 (vence 10:15:00), timeout de socket ⇒ encolado con retraso ambiguo ⇒
primer intento 10:05; 429 (`130429`) en ese y los siguientes ⇒ +30 s, +60 s,
+120 s, +240 s… el quinto reintento cae hacia **10:17** con la URL ya caducada y
el fallo deja de ser transitorio. Muere en `dead` y alerta, pero
`entregada_operador_en` se selló a las 10:00 y ningún mensaje posterior del
chofer vuelve a firmar.

**Consecuencia.** Un 429 pasajero se convierte en un PDF perdido para siempre; la
alerta `salida_muerta` habla de «un mensaje de WhatsApp», no de una liquidación
marcada como entregada sin estarlo.

---

### [BAJO] El cron `escalar` pierde `configAusente` cuando además hubo corte duro: el hueco declarado vuelve a leerse como degradación

`src/app/api/cron/escalar/route.ts:418-424`.

**Escenario, con valores.** Corrida de las 14:00 sin `CALCOM_API_KEY`
(`resultado.calcom.configured === false`) y con el reloj duro venciendo con
`relojes` en vuelo (`corteDuro = true`, `huboFallo = false`). El ternario
anidado de `:418-422` evalúa `corteDuro` **primero**, así que el `detalle` queda
`{cortesSeguidos, cortados, corteDuro:'relojes'}` y **`configAusente` no viaja**.
`esHuecoDeConfiguracion()` (health.ts) lee `detalle.configAusente` ⇒
`/api/health` publica `degraded`, no `config_ausente` — el issue #365 que el
commit `15fd8d3` dice cerrar reaparece en cuanto una corrida corta.

**Consecuencia.** El tablero del operador vuelve a mezclar «falta una env var»
con «se rompió algo», que es exactamente lo que OP-C1 pide separar.

**Causa raíz probable.** Los dos hechos son independientes y se codificaron como
ramas excluyentes de un ternario en vez de campos de un mismo objeto.

---

### [BAJO · REINCIDENTE] Doce cartas muertas ⇒ doce mensajes casi idénticos al chofer y doce alertas al operador, en el mismo turno

`src/lib/likida/processor.ts:4101-4125` (el `for` sin tope, con `say` y
`alertarOperador` dentro) · `src/lib/likida/conv.ts:1003` (`.limit(50)`).

**Verificado hoy: sin cambios.** OCR caído media hora, el chofer `5219993700779`
mandó 12 fotos y las 12 llegaron a `intentos = 5`. En su siguiente «listo»,
`muertas.length = 12` ⇒ 12 mensajes idénticos y 12
`alertarOperador('cierre.carta_muerta')`, hasta un tope teórico de 50 por el
`.limit(50)` de la consulta. El aviso en sí es correcto (cerró BE-A3 de la 28);
lo que falta es agrupar.

---

## Lo que revisé y está bien

- **La migración 0348 y su test SQL**, punto por punto arriba. Es el mejor
  trabajo del rubro en esta ventana: firma, owner, `SECURITY INVOKER`,
  estabilidad y forma de respuesta conservadas, `comment on function` con el
  identificador del hallazgo, y un test que **no** ejercita solo el camino feliz.
- **`traerTodoDesdeId` resuelve lo que dice resolver.** Verifiqué el modo de
  falla viejo con la misma simulación: con `traerTodo` y un insert *antes* del
  cursor, `'00009990'` sale **dos veces** y `leidas` termina en 1,201 contra
  `esperadas` 1,200 — duplicación silenciosa en una suma fiscal. Con el cursor,
  cero duplicados. `pg.test.ts` compara los dos lados con la misma tabla viva:
  es prueba RED→GREEN de verdad, no decoración. 62 pruebas verdes en los cuatro
  archivos que corrí.
- **`d0db998` (consolidado ECC a medio conciliar) cerró bien.**
  `sat_descarga/ciclo.ts:315-355`: `yaDescargado` separa «está en la tabla de
  dedup» de «terminó de procesarse», y el `if (yaDescargado) continue;` quedó
  **después** de la rama `consolidado` y **antes** de `casado`. Verifiqué la
  afirmación de la que depende todo —que la decisión `consolidado` no depende de
  `fondo`—: `cruce.ts:102-121` la toma con `tipoComprobante`,
  `estaEnPadronMonederos(rfcEmisor)` y el conteo de líneas `ecc12`, ninguno de
  ellos función de los gastos. Y el `marcar(...'ignorado')` solo corre si
  `!yaDescargado`, así que el reintento no reescribe la bitácora.
- **`/api/stripe/webhook` como puerta** (`route.ts:53-121`): 503 si falta el
  secreto (no hay modo «sin configurar»), firma sobre los bytes exactos antes de
  cualquier parse, 401 con evento de seguridad, coincidencia `livemode` que
  **no** marca el evento (para que quede visible como entrega fallida en el panel
  de Stripe), `marcarEvento` con el insert como carrera y 500 deliberado para que
  Stripe reintente. El `switch` distingue «no nos concierne» (200) de «nos
  concierne y falló» (lanza), con la razón escrita en cada rama.
- **`/api/worker/bus/[accion]`** (`route.ts:74-190`): los tres writes están
  anclados en el `WHERE` y comprobados con `.select()` — `corrida-fin` exige
  `.is('fin', null)`, `ordenes-claim` exige `.eq('estado','pendiente')`,
  `ordenes-resolver` exige seguir `tomada` **y** ser quien la tomó, con la rama
  de compatibilidad para `tomada_por is null` explícita. Un cierre que no aplicó
  contesta `resolvio:false` por valor y loguea, no un 200 a secas.
- **`/api/cron/facturar/cola`** (`route.ts:34-121`): 503 **con latido `fallo`**
  si falta config de QStash, firma verificada sobre el texto exacto con cuerpo
  acotado antes, kill switch con **200** (un 5xx haría que QStash reintentara lo
  apagado), y revalidación de que los gastos siguen sin CFDI antes de procesar.
  El `.in('id', ids)` no puede tocar el recorte de 1,000: `LOTE_POR_FLOTA = 20`.
- **`ejecutarMantenimientoCalcom` dejó de lanzar y `escalar` lo traduce bien en
  el caso normal** (`escalar/route.ts:415-417`): `configAusente` solo se marca si
  `!huboFallo`, así que un fallo real en otro motor no queda enmascarado. El
  único hueco es la combinación con `corteDuro`, arriba.
- **`actualizarFacilidad15`** (`repo.ts:1603-1626`): coteja **solo la dirección
  peligrosa** (conceder contra una clave que lo niega), comprueba el `error` de
  la lectura antes de decidir —una base caída no se lee como «no tiene clave»— y
  lanza `DatoInvalido` con el fundamento. Fallar cerrado nunca imprime una
  deducción de más.
- **`leerSnapshotInsumosCierre`** (`repo.ts:1087-1090`) subió a `version: 2` en
  sincronía con `0354:164`, y la RPC `guardar_liquidacion_tx` rechaza un cliente
  que todavía pida `version=1` (`0354:219-221`): el acople de despliegue está
  declarado en los dos extremos, no supuesto.
- **`pg_errores.ts:38-44`**: `violaIndice` exige **código 23505 y** nombre del
  índice en `message`/`details`; sin el código, un mensaje que casualmente lo
  mencione daría falso positivo y se tragaría un error real.
- **`/api/export/pdf/[id]`** sigue contestando 409 sin firmar sobre una
  rechazada, y la ventana añadió `Cache-Control: no-store` al redirect
  (`route.ts:173-178`) — la URL firmada es de un solo tenant.

---

## Lo que NO alcancé a revisar

- **`src/middleware.ts` no existe.** `find . -name 'middleware*.ts'` fuera de
  `node_modules` no devuelve nada: el rubro me lo asigna y el repo no lo tiene.
  Lo digo por si la cobertura de rutas que alguien supone en un middleware vive
  en realidad en `_comun.ts`/`abrir()` — que es donde la encontré.
- **`cron/facturar/lote.ts`** (915 líneas): solo leí `procesarLoteEnCola` desde
  sus dos llamadores, no el interior de la sesión de portal.
- **Siguen sin abrir** de la lista de la 29: `mcp` y su OAuth (3 rutas),
  `marketing/*`, `lead`, `admin/copiloto`, `admin/mapa-prospectos`,
  `admin/qa/*`, `webhook/calcom` y `lib/admin/calcom_webhook.ts` (+242 líneas),
  `cron/{jornada,portales-vivos,runner,purgar,asistencia}`,
  `export/{bitacora-peaje,carta-porte-xml,facturas-proveedor,jornada}`,
  `client-error`.
- **La carrera concurrente de `marcarEvento`** (`suscripcion.ts:563-584`): dos
  entregas simultáneas del MISMO `evt.id` ven las dos `'pendiente'` y aplican en
  paralelo. No lo reporto como hallazgo propio porque `aplicarFactura` es un
  upsert por `stripe_invoice_id` y `aplicarSuscripcion` por
  `stripe_subscription_id` —el efecto duplicado se absorbe—, pero **no lo pude
  descartar para `cancelarFacturaDeStripe`**, que llama al PAC: no leí ese
  camino completo.
- **Todo lo que exige Postgres vivo.** Cuanto afirmo del SQL de la 0348 sale de
  leerla contra su test, no de ejecutarla; `supabase/verificaciones.sql` sigue
  sin correr aquí.
- **No corrí `npm test` completo** (lo corre el orquestador): corrí
  `pg.test.ts`, `factura_orden.test.ts`, `suscripcion_orden.test.ts` y
  `cron/escalar/route.test.ts` — **4 archivos, 62 pruebas, verdes**.
