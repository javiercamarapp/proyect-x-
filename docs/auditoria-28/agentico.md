# Sistema agéntico y orquestación — auditoría 28

**Nota: 4/10** (antes 5). Razón del movimiento: **mirada más profunda.** No es
que empeorara: el código de este rubro no recibió un solo commit en la ventana
(`git log 06b2eca4..HEAD -- src/lib/agents/ src/lib/likida/` → **0 commits**), y
los nueve hallazgos de la 27 siguen ahí, línea por línea. Lo que cambió es lo
que se vio. Esta ronda caminé el ciclo que llevaba **tres rondas listado como
pendiente y que ningún auditor había abierto**: el canal de correo de los
agentes, de punta a punta — emisor → anti-ruido → persistencia → pantalla
(`agentes/notificaciones.ts`, 1,095 líneas; sus dos emisores reales; la
migración 0097; y la sección que el cliente lee). Ahí sale que **dos de los
cuatro pares (agente, evento) cableados nunca cierran su incidente**, así que su
correo se apaga para siempre después del primero — y la pantalla le afirma al
dueño, por escrito, exactamente lo contrario. Ese es el estado que la escala del
rubro puntúa por debajo de 5: la base dice una cosa y el usuario cree otra, con
la pantalla de por medio. La nota anterior estaba inflada porque esa mitad del
rubro nunca se había abierto.

**El riesgo mayor hoy** sigue siendo el de la 27 —la liquidación que se
reentrega texto y PDF una vez por cada «gracias» del chofer, que es lo primero
que un contralor ve en el demo (ALTO-1)—. El de esta ronda es el más silencioso
del rubro: el único canal de correo que Likida le da a la flota se muere solo,
sin ruido, y el panel jura que sigue vivo.

---

## Verificación de lo que venía abierto (abrí los nueve, uno por uno)

| Hallazgo de la 27 | Dónde | Veredicto hoy |
|---|---|---|
| CRÍTICO · `ingerirRep` sin reloj ni tope | `intake/rep.ts:190-241` | **REINCIDENTE, sin tocar** |
| ALTO · el cierre se reentrega sin techo | `processor.ts:1096-1118` · `avisar_cierre.ts:180-226` | **REINCIDENTE, sin tocar** |
| ALTO · el varado fuera de ventana salta a nivel 4 | `asistencia_escalamiento.ts:72-79,240-262` | **REINCIDENTE, sin tocar** |
| ALTO · los relojes legales sellan con un solo canal | `relojes_legales.ts:269-289` | **REINCIDENTE, sin tocar** |
| ALTO · la cotización de la grúa al jefe equivocado | `asistencia_coordinacion.ts:645-666` | **REINCIDENTE, sin tocar** |
| MEDIO · `ticket_soporte.vence_en` sin escritor | `comercial.ts:713-720` | **REINCIDENTE, sin tocar** |
| MEDIO · «Tu jefe ya lo sabe» en violencia sin respaldo | `asistencia_wa.ts:463,574` | **REINCIDENTE, sin tocar** |
| BAJO · el resumen de ráfaga por `sendText` (5ª ronda) | `processor.ts:1252,3031` | **REINCIDENTE, sin tocar** |
| BAJO · previsualización del copiloto sin validar objetivo | `copiloto.ts:81` | **REINCIDENTE, sin tocar** |

Los nueve están abiertos y los verifiqué **abriendo el archivo**, no por el log:
`relojes_legales.ts:269` sigue teniendo un solo `alguienRecibio` para dos
canales; `asistencia_escalamiento.ts:74` sigue derivando el nivel de
`ahora − abiertaEn` sin mirar `notificar_desde`; `asistencia_wa.ts:463` sigue
devolviendo `'Recibido. Tu jefe ya lo sabe.'` sin consultar `avisado`;
`comercial.ts:713-720` sigue insertando seis columnas sin `vence_en`;
`rep.ts:190-241` sigue sin un solo chequeo de reloj dentro del bucle. **Cero
cierres esta ronda.** Sus escenarios con valores están en
`docs/auditoria-27/agentico.md` y no los repito: repetirlos no informa a nadie.

---

## Hallazgos

### [ALTO · NUEVO] Los dos avisos que la auditoría 4 cableó nunca cierran su incidente: después de tres correos, `escalado` y `cola_atorada` quedan mudos PARA SIEMPRE — y la pantalla le promete al dueño que «la cuenta vuelve a cero en cuanto el problema se resuelve»

`src/lib/likida/escalar_viaje.ts:483` (`if (c.folios.length > 0)`) · `:487`
(`{ hayProblema: true, magnitud: c.folios.length }`) ·
`src/app/api/cron/facturar/lote.ts:893` (`for … of bloqueadosPorFlota`) · `:897`
(`{ hayProblema: true, magnitud: bloqueados.length }`) ·
`src/lib/likida/agentes/notificaciones.ts:922-924` (`cerrarIncidente` es
alcanzable **solo** desde `!estado.hayProblema`) · `:515-522` (el corte por
marca) · `:890-892` (la doctrina que esto incumple) ·
`src/app/dashboard/agentes/notificaciones-forma.tsx:300-307` (el rótulo).

`avisar(...)` se llama con literal `hayProblema: true` en los **dos únicos**
sitios de todo `src/` que emiten estos eventos, y solo cuando hay algo que
contar (`folios.length > 0`, `bloqueadosPorFlota`). `cerrarIncidente` —la única
escritura que pone `magnitud = 0` y re-arma el filo— vive dentro de la rama
`if (!estado.hayProblema)` de `avisar` (`:922`). Conclusión mecánica: para las
filas `(tenant, 'conductores', 'escalado')` y `(tenant, 'facturas',
'cola_atorada')` de `agente_notificacion_estado`, **`magnitud` nunca vuelve a
0**. Y como `incidenteCerrado` (`:931`) se calcula precisamente con
`previo.magnitud === 0`, la degradación de huella (`:816`) tampoco corre nunca:
`magnitud_avisada` solo sube, jamás baja.

Escenario, con valores. Cron `/api/cron/escalar`, `7 * * * *` (horario).
Innovativos enciende «El agente escaló un caso» en
`/dashboard/agentes/conductores` (el default no lo trae; hay que marcarlo).

- **Lun 10:07** — 2 viajes llevan 5 h sin que ningún chofer los acepte.
  `porFlota` → `folios: ['V-4410','V-4411']`. `avisar(..., magnitud: 2)`.
  `previo === null` → `ultimo === null` → `debeAvisar` devuelve
  «primera vez» → claim → **correo**. Fila: `magnitud = 2`,
  `avisado_en = lun 10:07`, `magnitud_avisada = 2`.
- **Mar 10:07** — 3 viajes sin aceptar. `magnitud = 3`.
  `marcaAlcanzada(3) = 0`; `marcaAlcanzada(2) = 0`. `0 <= 0` (`:515`) → **no
  sale nada**. El `porque` que devuelve es, literal: *«ya se avisó con 2; el
  siguiente sale al llegar a 5 o cuando esto se resuelva y reaparezca.»*
- **Los seis meses siguientes** — mientras ninguna corrida suelta escale ≥5
  viajes de golpe, no sale un solo correo más. Si algún día una corrida escala
  6, sale el segundo; si otra escala 21, el tercero. **Después de ese tercero,
  `magnitud_avisada = 21` y `marcaAlcanzada` no tiene un cuarto escalón: la
  fila queda muda de forma definitiva.** «Cuando esto se resuelva y reaparezca»
  es una condición que ningún código puede cumplir, porque no existe un
  llamador que pase `hayProblema: false` para este evento.

Idéntico para `facturas:cola_atorada` (cron `*/15`): la primera corrida que
bloquee ≥20 tickets por `requiere_cuenta`/CAPTCHA manda su correo y apaga el
evento para esa flota de por vida.

Y hay una agravante que hace que ni siquiera haga falta llegar a la marca 20:
`reclamarAviso` (`:835-850`) sella `avisado_en` y `magnitud_avisada` **antes**
del `enviarCorreo` (`:969`). Si Resend devuelve un 429 en ese único correo del
lunes, `envio.ok` es `false`, se registra un `logger.warn` (`:971`) y la fila
queda igual que si hubiera salido. Para `corrida_fallida` eso es un peaje
acotado —el filo se re-arma en cuanto el agente vuelve a trabajar bien—; para
estos dos eventos **no hay segunda oportunidad**: el único correo de la vida de
esa flota se lo comió un HTTP 429 y nadie más que el log se enteró.

Lo que lo convierte en un rótulo falso, y no solo en una decisión discutible:
`notificaciones-forma.tsx:300-307` le dice al dueño, para **todos** los eventos
por igual y sin distinguir cuál, que llegan «3 como máximo **por incidente**» y
que «**la cuenta vuelve a cero en cuanto el problema se resuelve, así que el
siguiente incidente te avisa desde el primero**». Para dos de los cuatro pares
cableados esa frase es falsa: son 3 como máximo **de por vida**, y la cuenta no
vuelve a cero nunca. El propio módulo lo tiene escrito como su regla, en
`notificaciones.ts:890-892`: *«SE LLAMA EN TODA CORRIDA, salga bien o mal […]
Un agente que solo llama cuando falla nunca vuelve a avisar de su segundo
incidente»* — y en `:1063-1068`, donde `avisarCorridasPorFlota` existe
literalmente para no cometer este error con `corrida_fallida`. Los dos emisores
nuevos no pasan por ahí.

Intenté refutarlo por tres lados y ninguno sostiene: (1) `grep -rn "avisar("
src/` da exactamente estos dos llamadores directos, ambos con `hayProblema:
true` literal, y la prueba `facturar/route.test.ts:638` fija esa forma;
(2) ninguna otra parte de `src/` escribe `agente_notificacion_estado` —solo
`notificaciones.ts:746,784,811,840`—; (3) no hay purga ni TTL: `0102` solo
declara `purgar_agente_corrida`, sobre otra tabla. El comentario de
`lote.ts:884-887` sí razona por qué no cierra («una corrida sin bloqueos nuevos
no sabe si la cola vieja ya la atendió una persona»), y ese razonamiento es
correcto para el cierre — pero deja el filo sin re-armar y nadie cerró el
círculo con el anti-ruido, que es donde muerde.

Consecuencia: el dueño de la flota marca la casilla, la pantalla le contesta
«Hoy le llega a: Ana Pérez», recibe un correo, y a partir de ahí el canal está
apagado sin que nada lo diga — mientras sus viajes se siguen escalando cada
hora porque nadie los acepta, y sus tickets de facturación se siguen bloqueando
cada 15 minutos. Es el modo de falla que `EVENTOS.corrida_fallida.porQue`
(`notificaciones.ts:148-149`) describe como «el más caro […] porque su síntoma
es que NO pasa nada», aplicado al canal que existe para detectarlo.

Causa raíz probable: el anti-ruido tiene DOS entradas (magnitud y cierre) y los
dos emisores cableados en la auditoría 4 solo alambraron la primera; `avisar`
no exige la segunda ni la echa de menos.

---

### [MEDIO · NUEVO] El diferimiento por piso de un incidente nuevo se destruye a sí mismo en la misma llamada: promete «sale en 30 min» y el aviso se retrasa cuatro corridas más

`src/lib/likida/agentes/notificaciones.ts:927` (`leerEstado`) · `:931`
(`incidenteCerrado = previo.magnitud === 0`) · `:935-938` (`guardarMagnitud`,
que pisa esa misma señal) · `:501-509` (la rama del piso) · `:515-522` (el corte
por marca que se la come en la corrida siguiente).

`incidenteCerrado` es la señal de «esto es un incidente NUEVO, sus marcas no
cuentan». Se lee de `previo.magnitud === 0`. En la misma llamada,
`guardarMagnitud` escribe `magnitud = 1` — así que en la corrida siguiente
`previo.magnitud` ya vale 1 y la señal **desapareció**. Si la corrida que la
tenía no llegó a mandar el correo porque el piso de 60 min la frenó
(`:503-508`), esa información se pierde para siempre.

Escenario, con valores. Cron `/api/cron/facturar`, `*/15`:

- **10:00** falla → `magnitud 1`, `ultimo === null` → **correo**. Fila:
  `magnitud 1`, `avisado_en 10:00`, `magnitud_avisada 1`.
- **10:15** corrida OK → `cerrarIncidente` → `magnitud 0` (la huella se queda).
- **10:30** falla otra vez (incidente B) → `incidenteCerrado = true`,
  `magnitud 1`, `degradarHuella` → `magnitud_avisada = 1`. Piso: han pasado 30
  de 60 min → no sale, y el veredicto dice literalmente *«es un problema nuevo,
  pero el aviso anterior salió hace menos de una hora: sale en 30 min»*.
- **10:45** falla → `previo.magnitud` ya es 1, no 0 → `incidenteCerrado = false`
  → cae al corte por marca: `marcaAlcanzada(2) = 0 <= marcaAlcanzada(1) = 0` →
  **no sale**. Tampoco a las 11:00 (`magnitud 3`) ni a las 11:15 (`magnitud 4`).
- **11:30** — `magnitud 5`, cruza la segunda marca → sale.

O sea: el aviso prometido para las 11:00 llega a las 11:30, y solo porque el
agente siguió cayéndose cada 15 minutos. La rama gemela del mismo `debeAvisar`
—el piso sobre un incidente vivo, `:526-532`— **sí** conserva la información, y
su comentario lo dice con todas sus letras (`:380-381`: *«No pierde información:
la marca cruzada sigue cruzada, así que el aviso sale en la siguiente evaluación
pasada la hora»*). La rama de incidente cerrado no cumple esa promesa, y la
asimetría no está declarada en ninguna parte.

Refutación que intenté: `notificaciones_parpadeo.test.ts:206-230` cubre este
caso… pero lo cubre con un bucle que falla **cada 5 minutos durante dos horas**,
así que la magnitud alcanza la marca 5 dentro de la misma hora y el retraso
queda escondido detrás del piso. Con la cadencia real del cron (15 min) el
retraso son cuatro corridas; con la de `/api/cron/escalar` (horaria) el piso
casi nunca muerde, pero cuando muerde el retraso son cinco horas.

Consecuencia: el contralor recibe el aviso de que su agente lleva media hora
caído media hora tarde, y el texto que el motor devolvió con la hora exacta era
falso. Es acotado —el aviso sí acaba saliendo—, pero es la misma familia que el
ALTO de arriba: el estado que dice «pendiente» no lo está.

Causa raíz probable: el esquema representa «incidente nuevo» con `magnitud = 0`
y la primera escritura de la corrida borra ese cero antes de que se decida si el
aviso salió o solo se difirió.

---

### [BAJO · NUEVO] `nada()` devuelve `destinatarios: 0` incluso cuando el reparto sí tenía gente, así que el porqué que el motor entrega no distingue «no hay a quién» de «había cinco y el correo rebotó»

`src/lib/likida/agentes/notificaciones.ts:906-907` (`nada` fija
`destinatarios: 0`) · `:955` (veredicto negativo) · `:972` (envío fallido, con
`reparto.reciben.length` en la mano).

Cuando `enviarCorreo` falla, `avisar` devuelve
`{ avisado: false, porque: 'el aviso no se pudo entregar (rechazado).',
destinatarios: 0 }` — pero `reparto.reciben` tenía 5 correos. El único consumidor
de hoy es el log, así que el daño es de mantenimiento, no de producto: quien
cablee mañana esta salida a la pantalla («a cuánta gente le llegó») va a pintar
un 0 que significa dos cosas opuestas, que es exactamente la distinción que
`seccion-notificaciones.tsx:40-42` declara como regla del archivo («la primera se
arregla mirando el log, la segunda capturando correos»). Deuda pequeña, en el
archivo que más cuida esa distinción.

---

## Lo que revisé y está bien

Todo esto lo abrí en esta ronda y salió limpio:

- **`debeAvisar` como función pura** (`notificaciones.ts:470-538`): el orden de
  los cortes es el correcto (canal → interruptor → destinatarios → problema), el
  `Math.max(1, …)` de `:489` redondea hacia el aviso y no hacia el silencio, y
  cada rama devuelve un porqué distinto. Es probable sin base y lo está.
- **La huella de dos columnas y su CHECK** (`0097` +
  `notificaciones.ts:753-761`): `avisado_en` y `magnitud_avisada` van juntas o no
  van, en el código Y en la base (`agente_notif_huella_completa`), con el
  razonamiento escrito de por qué una huella a medias equivaldría a apagar el
  anti-ruido. El doble de prueba (`notificaciones_parpadeo.test.ts:32-40`) valida
  los mismos CHECK, así que ninguna prueba puede pasar sobre un estado que
  Postgres rechazaría — es el mejor doble de base del rubro.
- **`reclamarAviso` como claim contra Postgres** (`:835-850`): el `.or(avisado_en
  is null | < ahora−1h)` mueve la decisión al motor, así que dos corridas
  solapadas de Vercel Cron (*at-least-once*) no pueden mandar dos correos
  iguales. El `select('tenant_id')` para contar filas afectadas es la forma
  correcta con PostgREST.
- **El dominio de `agente` migrado de CHECK a FK** (`0204:94-107`): fui a
  buscar el fallo obvio —`carta_porte` entró al catálogo TS el 25-ago y los
  CHECK de la `0097` solo enumeran seis agentes, así que
  `guardarConfigNotificaciones` habría reventado con un 23514 y la pantalla
  habría dicho «Inténtalo de nuevo» para siempre— y **ya está resuelto**: la
  0204 tira los dos CHECK y los sustituye por una FK contra
  `agente_definicion`. Refutación limpia.
- **`usuariosAvisables`** (`:699-735`): el `.order('id')` antes del `.limit(200)`
  (FE-34) y el doble filtro de `activo` —en la consulta y en el `.filter` del
  cliente, solo el `false` explícito da de baja— siguen puestos, y el cierre de
  la auditoría 25 aguanta.
- **`repartoDe`** (`:586-624`): el orden de las causas de exclusión es el que
  declara (lo no accionable primero), la deduplicación por correo en minúsculas
  evita el doble envío a la misma bandeja, y el tope de 20 se declara en vez de
  recortar en silencio.
- **`puedeConfigurarAvisos`** (`:271-285`): una sola puerta para las seis
  páginas, con `puedeAdministrar` **y** el cruce de tenant, y la excepción de
  superadmin declarada. El cierre de FE-27 sigue en pie.
- **`validarConfigNotificaciones`** (`:311-341`): el segundo filtro por
  `tieneEmisor` (`:327`) impide guardar encendido un evento sin emisor incluso
  ante un POST fabricado, y el único error duro —encendido sin destinatarios— es
  el correcto.
- **`avisarCorridasPorFlota`** (`:1084-1095`): `allSettled` sin propagar, y las
  flotas que el corte por reloj dejó fuera NO entran al mapa (verificado en
  `cobranza.ts:462` y en el `for` de `escalar_viaje.ts:274-280`), que es lo que
  impide borrar una racha real sin haber arreglado nada.
- **El `finally` del cron de facturación** (`lote.ts:796-814`): fui a comprobar
  si el camino de fallo duro (`if (arranco) throw e`) deja alguna flota sin
  entrar al mapa, y no: `:673` y `:687` hacen el `corridas.set` dentro del catch
  por flota, y el `finally` corre igual cuando el catch exterior devuelve el 500.
- **`enviarCorreo` con lista de destinatarios** (`correo/enviar.ts:143`): pone
  todos en `to:`, y me detuve a mirar si eso expone correos entre flotas. No: el
  reparto es siempre dentro de un solo `tenant_id` y esas cuentas ya se ven entre
  sí en `/dashboard/usuarios`. No es hallazgo.

## Lo que NO alcancé a revisar

- **Los nueve reincidentes NO los re-caminé entero**: los abrí para confirmar que
  siguen ahí (lectura del fuente, no `git log`), pero elegí gastar la ronda en un
  ciclo nuevo en vez de reescribir sus escenarios. Siguen válidos tal como los
  dejó la 27.
- **`copiloto-tools.ts` (412 líneas cross-tenant) y `copiloto-historial.ts`** —
  tercera ronda fuera.
- **`asistencia_camara.ts`, `carta_porte_wa.ts`, `admin_comandos_wa.ts`**: sus
  ciclos completos siguen sin caminarse.
- **Los 45 motores de agente** (`agentes/{backoffice,direccion,crecimiento,…}.ts`):
  audité el despacho en rondas previas, no lo que cada motor hace con su `venceEn`.
- **La ráfaga bajo concurrencia real** (`conv.ts` mutex + barrera): reusé la
  verificación de la 26, cuarta ronda sin rehacerla.
- **`registrarCorrida` / `agente_corrida` (0102)** — la bitácora que la pantalla
  del agente pinta junto a estas notificaciones. La vi pasar en los dos crons,
  no la abrí.
- **No corrí la suite ni la compuerta.** Todo lo de arriba es lectura del
  fuente, de las migraciones y de las pruebas existentes; los conteos salen de
  `grep`. La línea base es la del MAPA (5 fallos INFRA en
  `scripts/ci/e2e/proxy-local.test.ts`).
