# Modelo de datos y esquema — auditoría 28

**Nota: 6/10** (antes 7). Razón del movimiento: **mirada más profunda**. El
esquema no cambió —siguen 324 `.sql`, hasta la 0347, ni una migración nueva—,
así que no empeoró: **se vio mejor**. La nota de 7 se sostenía con esta frase
literal de la 27: «el auditor no pudo escribir un solo escenario *entra X → sale
Y mal* con dinero». Esta ronda lo escribí: `kpis_liquidacion_tenant` y
`dinero_observado_por_tipo_tenant` —dos funciones del mismo esquema, tocadas por
la MISMA migración 0344 el mismo día— definen «dinero observado» con dos
predicados distintos, y la tarjeta que lo pinta en `/dashboard` lleva el rótulo
de la definición que NO usa. Con un anticipo de $20,000 y $12,000 comprobados, el
chat del panel dice «Dinero observado $300» y la tarjeta dice «$8,300». Los
cimientos que la 27 midió siguen firmes —los volví a medir con guion, más a
fondo, y aguantaron todos— pero el punto extra no era de ellos.

Lo que verifiqué de nuevo y **sí** aguantó (guion, no lectura suelta): las 33 FK
compuestas `(col, tenant_id)` que la 0145 monta con `execute format` espejan
carácter por carácter la acción `on delete` de la FK simple que ya existía en la
misma columna — **0 divergencias en 33 pares**; 90 de las 92 tablas con
`tenant_id` cuelgan del tenant con `on delete cascade`; ningún `onConflict` de
`src/` apunta a un único que no exista o que sea parcial; y los guardas `<>
'NaN'` de la 0025 cubren las tres columnas por las que pasa el dinero del cierre.

**El riesgo mayor del rubro hoy** no es que la base acepte un estado imposible
—no lo acepta— sino que el esquema guarda **dos definiciones del mismo agregado
de dinero**, y nada en `verificaciones.sql` compara una contra la otra: 19 de las
24 migraciones más recientes siguen sin un solo bloque en la batería (medido otra
vez esta ronda: `grep -c` da 0 para las 19).

## Hallazgos

### [ALTO] «Dinero observado» está definido dos veces en el esquema con dos predicados distintos, y la tarjeta que lo pinta lleva el rótulo de la definición que no usa
`supabase/migrations/0344_analytics_sin_rechazadas.sql:19`,
`supabase/migrations/0344_analytics_sin_rechazadas.sql:29`,
`supabase/migrations/0344_analytics_sin_rechazadas.sql:49-50`,
`src/lib/likida/analytics.ts:327-331`,
`src/app/dashboard/agentes/liquidacion/vista.tsx:305`,
`src/app/dashboard/agentes/liquidacion/vista.tsx:309`,
`src/app/dashboard/chat.tsx:106`,
`src/lib/likida/cuadre/engine.ts:1241-1247`

Escenario, con valores. Un viaje con **anticipo $20,000** y **$12,000
comprobados**, más un solo gasto **$300 sobre política**. El motor empuja a
`liquidacion.diferencias` dos entradas: `{tipo:'sobre_politica', monto:300}` y
`{tipo:'anticipo', monto:8000}` (`engine.ts:1241-1247` — `monto: diferencia`, la
resta completa del anticipo; se persiste íntegra vía `p_diferencias`,
`repo.ts:1153`). Entonces:

- `kpis_liquidacion_tenant` suma **solo** los tipos `('sobre_politica',
  'duplicado')` (`0344:19`) → `diferenciaDetectada = 300`. Ese número sale a
  pantalla con el rótulo literal **«Dinero observado»** en `chat.tsx:106`, y como
  «Diferencias detectadas por el motor» en la herramienta MCP
  (`src/lib/mcp/herramientas/dinero.ts:244`).
- `dinero_observado_por_tipo_tenant` **no filtra por tipo**: desanida
  `jsonb_array_elements(l.diferencias)` entero y suma `abs(monto)` de los ~40
  tipos (`0344:49-50`) → **$8,300**. Ese número es el titular de la tarjeta
  **«Dinero observado»** de `/dashboard/agentes/liquidacion`
  (`vista.tsx:305` es el `reduce`, `vista.tsx:308` el `<h2>`), y su subtítulo,
  en la línea de abajo, dice **«Lo que el agente atrapó fuera de regla o
  duplicado»** (`vista.tsx:309`) — que es la definición de la OTRA función.

Entra: una flota cuyos choferes devuelven cambio del anticipo (lo normal). Sale:
la tarjeta afirma que el agente «atrapó fuera de regla o duplicado» una cifra que
en su mayor parte es **anticipo sobrante devuelto** —dinero de la empresa que
nunca salió de regla—, y el mismo panel, en su chat, da otro número con el mismo
rótulo. Aquí son 27× de diferencia; el factor lo fija el hábito de la flota, no
un tope.

Agravante que lo hace inauditable desde el código: el comentario de
`analytics.ts:327-331` afirma que «`getKpis` suma el total; esta lo abre para la
dona — misma fuente, **mismo valor absoluto**». Es falso desde la 0112/0150 y la
0344 pasó por las dos funciones sin notarlo. Y `dinero_observado_por_tipo_tenant`
ni siquiera recibe `p_desde` (`0344:38`), mientras que `kpis_liquidacion_tenant`
sí (`0344:6`): además de sumar poblaciones distintas, suman ventanas distintas.

Consecuencia: el contralor. Es exactamente la regla de la casa —«una cifra fiscal
que se lee distinto en dos pantallas se lee como dos cálculos»— rota dentro del
esquema, y el número inflado es el que encabeza la pantalla del agente que le
vendemos. En una sala, cruzar la tarjeta contra el chat cuesta el trato.

Causa raíz probable: el rótulo y el subtítulo de la tarjeta se escribieron cuando
el desglose solo tenía dos tipos; la auditoría 18 amplió `ROTULO_DIFERENCIA` a
los ~40 tipos (`rotulo-diferencia.ts:18`) sin que nadie volviera a mirar si el
predicado del KPI hermano había crecido igual.

### [MEDIO] Desde la 0344 hay dos poblaciones de `liquidacion` en la misma pantalla: la tarjeta de KPI descuenta las rechazadas y el mapa de cierres no
`supabase/migrations/0344_analytics_sin_rechazadas.sql:23`,
`supabase/migrations/0150_agregados_analytics.sql:522-523`,
`supabase/migrations/0150_agregados_analytics.sql:326-328`,
`supabase/migrations/0299_revision_liquidacion.sql:415`,
`src/app/dashboard/agentes/liquidacion/vista.tsx:243`,
`src/app/dashboard/agentes/liquidacion/page.tsx:81`

Escenario. Una flota nueva —el caso real de Likida— con **10 liquidaciones en sus
primeras 12 semanas**, de las que el contralor **rechazó 3**. Rechazar corre
`update viaje set estatus = 'en_cuadre'` (`0299:415`), así que el viaje deja de
estar liquidado. En la misma pantalla `/dashboard/agentes/liquidacion`:

- «Tasa de cuadre · **7** liquidaciones» — `kpis_liquidacion_tenant` filtra
  `revision <> 'rechazada'` desde la 0344 (`0344:23`).
- «Liquidados: **7**» en el bloque de ciclo — `contarViajes(tenantId,
  ['liquidado'])` (`analytics.ts:909-920`), coherente con la 0299.
- «**10** liquidaciones cerradas en la ventana» bajo el mapa de calor
  (`vista.tsx:243`) — `liquidaciones_por_dia_tenant` cuenta `from liquidacion
  where tenant_id = p_tenant and created_at >= p_desde` (`0150:522-523`), **sin
  filtro de revisión**. La 0344 tocó dos RPC y dejó las otras cuatro que leen
  `liquidacion` con la población vieja (`liquidado_semanal_tenant` `0150:368-369`,
  `stats_operador_tenant` `0150:326-328`, `operadores_detalle_tenant`
  `0150:433-435`).

Sale: tres cifras del mismo hecho en una sola pantalla, una de ellas
contradiciendo a las otras dos, y la que miente es la que dice **«cerradas»**
sobre liquidaciones que el propio contralor devolvió a cuadre.

Consecuencia: el contralor que acaba de rechazar tres liquidaciones las ve
seguir contadas como cierres del periodo; y el equipo, porque cada RPC nueva
sobre `liquidacion` tiene que acordarse a mano de cuál de las tres poblaciones
—todas, `sin_rechazadas`, `firmadas`— le toca.

Causa raíz probable: la 0344 se acotó a «los importes operativos agregados» y
`liquidaciones_por_dia_tenant` es un conteo, no un importe — pero el rótulo que
lo pinta sí afirma un hecho («cerradas») que el rechazo deshace.

### [MEDIO] Dos de las 92 tablas con `tenant_id` no cascadean: un `delete from tenant` rebota, y el único borrado de tenant que existe ya borró el Storage antes de enterarse
`supabase/migrations/0088_chat_conversaciones.sql:20`,
`supabase/migrations/0089_agente_cobranza.sql:47`,
`src/lib/admin/qa-motor.ts:422-437`,
`src/lib/admin/qa-motor.ts:442-443`

Escenario. `chat_conversacion.tenant_id uuid not null references
public.tenant(id)` y `cobranza_contacto.tenant_id uuid not null references
public.tenant(id)` — **sin cláusula `on delete`**, o sea `NO ACTION`. Son las dos
únicas excepciones que encontré: las otras 90 tablas con `tenant_id` llevan `on
delete cascade` (extraído con guion sobre las 324 migraciones; `factura_viaje`
ganó el suyo en `0145:100` y `qa_corrida` es `set null` a propósito). Ninguna
migración posterior les añade la acción (grepeado: solo 0088:37, 0126:46 y
0145:140 vuelven a nombrarlas, y ninguno toca esa FK).

Entra: una corrida de QA sobre un tenant `ZZZ` en la que alguien abrió una
conversación del copiloto o el agente de cobranza dejó un contacto. `limpiarTenant`
**primero** borra los objetos de Storage de los buckets `comprobantes` y
`liquidaciones` (`qa-motor.ts:422-437`) y **después** intenta
`db.from('tenant').delete()` (`:442`). Sale: `23503 — update or delete on table
"tenant" violates foreign key constraint "chat_conversacion_tenant_id_fkey"`. El
`if (del.error)` lo reporta (`:443`, mérito suyo: falla ruidosa), pero el orden ya
dejó el tenant vivo con sus filas de `gasto` y `liquidacion` **apuntando a fotos y
PDFs que ya no existen**. La lista de sobras que corre después (`:450`) no incluye
ni `chat_conversacion` ni `cobranza_contacto`, así que tampoco nombra a la
culpable.

Consecuencia: el equipo que opera QA, hoy. Y, el día que haya que honrar «borren
mi cuenta» de una flota que se va, `delete from tenant` es una operación que la
base rechaza sin decir por qué — no hay hoy ningún otro camino de producto que
borre un tenant, así que la deuda está intacta y sin descubrir.

Causa raíz probable: 0088 y 0089 se escribieron antes del barrido de FK de la
0145, y ese barrido se ocupó de las FK **compuestas con tenant** de las tablas
hijas, no de revisar la cláusula `on delete` de las FK **a `tenant`** ya
existentes.

### [MEDIO · REINCIDENTE] `revisar_liquidacion` y `ejecutar_arco_cancelacion` siguen sin cuerpo vigente en ningún archivo del repo
`supabase/migrations/0347_revision_duplicados_identidad.sql:69`,
`supabase/migrations/0340_arco_alcance_cancelacion.sql:12-19`,
`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:80`

Verificado esta ronda: no entró ninguna migración, así que el último archivo con
un `create or replace` COMPLETO de `revisar_liquidacion` sigue siendo la 0306 —el
cuerpo que la 0347 vino a corregir— y la 0340 sigue parchando
`ejecutar_arco_cancelacion` con `pg_get_functiondef` + `replace` sobre una
definición que no imprime (`0340:12-19`). Escenario y consecuencia, sin cambio,
en `docs/auditoria-27/datos.md:23-55`. Lo confirmo abriendo los tres archivos:
la 0340 solo contiene el `do $migracion$` de sustitución de texto; el último
cuerpo completo de la ARCO es el de la `0286:57-155`, dos parches atrás.

### [MEDIO · REINCIDENTE] 19 de las 24 migraciones más recientes no tienen bloque en `verificaciones.sql`
`supabase/verificaciones.sql`

Medido de nuevo esta ronda, no recordado: `grep -c` sobre `verificaciones.sql` da
**0** para 0324, 0325, 0327, 0329, 0330, 0331, 0333, 0334, 0335, 0336, 0337,
0338, 0339, 0340, 0341, 0344, 0345, 0346 y 0347. Idéntico a la 27. Y esta ronda
gana peso: la batería es lo único que corre contra un Postgres de verdad, y es
justo lo que habría podido afirmar «`dinero_observado_por_tipo_tenant` y
`kpis_liquidacion_tenant` suman lo mismo sobre el mismo dataset» — el hallazgo
ALTO de arriba. Escenario completo en `docs/auditoria-27/datos.md:57-82`.

### [BAJO · REINCIDENTE] `cierre_insumos_hash` conserva la cuarta copia de la regla de medio de pago de combustible, y sigue siendo la vieja
`supabase/migrations/0321_cierre_snapshot_atomico.sql:129-140`,
`supabase/migrations/0345_combustible_rep_por_definir.sql:28-32`

Verificado abriendo los dos: `0345:30` excluye `forma_pago_efectiva <> '99'` del
numerador de efectivo; el bloque `combustible` de `0321:129-140` reconstruye la
misma forma efectiva con un `case` y **no** excluye el `'99'` resultante. Un CFDI
de diésel con `forma_pago='99'` cuyo REP trae `FormaDePagoP='99'` entra al hash y
no al acumulado. Sigue sin mover un peso (solo alimenta un SHA-256), sigue siendo
la regla fiscal escrita dos veces con dos veredictos.

### [BAJO · REINCIDENTE] El número 0343 sigue sin registrarse en `NUMERACION-SALTADA.md`
`supabase/migrations/NUMERACION-SALTADA.md`

Abierto y leído esta ronda: el archivo lista **0277, 0293 y 0295**, y dice
literalmente «estos tres números no existieron nunca y no deben reutilizarse».
**0343 no está**, y `ls supabase/migrations` sigue saltando de
`0342_poliza_revision_y_desglose.sql` a `0344_analytics_sin_rechazadas.sql`. El
atenuante de la 27 sigue vigente: `compuerta-deploy.mjs:126-136` compara
conjuntos de prefijos, así que un 0343 futuro bloquearía el build en vez de
colarse.

### [BAJO · REINCIDENTE] `0341` sigue siendo la única de su ronda no reaplicable, con `drop function` sin `if exists`
`supabase/migrations/0341_gps_alerta_minima_privacidad.sql:35`

Verificado línea por línea: `grep -n "if exists"` sobre el archivo **no devuelve
nada**, y la línea 35 es `drop function
public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz);`
pelado, dentro de su propio `begin;`/`commit;`. Sus hermanas siguen declarando lo
contrario (`0347:3` «Reaplicable», `0340:18` «Reaplicación: no redefine»).

## Lo que revisé y está bien

Todo lo de abajo lo abrí esta ronda; lo que dice «guion» lo extraje
programáticamente de las 324 migraciones y lo crucé, no lo leí a ojo.

- **Las FK compuestas de la 0145 no divergen de las simples (guion, 33 pares, 0
  fallos).** La 0145 monta sus FK `(col, tenant_id)` con `execute format(... on
  delete %s ...)` dentro de un `do $$` (`0145:193-197`), así que ningún grep las
  ve. Extraje las 33 tuplas de su tabla de `values` (`0145:137-169`) y las crucé
  contra la última definición de la FK simple sobre la MISMA columna: **las 33
  coinciden** (`cascade` con `cascade`, `set null` con `set null`, `restrict` con
  `restrict`). Era el modo de falla que buscaba —dos FK sobre la misma columna
  con acciones distintas, cuyo resultado depende del orden de disparo de los
  triggers RI— y **no existe**. De paso: el `on delete set null (viaje_id)` que
  genera ese `format` es la sintaxis de columna acotada de PostgreSQL 15+, y es la
  correcta: deja `tenant_id` (que es `not null`) en paz.
- **La cascada del tenant está completa salvo las dos del hallazgo (guion).**
  Extraje las 155 tablas y sus columnas de las 324 migraciones: **92 tienen
  `tenant_id`**, y 90 cuelgan con `on delete cascade`. Las dos excepciones son el
  hallazgo MEDIO; `factura_viaje` (que nació sin `tenant_id`) lo ganó con cascada
  en `0145:100` y su trigger de herencia en `0145:107-124`; `qa_corrida` es `set
  null` a propósito.
- **Ningún `onConflict` de `src/` apunta a un único inexistente o parcial
  (guion).** Crucé los 44 `.upsert(..., { onConflict })` de `src/` contra todos
  los `unique`/`create unique index`/PK del esquema. Tres saltaron y los tres son
  falsos positivos de mi extractor: `bus_pieza.carpeta` es un `constraint … unique`
  en línea (`0127:56`), `posicion(tenant_id,unidad_id,medida_en)` es
  `uq_posicion_lectura` (`0176:66-67`, creado a propósito **sin `where`** y con el
  motivo escrito: un parcial rompería el `ON CONFLICT` del poller), y
  `factura_saas.stripe_invoice_id` fue exactamente este defecto y la **0309** lo
  cerró convirtiendo el parcial en total. La casa ya conoce la clase y la cazó
  una vez.
- **Los guardas de NaN cubren el camino del dinero.** `gasto_monto_no_nan`
  (`0025:104-105`), `viaje_anticipo_no_nan` (`0025:114-115`) y
  `liquidacion_montos_no_nan` sobre las tres columnas del cierre
  (`0025:129-130`). Importa más de lo que parece: en Postgres `numeric` NaN es
  **mayor** que cualquier número, así que `liquidacion_totales_no_negativos`
  (`0146:63`) lo dejaría pasar solo — el CHECK explícito es lo que cierra.
- **Los agregados de acreditamiento no pueden ser NULL.** Verifiqué la afirmación
  de la 27 en el archivo: `0007:9-11` declara `ieps_acreditable`,
  `iva_acreditable` y `peaje_acreditable` como `numeric(12,2) not null default 0`,
  y `0021:13` lo mismo para `litros_diesel_acreditables numeric(12,3)`. `Number(x)`
  sobre ellas nunca ve `null`.
- **Los umbrales fiscales no están duplicados en SQL.** Grepeé `750`, `2000`,
  `0.15` y `5000` sobre las 324 migraciones: **ninguno** aparece como constante de
  regla fiscal (los `5000` son tamaños de tanda de purga y un radio de carta
  porte). El tope de alimentación de $750 solo vive como texto de ayuda de
  `tenant.config` (`0026:164`). La regla vive en TypeScript y en `normas/`; el
  esquema no la re-implementa.
- **El dominio de `cron_latido.id` espeja de verdad a `CRONS`.** Los 11 valores de
  `0248:57-70` son exactamente `CRONS` en `src/lib/admin/salud.ts:28`, y los 9
  `registrarLatido(...)` de las rutas de cron pasan solo ids de esa lista
  (grepeados uno por uno). Ningún cron escribiría un id que la base rechace.
- **Los dominios enumerados del esquema no los contradice el código.** Extraje
  con guion los ~100 CHECK con lista de valores y crucé cada uno contra las
  literales que `src/` escribe en esa columna. Los únicos candidatos que
  sobrevivieron a mirarlos de cerca eran falsos: `incidencia.autorizacion:
  'pendiente'` (`talacha_wa.ts:350`) **sí** está en el dominio —lo declara
  `0107:63-64`, y lo que la `0109:25-27` restringe a `('autorizada','rechazada')`
  es otra cosa: la coherencia de la firma—; el resto eran uniones de TypeScript
  homónimas sin relación con la tabla.

### Auto-refutaciones (hallazgos que abrí y maté yo mismo)

- **«La cancelación ARCO deja PII en `operador` que no anonimiza»** — el último
  cuerpo completo (`0286:135-145`) cubre `nombre`, `telefono`, `rfc`, `licencia`,
  `licencia_tipo` y `licencia_vence`. Contra el listado completo de columnas de
  `operador` (17, extraídas con guion) solo queda `numero_empleado` sin tocar, y
  el propio comentario de la función (`0340:26`) enumera por escrito lo que
  conserva y declara «No acredita anonimización total». Está declarado, no
  escondido.
- **«Borrar un `viaje` arrastra la contabilidad por cascada»** — cierto que
  `pod`, `incidencia`, `factura_viaje` y `cobranza_contacto` cuelgan de `viaje`
  con `cascade`, pero **ningún camino del producto borra un viaje ni un gasto**:
  los 20 `.delete()` de `src/` (fuera de pruebas) tocan `codigo_pendiente`,
  `peaje_cierre_aviso`, `desglose_peaje`, `proveedor_emergencia`, colas de
  agentes y tokens OAuth. El único `delete` de una fila raíz es el del tenant de
  QA. La cascada de `viaje` es hoy inalcanzable.
- **«Las purgas de retención de la 0332/0335/0338 borran más que la 0104»** —
  comparé los predicados: `purgar_wa_conversacion` sigue siendo `updated_at <
  ahora - p_dias` y `purgar_codigo_pendiente` sigue siendo `creado_en < ahora -
  p_dias`, idénticos a `0104:70` y `0104:96`. Lo que la 0332 añade es tope de
  5,000, `for update skip locked`, orden estable y deadline. No borra nada nuevo.
- **«`liquidacion` puede tener dos filas por viaje y `maybeSingle()` reventaría»**
  — `liquidacion_viaje_uidx` (`0005:9`) es único sobre `viaje_id`. Imposible.
- **«El parser de CFDI puede meter NaN en `iva_traslado`, que no tiene CHECK»** —
  `num()` (`cfdi_xml.ts:262-266`) devuelve `undefined` ante NaN, y `repo.ts:377`
  lo convierte en `null`. La ausencia de guarda en la columna existe, pero no hay
  escritor que la alcance. (Lo que `parseFloat` sí acepta es `"1,234.56"` → `1`;
  eso es del rubro de backend/intake, no del esquema, y no lo reporto aquí.)
- **«El hueco 0343 desalinea la compuerta»** — sigue sin hacerlo:
  `compuerta-deploy.mjs:126-136` compara conjuntos, no máximos. Reconfirmado.

## Lo que NO alcancé a revisar

- **Nada corrió contra Postgres.** Sin base, sin `.env` y sin poder correr
  `verificaciones.sql`, todo lo de arriba —incluidos los guiones— es lectura de
  catálogo sobre archivos. No vi rebotar una sola fila.
- **El orden de disparo de los triggers RI** cuando dos FK apuntan al mismo
  padre. Comprobé que hoy **no hay** ningún par con acciones distintas, así que la
  pregunta es teórica; si alguien añade uno, sigue sin haber quien lo detecte.
- **`ejecutar_arco_cancelacion` sobre `posicion` y `app_user.email`.** La función
  declara por escrito que no los toca (`0173:100-106`, `0340:26`). No evalué si
  esa declaración basta legalmente — eso es del rubro legal.
- **Reversibilidad.** Ninguna migración trae `down`. Es el criterio del rubro que
  vuelvo a dejar sin medir; esta ronda solo miré reaplicabilidad (el BAJO de la
  0341).
- **`0325` (1,432 líneas) y `0323`/`0327` (966) a fondo.** Igual que la 27: leí
  tablas, índices, CHECK, FK y firmas; no la lógica interna de
  `sincronizar_jornadas_por_derivar` ni `procesar_jornadas_derivadas`.
- **Las otras cuatro RPC de `0150` que leen `liquidacion`.** Confirmé que no
  filtran rechazadas (hallazgo MEDIO), pero no recorrí qué pantalla pinta cada
  una ni si el rótulo de esa pantalla las contradice como el de «cierres».
