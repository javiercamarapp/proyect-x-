# Backend y API — auditoría 27

**Nota: 5/10** (antes 6). Razón del movimiento: **deuda que cobró factura**. El
patrón `soltarClaim(true)` → `'sin_tiempo'` → `devolverIntentoPendiente` se
diseñó (auditoría 24, ESC-1) para que un mensaje que *nadie miró* no se
convirtiera en carta muerta. En esta ronda se le colgaron **tres condiciones
nuevas de cierre que no son transitorias**, y el resultado es un aplazamiento
sin techo, sin salida y sin una sola palabra hacia el chofer. Una de esas
condiciones ya rompió, en el árbol, el arnés de QA que corre el motor real con
gasto real — y `npm test` no lo ve porque ese arnés mockea `processInbound`.

**El riesgo mayor del rubro, hoy:** existe un camino en el que una liquidación
**nunca se escribe** —el «listo» del chofer se aplaza para siempre, su
conversación entera se estanca detrás de él— y lo único que queda es una línea
de `logger.warn`. Es literalmente el ancla de 4 del rubro; lo que sostiene el 5
es que el resto del camino del dinero (idempotencia de `/v1`, cierre atómico
con snapshot, compensación de facturación, claims anclados) sigue siendo sólido
y **sí tiene prueba propia**.

---

## Hallazgos

### [ALTO] Una foto que agotó sus 5 intentos bloquea PARA SIEMPRE todos los cierres de ese chofer, en silencio y sin salida

`src/lib/likida/conv.ts:940-970` (la consulta), `src/lib/likida/processor.ts:3746-3757`
(quien la obedece), `supabase/migrations/0325_capacidad_wa_jornada_timezone.sql:56-57`
(`intentos < 5`), `supabase/migrations/0155_purgas_y_bucket_comprobantes.sql:150`
(la única salida: 90 días).

**Escenario, con valores.** El chofer 5219993700779 manda una foto el 1-sep a
las 10:00. `processInbound` truena 5 veces (media hora de OCR caído, o el media
de Meta ya caducó cuando la bandeja la rescató): la fila llega a `intentos = 5`
con `procesado_en IS NULL` → **carta muerta**. `listar_wa_pendientes` la
excluye (`intentos < 5`), así que nadie la va a procesar nunca; la purga la
borra a los **90 días**.

A las 10:40 el chofer escribe «listo». En `processor.ts:3747`,
`fotoAnteriorSinProcesar('5219993700779', 1756...)` consulta
`wa_evento_pendiente` con `procesado_en is null`, `type='image'` y
`evento->timestampMs < mensajeMs` — **y ya no filtra por `intentos`**: la
carta muerta califica. Devuelve `true` → `soltarClaim(true)` → `'sin_tiempo'`
→ `devolverIntentoPendiente` (el intento NO se consume) → `return`. **Cero
mensajes al chofer.**

En la vuelta siguiente del cron pasa exactamente lo mismo, y en la siguiente.
Peor: en `drenado.ts:161` un `'sin_tiempo'` hace `return` de la cadena entera
de ese remitente, y en `route.ts:440-444` hace `break`. Como
`listar_wa_pendientes` ordena la cadena por `orden_evento, recibido_en`, ese
«listo» es la cabeza permanente de la cola de ese chofer: **sus fotos nuevas,
sus viajes nuevos y sus siguientes «listo» tampoco avanzan**. Y como el intento
nunca se consume, esas filas jamás llegan al tope: no aparecen en
`cartasMuertas()` ni disparan `alertarOperador`.

No hay ninguna forma de salir desde el producto: busqué un reencolado, un
`intentos = 0`, un `procesado_en` manual o una pantalla de admin sobre
`wa_evento_pendiente`. **No existe ninguno.** Solo la consola de Supabase o
esperar 90 días.

**Consecuencia.** El chofer manda comprobantes y escribe «listo» durante días y
el bot no le contesta nada — para él el producto está muerto. La flota no
liquida esos viajes: el anticipo se queda abierto, sin PDF y sin cifras. La
oficina no tiene una sola señal: el único rastro es `cierre.foto_anterior_pendiente`
en los logs. Es exactamente «no se escribe y nadie se entera».

**Causa raíz probable.** El commit que endureció esta guardia quitó a propósito
el `.lt('intentos', 5)` (hay prueba que lo fija:
`conv_foto_anterior_aud24.test.ts:71-75`, «una foto agotada sigue siendo
evidencia pendiente»), pero la carta muerta es por definición un estado
**terminal**: tratarla como «pendiente» convierte un bloqueo pensado para
segundos en uno permanente, y no se le dio ni caducidad, ni aviso al chofer, ni
camino de resolución (el fallo de OCR sí lo tiene:
`resolverIncidenteOcrDeEstaFoto`, `processor.ts:2218-2239`).

---

### [ALTO] Un «listo» sin hora de Meta se aplaza para siempre — y así rompió el arnés de QA, que gasta dinero real en cada corrida

`src/lib/likida/processor.ts:3688-3703`, `src/lib/admin/qa-motor.ts:745`, `:748`,
`:1397`, `:1400`.

**Escenario, con valores.** `qa-motor.ts` corre el motor de producción
(`processInbound` importado tal cual, con OCR y LLM de pago) y cierra el
escenario así:

```
await processInbound({ from: telefono, type: 'text', text: 'listo, ya subí todo', waMessageId: `${prefijo}t1` });
```

Sin `timestampMs`. En `processor.ts:3688`, `pidioCerrar('listo, ya subí todo')`
→ `true` (empata `pareceCierre`, `:516`); `timestampCierreMs` → `null`; se
entra al `if` de `:3697` y el turno hace `soltarClaim(true); return`. **La
liquidación no se genera nunca.** El arnés lo detecta a medias
(`hayLiquidacion` → false), reintenta una vez con `t2` — mismo resultado — y
después cierra el paso con `await cerrarPaso(pC, 'ok', ...)` en `:750`: **un
verde sobre un cierre que no ocurrió**, con las fotos y las llamadas de visión
ya pagadas.

Que el comportamiento es el que leo lo fija una prueba existente:
`aviso_barrera_cerrado.test.ts:105-108` («timestamp %s => no puede probar
causalidad y aplaza sin consumir intento», esperando
`cierre.timestamp_indeterminado`). Se actualizó la prueba del motor y **no** el
único llamador del repo que manda `listo` sin timestamp. `npm test` no lo
atrapa porque `qa-motor.test.ts:286` mockea `processInbound`.

**Consecuencia.** (a) El arnés de QA —la única corrida punta a punta contra el
motor real— ya no puede cerrar nada, reporta el paso en verde y quema OCR/LLM
de pago en cada lanzamiento desde `/admin/qa/lanzar`. (b) Fuera de QA: cualquier
mensaje entrante cuyo `timestamp` de Meta llegue ilegible (`route.ts:685` lo
convierte en `undefined` sin ruido) queda aplazado sin consumir intento — otra
fila inmortal, y el chofer sin respuesta.

**Causa raíz probable.** La guardia trata la ausencia de hora como
«incertidumbre causal» y la resuelve con un aplazamiento **sin techo ni
caducidad**, en vez de con un número acotado de vueltas o con un mensaje al
humano; y el cambio no se propagó al llamador interno que siempre llamó sin
hora.

---

### [ALTO · REINCIDENTE] La liquidación rechazada sigue sumando dinero: el arreglo cubrió 4 consultas, faltan al menos 3

`supabase/migrations/0112_agregados_rpc.sql:243-249` (`serie_comparativa_tenant`),
`supabase/migrations/0150_agregados_analytics.sql:366-370` (`liquidado_semanal_tenant`),
`supabase/migrations/0150_agregados_analytics.sql:433-437` (`operadores_detalle_tenant`),
`supabase/migrations/0150_agregados_analytics.sql:324-330` (`stats_operador_tenant`).

**Lo que sí quedó cerrado** (verificado abriendo el commit, no leyendo su
asunto): `0c2133a8` + mig. `0344` cubren las CUATRO consultas que la ronda
anterior enumeró — `getKpis` (`analytics.ts:219`, vía
`kpis_liquidacion_tenant` con `revision <> 'rechazada'`),
`getDineroObservadoPorTipo` (`:333`), `getLiquidaciones`
(`analytics.ts:1980`, `.neq('revision','rechazada')`) y
`getLiquidacionesDeViajes` (`:1055-1066`, importes a `null` y no a cero). Y el
`.neq` es seguro: `revision` es `text not null default 'pendiente'`
(`0299_revision_liquidacion.sql:58`), así que no hay NULL que PostgREST
descarte en silencio.

**Lo que quedó fuera, con valores.** Flota con dos liquidaciones de la semana:
A por $50,000 (aprobada) y B por $30,000 (**rechazada**, el viaje volvió a
`en_cuadre`).

- `liquidado_semanal_tenant` suma `total_comprobado` sin mirar `revision` →
  devuelve **$80,000**. Ese número es el que pinta el banner de
  `/dashboard`: «Tu flota liquidó **$80,000.00** en viajes cerrados»
  (`inicio-contenido.tsx:463-472`) y la gráfica «Liquidado» de abajo.
- `serie_comparativa_tenant` (`liq`, `:244`) devuelve `liquidado: 80000` para
  la tarjeta de KPI de `getSeriesKpiCards` — mientras el KPI «Monto
  comprobado», que sale de `kpis_liquidacion_tenant`, ya dice **$50,000**.
  **Dos cifras distintas del mismo hecho, en la misma pantalla.**
- `operadores_detalle_tenant` mete el comprobado de B en el
  `comprobadoTotal` del chofer → en `/dashboard/operadores` su
  «% comprobado» sale como si la liquidación rechazada contara
  (`analytics.ts:1279-1280`).
- `stats_operador_tenant` cuenta la liquidación rechazada de B en
  «Diferencias por operador» si `|diferencia| >= 0.01`.

**Consecuencia.** El contralor rechaza una liquidación —el acto que existe
justo para invalidarla— y el panel sigue contando su dinero en el banner, en la
tarjeta de KPI y en el expediente del chofer, mientras el CSV, `/v1`, la póliza,
los acreditables y ahora los KPI se abstienen. Es la contradicción más cara del
producto: dos números del mismo periodo que no cuadran, delante de quien compra.

**Causa raíz probable.** El arreglo se hizo consulta por consulta contra la
lista del hallazgo anterior en vez de contra el inventario de agregados que
tocan `liquidacion` (son 7, no 4); no hay una vista ni un predicado compartido
que obligue a todos a decidir sobre `revision`.

---

### [MEDIO] Un bache de red al leer la revisión pinta una liquidación RECHAZADA como si estuviera vigente

`src/app/dashboard/[id]/page.tsx:198`, `src/app/dashboard/[id]/detalle.tsx:421-423`.

**Escenario, con valores.** La liquidación `L` de $30,000 está `revision =
'rechazada'` con su motivo. El contralor abre `/dashboard/<id>`. `leerRevision`
está bien construida: usa `exigir(res, 'revision.leer')` y **lanza** ante error
de lectura (`revision.ts:318-343`). Pero la página la llama así:

```ts
const revisionEstado: RevisionDetalle | null = await leerRevision(tenantId, id).catch(() => null);
```

Un timeout de `acotada`, un 503 de PostgREST o un blip del pool → `null`. El
render hace `{revision && (<PanelRevision …/>)}` (`detalle.tsx:421`), así que
el panel de revisión —el que dice «rechazada», por quién y con qué motivo—
**simplemente no se pinta**. La página queda enseñando el chip de estatus de la
liquidación («Cuadrada» / «Con diferencias»), sus $30,000 de comprobado, su
desglose y su botón de PDF, sin una línea que diga que fue rechazada ni que
hubo un error. `catch(() => null)` además no registra nada: no hay log de qué
fila falló.

**Consecuencia.** El contralor —o su contador— lee como vigente una liquidación
que él mismo invalidó, y la puede exportar/archivar. Es el modo de falla que
`exigir()` y `traerTodo()` existen para impedir, anulado por el llamador en el
último metro.

**Causa raíz probable.** Un `.catch(() => null)` defensivo para que la página
no reviente, aplicado a un dato que **cambia el significado de las cifras que
está debajo**; el resto del archivo distingue bien «no hay» de «no se pudo»
(ver `totalOperadores`, `:275-277`: «`null` (no se pudo contar) NO apaga el
control»).

---

## Lo que revisé y está bien

- **`fd3e32fe` — VERIFICADO CERRADO.** `src/app/api/webhook/whatsapp/route.ts:440-444`:
  el `catch` del claim ahora hace `break`, así que un fallo de claim no deja
  que el «listo» adelante a una foto de la misma cadena. La cadena por chofer
  (`:361-369`) y el pool (`:371`) están intactos.
- **`b1758730` + `01473844` — VERIFICADOS CERRADOS.** `analytics.ts:296-322`:
  `getHechosSolos` lee cada tipo por su propio sello (`escalado_en`,
  `recordatorio_comprobacion_en`) con `.order(campo, desc)` **más**
  `.order('id', desc)` como desempate determinista, y mezcla en JS por
  `cuando`. Ya no ordena viajes por UUID antes del límite.
- **`0c2133a8` — cubre de verdad las cuatro consultas que enumeraba el
  hallazgo** (detalle arriba). Y `revision` es `not null default 'pendiente'`
  (`0299:58`): el `.neq` de `analytics.ts:1980` no descarta filas en silencio,
  que era la trampa obvia.
- **Idempotencia de `/v1`** (`src/app/api/v1/_escritura.ts:699-785`): tres
  capas, y las dos que sostienen la promesa son durables. `leerRecuerdoDurable`
  degrada a propósito y lo justifica (`:469-479`); `buscarViajePorFolio:873` y
  `buscarUnidadPorEconomico:923` **fallan cerrado** con `throw`; la carrera
  contra el unique se resuelve releyendo (`:767-777`) y el 409 por contenido
  distinto no se memoriza (`:745-752`). `leerLlaveIdempotencia` exige la
  cabecera en vez de aceptarla (`:387-411`).
- **Cierre atómico con snapshot** (`tools.ts:330-461`, `repo.ts:1071-1160`): el
  sello se lee **antes** del cálculo y la RPC lo recalcula bajo lock; el
  reintento es UNO, y `generarPdfs` reinicia `pdfPath`/`pdfOperadorPath`
  (`tools.ts:396-397`) para que la segunda pasada no archive el PDF viejo. El
  candado del cierre en ceros (`:361-369`) sale del MISMO cuadre que se
  persiste.
- **Compensación de facturación** (`facturacion_escritura.ts:424-437`): si las
  ligas a viajes fallan, la factura se **cancela** (no se borra) y el fallo se
  propaga completo; si ni cancelar se puede, queda `facturacion.alta_a_medias`
  con `tenantId` y `facturaId`.
- **Claims anclados del bus de workers** (`worker/bus/[accion]/route.ts:81-193`):
  `corrida-fin` ancla a `.is('fin', null)`, `ordenes-claim` a
  `.eq('estado','pendiente')`, `ordenes-resolver` a `estado='tomada'` **y** al
  dueño; los tres devuelven por valor si no aplicaron y lo loguean.
- **Autenticación de crons** (`src/lib/admin/salud.ts:80-97`): `puertaCron`
  falla cerrado sin `CRON_SECRET` (500 + alerta) y compara en tiempo constante;
  las rutas de cola usan el `receiver` de QStash. No encontré ninguna ruta
  `cron/*` sin puerta.
- **Cuerpos acotados** (`src/lib/http/cuerpo_acotado.ts`): se corta el stream
  por contador de bytes y el `TextDecoder` corre **sobre el buffer ya
  ensamblado** (`:44-59`) — no parte caracteres multibyte, que es lo que
  invalidaría la firma HMAC de Stripe/Meta.
- **`/api/pago/registrar`** (la única ruta pública que toca dinero): 413 antes
  del limitador, rate limit por IP antes de leer el stream, honeypot mudo, un
  solo texto para las cuatro razones de token inválido, 503 (no 404) cuando no
  se pudo *preguntar*, y 409 explícito para factura cancelada.
- **`export/poliza`** (`route.ts:102-360`): compuerta de versión de RPC
  (`RPC_VERSION_MINIMA = 342`) y 409 `liquidaciones_sin_firma` — la póliza no
  sale con nada que no esté aprobado o ajustado.
- **`guardar_comprobante_huerfano_tx`** (`0322`): registrar y vincular son una
  sola transacción con `FOR UPDATE`; HU001/HU002/HU003 hacen que
  `guardarHuerfano` devuelva `false` en vez de prometer que se guardó.

---

## Lo que NO alcancé a revisar

- **~40 de las 68 rutas de `src/app/api/`**: todo `admin/copiloto`,
  `admin/mapa-prospectos`, `admin/qa/*` (las rutas; sí revisé el motor),
  `correo/{entrante,baja,eventos}`, `marketing/*`, `lead`, `mcp` y su OAuth,
  `webhook/calcom` y `webhooks/calcom` (que cambió 235 líneas en esta ventana),
  `cron/{descarga-sat,facturar,jornada,portales-vivos,runner}`,
  `export/{bitacora-peaje,carta-porte-xml,facturas-proveedor,jornada,pdf}`.
- **El fencing de los pollers de conectores** (`repo.ts:1700-1810`,
  `reclamar_polls_conector` / `finalizar_poll_conector`) y
  `conectores/sincronizar_gps.ts`: leí la frontera en `repo.ts`, no la RPC ni
  el carril de backfill vs. reciente.
- **Los escritores nuevos** que el MAPA declara ya existentes: `cotizador/lector.ts`,
  `mantenimiento.ts`, `likida/soporte.ts`. Cero líneas leídas.
- **Las 18 consultas restantes de `analytics.ts`** más allá de las que tocan
  `liquidacion`: no repetí el barrido completo de la ronda anterior sobre
  `gasto`, `cfdi_consolidado_linea` ni `factura_emitida`.
- **`supabase/verificaciones.sql`** (308 bloques) y cualquier comprobación que
  necesite base viva: aquí no hay Postgres. Todo lo que afirmo sobre SQL sale
  de leer la migración, no de ejecutarla.
- **No corrí `npm test` completo** en esta ronda: usé la línea base del MAPA
  (12,168 pasan / 5 fallos INFRA por IPv6) y solo ejecuté
  `conv_foto_anterior_aud24.test.ts` y `analytics_rechazadas.test.ts`
  (11 pruebas, verdes) para confirmar dos lecturas.
