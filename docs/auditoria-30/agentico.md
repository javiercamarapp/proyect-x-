# Sistema agéntico y orquestación — auditoría 30

**Nota: 4/10** (antes 7). Razón del movimiento: **mirada más profunda (el código
no cambió, la nota anterior estaba inflada)** · y, en lo poco que sí cambió,
**deuda que cobró factura**.

Las dos razones son separables y las dos se sostienen con evidencia:

1. **El código de este rubro no cambió.** `git log 7bcc319..HEAD -- src/lib/agents/
   src/lib/likida/processor.ts conv.ts presupuesto.ts startup.ts cuadre/
   intake/ sat_descarga/` devuelve **exactamente dos commits**, `d0db998` y
   `e2038a5`, los dos sobre el ciclo del consolidado. Los cinco hallazgos que
   la 29 dejó abiertos siguen **intactos, línea por línea** (los verifiqué
   abiertos uno por uno, ver la tabla). Y la propia 29 escribió que
   `escalado` era «el único sitio donde hoy la base dice una cosa y el usuario
   cree otra» — que es, literalmente, el disqualificador del ancla de 3 de este
   rubro. Se dio un 7 con ese estado en pie. Eso es la inflación, dicha con las
   palabras del MAPA.
2. **El único commit que tocó mi área abrió un CRÍTICO nuevo.** `d0db998`
   arregla REN-C1 reintentando la conciliación de un consolidado ECC, y el
   reintento **corre el trabajo pero no cierra el ciclo**: deja el comprobante
   de $200,000 en la cola que la pantalla rotula «nadie reportó este gasto».
   Es exactamente el modo de falla que el rubro puntúa —un reintento nuevo que
   deja al humano sin cierre— y es la primera vez que lo produce un arreglo.

Dejo un punto por encima del ancla (4 y no 3) porque las garantías estructurales
que la 29 ancló son reales y las volví a verificar: `ingerirRep` sigue cerrado
de verdad, el orden por chofer sigue teniendo tres capas, y los relojes de
`ciclo.ts` cortan en los puntos correctos. La maquinaria es buena; lo que falla
es el último metro hacia el humano.

**El riesgo mayor del rubro, hoy:** en `sat_descarga`, el sello que dice «qué
pasó con este CFDI» y el trabajo que de verdad se hizo con él son dos hechos
distintos que nadie reconcilia — y desde `d0db998` se pueden separar
permanentemente, con un comprobante de seis cifras del lado equivocado.

---

## Estado de los hallazgos abiertos de la 29

Ninguno recibió una línea de código. Los cuatro primeros son **REINCIDENTES por
construcción**: el fuente es byte por byte el de la 29.

| Hallazgo 29 | Dónde lo verifiqué hoy | Veredicto |
|---|---|---|
| **[ALTO]** `escalado` no re-arma su filo cuando el problema se resuelve | `escalar_viaje.ts:274-281` (`anota` sigue solo dentro del `for (const v of viajes)`), `:466` (`for (const [tenantId, c] of porFlota)`), `:497-501` | **REINCIDENTE**, 3ª ronda |
| **[MEDIO]** el prompt ordena narrar el remanente que la guardia prohíbe | `prompts.ts:79` («ÁBRELE con los números (… cuánto era el anticipo, **cuánto queda**)») contra `guardia.ts:108-121,143,152` y `cifras.ts:138-145` | **REINCIDENTE** |
| **[MEDIO]** la carta muerta que no es foto no la drena nadie | `wa_pendientes.ts:316-324,344-357` · `conv.ts:990-1003` (sigue el `.eq('evento->>type','image')`) | **REINCIDENTE** |
| **[BAJO]** `definitivo` sella para el contralor y no para el chofer | `avisar_cierre.ts:92-99` contra `processor.ts:1200-1208` / `:1234-1243` | **REINCIDENTE** |
| **[BAJO]** el «listo» sin hora se abandona mudo | `processor.ts:4009-4015` (`soltarClaim(); return;`, sin `say`) | **REINCIDENTE** |

### El CRÍTICO de `ingerirRep` que la 29 declaró cerrado: **sigue cerrado**

Lo volví a abrir porque el encargo lo pedía explícitamente.
`intake/rep.ts:199` acepta `venceEn`; `:209-215` corta **antes de arrancar cada
docto** y acumula lo que falta de todos los pagos restantes; `:272-293`
(`mensajeRepRecibido`) le dice al humano cuántos quedaron y le pide reenviar el
MISMO complemento, que es idempotente por el `ignoreDuplicates` del upsert de
`:220-231`. La prueba ancla sigue viva y con el mismo nombre:
`intake/rep.test.ts:244` — *«corta ANTES del docto 64 cuando venceEn ya pasó —
63 procesados, 87 pendientes, nada a medias»*. **Corrida hoy: 45 pruebas verdes
en `rep.test.ts` + `ciclo_flota.test.ts` + `consolidado_orquestador.test.ts`.**
Cerrado de verdad; no lo cuento como hallazgo.

---

## Hallazgos

### [CRÍTICO] El consolidado que el reintento de `d0db998` SÍ concilia se queda para siempre en la cola «nadie reportó este gasto»: el ECC de $200,000 queda ofrecido al contralor para ligarlo 1:1 a un ticket de $1,200

`src/lib/likida/sat_descarga/ciclo.ts:297-310` (el sello se crea con
`estatus: 'disponible'`) · **`:340-351`** (el bloque nuevo de `d0db998`) ·
**`:342`** (`if (!yaDescargado)`) · `:344-346` (el `marcar(..., 'ignorado')` que
queda dentro de ese `if`) · `:387-399` (`marcar` falla con `logger.warn` y **NO**
empuja a `r.errores`) · `src/lib/likida/sat_descarga/resolucion.ts:189-197`
(desde `'disponible'` la elección de gasto es LIBRE) ·
`supabase/migrations/0263_ligar_cfdi_sat_transaccional.sql:117`
(`set cfdi_uuid = v_cfdi_uuid, cfdi_orden = 1, xml_verificado = true`) ·
`src/app/dashboard/descarga-sat/bandeja/vista.tsx:29,51-55` (el rótulo:
«disponible» = *«nadie reportó este gasto»*).

**Escenario, con valores.** Flota Innovativos, RFC con descarga activa. En el
paquete `p1` del SAT viene el ECC mensual del monedero de diésel:
`uuid = 9f3c…a1`, `total = 200,000.00`, 412 líneas.

1. **Corrida del día 1, 06:25.** `ingerir` sella el CFDI:
   `sat_cfdi_descargado` queda con `estatus = 'disponible'` (`:308`). Entra al
   bloque `consolidado` y llama `guardarYConciliarConsolidado`. A media
   conciliación —el caso EXACTO que `d0db998` documenta en su mensaje— Vercel
   mata la invocación a los 300 s. `marcar(..., 'ignorado')` nunca corre. El
   paquete nunca se anotó en `paquetes_bajados`.
2. **Corrida del día 1, 12:25.** El paquete se re-baja. Ahora, gracias al fix,
   `yaDescargado = true` **no impide** el reintento: se llama otra vez a
   `guardarYConciliarConsolidado`, que retoma por `selladoPorIndice` y
   **termina**: las 412 líneas quedan en `cfdi_consolidado_linea`, 380 de ellas
   `conciliada`, con sus 380 gastos sellados (`cfdi_uuid = 9f3c…a1`,
   `cfdi_orden = 1..412`, `xml_verificado = true`).
3. **Y entonces `:342` dice `if (!yaDescargado)` — y `yaDescargado` es `true`.**
   `marcar` no corre. La fila de `sat_cfdi_descargado` se queda en
   `estatus = 'disponible'` **para siempre**: no hay ningún otro camino
   automático que la mueva (`marcar` solo se llama desde `ingerir`, y `ingerir`
   ya no volverá a ver este UUID porque el paquete sí quedó bajado esta vez).
   `r.consolidados` tampoco se incrementa, así que el latido no lo cuenta.
4. **Lo que ve el contralor.** Abre `/dashboard/descarga-sat/bandeja`, cola
   **«Sin gasto que les corresponda»**, cuyo texto en pantalla dice literalmente
   *«Bajaron del SAT y ningún gasto los reclama. Eso TAMBIÉN es un hallazgo:
   alguien gastó y nadie lo reportó. Lígalos al gasto que les toque»*. Ahí está
   su ECC de **$200,000.00**, con su fecha y su RFC emisor. La pantalla le está
   pidiendo que haga justo lo que la regla 3.3.1.7 prohíbe.
5. **Si le hace caso, dos finales y los dos son malos.** Desde `'disponible'` la
   elección de gasto es libre (`resolucion.ts:194-197`), y `sat_cfdi_ligar_tx`
   escribe **`cfdi_orden = 1`** fijo:
   - si la línea 1 del ECC ya quedó conciliada (lo normal: es la cola que el
     reintento acaba de llenar), el índice único `uq_gasto_cfdi_uuid
     (tenant_id, cfdi_uuid, cfdi_orden)` de la 0065 rebota con `23505`, que no
     es ninguno de los tres SQLSTATE que `resolucion.ts:281-305` traduce → el
     contralor recibe en pantalla, en crudo: *«No se pudo ligar el gasto, así
     que no se cambió nada: duplicate key value violates unique constraint
     "uq_gasto_cfdi_uuid"»*. **Eso es el demo cayéndose en la sala.**
   - si la línea 1 quedó `por_conciliar` (32 de las 412 lo quedaron en este
     ejemplo), el `cfdi_orden = 1` está libre y **el ligado SE HACE**: un gasto
     de $1,200 queda con `xml_verificado = true` contra un CFDI de $200,000 que
     ya amparaba a otros 380 gastos. `ligarLineaAGasto` se cuidó de NO copiar
     `iva_traslado`/`ieps_traslado` por línea precisamente para no inventar un
     desglose; este camino se salta ese cuidado por completo.

**Tres caminos distintos llegan al mismo estado, y uno deja el latido en verde.**
(a) la muerte dura descrita arriba; (b) `guardarYConciliarConsolidado` lanza y el
`catch` de `:348-350` empuja a `r.errores` sin llamar a `marcar` — pero como los
errores **no** ponen `todoBien = false`, `:650` anota el paquete como bajado y
`:694-699` avanza `ultima_descarga_hasta`: ese consolidado no se reintenta jamás
(ver el ALTO de abajo); (c) **`marcar` falla por su cuenta** — `:393-398` solo
hace `logger.warn('sat.marcar_fallo')` y **no toca `r.errores`**, así que el
latido de `descarga-sat` sale `'ok'` con el ECC en la cola equivocada y ningún
humano enterado.

**Intenté refutarlo por cuatro lados y ninguno sostiene.** (1) `grep -n
"marcar(" ciclo.ts` da cinco llamadas, todas dentro de `ingerir`; no hay otro
escritor automático de `estatus` (los de `resolucion.ts` son actos humanos).
(2) `barrerPorConciliar` (`consolidado.ts:749`) solo mira
`cfdi_consolidado_linea`, nunca `sat_cfdi_descargado`. (3) El CHECK
`sat_cfdi_descargado_casado_coherente` no impide nada aquí: `disponible` +
`gasto_id null` es un estado perfectamente legal. (4) **Las tres pruebas que
`d0db998` añadió (`ciclo_flota.test.ts:511-567`) comprueban que
`guardarYConciliarConsolidado` VUELVE A SER LLAMADA y que el error se reporta —
ninguna afirma nada sobre el `estatus` final del sello.** El hueco quedó
exactamente donde la prueba no mira.

Consecuencia: el contralor —el comprador— ve el comprobante fiscal más grande
del mes en la cola que su propia pantalla define como «alguien gastó y nadie lo
reportó», y el sistema le ofrece un botón que o revienta con SQL crudo o le mueve
$200,000 de acreditamiento al gasto equivocado.

Causa raíz probable: `d0db998` reusó `yaDescargado` para dos preguntas distintas
—«¿cuento este CFDI como repetido?» y «¿ya quedó registrado qué se hizo con
él?»— y el cierre hacia el humano (`marcar`) se quedó colgado de la primera.

---

### [ALTO] Un consolidado cuya conciliación lanza se da por bajado, avanza el calendario fiscal y no se reintenta NUNCA — y el único rastro es un entero en el latido

`src/lib/likida/sat_descarga/ciclo.ts:348-350` (el `catch` empuja a
`r.errores` y `continue`) · `:383-384` (`ingerir` devuelve `{completo: true}`
aunque haya errores) · `:650` (`if (resultado.completo) bajados.push(p)`) ·
`:594,677-699` (`todoBien` nunca lo tocan los errores → `estado: 'descargada'`
y `ultima_descarga_hasta` avanza) · `src/app/api/cron/descarga-sat/route.ts:155`
(`const errores = descarga.resumenes.reduce((n, r) => n + r.errores.length, 0)`)
· `:156-171` (`registrarLatido('descarga-sat', 'parcial', { …, errores, … })` —
**el número, nunca los textos**) · `src/lib/likida/intake/consolidado.ts:527-539`
(el `throw` que lo produce).

**Escenario, con valores.** Mismo ECC `9f3c…a1`, 412 líneas.
`guardarYConciliarConsolidado` llega hasta `:495-503` y liga 380 gastos; el
`upsert` de las 412 filas de `cfdi_consolidado_linea` (`:527`) se topa con el
tope de `acotada` (`TOPE_CONSULTA_MS`) y devuelve error → `:538` lanza.

- `ciclo.ts:349` empuja la cadena `"El consolidado 9f3c…a1 no se pudo conciliar:
  guardarYConciliarConsolidado: no se pudieron guardar las líneas — sin
  respuesta en N ms (tope de consulta)"`.
- `ingerir` **igual devuelve `{completo: true}`** → `bajados.push('p1')` →
  `todoBien` sigue en `true` → la solicitud pasa a `'descargada'` y
  `ultima_descarga_hasta` **avanza al 31 del mes**. El paquete no se vuelve a
  bajar nunca: no hay retroceso de calendario en este diseño (lo dice el propio
  comentario de `:691-693`).
- Lo que queda en la base: **380 gastos con `cfdi_uuid = 9f3c…a1` y
  `xml_verificado = true`, y CERO filas en `cfdi_consolidado_linea`.** Esos
  gastos no están en ninguna cola: `barrerPorConciliar` barre líneas, y no hay
  líneas. El comprobante sigue `'disponible'` en la bandeja (mismo estado que el
  CRÍTICO de arriba, por otro camino).
- Lo que ve un humano: el latido de `descarga-sat` en `/admin/crons` dice
  `'parcial'` con `errores: 1`. **El texto del error no viaja a ningún lado** —
  `registrarLatido` recibe el conteo; la cadena solo existe en el cuerpo JSON de
  la respuesta HTTP de un cron que nadie lee. No hay `alertarOperador` para
  errores por flota (solo para el `catch` de la ruta entera, `:178-185`).

Consecuencia: el mes de diésel más caro del año queda medio conciliado,
irreversiblemente fuera del alcance de cualquier reintento automático, y la única
señal es un `1` junto a un `parcial` en un tablero — indistinguible del `1` de un
XML ilegible del mismo paquete.

Causa raíz probable: `ingerir` trata «este CFDI falló» y «este paquete terminó»
como hechos independientes, y solo el segundo decide si el trabajo se da por
hecho.

---

### [ALTO] El reintento que `d0db998` habilitó puede revertir la resolución HUMANA de una línea: la puerta de idempotencia de `guardarYConciliarConsolidado` falla ABIERTA

`src/lib/likida/intake/consolidado.ts:421-439` (el `try/catch` que deja
`existentes = null` y **sigue**) · `:440-443` (la salida temprana que ese bloque
dice ser) · `:477-483` (el JOIN se re-corre para toda línea sin gasto sellado) ·
`:505-529` (`upsert … { onConflict: 'cfdi_xml_id,indice' }`, con `estatus` en el
payload) · `:609-618` (`resolverLineaAMano` → `estatus = 'sin_match'`, sin sellar
ningún gasto) · `src/lib/likida/sat_descarga/ciclo.ts:340-341` (el llamador
nuevo).

Antes de `d0db998`, un consolidado ya sellado **no volvía a entrar nunca** a esta
función desde el ciclo del SAT. Ahora entra en cada re-ingesta del paquete. Eso
convierte un `catch` que antes casi no se alcanzaba en un camino vivo.

**Escenario, con valores.**

1. **Día 1.** El ECC se concilia. La línea `indice = 7` (`monto = 1,842.50`,
   `fecha = 2026-08-14`) sale con dos candidatos → `estatus = 'por_conciliar'`.
2. **Día 2.** El contador Luis abre *Combustible & Casetas*, mira la línea y
   declara **«ninguno corresponde»** → `resolverLineaAMano(..., {tipo:
   'sin_match'})` escribe `estatus = 'sin_match'`, `resuelto_por = 'luis@…'`,
   `resuelto_en = 2026-09-02T11:04Z`. **Ningún gasto queda sellado con
   `cfdi_orden = 7`** — es la definición de `sin_match` (0077).
3. **Día 3.** El reloj corta `ingerir` en el CFDI 1,900 de 2,000 del mismo
   paquete; el paquete no se marca bajado y la corrida siguiente lo re-baja
   (REND-A3, el camino normal). El ECC vuelve a pasar por el bloque
   `consolidado`, ahora sí (fix de `d0db998`).
4. **Dentro de `guardarYConciliarConsolidado`:** la lectura de `existentes`
   (`traerTodo` sobre `cfdi_consolidado_linea`, 412 filas = 1 página, pero bajo
   la misma carga que acaba de agotar el reloj) devuelve el error de tope de
   `acotada` → `exigir` lanza → **`catch` de `:434-439`: `existentes = null`,
   `logger.warn`, y se sigue**. La salida temprana de `:440` no se toma.
5. `yaSellados` no contiene el índice 7 (nunca se selló). El JOIN se re-corre
   para él contra `candidatosDb` **de hoy**, y hoy solo queda un gasto que
   empata ($1,842.50, 2026-08-15) porque el otro ya se ligó por otro camino →
   `candidatos.length === 1` → `conciliarLineas` devuelve **`conciliada`**.
6. `ligarLineaAGasto` sella ese gasto (`cfdi_uuid`, `cfdi_orden = 7`,
   `xml_verificado = true`) y el `upsert` de `:527` pisa la fila de la línea con
   `estatus = 'conciliada'`. **`resuelto_por` y `resuelto_en` NO están en el
   payload, así que no se tocan:** el expediente queda diciendo que *Luis
   resolvió esta línea el 2 de septiembre* — ligada al gasto que Luis
   explícitamente descartó.

Consecuencia: un veredicto humano firmado se revierte en silencio, el expediente
queda atribuyéndole al contador una decisión que no tomó, y el gasto queda con
`xml_verificado = true`, que es lo que `cuadre/engine.ts:1248` usa para abrir
todo el bloque de acreditamiento. Nadie recibe un mensaje: el único rastro es un
`logger.warn('consolidado.lineas_existentes_ilegibles')`.

No es refutable por el bloque de reanudación: ese bloque protege explícitamente
las líneas **cuyo gasto quedó sellado** (`:445-470`), y `sin_match` es por
definición la resolución que no sella ninguno. El propio comentario de `:434-437`
afirma que «el error de lectura conserva su camino de siempre (seguir al JOIN,
que la reanudación de abajo protege)» — la reanudación no la protege.

Causa raíz probable: la puerta que declara «este CFDI ya se procesó» falla
abierta, y el mecanismo que la respalda reconoce el trabajo hecho por la máquina
(el sello en `gasto`) pero no el hecho por el humano (`sin_match`).

---

### [MEDIO] La alarma «ticket sin una sola respuesta» la apaga un segundo usuario de la propia flota — incluido el superadmin que solo entró a ver la pantalla del cliente

`src/lib/likida/agentes/exito.ts:1372-1379` (`cuentaComoRespuesta`: el único
criterio es `m.autorId !== solicitanteId`) · `:1398` (`sinRespuesta =
tickets.filter((t) => t.respuestas === 0)`) · `:1411,1419` (lo que el parte
afirma) · `src/lib/likida/soporte.ts:280-285` (`responderTicket` firma con
`actor.userId`, sea de Likida o de la flota) ·
`src/app/dashboard/soporte/page.tsx:111-116,121-125` (el action del cliente) ·
`supabase/migrations/0051_soporte_y_cotizacion.sql:59-69` (`ticket_mensaje` **no
tiene ninguna columna que diga de qué lado está el autor**).

El parte de soporte afirma por escrito, en `:1419`: *«Sin respuesta» cuenta SOLO
mensajes públicos (interna=false) de un autor distinto del solicitante: ni la
nota interna del equipo ni el «¿alguna novedad?» del propio cliente apagan la
alarma.* Y `dashboard/soporte/page.tsx:111-116` razona que responder desde el
panel del cliente **no** cuenta como respuesta de Likida, «que es justo la
diferencia que se perdería si este action pudiera hablar como Likida». Las dos
afirmaciones son falsas para cualquier segundo usuario.

**Escenario, con valores.** Flota Innovativos, `tenant_id = 11111111-…`.
Ana (`flota_admin`, `app_user 7a2f…`) abre el ticket *«No me llega el PDF de
la liquidación V-4410»* el lunes 08:10 → `ticket_soporte.abierto_por = 7a2f…`,
`vence_en = martes 08:10`. Nadie de Likida lo toca.

- **Lunes 15:40.** Luis (`contador`, `app_user c918…`) entra a
  `/dashboard/soporte` y escribe *«esto nos está frenando el cierre de
  nómina»*. `responderTicket` inserta `ticket_mensaje(autor_id = c918…,
  interna = false)`.
- **Cron de éxito, lunes 16:00.** `cuentaComoRespuesta({autorId: 'c918…',
  interna: false}, '7a2f…')` → `interna` no, `autorId` no es null, `c918… !==
  7a2f…` → **`true`**. `respuestas = 1`.
- **El parte del día** (`:1404,1411`) sale con `sin una sola respuesta 0` y la
  línea del ticket dice **`· 1 respuesta(s)`** en vez de `· SIN RESPUESTA`.
  Javier lee su bandeja y concluye que alguien ya contestó. Nadie contestó.
- La variante peor es más fácil todavía: Javier mismo, previsualizando
  `/dashboard/soporte` de esa flota (el action usa `{tipo: 'flota', userId:
  sesion.userId}` **con su propio id de superadmin**), escribe «viéndolo» — y
  apaga la señal que él mismo iba a leer, en el camino que el comentario del
  archivo dice haber diseñado para que eso no pase.

El semáforo por SLA (`semaforoTicket`) sigue funcionando, y por eso esto es
MEDIO y no ALTO: un ticket con SLA pactado igual sale como `VENCIDO`. Pero los
tickets **sin SLA pactado** (`venceEn === null` → `SIN_SLA`, que no escala) solo
tienen esta señal, y para ellos queda apagada.

Causa raíz probable: «de qué lado está el autor» se derivó de `autor_id !==
abierto_por`, que responde una pregunta distinta —«¿es el solicitante?»— y
`ticket_mensaje` no guarda el dato que de verdad hace falta.

---

## Lo que revisé y está bien

Abierto y leído en esta ronda, con el fuente delante:

- **El corte por reloj de `ingerirRep` y su acuse** — `intake/rep.ts:209-215`
  (corte antes de arrancar cada docto, acumulando lo que falta de TODOS los
  pagos restantes), `:272-293`. Ancla viva: `intake/rep.test.ts:244`. **45
  pruebas verdes corridas hoy** sobre `rep.test.ts`,
  `sat_descarga/ciclo_flota.test.ts` y `intake/consolidado_orquestador.test.ts`.
- **Los tres relojes de `ciclo.ts` cortan en el punto correcto y lo dicen.**
  `:522-528` (antes de `prov.verificar`, cuando no se le debe nada a nadie),
  `:622-629` (antes de quemar cuota del SAT — el comentario de `:598-621`
  razona por qué `todoBien = false` no es opcional, y el código lo hace),
  `:855-862` (frontera entre flotas). Los tres suman a `sinTurno`, y
  `cron/descarga-sat/route.ts:153-155` lo traduce a `'parcial'`, nunca `'ok'`.
- **La reanudación por paquete de `paquetesYaBajados`** (`ciclo.ts:411-414`):
  cualquier cosa que no sea un arreglo de textos se descarta con aviso en vez de
  adivinar — «dar por bajado un paquete que no se bajó» no tiene protección
  aguas abajo y el código lo sabe.
- **`contarNuevosDeSolicitud` devuelve `null`, no 0**, y el llamador (`:682-688`)
  deja la columna como estaba en vez de escribir un cero que nadie midió.
- **`traerTodoDesdeId` para `candidatosDb`** (`pg.ts:251-279`, `consolidado.ts:342-356`):
  el cursor por `id` es correcto y la salida por página vacía (`:268-272`) es la
  diferencia legítima con `traerTodo` — con cursor por fila, vacío es vacío, y
  las filas que salieron del filtro (un gasto al que WhatsApp le pegó su CFDI a
  media paginación) deben salir. Si el ciclo muere entre páginas no queda nada a
  medias: es una lectura, y la corrida siguiente la rehace entera.
- **`carta_porte_wa.ts` de punta a punta** (primera vez que se camina, tercera
  ronda que estaba fuera): el candado de rol va ANTES de tocar nada (`:273`); el
  `tenantId` sale de la cuenta, jamás del texto del botón; el cruce de tenants
  está cerrado por `declararCcp` (`carta_porte_datos.ts:285-287`), que lanza
  `DatoInvalido` cuando el UPDATE no afecta filas y `atenderCcpOficina:301`
  devuelve ese mensaje al humano; `ccp_si` preserva el radio ya medido
  (`:286-297`) y `ccp_no` lo limpia porque la pareja «no pisa + radio» es la
  contradicción que `validarDeclaracion` rechaza; y la palanca apagada
  **contesta la verdad** («esta respuesta NO quedó registrada») en vez de callar
  (`:262-264`).
- **`resumenCuadre` y el destinatario** (`cuadre/resumen.ts:45-54,86-101,120-123`):
  `SOLO_CONTRALOR` se filtra ANTES de contar, así que el «…y N observaciones
  más» cuenta sobre la lista ya filtrada y no le promete al chofer algo que no
  va a ver; `complemento_no_verificable` está deliberadamente FUERA de la lista
  con su razón escrita; el descargo legal solo va al contralor. El único
  llamador desde WhatsApp (`guardia.ts:152`) pasa `'operador'` explícito.
- **`guardiaCifras` con snapshot de cierre** (`guardia.ts:88-91,137-143`): sin
  snapshot **no se recalcula** — se dice «Ya cerré tu liquidación ✅» y se manda
  el PDF. Ningún camino puede narrar un cuadre distinto del impreso.
- **La transacción de ligado a mano** (`0263_ligar_cfdi_sat_transaccional.sql:78-140`):
  las dos escrituras y el renglón del expediente son una unidad, los dos
  `for update` anclan al estatus leído, y los tres SQLSTATE propios (CU001,
  CU014, CU015) se traducen a frases que dicen qué hacer. Es el modelo de cómo
  debería cerrarse un ciclo en este repo — y por contraste hace más visible el
  CRÍTICO de arriba.
- **`tomarTicket` ancla su claim** (`soporte.ts:347-364`): el `.or('asignado_a.is.null,
  asignado_a.eq.<actor>')` hace que dos superadmin que pulsan «Tomar» a la vez
  no reciban los dos un éxito, y el perdedor lee **quién** lo tiene.
- **El copiloto rescata la tarjeta de acción antes de que el `finally` limpie el
  mapa** (`copiloto.ts:353-383`) y **borra `CAPTURAS` antes del reintento
  correctivo** (`:276`), que era el bug de leer los bloques del primer ciclo
  después de haberlos rechazado.
- **`intakePendientes` dejó de ser una escritura** (`conv.ts:1082-1106`) y trata
  el contador vencido por TTL como 0 con su log, no en silencio; `esperarIntake`
  (`:1156-1167`) trata `null` como «no sé» y no abre.

## Lo que NO alcancé a revisar

- **Los 45 motores de agente** (`agentes/{backoffice,direccion,crecimiento,…}.ts`):
  esta ronda abrí `exito.ts` (soporte) por primera vez y ahí salió un hallazgo;
  los demás siguen sin caminar. Tercera ronda.
- **`copiloto-tools.ts` (cross-tenant) y `copiloto-historial.ts`**: quinta ronda
  fuera. Abrí `copiloto.ts` entero, no el catálogo de tools.
- **`agentes/enviador.ts` y la cadencia de campaña bajo concurrencia real.**
- **La ráfaga bajo concurrencia real** (mutex de viaje + barrera): leí
  `intakePendientes`/`esperarIntake`/`intentarLockViaje`, pero no monté dos
  invocaciones solapadas. Sexta ronda sin rehacerlo.
- **`sat_descarga/peaje_cierre.ts`**: comparte `venceEn` con la descarga y es la
  otra mitad de esa ruta; solo lo miré desde el lado del reloj.
- **Nada que exija base viva.** Los tres hallazgos de `sat_descarga` se
  argumentan sobre el fuente, las migraciones y las pruebas existentes; el
  `23505` del punto 5 del CRÍTICO se deriva de `uq_gasto_cfdi_uuid`
  (`0065:69`) leído, no ejecutado.
- **No corrí la suite completa** (la corre el orquestador). Corrí puntualmente
  los tres archivos citados arriba (45 pruebas, verdes) para confirmar que leo
  el árbol vivo.
