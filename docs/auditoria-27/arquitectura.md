# Arquitectura y mantenibilidad — auditoría 27

**Nota: 4/10** (antes 5). Razón del movimiento: **deuda que cobró factura**. De
los seis hallazgos que la 26 dejó abiertos en este rubro, **cero se cerraron** —
los abrí uno por uno y cinco están idénticos al carácter (ARQ-26-1 conserva
hasta el comentario que declara exacta una aproximación); el sexto
(`procesarTurno`) **creció otra vez**. Y el CRÍTICO de la 24 —la póliza tras
`ajustar`, 5ª aparición— no siguió abierto: **alguien tomó la decisión de
producto que faltaba, implícitamente, dentro de un commit de fiscal**
(`42f93f91`), y la tomó en la dirección que rompe el entregable. Eso es
exactamente lo que la regla del rubro llama cobrar factura: la advertencia
existía escrita («exige decidir qué hace el producto con una liquidación
ajustada») y el arreglo la resolvió sin decidirla.

No baja de 4 porque hubo trabajo estructural real y verificado: la frontera de
datos aguantó 181 commits sin una sola fuga nueva, no nacieron dependencias
invertidas, la 0345 cerró la divergencia SQL↔TS que la 26 había dejado anotada
en un comentario, y los módulos nuevos (`sat_descarga`, `https_publico`) reusan
en vez de copiar. Pero el ancla del rubro dice «4 o menos si la misma lógica de
dinero vive en más de un archivo», y hoy el predicado «esto es combustible del
ejercicio» vive en **cinco** implementaciones, y la regla «una foto repetida no
es un gasto» vive en once archivos de TypeScript y en **cero** de los dos
agregados SQL que alimentan el mismo cubo fiscal.

**El riesgo mayor del rubro, hoy:** después de usar «ajustar» —el botón que el
producto vende como su corrección insignia (WA-3: `$8,000` leídos como `$800`)—
la póliza del MES ENTERO deja de poder exportarse, para siempre, y el mensaje de
error le pide al contralor que corrija un XML que está bien.

> **Método.** Todas las citas están abiertas y leídas contra `06b2eca4` (HEAD de
> `claude/auditoria-27`). No edité ningún archivo del repo fuera de este
> entregable (`git status` limpio salvo este documento). `npx tsc --noEmit -p .`
> → exit 0. Corrí los cinco guardias estructurales del repo
> (`frontera_datos_guardiana`, `etiquetas_sincronizadas`, `rol_label_unico`,
> `fiscal_agregado_15pct`, `contencion_listas`): 24 pruebas, todas verdes —
> el punto de dos de mis hallazgos es justamente que están verdes.
> La aritmética de los escenarios es aritmética sobre el código leído, no filas
> contadas: la base está en cero y no hay credenciales en esta ronda.

---

## Hallazgos

### [CRÍTICO · REINCIDENTE, 5ª aparición desde la 24] La decisión de producto sobre «la póliza tras `ajustar`» se tomó sin tomarse: hoy un ajuste firmado inhabilita el export contable del periodo completo, para siempre

`src/app/api/export/poliza/route.ts:116-131` (`ajustesIncompatibles`, nuevo en
`42f93f91`) · `:364-368` (dónde entra al bucle) · `:394-406` (el 409 que tira el
periodo entero) · `src/lib/likida/revision_recalculo.ts:56-59` (el ajuste solo
cambia `monto`) · `supabase/migrations/0306_…:32` («*Lo que NO se toca:
`gasto.sub_total`/`iva_traslado`/`ieps_traslado`*») y `:209` (`update gasto set
monto = v_nuevo`) · `src/app/dashboard/[id]/revision-panel.tsx:144` (lo único
que la pantalla de firma le promete al contralor).

**Qué cambió y qué no.** La mitad vieja del hallazgo —la póliza **inventaba**
$7,200 de «IVA/IEPS no acreditable» en el archivo que va al ERP— **sí está
cerrada**: `ajustesIncompatibles` bloquea antes de llegar a
`poliza.ts:230`. `src/lib/likida/contabilidad/poliza.ts` **no se ha tocado desde
la auditoría 22** (`git log -- …/poliza.ts` → último commit `7b1f109a`): sigue
derivando `comprobado = anticipo − diferencia` (`:205`, que un ajuste SÍ mueve)
contra `subtotalDeclarado` armado de `g.subTotal` (`route.ts:192`, que un ajuste
NO mueve). Lo que cambió es que ahora, en vez de asentar la resta envenenada, la
ruta se niega.

**Escenario, con valores.** V-119, anticipo $10,000, dos comprobantes CON XML
(la única población que la ruta deja pasar, `route.ts:369-376`):

- diésel: `sub_total` 6,896.55 · `iva_traslado` 1,103.45 · `monto` 8,000
- caseta: `sub_total` 1,724.14 · `iva_traslado` 275.86 · `monto` 2,000

El contralor firma «ajustar» sobre el diésel: 8,000 → 800 (el CFDI amparaba el
consumo del mes; a este viaje le tocan $800). La RPC 0306 mueve `monto` a 800 y
—por diseño escrito— deja `sub_total` e `iva_traslado` intactos.

Al exportar la póliza del mes, `ajustesIncompatibles` calcula
`totalFiscal = 6,896.55 − 0 + 1,103.45 + 0 − 0 − 0 = 8,000.00` y compara contra
`monto = 800.00`: `|800 − 8,000| = 7,200 > 0.01` → bloqueo. Como
`bloqueos.length > 0`, la ruta contesta **409 `polizas_incompletas` y NO exporta
una sola liquidación del periodo**: entra un mes con 40 liquidaciones firmadas de
las cuales UNA se ajustó → sale cero archivo, para las 40, con el texto «*el
importe 800.00 no coincide con el desglose fiscal 8000.00. Revisa el ajuste y
corrige los datos del comprobante antes de exportar*».

Y es **por construcción, no por un dato malo**: un ajuste que cambie el importe
de un comprobante timbrado produce siempre `monto ≠ totalFiscal`, porque la 0306
declara el desglose del CFDI intocable. Las dos únicas salidas son deshacer el
ajuste o «corregir el XML» —que es el hecho fiscal del proveedor, no un dato de
Likida—. La pantalla de firma no lo advierte: `revision-panel.tsx:144` solo
promete «*El sistema recalcula el cuadre con los montos corregidos*».

**Consecuencia.** El contralor —el comprador— usa la corrección que se le vendió
en la demo y, al cerrar el mes, el botón «Descargar póliza del mes (CSV
CONTPAQi)» (`dashboard/contador/perfil-erp.tsx:80`) le devuelve un JSON de error
en vez de su archivo, culpando al SAT de un problema que creó el producto.
Ajustar y exportar la contabilidad son mutuamente excluyentes, y nada lo dice.

**Intento de refutación.** Lo busqué en serio. (a) ¿Se salva el caso normal?
No: `route.ts:369` ya exige que TODO gasto traiga `sub_total`, así que la
población que llega a `ajustesIncompatibles` es exactamente la que tiene
desglose completo y por tanto la que siempre va a discrepar tras un ajuste.
(b) ¿Hay una rama que perdone el gasto sin desglose? Sí, pero al revés: `:124`
bloquea también cuando falta un campo — y verifiqué que `parseCfdiXml`
(`intake/cfdi_xml.ts:343-386`) devuelve `0` y no `undefined` para IEPS, así que
esa rama NO se dispara sobre un CFDI normal sin IEPS; el bloqueo real es el de
la comparación. (c) ¿Hay prueba? **Ninguna**: `ls src/app/api/export/poliza/`
son `rol_dinero.test.ts`, `salida.test.ts` y `salida_sap_b1_aud24.test.ts`, y
`grep -rn "ajustesIncompatibles\|ajuste del comprobante" src/` devuelve **solo
la propia `route.ts`**. Un comportamiento que decide si el cliente puede cerrar
su mes entró sin un solo caso.

**Causa raíz probable:** la 0306 puso la frontera del ajuste en el desglose de la
LIQUIDACIÓN y dejó intacto el del COMPROBANTE, de donde la póliza saca dos de
los tres términos de su resta; `42f93f91` tapó el síntoma en la ruta en vez de
decidir qué es un ajuste para la contabilidad (¿un gasto prorrateado con su
propio renglón? ¿una nota? ¿un comprobante partido?).

---

### [ALTO] La regla «una foto repetida no es un gasto» vive en once archivos de TypeScript y en cero de los dos agregados SQL, y el cubo del 15 % se mide con los dos a la vez

`src/lib/likida/cuadre/engine.ts:502-547` (`copiasDeComprobante`, «*Exportada y
única*»; rama por `concepto|folioNorm|monto` en `:544-547`) · `:662-670` y `:687`
(el motor las excluye del comprobado y del recorrido) ·
`supabase/migrations/0345_combustible_rep_por_definir.sql:11-33`
(`sumar_combustible_ejercicio`: `from gasto where … monto > 0 …` — **sin una sola
cláusula de deduplicación**) ·
`supabase/migrations/0317_gastos_fiscales_agregados_paridad_engine.sql:139`
(el agregado del panel fiscal, tampoco) ·
`src/lib/likida/cuadre/desde_db.ts:171-174` (la resta que espeja el `where` de la
RPC: espeja fecha, forma de pago y pertenencia, **no** las copias) ·
`src/lib/likida/cuadre/engine.ts:799-807` (dónde se consume).

**Escenario, con valores.** Ejercicio 2026, flota con `facilidad15 = true`.

- Viaje A (cerrado en marzo): el operador mandó **dos fotos del mismo ticket de
  diésel** — dos filas en `gasto`, ambas `concepto 'diesel'`, `monto 100,000.00`,
  `forma_pago '01'`, `fecha 2026-03-10`, sin `cfdi_uuid`, `folio_norm '5461'`.
  `copiasDeComprobante` marca la segunda como copia y el PDF de A ya se imprimió
  contando **$100,000**, no $200,000 (es literalmente el bug del Costco que la
  función documenta en `:492-497`).
- Resto del ejercicio: $1,000,000 de diésel con tarjeta (`'04'`).
- Viaje B, cerrando hoy: un CFDI de diésel de **$50,000** en efectivo (`'01'`).

Lo que mide SQL (0345, sin dedup): `total = 1,250,000`, `efectivo = 250,000`.
`desde_db.ts:171` le resta lo de ESTE viaje ($50,000) → `efectivoPrev = 200,000`.
El motor: `tope = 0.15 × 1,250,000 = 187,500`; `previoSinEste = 200,000`;
`cupoRestante = max(0, 187,500 − 200,000) = 0`; `dentro = 0`;
**`excedenteDeEste = 50,000`** → `efectivo_sobre_15`, `proporcionDeducible = 0`,
IVA no acreditado.

Con la MISMA regla de copias que usan el motor, el PDF, la póliza, el panel de
analytics y las tools: `total = 1,150,000`, `efectivo = 150,000`,
`prev = 100,000`, `tope = 172,500`, `cupoRestante = 72,500`, `dentro = 50,000`
→ **excedente 0, deducible completo**.

Entra **una foto repetida de un ticket de $100,000** → sale, en OTRO viaje y
meses después, **$50,000 de diésel marcados «No deducible»** y su IVA
(**$6,896.55** al 16 %) sin acreditar. Y la nota que se imprime en el PDF
(`engine.ts:825`) dice «*el ejercicio lleva $250,000 de combustible pagado con
medios que la LISR 27-III no admite, contra un tope de $187,500 (15% de
$1,250,000)*»: tres cifras que el contralor **no puede reconstruir**, porque
$100,000 de ellas son el mismo ticket contado dos veces y el PDF del viaje A le
dijo por escrito que esa copia se había excluido.

**Consecuencia.** La flota pierde deducción y acreditamiento por un error de
captura que el propio producto ya detectó y le presumió haber corregido. Y el
sentido se invierte según dónde caiga la copia: si la copia es de ESTE viaje, la
resta de `desde_db` la cancela y lo que queda inflado es solo el DENOMINADOR, es
decir cupo del 15 % **regalado**. El mismo defecto empuja para los dos lados.

**Intento de refutación.** (a) ¿Puede haber dos filas así? Sí: el índice único
`uq_gasto_cfdi_uuid` (mig. 0065) solo cubre el caso CON UUID; la rama por
`folioNorm` de `copiasDeComprobante` existe precisamente porque los tickets sin
timbrar entran dos veces, y el dedup por hash de imagen no ve dos fotos
distintas del mismo papel. (b) ¿Lo cubre alguna prueba? No:
`repo_acumulado.test.ts` no menciona copias ni folios, y su describe de
«equivalencia» compara `legacyAcumuladoJs` —una copia congelada de la regla
PRE-0190, que solo cuenta `'01'`— contra `sqlEquivalente`, sobre fixtures que
solo usan `'01'`, `'04'` y `null`: los dos oráculos coinciden únicamente en el
subconjunto donde las dos reglas dicen lo mismo. (c) ¿Es sabido? No aparece en
ninguna ronda anterior; la 26 lo tenía en «lo que no alcancé a revisar».

**Causa raíz probable:** `copiasDeComprobante` es una función de TypeScript sobre
una lista de `Gasto`, y las dos agregaciones que miden el mismo universo corren
en SQL sobre `gasto` crudo — la identidad del comprobante se pierde antes de
poder aplicarla, y nadie declaró que ese término del `where` faltaba.

---

### [ALTO · REINCIDENTE de la 26 (ARQ-26-1), verbatim] El panel sigue acreditando el IVA de combustible con una proporción agregada, y el comentario que la introduce sigue afirmando que es exacta

`src/lib/likida/fiscal.ts:506-535` (`proporcionCombustible15` y el comentario
«*da la MISMA proporción agregada que sumar el resultado real del motor viaje por
viaje — exacta cuando `gastos` cubre el ejercicio completo*») ·
`src/lib/likida/fiscal.ts:1096-1109` (la MISMA proporción aplicada a TODOS los
comprobantes) · `src/lib/likida/cuadre/engine.ts:766-808` (la asignación real:
por comprobante, `dentro / g.monto`) ·
`src/lib/likida/fiscal_combustible15.test.ts` (la prueba que los ata usa dos
comprobantes idénticos, el único caso donde la identidad se cumple).

Lo comprobé línea por línea: **el archivo no cambió** desde la medición de la 26.
El escenario y las cifras de aquella ronda siguen siendo válidos tal cual: dos
CFDI de diésel en efectivo de $100,000 con tasas distintas (16 % en el centro,
8 % en frontera) sobre un ejercicio de $1,000,000 → el panel imprime
**$15,900.38** de IVA acreditable y el motor/PDF **$17,496.81** (o $14,303.96,
según qué viaje cerró primero). La identidad que el comentario invoca es cierta
para el MONTO deducible y falsa para el IVA en cuanto el cociente IVA/monto no
es uniforme, y basta una tasa fronteriza o un `ivaTraslado` nulo para romperla.

**Consecuencia.** El contralor teclea en su declaración la cifra de la pantalla y
archiva el PDF con otra. Sigue siendo ALTO y no CRÍTICO por las mismas tres
defensas de la ronda anterior (reusa `proporcionesDeducibles`, falla cerrado sin
acumulado, y `combustible15SujetoADeriva` avisa de la deriva temporal) — pero
ninguna de las tres dice lo que aquí falla: que **con el acumulado de HOY** el
agregado tampoco reproduce el reparto.

**Causa raíz probable:** la asignación del motor depende del orden de cierre; el
arreglo eligió la única forma agregada que no puede ser exacta y la documentó
como exacta.

---

### [ALTO · REINCIDENTE PARCIAL de la 26 (ARQ-26-2)] «¿Qué liquidaciones sostienen el IVA acreditable del mes?» bajó de tres respuestas a dos — y la que sobrevive es la que va al cliente afirmando ser la otra

`src/lib/likida/agentes/exito.ts:685-695` (`leerValorDelMes`:
`from('liquidacion').select('… iva_acreditable …')` con `tenant_id` y rango de
fechas, **sin una sola cláusula sobre `revision`**; el `select` ni siquiera trae
la columna) · `src/lib/likida/agentes/exito.ts:654` (el rótulo que se imprime:
«*la misma columna que la RPC `acreditables_liquidacion_tenant`*») ·
`supabase/migrations/0308_acreditables_solo_firmadas.sql:50`
(`and revision in ('aprobada','ajustada')`, lo que alimenta el tile del panel).

**Lo que SÍ se cerró, y lo verifiqué:** la tercera respuesta —la póliza— ya no
existe. `src/app/api/export/poliza/route.ts:354-361` rechaza con 409 cualquier
periodo que contenga una liquidación cuya `revision` no sea `aprobada` o
`ajustada`, el mismo criterio que la 0308. Ese medio hallazgo está cerrado por
mecanismo, no por casualidad.

**Escenario, con valores.** Un mes con 100 liquidaciones de una flota, cada una
con `iva_acreditable = $16,000`: 60 aprobadas, 10 ajustadas, 25 pendientes de
firma, 5 rechazadas.

- `/dashboard/contador`, tile «IVA acreditable de tus liquidaciones» (RPC 0308):
  **70 × 16,000 = $1,120,000**.
- El reporte «VALOR — <flota> — <mes>» (`armarReporteValor`), el borrador que
  Javier edita y **le manda al cliente**: **100 × 16,000 = $1,600,000**, con las
  5 rechazadas y las 25 sin firmar dentro, bajo una leyenda que asegura ser la
  misma columna que la RPC.

Entra **el mismo mes de la misma flota** → salen **$1,120,000 y $1,600,000**, las
dos bajo el rótulo «IVA acreditable del mes», con una brecha de **$480,000**.

**Consecuencia.** El correo que se le manda al cliente lleva una cifra que su
propio panel nunca va a reproducir, y el rótulo que la acompaña afirma
explícitamente lo contrario. Es la regla «un rótulo tiene que ser verdad» rota
en el artefacto comercial.

**Intento de refutación.** Busqué el guardarraíl y no hay ninguno:
`leerValorDelMes` no selecciona `revision`, no la filtra y no advierte nada; la
única defensa del reporte (`incompleto`) es sobre la paginación, no sobre el
universo. Y no es un caso vacío: la 0299 creó `revision` porque «pendiente» es el
estado normal de una liquidación recién cerrada.

**Causa raíz probable:** `revision` se propagó consulta por consulta sin un
predicado exportado que diga «esta liquidación sostiene dinero»; hoy el
vocabulario existe como *strings* (`FILTROS_REVISION_EXPORT`, `revision.ts:49`)
pero no como una función que las ocho consultas puedan llamar, así que cada una
volvió a elegir su cláusula a mano — `in ('aprobada','ajustada')` en 0308:50,
0316:82 y `route.ts:354`; `<> 'rechazada'` en 0342:84, 0344:23, 0344:50 y
`analytics.ts:1980`; ninguna en `exito.ts:685`.

---

### [MEDIO] El predicado del 15 % tiene CINCO implementaciones y el único guardia SQL↔TS cubre uno de sus cuatro términos, leyendo un archivo de migración fijado a mano

Las cinco, contadas hoy:

| # | Dónde | Cómo dice «es combustible del ejercicio» |
|---|---|---|
| 1 | `supabase/migrations/0345_…sql:24` | `concepto = 'diesel' or (p_claves is not null and cardinality(p_claves) > 0 and clave_prod_serv = any(p_claves))` |
| 2 | `supabase/migrations/0317_…sql:139` | `g.concepto = 'diesel' or g.clave_prod_serv = any (coalesce(p_claves_combustible, '{}'))` |
| 3 | `src/lib/likida/cuadre/engine.ts:694` | `g.concepto === 'diesel' \|\| (!!h && h.claves.includes(g.claveProdServ ?? ''))` |
| 4 | `src/lib/likida/fiscal.ts:678-679` | `g.concepto === 'diesel' \|\| o.clavesCombustible.includes(g.claveProdServ ?? '')` |
| 5 | `src/lib/likida/cuadre/desde_db.ts:173` | `g.concepto === 'diesel' \|\| clavesCombustible.includes(g.claveProdServ ?? '')` |

(Y dos copias más, en TypeScript, dentro de `repo_acumulado.test.ts:69-70` y
`:110-130`, que es el archivo que dice medir la equivalencia.)

**Lo que impide que se separen, medido.** El único guardia que cruza la frontera
TS↔SQL es `src/lib/likida/fiscal_agregado_15pct.test.ts`. Sus cuatro aserciones
(`:49-79`) cubren **exclusivamente el término de la forma de pago**: la lista de
la LISR 27-III, el `'99'` sin REP, el `'99'` con REP y el `null`. **Nadie ata la
pertenencia** (`concepto`/`clave_prod_serv`) entre los cinco sitios, **nadie ata
la fecha**, y —hallazgo anterior— nadie ata las copias. Además, `:38` fija el
archivo por nombre:

```
const RUTA_SQL = 'supabase/migrations/0345_combustible_rep_por_definir.sql';
```

Cinco migraciones ya redefinieron `sumar_combustible_ejercicio` (0084 → 0112 →
0190 → 0305 → 0345) y ese literal se ha movido a mano dos veces
(`git log -p --follow`): 0190 → 0305 → 0345. Una sexta redefinición que olvide
mover el literal deja la prueba leyendo una migración que ya no es la vigente y
la suite verde mientras producción diverge — el mismo modo de falla que mató a
`acotada_guardiana.test.ts` y que el propio encabezado del archivo dice combatir.

**Escenario con valores (el término sin guardia, hoy).** Es el hallazgo ALTO de
las copias: `desde_db.ts:171-174` fue reescrito por la 26 «*para espejar el
`where` de la RPC en TODOS sus términos*» y espeja tres de cuatro. Con las dos
fotos del ticket de $100,000, el término que falta mueve $50,000 de deducción y
$6,896.55 de IVA, y ninguna de las 24 pruebas de los cinco guardias se pone en
rojo.

**Consecuencia.** Para el equipo que mantiene esto: cada arreglo del 15 % obliga a
tocar cinco sitios en dos lenguajes y solo uno de los cuatro términos avisa si se
olvida uno. Es la explicación mecánica de por qué este cálculo lleva cuatro
vueltas de arreglo (25, 26 ×2, continuación ×1) y por qué cada vuelta encontró el
defecto en la línea que la anterior acababa de editar.

**Causa raíz probable:** el predicado no tiene una representación única que los
dos lenguajes puedan consumir (una tabla, una vista, o un generador del `where`),
así que la única disciplina disponible es la vigilancia por texto — y se aplicó
al término que dolió, no al predicado.

---

### [MEDIO] «¿Este destino es interno?» tiene dos implementaciones con reglas distintas y dos suites que fijan las dos verdades

`src/lib/http/destino_publico.ts:22-59` (`esIpPublica`/`hostNoPublico`, con los
registros especiales de IANA consultados el 4-sep-2026 y IPv6 restringido a
`2000::/3`) · `src/lib/http/https_publico.ts:44-52` (lo aplica dentro del
`lookup` del socket, sobre TODAS las direcciones) ·
`src/lib/likida/agentes/investigador.ts:157-185` (`esIpPrivada` + `hostPublico`,
una lista escrita a mano) · `src/lib/http/destino_publico.test.ts:5-12` y
`src/lib/likida/agentes/investigador.test.ts:178-192` (las dos suites, las dos
verdes).

**Escenario, con valores.** Tres direcciones, dos veredictos:

| Entrada | `destino_publico` | `investigador.esIpPrivada` |
|---|---|---|
| `100.64.0.1` (CGNAT, IANA special) | **no pública** (test `:7` lo fija) | `a=100` no cae en ningún `if` → **pública** |
| `::ffff:169.254.169.254` (metadatos del cloud, mapeada) | **no pública** (`2000::/3`) | la lista solo trae `::ffff:127.`, `::ffff:10.` y `::ffff:192.168.` → **pública** |
| `64:ff9b::7f00:1` (NAT64 de 127.0.0.1) | **no pública** (test `:9`) | no empieza con `fc/fd/fe8-b` → **pública** |

Además, `hostPublico` (`:176-185`) resuelve el nombre con `lookup()` y comprueba
**la primera** dirección, y luego `fetch()` (`:232`) vuelve a resolver por su
cuenta — la ventana de rebinding que `https_publico.ts:44-52` cierra validando
dentro del `lookup` del socket y sobre `all: true`.

**Consecuencia.** Hoy no hay explotación: el único consumidor es
`investigarProspecto`, que solo baja `prospecto.sitio_web`, y **esa columna no
tiene escritor** (`grep -rn "sitio_web" src/ supabase/ | grep -iE
"insert|update|set"` → cero resultados; `/api/lead/route.ts:193-203` no la
escribe). Lo digo así de explícito porque es lo que baja esto de ALTO a MEDIO.
Lo que queda es el costo de cambiar: hay dos respuestas a la misma pregunta de
seguridad, cada una con su prueba verde, y el próximo módulo que necesite
«¿puedo abrir esta conexión?» va a elegir una de las dos sin saber que existe la
otra — que es exactamente cómo nació esta pareja: `330e8404` endureció el camino
de conectores el 5-sep y no tocó el de `investigador`, escrito antes.

**Causa raíz probable:** el arreglo creó un módulo nuevo (`lib/http/`) en vez de
mover el predicado que ya existía; el viejo se quedó donde estaba, exportado y
probado, y nada señala cuál de los dos es el bueno.

---

### [BAJO · REINCIDENTE de la 25 y la 26] `estadoRenglon` sigue siendo la única reconstrucción de `cubetaDe` que no llama a `cubetaDe`

`src/app/dashboard/[id]/vista.tsx:199-219` (siete condiciones propias) ·
`src/lib/likida/cuadre/engine.ts:469-482` (`cubetaDe`, «*LA ÚNICA definición…
vive aquí, exportada, para que nadie la reconstruya*») · `:480`
(`if (!g.cfdiUuid) return 'por_confirmar'`, el criterio que la pantalla no tiene)
· `src/lib/likida/config.ts:94` (`{ concepto: 'diesel', topeMonto: 4000 }`, sin
`requiereCfdi`) · `src/app/dashboard/[id]/detalle.tsx:371` (dónde se pinta).

Sin cambios respecto a la 26. Ticket de diésel de **$3,800** sin CFDI y sin forma
de pago: `cubetaDe` → `'por_confirmar'` y el bloque de deducibilidad de la MISMA
hoja imprime «Por confirmar $3,800.00»; `estadoRenglon` recorre sus siete
condiciones sin acertar ninguna (`sin_cfdi` no se emitió porque la política del
diésel no exige CFDI) y cae a `{ estado: 'neutral', etiqueta: 'Ticket' }`. Los
otros tres consumidores (`liquidacion/pdf.ts`, `analytics.ts:1617`,
`api/export/poliza/route.ts:196`) sí llaman la función.

---

### [BAJO · REINCIDENTE, sexta ronda seguida — y creció otra vez] `procesarTurno` pasó de 3,140 a 3,253 líneas

`src/lib/likida/processor.ts:1351-4603`. Medido con un barrido de columna 0:
entre la línea 1351 (`async function procesarTurno(...)`) y la 4603 (el `}` final
del archivo) no hay ninguna otra declaración de nivel superior. 4603 − 1351 + 1 =
**3,253**. El archivo entero son 4,603 líneas (eran 4,455).

La serie: 2,913 (c23) → 3,096 (c24) → 3,096 (c25) → 3,140 (c26) → **3,253 (hoy)**.
Seis rondas señalándolo, cero pasos extraídos, y la segunda subida consecutiva.
El 100 % del producto entra por esta función y las +113 líneas que la ronda le
metió se revisaron dentro de un bloque que no se puede probar por partes.

---

### [BAJO · REINCIDENTE de la 26] El encabezado de `revision.ts` declara dos contratos que su propio archivo rompe, y ahora hay 24 archivos que lo desmienten

`src/lib/likida/revision.ts:9` («*Este archivo es el ÚNICO lector/escritor de
`liquidacion.revision` en la app*») · `:18-20` («*La escritura NO re-cuadra…*») ·
`:30` (importa `recalcularParaAjuste`) · `src/lib/likida/revision_recalculo.ts:60`
(`await cuadrarDesdeDB(...)` — la escritura SÍ re-cuadra).

Sin cambios. Y la primera afirmación empeoró: `grep -rln "revision" src/
--include=*.ts --include=*.tsx` (sin pruebas) da **24 archivos**, siete de ellos
leyendo la columna para decidir dinero o pintura —`export/poliza/route.ts:354`,
`v1/liquidaciones/route.ts`, `export/liquidaciones/periodo.ts`,
`analytics.ts:1064`, `liquidacion/pdf.ts:90`, `processor.ts:1203-1206`,
`fiscal.ts`—. Un autor nuevo que lea el encabezado y agregue ahí su rama deja
esos siete sin ella, que es exactamente cómo nació el hallazgo de `?revision=`
de la 25.

---

### [BAJO · REINCIDENTE de la 26] `ROL_BADGE` sigue siendo la quinta copia del dominio de roles, y el barrido que lo debería ver casa por nombre

`src/lib/auth/provisionar.ts:36` (`ROL_LABEL: Record<RolAppUser, string>`, la
única exhaustiva y tipada) · `src/lib/auth/rol_label_unico.test.ts:21`
(`grep -rlnE '(const|let) ROL_LABEL' src` — casa por NOMBRE) ·
`src/app/dashboard/chrome.tsx:29-35` (`ROL_BADGE: Record<string, string>`, los
mismos cinco roles sin tipar) y `:107` (`ROL_BADGE[rol] ?? rol.toUpperCase()`).

Sin cambios. Un sexto rol por migración pone `tsc` en rojo en `provisionar.ts` y
**nunca** menciona `chrome.tsx`: el sidebar imprimiría la clave cruda en
mayúsculas mientras las otras tres pantallas imprimen el rótulo bueno — lo que
literalmente le pasó a `vendedor` antes de `f128cd1`.

---

## Lo que revisé y está bien

- **La frontera de datos aguantó 181 commits sin una sola fuga.** Reimplementé el
  barrido de `frontera_datos_guardiana.test.ts:66-93` fuera de vitest sobre el
  árbol integrado: **252 de 252**, el mismo número que midió la 26. Verifiqué que
  no fue por un techo movido: `git log a3c1560..HEAD -- …guardiana.test.ts` está
  vacío, y de los archivos AÑADIDOS en el rango con `.from(`/`.rpc(` los cuatro
  son `*.test.ts`. Es el guardia que mejor aguantó la integración, por segunda
  ronda seguida.
- **Las dependencias que apuntan al revés siguen siendo dos, las mismas.**
  `grep -rn "from '@/app/" src/lib/` (sin pruebas) → `likida/oficina_wa.ts:7` y
  `lib/mcp/credencial.ts:20`. No nacieron terceras en 346 archivos tocados.
- **La 0345 cerró de verdad la divergencia que la 26 dejó anotada como
  comentario.** `desde_db.ts:156-159` decía que quedaba «*un REP cuyo
  `FormaDePagoP` es a su vez '99': la RPC lo cuenta y este predicado no lo
  juzga*». Lo comprobé término por término: `0345:14-18` mapea `'99'` sin
  `pagado_en` a `null` y `0345:29-31` excluye del numerador `null` y `'99'` —
  justo lo que `medioNoAdmitidoCombustible` (`engine.ts:221-225`) devuelve
  `false`. Las dos implementaciones dicen lo mismo hoy.
- **SQL sigue sin juzgar deducibilidad.** `grep` de `deducible` sobre las 324
  migraciones solo da comentarios y textos de `comment on`: ni un `case` que
  decida cubeta. La promesa de la 0317 («*SQL sigue sin juzgar deducibilidad,
  solo agrupa*») es cierta, y es la frontera más importante del repo.
- **`sat_descarga` no tiene un segundo lector de CFDI.** Era el pendiente
  explícito de la 26 y la 24. `ciclo.ts:28` importa `parseCfdiXml` de
  `intake/cfdi_xml` y `cruce.ts:45` importa el TIPO `CfdiXmlData`; no hay un
  `@_ClaveProdServ` ni un parser propio en todo el directorio. Reuso real.
- **`https_publico.ts` es el contraejemplo bueno del rubro.** Nace importando
  `esIpPublica`/`hostNoPublico` de `destino_publico.ts` (`:5`) en vez de
  copiarlas, y aplica la validación dentro del `lookup` del socket sobre todas
  las direcciones. Es lo que hace más visible que `investigador.ts` se quedó
  atrás.
- **`formaPagoEfectiva` y `formaPagoJuzgableDe` no han divergido.** Son dos
  implementaciones (`fiscal.ts:229-232` y `engine.ts:213-219`) de la misma regla,
  con tipos distintos (`pagado: boolean` vs `pagadoEn: string`) y retornos
  distintos (`null` vs `undefined`). Recorrí las cuatro entradas posibles
  (`null`, `'01'`, `'99'` con REP, `'99'` sin REP) y en las cuatro los dos
  resultados son equivalentes para los consumidores (`medioNoAdmitidoCombustible`
  trata `null` y `undefined` igual). No lo reporto porque no pude construir el
  escenario con valores que este rubro exige — pero es la duplicación con más
  probabilidad de cobrar la próxima.
- **`codificarCursor`/`decodificarCursor` no son una duplicación.** Comparten
  nombre en `api/v1/_comun.ts:445-458` y `viajes_registro.ts:51-71`, pero
  codifican cosas distintas (`creadoEn|id` en base64url vs un JSON `{f,c,id}`) y
  ningún consumidor cruza de un endpoint al otro. Es un nombre repetido, no una
  verdad repetida.
- **Los guardias estructurales corren y están verdes.**
  `frontera_datos_guardiana`, `etiquetas_sincronizadas` (el `otro: 'Gasto'` /
  `otro: 'Otro'`, el ejemplo canónico del rubro, sigue cerrado por PATRÓN),
  `rol_label_unico`, `pill_estatus_unico`, `contencion_listas` y
  `fiscal_agregado_15pct`: 24 pruebas, 5 archivos, verdes.
- **`npx tsc --noEmit -p .` → exit 0.**

---

## Lo que NO alcancé a revisar

- **Las 29 migraciones nuevas (0319-0347) leídas de punta a punta.** Abrí 0305,
  0306, 0308, 0316, 0317, 0342, 0345 y 0346 por lo que tocaban a mis hallazgos.
  **No crucé qué funciones redefine `create or replace` entre 0319 y 0347** — el
  accidente que la 24 encontró en 0283/0299 y la 26 volvió a encontrar en la
  0317. `supabase/verificaciones.sql` (308 bloques) no lo abrí más allá de cuatro
  `grep`.
- **`procesarTurno` por dentro.** Medí su tamaño; no leí sus 3,253 líneas ni
  repetí el barrido de aritmética de dinero que hizo la 26 (`grep` de
  `round2(`/`0.16`/`ivaAcreditable`), así que no puedo afirmar que las +113
  líneas nuevas no metieran una regla de pesos ahí adentro.
- **`conectores/sincronizar_eventos.ts`** — el archivo que más creció de la ronda
  (+1,026 líneas) y no lo abrí. Es un candidato natural a haber duplicado el
  criterio de «evento de seguridad» o el de geocerca.
- **`lib/mcp/herramientas/*` contra `/v1/*`.** Pendiente desde la 26: no crucé
  `viajes.ts` ni `busqueda.ts` contra sus gemelos de la API pública.
- **Un detector de clones por CONTENIDO.** Corrí uno por nombre de símbolo
  exportado sobre todo `src/` y trabajé los candidatos con semántica de dominio
  (`lunesDe`, `masDias`, `diasEntreIso`, `codificarCursor`, `ROL_BADGE`,
  `MAX_CUERPO_BYTES`, `esIpPrivada`, `esCombustible`, `formaPagoEfectiva`). Los
  que comparten estructura sin compartir nombre —las cuatro `forma.tsx` que la 24
  marcó, y las tres `Plegable`— siguen sin evaluarse.
- **Nada que requiera base viva.** Los conteos de los escenarios son aritmética
  sobre las cláusulas SQL y el TypeScript leídos, no filas contadas: la base está
  en cero y no hay credenciales en esta ronda.
