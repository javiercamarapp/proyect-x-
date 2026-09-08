# Modelo de datos y esquema — auditoría 29

**Nota: 7/10** (antes 6). Razón del movimiento: **se atacó y subió**. El esquema
volvió a NO cambiar —324 `.sql`, hasta la 0347, tercera ronda sin migración
nueva— pero el hallazgo ALTO que hundió la nota a 6 **se cerró de verdad**, y no
solo de rótulo: `c65a01f` corrigió los dos textos de pantalla y, lo que importa
para este rubro, `supabase/tests/0344_analytics_sin_rechazadas.sql` **añadió el
caso n=8 que hace divergir las dos RPC a propósito** (`anticipo` 25: la dona lo
cuenta, el KPI no) y clavó los dos números esperados —dona 70, KPI 45— en el
mismo archivo. Ya no es una divergencia tácita: es una divergencia **fijada por
una prueba que corre contra Postgres real**. Ese es el criterio de cierre.

Y la segunda mitad del punto la puso una barrida más honda de lo que la 28
alcanzó: **las 155 tablas del esquema tienen RLS habilitada** (medido con guion
sobre las 324 migraciones, incluidos los dos `execute format` que ningún grep
ve), **ninguna policy usa `using (true)`**, `liquidacion` impone por CHECK la
identidad `diferencia = anticipo − comprobado` al centavo (`0146:68`), la
forma de `diferencias` (`0158:580-581`, array o nada) y los pisos no-negativos
de `gasto.monto`/`viaje.anticipo` (`0070:41,44`); y la coherencia
`liquidado ⇎ rechazada` la sostiene un **constraint trigger diferido**
(`0299:225-234`) que además el producto sabe narrar (`processor.ts:1331`). Tres
de los cuatro escenarios de fallo que abrí esta ronda murieron contra una
restricción que ya existía.

No es 8 por dos razones concretas, ambas abajo: hay **una invariante del
producto que hoy vive en una lista escrita a mano en TypeScript** y no en la
base (las dos tablas sin cascada), y **10 de las 21 exenciones** que cubren a
las migraciones 0324+ apuntan a archivos que `ci-postgres.yml` no ejecuta —o
sea, las garantías más nuevas del esquema no tienen prueba corrida.

**El riesgo mayor del rubro hoy:** no que la base acepte un estado imposible
—sigue sin aceptarlo—, sino que desde la **0324** ninguna migración tiene bloque
en `verificaciones.sql` (el último es el 263, de la 0323) y la evidencia se mudó
a `supabase/tests/`, donde el runner del CI es **una lista escrita a mano**: 29
de los 46 archivos no los corre nadie. Seis textos de exención afirman por
escrito que sí.

## ¿Cabe una migración nueva hoy?

**Sí, en el árbol y en la compuerta. Con un residuo medido, en el workflow de
recuperación.**

`861d09d` hizo lo que dice. `scripts/ci/staging-recovery.mjs:118-131` ya no
exige «exactamente 324 terminando en 0347»: hoy solo valida forma
(`/^\d{4}_.+\.sql$/`, al menos una, sin prefijos repetidos) y guarda la lista
observada en `manifest.migrations`; la protección real —que no aparezca una
migración entre `capture` y `execute`— se hace contra el manifiesto (`:194`), no
contra un número del pasado. Lo verifiqué además por el otro lado: el fixture de
`scripts/ci/staging-recovery.test.ts:22` **lee el directorio real**
(`readdirSync('supabase/migrations')`) y deriva de ahí `history`, así que un
`0348_*.sql` fluye por las 35 pruebas sin tocarlas. Y grepeé el resto del repo:
no queda ningún otro pin a 324 ni a `'0347'` fuera de comentarios y de fixtures
que fabrican sus propios archivos. **Los tres críticos que morían en ese cuello
de botella están desbloqueados.**

El residuo, y hay que decirlo porque es aritmética exacta:
`staging-recovery.mjs:214` sigue exigiendo `Number(physical[0].tables) !== 154`.
Conté las tablas del esquema con guion sobre las 324 migraciones: **155 nombres
distintos en `create table`, menos `foto_pendiente` que la `0041:18` dropea =
154.** El pin es correcto **hoy**, lo que significa exactamente que **la primera
migración que cree una tabla hace fallar `RECOVERY_FINAL_SCHEMA`** en
`recover-empty-staging.yml`. No bloquea el árbol ni el CI (la prueba mockea esa
respuesta, `staging-recovery.test.ts:20`), sí bloquea la recuperación el día que
haga falta. Va como DAT-B3.

**Consecuencia para la severidad de este reporte:** todo lo de abajo es
**arreglable con una migración**, no solo proponible. Eso sube el peso de los
reincidentes: llevan tres rondas sin arreglo y ya no tienen la excusa de la
compuerta cerrada.

## Estado de los hallazgos abiertos de la 28

| # | Hallazgo (28) | Veredicto | Evidencia |
|---|---|---|---|
| ALTO | «Dinero observado» definido dos veces, y la tarjeta con el rótulo de la definición que no usa | **CERRADO** | `vista.tsx:309` ahora dice «Todas las diferencias que el motor registró, por tipo — histórico completo, no solo fuera de política o duplicado»; `chat.tsx:106` dice «Fuera de regla o duplicado»; `analytics.ts` ya no afirma «mismo valor absoluto»; y `supabase/tests/0344_…sql:33-35,58-62` clava dona=70 vs KPI=45 con un `anticipo` en el fixture. Revertir cualquiera de los dos rótulos deja la prueba verde, pero revertir la **divergencia** ya no: la prueba la exige. |
| MEDIO | Dos poblaciones de `liquidacion` en la misma pantalla («10 cerradas» vs «7») | **REINCIDENTE** | Intacto. `0150:522-523` sigue contando sin filtro de revisión y `vista.tsx:243` sigue diciendo «cerradas». Ver DAT-M1. |
| MEDIO | Dos de 92 tablas con `tenant_id` no cascadean | **MUTADO** | `24a99e2` arregló el ORDEN y la lista de sobras en `qa-motor.ts:457-518` —de verdad, y con pruebas—, pero el propio commit escribe «Fuera de alcance a propósito: la FK `on delete cascade` de 0088/0089». La base sigue igual. Ver DAT-M2. |
| MEDIO | 19 de las 24 migraciones recientes sin bloque en `verificaciones.sql` | **MUTADO — y mi medición de la 28 estaba mal** | Existe `supabase/tests/`, 46 archivos, que la 28 no miró. El enunciado correcto es otro y es peor en otra dirección. Ver DAT-M3. |
| MEDIO | `revisar_liquidacion` y `ejecutar_arco_cancelacion` sin cuerpo vigente en el repo | **REINCIDENTE** | Sin migración nueva, por construcción. Reabrí los tres archivos: `0347` sigue parchando el cuerpo de la `0306`; `0340:12-19` sigue siendo el `do $migracion$` de `pg_get_functiondef` + `replace`. Ver DAT-M4. |
| BAJO | `cierre_insumos_hash` conserva la cuarta copia de la regla de combustible | **REINCIDENTE** | `0345:30` excluye `forma_pago_efectiva <> '99'`; `0321:129-140` no. Ver DAT-B1. |
| BAJO | 0343 sin registrar en `NUMERACION-SALTADA.md` | **CERRADO** | `7292f9d`. El archivo ahora lista `0277, 0293, 0295, 0343`, dice «estos **cuatro** números» en los dos lugares, y la fila de 0343 trae los dos shas que la explican. Leído completo. |
| BAJO | `0341` no reaplicable: `drop function` sin `if exists` | **REINCIDENTE** | `0341:35`, palabra por palabra, sin `if exists`. Ver DAT-B2. |

## Hallazgos

### [MEDIO · REINCIDENTE ×2] DAT-M1 — la misma pantalla cuenta 10 «liquidaciones cerradas» y 7 liquidaciones; la que miente es la que dice «cerradas»
`supabase/migrations/0344_analytics_sin_rechazadas.sql:23`,
`supabase/migrations/0150_agregados_analytics.sql:522-523`,
`supabase/migrations/0150_agregados_analytics.sql:368-369`,
`supabase/migrations/0299_revision_liquidacion.sql:415`,
`src/app/dashboard/agentes/liquidacion/vista.tsx:243`

Verificado esta ronda archivo por archivo: **ni una línea cambió**. `c65a01f`
tocó los rótulos de «dinero observado» y dejó éste en pie.

Escenario, con valores. Flota nueva, **10 liquidaciones en 12 semanas**, el
contralor **rechaza 3**. Rechazar corre `update viaje set estatus='en_cuadre'`
(`0299:415`) y deja `revision='rechazada'`. En
`/dashboard/agentes/liquidacion`, a la vez:

- «Tasa de cuadre · **7**» — `kpis_liquidacion_tenant` filtra
  `and revision <> 'rechazada'` (`0344:23`).
- «Liquidados: **7**» — `contarViajes(tenantId, ['liquidado'])`.
- «**10** liquidaciones cerradas en la ventana» bajo el mapa de calor
  (`vista.tsx:243`) — `liquidaciones_por_dia_tenant` es
  `from liquidacion where tenant_id = p_tenant and created_at >= p_desde`
  (`0150:522-523`), **sin filtro de revisión**.

La 0344 tocó dos RPC y dejó las otras cuatro que leen `liquidacion` con la
población vieja (`liquidado_semanal_tenant` `0150:368-369`,
`stats_operador_tenant` `0150:326-328`, `operadores_detalle_tenant`
`0150:433-435`).

Consecuencia: el contralor que acaba de devolver tres liquidaciones a cuadre las
ve seguir contadas como **cierres del periodo** en la misma pantalla donde acaba
de rechazarlas. Es el rótulo afirmando un hecho que él mismo deshizo hace un
minuto. Y para el equipo: cada RPC nueva sobre `liquidacion` tiene que acordarse
a mano de cuál de las tres poblaciones —todas, `sin_rechazadas`, `firmadas`— le
toca, porque nada en el esquema lo dice.

Causa raíz: la 0344 se acotó a «los importes operativos agregados» y un conteo
no es un importe — pero el rótulo que lo pinta sí afirma «cerradas».

### [MEDIO · MUTADO] DAT-M2 — la invariante «borrar un tenant borra todo lo suyo» pasó de estar rota a estar escrita a mano en TypeScript; la base sigue sin imponerla
`supabase/migrations/0088_chat_conversaciones.sql:20`,
`supabase/migrations/0089_agente_cobranza.sql:47`,
`src/lib/admin/qa-motor.ts:457-471`,
`src/lib/admin/qa-motor.ts:511-518`

El arreglo de `24a99e2` es bueno y hay que decirlo: `limpiarTenant` ahora borra
`chat_conversacion` y `cobranza_contacto` **antes** de tocar Storage y antes del
`delete from tenant`, así que un rebote deja todo intacto y la lista de sobras
nombra a la culpable. Pero es el arreglo del síntoma en el operador de QA, no de
la causa: `chat_conversacion.tenant_id uuid not null references
public.tenant(id)` (`0088:20`) y `cobranza_contacto.tenant_id … references
public.tenant(id)` (`0089:47`) siguen **sin cláusula `on delete`**, o sea
`NO ACTION`. El commit lo dice él mismo: «Fuera de alcance a propósito: la FK
`on delete cascade` de 0088/0089 es la serie M4».

Escenario, con valores, y es el chequeo que define el rubro. Una flota se va y
hay que honrar «borren mi cuenta». Quien lo ejecute no será `qa-motor.ts`
—`limpiarTenant` está guardado detrás de `exigirTenantZZZ` y solo corre en el
carril de QA—: será una persona en la consola SQL de Supabase escribiendo
`delete from public.tenant where id = '…';`. Si esa flota abrió alguna vez el
copiloto «Chatea con tus datos», sale
`23503 — update or delete on table "tenant" violates foreign key constraint
"chat_conversacion_tenant_id_fkey"`, sin decir por qué. Y a la inversa, el día
que alguien añada una **tercera** tabla con `tenant_id` sin cascada, la lista de
`qa-motor.ts:468` no se entera: 90 de las 92 tablas cuelgan de la base, y dos
cuelgan de que alguien se acuerde de editar un array.

Consecuencia: el borrado de cuenta —la obligación que sí llega con el primer
cliente— es una operación que la base rechaza y que hoy solo funciona si el
operador humano conoce dos nombres de tabla de memoria.

Causa raíz: 0088 y 0089 se escribieron antes del barrido de FK de la 0145, y ese
barrido se ocupó de las FK **compuestas** de las tablas hijas, no de la cláusula
`on delete` de las FK **a `tenant`** ya existentes.

### [MEDIO · MUTADO, con mi propia medición de la 28 corregida] DAT-M3 — desde la 0324 el esquema no tiene bloque en la batería, y 10 de las 21 exenciones que lo justifican apuntan a archivos que el CI no ejecuta
`src/lib/likida/migraciones_verificadas.test.ts:53`,
`src/lib/likida/migraciones_verificadas.test.ts:56`,
`.github/workflows/ci-postgres.yml:175-193`,
`supabase/verificaciones.sql` (último bloque: 263, mig. 0323)

Empiezo por corregirme: la 28 escribió «19 de las 24 migraciones más recientes
no tienen bloque en `verificaciones.sql`» y **no miró `supabase/tests/`**, que
tiene 46 archivos y cubre casi todas ellas. Medido de nuevo, bien, esta ronda:

- De las 23 migraciones 0324–0347, **solo 0326 y 0332 tienen bloque** en la
  batería (extraje los 243 títulos `-- ── N.` y crucé los números de `mig.`).
  Las otras **21 son `EXENTAS`** en `migraciones_verificadas.test.ts`, y la razón
  que dan es, en las 21, «su prueba vive en `supabase/tests/…`».
- El step que corre esos archivos (`ci-postgres.yml:175-193`) es **una
  enumeración escrita a mano**, no un glob. Crucé lo que cita contra
  `ls supabase/tests/`: **29 de los 46 archivos no los invoca nadie**, en ningún
  workflow ni script (`grep -rl "supabase/tests"` da un único fichero:
  `ci-postgres.yml`).
- Resultado: **10 exenciones** —0324, 0325, 0327, 0328, 0329, 0331, 0333, 0334,
  0336, 0337— apuntan a archivos que **nunca corren**. (0330 es mixta: corren sus
  dos archivos de retención, no los dos de GPS que su exención cita.)
- Cuatro de esas diez lo confesaron al escribirse: «Esta exención sólo clasifica
  dónde vive la evidencia; **no afirma que ci-postgres los ejecute**»
  (`:60`, 0333; igual 0334, 0336, `:64` 0337). **Las otras seis afirman lo
  contrario**: la 0324 dice «ejecutados contra PostgreSQL real» (`:53`) y la 0328
  dice que las suites de 0330/0333 «ejercen el contrato vigente, incluida la
  carrera, sobre PostgreSQL real» (`:56`).

Escenario, con valores y con nombres. La `0341:35-36` **dropea y recrea**
`reclamar_eventos_seguridad` —le agrega `privacidad_minima` al `RETURNS TABLE` y
le mete una rama nueva—. El único archivo del repo que ejercita esa función
contra Postgres de verdad es `supabase/tests/0324_gps_poll_durable.sql`, que la
llama **16 veces** para probar el reparto justo entre cinco tenants, el lease de
360 s (no la roba otro worker a +121 s ni a +300 s, sí a +361 s), el
`SKIP LOCKED`, el veneno y el backoff. Ese archivo **no está en la lista del
step**. O sea: el PR de la 0341 pasó en verde sin correr ni una de esas 16
aserciones, y si el cuerpo nuevo hubiera dejado que dos workers reclamaran el
mismo choque, el CI habría dicho verde igual — y el resultado en el teléfono del
dueño de la flota son **dos alertas de choque para un choque**, o ninguna.

Consecuencia: para las once garantías más nuevas de la base —poller GPS durable,
capacidad de jornada y su PK inmutable con DST, lote atómico de 2,000 acuses,
retención forward de Cal.com— «está probado contra Postgres» es hoy una
afirmación escrita en un `Record<string,string>`, no un hecho. Y la prueba que
existe para impedir justo eso (`migraciones_verificadas.test.ts`, «obliga a que
toda migración nueva tome una decisión explícita») acepta como razón un puntero
a un archivo que nadie ejecuta.

Nota de honestidad entre rubros: `pruebas` ya trae este hueco desde la 27 («29
de 47 arneses sin invocador», reincidente en la 28) y por eso **no lo cuento
como ALTO nuevo mío**. Lo que aporto aquí es la mitad que le toca a este rubro y
que no estaba escrita: **cuáles migraciones quedan sin prueba corrida** (las
diez de arriba) y que **seis textos de exención afirman una ejecución que no
ocurre**.

### [MEDIO · REINCIDENTE ×3] DAT-M4 — `revisar_liquidacion` y `ejecutar_arco_cancelacion` siguen sin cuerpo vigente en ningún archivo del repo
`supabase/migrations/0347_revision_duplicados_identidad.sql:69`,
`supabase/migrations/0340_arco_alcance_cancelacion.sql:12-19`,
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:80`

Sin migración nueva, por construcción: el último archivo con un
`create or replace` COMPLETO de `revisar_liquidacion` sigue siendo la **0306**
—el cuerpo que la 0347 vino a corregir— y la 0340 sigue parchando
`ejecutar_arco_cancelacion` con `pg_get_functiondef` + `replace` sobre una
definición que **no imprime en ningún archivo** (`0340:12-19`); el último cuerpo
completo de la ARCO es el de la `0286:57-155`, dos parches atrás. Escenario y
consecuencia sin cambio en `docs/auditoria-27/datos.md:23-55`.

Lo que esta ronda le agrega: ya **cabe una migración nueva** (arriba), así que
la razón operativa para no consolidar el cuerpo desapareció.

### [BAJO · REINCIDENTE] DAT-B1 — `cierre_insumos_hash` conserva la cuarta copia de la regla de medio de pago de combustible, y sigue siendo la vieja
`supabase/migrations/0321_cierre_snapshot_atomico.sql:129-140`,
`supabase/migrations/0345_combustible_rep_por_definir.sql:28-32`

Abiertos los dos esta ronda. `0345:30` excluye `forma_pago_efectiva <> '99'` del
numerador de efectivo; el bloque `combustible` de `0321:129-140` reconstruye la
misma forma efectiva con un `case` (`forma_pago='99' and pagado_en is not null`
→ `pagado_forma`) y **no excluye el `'99'` resultante**. Un CFDI de diésel con
`forma_pago='99'` cuyo REP trae `FormaDePagoP='99'` entra al numerador del hash
y no al del acumulado. Sigue sin mover un peso —solo alimenta un SHA-256 que
compara «antes y después»— y sigue siendo la misma regla fiscal escrita dos
veces con dos veredictos, en el archivo cuyo trabajo es demostrar que nada
cambió.

### [BAJO · REINCIDENTE] DAT-B2 — `0341` sigue siendo la única de su ronda no reaplicable, con `drop function` sin `if exists`
`supabase/migrations/0341_gps_alerta_minima_privacidad.sql:35`

`grep -n "if exists"` sobre el archivo **no devuelve nada**, y la línea 35 es
`drop function public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz);`
pelado, dentro de su propio `begin;`/`commit;`. Sus hermanas siguen declarando
lo contrario (`0347:3` «Reaplicable», `0340:18` «Reaplicación: no redefine»).
Refuté la versión grave: la firma de seis argumentos **sí** existe desde
`0324:477`, así que un replay limpio desde cero no rompe; lo que rompe es
reaplicar la 0341 sola.

### [BAJO · NUEVO] DAT-B3 — el candado de recuperación se abrió para el conteo de migraciones y quedó cerrado para el conteo de tablas: la primera migración que cree una tabla rompe `RECOVERY_FINAL_SCHEMA`
`scripts/ci/staging-recovery.mjs:214`,
`scripts/ci/staging-recovery.test.ts:20`,
`supabase/migrations/0041_foto_pendiente_revertida.sql:18`

`861d09d` sustituyó el pin de `324/'0347'` por un verificador por conjunto —bien
hecho, ver arriba— pero dejó intacto el pin gemelo tres párrafos más abajo:
`Number(physical[0].tables) !== 154` → `fail('RECOVERY_FINAL_SCHEMA')`.

Escenario, con aritmética. Conté con guion sobre las 324 migraciones: **155
nombres distintos en `create table`**, menos `foto_pendiente` que la `0041:18`
dropea = **154**. El pin coincide con la realidad de hoy, que es justo el
problema: en cuanto entre una `0348` con un `create table` —la serie M4 de
DAT-M2 no lo necesita, pero cualquier tabla nueva sí—, `recover-empty-staging`
falla **después** de haber corrido `db reset --linked` sobre staging (`:200`),
con el esquema ya destruido y `db push` ya aplicado. El CI no lo ve: el fixture
`staging-recovery.test.ts:20` devuelve `{tables: 154}` mockeado, así que las 35
pruebas siguen verdes mientras el workflow real queda muerto.

Consecuencia: el procedimiento de recuperación de staging deja de funcionar en
silencio, y se entera quien lo necesita, el día que lo necesita.

### [BAJO · NUEVO] DAT-B4 — dos dominios de rol en el mismo esquema divergieron: `invitacion` todavía admite `operador` (retirado en la 0086) y no admite `vendedor` (agregado en la 0105)
`supabase/migrations/0053_cuentas_bitacora_arco_campanias.sql:45`,
`supabase/migrations/0086_retirar_rol_operador.sql:98`,
`supabase/migrations/0105_zona_vendedores.sql:52`

`invitacion_rol_dominio` es
`check (rol in ('flota_admin','contador','encargado','operador'))` y **ninguna
migración posterior lo vuelve a tocar** (grepeado sobre las 324). Su tabla
hermana, `app_user_rol_dominio`, se reescribió dos veces desde entonces: la
`0086:98` quitó `operador` («el chofer solo tiene WhatsApp») y la `0105:52` lo
dejó en `('superadmin','flota_admin','contador','encargado','vendedor')`.

Escenario, con valores: `insert into public.invitacion (tenant_id, email, rol,
token_hash, expira_en) values (…, 'contralor@flota.mx', 'operador', …, now() +
interval '7 days')` **la base lo acepta**, y el rol que lleva no existe para
`app_user`: quien la acepte no puede provisionarse (23514 contra
`app_user_rol_dominio`). En el otro sentido, invitar a un `vendedor` la base lo
rechaza, aunque el rol lleve nueve migraciones vivo y tenga su propio panel.

Lo digo con su atenuante, que es grande: **`invitacion` no tiene escritor** —el
único acierto de `grep -rn "invitacion"` en `src/` es una prueba de catálogo—,
así que hoy la única entrada es la consola SQL. Lo reporto igual porque es
exactamente la forma del rubro: la pantalla de invitar al contador es la
siguiente que se construye para el primer cliente, y el dominio que la va a
recibir lleva 250 migraciones sin actualizarse.

## Lo que revisé y está bien

Lo que dice «guion» lo extraje programáticamente de las 324 migraciones y lo
crucé; el resto lo abrí a mano esta ronda.

- **Las 155 tablas del esquema tienen RLS habilitada (guion).** Extraje los
  nombres de `create table` y los de `enable row level security`, **incluidos
  los dos `execute format(...)` que ningún grep literal ve** (`0001:107-112` con
  siete tablas, `0047:157-162` con cuatro). Diferencia: **cero**. Además,
  `grep -i "using (true)"` sobre las 324 migraciones **no devuelve nada**: no
  hay una sola policy permisiva. Hay 73 `create policy` para 155 tablas, y eso
  es correcto y deliberado —una tabla con RLS y sin policy es deny-all para
  `anon`/`authenticated`, que es el default seguro; la 0088 lo escribe con todas
  sus letras (`:14`)—. La 28 no midió esto.
- **La coherencia `liquidado ⇎ rechazada` la impone la base, y el producto la
  narra.** Abrí el escenario que parecía el mejor candidato a CRÍTICO: contralor
  rechaza (`0299:408-415`, `revision='rechazada'`, viaje a `en_cuadre`), el
  chofer vuelve a escribir «listo» **sin cambiar nada**, `guardar_liquidacion_tx`
  hace `on conflict (viaje_id) do update` (`0321:325-337`) que **no toca
  `revision`**, y el `update viaje set estatus='liquidado'` (`0321:339`) cerraría
  con la fila rechazada. No pasa: el trigger `liquidacion_revision_regla`
  (`0299:140-157`) retira la firma si cambia cualquiera de las cinco cifras, y si
  no cambian, el **constraint trigger diferido** `trg_viaje_revision_coherente`
  (`0299:230-234`) revienta al commit con «el viaje X está liquidado y su
  liquidación está rechazada: una de las dos miente». Falla cerrado. Y —esto es
  lo que lo cierra de verdad— el producto lo espera: `confirmarCierreEnBase`
  (`processor.ts:1352-1354`) lee `revision` y `viaje.estatus` en **un solo
  snapshot** y contesta `RESPUESTA_CIERRE_RECHAZADO` (`processor.ts:1331`), que
  es una frase útil, no un 23514.
- **La identidad del cuadre es un CHECK, no una convención.**
  `liquidacion_diferencia_cuadra` (`0146:68`):
  `abs(diferencia - (total_anticipo - total_comprobado)) <= 0.01`, con el
  comentario que explica que la **negativa es válida** (se comprobó más que el
  anticipo). O sea: la resta que hace `engine.ts` no puede desalinearse de la
  fila ni por el camino de `ajustar` (`0306:227-236`, que reescribe
  `total_comprobado` y `diferencia` sin tocar `total_anticipo` — y el CHECK es
  quien garantiza que eso siga cuadrando).
- **Los pisos del dinero están puestos y razonados.** `0070` cerró los dos
  huecos que importaban (`gasto_monto_no_negativo`, `viaje_anticipo_no_negativo`,
  `:41` y `:44`) y su cabecera enumera los que ya existían (`pago_recibido.monto > 0`,
  `tarifa.precio > 0`, `factura_emitida`, `cotizacion`,
  `viaje.intake_pendientes >= 0`). Sumado a los tres guardas `<> 'NaN'` de la
  `0025:104,114,129` —que importan más de lo que parecen, porque en Postgres
  `numeric` NaN es **mayor** que cualquier número y `liquidacion_totales_no_negativos`
  (`0146:63`) lo dejaría pasar solo—, el camino del dinero no admite un
  negativo ni un NaN por ninguna de sus columnas.
- **`liquidacion.diferencias` sí tiene forma impuesta.** `0158:580-581`:
  `check (diferencias is null or jsonb_typeof(diferencias) = 'array')`. Lo
  busqué porque cinco RPC hacen `jsonb_array_elements` sobre esa columna
  (`0112:324`, `0150:487`, `0299:376`, `0306:201`, `0344:18` y `:49`, `0347` en
  cuatro sitios) y un objeto ahí reventaría el KPI de la flota entera con
  `22023`. La base no lo permite.
- **Los dominios enumerados que el código nuevo escribe existen y lo cubren.**
  `evento_seguridad_flota.aviso_estado`, que la `0330:155` copia CRUDO desde
  `wa_outbox.estado` (`update … set aviso_estado = new.estado`), tiene su CHECK
  en `0324:420-422` con `('no_requerido','pending','sending','sent','dead')`, y
  el dominio de origen (`0180:71`, `('pending','sending','sent','dead')`) es
  **subconjunto estricto** del destino: la copia no puede violar el CHECK. Lo
  crucé porque es la forma exacta del defecto que busco —dos enumeraciones que
  tienen que ser subconjunto una de la otra por acuerdo tácito— y aquí el
  acuerdo se cumple.
- **La unicidad del CFDI está impuesta donde el manual dice.**
  `uq_gasto_cfdi_uuid` sobre `(tenant_id, cfdi_uuid, cfdi_orden)` (`0065:69`,
  que reemplazó a propósito el `(tenant_id, cfdi_uuid)` de la 0019 cuando
  apareció la consolidada de CAPUFE), más `factura_proveedor` (`0091:41`),
  `cfdi_xml` (`0009:12`) y `sat_cfdi_descargado_unico` (`0231:239`). El mismo
  folio fiscal no se liquida dos veces, y no por convención.
- **`liquidacion` no puede tener dos filas por viaje**: `liquidacion_viaje_uidx`
  (`0005:9`), único sobre `viaje_id` — que es lo que hace atómico el
  `on conflict (viaje_id)` del cierre.

### Auto-refutaciones (hallazgos que abrí y maté yo mismo)

- **«El re-cierre tras un rechazo deja la liquidación firme como rechazada»** —
  no: dos triggers de la 0299 lo impiden y el producto lo narra. Ver arriba. Era
  mi mejor candidato a CRÍTICO de la ronda.
- **«`liquidacion.diferencias` acepta un objeto y revienta el KPI de la flota»** —
  no: `0158:580-581`. La restricción llegó 186 migraciones después del `create
  table`, que es justo por lo que el prompt manda buscarla antes de reportar.
- **«El upsert del cierre pisa la liquidación rechazada sin archivarla»** — pisa
  la fila, sí (`0321:325-337`), y `liquidacion_historico` solo la escribe
  `reabrir_viaje_tx` (`0159:228`). Pero el rechazo **sí queda**: la RPC inserta
  en `bitacora_auditoria` en la misma transacción con actor, correo, folio y
  motivo (`0299:419-423`). No se pierde el acto humano, solo las cifras de la
  versión pisada — y eso no alcanza para un hallazgo con dinero.
- **«El KPI y la dona tratan distinto un `monto` que no sea número»** — cierto en
  el papel: `0344:47` guarda con `jsonb_typeof(e->'monto') = 'number'` y `0344:17`
  hace `abs((d->>'monto')::numeric)` a pelo, así que un `"monto": "1,234"`
  reventaría el KPI con `22P02` y valdría 0 en la dona. **No hay escritor**: el
  único que llena esa columna es el motor en TS (`Diferencia.monto: number`) y
  `JSON.stringify` convierte `NaN`/`Infinity` en `null`, que las dos ramas
  tratan igual. Sin escritor no hay escenario, y sin escenario no es hallazgo.
- **«`posicion.proveedor` no tiene dominio y mezcla el pin del chofer con la
  telemetría de la unidad»** — la columna es `text not null` sin CHECK
  (`0050:58`; el CHECK de `0050:125` es de `rastreo_credencial`, otra tabla), y
  los dos escritores meten literales distintos (`'whatsapp'` en
  `processor.ts:199`, el id del conector en `sincronizar_gps.ts`). Pero **ningún
  lector se bifurca por ese valor**: solo se pinta. Sin consecuencia, no lo
  reporto.
- **«0341 rompe un replay limpio»** — no: la firma de seis argumentos que dropea
  la crea `0324:477`, así que aplicar las 324 en orden sobre base virgen
  funciona. El daño se queda en la reaplicación (DAT-B2).

## Lo que NO alcancé a revisar

- **Nada corrió contra Postgres.** Sin base, sin `.env` y sin poder correr
  `verificaciones.sql` ni los 46 archivos de `supabase/tests/`, todo lo de
  arriba —incluidos los guiones— es lectura de catálogo sobre archivos. No vi
  rebotar una sola fila. Lo cual, después de DAT-M3, es la observación más
  incómoda del reporte: para once migraciones **nadie** las ha visto rebotar.
- **Reversibilidad, otra vez sin medir.** Ninguna migración trae `down`, y es el
  criterio del rubro que llevo tres rondas dejando pendiente. Esta ronda solo
  miré **reaplicabilidad** (DAT-B2) y **replay limpio desde cero** para la 0341.
  No barrí las 324 buscando `create index` / `add constraint` sin guarda.
- **Las diez migraciones sin prueba corrida, por dentro.** Leí sus tablas,
  índices, CHECK, FK y firmas para poder afirmar DAT-M3; **no** leí la lógica de
  `sincronizar_jornadas_por_derivar`, `procesar_jornadas_derivadas` (`0325`,
  1,432 líneas) ni la del lote de 2,000 acuses de la `0337`. Si hay un defecto
  ahí dentro, este reporte no lo encontró y el CI tampoco lo va a encontrar.
- **El orden de disparo de los triggers RI con dos FK al mismo padre.** Sigue
  siendo teórico: reconfirmé (guion, 33 pares de la `0145:137-169`) que no hay
  ningún par con acciones distintas. Si alguien añade uno, sigue sin haber quien
  lo detecte.
- **Las otras cuatro RPC de la 0150 que leen `liquidacion`.** Confirmé que no
  filtran rechazadas (DAT-M1); no recorrí qué pantalla pinta cada una ni si su
  rótulo las contradice como el de «cerradas».
- **`ejecutar_arco_cancelacion` sobre `posicion` y `app_user.email`.** La función
  declara por escrito que no los toca (`0173:100-106`, `0340:26`). Si esa
  declaración basta legalmente es del rubro legal, no de éste.
