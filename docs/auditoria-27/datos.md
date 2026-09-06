# Modelo de datos y esquema — auditoría 27

**Nota: 7/10** (antes 6). Razón del movimiento: **se atacó y subió**. Abrí las 12
migraciones nuevas (0319→0347) y comprobé una por una: `0339` cierra a mano las
FK compuestas `(operador_id, tenant_id)` / `(viaje_id, tenant_id)` que la `0319`
había omitido, y las **VALIDA** (`0339:9-38`); `0321` y `0346` convierten en
*trigger* invariantes de cierre que antes vivían en TypeScript; `0331` hace un
backfill y **luego** `set not null` sobre `jornada_dia.input_version`
(`0331:74-82`); `0326` sustituye el probe de arranque que EJECUTABA negocio con
UUID falsos por un lector de `pg_proc`/`pg_constraint`; toda tabla nueva nace con
`enable row level security` + `revoke all` (9 de 9). No llego a 8 porque la red
de verificación no siguió al esquema: 19 de las 24 migraciones más recientes no
tienen un solo bloque en `verificaciones.sql`, y dos funciones del camino del
dinero ya no existen como texto en ningún archivo del repo.

**El riesgo mayor del rubro hoy** no es que la base acepte un estado imposible —
los dominios, unicidades y CHECK están puestos— sino que el cuerpo vigente de
`revisar_liquidacion` (la única puerta de la firma humana) solo exista en
producción: el repo guarda la versión de la 0306 más un `replace()` de texto.

## Hallazgos

### [MEDIO] `revisar_liquidacion` y `ejecutar_arco_cancelacion` ya no tienen cuerpo vigente en ningún archivo del repo; un `create or replace` futuro revierte LR019/LR022 sin que nada lo note
`supabase/migrations/0347_revision_duplicados_identidad.sql:7`,
`supabase/migrations/0347_revision_duplicados_identidad.sql:69`,
`supabase/migrations/0340_arco_alcance_cancelacion.sql:11`,
`supabase/migrations/0340_arco_alcance_cancelacion.sql:16`,
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:80`

Escenario: la 0347 lee `pg_get_functiondef('public.revisar_liquidacion(uuid,uuid,
text,text,jsonb,uuid,text,jsonb)')`, sustituye por texto el bloque de exclusión
de la 0306 (`0306:197-207`) por 55 líneas nuevas y hace `execute` del resultado
(`0347:69`). El último archivo del repo que contiene un cuerpo COMPLETO de esa
función es la 0306 — y ese cuerpo es justamente el que la 0347 vino a corregir.
Entra: alguien escribe la migración 0348 «arreglar el mensaje de LR018»
copiando el `create or replace` completo de la 0306 (que es lo que encuentra al
buscar la función en el repo, y el patrón que usan 0342 y 0344, que pegan el
cuerpo entero). Sale: la base pierde la distinción original/copia y la regla
LR022 completa. Concretamente, con un fajo de tres fotos del mismo ticket
Costco folio 3522 por $7,881.05, `copiasDeComprobante`
(`src/lib/likida/cuadre/engine.ts:502`) marca dos copias y el motor emite UNA
diferencia `duplicado` con `gastoId` = el ORIGINAL
(`src/lib/likida/cuadre/engine.ts:1234`). Sin el parche 0347, el contralor que
quiera ajustar la COPIA a su monto real recibe «se ajusta, se rechaza la
liquidación» sobre el comprobante equivocado, y el ORIGINAL —cuya identidad
depende del monto— sí se deja mover, separando el grupo. Nada lo detecta: la
0347 solo se protege a sí misma (`0347:66-68` aborta si el texto base cambió) y
no hay bloque en `verificaciones.sql` que afirme que LR022 existe.
Consecuencia: el contralor firma un ajuste sobre el comprobante equivocado, y el
equipo que mantiene esto no puede leer la regla vigente en ningún archivo — solo
consultándola en producción. Lo mismo aplica a `ejecutar_arco_cancelacion`, cuyo
texto de resolución ARCO (el que se le entrega al titular) hoy es el resultado
de un `replace` sobre una definición que la 0340 nunca imprime.
Causa raíz probable: parchar por `pg_get_functiondef` + `replace` en vez de
reemitir el cuerpo completo deja el repo sin fuente de verdad para la función.

### [MEDIO] 19 de las 24 migraciones más recientes no tienen bloque en `verificaciones.sql`, incluidas las cuatro últimas del camino del dinero
`supabase/verificaciones.sql:119` (bloque 264, mig. 0332),
`supabase/verificaciones.sql:159` (bloque 266, mig. 0326),
`supabase/verificaciones.sql:211` (bloque 261, mig. 0319)

Escenario: `grep -c` de cada prefijo sobre `verificaciones.sql` da **0** para
0324, 0325, 0327, 0329, 0330, 0331, 0333, 0334, 0335, 0336, 0337, 0338, 0339,
0340, 0341, 0344, 0345, 0346 y 0347 (0328 solo aparece dentro de un número de
certificado en `verificaciones.sql:11460`, no como bloque). La batería sí cubre
0319/0320/0321/0322/0323/0326/0332/0342. Entra: se aplica 0346 en producción y
el trigger `zzz_liquidacion_pdf_versionada` (`0346:4-30`) pone
`new.pdf_url := null` en cada transición a `revision='ajustada'`. Si el orden de
disparo respecto de `trg_liquidacion_revision_regla` (0299) no fuera el que el
comentario de `0346:31` supone —alfabético— la liquidación ajustada quedaría con
`pdf_url` nulo y `pdf_versionada` verdadero sin que nadie lo advierta hasta que
el contralor abra `/api/export/pdf/[id]` y no haya papel. Sale: no hay un solo
`raise exception` en la batería que lo compruebe contra un Postgres real; el
único cotejo es la prueba unitaria con mocks. Igual para el CHECK nuevo
`evento_seguridad_privacidad_minima_check` (`0341:14-23`), para las FK que 0339
VALIDA, y para la exclusión de rechazadas en KPI (`0344:23` y `0344:50`).
Consecuencia: el equipo pierde la única red que corre contra Postgres de verdad
justo sobre los cambios más nuevos y menos rodados; la nota de este rubro
descansa en lectura, no en ejecución.
Causa raíz probable: el patrón de la casa (un bloque por migración) se sostuvo
hasta la 0323 y se soltó en las rondas «forward-only» que produjeron el grueso
de estas migraciones.

### [BAJO] `cierre_insumos_hash` lleva una cuarta copia de la regla de medio de pago de combustible, y es la que quedó vieja
`supabase/migrations/0321_cierre_snapshot_atomico.sql:129-140`,
`supabase/migrations/0345_combustible_rep_por_definir.sql:28-32`,
`src/lib/likida/cuadre/engine.ts:221`

Escenario: la 0345 corrigió el numerador del 15% de la RFA 2026 2.9 añadiendo
`forma_pago_efectiva <> '99'` (`0345:30`) para igualarlo con
`medioNoAdmitidoCombustible` (`engine.ts:221-225`, que devuelve `false` para
`'99'`). El bloque `combustible` del hash de cierre (`0321:129-140`) copia la
MISMA regla sin esa exclusión. Entra: un CFDI de diésel de $9,800 con
`forma_pago='99'` cuyo REP trae `FormaDePagoP='99'` («por definir» también en el
complemento). Sale: `sumar_combustible_ejercicio` lo deja FUERA del numerador de
efectivo, `medioNoAdmitidoCombustible` también, y `cierre_insumos_hash` lo cuenta
DENTRO. Hoy no mueve un peso —ese valor solo entra a un SHA-256 que sirve de
huella, y ambas ramas leen las mismas filas, así que el hash sigue siendo
estable y CU006 no se dispara de más—, pero la regla fiscal vuelve a estar
escrita en dos SQL del mismo camino del dinero con dos veredictos distintos.
Consecuencia: el equipo que mantiene esto. Es exactamente el patrón que la casa
prohíbe («una cifra fiscal que se lee distinto en dos pantallas se lee como dos
cálculos»), y ya cobró factura una vez: la propia auditoría 26 arregló la copia
de la RPC y no vio esta.
Causa raíz probable: la 0321 se escribió pegando la lógica del acumulado en
lugar de llamar a `sumar_combustible_ejercicio`.

### [BAJO] El número 0343 se saltó y no quedó registrado en el archivo que existe para eso (REINCIDENTE de la auditoría 25)
`supabase/migrations/NUMERACION-SALTADA.md`,
`.superpowers/sdd/PLAN-EJECUCION-ENTERPRISE/progress.md:120`

Escenario: `ls supabase/migrations` salta de `0342_poliza_revision_y_desglose.sql`
a `0344_analytics_sin_rechazadas.sql`. El único rastro de por qué es una línea de
progreso — «0342 póliza… 0344 KPI… **0343 no se necesita**» — fuera de
`supabase/`. `NUMERACION-SALTADA.md` lista 0277, 0293 y 0295 y dice literalmente
«estos números no existieron nunca y no deben reutilizarse»; 0343 no está.
Entra: una rama futura reserva el hueco y aterriza `0343_lo_que_sea.sql` cuando
producción ya aplicó hasta 0347. Sale: la migración se aplica DESPUÉS de la
0347, fuera de su hueco numérico — el modo de falla exacto que ese archivo
documenta. Atenuante verificado: `decidir()` en
`scripts/ci/compuerta-deploy.mjs:126-136` ya coteja el CONJUNTO de prefijos
aplicados contra el conjunto del repo, así que un 0343 nuevo bloquearía el build
hasta aplicarse; el daño se reduce a orden de aplicación, no a un deploy ciego.
Consecuencia: el equipo. Nada distingue «número saltado a propósito» de
«migración perdida», que es el hallazgo que la 25 dejó abierto.
Causa raíz probable: el registro es manual y no hay nada que lo exija.

### [BAJO] `0341` es la única de su ronda que no se puede volver a aplicar, y trae su propio `begin;/commit;`
`supabase/migrations/0341_gps_alerta_minima_privacidad.sql:4`,
`supabase/migrations/0341_gps_alerta_minima_privacidad.sql:35`,
`supabase/migrations/0341_gps_alerta_minima_privacidad.sql:104`

Escenario: `drop function public.reclamar_eventos_seguridad(uuid,text,integer,
text,integer,timestamptz);` — **sin `if exists`** (`0341:35`), dentro de un
`begin;`…`commit;` propio del archivo. Sus hermanas de la misma ronda declaran lo
contrario por escrito: `0347:3` («Reaplicable»), `0340:18` («Reaplicación: no
redefine»), `0339` guarda cada `add constraint` con un `if not exists`, y todos
los demás `drop function` de las migraciones nuevas llevan `if exists`
(`0319:83`, `0321:216`, `0323:317`, `0324:113`, `0325:787`, `0332:151-154`).
Entra: un replay de la carpeta sobre una base local que ya la corrió, o un caso
en el que el runner haga commit del `commit;` del archivo y no alcance a
registrar la migración. Sale: `ERROR: function public.reclamar_eventos_seguridad
(...) does not exist` y el script de aplicación se cae a media ronda.
Consecuencia: quien opera el despliegue — `scripts/aplicar-migraciones-y-humos.sh`
aborta y la base queda a medio camino entre 0340 y 0347.
Causa raíz probable: se escribió `drop function` sin `if exists` porque en el
momento de escribirla la función existía con certeza.

## Auto-refutaciones (hallazgos que abrí y maté yo mismo)

Las anoto porque valen tanto como los hallazgos y evitan que la próxima ronda
los vuelva a levantar:

- **«0328 crea dos índices idénticos sobre `wa_outbox(provider_message_id)`»** —
  cierto en `0328:7-15` (`wa_outbox_provider_message_idx` no único y
  `wa_outbox_provider_message_uidx` único, misma columna, mismo `where`), pero
  `0330_gps_r3_receipts_forward.sql:19` hace `drop index if exists
  public.wa_outbox_provider_message_idx`. La redundancia solo existe entre dos
  migraciones consecutivas. No es hallazgo.
- **«`jornada_derivacion_trabajo` no tiene retención y se revisita cada hora para
  siempre»** — la `0325` sí quitó de `elegibles` el gate
  `processed_version is distinct from input_version` que traía la `0319:221`, y
  `REVISITA_EXITOSA_SECONDS = 3_600` (`src/lib/likida/jornada/derivar.ts:62`)
  reabre cada fila cada hora. Pero `sincronizar_jornadas_por_derivar` BORRA en
  tandas de 10,000 toda fila con `procesado_al_menos_una_vez` cuyo `dia` haya
  salido de la ventana (`0325:660-684`), que es justo lo que sirve
  `jornada_derivacion_retencion_idx` (`0325:203-205`). El índice sí tiene
  consulta y la cola sí se purga.
- **«las nuevas RPC filtran `revision <> 'rechazada'` y una `revision` NULL las
  haría desaparecer en silencio»** (`0342:84`, `0344:23`, `0344:50`) —
  `0299:58` declara `revision text not null default 'pendiente'`. Nunca es NULL.
- **«`dinero_observado_por_tipo_tenant` puede reventar con un `diferencias` que
  no sea arreglo»** — `liquidacion_diferencias_arreglo` (`0158:580-581`) lo
  impide en la base.
- **«el CHECK de `privacidad_minima` pasa con `etiquetas` NULL, porque
  `cardinality(NULL)=0` da NULL»** (`0341:17`) — `0203:27` declara
  `etiquetas text[] not null default '{}'`. Inalcanzable.
- **«`publicar_pdf_liquidacion` compara `p_cifras` contra columnas que pueden
  ser NULL, y `Number(null)` en TypeScript manda 0»** (`0346:52-55` vs
  `src/lib/likida/revision_recalculo.ts:112-114`) — las cuatro columnas de
  acreditamiento son `not null default 0` (`0007:9-11`, `0021:13`) y las tres de
  totales también (`0001:71-73`). No hay divergencia posible.
- **«el hueco 0343 hace que la compuerta calcule mal `atras`»** —
  `compuerta-deploy.mjs:126-136` compara CONJUNTOS (`m.aplicados` contra
  `prefijosCodigo`), no máximos, desde esta ronda. El hueco no la afecta.

## Lo que revisé y está bien

- **Toda tabla nueva nace cerrada.** Las 9 tablas creadas entre 0319 y 0347
  (`jornada_derivacion_trabajo` `0319:6`, `wa_drenado_cadena` `0319:458`,
  `calcom_sincronizacion_estado` `0323:158`, `conector_poll_estado` `0324:17`,
  `evento_seguridad_cuarentena` `0324:260`, `jornada_derivacion_invalida`
  `0325:216`, `jornada_revision_historial` `0325:247`, `wa_meta_receipt`
  `0330:4`, `producto_evento_estado` `0332:9`) llevan `enable row level
  security` + `revoke all from public, anon, authenticated`. Tres de ellas no
  tienen ni siquiera `grant` a `service_role`: solo se tocan por funciones
  `security definer`. Ninguna se lee desde `src/` por nombre de tabla (grepeado).
- **Las FK compuestas con tenant.** `evento_seguridad_cuarentena` (`0324:283`),
  `jornada_derivacion_invalida` (`0325:225-226`) y `jornada_revision_historial`
  (`0325:261-262`) traen su `(col, tenant_id)` desde el nacimiento; `0339:9-38` se
  la agrega a `jornada_derivacion_trabajo` como `not valid` y luego la
  `validate`, que es la forma correcta sobre una tabla viva. Todas apuntan a una
  llave que existe (`jornada_dia_id_tenant_key`, `0241:129`). El bloque
  auto-descubriente 112 (`verificaciones.sql:5758-5836`) sigue siendo la red.
- **Ningún `select` de `src/` pide una columna que no exista.** Escribí un
  extractor del esquema (`create table` + `add/drop/rename column` de las 324
  migraciones, 156 tablas) y lo crucé contra los ~600 `.from('t').select('…')`
  de `src/`: 0 desajustes reales (los 12 restantes son `factura_saldo`, que es
  vista). Mismo cruce sobre los payloads de `.insert/.update/.upsert`: 0.
- **Ningún `.rpc()` de `src/` manda un parámetro que la función no declare.**
  Crucé los nombres de parámetro de todos los `.rpc('f', {…})` contra la última
  definición de cada función en `supabase/migrations`: 0 desajustes (los 2 que
  saltaron son palabras dentro de un comentario de `repo.ts:1427-1431`).
- **El probe de arranque coteja firmas reales.** Verifiqué las 7 firmas que
  `garantias_arranque_faltantes` (`0326:15-51`) exige, una por una, contra su
  última definición: `try_lock_viaje` (`0280:57`, 3 args / 1 default),
  `unlock_viaje` (`0280:80`, 2/1), `intake_delta` (`0031:49`, 2/0),
  `enriquecer_gasto_codigo` (`0017:26`, 4/1), `confirmar_aviso_privacidad`
  (`0033:94`, 3/0), `liberar_aviso_privacidad` (`0033:118`, 2/0) y
  `guardar_liquidacion_tx` (`0321:221`, 15/4). Coinciden nombre, orden, tipo de
  retorno y número de defaults. Ninguna produciría un falso «FALTA».
- **`0342` y `0344` son supersets fieles.** Extraje las claves del `jsonb_build_
  object` de `poliza_datos_tenant` en `0307` y en `0342`: **cero perdidas**,
  cuatro nuevas (`revision`, `ivaTraslado`, `iepsTraslado`). `0344` conserva las
  seis claves de `kpis_liquidacion_tenant` de `0112:331-339` y las tres de
  `dinero_observado_por_tipo_tenant` de `0150:475-487`; el único cambio es el
  filtro. Y `route.ts:105` sube `RPC_VERSION_MINIMA` a 342 y **falla cerrado**
  (409) si la base va atrás, en vez de degradar.
- **`0345` cierra de verdad la paridad FIS-C2.** El `<> '99'` de `0345:30`
  espeja `medioNoAdmitidoCombustible` (`engine.ts:221-225`) para el caso que el
  comentario de `src/lib/likida/cuadre/desde_db.ts:157-159` todavía declara
  «hallazgo abierto» — ese comentario quedó obsoleto, el código ya no diverge.
- **`0347` acierta la dirección del duplicado.** Su premisa —«`diferencias.
  duplicado` señala al ORIGINAL, nunca a la copia»— la confirma
  `engine.ts:1234` (`gastoId: originalId`), y su regla de identidad (uuid+orden,
  o folio_norm+concepto+monto con ambos uuid nulos) coincide término por término
  con `copiasDeComprobante` (`engine.ts:502-548`) y con el `rankeados` de
  `guardar_liquidacion_tx` (`0321:287-300`). LR022 está en la lista de códigos
  que llegan a pantalla (`src/lib/likida/revision.ts:372`).
- **`0346` está cableado en el orden que dice.** `conservarPdfAntesDeAjuste`
  (`revision_recalculo.ts:97`) sí corre ANTES de la RPC (`revision.ts:445` vs
  `:452`), así que LP002 no bloquea una liquidación legacy; y los dos únicos
  llamadores de `saveLiquidacion` (`tools.ts:450` y `:460`) pasan rutas
  versionadas de `rutasPdfVersionadas`, que casan con la regex del trigger.
- **`computeCuadre` no escribe.** Buscando si el snapshot CU006 podía rebotar
  solo: `cuadre/desde_db.ts` no tiene un solo `insert`/`update`/`rpc` de
  escritura, así que el hash tomado en `tools.ts:340` no lo invalida el propio
  cálculo.
- **Dominios y unicidades del núcleo.** `gasto_concepto_dominio` (9 valores =
  `ConceptoGasto`), `gasto_estado_sat_dominio` (4 = `EstadoSat`),
  `liquidacion_estatus_dominio` (3 = `EstatusLiquidacion`),
  `liquidacion_revision_dominio` (4 = `RevisionLiquidacion`),
  `viaje_estatus_dominio` (3), `gasto_monto_no_negativo`,
  `gasto_ocr_confianza_rango` [0,1], `liquidacion_diferencia_cuadra`
  (`0146:67`), `uq_gasto_cfdi_uuid (tenant, uuid, orden)` (`0065:69`). Todos
  cierran con `src/types/likida.ts`.
- **`0327` reaplica `0323` byte por byte y no rompe.** Los diffé ignorando
  comentarios: son el mismo archivo. Revisé cada sentencia no-idempotente de
  0323 (`0323:60-62`, `0323:86-88`, `0323:174-175`): las tres van precedidas de un
  `drop … if exists` o llevan `on conflict do nothing`. Aplicarlas dos veces
  seguidas funciona.
- **`0332` no doblecuenta.** El watermark `producto_evento_estado.detalle_desde`
  y los snapshots mensuales se publican en la misma transacción (`0332:78-92`) y
  el `full join` de `uso_producto_mensual` (`0332:39-45`) toma snapshot para
  meses cerrados y detalle desde el watermark: no hay mes que caiga en los dos.

## Lo que NO alcancé a revisar

- **Nada corrió contra Postgres.** Sin base, sin `.env` y sin poder correr
  `verificaciones.sql`, todo lo de arriba es lectura de catálogo en archivos. Los
  CHECK que declaro correctos no los vi rebotar una fila.
- **Planes de ejecución.** No puedo decir qué índice usa de verdad ninguna de
  las consultas nuevas. En particular, el `obsoletos` de `0325:660-684` combina
  un rango sobre `dia` con un `or fuente.fuente_obsoleta` calculado en un
  `cross join lateral`; sospecho que ese `or` inutiliza
  `jornada_derivacion_retencion_idx`, pero es una sospecha sin `EXPLAIN` y
  pertenece al rubro de rendimiento.
- **`0325` y `0323/0327` a fondo.** Son 1,432 y 966 líneas. Leí sus tablas,
  índices, CHECK, FK, dominios y las firmas de sus RPC; **no** verifiqué línea
  por línea la lógica interna de `sincronizar_jornadas_por_derivar` (274 líneas),
  `procesar_jornadas_derivadas` (302) ni `aplicar_evento_calcom_tx`.
- **Orden de disparo de triggers sobre `liquidacion` y
  `evento_seguridad_flota`.** Hoy conviven `trg_liquidacion_revision_regla`
  (0299), `zzz_liquidacion_pdf_versionada` (0346) y el constraint trigger
  diferido `trg_liquidacion_revision_coherente`; y sobre eventos,
  `evento_no_sella_accepted_wa` (0328), `evento_reconcilia_aviso_outbox`
  (0328/0330) y `evento_validar_vinculo_gps_outbox` (0330). Postgres los ordena
  alfabéticamente y los comentarios lo asumen; no lo pude comprobar corriendo.
- **Reversibilidad.** Ninguna de las 12 migraciones nuevas trae `down`, y no
  evalué si alguna sería reversible. Es el criterio del rubro que dejé sin
  medir por completo.
- **`0335`/`0338` (retención r3/ronda5) y `0333`/`0337` (gps r4/ronda5).** Los
  abrí para ver qué tablas y funciones tocan, no para auditar su lógica.
