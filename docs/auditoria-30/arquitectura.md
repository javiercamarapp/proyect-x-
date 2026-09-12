# Arquitectura y mantenibilidad — auditoría 30

**Nota: 3/10** (antes 4). Razón del movimiento: **deuda que cobró factura**, y
en segundo lugar **mirada más profunda** (el conteo de cinco de la 29 era un
subconteo: faltaba `cierre_insumos_hash`).

No es una bajada por sobre-corrección. Es aritmética contra el ancla del rubro
—«4 o menos si la misma lógica de dinero vive en más de un archivo»— y contra lo
que la ventana hizo:

1. **El predicado del 15 % no bajó a cuatro: hoy son SEIS**, y las tres del lado
   SQL las reescribió esta misma ventana (0345→0349, 0317→0355, 0321→0354).
2. **La ventana convirtió la duplicación en un número equivocado, hoy, en el
   camino del dinero.** `0349` le agregó al acumulado del ejercicio un término
   nuevo (excluir copias del mismo comprobante) y **la resta que vive en
   TypeScript no se movió** (`cuadre/desde_db.ts:173-177`). Los dos términos del
   cubo del 15 % dejaron de medir lo mismo, en la dirección que **regala
   deducción**: con los valores de abajo, el PDF declara deducibles $9,400 cuando
   $4,400 no lo son. **Antes de `0349` el par estaba cuadrado.** El propio
   archivo declara el invariante que la migración rompió, veinte líneas arriba
   del `filter` (`desde_db.ts:163-165`: «*el `.filter` tiene que espejar el
   `where` de la RPC en TODOS sus términos*»).
3. **El único guardia que cruza la frontera TS↔SQL del 15 % quedó ciego en esta
   ventana**: `fiscal_agregado_15pct.test.ts:37` sigue leyendo
   `supabase/migrations/0345_…sql`, una definición **superseded** por la 0349.
   El guardia existe porque la 0190 prometió por escrito que una divergencia
   fallaría ruidoso en CI; hoy valida un archivo muerto y pasa verde.
4. **Cero de los ocho hallazgos abiertos de la 29 cerró.** Los ocho son
   REINCIDENTES, byte por byte en siete de ellos.

**El riesgo mayor del rubro, hoy:** el equipo aprendió a portar reglas de
TypeScript a SQL y no aprendió a atarlas — nueve migraciones reescribieron
funciones de base en un solo día y **ninguna de las tres que tocan el 15 %
agregó un guardia**, mientras el guardia que ya existía se quedó apuntando a un
archivo anterior; la próxima edición de cualquiera de las seis copias no la ve
nadie.

> **Método.** Todo medido en `claude/auditoria-30` (HEAD `4e36c82`), leyendo
> archivo y línea. `npx tsc --noEmit -p .` → **exit 0**. Corrí
> `fiscal_agregado_15pct`, `repo_acumulado`, `desde_db_efectivo_previo`,
> `frontera_datos_guardiana`, `tope_consulta`, `sin_importar_app`,
> `etiquetas_sincronizadas` → **7 archivos, 51 pruebas, verdes**. Barrido propio
> de consultas crudas (mismo regex del guardia, sobre fuente sin comentarios):
> **200 llamadas en 73 archivos de producción**, idéntico a la 29. Cadena de
> `create or replace` trazada por `grep` sobre las 333 migraciones para saber
> cuál definición está VIVA de cada función. No hay base ni credenciales: la
> aritmética de los escenarios es aritmética sobre el SQL y el TS leídos. No
> edité ningún archivo del repo fuera de este documento.

---

## El conteo del predicado del 15 % hoy

«¿Este comprobante es combustible para la facilidad de la RFA 2026 regla 2.9?»
Solo cuento la definición **VIVA** de cada función (la última `create or
replace` de la cadena), y solo producción.

**TypeScript (3):**

1. `src/lib/likida/cuadre/engine.ts:706`
   `const esCombustible = g.concepto === 'diesel' || (!!h && h.claves.includes(g.claveProdServ ?? ''));`
2. `src/lib/likida/fiscal.ts:715` — `export function esCombustible(g, o)`
   `return g.concepto === 'diesel' || o.clavesCombustible.includes(g.claveProdServ ?? '');`
3. `src/lib/likida/cuadre/desde_db.ts:175` (en línea, dentro del `.filter` de
   `efectivoDeEsteViaje`)
   `(g.concepto === 'diesel' || clavesCombustible.includes(g.claveProdServ ?? ''))`

**SQL (3), todas reescritas en esta ventana:**

4. `supabase/migrations/0349_combustible_15_sin_copias.sql:54` —
   `sumar_combustible_ejercicio`. Cadena: 0084 → 0112 → 0190 → 0305 → 0345 →
   **0349**. (La 29 contaba `0345:24`; ya no es la viva.)
5. `supabase/migrations/0355_gastos_fiscales_sin_copias.sql:80` —
   `gastos_fiscales_agregados_tenant`. Cadena: 0151 → 0192 → 0282 → 0316 → 0317
   → **0355**. (La 29 contaba `0317:139`; ya no es la viva.)
6. `supabase/migrations/0354_cierre_insumos_hash_v2.sql:100-108` —
   `cierre_insumos_hash`. Cadena: 0321 → **0354**. **Esta la 29 no la contó**, y
   ya estaba viva entonces como `0321:148`.

**Veredicto: SEIS. No bajó.** Ni a cuatro ni a cinco. Dos de las cinco que la 29
nombró fueron sustituidas por copias nuevas del mismo predicado en archivos
nuevos, y la sexta —que ya existía y la 29 pasó por alto— también se reescribió
en esta ventana **sin alinearla** con sus dos hermanas (ver ARQ-A2).

Fuera de este conteo, pero del mismo tejido:

- **El factor 0.15 se teclea tres veces**: `periodo/combustible.ts:25`
  (`TOPE_EFECTIVO`), `fiscal.ts:562`, `engine.ts:814`. Hoy los tres valen 0.15.
  La ironía está en `engine.ts:297`, que escribe un comentario sobre «no escribir
  su propio 0.15» para OTRA constante, 517 líneas antes de escribir el suyo.
- **La lista de claves SAT por defecto** (`['15101505','15101514','15101515']`)
  vive en `config.ts:120` y, como *fallback* literal, en `0354:105`.
- **Dos copias más del predicado en pruebas** (`repo_acumulado.test.ts:71-72` y
  `:117`), deliberadas: son las dos implementaciones que el test cruza. Ninguna
  conoce el término de copias que la 0349 agregó, así que esa «equivalencia»
  hoy compara TS contra TS.
- `normas/rfa-2026-2.9.yaml:84-91` (`usado_en_codigo`, el campo que el README
  declara como «*tu impacto si cambias la norma*») lista **siete** entradas y
  **ninguna es un `.sql`**. La regla ahora se ejecuta en tres funciones de base
  y la ficha no nombra una sola.

---

## Hallazgos

### [CRÍTICO · NUEVO, creado por esta ventana] ARQ-C2 — la 0349 dedupó un término del cubo del 15 % y la resta que vive en TypeScript no se movió: el cupo se regala

`supabase/migrations/0349_combustible_15_sin_copias.sql:56-78` (las CTE
`marcados`/`base` nuevas, `where orden_copia = 1`) ·
`src/lib/likida/cuadre/desde_db.ts:173-177` (`efectivoDeEsteViaje`, **sin**
exclusión de copias) · `:132` (de dónde sale el minuendo:
`getAcumuladoCombustible` → la RPC) · `src/lib/likida/repo.ts:1496-1510` ·
`src/lib/likida/cuadre/engine.ts:709` (`if (duplicados.has(g.id)) continue;`) ·
`:811-819` (dónde se gasta el cupo) · y el invariante que se rompió, escrito en
`desde_db.ts:163-165`.

**Escenario, con valores.** Flota con la facilidad vigente. Ejercicio 2026: el
combustible total del ejercicio, ya deduplicado por la 0349, es
`T = $1,400,000` → **tope = 0.15 × T = $210,000**. De efectivo, la flota lleva
`$205,000` en otros viajes. En el viaje V-0912 el chofer fotografía **dos veces
el mismo ticket** de diésel: concepto `diesel`, folio `5461`, monto **$9,400**,
`forma_pago '01'`. Dos filas en `gasto`, misma identidad.

- `sumar_combustible_ejercicio` (0349) excluye la copia → `efectivo = E =
  205,000 + 9,400 = $214,400`. **Correcto.**
- `desde_db.ts:173-176` suma los gastos de ESTE viaje sin deduplicar →
  `efectivoDeEsteViaje = $18,800`.
- `desde_db.ts:177` → `efectivoPrevEjercicio = max(0, 214,400 − 18,800) =
  **$195,600**`. Lo correcto es **$205,000**: la resta se come el ticket dos
  veces y solo se sumó una.
- El motor procesa el único comprobante no-duplicado ($9,400; el otro lo salta
  en `engine.ts:709`): `previoSinEste = 195,600`; `cupoRestante = 210,000 −
  195,600 = $14,400`; `dentro = min(9,400, 14,400) = $9,400`;
  `excedenteDeEste = $0` → emite `combustible_efectivo_dentro15`.
- Lo correcto: `previoSinEste = 205,000`; `cupoRestante = $5,000`;
  `dentro = $5,000`; **`excedenteDeEste = $4,400`** → `efectivo_sobre_15`, no
  deducible.

**Entra un ticket fotografiado dos veces → sale un PDF que declara deducibles
$9,400 cuando $4,400 no lo son.**

**La prueba de que la ventana lo creó:** con la definición anterior (`0345:24`,
sin CTE de copias) el acumulado era `E' = 205,000 + 18,800 = $223,800`, y
`223,800 − 18,800 = $205,000` — el previo salía **exacto**. Los dos términos
contaban las copias, así que la resta las cancelaba. La 0349 movió uno solo.

**Consecuencia.** El contralor firma una liquidación que le concede una
deducción que la RFA 2.9 no le da; la diferencia sale de su declaración anual,
no de la de Likida. Peor, es el error que este mismo archivo documenta haber
cometido y corregido dos veces («*dejando el previo CORTO — el error hacia el
otro lado: regalar cupo del 15 % que la regla no concede*», `:168-169`), en la
tercera dirección que nadie miró. Nada se pone rojo:
`desde_db_efectivo_previo.test.ts` (168 líneas) no tiene la palabra `copia`,
`duplicad` ni `folio`; `fiscal_agregado_15pct.test.ts` lee el archivo
equivocado (ARQ-A1); `supabase/tests/0349_…sql` prueba la RPC contra sí misma.

**Intento de refutación.** (a) ¿El motor no vuelve a deduplicar? Sí, pero solo
los gastos de ESTE viaje (`engine.ts:675,709`) — el minuendo viene de la RPC ya
deduplicado y el sustraendo no; el desajuste está en `desde_db`, no en el motor.
(b) ¿Y si `getAcumuladoCombustible` falla? Cae a `{0,0}` y `efectivoPrev` queda
en 0 (`:130-136`) — otro caso, no éste. (c) ¿El error va siempre en la misma
dirección? Sí: `V_raw ≥ V_dedup` siempre, así que el previo siempre sale corto y
el cupo siempre se regala. (d) ¿Es de `fiscal` y no mío? El daño es fiscal; el
defecto es que el mismo hecho se mide con dos criterios en dos lenguajes y nadie
los ata — es exactamente el rubro.

**Causa raíz probable:** el `.filter` de `desde_db.ts:173` es una reimplementación
manual del `where` de una RPC; cualquier término que se le agregue a la RPC hay
que copiarlo a mano y no hay mecanismo que lo exija (el comentario que lo pide
es prosa, no un guardia).

---

### [CRÍTICO · REINCIDENTE, 8ª aparición desde la 24] ARQ-C1 — un ajuste firmado sigue tirando el export contable del PERIODO COMPLETO

`src/app/api/export/poliza/route.ts:117-131` (`ajustesIncompatibles`) · `:364-368`
(`bloqueos.push` + `continue`) · `:394-406` (el 409 `polizas_incompletas`) ·
`src/lib/likida/revision_recalculo.ts:56-58` ·
`supabase/migrations/0306_…:32`.

**Verificación de hoy.** `git diff 7bcc319..HEAD -- src/app/api/export/poliza/
src/lib/likida/contabilidad/ src/lib/likida/revision_recalculo.ts` → **vacío**.
Los números de línea de la 28 y la 29 apuntan a lo mismo. Ninguno de los 38
commits abrió el archivo; las nueve migraciones de la ventana tampoco lo tocan.

**Escenario, con valores** (idéntico al de la 29, reverificado): marzo 2026, 40
liquidaciones firmadas; el contralor ajusta un hospedaje de $1,480 a $5,480 con
el botón que el demo enseña. La 0306 mueve `gasto.monto` y **conserva**
`sub_total = 1,275.86` / `iva_traslado = 204.14`. `ajustesIncompatibles` calcula
`totalFiscal = 1,480.00`, ve `|5,480 − 1,480| = 4,000 > 0.01`, y `:394` contesta
**409** con «1 de 40 liquidaciones no se pueden asentar. No se exporta el archivo
a medias». **Las 39 sanas tampoco salen**, y el mensaje le pide corregir un
comprobante que está bien.

**Consecuencia.** El contralor no cierra el mes en su ERP por haber usado la
función insignia. Un hallazgo que sobrevive ocho rondas —incluida la ventana que
sí tuvo apetito para reescribir nueve funciones de base— no es deuda técnica: es
evidencia de que el tablero no gobierna la prioridad.

**Causa raíz probable:** no hay decisión de producto escrita sobre qué es la
póliza de un comprobante cuyo `monto` firmado y cuyo desglose fiscal no cuadran;
`ajustesIncompatibles` toma la más conservadora y la aplica al periodo, que es
la granularidad equivocada para una decisión por comprobante.

---

### [ALTO · NUEVO] ARQ-A1 — el único guardia que cruza TS↔SQL en el cubo del 15 % lee una migración superseded, y se quedó ciego en esta ventana

`src/lib/likida/fiscal_agregado_15pct.test.ts:37`
(`const RUTA_SQL = 'supabase/migrations/0345_combustible_rep_por_definir.sql'`) ·
`:38` (`readFileSync(RUTA_SQL)`) · `:49-71` (las cuatro aserciones, todas sobre
ese texto) · `supabase/migrations/0349_combustible_15_sin_copias.sql:39` (el
`CREATE OR REPLACE` que sustituyó a la 0345 el 8-sep-2026, commit `ed80434`) ·
`supabase/migrations/0190_…sql:22-25` (la promesa que el guardia existe para
cumplir: «*una diferencia falle ruidoso en CI, no en silencio en producción*»).

**Escenario, con valores.** Un mantenedor decide que el monedero electrónico
(`'17'`) es un medio admitido y lo agrega al `not in (...)` de la **definición
viva**, `0349:84`, sin tocar `MEDIOS_LISR_27_III` en `engine.ts`. A partir de
ese deploy, con un diésel de **$9,400** pagado con forma `'17'`:

- la RPC (0349) **no** lo cuenta en `efectivo` → el acumulado del ejercicio y el
  panel del contador lo ignoran;
- `engine.ts` (vía `medioNoAdmitidoCombustible`) **sí** lo cuenta → el PDF de la
  liquidación lo mete al cubo del 15 % y consume $9,400 de cupo;
- `npx vitest run fiscal_agregado_15pct` queda **verde**: compara
  `MEDIOS_LISR_27_III` contra el `not in (...)` de la **0345**, que nadie tocó.

Dos cifras distintas del MISMO cubo fiscal, con la suite en verde — que es
palabra por palabra el modo de falla que el encabezado del guardia dice atacar
(`:20-23`).

**Hoy las dos listas coinciden**: 0345 y 0349 dicen ambas
`not in ('02','03','04','05','28','29')`, y las otras tres aserciones (el `'99'`
sin REP, el `pagado_forma` del REP, el `is not null`) también pasan sobre las
dos. Lo reporto porque **la ventana ya demostró el fallo**: la 0349 cambió la
función (le agregó dos CTE y un `where orden_copia = 1`) y el guardia no se
enteró, ni de la sustitución ni del término nuevo.

**Consecuencia.** El repo cree tener cubierta la frontera TypeScript↔SQL de su
regla fiscal más cara y no la tiene. Para quien venga: el nombre del archivo y su
comentario dicen «la definición VIGENTE» — un rótulo falso, que es la regla de
producto que este proyecto declara primero.

**Causa raíz probable:** el guardia fija la ruta del `.sql` como literal en vez
de derivar cuál es la última `create or replace` de la función; la 25 ya tuvo que
moverlo a mano una vez (`:29-31` lo cuenta) y nadie lo convirtió en derivación.

---

### [ALTO · NUEVO] ARQ-A2 — `cierre_insumos_hash` es la sexta copia del predicado, se reescribió en esta ventana cuatro commits DESPUÉS de la 0349, y quedó citando la 0345

`supabase/migrations/0354_cierre_insumos_hash_v2.sql:71-108` (la CTE
`combustible`: total y efectivo del ejercicio, **sin** exclusión de copias) ·
`:1-9` (el encabezado, que diagnostica literalmente «*mismo criterio, dos
copias, una sin actualizar*») · `:6` y `:74-76` y `:147` (las tres veces que cita
`sumar_combustible_ejercicio (0345)`) ·
`supabase/migrations/0349_…sql:56-78` (la exclusión de copias que la 0349 ya le
había puesto a esa función) · commits `ed80434` (0349) y `1466430` (0354), ambos
del 8-sep-2026, **en ese orden**.

**Escenario, con valores.** Mismo par de fotos del ticket de $9,400 de ARQ-C2,
en el viaje V-0912, ejercicio con `$205,000` de efectivo previo.

- `sumar_combustible_ejercicio` (0349) → `efectivo = $214,400`, `total` deduplicado.
- `cierre_insumos_hash` (0354) → el mismo `combustible_ejercicio` con la copia
  dentro: `efectivo = $223,800`. **$9,400 de diferencia entre dos funciones que
  el comentario de la segunda afirma que calculan lo mismo.**

Ese `combustible_ejercicio` es lo que se sella en el hash de cierre
(`0354:140`), el sello que `guardar_liquidacion_tx:227-231` recalcula bajo sus
locks y contra el que rebota con `CU006 snapshot_changed`. Con los dos criterios
distintos, el sello deja de representar los insumos que el motor de verdad usó:
borrar la foto repetida entre el `leerSnapshotInsumosCierre` (`repo.ts:1081`) y
el guardado **cambia el hash** (la 0354 la contaba) **sin cambiar un centavo de
lo que el motor leyó** (la 0349 no la contaba) → el cierre rebota con
«cambiaron insumos económicos/fiscales del viaje» cuando no cambió ninguno.

**Consecuencia.** Falla cerrado, así que no imprime una cifra mala — por eso es
ALTO y no CRÍTICO. Lo que sí hace es dejar la sexta copia del predicado del 15 %
viva y **fuera de sincronía a propósito**, con un comentario que promete lo
contrario y que cita una migración que llevaba cuatro commits muerta cuando se
escribió. Para el equipo es el dato más caro de la ronda: la migración cuyo
único propósito declarado era «dos copias, una sin actualizar» se mergeó con la
copia sin actualizar.

**Intento de refutación.** (a) ¿No basta con que las dos puntas del hash usen la
misma función? Para la aritmética del *optimistic locking*, sí; para lo que el
payload **declara ser** (los insumos económicos del cierre, `0354:140`), no —
declara un `combustible_ejercicio` que no es el que entró al cálculo. (b) ¿Es el
mismo hallazgo que ARQ-C2? No: aquél es el desajuste TS↔SQL en la resta; éste es
SQL↔SQL entre dos funciones hermanas. (c) ¿Es reciente? El predicado ya estaba
en `0321:148`; lo nuevo es que ahora **diverge** de su hermana y que la ventana
tuvo el archivo abierto para arreglarlo.

---

### [ALTO · NUEVO] ARQ-A3 — «esto es una copia del mismo comprobante» pasó de dos implementaciones a cinco, con tres desempates y dos ALCANCES distintos, y el alcance ya diverge

`src/lib/likida/cuadre/engine.ts:514-564` (`copiasDeComprobante`, la canónica;
recorre `input.gastos`, o sea **un viaje**) · `src/lib/likida/repo.ts:1002`
(`getGastos` ordena por `created_at`, sin desempate por `id`) ·
`supabase/migrations/0349_…sql:56-67` (`row_number() … order by id`, `unaccent`,
alcance **tenant × ejercicio completo**) ·
`supabase/migrations/0355_…sql:104-114` (`order by id`, `unaccent`, alcance
**tenant × periodo del panel**) ·
`supabase/migrations/0354_…sql:238-256` (`order by g.created_at, g.id`,
`translate('áéíóúüñ','aeiouun')`, alcance **un viaje**) ·
`supabase/migrations/0353_…sql:129-137` y `:148-155` (sin normalizar acentos,
alcance **un viaje**).

**Escenario, con valores — la divergencia de ALCANCE, viva hoy.** Una flota
compra diésel por importes redondos («ponme $2,500 de diésel»), que es lo
normal. Dos tickets **de estaciones distintas**, ambos con folio `1234` (la
numeración de folio es por emisor y se reinicia), concepto `diesel`, monto
**$2,500.00** exacto, uno en enero (viaje A) y otro en agosto (viaje B), los dos
en efectivo y sin CFDI.

- `copiasDeComprobante` (engine, un viaje) los ve en viajes distintos → **no son
  copias**. Los dos PDF los cuentan, correctamente.
- `sumar_combustible_ejercicio` (0349, tenant × año, particionado por
  `(concepto, folio, monto)` y **sin `rfc_emisor`**) los colapsa en uno → el
  total y el efectivo del ejercicio salen **$2,500 cortos**.

Efecto en el cubo: el denominador baja $2,500 (el tope baja $375) y el numerador
baja $2,500. El panel del contador y los dos PDF del chofer informan **cifras
distintas del mismo ejercicio**, y el encabezado de la 0349 (`:7`) afirma «Mismo
criterio EXACTO que `copiasDeComprobante`». No lo es: el criterio es el mismo,
el **universo sobre el que se aplica** no, y ese es el parámetro que decide si
dos filas colisionan.

**Las otras dos divergencias, declaradas como latentes.** (a) **Desempate**: la
0349/0355 conservan la fila de `id` más chico (`gasto.id` es un uuid, o sea
azar); la 0354 y el TS conservan la más antigua por `created_at`. Hoy es
inocuo en la rama de folio porque `monto` está en la llave de partición, y la
rama de CFDI es inalcanzable (`uq_gasto_cfdi_uuid` sobre
`(tenant_id, cfdi_uuid, cfdi_orden)` con `cfdi_orden smallint not null default
1`, `0065:69` — cosa que el propio repo reconoce en
`migraciones_verificadas.test.ts:76`). Deja de ser inocuo en cuanto la
sobreviviente aporte **cualquier otra columna**: la 0355 agrupa por 26
dimensiones tomadas de la fila que sobrevive (`forma_pago`, `estado_sat`,
`fecha`, `rfc_emisor`…), y dos fotos del mismo ticket con OCR distinto difieren
justo ahí. (b) **`nullif`**: 0355, 0354, 0353 y 0347 escriben todas
`coalesce(nullif(folio_norm,''), folio)`; **la 0349 es la única que no**
(`:63`, `coalesce(folio_norm, folio)` sobre columnas crudas). Hoy coinciden
porque `intake/ocr.ts:640` nunca produce `''` (el lookahead `(?=\d)` lo
impide); el día que otro escritor guarde un `folio_norm` vacío, la 0349 es la
única que lo tomará como llave.

**Consecuencia.** «Una foto repetida no es un gasto» es una regla de dinero y
ahora se implementa cinco veces con tres criterios de desempate, dos
tratamientos de acentos y dos alcances. Ninguna prueba cruza dos de ellas.

**Causa raíz probable:** portar una función pura de TS a SQL no es traducir el
cuerpo — es también fijar el universo y el orden, que en TS venían implícitos
del llamador (`input.gastos` de un viaje, en orden de `created_at`), y las tres
migraciones nuevas los eligieron cada una por su cuenta.

---

### [ALTO · REINCIDENTE de la 29] ARQ-A4 — el techo de reintentos del inbox de WhatsApp sigue en TypeScript y en SQL, con el comentario afirmando que están atados

`src/lib/likida/wa_pendientes.ts:26` (`MAX_INTENTOS_PENDIENTE = 5`) ·
`conv.ts:1012` · `processor.ts:4085-4089` (el comentario que documenta un
acoplamiento inexistente) · `supabase/migrations/0325_…sql:27,56,96,103`
(`intentos < 5` literal, cuatro veces) · `0187:14,34,43,92,102`,
`0194:35,44`, `0280:136` (más literales de lo mismo) · `0155:150`
(`intentos >= 5`) · `aviso_barrera_cerrado.test.ts:73` (el `5` a mano en un mock).

Sin cambios en la ventana: verifiqué las once apariciones. El escenario y los
valores de la 29 siguen vigentes palabra por palabra (subir el techo a 8 deja
una foto de $9,400 con `intentos = 6` viva para TypeScript e invisible para el
cron → aplazamiento perpetuo, sin carta muerta y sin una sola prueba roja).

---

### [MEDIO · REINCIDENTE-MUTADO de la 29] ARQ-A5 — «qué régimen SAT abre el 15 %» pasó de tres deciders a tres deciders y una función canónica, y las dos que quedaron a mano devuelven otra cosa

`src/lib/likida/perfil/preguntas.ts:362` (`REGIMENES_ELEGIBLES_15`) y `:369`
(`regimenElegiblePorClave`, la canónica que la 29 produjo) ·
`src/lib/likida/administracion.ts:205` (migrado ✔) ·
`src/lib/likida/perfil/onboarding.ts:19-22` (`regimenElegibleDeClave`, **sin
migrar**) · `src/lib/likida/perfil/entrevista.ts:713`
(`const elegible = v === '612' || v === '624'`, en línea, **sin migrar**) ·
`normas/rfa-2026-2.9.yaml:84-91`.

**Lo que mejoró:** `crearFlota` ya no tiene su literal local. **Lo que no:**
quedaron dos deciders escritos a mano, y ahora hay **cuatro** lugares en vez de
tres, porque el arreglo agregó la canónica sin retirar los otros dos.

**Y ya divergen, en el valor que el código declara load-bearing.** Con una clave
fuera del catálogo de seis (p. ej. `'605'`, Sueldos y Salarios):

- `regimenElegiblePorClave('605')` → **`false`** (`preguntas.ts:371`, un
  `.includes` sobre la lista de dos).
- `regimenElegibleDeClave('605')` → **`undefined`** (`onboarding.ts:20`, porque
  `'605'` no está en `CLAVES_REGIMEN_SAT`).

La diferencia no es cosmética: el propio repo la define. `undefined` es «no se
puede saber — no se inventa un veredicto que la base no sostiene»
(`preguntas.ts:365-367`); `false` es «no califica», y `crearFlota` lo escribe
firme en `config.facilidadCombustibleEfectivo.regimenElegible`
(`administracion.ts:206-213`), lo que hace que `engine.ts:841` emita
`efectivo_no_elegible` —no deducible, y sin IVA acreditable— sin haberle
preguntado nunca a la flota. Dos puertas de alta, mismo RFC, dos estados. Dentro
del catálogo de seis los tres coinciden (probé `601/603/612/621/624/626`); el
riesgo es la próxima clave y la próxima republicación de la RFA, que es el
escenario que la 29 ya escribió.

**Tercer eje, sin divergir hoy:** la lista de seis claves vive en
`onboarding.ts:14`, `entrevista.ts:598` y `saas/fiscal.ts:24-31`.

---

### [MEDIO · REINCIDENTE de la 28 y la 29] ARQ-M1 — «ninguna consulta del cierre se queda sin techo» sigue siendo una lista literal de 6 sobre 73, y quien sube el PDF sigue fuera

`src/lib/likida/tope_consulta.test.ts:38-45` (`CAMINO_DEL_CIERRE`, los mismos
seis de la 29) · `src/lib/likida/tools.ts:412`
(`await supabaseAdmin().storage.from('liquidaciones').upload(...)`, **sin
`acotada`**) y `:433-434` (se llama dos veces: el ejemplar del contralor y el del
operador) · `src/lib/supabase/admin.ts:18` (el backstop de 25 s).

**Medición de hoy**, con el regex del propio guardia sobre el fuente sin
comentarios: **200 consultas crudas en 73 archivos de producción**. El guardia
mira 6. **Idéntico a la 29** — la ventana no movió ni una. El escenario (dos
`upload` en serie, hasta 25 s cada uno contra los 8 s del tope fino, de los
120 s de la invocación, con `saveLiquidacion` + `sendDocument` detrás) sigue
siendo el que el encabezado del propio guardia describe en `:13-17`.

---

### [MEDIO · REINCIDENTE de la 29] ARQ-M2 — el plazo de conservación de la telemetría se promete en prosa y se ejecuta con literales SQL

`src/lib/likida/privacidad.ts:712` y `:715` («*Se conservan **180 días**… si el
evento fue grave… **365 días***») · `:401-415` (`versionAvisoVigente` firma
**solo el texto**) · `supabase/migrations/0288_…:174` y `0289_…:135`
(`purgar_evento_seguridad_flota(180, 365, …)`, a mano).

Sin cambios. El escenario de la 29 sigue en pie: una `create or replace
mantenimiento_de_datos` con `(365, 365, …)` —el patrón exacto que ya se repitió
dos veces— deja el aviso declarando un plazo menor que el real, con la firma
diciendo que nada cambió y `privacidad_leg3_aud24.test.ts` verde. La ventana
además normalizó el patrón: nueve `create or replace` más en un día.

---

### [MEDIO · REINCIDENTE de la 29] ARQ-M3 — el margen de reloj de los crons se deriva de un conteo de consultas hecho a mano

`src/lib/likida/presupuesto.ts:399-401` (`margenUnidadAtomicaMs`) ·
`src/app/api/cron/gps/route.ts:63` (`{ consultas: 11, envios: 0 }`) ·
`src/app/api/cron/descarga-sat/route.ts:106` (`{ consultas: 3, envios: 1 }`).

Sin cambios: siguen siendo 11 y 3, contados en un comentario. El escenario de la
29 (una consulta más en la cadena de `crearIncidencia` deja el margen 9.5 s
corto y Vercel mata la función entre `crearIncidencia` y `finalizarGrave`) sigue
alcanzable y sigue sin ponerse rojo.

---

### [BAJO · REINCIDENTE de la 29] ARQ-B1 — «¿qué prospecto es este correo?» sigue con dos implementaciones

`src/lib/admin/calcom_webhook.ts:233` · `src/lib/admin/calcom.ts:474`. Las
**únicas dos** apariciones de `correo_normalizado` en producción, con el mismo
`.eq(...).is('duplicado_de', null).limit(2)` escrito dos veces. Sin cambios.

---

### [BAJO · REINCIDENTE, 8ª ronda] ARQ-B2 — `procesarTurno`

`src/lib/likida/processor.ts:1554` (la firma) → `:4990` (el cierre) = **3,436
líneas**, exactamente las mismas que en la 29. Es la única métrica de este
informe que **no empeoró**. Sin escenario nuevo.

---

### [BAJO · NUEVO] ARQ-B3 — la campaña de cobertura dejó catorce mocks a mano de `TenantEfectivo`, con cuatro formas distintas y ninguna atada al tipo real

`src/lib/auth/tenant-efectivo.ts:32-52` (`interface TenantEfectivo extends
SessionTenant`: `tenantId`, `tenantNombre`, `tenantExiste`, más `rol`/`userId`) ·
los catorce `vi.mock('@/lib/auth/tenant-efectivo', () => ({
resolverTenantEfectivo: async () => sesion }))` de la ventana, con cuatro
declaraciones distintas de `sesion`:
`src/app/dashboard/chat/page.test.tsx:21` (`{tenantId, rol, tenantNombre,
tenantExiste}`) · `src/app/dashboard/clientes/page.test.tsx:25` (`{tenantId, rol,
userId}`) · `src/app/dashboard/conocimiento/page.test.tsx:10` (`{tenantId,
rol}`) · `src/app/dashboard/descarga-sat/page.test.tsx:10` (`{tenantExiste}`).

**Hoy coinciden, y lo digo explícito:** crucé las catorce contra lo que
desestructura su `page.tsx` y **cada mock cubre exactamente lo que su página
lee**; los únicos tres `page.tsx` que leen `tenantExiste` (`chat:38`,
`contador:31`, `descarga-sat:22`) son los tres cuyo mock sí lo trae. No hay bug.

**El riesgo es la próxima edición, y es mecánico.** La factoría de `vi.mock` no
se typechequea contra el módulo: ninguna de las catorce dice `satisfies
TenantEfectivo`. El día que `dashboard/clientes/page.tsx` empiece a leer
`tenantExiste` —el campo que existe justamente para no afirmar «aún no hay
liquidaciones» sobre una flota borrada, `tenant-efectivo.ts:38-46`— su prueba
seguirá devolviendo `{tenantId, rol, userId}`, `tenantExiste` llegará
`undefined`, la página pintará el aviso de flota inexistente **en el camino
feliz**, y las aserciones de esa prueba no lo notarán porque no lo miran.
Catorce sitios donde eso puede pasar, cada uno con su propia definición local
del tipo de una frontera de sesión.

Lo reporto BAJO y no más porque no encontré divergencia viva, que es lo que el
encargo pedía — pero es la deuda de mantenibilidad concreta que dejaron los 49
archivos nuevos, y es la única que encontré: el resto de la campaña **no** es
andamio copiado (ver abajo).

---

## Lo que revisé y está bien

- **La campaña de cobertura NO es un andamio copiado 35 veces.** Es el hallazgo
  que fui a buscar y no está. Conté los `vi.mock` de los 47 `page.test.tsx`
  nuevos: la moda es `next/navigation` con 19 apariciones sobre 47, y de ahí
  para abajo (`admin/negocio` 15, `next/cache` 14). Abrí pares al azar
  (`admin/cobranza/page.test.tsx` — 18 líneas, dos aserciones de contenido
  contra una página estática; `admin/consumo/page.test.tsx` — 40 líneas de
  fixtures propias y resiliencia **por sección**): son pruebas escritas una por
  una contra lo que cada página hace, no un molde. La única duplicación real es
  ARQ-B3.
- **El motor del dinero sigue siendo puro.** `cuadre/engine.ts`: **cero**
  ocurrencias de `async `/`await ` en 1,900+ líneas. La frontera con I/O la
  sostiene `cuadre/desde_db.ts`, que lee y materializa. (Que esa frontera tenga
  el bug de ARQ-C2 no cambia que la separación esté bien puesta: el defecto está
  en el traductor, no en el motor.)
- **El ejemplo canónico del rubro sigue cerrado y vigilado.** `engine.ts:1891`
  dice `otro: 'Otro'`, `pdf.ts` importa `etiquetaConcepto`, y
  `etiquetas_sincronizadas.test.ts:43` barre **todo** `src/` buscando
  `const CONCEPTO(_LABEL)?` en vez de una lista de rutas. Verde hoy.
- **`FaseCosto` es cómo se hace bien, y está en esta misma ventana.**
  `supabase/migrations/0351_…sql:17` amplía el CHECK a `copiloto`/`runner`,
  `src/lib/likida/costos.ts:41` amplía la unión de TS, y
  `costos_dominio.test.ts` **cruza las dos listas y falla si divergen** — el
  comentario de la constraint (`0351:20`) lo dice y es verdad. Es exactamente el
  mecanismo que las tres migraciones del 15 % no traen. La ventana sabía cómo.
- **Las dependencias invertidas siguen en dos y hay quien las cuente.**
  `sin_importar_app.test.ts` verde, incluido su tercer `it`, que exige que el
  barrido encuentre **exactamente** esas dos (o sea, se cae si se queda ciego).
- **`gasto.cfdi_orden` cierra la rama de CFDI del dedup a nivel de índice.**
  `0065:69` (`unique (tenant_id, cfdi_uuid, cfdi_orden) where cfdi_uuid is not
  null`) + `0065:58` (`smallint not null default 1`): no hay NULL que haga
  distintas dos filas del mismo comprobante. Es la refutación que mata la mitad
  de ARQ-A3, y el repo ya la tenía escrita (`migraciones_verificadas.test.ts:76`).
- **Ninguna migración nueva quedó sin decisión.** `migraciones_verificadas.test.ts`
  exige que cada `.sql` aparezca en `verificaciones.sql` o en `EXENTAS`; las
  nueve pasan.
- **El acceso a datos no creció.** 200 llamadas crudas en 73 archivos, idéntico
  a la 29: la ventana agregó +5,429 líneas de `src/` y **cero** consultas crudas
  nuevas, porque casi todo fue prueba.
- **`npx tsc --noEmit -p .` → exit 0.** Siete guardias estructurales, 51
  pruebas, verdes.

---

## Lo que NO alcancé a revisar

- **Las otras seis migraciones nuevas por dentro** (0348, 0350, 0351, 0352,
  0353, 0356) contra su `supabase/tests/*.sql`. De 0351 y 0352 leí lo suficiente
  para el punto (b) del encargo; de 0348 y 0356 solo el diff. `0353` merece una
  mirada de `datos`: reescribe `revisar_liquidacion` **entera** afirmando que el
  `pg_get_functiondef()` es byte-idéntico, y eso no se puede verificar aquí.
- **Si `gastos_fiscales_agregados_tenant` (0355) desincronizó el panel del
  contador contra el PDF por el mismo problema de ALCANCE de ARQ-A3.** La 0355
  dedupa por periodo y el motor por viaje; no reconstruí `resumirFiscal` lo
  bastante para escribir el escenario con valores. Es la extensión natural de
  ARQ-A3 y probablemente el séptimo hallazgo.
- **El detector de clones por contenido**, que la 29 corrió (49 pares). No lo
  repetí: gasté la ronda en el conteo del 15 %, que era el encargo.
- **`conectores/sincronizar_eventos.ts`, cuarta ronda pendiente.**
- **`lib/mcp/herramientas/*` contra `/v1/*`**, pendiente desde la 26.
- **Nada que requiera base viva.** Ninguna de las nueve funciones nuevas se
  puede ejecutar aquí; los escenarios son aritmética sobre el SQL leído.
- **Si el `id` de `gasto` es aleatorio en producción** (lo asumí uuid v4 por el
  uso de `gen_random_uuid()` en el resto del esquema). Si fuera monótono, el
  desempate `order by id` de 0349/0355 coincidiría con `created_at` y la mitad
  latente de ARQ-A3 sería más benigna de lo que escribí. La mitad de ALCANCE no
  depende de eso.
