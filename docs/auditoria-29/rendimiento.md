# Rendimiento y costo — auditoría 29

**Nota: 6/10** (antes 4). Razón del movimiento: **se atacó y subió**. De los 13
hallazgos abiertos de la 28, **12 están cerrados** y los verifiqué uno por uno
abriendo el archivo y la prueba: no son asuntos de commit, son mecanismos. El
más importante no es un parche sino una función: `margenUnidadAtomicaMs()`
(`src/lib/likida/presupuesto.ts:399-401`) convierte el margen de reloj de un
cron en una DERIVACIÓN de los techos de su unidad atómica —`consultas ×
TECHO_PASO_CONSULTA_MS + envíos × TECHO_ENVIO_WHATSAPP_MS + colchón`— y con eso
las sumas de `gps` y `descarga-sat`, que la 27 y la 28 escribieron en rojo, hoy
**cierran con margen** (295 s y 294.5 s contra 300 s; los rehíce a mano, abajo).

No llega a 7 por dos razones que también medí: **una cadena excede su límite
escrito NOMINALMENTE, no solo a techos** —el destino `consolidado` de
`descarga-sat`, 331.5 s contra `maxDuration = 300` con los costos unitarios del
propio repo— y **pierde dinero fiscal en silencio** porque el sello de dedup se
commitea antes del trabajo; y el techo diario de IA sigue siendo el piso de
$5.00 para los tres planes del catálogo, cosa que el commit que dice cerrar
REN-A1 declara fuera de alcance con todas sus letras.

**El riesgo mayor hoy:** un paquete del SAT con un estado de cuenta ECC mensual
despachado después del segundo 225 de la corrida muere a medio conciliar; en la
corrida siguiente el CFDI sale por `cfdisRepetidos` y **ese consolidado no se
concilia nunca más** — el IVA acreditable de un mes entero de tarjeta de
combustible no llega a la cola del contador y nadie lo dice.

---

## Estado de los hallazgos abiertos de la 28

| # de la 28 | Veredicto | Evidencia que lo ancla |
|---|---|---|
| [ALTO] techo diario de IA dimensionado al promedio; derivación muerta para los 3 planes | **MUTADO** (síntoma cerrado, causa raíz viva) | El rótulo sí se arregló (`budget.ts:334-345`, pruebas `presupuesto_por_tenant.test.ts:181-224`). El dimensionamiento no se tocó — el propio `2c63d74` lo dice: «No se toca el piso, el margen ni la derivación». Reabierto como **REN-A1**. |
| [ALTO] el techo agotado se reporta como «OCR caído» | **CERRADO** | `intake/ocr.ts:476-493` (`esErrorDePresupuesto` ANTES de `vigilante.fallo()`, `motivo: 'sin_presupuesto'`, `costo` en 0 con la razón escrita), propagado a `intake/decidir.ts:80`, `processor.ts:2117-2135` y a la libreta de ráfaga (`rafaga.ts:63`, `:276-281`, `:369-380`) con coletilla que ya no dice «en un rato». Revertir el `if` de `:476` reabre `ocr.caido` de inmediato. |
| [ALTO] piloto de visión: `runId` nuevo por paso, `maxRunUsd` inoperante | **CERRADO** | `piloto_vision.ts:285-286`: `const runId = randomUUID()` y `createLlmBudget(...)` UNA vez, **antes** del `for` de `:288`. El tope de $0.50 vuelve a acotar la sesión entera. |
| [MEDIO] el chat del contralor corre en el carril `fondo` | **CERRADO** | `agents/analista.ts:334` → `'interactivo'`, con prueba que espía `createLlmBudget` (`analista_presupuesto_carril.test.ts:46-56`). |
| [CRÍTICO] `ingerirRep` sin reloj, 3 consultas por docto | **CERRADO** | `intake/rep.ts:199` acepta `venceEn` y corta en `:210-217` ANTES de arrancar un docto, contando `pendientes`; **los cuatro llamadores lo pasan** (`correo/entrante/route.ts:350`, `processor.ts:1657`, `:2009`, `:3384`) y el acuse lo dice (`rep.ts:283-289`). |
| [ALTO] cron de GPS: margen de 20 s sobre unidad de ~114 s | **CERRADO** | `cron/gps/route.ts:63` → `margenUnidadAtomicaMs({consultas: 11, envios: 0})` = 109.5 s. La suma cierra (abajo). |
| [ALTO] margen del cron del SAT (20 s) | **CERRADO para las dos cadenas que declara** | `cron/descarga-sat/route.ts:106` → `margenUnidadAtomicaMs({consultas: 3, envios: 1})` = 43.5 s. **Pero deja fuera a propósito el destino `consolidado`** (lo dice su comentario, `:96-99`) — eso es **REN-C1**. |
| [ALTO] reloj del piloto vigila el arranque del paso, no su duración | **CERRADO** | `piloto_vision.ts:636` pasa `signal: senalDeSesion(venceSesionEn)`; `:650-658` devuelve una señal ya abortada si no queda nada. La escalera de 4×30 s ya no se sale del presupuesto de 130 s. |
| [MEDIO] cola de eventos: 285 s de consultas tras el último chequeo | **CERRADO** | `conectores/sincronizar_eventos.ts:837-843` y `:869-875`: reloj por vuelta en los dos bucles, con `backlog: true` y log de pendientes. |
| [MEDIO] `.limit(5000)` con detector de truncamiento insatisfacible | **CERRADO** | `sat_descarga/peaje_cierre.ts:231-233`: la página fija se sustituyó por lectura paginada; `truncado` ya no es `1000 >= 5000` sino `false` con `LecturaIncompleta` lanzando (`:396-398`). |
| [MEDIO] `traerTodo` sin desempate único ni `conteo()` | **CERRADO** | `asistencia_escalamiento.ts:205-212`: desempate y `conteo(desde)`, con el porqué escrito. |
| [MEDIO] la captura del piloto va al modelo sin redimensionar | **CERRADO** | `piloto_vision.ts:626` → `comoDataUriAcotada`, que en `:673-683` pasa por `redimensionarParaVision` y solo cae al original si `sharp` falla. |
| [BAJO] la foto principal pasa por `sharp` tres veces | **CERRADO** | `intake/ocr.ts:435-446`: reusa la `reducida` que ya calculó `decodificarCodigosYReducir`; el redimensionado extra solo corre si no hubo ninguna. |

**12 cerrados · 1 mutado · 0 reincidentes.** Es el mejor resultado de este rubro
en las rondas que tengo a la vista, y no lo estoy regalando: en cada fila de
arriba abrí el archivo y me pregunté si la prueba fallaría con el arreglo
revertido.

---

## Las sumas que hice esta ronda

Todas usan los techos ESCRITOS del repo: `TECHO_PASO_CONSULTA_MS` = 9,500 ms
(`presupuesto.ts:83`, = `TOPE_CONSULTA_MS` 8,000 + gracia 1,500) y
`TECHO_ENVIO_WHATSAPP_MS` = 10,000 ms (`presupuesto.ts:47`). Donde uso costos
nominales, son los del propio archivo (0.3 s una consulta, `presupuesto.ts:37`).

### 1. `cron/gps` — CIERRA
margen = 11 × 9.5 + 5.0 = **109.5 s** → `venceEn` = 190.5 s.
Unidad atómica más cara (evento grave de cámara, 11 consultas, 0 envíos) =
**104.5 s**. 190.5 + 104.5 = **295.0 s** contra `maxDuration = 300`, con 5 s de
colchón para latir y responder. ✅

### 2. `cron/descarga-sat`, destinos `casado` y `avisarCierrePeaje` — CIERRAN
margen = 3 × 9.5 + 1 × 10 + 5 = **43.5 s** → `venceEn` = 256.5 s.
`ingerir` casado = 4 × 9.5 = 38.0 → **294.5 s**. `avisarCierrePeaje` = 3 × 9.5 +
10 = 38.5 → **295.0 s**. Los dos contra 300. ✅

### 3. `cron/descarga-sat`, destino `consolidado` — **NO CABE** (REN-C1)
Mismo `venceEn` = 256.5 s. La unidad es `guardarYConciliarConsolidado`
(`intake/consolidado.ts:351-524`), que **no mira el reloj ni una vez**:

| paso | consultas |
|---|---|
| lectura de `cfdi_xml` (`:351`) | 1 |
| `traerTodo` líneas existentes (`:386`) | ⌈L/1000⌉ |
| `traerTodo` gastos ya sellados (`:420`) | ⌈L/1000⌉ |
| `traerTodo` candidatos del MES (`:442-451`) | ⌈G/1000⌉ |
| `enLotes(porLigar, 10, ligarLineaAGasto)` (`:481-482`) | ⌈C/10⌉ × 2 |
| upsert de las líneas (`:513`) | 1 |

Con los supuestos de escala del propio repo (`docs/escala-15k.md`: 15,000
viajes/mes × 3 fotos = 45,000 gastos/mes → G=45,000) y un ECC mensual de 1,000
líneas conciliables (L=C=1,000):
**nominal** 0.3 + 0.6 + 13.8 + 60.0 + 0.3 = **75.0 s**; **a techo** 9.5 + 19 +
437 + 1,900 + 9.5 = **2,375 s**.
256.5 + 75.0 = **331.5 s** contra 300 → **31.5 s de más NOMINALES**. A techo,
2,631 s. ❌

### 4. El reintento del «listo»/«gracias» sin viaje abierto — **NO CABE** (REN-A2)
`maxDuration = 120` (`webhook/whatsapp/route.ts:117`). Única puerta de reloj:
`reloj.alcanza(15_000)` (`processor.ts:1476`), que deja entrar con `restante()`
= 15 s, o sea con `elapsed` ≤ 120,000 − 39,600 (`MARGEN_CIERRE_MS`) − 15,000 =
**65.4 s**.

| paso | archivo:línea | techo |
|---|---|---|
| `liquidacionRecienteDe` | `conv.ts:265` | 9.5 |
| `createSignedUrl.reentrega` | `processor.ts:1184` | 9.5 |
| `sendDocument` PDF chofer | `processor.ts:1186` | 10.0 |
| `registrarCostoWhatsApp` | `processor.ts:1189` | 9.5 |
| `sellarEntregaLiquidacion` | `processor.ts:1190` | 9.5 |
| `createSignedUrl.contralor` | `processor.ts:1223` | 9.5 |
| `telefonoParaDineroDe` | `contactos.ts:158` | 9.5 |
| `resumenDeCierre` (Promise.all) | `avisar_cierre.ts:133` | 9.5 |
| `avisarOficina` → `enviarTexto` | `aviso_oficina.ts:84` | 10.0 |
| `avisarOficina` → `sendTemplate` | `aviso_oficina.ts:95` | 10.0 |
| `sendDocument` PDF jefe | `avisar_cierre.ts:279` | 10.0 |
| `sellarEntregaLiquidacion` | `processor.ts:1242` | 9.5 |
| `sendText` del `mensajeCierreConfirmado` | `processor.ts:2295` | 10.0 |
| **TOTAL** | | **126.0 s** |

65.4 + 126.0 = **191.4 s** contra 120 → **71.4 s de más**. Y ni con `elapsed = 0`
cabe: 126.0 > 120. ❌

### 5. `correo/entrante` — **NO CABE por 10.5 s** (REN-M1)
`maxDuration = 60`, reserva `RESERVA_PARA_LIBERAR_MS` = 3.0 s (`:284`).
Última mirada al reloj: `restanteMs() === 0` antes de la segunda descarga
(`:307`). Cola posterior sin reloj: `estadoSatDeCfdi` (4.0 s,
`intake/sat.ts:36`) + `guardarFacturaProveedor` (1 consulta, 9.5 s) = **13.5 s**
contra 3.0 s de reserva. 57.0 + 13.5 = **70.5 s** contra 60. ❌

### 6. `cron/facturar` con el piloto — cabe nominal, no a techos (REN-M2)
`MARGEN_LOTE_MS` = 150 s (`lote.ts:79`) → la última sesión se abre a 149.999 s.
La sesión ya está acotada a `PRESUPUESTO_SESION_MS` = 130 s (arreglo de la 28,
con `signal`). Cola posterior a la sesión: `guardarUno` por ticket
(`al_vuelo.ts:490`, 1-2 consultas). Con 8 tickets:
nominal 150 + 130 + 16 × 0.3 = **284.8 s** ✅ / a techo 150 + 130 + 16 × 9.5 =
**432 s** contra 300 ❌.

### 7. El techo diario de IA, recalculado desde cero (REN-A1)
`COSTO_ESTIMADO_USD.viajeCompleto = 0.18 + 3 × 0.0016 =` **$0.1848**
(`models.ts:270-277`, contado por mí, no citado).
`topeDerivadoDelPlan(limite, piso)` (`budget.ts:271-276`) =
`min(max((limite/30) × 0.1848, piso), techo)` con `piso = $5.00`:

| plan (`0052:111-114`) | `limite_viajes_mes` | derivado | techo aplicado | rótulo hoy |
|---|---|---|---|---|
| demo | 50 | $0.308 | **$5.00** | `'piso'` (bien) |
| flota | 500 | $3.080 | **$5.00** | `'piso'` (bien) |
| empresa | `null` | — | **$5.00** | `'piso'` |

Punto de cruce donde la derivación empieza a mandar: `5 × 30 / 0.1848` =
**811.7 viajes/mes**. Ningún plan del catálogo llega, y **no entró ninguna
migración nueva** (324 `.sql`, hasta 0347): la derivación sigue siendo código
muerto para los tres.
$5.00 / $0.1848 = **27.05 liquidaciones/día**. El único plan con precio (`flota`,
$17,500 MXN/mes, `0136:14-16`) vende 500 viajes/mes = **22.7 por día hábil**
(500/22) = **84 %** del techo. Con la reserva del 40 % (`budget.ts:164-168`) el
carril de fondo puede llegar a $3.00 y al interactivo le quedan $2.00 = **10.8
liquidaciones**.

---

## Hallazgos

### REN-C1 · [CRÍTICO] El margen del cron del SAT excluye a propósito al destino `consolidado`, y el sello de dedup se commitea ANTES de esa cadena: un estado de cuenta ECC muerto a medias no se concilia nunca más

`src/app/api/cron/descarga-sat/route.ts:96-99` (el comentario que deja el
consolidado fuera de la cuenta con esas palabras: «queda fuera de esta cuenta a
propósito») y `:106` (`margenUnidadAtomicaMs({consultas: 3, envios: 1})`);
`src/lib/likida/sat_descarga/ciclo.ts:277-283` (el reloj se mira por XML),
`:296-315` (el upsert de `sat_cfdi_descargado` con `ignoreDuplicates` y su
`continue` en `:315`), `:321-333` (el destino `consolidado`);
`src/lib/likida/intake/consolidado.ts:351`, `:386`, `:420`, `:442-451`,
`:481-482`, `:513` (cero chequeos de reloj en toda la función).

**Entra esto → sale esto mal.** El margen es de **43.5 s**, o sea `venceEn` a
los **256.5 s** de una invocación de `maxDuration = 300`. El bucle de `ingerir`
mira el reloj ANTES de cada XML y despacha el siguiente si aún hay turno. Un
paquete del SAT trae «miles de CFDI» (lo dice la cabecera de `ciclo.ts:243`), así
que llegar al segundo 225 es rutina. Ahí entra el XML del estado de cuenta ECC
mensual de la tarjeta de combustible: destino `consolidado`, unidad de
**75.0 s NOMINALES** (46 páginas de candidatos del mes + 100 tandas de
`ligarLineaAGasto` a 2 consultas cada una, con los supuestos de
`docs/escala-15k.md`), **2,375 s a techos**. 256.5 + 75.0 = **331.5 s contra
300**: Vercel mata la función a media conciliación, sin excepción y sin `catch`.

Lo que queda escrito en la base en ese momento: parte de los gastos con
`cfdi_uuid` y `xml_verificado = true` (los `ligarLineaAGasto` que sí corrieron,
`consolidado.ts:281-317`) y **ninguna fila en `cfdi_consolidado_linea`** — ese
upsert es el ÚLTIMO paso (`:511-513`). Y lo decisivo: el sello de dedup
(`sat_cfdi_descargado`) ya se commiteó en `ciclo.ts:296-310`, ANTES de llamar a
la conciliación. Como el paquete no se marcó como bajado, la corrida siguiente
lo re-baja y vuelve a recorrer sus XML — pero para ESTE CFDI el upsert conflicta,
`(metido ?? []).length === 0`, y `ciclo.ts:315` hace `r.cfdisRepetidos++;
continue;`. **La conciliación no se reintenta jamás.** El bloque de reanudación
que `consolidado.ts:416-433` construye para exactamente este caso es
inalcanzable, porque nadie vuelve a llamar a la función.

**Consecuencia para alguien real.** El contador de la flota no ve en su cola las
líneas de un mes completo de tarjeta de combustible: `cfdi_consolidado_linea`
está vacía para ese CFDI, así que ni aparecen como `por_conciliar` ni como
`sin_match`. Un ECC mensual de $200,000 MXN son ~$27,600 de IVA acreditable
(16 % sobre subtotal) que no llega a la declaración, y ~$0 de estímulo de diésel
por los litros que `ligarLineaAGasto` iba a escribir en `ocr_extra`. No hay
alerta: el latido tampoco se escribe (la invocación murió antes de
`registrarLatido`), así que el tablero dice «no late» sin decir por qué, y
`avisarCierrePeaje` —que corre DESPUÉS en la misma invocación— no corre para
NINGUNA flota ese día. Es exactamente el modo de falla que REN-A5 vino a cerrar,
alcanzado por otra puerta.

Causa raíz: el margen se derivó de las dos cadenas baratas del cron y la tercera
—la única sin techo propio— se documentó como excluida en vez de acotarse.

---

### REN-A1 · [ALTO · causa raíz reincidente] El techo diario de IA sigue siendo el piso de $5.00 para los tres planes del catálogo, y el plan que sí tiene precio consume el 84 % de él en un día hábil normal

`src/lib/llm/budget.ts:271-276` (`topeDerivadoDelPlan`, sin margen sobre el
derivado), `:219` (`PISO_TOPE_TENANT_USD = 5.00`), `:231-232` + `:243-245` (el
margen 1.5 aplicado al TECHO global, nunca al derivado por flota),
`:164-168` (reserva del 40 %), contra
`supabase/migrations/0052_saas_plan_suscripcion.sql:111-114` y
`supabase/migrations/0136_precios_live.sql:14-16`, y
`src/lib/llm/models.ts:270-277`.

**Qué se cerró y qué no.** El commit `2c63d74` arregló el RÓTULO —hoy
`budget.ts:334-345` dice `'piso'` cuando el piso ganó, deja
`presupuesto_llm.tope_plan_bajo_piso` como evidencia, y cuatro pruebas lo
anclan— y eso vale: la alerta que le llega a Javier ya no lo manda a revisar un
plan mal dimensionado. Lo que NO se tocó lo declara el propio commit: «No se
toca el piso, el margen ni la derivación por defecto».

**Escenario con la aritmética rehecha esta ronda** (ver suma 7): el derivado del
plan «Flota» es **$3.08/día**, el piso **$5.00**, y `Math.max` deja $5.00 para
las tres claves del catálogo; la derivación solo empezaría a mandar a partir de
**811.7 viajes/mes**, que ningún plan vende. $5.00 compran **27.05
liquidaciones/día** a $0.1848 cada una. El plan «Flota» —$17,500 MXN/mes, el
único con precio— vende 500 viajes/mes, que son **22.7 por día hábil**: el
**84 %** del techo antes de que corra un agente de fondo. Y si el carril de
fondo usa su parte ($3.00, `0244:239`), al chofer le quedan $2.00 = **10.8
liquidaciones**. El comentario de `:221-230` dice que el margen de 1.5 existe
para «picos de fotos por viaje y reintentos»; se aplica al techo global
($138.60) y **nunca** al valor por flota, que queda exactamente en la media —
un presupuesto puesto en la media se rebasa la mitad de los días por definición.

**Consecuencia para alguien real.** El día 12 del primer mes, a media tarde, los
choferes de la primera flota que pague dejan de recibir cuadre; con el arreglo
de REN-A2 al menos ya se les dice la verdad («hoy tu flota ya agotó su cupo de
IA… reenvíamela mañana»), pero la flota que paga $17,500 al mes está comprando
un servicio que su propio plan agota. La palanca de reparación sigue siendo
poner `tenant.config.presupuestoLlmUsdDia` a mano, flota por flota.

---

### REN-A2 · [ALTO] La reentrega de un cierre pendiente es una cadena de 126 s sin un solo chequeo de reloj, y la prueba del presupuesto la excluye por escrito

`src/lib/likida/processor.ts:2277-2304` (la rama «sin viaje abierto», sin
ninguna referencia a `reloj`), `:1160-1254` (`entregarCierrePendiente`),
`:1476` (la única puerta: `reloj.alcanza(COSTO_MINIMO_TURNO_MS)` con
`COSTO_MINIMO_TURNO_MS = 15_000` en `:904`), `:1134` (`TECHO_REENTREGAS_POR_PROCESO
= 2`, en memoria), contra `src/lib/likida/presupuesto.test.ts:165-170`, cuyo
comentario dice literalmente que cuenta los sellos «del cierre PRINCIPAL» y que
«se distinguen de los de `entregarCierrePendiente`, la ruta de reentrega».

**Entra esto → sale esto mal.** El chofer escribe «gracias» después de un cierre
que quedó a medias. Su mensaje es el quinto de una invocación que ya lleva
65.3 s gastados: pasa la puerta (`restante()` = 15.1 s ≥ 15.0 s) y entra a una
cadena de **13 viajes de red que suman 126.0 s a sus techos escritos** (tabla en
la suma 4). 65.4 + 126.0 = **191.4 s contra `maxDuration = 120`**. Ni con la
invocación recién nacida cabe: 126.0 > 120.

Lo que distingue esto de la deuda ya declarada del cierre es que el cierre
principal SÍ tiene su mitigación —`reloj.margenDuro()` en `:4591` re-mira el
reloj después del agente y recorta los pasos accesorios con log (`:4728`,
`:4885`)—, y **esta rama nunca llega ahí**: hace `return` en `:2296`, 2,300
líneas antes. `PASOS_CIERRE` tampoco la ve: la tabla se quedó en 20 renglones y
la prueba que la vigila se declara explícitamente ciega a ella.

**Consecuencia para alguien real.** Vercel corta la invocación entre el
`sendDocument` de `:1186` (que ya salió) y el `sellarEntregaLiquidacion` de
`:1190` (que no). Meta ya recibió su 200 y no reintenta. El sello nunca se pone,
así que el siguiente «gracias» vuelve a entrar por la misma rama y vuelve a
firmar Storage, mandar el mismo PDF y avisar otra vez a la oficina — la
duplicación que AG-A1 vino a matar, resucitada por el hachazo del reloj. El
techo que debería frenarla, `TECHO_REENTREGAS_POR_PROCESO`, es un `Map` de
módulo: cada invocación fría arranca en cero, y su propio comentario
(`:1127-1132`) lo dice. Cuesta 3 mensajes de WhatsApp por repetición ($0.024) y,
peor, la invocación que muere se lleva por delante a los demás mensajes del
mismo lote.

Causa raíz: la rama de reentrega se escribió como camino de reparación y heredó
la puerta de 15 s del turno normal, sin margen propio ni renglón en la tabla que
mide el cierre.

---

### REN-M1 · [MEDIO] El buzón de correo reserva 3 s para una cola de 13.5 s: el CFDI de proveedor muere 10.5 s después del `maxDuration`, sin registrar el fallo del claim

`src/app/api/correo/entrante/route.ts:284-286` (`RESERVA_PARA_LIBERAR_MS =
3_000`, `finPresupuesto`, `restanteMs()`), `:298` y `:307` (los dos únicos
chequeos, ambos ANTES de las descargas), `:362` (`estadoSatDeCfdi`, 4 s de tope
en `intake/sat.ts:36`), `:363` (`guardarFacturaProveedor`, 1 consulta acotada a
9.5 s en `proveedores.ts:128-148`), `:88` (`maxDuration = 60`), `:375`
(`finalizar(false, …)`).

**Entra esto → sale esto mal.** Las dos descargas de Resend sí se autoacotan
(`AbortSignal.timeout(restanteMs())`), así que ese tramo está bien. El problema
es lo que va DESPUÉS del último `restanteMs()`: con el adjunto ya en la mano a
los 57.0 s, el camino de un CFDI normal todavía paga `estadoSatDeCfdi` (4.0 s) y
`guardarFacturaProveedor` (9.5 s) = **13.5 s sin volver a mirar el reloj**,
contra una reserva de **3.0 s**. Fin a los **70.5 s** contra `maxDuration = 60`.

**Consecuencia para alguien real.** La invocación muere antes de `finalizar`, así
que en `correo_procesado` no queda ni el `ok` ni el error: la fila se queda
`claimed` con su lease de 90 s (`:216`). Los reintentos de Resend dentro de esa
ventana reciben 503 «correo en proceso» y se gastan; si su calendario de
reintentos no sobrevive a los 90 s, la factura de ese proveedor no vuelve a
entrar por el buzón y nadie lo dice. El daño está acotado por el lease —por eso
es MEDIO y no ALTO— pero la reserva es literalmente menor que UNA consulta.

Causa raíz: la reserva se dimensionó contra el `delete` que libera el claim, no
contra los dos pasos que corren después del último chequeo.

---

### REN-M2 · [MEDIO] `MARGEN_LOTE_MS` sigue en 150 s aunque la sesión del piloto ahora se autoimpone 130 s y encima escribe una consulta por ticket

`src/app/api/cron/facturar/lote.ts:79` (`MARGEN_LOTE_MS = 150_000`, con el
comentario de `:52-77` que lo deriva de «~147 s» de OTRO adaptador),
`:454-459` (el corte por flota), `:548-549` (el mismo instante para los
portales), contra
`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:131`
(`PRESUPUESTO_SESION_MS = 130_000`) y
`src/lib/likida/facturacion/al_vuelo.ts:488-490` (`guardarUno` por gasto, 1-2
consultas acotadas).

**Entra esto → sale esto mal.** El corte deja abrir la última sesión a los
149.999 s. La sesión del piloto ya tiene techo duro de 130 s (bien: eso lo
arregló la 28). Pero la cola de escritura corre DESPUÉS de la sesión y fuera de
todo reloj: con 8 tickets de un mismo portal son 16 consultas. Nominal:
150 + 130 + 16 × 0.3 = **284.8 s**, cabe. A los techos escritos:
150 + 130 + 16 × 9.5 = **432 s** contra `maxDuration = 300` → **132 s de más**.

**Consecuencia para alguien real.** En modo `emitir`, morir en esa cola deja
CFDI timbrados en el portal cuyo `cfdi_uuid` no se alcanzó a escribir en
`gasto`: el ticket vuelve a la cola de la corrida siguiente y se factura dos
veces por el mismo consumo — el escenario que `marcarEmisionEnCurso`
(`al_vuelo.ts:469`) existe para prevenir y que `levantarEmisionEnCurso` no puede
levantar si el proceso ya murió. Es el mismo defecto de dimensionamiento que
`margenUnidadAtomicaMs` acaba de resolver para `gps` y `descarga-sat`, en el
cron que no lo adoptó.

---

### REN-M3 · [MEDIO] Los 2-3 mensajes de WhatsApp del aviso a la oficina no pagan su costo: el «costo por liquidación» que el producto mide se queda corto entre 9 % y 50 % según cómo se cuente

`src/lib/likida/avisar_cierre.ts` y `src/lib/meta/aviso_oficina.ts`: **ni uno de
los dos archivos menciona `registrarCostoWhatsApp`** (verificado con grep sobre
los dos fuentes). Los envíos que hacen: `aviso_oficina.ts:84`
(`enviarTexto`), `:95` (`sendTemplate` de respaldo cuando Meta contesta fuera de
ventana) y `avisar_cierre.ts:279` (`sendDocument` del PDF del contralor). El
contraste está en el mismo cierre: `processor.ts:4819` sí llama
`registrarCostoWhatsApp` tras el PDF del operador, y `say()` (`:1455`) lo llama
tras cada texto al chofer.

**Entra esto → sale esto mal.** Con Meta cobrando $0.008 por mensaje
(`costos.ts:47`, `precioMensajeWhatsAppUsd`), un cierre normal manda 4 mensajes
—respuesta al chofer, PDF al chofer, texto al jefe, PDF al jefe— y sólo
**registra 2**. Si la ventana de 24 h está cerrada y entra la plantilla de
respaldo, son 5 mandados y 2 registrados. En dinero: **$0.016 a $0.024 por
liquidación que nunca entran en `llm_costo`**, contra un costo unitario de IA
medido de $0.1848 — o sea que la cifra que /admin/costos y el panel del
contralor construyen está **8.7 % a 13 % baja**; mirando sólo la cola de cierre,
**la mitad de sus mensajes no se cobran**. Y la misma omisión vive en la ruta de
reentrega (`processor.ts:1227`, que registra el PDF del chofer en `:1189` pero no
los del jefe).

**Consecuencia para alguien real.** La regla que define al producto es «nunca
inventar una cifra»; aquí no se inventa, se omite, y el efecto es el mismo: el
costo por liquidación que Javier usa para fijar precio y el que el contralor ve
en su panel están sistemáticamente por debajo del real, y la brecha crece
justo con los cierres que más trabajo dieron (los que necesitaron plantilla).

---

### REN-B1 · [BAJO] `PASOS_CIERRE` sigue en 20 renglones mientras el cierre recuperado añadió dos consultas que la tabla no ve

`src/lib/likida/presupuesto.ts:87-119` (los 20 renglones) y
`presupuesto.test.ts:147` (`expect(PASOS_CIERRE).toHaveLength(20)`), contra
`src/lib/likida/processor.ts:1379` (`getSnapshotCierreLiquidacion`, nueva esta
ventana, `repo.ts`) dentro de `confirmarCierreEnBase`, y `processor.ts:4765`
(`getLiquidacionDeViaje`, la rama que lee el puntero del PDF cuando la tool no
devolvió `pdf_url`).

**Entra esto → sale esto mal.** Las dos son consultas reales, envueltas en
`acotada`, que corren después del agente en el camino del cierre recuperado:
**+19.0 s de techo y +0.6 s nominales** que `MARGEN_CIERRE_MS` (39.6 s) no
descuenta. Es exactamente el defecto REND-A2 que las auditorías 18 y 25
persiguieron dos veces —«la tabla se comparaba consigo misma»— reaparecido en
pequeño: la prueba fija el número 20 y vigila `avisar_cierre.ts` y los sellos
del cierre principal, pero no tiene forma de ver una consulta nueva en otra
función del mismo camino.

**Consecuencia:** ninguna hoy —cabe en la holgura— pero la tabla vuelve a estar
por debajo del cierre real, que es la condición que precede a los tres hallazgos
altos anteriores del mismo tema.

---

## Lo que revisé y está bien

- **`margenUnidadAtomicaMs` es el arreglo correcto, no un parche.**
  `presupuesto.ts:368-401`: el margen deja de ser un literal copiado y se deriva
  de `consultas × TECHO_PASO_CONSULTA_MS + envíos × TECHO_ENVIO_WHATSAPP_MS +
  COLCHON_LATIDO_CRON_MS`, y sigue a `LIKIDA_TOPE_CONSULTA_MS` por entorno
  (probado en `presupuesto.test.ts:288-308`). El comentario de
  `cron/gps/route.ts:41-63` cuenta los 11 pasos uno por uno y **corrige a la
  baja** la cifra heredada de la 27 (11 consultas / 0 envíos, no 13 + 1) con la
  razón escrita: `encolarBotonesWhatsApp` es un `rpc` de encolado, no un envío
  síncrono. Recontarlo contra `asistencia_camara.ts` me dio lo mismo.
- **El corte por presupuesto de IA ya es honesto de punta a punta.**
  `intake/ocr.ts:476-493` → `intake/decidir.ts:80` → `processor.ts:2117-2135` →
  `rafaga.ts:276-281` y `:369-380`. El `costo: 0` viene con la distinción
  explícita entre «no se llamó» (aquí) y «no se sabe» (`noMedido`, el abort de
  RES-4) — que es justo la clase de cifra que este producto no puede confundir.
- **El piloto de visión quedó acotado por los dos lados.** Un solo `LlmBudget`
  por sesión (`piloto_vision.ts:285-286`) devuelve el poder al tope de $0.50 por
  corrida, y `senalDeSesion` (`:636`, `:650-658`) impide que la escalera de
  reintentos de `openrouter.ts` se coma el presupuesto de la sesión. Con eso el
  peor caso de la sesión pasó de ~250 s a 130 s duros.
- **`ingerirRep` se corta antes de un docto, no a la mitad, y lo dice.**
  `rep.ts:207-217` cuenta los `pendientes` de TODOS los pagos restantes (no solo
  el actual) y `mensajeRepRecibido` (`:283-289`) le dice al chofer que reenvíe el
  MISMO complemento porque el registro es idempotente. Los cuatro llamadores
  pasan `venceEn`; comprobé los cuatro.
- **La contabilidad de tokens del ciclo de tools sigue en pie y ahora atribuye
  bien.** `openrouter.ts:664-690` (`costoPorModelo` en `generateStructured`) cierra
  el hueco de atribuir a un modelo el gasto de otro cuando el fallback cruza de
  proveedor; `gastado` sigue sumando el total correcto y
  `settleLlmBudget` reescribe la reserva al costo real
  (`0186:89-92`), así que la sobre-reserva no infla el acumulado del día.
- **`TruncatedError` ya no se manda al fallback cross-provider**
  (`openrouter.ts:434-441`): quedarse sin `max_tokens` no es un fallo de
  proveedor y cambiar de proveedor no lo arregla — evita pagar una segunda
  llamada cara por un corte de salida. El comentario incluso explica la
  coincidencia numérica («se agotaron los 500 tokens») que hacía que
  `isTransientError` lo leyera como un 5xx.
- **La RPC de reserva sigue siendo fail-closed y con corte a medianoche de
  México** (`budget.ts:465-477`, `0244:207-221`): cualquier respuesta fuera del
  contrato lanza, y ningún `false` se lee como «tope».
- **`sharp` ya no corre tres veces por foto** (`intake/ocr.ts:435-446`): se reusa
  la reducida que la decodificación de códigos ya calculó; 2 pasadas en el caso
  común, 1 si el CFDI salió ya a 1600 px, y el original si `sharp` truena — la
  foto nunca se pierde por eso.
- **No existe `src/lib/queue/`** (verificado con `ls`): la deuda de cola sigue
  siendo `wa_outbox` + la bandeja durable, y nada nuevo que auditar ahí.

## Lo que NO alcancé a revisar

- **La latencia real Vercel ↔ Supabase.** Todas las sumas usan los techos
  escritos (9.5 s consulta, 10 s envío) y los nominales del propio repo (0.3 s).
  Sin base ni red, los desbordes son ciertos como peor caso; **la única
  excepción es REN-C1, que también desborda con los costos NOMINALES**, y por eso
  lo puse en crítico y no en alto.
- **Cuántas líneas trae de verdad un ECC mensual.** La suma de REN-C1 usa 1,000
  líneas y 45,000 gastos/mes como supuestos DECLARADOS, tomados de
  `docs/escala-15k.md` y del comentario de `consolidado.ts:378-385` (que dice
  «con más de 1,000 líneas»). Con 200 líneas el desborde nominal desaparece y
  queda solo el de techos; con 3,000 se triplica. Es el número que instrumentaría
  primero.
- **Cuántas llamadas de modelo gasta una liquidación real de punta a punta.**
  Sigue sin medirse cuántos mensajes de TEXTO manda un chofer, que es el
  multiplicador que decide si $0.1848 es el costo de una liquidación o el de una
  conversación corta. Abierto desde la 27.
- **El costo en Postgres del hash de cierre de la 0321** y **el plan real de la
  consulta de candidatos de `consolidado.ts:442-451`** (que es la que decide si
  46 páginas cuestan 13.8 s o mucho más). Sin base viva no se mide.
- **`npm test` completo.** Corrí solo `presupuesto.test.ts` (27 pasan) para
  confirmar que `PASOS_CIERRE` está anclada y qué anclan exactamente esas
  pruebas. No toqué código, así que no puedo haber movido la línea base.
