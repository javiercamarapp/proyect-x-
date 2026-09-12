# Modelo de datos y esquema — auditoría 30

**Nota: 7/10** (antes 7). Razón del movimiento: **se sostiene, pero por otra
razón**. El 7 de la 29 se dio en parte porque «el esquema no cambió tres rondas
seguidas». Ese argumento desapareció: entraron **9 migraciones (0348–0356,
+1,364 líneas SQL en `supabase/migrations/` y +88/−16 en `verificaciones.sql`)**
y las leí una por una. El trabajo está **bien instrumentado**: de las nueve,
**ocho traen una prueba que hace DIVERGIR a propósito la versión vieja de la
nueva** (seis en `supabase/tests/`, dos en `verificaciones.sql`), **las siete
pruebas nuevas de `supabase/tests/` SÍ están cableadas en
`ci-postgres.yml:194-200`** —el cuello exacto que la 29 dejó abierto—, **ninguna
de las nueve cambia una firma** y el espejo TS de cada agregado se actualizó con
el mismo predicado. Eso vale el 7 por mérito propio, no por ausencia de cambio.

No sube a 8 porque tres de las nueve dejaron un hueco que puedo escribir con
valores: **0350 cerró dos de las TRES claves foráneas que bloquean el borrado de
un tenant** (y el comentario del código sigue afirmando que eran dos),
**0349/0355 ensancharon el criterio de «foto repetida» de por-viaje a
por-tenant-y-periodo mientras su propia cabecera dice «mismo criterio EXACTO»**,
y **0352 creó una columna de dinero sin techo** — la base acepta una retención
de IVA mayor que el IVA trasladado. El ancla del rubro («8+ si cada invariante
del código tiene su restricción en la base») sigue sin cumplirse.

**El riesgo mayor del rubro hoy:** el predicado de «qué comprobantes son el
mismo» vive ahora en **cinco** implementaciones (TS `engine.ts:514`, SQL en
0321/0354, 0347/0353, 0349 y 0355) con **tres alcances distintos** y **ninguna
restricción de base que las obligue a coincidir**; la única prueba que las cruza
usa dos filas del mismo viaje, que es justo el caso donde las cinco están de
acuerdo.

## Las 9 migraciones, una por una

Leídas completas, y cada `create or replace` cotejado contra la definición que
la migración anterior dejaba instalada.

| Mig. | ¿Reversible? | ¿Test que hace DIVERGIR? | ¿Cambia firma? (llamadores) | ¿CHECK / unique / NOT NULL / CASCADE? |
|---|---|---|---|---|
| **0348** analytics sin rechazadas ×6 | Sin `down` (ninguna lo tiene). Reaplicable: solo `create or replace`. Revertir = reescribir los 6 cuerpos de 0150/0158 a mano — el repo no los guarda como «versión anterior». | **SÍ.** `tests/0348…sql:26-67` siembra 3 liquidaciones (aprobada 980 / **rechazada 8500** / ajustada 500) en el mismo día y clava los seis resultados: `n=2`, `1480`, `1480`, `1480`, `1480`, `diferencias=1`. Sin el filtro salen `3`/`10480`/…; además comprueba que **no** filtró las columnas que vienen de `viaje` (`viajes=3`, `anticipo=900`, `ingreso=2000`) y que leer no mutó el historial (md5 por fila). | **No.** 6 funciones, mismos argumentos. Espejos TS actualizados con el mismo predicado (`espejo_0152.pruebas.ts:76`, `analytics_rpc_0150.fixture.ts`, `analytics_serie_comparativa.test.ts`). | Ninguna. Nota: `revision` es `text not null default 'pendiente'` (`0299:58`), así que `revision <> 'rechazada'` **no** se come filas por NULL — lo verifiqué porque es el modo de falla clásico de ese predicado. |
| **0349** 15 % sin copias | Reaplicable (`create extension if not exists` + `create or replace`). Revertir = reponer el cuerpo de 0345. | **SÍ.** `tests/0349…sql:20-36`: dos fotos del mismo ticket (`folio '0059'`/`'59'`, `folio_norm '59'`, $300, efectivo) → espera `total=3300 / efectivo=300`; sin el filtro son `3600/600`. El propio test documenta que el camino `(cfdi_uuid, cfdi_orden)` **no se puede sembrar** porque `uq_gasto_cfdi_uuid` ya lo prohíbe. | **No.** `(uuid, int, text[])` desde 0084. | Ninguna nueva. **Sí añade una dependencia**: `create extension if not exists unaccent with schema public` (`:37`). Refutado el riesgo obvio: `0247:11-12` prueba que en producción las funciones de `unaccent` están en `public` (el linter de Supabase las listó entre las de `public` sin `search_path`), así que el `search_path` `public, pg_catalog` de la función las resuelve. |
| **0350** cascade chat/cobranza | Reaplicable (drop+add del mismo nombre). Revertir = volver a `no action`, trivial. | **SÍ, y es un rojo real.** `tests/0350…sql:20-27` siembra `chat_conversacion` + `cobranza_contacto`, borra el tenant y exige 0 filas. Antes de 0350 ese `delete` moría con 23503. | **No.** | **SÍ**: dos FK pasan de `NO ACTION` a `ON DELETE CASCADE`. **Pero no cubre todas las hijas del tenant** — ver DAT30-M1. |
| **0351** FaseCosto copiloto/runner | Reaplicable. Revertir = angostar el dominio; fallaría si ya hubiera filas con esas fases (hoy no hay llamador). | **SÍ.** `tests/0351…sql:7-19` inserta `copiloto` y `runner` (rojo antes de 0351: 23514) y exige que una fase `'inventada'` siga rebotando con `check_violation`. | **No.** | **SÍ**: recrea `llm_costo_fase_dominio` con 9 fases. **El CHECK y el tipo TS coinciden EXACTAMENTE**: `costos.ts:41` declara las mismas nueve, en el mismo orden, y `costos_dominio.test.ts` las cruza **en las dos direcciones** leyendo la ÚLTIMA migración que define el constraint y el `export type` del fuente. Corrí la prueba: verde. Es el único dominio del esquema con arnés bidireccional real. |
| **0352** retención de IVA | **NO reaplicable** (`add column` sin `if not exists`, `:10`) — ver DAT30-B1. Irreversible de facto: `drop column` pierde las retenciones capturadas. | **SÍ.** `tests/0352…sql:11-39`: factura sin retención (11600 = 10000+1600) y con retención (11200 = 10000+1600−400); después exige 23514 para un total que ignora la retención (11600) y para una retención negativa. | **No.** `crearFactura` (`facturacion_escritura.ts:394`) ya escribe `retencion_iva`, y `validarFactura:158,161` la calcula. | **SÍ**: columna `numeric not null default 0`; recrea `factura_total_cuadra` (`abs(total−(subtotal+iva−retencion_iva)) ≤ 0.01`) y `factura_importes_positivos` (`:20`). **Le falta el techo** — ver DAT30-M3. |
| **0353** cuerpos completos | Reaplicable. **Efecto colateral**: tras 0353, reaplicar 0347 sola **revienta** (`0347:66-68` no encuentra ni el texto viejo ni el nuevo, porque 0353 borró comentarios del cuerpo) — no afecta un replay en orden. | **NO trae test propio, y es la única de las nueve sin evidencia dedicada.** Lo suplí mecánicamente: reconstruí `0306 + replace(0347)` y `0286 + replace(0340)` y los diferencié contra los cuerpos de 0353. **Resultado: la diferencia es SOLO comentarios** (≈10 bloques `--` suprimidos); ni una línea ejecutable cambia, y `security definer` / `search_path` coinciden con `0306:95-96` y con `extensions` para la ARCO (`arco_search_path.test.ts` verde). Lo que NO existe es un arnés que haga esa comparación: la hice yo, a mano, esta ronda. Ver DAT30-M4. | **No.** Las dos conservan firma, `SECURITY`, `search_path` y ACL (`create or replace` preserva owner/grants). | Ninguna. |
| **0354** `cierre_insumos_hash` v2 | Reaplicable. Revertir es **semánticamente imposible sin migración de datos**: toda liquidación sellada con `insumos_hash_version=2` guarda un hash calculado con la fórmula nueva; con 0321 reinstalada, `cierre_insumos_hash` devuelve otro valor y cualquier re-cierre muere con `CU006 snapshot_changed`. (Refutado el susto mayor: 0321 crea su CHECK dentro de un `if not exists`, así que un replay **no** rebota contra las filas v2.) | **SÍ, el mejor de los nueve.** `tests/0354…sql:16-21` siembra dos viajes idénticos salvo `pagado_forma` (`'99'` vs `'03'`) y exige que **los hashes difieran** («la fórmula sí cambió»), que `guardar_liquidacion_tx` **rechace** `version=1` con `CU007` y acepte `version=2`, y que el CHECK siga rechazando `version=3`. | **No.** `guardar_liquidacion_tx` conserva sus 15 argumentos — cotejado contra el catálogo de arranque `0326:41-49`, que los pinea por nombre, y contra el único llamador (`repo.ts:1217-1218`). | **SÍ**: recrea `liquidacion_insumos_hash_forma` **ensanchando** a `version in (1,2)` (no angosta: las filas históricas v1 siguen válidas). |
| **0355** agregado fiscal sin copias | Reaplicable. Revertir = reponer el cuerpo de 0317. | **SÍ, pero NO en `supabase/tests/`** — está en `verificaciones.sql:18088-18148`, bloque **267**, que sí corre en CI (`ci-postgres.yml:231-238`): dos casetas de $348 con el mismo folio → `n=1, monto=348, iva=48`; después una tercera con folio distinto → `n=2`. Rojo real antes de 0355. | **No.** Los 13 parámetros coinciden uno a uno con el llamador `fiscal.ts:1652-1673`. La firma de 7 argumentos ya la había dropeado `0317:43`, así que no queda overload fantasma — el bug de la 28 no se repitió. | Ninguna. |
| **0356** ARCO borra contacto de emergencia | Reaplicable. Revertir = reponer 0353. Efecto colateral igual al de 0353 sobre 0340. | **SÍ, tampoco en `supabase/tests/`** — está en `verificaciones.sql:8514-8560`, bloque **144**, que inserta un `contacto_emergencia` («Familiar ARCO») y exige `familia_fuera=0` y `evidencia ? 'contacto_emergencia'`; además `tests/0340_arco_alcance.sql:33` fija el texto nuevo de resolución. | **No.** Diferencié 0353 vs 0356: el delta son exactamente 5 líneas (el `delete` + su `get diagnostics`) y el texto de `resolucion`. | Ninguna en el esquema; `contacto_emergencia` ya tenía `on delete cascade` a tenant y a operador (`0198:95-96`). |

**Las tres sin test propio (`0353`, `0355`, `0356`) — qué significa.** Verifiqué
la afirmación del brief: es cierta para `supabase/tests/`, pero **dos de las tres
sí tienen prueba que diverge, en `verificaciones.sql`** (bloques 267 y 144), y
ese archivo corre en el mismo job de CI. La que de verdad se queda **sin ninguna
evidencia ejecutable propia es la 0353** — y es, con diferencia, la más grande
de las tres (334 líneas, transcritas a mano, de la RPC que hace
`update gasto set monto`). Ver DAT30-M4.

## Estado de los hallazgos abiertos de la 29

| # | Hallazgo (29) | Veredicto | Evidencia |
|---|---|---|---|
| MEDIO | **DAT-M1** — dos poblaciones de `liquidacion` en la misma pantalla | **CERRADO para el panel del cliente** | `0348` puso `revision <> 'rechazada'` en los seis agregados que faltaban, con el test que diverge. Barrí las 333 migraciones quedándome con la ÚLTIMA definición de cada función: de las 22 que leen `liquidacion`, **las 12 que son agregados de dinero o de conteo del cliente ya filtran**. Residuo en `/admin`: ver DAT30-B3. |
| MEDIO | **DAT-M2** — «borrar un tenant borra todo lo suyo» vive en un array de TS | **PARCIALMENTE CERRADO / mutado** | `0350` puso la cascada en `chat_conversacion` y `cobranza_contacto`, con rojo real. Pero la invariante sigue rota en una tercera tabla y el array de TS sigue diciendo que eran dos. Ver DAT30-M1. |
| MEDIO | **DAT-M3** — 21 exenciones, 10 apuntan a archivos que el CI no ejecuta | **REINCIDENTE en lo viejo, CERRADO en lo nuevo** | Medido otra vez: `supabase/tests/` tiene **53 archivos** y `ci-postgres.yml` invoca **24**; siguen **29 sin invocador**, y son exactamente los mismos (0319, 0323–0337). Las **10 exenciones** de `migraciones_verificadas.test.ts:55-66` siguen apuntando a ellos, y **seis siguen afirmando ejecución** («ejecutados contra PostgreSQL real», `:55`). Lo nuevo sí se hizo bien: los 7 archivos 0348–0354 están en la lista. |
| MEDIO | **DAT-M4** — `revisar_liquidacion` y `ejecutar_arco_cancelacion` sin cuerpo vigente en el repo | **CERRADO** (3ª ronda) | `0353` imprime los dos cuerpos completos y `0356` parte de ahí. Verificado con diff mecánico contra la cirugía que sustituye: idéntico salvo comentarios. |
| BAJO | **DAT-B1** — `cierre_insumos_hash` conserva la cuarta copia de la regla de combustible | **MUTADO** | `0354` cerró la mitad del `'99'` (`:77-93`). Pero `0349` metió el dedup de copias en `sumar_combustible_ejercicio` y **el bloque `combustible` de 0354 no lo tiene**: la misma regla sigue escrita dos veces con dos veredictos, ahora en otro eje. Ver DAT30-B2. |
| BAJO | **DAT-B2** — `0341` no reaplicable | **REINCIDENTE** | `grep -n "if exists" supabase/migrations/0341_gps_alerta_minima_privacidad.sql` sigue sin devolver nada. Y el defecto se repitió en una migración de esta ventana: DAT30-B1. |
| BAJO | **DAT-B3** — pin de 154 tablas en `staging-recovery.mjs` | **REINCIDENTE, latente** | `staging-recovery.mjs:214` sigue con `Number(physical[0].tables) !== 154`. Ninguna de las nueve migraciones nuevas trae un `create table` (verificado), así que el pin sigue coincidiendo. La primera que cree una tabla rompe `RECOVERY_FINAL_SCHEMA`. |
| BAJO | **DAT-B4** — `invitacion_rol_dominio` divergente | **REINCIDENTE** | `grep -rn "invitacion_rol_dominio" supabase/migrations/*.sql` devuelve **una sola línea**, `0053:45`, con `('flota_admin','contador','encargado','operador')`. Sigue admitiendo el rol retirado en la 0086 y rechazando `vendedor`. |

## Hallazgos

### [MEDIO · REINCIDENTE (DAT-M2), mutado] DAT30-M1 — 0350 cascadeó dos tablas de una lista escrita a mano que era incorrecta: `prospecto` sigue bloqueando el borrado de un tenant
`supabase/migrations/0350_cascade_chat_cobranza.sql:9-17`,
`supabase/migrations/0105_zona_vendedores.sql:80`,
`src/lib/admin/qa-motor.ts:459`,
`supabase/migrations/0088_chat_conversaciones.sql:21`

Extraje con guion las **102 referencias a `tenant(id)`** de las 333 migraciones y
las clasifiqué por cláusula `on delete`. Antes de 0350 había **6 sin cascada**;
0350 arregló 2. De las 4 restantes, tres son `on delete set null` a propósito
(`bitacora_auditoria` 0053:69, `evento_seguridad` 0133:16, `qa_corrida`
0185:75 — todas con la columna anulable, todas coherentes). **La cuarta no es
`set null`: es `NO ACTION`.**

`0105:80`: `tenant_id uuid references public.tenant(id),` en `prospecto`, sin
cláusula `on delete`. La columna existe justamente para ligar el prospecto con
la flota: `prospecto_tenant_solo_cerrado` (`0105:96`) la exige `null` salvo en
estado `'cerrado'`, y `ficha-cliente.ts:59-60` la lee para pintar «de qué
prospecto nació este cliente».

Escenario, con valores. Javier cierra a «Transportes del Bajío», crea el tenant
`a1b2…`, y al cerrar el trato pone `update prospecto set estado='cerrado',
cerrado_en=now(), tenant_id='a1b2…' where id='…'`. Nueve meses después la flota
se va y pide baja de cuenta. Quien la ejecute abre la consola SQL y escribe
`delete from public.tenant where id='a1b2…';` →

```
ERROR: 23503: update or delete on table "tenant" violates foreign key
constraint "prospecto_tenant_id_fkey" on table "prospecto"
```

Y no solo por la consola: `limpiarTenant` (`qa-motor.ts:481`) devuelve
`❌ el DELETE del tenant falló`, porque su lista de sobras a barrer a mano
(`:468`) nombra `chat_conversacion` y `cobranza_contacto` y **no** `prospecto`.
El comentario que la justifica sigue en el árbol, y hoy es falso en dos
sentidos: `:459` dice «son las **DOS** únicas tablas con `tenant_id` que NO
llevan `on delete cascade` (**las otras 90** sí)» — son 99 tablas con
`tenant_id`, y siguen siendo 4 las que no cascadean.

Secundario, misma causa: el barrido miró la columna `tenant_id` y no las demás
FK que el borrado arrastra. `chat_conversacion.user_id` (`0088:21`) apunta a
`app_user(id)` también sin `on delete`. Hoy no muerde —el borrado del tenant
elimina ambas filas dentro del mismo statement y `NO ACTION` se comprueba al
final— y no hay ningún `delete` de `app_user` en `src/` (grepeado). Lo anoto
porque es el mismo hueco: la invariante depende de en qué orden Postgres
resuelva dos cascadas, no de una declaración.

Consecuencia: el borrado de cuenta —la obligación que llega con el primer
cliente que se va— sigue siendo una operación que la base rechaza, y el arreglo
que decía cerrarlo se dimensionó desde un inventario escrito a mano que estaba
mal. El test `tests/0350…sql` **no siembra un `prospecto`**, así que pasa en
verde probando dos tablas en lugar de la invariante.

Causa raíz probable: la migración se escribió contra la lista del comentario de
`qa-motor.ts` en vez de contra el catálogo (`pg_constraint` / un guion sobre las
migraciones), que es lo que habría enumerado las cuatro.

### [MEDIO · NUEVO] DAT30-M2 — 0349 y 0355 dicen portar «el mismo criterio EXACTO» de `copiasDeComprobante`, pero lo aplican sobre TODO el tenant en vez de sobre un viaje: dos comprobantes legítimos de viajes distintos se funden en uno
`supabase/migrations/0349_combustible_15_sin_copias.sql:7-8`,
`supabase/migrations/0349_combustible_15_sin_copias.sql:46-66`,
`supabase/migrations/0355_gastos_fiscales_sin_copias.sql:8-9`,
`supabase/migrations/0355_gastos_fiscales_sin_copias.sql:104-114`,
`src/lib/likida/cuadre/engine.ts:514`

`copiasDeComprobante(gastos: Gasto[])` recibe **los gastos de UN viaje** —así lo
llaman el cuadre y el resumen laboral del PDF, y su docstring lo narra con el
caso real del 1-ago (`engine.ts:504-512`). Las dos funciones SQL nuevas hacen
`row_number() over (partition by unaccent(lower(concepto)),
coalesce(folio_norm, folio), monto order by id)` **sin `viaje_id` en la
partición** (`0349:63`, `0355:110`): en 0349 el universo es el **ejercicio
completo del tenant**, en 0355 es **todo el tenant en el periodo consultado**.

El camino por CFDI está a salvo —`uq_gasto_cfdi_uuid` sobre
`(tenant_id, cfdi_uuid, cfdi_orden)` (`0065:69`) hace imposible dos filas con la
misma llave—, así que la diferencia solo puede morder por el camino del **folio
sin CFDI**, que es exactamente el que ambos tests ejercitan… con **las dos filas
en el mismo viaje** (`tests/0349…sql:20-21`, ambas en `…-000000000001`;
`verificaciones.sql:18113-18116`, ambas en el viaje `ZZZ-0355`). Es decir: la
prueba cubre el caso donde el criterio viejo y el nuevo coinciden.

Escenario, con valores. Flota con dos tractos. El 3-mar la unidad A cruza la
caseta de Palmillas en el viaje `V-118` y el operador manda la foto del boleto:
`concepto='caseta'`, `folio='0001'` (el boleto de la primera vuelta del turno),
`folio_norm='1'`, `monto=316.00`, sin CFDI. El 17-abr la unidad B cruza la misma
caseta en el viaje `V-203`, mismo turno de apertura, mismo boleto `0001`, y el
peaje es una **tarifa fija**: `monto=316.00`. Dos gastos reales, dos viajes, dos
reembolsos al operador.

- La liquidación de `V-118` y la de `V-203` cuentan **$316.00 cada una** — el
  motor deduplica por viaje y ahí no hay copia.
- `/dashboard/fiscal` para el ejercicio 2026 llama
  `gastos_fiscales_agregados_tenant(tenant, null, null, …)`; la CTE `marcadas`
  las mete en la misma partición (`caseta | 1 | 316.00`), `base` se queda con
  `orden_copia = 1` y la celda sale **`n=1, monto=316.00`**.

El contralor cruza el panel fiscal contra los dos PDF y le faltan $316.00 y un
comprobante. La misma cifra fiscal, dos pantallas, dos valores — que es
literalmente lo que `lib/formato.ts` y su prueba existen para impedir en el
formato, y aquí ocurre en el cálculo.

Lo intenté refutar por tres lados y sobrevivió: (a) `folio_norm` **no** aplana
folios distintos —`ocr.ts:640` solo quita ceros a la izquierda de un número, así
que «A-001» y «B-001» siguen siendo distintos—, pero tampoco hace falta que los
aplane: el escenario usa el mismo folio impreso; (b) el desempate por `id` es
determinista, así que no es intermitente: es **siempre** la misma fila la que
desaparece; (c) el sentido del error es siempre a la baja (subcontar), que es el
lado prudente para la deducibilidad, salvo en el cubo del 15 %: ahí `total` es el
**denominador** (`0349:80`), y bajarlo **sube** el cociente `efectivo/total` —
una flota cerca del límite puede cruzarlo por comprobantes que sí existen.

Consecuencia: el panel fiscal y el PDF de liquidación pueden no cuadrar, y el
motivo no se ve en pantalla. Para el equipo: la cabecera de las dos migraciones
afirma «mismo criterio EXACTO» y «el idéntico criterio», así que la próxima
persona que lea el SQL creerá que ya está cruzado con TS.

Causa raíz probable: el predicado se portó a SQL copiando la **llave** de
`copiasDeComprobante` y no su **alcance**; el alcance vivía en quién llamaba a la
función, no en la función.

### [MEDIO · NUEVO] DAT30-M3 — `factura_emitida.retencion_iva` nació sin techo: la base acepta una retención mayor que el IVA que se trasladó
`supabase/migrations/0352_factura_retencion_iva.sql:10`,
`supabase/migrations/0352_factura_retencion_iva.sql:15`,
`supabase/migrations/0352_factura_retencion_iva.sql:20`,
`src/lib/likida/facturacion_escritura.ts:158`,
`src/lib/likida/facturacion_escritura.ts:161`

0352 puso dos restricciones y le faltó la tercera. `factura_total_cuadra`
(`:15`) exige la identidad `total = subtotal + iva − retencion_iva` al centavo, y
`factura_importes_positivos` (`:20`) exige que los cuatro sean `>= 0`. **Nada
acota `retencion_iva` por arriba.** Despejando: la base acepta cualquier
retención hasta `subtotal + iva`.

La retención de IVA por autotransporte terrestre de carga es el **4 % del valor
de la contraprestación** (LIVA 1-A-II-c y su Reglamento art. 3-II): es siempre
una fracción del IVA trasladado, nunca más. Una fila con
`retencion_iva > iva` describe una factura que no puede existir.

Escenario, con valores. El contador captura la factura del flete de Querétaro:
subtotal `10,000.00`, IVA `1,600.00`, y en el campo de retención teclea
`1,600.00` en vez de `400.00` (copia el IVA por reflejo, es el error de dedo más
común del renglón de al lado). `validarFactura` (`:161`) calcula
`total = 10000 + 1600 − 1600 = 10,000.00`; los dos CHECK pasan; la fila se
guarda. Con la variante peor —teclea `4,000.00` porque leyó el 4 % del total con
IVA mal— sale `total = 7,600.00` y también pasa.

Qué queda guardado y qué se ve: `factura_saldo` (`0049:118`) deriva
`saldo = total − sum(pagos)`. El cliente paga los `11,200.00` reales del CFDI;
`/dashboard/facturacion` pinta un **saldo negativo de −1,200.00** y la factura
como sobrepagada, o —en el otro sentido, si el cliente paga lo que dice el
panel— la flota cobra 1,200 pesos de menos y la cobranza deja de perseguirlos
porque `vencida` (`0049:123-126`) exige `saldo > 0.01`.

Atenuante, que es grande y hay que decirlo: hoy **ningún formulario teclea el
campo** — lo declara la propia exención (`migraciones_verificadas.test.ts:79`) y
lo confirmé grepeando: el único escritor es `crearFactura`, y el único origen del
valor es `FacturaCruda.retencion`, que hoy llega vacío y se resuelve a `0`
(`:158`). Lo reporto igual porque es exactamente la forma del rubro: la columna
se creó para que la teclee la siguiente pantalla, y el dominio que la va a
recibir no tiene piso superior ni en la base ni en `validarFactura`. El test de
0352 comprueba la retención **negativa** y el total **incoherente**; el techo no
se le ocurrió a nadie.

Causa raíz probable: la migración derivó sus CHECK de la identidad aritmética
(`total = subtotal + iva − retención`) y no de la regla fiscal
(`0 ≤ retención ≤ iva`), que es la que acota el dominio.

### [MEDIO · NUEVO] DAT30-M4 — la única «verificación» que respalda 0353 es una frase en un `Record<string,string>`, y esa frase es demostrablemente falsa
`src/lib/likida/migraciones_verificadas.test.ts:54`,
`src/lib/likida/migraciones_verificadas.test.ts:209`,
`supabase/migrations/0353_revisar_liquidacion_arco_cuerpos_completos.sql:13-15`,
`supabase/migrations/0347_revision_duplicados_identidad.sql:19-21`

0353 es la migración más grande de la ventana (334 líneas) y transcribe **a
mano** el cuerpo de `revisar_liquidacion` —la RPC que ejecuta
`update gasto set monto = v_nuevo` (`0353:158`) y reescribe `total_comprobado`,
`diferencia` y los cuatro acreditables (`:172-183`)—. No trae test. Su respaldo
es la exención `EXENTAS['0353']`, que afirma:

> «Verificado contra producción antes de aplicar: `pg_get_functiondef()` de ambas
> funciones es **BYTE-IDÉNTICO antes y después**».

**Eso no puede ser cierto, y se ve sin base de datos.** `pg_get_functiondef`
emite `prosrc` literal, comentarios incluidos. Reconstruí el cuerpo que 0347
deja instalado —`0306` con el `replace()` de `0347:8-63` aplicado— y lo diferencié
contra `0353`: la salida son **10 hunks, todos de supresión de comentarios**. Por
ejemplo, `0347:19-21` inyecta tres líneas de comentario y 0353 conserva **solo la
primera** (`0353:117`); la migración también borró el bloque «EL VIAJE PRIMERO,
LUEGO LA LIQUIDACIÓN…» de 0306 y otros siete. Si el cuerpo hubiera salido de un
volcado, esas líneas estarían ahí. Salió de una transcripción editada.

La buena noticia, y la digo porque la comprobé: **ni una línea ejecutable
cambia** —hice el mismo diff para `ejecutar_arco_cancelacion` (0286 + el
`replace()` de 0340) y también es solo comentarios—, y `SECURITY DEFINER` /
`SET search_path TO 'public','pg_catalog','pg_temp'` coinciden con `0306:95-96`.
Hoy no hay defecto.

Escenario de la falla que esto no atrapa, con valores. Supón que en la
transcripción se hubiera caído el `and original.id <> v_gasto.id` de `0353:126`
(una condición de una línea, en medio de un `exists` de 20). El contralor entra a
ajustar el comprobante de diésel `g-9f31` de $8,450 que el motor marcó como
ORIGINAL de un duplicado; la función lo tomaría por su propia copia y lo
rechazaría con `LR019` en vez de aplicar el ajuste — o, con la omisión al revés,
dejaría ajustar una copia excluida y `LR020` compararía contra un
`total_comprobado` que ya no se deriva de los gastos. **Nada en CI lo diría**:
`tests/0347_revision_duplicados_identidad.sql` corre *después* de 0353 y
ejercita la función resultante, así que probaría la versión rota como si fuera la
buena; y la prueba que gobierna las exenciones solo comprueba
`razon.trim().length >= 20` (`:209`).

Consecuencia: para la RPC que un contralor usa para corregir dinero, el repo
sustituyó una cirugía de texto **automática y auto-verificante** (`0347:65-68`
aborta si la definición vigente no es la esperada) por una copia **manual**, y la
prueba de que la copia es fiel es una oración en un diccionario de TS que ninguna
prueba lee y que, leída con cuidado, no se sostiene.

Causa raíz probable: `migraciones_verificadas.test.ts` obliga a *escribir* una
decisión, no a *demostrarla*; cualquier texto de 20 caracteres la satisface.

### [BAJO · NUEVO, mismo defecto que DAT-B2] DAT30-B1 — 0352 no es reaplicable: `add column` sin `if not exists`
`supabase/migrations/0352_factura_retencion_iva.sql:10`

`alter table public.factura_emitida add column retencion_iva numeric not null
default 0;` — pelado. El idioma de la casa es el otro (`0321:6-7`,
`add column if not exists insumos_hash …`). Reaplicar 0352 sola muere con
`42701: column "retencion_iva" of relation "factura_emitida" already exists`,
dentro de su propio `begin;`/`commit;`, sin llegar a los dos `drop constraint`
que vienen después. Un replay limpio desde cero sí funciona (la aplica una vez);
lo que rompe es reaplicarla, exactamente como `0341:35` lleva tres rondas. Las
otras ocho de la ventana **sí** son reaplicables (verificado una por una:
`create or replace` puro, o `drop constraint` de un nombre que la propia
migración vuelve a crear).

### [BAJO · REINCIDENTE (DAT-B1), mutado] DAT30-B2 — el `combustible` del hash de cierre cerró el hueco del `'99'` y abrió el de las copias
`supabase/migrations/0354_cierre_insumos_hash_v2.sql:77-93`,
`supabase/migrations/0349_combustible_15_sin_copias.sql:56-78`,
`supabase/migrations/0354_cierre_insumos_hash_v2.sql:238-256`

0354 hizo lo que prometía: el bloque `combustible` ahora excluye
`forma_pago_efectiva = '99'`, igual que 0345/0349. Pero 0349 —aplicada **cinco
números antes**— le agregó al panel el dedup de copias, y el bloque de 0354
**suma todas las filas** (`:73`, `coalesce(sum(g.monto), 0)` sobre `gasto` sin
`row_number`). La misma regla sigue escrita dos veces con dos veredictos, ahora
en el eje de las copias en vez del de la forma de pago.

Lo curioso, y lo que lo deja en BAJO: **dentro de la misma migración**, a 160
líneas de distancia, `guardar_liquidacion_tx` **sí** deduplica (`:238-256`) — con
una tercera variante del predicado, `translate(lower(concepto),'áéíóúüñ',
'aeiouun')` y `order by created_at, id`, contra el `unaccent(lower(...))` y
`order by id` de 0349/0355. Refuté el impacto: `translate` y `unaccent` coinciden
para las siete letras del español, y cambiar el criterio de desempate cambia
**cuál** fila sobrevive, no cuántas ni la suma. Y el hash no mueve un peso: solo
alimenta la comparación «antes y después», donde cualquier alta de una copia
cambia el hash igual por la vía de `gastos_viaje` (`:60-66`). Sigue siendo la
misma regla fiscal con cinco implementaciones y ninguna restricción de base que
las ate.

### [BAJO · residuo de DAT-M1] DAT30-B3 — dos agregados de `/admin` siguen contando liquidaciones rechazadas como cierres
`supabase/migrations/0162_limpieza_storage.sql:83`,
`supabase/migrations/0251_producto_evento.sql:78`

Barrido completo de las últimas definiciones: después de 0348 quedan dos
agregados que leen `liquidacion` sin filtrar la revisión.

- `senales_pmf` (`0162:79-84`): `count(*) … from liquidacion where p_tenant is
  null or tenant_id = p_tenant`, y lo publica como `'liquidaciones'` (`:111`).
- `embudo_activacion` (`0251:78`): `'activadas', (select count(distinct
  l.tenant_id) from liquidacion l)`.

Escenario, con valores: una flota piloto manda 4 liquidaciones, el contralor
rechaza las 4 y se va. En `/admin` la flota sigue contando como **activada** y
con **4 liquidaciones** en las señales de PMF; en su propio panel ve 0. No es
dinero del cliente y no lo ve el contralor —por eso BAJO— pero es la misma
grieta que DAT-M1: cada RPC nueva sobre `liquidacion` tiene que acordarse a mano
de cuál de las tres poblaciones (todas / `sin_rechazadas` / `firmadas`) le toca,
porque nada en el esquema lo dice.

### [BAJO · REINCIDENTE ×2] DAT30-B4 — `0341` sigue siendo la única no reaplicable de su ronda
`supabase/migrations/0341_gps_alerta_minima_privacidad.sql:35`

Reverificado: `grep -n "if exists"` sobre el archivo no devuelve nada, y la
línea 35 sigue siendo el `drop function public.reclamar_eventos_seguridad(...)`
pelado. Escenario y refutación sin cambio respecto de `docs/auditoria-29/datos.md`.

### [BAJO · REINCIDENTE, latente] DAT30-B5 — el pin de 154 tablas sigue puesto; ninguna de las 9 migraciones lo disparó
`scripts/ci/staging-recovery.mjs:214`

`Number(physical[0].tables) !== 154 → fail('RECOVERY_FINAL_SCHEMA')`, intacto.
Verificado que ninguna de 0348–0356 trae `create table` (0352 añade una columna),
así que el conteo sigue coincidiendo y el defecto sigue sin manifestarse. La
primera migración que cree una tabla rompe `recover-empty-staging` **después**
de haber corrido `db reset --linked` sobre staging.

### [BAJO · REINCIDENTE] DAT30-B6 — `invitacion_rol_dominio` sigue 250 migraciones atrás
`supabase/migrations/0053_cuentas_bitacora_arco_campanias.sql:45`

Única definición en las 333 migraciones:
`check (rol in ('flota_admin','contador','encargado','operador'))`. Sigue
admitiendo el rol que la `0086:98` retiró y rechazando el que la `0105:52`
agregó. `invitacion` sigue sin escritor en `src/`, lo que lo mantiene en BAJO;
la pantalla de invitar al contador es de las primeras que se construyen para el
primer cliente.

### [BAJO · REINCIDENTE (DAT-M3), acotado] DAT30-B7 — 29 de 53 archivos de `supabase/tests/` siguen sin invocador, y 10 exenciones siguen apuntando a ellos
`.github/workflows/ci-postgres.yml:175-200`,
`src/lib/likida/migraciones_verificadas.test.ts:55-66`

Medido esta ronda con guion sobre el directorio y el workflow: **53 archivos, 24
invocados, 29 no**. Son exactamente los mismos que la 29 listó (0319, 0323–0337);
el crecimiento del directorio (+7) fue todo de archivos **sí** cableados. Las
exenciones de 0324, 0325, 0327, 0328, 0329, 0331, 0333, 0334, 0336 y 0337
siguen citando archivos que nadie ejecuta, y seis de ellas siguen afirmando lo
contrario («ejecutados contra PostgreSQL real», `:55`). Lo bajo de ALTO a BAJO
respecto de cómo lo escribí en la 29 por una razón concreta: **la ventana que
audito hoy no lo repitió** — las siete pruebas nuevas están en la lista, y dos
migraciones más resolvieron su evidencia con bloque en `verificaciones.sql`, que
sí corre. El residuo es histórico y ya está anotado por `pruebas` desde la 27.

## Lo que revisé y está bien

Lo que dice «guion» lo extraje programáticamente de las 333 migraciones; el
resto lo abrí a mano esta ronda.

- **Ninguna de las nueve cambia una firma, y lo verifiqué por los dos lados.**
  `gastos_fiscales_agregados_tenant` conserva sus 13 parámetros y coinciden uno a
  uno con `fiscal.ts:1652-1673`; el overload de 7 argumentos —el que causó el bug
  de la 28— sigue dropeado desde `0317:43`, así que no hay resolución ambigua.
  `guardar_liquidacion_tx` conserva sus 15 y los pinea por **nombre** el catálogo
  de arranque `0326:41-49`. `sumar_combustible_ejercicio` sigue en
  `(uuid,int,text[])` desde 0084, `revisar_liquidacion` en sus 8 y
  `ejecutar_arco_cancelacion` en sus 2.
- **Los `create or replace` conservan lo que no se ve.** Coteje uno a uno
  `SECURITY`, `search_path`, `STABLE/PARALLEL SAFE` y los `revoke/grant` contra
  la definición vigente anterior: 0353 mantiene `security definer` +
  `public,pg_catalog,pg_temp` (`0306:95-96`) y la ARCO mantiene `extensions` en
  el `search_path` —el defecto que 0264/0275 pagaron dos veces— con
  `arco_search_path.test.ts` verde sobre la ÚLTIMA definición, que hoy es la
  0356.
- **El dominio de `FaseCosto` y su CHECK coinciden EXACTAMENTE, y hay quien lo
  vigile en las dos direcciones.** `costos.ts:41` y `0351:17` declaran las mismas
  nueve fases; `costos_dominio.test.ts` lee la última migración que define el
  constraint y el `export type` del fuente y falla si sobra o falta una de
  cualquiera de los dos lados. Es el patrón que el resto de los dominios del
  esquema no tiene.
- **0348 no se comió filas por NULL.** `liquidacion.revision` es `text not null
  default 'pendiente'` (`0299:58`) con `liquidacion_revision_dominio` (`:75-76`),
  así que `revision <> 'rechazada'` no puede evaluar a NULL y dejar fuera una
  liquidación buena. Era el modo de falla más probable de los seis cuerpos y no
  aplica.
- **Los cuerpos que 0353 imprime son fieles.** Diff mecánico contra
  `0306 + replace(0347)` y contra `0286 + replace(0340)`: solo comentarios. Es la
  verificación que la migración dice haber hecho de otra forma (ver DAT30-M4),
  pero el resultado es correcto.
- **0354 no angosta hacia atrás.** El CHECK nuevo admite `version in (1,2)`
  (`:29`), las liquidaciones ya selladas con v1 siguen siendo filas válidas, y
  `guardar_liquidacion_tx` **falla cerrado** ante un cliente que todavía pida v1
  (`CU007`, `:219-225`) en vez de comparar un hash bajo la fórmula equivocada.
  Ese último detalle es el que evita el modo de falla malo durante el propio
  deploy.
- **`unaccent` resuelve donde tiene que resolver.** 0349 crea la extensión
  `with schema public` para una base virgen (`:37`), y en producción ya está ahí:
  `0247:11-12` la enumera entre las funciones **de `public`** que el linter de
  Supabase levantó sin `search_path`. Fui a buscar el defecto opuesto —el de
  `digest()` en `extensions` que la 0264 pagó— y aquí no está.
- **La unicidad que el manual exige sigue puesta y ahora carga trabajo nuevo.**
  `uq_gasto_cfdi_uuid` sobre `(tenant_id, cfdi_uuid, cfdi_orden)` (`0065:69`) es
  lo que hace **imposible** el camino por CFDI del dedup de 0349/0355 — los dos
  tests lo dicen por escrito en vez de fingir que lo prueban. `liquidacion_viaje_uidx`
  (`0005:9`) sigue siendo lo que hace atómico el `on conflict (viaje_id)` de
  `0354:275`.
- **El inventario de cascadas, medido y no recordado.** 99 tablas tienen columna
  `tenant_id` y **las 99 tienen FK a `tenant`** (guion sobre los bloques
  `create table`). Después de 0350 quedan 4 sin `cascade`: tres `set null`
  deliberadas y coherentes (columna anulable), y `prospecto` (DAT30-M1).
- **La coherencia `liquidado ⇎ rechazada` sigue en pie tras 0353.** El
  `constraint trigger` diferido `trg_liquidacion_revision_coherente`
  (`0299:225-234`) y `liquidacion_revision_regla` (`:112-176`) no los toca
  ninguna de las nueve; `0353:198` conserva el `update viaje set
  estatus='en_cuadre'` que los alimenta.

### Auto-refutaciones (hallazgos que abrí y maté yo mismo)

- **«0353 dejó `ejecutar_arco_cancelacion` en `SECURITY INVOKER` por omisión,
  perdiendo el `DEFINER`»** — no: la función es `security invoker` desde que
  nació (`0173:50`, `0262:52`, `0264:58`, `0286:45`), y su defensa real son los
  `revoke all … / grant execute … to service_role` que `0356:131-132` repite.
  Era mi mejor candidato a ALTO de la ronda.
- **«Revertir 0354 revienta contra las filas `insumos_hash_version=2`»** — no:
  `0321:13-14` envuelve el `add constraint` en un `if not exists`, y tras 0354 el
  constraint existe, así que un replay de 0321 lo salta y solo repone los
  cuerpos v1. Lo que sí queda roto es la verificación de un sello v2 bajo la
  fórmula v1 (`CU006`), y eso lo anoté en la tabla.
- **«`unaccent` vive en `extensions` en producción y las dos funciones nuevas
  truenan con 42883»** — no: `0247:11-12` prueba lo contrario. Lo busqué
  precisamente porque es la familia de defecto que 0264/0275 documentaron.
- **«0349 y `engine.ts` discrepan con `folio = ''`»** — cierto en el papel
  (`0349:63` usa `folio is not null`, mientras `engine.ts:540` usa `if (g.folio)`
  y `0355:33` hace `nullif(g.folio,'')`), pero **no hay escritor que produzca
  `''`**: `sanitizarFolio` (`intake/sanitizar.ts:12`) devuelve `undefined` para
  la cadena vacía, `repo.ts:362` escribe `?? null` y el acercamiento no toca
  `folio` por diseño (`repo.ts:893`). Sin escritor no hay escenario. Lo dejo
  anotado porque **la base no lo impide**: `0158:595-622` puso el
  `btrim`/no-vacío a `viaje.folio` y `factura_emitida.folio`, y **no** a
  `gasto.folio` — hoy el invariante lo sostiene la aplicación.
- **«El accent-stripping de `guardar_liquidacion_tx` (`translate`) discrepa del
  de 0349/0355 (`unaccent`)»** — no en la práctica: `translate(…, 'áéíóúüñ',
  'aeiouun')` y `unaccent` coinciden para el español, y `concepto` es un dominio
  enumerado corto. Queda como deuda de arquitectura (una quinta copia), no como
  defecto de datos.
- **«0352 rompe `factura_saldo`»** — no: la vista deriva de `f.total`
  (`0049:116-118`), que ya viene neto de retención por el CHECK. Ningún lector de
  `factura_emitida` reconstruye `subtotal + iva` (grepeado los 12 llamadores).

## Lo que NO alcancé a revisar

- **Nada corrió contra Postgres.** Sin base ni `.env`, no pude ejecutar ni una
  de las siete pruebas nuevas ni `verificaciones.sql`. Todo lo de arriba
  —incluidos los diffs de 0353— es lectura de archivos. Los «rojo real antes de
  aplicar» que las cabeceras afirman no los vi rebotar.
- **El interior de las 10 migraciones sin prueba corrida.** Igual que en la 29:
  leí sus tablas, CHECK y firmas para poder afirmar DAT30-B7; no leí la lógica de
  `procesar_jornadas_derivadas` (`0325`) ni la del lote de 2,000 acuses de la
  `0337`.
- **Si el cuerpo que 0353 imprime coincide con PRODUCCIÓN.** Verifiqué que
  coincide con lo que el **repo** dice que producción debería tener
  (`0306+0347`, `0286+0340`). Si producción hubiera derivado por alguna otra vía
  —un `create or replace` manual en la consola—, 0353 la acaba de pisar con la
  versión del repo y nadie lo notaría.
- **El alcance del dedup en las otras tres copias del predicado.** Documenté la
  divergencia de alcance de 0349/0355 contra `engine.ts`; no crucé si
  `0342`/`0307` (desglose de póliza, que también arman `folioNorm` en su jsonb)
  aplican el suyo por viaje o por tenant.
- **Reversibilidad, medida solo hasta la reaplicabilidad.** Ninguna migración
  del repo trae `down`, así que «reversible» siempre significa «escribir una
  compensatoria». Esta ronda medí reaplicabilidad de las nueve y el replay limpio
  de 0352; no barrí las 333 buscando `create index`/`add constraint` sin guarda.
- **Los 10 bloques de `verificaciones.sql` que la ventana tocó.** Leí el 267
  (0355) y el 144 (0356) completos y confirmé que divergen; los otros cambios de
  las +88 líneas (actualización del bloque 259 a `version=2`) los leí de pasada.
