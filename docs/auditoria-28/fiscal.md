# Cumplimiento fiscal — auditoría 28

**Nota: 3/10** (antes 4). Razón del movimiento: **mirada más profunda**. Con esas
palabras: el código fiscal no empeoró —no recibió un solo commit en la ventana—,
se vio mejor. La 27 auditó el **cálculo** del 15 % (numerador, denominador,
prorrateo, copias) y lo agotó. Esta ronda abrió lo de **antes** del cálculo: la
**puerta de elegibilidad** de la RFA 2.9, que ninguna auditoría de esta serie
había cruzado contra su ficha. Ahí hay un camino, medido, por el que el mismo
CFDI de diésel pasa de `{deducible $0 · IVA $0}` a `{deducible $11,600 · IVA
$1,600}` porque el dueño de la flota contestó **«Sí»** a un `<select>` — el mismo
«sí califico» que la entrevista conversacional de la pantalla de al lado **se
niega por escrito a aceptar**, y sin que nadie compare esa respuesta contra
`tenant.regimen_fiscal`. Y la única pantalla que existe para corregirlo escribe
en un campo que el motor ya no lee.

El ancla del rubro («3 o menos si el producto imprime una cifra fiscal
equivocada») ya se rozaba en la 27 por el cubo del 15 %. Lo que la empuja a 3 es
que ahora hay **una segunda ruta, independiente del cálculo, más fácil de
disparar** (la contesta cualquier cliente nuevo el día del alta), que el
**control de corrección es inerte**, y que la vigilancia que debería atrapar la
deriva de las fichas **cubre 18 de 39** con un mecanismo que no existe en
ninguna. Lo que la sostiene en 3 y no menos: la disciplina de fichas sigue
intacta, la derivación correcta **existe** (`administracion.ts:198`,
`entrevista.ts:704`) y está probada — el defecto es que la ruta débil le gana.

**El riesgo mayor del rubro, hoy:** la elegibilidad a la facilidad del 15 % se
puede AUTODECLARAR con un sí/no, y esa autodeclaración **manda sobre** la
derivación desde la clave SAT que un CRÍTICO anterior (FISC-C2-1) instaló
precisamente para que nadie pudiera concederla de más.

| Severidad | # | de los cuales |
|---|---|---|
| CRÍTICO | 2 | 1 nuevo · 1 REINCIDENTE |
| ALTO | 3 | 1 nuevo · 2 REINCIDENTES |
| MEDIO | 3 | 2 nuevos · 1 REINCIDENTE |
| BAJO | 2 | 1 nuevo · 1 REINCIDENTE |

Lo marcado *(medido)* se corrió con `cuadrarViaje` y `parseOnboarding` REALES
desde un `vitest.config.ts` en el scratchpad con `resolve.alias` a
`/home/user/cuadra/src` — **cero archivos del repo tocados**; `git status
--porcelain` vacío al terminar y al empezar.

---

## Primero: los abiertos de la 27, reverificados uno por uno

Ventana de 3 commits, ninguno en código fiscal (`e578dd2` solo toca
`normas/.latido-vigilancia`). Los cinco siguen **exactamente** donde estaban —
abiertos y leídos hoy, no inferidos:

| Hallazgo de la 27 | Verificado hoy | Estado |
|---|---|---|
| **CRÍTICO** — la COPIA de un comprobante entra al 15 % por la RPC y no por el motor | `engine.ts:662-663` (`copiasDeComprobante`) y `:687` (`if (duplicados.has(g.id)) continue`) siguen ahí; `0345:19-24` sigue sin una palabra de copias; `desde_db.ts:171-174` tampoco las resta | **REINCIDENTE** |
| **ALTO** — el denominador suma combustible COMPRADO, la norma dice «pagos EFECTUADOS» | `0345:27` sigue siendo `coalesce(sum(monto), 0) as total` sobre el `where` de `:20-24`, sin mirar forma de pago, mientras `:28-32` sí exige `forma_pago_efectiva is not null` | **REINCIDENTE** |
| **ALTO** — el panel del contador cuenta las copias que el PDF descarta | `fiscal.ts:1080` sigue siendo `gastoTotal += g.monto`; `grep -c copiasDeComprobante src/lib/likida/fiscal.ts` = **0** | **REINCIDENTE** |
| **MEDIO** — `factura_emitida` no puede representar la retención del 4 % | `facturacion_escritura.ts:154`: `const total = Math.round((subtotal + iva) * 100) / 100` | **REINCIDENTE** (de la 25, 26 y 27) |
| **BAJO** — la ficha 2.9 declara viva `tope15DeGastos` | `rfa-2026-2.9.yaml:91` sigue citándola; `fiscal.ts:1205` sigue sin llamador en producción (solo `fiscal.test.ts:493` y `fiscal_agregado.test.ts:328`) | **REINCIDENTE** |

No los desarrollo otra vez: sus escenarios y sus cifras están en
`docs/auditoria-27/fiscal.md` y no han cambiado. Cuentan en la tabla de
severidades porque siguen vivos; no mueven la nota porque repetirlos no es
trabajo nuevo.

**Sobre la sexta implementación del predicado.** El encargo pedía mirar si «una
sexta implementación del mismo predicado dentro de SQL» es el hallazgo raíz. Lo
conté hoy y sigue en **cinco vivas** (`0345:19-33`, `desde_db.ts:171-174`,
`engine.ts:752-812`, `fiscal.ts:229/723/971/1096/1211`, `0317:66-155`). Mi
lectura, sostenida: la duplicación es la **causa** de los tres hallazgos del
cubo, pero no es un hallazgo propio de este rubro —no imprime una cifra
equivocada por sí sola— y su arreglo exige una migración nueva, que el MAPA
declara fuera de esta ronda (`staging-recovery.mjs:121` fija el inventario en
`324/'0347'`). Lo dejo escrito como causa raíz compartida y no lo cuento como
hallazgo.

---

## Hallazgos

### [CRÍTICO] El formulario de onboarding acepta un «sí califico» para el régimen de la RFA 2.9 — la entrevista de la MISMA pantalla lo rechaza por escrito, y el «sí» le gana a la clave del SAT

`src/app/dashboard/onboarding/forma.tsx:80` (`<Selector nombre="regimen"
etiqueta="¿Régimen fiscal elegible para la facilidad del 15%?" opciones={SI_NO}>`)
· `src/lib/likida/perfil/onboarding.ts:37` (`regimenElegible: siNo(String(fd.get('regimen') ?? ''))`)
· `src/lib/likida/perfil/preguntas.ts:239` (`patch.regimenElegible = campo(...)`)
y `:187-189` (`campo()` sella `procedencia: 'declarado'`, la procedencia que
`decidir()` en `:86-91` sí obedece) · `src/app/dashboard/onboarding/page.tsx:68-70`
(`facilidad15Declarada(patch)` → `actualizarFacilidad15`) ·
**`src/lib/likida/cuadre/desde_db.ts:106-113`** — la línea que decide:

```ts
const f15Perfil = facilidad15Declarada(perfilCrudo);
const f15 = config.facilidadCombustibleEfectivo;
const facilidad15 = f15Perfil
  ? (f15Perfil.dedicacionExclusivaCarga && f15Perfil.regimenElegible)
  : (…config…)
```

el **perfil gana**, y el perfil es donde escribe el `<select>`.

Contra los dos sitios que sí derivan la elegibilidad de un hecho comprobable:
`src/lib/likida/administracion.ts:198-199` (`const REGIMENES_ELEGIBLES = ['624',
'612']; const regimenElegible = f.regimenFiscal ? REGIMENES_ELEGIBLES.includes(f.regimenFiscal) : undefined`)
y `src/lib/likida/perfil/entrevista.ts:704` (`const elegible = v === '612' || v === '624'`).

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, literal:

> «Los contribuyentes personas físicas o morales, dedicados exclusivamente al
> autotransporte terrestre de carga federal, **que tributen conforme al Título
> II, Capítulo VII o Título IV, Capítulo II, Sección I de la Ley del ISR**,
> considerarán cumplida la obligación establecida en el artículo 27, fracción
> III, segundo párrafo de la Ley del ISR…»

Y `normas/lisr-72-73.yaml`, **`verificado_fuente_primaria`** —la ficha que
**nadie había cruzado contra el código** (`grep` sobre `docs/auditoria-2*/`: cero
apariciones de `lisr-72-73` antes de hoy)— art. 72, primer párrafo, literal:

> «Se consideran coordinados, a las personas morales que administran y operan
> activos fijos o activos fijos y terrenos, relacionados directamente con la
> actividad del autotransporte terrestre de carga o de pasajeros y cuyos
> integrantes realicen exclusivamente actividades de autotransporte…»

El Título II **Capítulo VII** es ese régimen propio —clave `c_RegimenFiscal`
**624**—, distinto del Título II a secas (clave **601**, la S.A. de C.V.
ordinaria). Esa distinción no es mía: es lo que la propia ficha registra en
`lo_que_ya_estaba_bien_en_el_codigo` y lo que el comentario `FISC-C2-1`
(`administracion.ts:186-197`) documenta como un **CRÍTICO ya corregido**, con su
frase: «Se falla cerrado a propósito: conceder de más imprime en el PDF, citando
el artículo, una deducción que la norma niega». El `<select>` de `forma.tsx:80`
es la puerta trasera de ese mismo fail-closed.

**Lo que el propio repo dice de esta pregunta** (`entrevista.ts:133-134`, la
pregunta `regimenSat`, verbatim):

> «¿En qué régimen tributan? **La clave SAT, no un “sí califico”**. RESICO (626) y
> el régimen general de persona moral (601) NO abren la facilidad del 15 %.»
> … «De la clave se DERIVA si aplica RFA 2.9. **Un “sí” cómodo acreditaría una
> facilidad que el SAT puede negar.**»

Y `entrevista.ts:703` devuelve el rechazo literal cuando alguien contesta con un
sí: «Elige la clave SAT (612, 601, 626, 624…) o descríbela. **No un “sí
califico”**». `entrevista.test.ts:72` incluso exige que el catálogo de la
entrevista **no contenga** `regimenElegible` como pregunta. El formulario está
detrás de un `<details>` en la MISMA página (`onboarding/page.tsx:97`) rotulado
«Prefiero el formulario», con el texto «**Las mismas declaraciones**, sin
conversación» (`:100`). No son las mismas: una exige la clave del SAT, la otra
acepta el sí.

**Escenario** *(medido)*. Flota **S.A. de C.V., régimen 601**, carga federal,
ejercicio 2026. Compras de combustible del año $1,000,000, de las cuales
$140,000 en efectivo (14 %). Un CFDI de diésel de **$11,600** (SubTotal $10,000
+ IVA $1,600), `FormaPago '01'`, XML verificado.

1. El alta la hizo bien: `crearFlota` con `regimenFiscal: '601'` →
   `regimenElegible = false` en `tenant.config` (`administracion.ts:199`).
2. El dueño entra a `/dashboard/onboarding`, abre «Prefiero el formulario» y en
   «¿Régimen fiscal elegible para la facilidad del 15 %?» elige **Sí** — de buena
   fe: es una flota de carga federal.
3. Salida medida de `parseOnboarding` + `declararOnboarding`:
   `regimenElegible = {"valor":true,"procedencia":"declarado"}` →
   `facilidad15Declarada = {dedicacionExclusivaCarga:true, regimenElegible:true}`.
4. `desde_db.ts:108` prefiere el perfil → `facilidad15: true`.

Mismo CFDI, dos veredictos del motor real:

| | 601 real (`facilidad15: false`) | tras el «Sí» del formulario (`true`) |
|---|---|---|
| Deducible para ISR | **$0.00** | **$11,600.00** |
| No deducible | **$11,600.00** | $0.00 |
| IVA acreditable | **$0.00** | **$1,600.00** |
| Diferencia emitida | `efectivo_no_elegible` $11,600 | `combustible_efectivo_dentro15` |

Y la frase que se imprime, verbatim de la corrida:

> «Combustible pagado en EFECTIVO — deducible por la facilidad del 15 % (**RFA
> 2026 regla 2.9**): el ejercicio lleva $140,000.00 de $1,000,000.00 de
> combustible pagado con medios que la LISR 27-III no admite (14 % del total,
> tope 15 %). No acredita IEPS.»

contra la que le corresponde a un 601:

> «…la flota declaró que NO califica a la facilidad del 15 % (dedicación
> exclusiva o régimen), así que el combustible exige uno de los medios de la
> LISR 27-III … — no deducible.»

**Consecuencia.** Sobre los $140,000 de efectivo del ejercicio: **$140,000 de
deducción** que la RFA 2.9 no le concede a un 601 (~$42,000 de ISR a la tasa del
art. 9) y **$19,310 de IVA acreditable** sobre ese efectivo. El papel que lo
sostiene cita el artículo, sale en verde, y lo firmó Likida — es el modo de falla
que el rubro tiene prohibido, y llega por la puerta más transitada que existe: la
pantalla de alta de **cualquier cliente nuevo**. Peor: el mismo `tenant` queda
diciendo dos cosas a la vez, `regimen_fiscal = '601'` (el que viaja al CFDI de la
mensualidad, `suscripcion/page.tsx:205`, cuyo `valorInicial` por defecto es
justamente `'601'`, `:413`) y `perfil.regimenElegible = true`. Nadie los compara:
`guardarPerfilPatch` (`repo.ts:125-140`) es una mezcla plana sin validación, y
`guardarDatosFiscales` cambia `regimen_fiscal` sin recalcular nada.

**Causa raíz probable:** hay dos onboardings para el mismo hecho fiscal con dos
estándares de prueba distintos —la clave del SAT y la palabra del cliente—, y el
que escribe último gana; es exactamente la falla que el comentario de
`forma.tsx:70-77` dice haber cerrado en la **fila de arriba** («dos onboardings,
dos preguntas distintas para la misma facilidad», AUDITORÍA 19 F3) y que quedó
viva en la fila de abajo.

---

### [ALTO] La única pantalla para ver y corregir la declaración del 15 % escribe en el campo que el motor dejó de leer: la corrección del superadmin es inerte

`src/app/admin/flotas/page.tsx:216` (la columna «**Facilidad 15 % (RFA 2.9)**») ·
`:236` (`<select name="reg" defaultValue={f.facilidad15?.regimenElegible === true ? 'si' : …}`)
· `:85-98` (`accionFacilidad` → `actualizarFacilidad15(flotaId, ded, reg)`) ·
`src/lib/likida/repo.ts:1509-1528` — `actualizarFacilidad15` escribe **solo**
`tenant.config` (`rpc('tenant_config_merge', { p_parcial: { facilidadCombustibleEfectivo: … } })`),
nunca `tenant.perfil` · `src/lib/admin/negocio.ts:445-450` — lo que la pantalla
**muestra** también sale de `t.config` · contra
**`src/lib/likida/cuadre/desde_db.ts:106-113`**, donde `f15Perfil` gana y
`config` es el `else`.

**Norma** — la misma `normas/rfa-2026-2.9.yaml`, `verificado_fuente_primaria`
(condición: «que tributen conforme al Título II, Capítulo VII o Título IV,
Capítulo II, Sección I»). Y la regla de la casa que este rubro custodia: *un
rótulo tiene que ser verdad*.

**Escenario.** La flota del hallazgo anterior. El contador llama a Javier: «somos
601, el 15 % no nos aplica». Javier entra a `/admin/flotas`, pone **«Régimen:
No»** en la columna que existe para exactamente esto (su comentario lo dice:
«AUDITORÍA 14: la declaración del 15 % (RFA 2.9) se puede VER y CORREGIR») y
recibe «Declaración del 15 % actualizada.». `tenant.config` queda en `false`.

- Lo que hace el motor en la siguiente liquidación: `f15Perfil` **existe** (el
  formulario lo escribió) → `desde_db.ts:109` devuelve `true` → `facilidad15:
  true` → el PDF vuelve a imprimir «deducible por la facilidad del 15 % (RFA 2026
  regla 2.9)» y los mismos **$11,600 deducibles + $1,600 de IVA** por comprobante.
- Lo que ve Javier al recargar `/admin/flotas`: «Régimen: No», porque la pantalla
  lee `config`. La corrección **se ve aplicada y no lo está**.

**Consecuencia.** Es una falla silenciosa con acuse de recibo: el único control
humano sobre la válvula fiscal más cara del motor confirma por escrito un cambio
que no ocurre, y lo confirma en la consola del superadmin, que es donde se
resuelven las llamadas del contralor. No hay ninguna pantalla que muestre el
valor que el motor de verdad usa (`tenant.perfil.regimenElegible`).

**Causa raíz probable:** el «Paso 6» movió la fuente de verdad de `tenant.config`
a `tenant.perfil` (lo dice el comentario de `desde_db.ts:103-105`: «el perfil es
la fuente. `tenant.config` queda como legado») y dejó atrás a los dos escritores
del campo legado —`/admin/flotas` y `actualizarFacilidad15`— sin migrarlos ni
retirarlos.

---

### [MEDIO] La válvula de «dedicación exclusiva» pregunta por «carga federal, pasaje o turismo» y con ese sí aplica la regla 2.9, cuyo texto verificado dice solo carga federal — y la ficha 2.1 afirma lo contrario dentro del corpus del agente contador

`src/app/dashboard/onboarding/forma.tsx:78` (`etiqueta="¿Dedicación exclusiva a
transporte de carga federal / pasaje / turismo?"`) ·
`src/lib/likida/perfil/entrevista.ts:162` (misma pregunta: «¿La flota se dedica
exclusivamente al autotransporte terrestre de carga federal, **pasaje o
turismo**?») · ese único booleano es el que `desde_db.ts:109` multiplica para
abrir la facilidad y el que `engine.ts:757` consume como `input.facilidad15`.

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, literal:

> «Los contribuyentes personas físicas o morales, **dedicados exclusivamente al
> autotransporte terrestre de carga federal**, que tributen conforme al Título
> II, Capítulo VII o Título IV, Capítulo II, Sección I…»

Ni «pasaje» ni «turismo» aparecen en el texto de la regla. La propia ficha lo
repite en `condiciones_de_aplicacion[0]`: «Dedicados EXCLUSIVAMENTE al
autotransporte terrestre de carga federal». Y `normas/lisr-27-III.yaml` lista el
pasaje y el turismo foráneo como una **excepción distinta**:
`excepciones_que_lo_modifican: [rfa-2026-2.9, **rfa-2026-3.12**, rfa-2026-1.9]`
— y `rfa-2026-3.12` **no tiene ficha** en `normas/` (39 archivos, ninguno es
3.12): el producto estaría concediendo una facilidad regida por una regla que el
repo nunca ha leído.

**El corpus se contradice a sí mismo, y es citable:**
`normas/rfa-2026-2.1.yaml:51` afirma, sobre la regla 2.1, «(no aplica a pasaje ni
turístico — **a diferencia de la RFA 2.2 y 2.9**, esta regla es más angosta)».
Pero el `texto_vigente` de `rfa-2026-2.2.yaml:9-13` y el de `rfa-2026-2.9.yaml:9-11`
—los dos `verificado_fuente_primaria`— dicen **los dos** «dedicados
exclusivamente al autotransporte terrestre de carga federal», la misma fórmula que
la 2.1. Las tres viven en el Título 2 de la RFA, rotulado «Sector de
Autotransporte Terrestre de **Carga Federal**» (`rfa-2026-2.1.yaml:42-43`). Por el
método del rubro, el texto literal verificado gana: la nota de la 2.1 está mal, y
esa nota está embebida **verbatim** en `src/lib/likida/normas/corpus_texto.ts:106`,
que es lo único que el agente contador puede afirmar.

**Escenario.** Flota de **autotransporte turístico** (o mixta carga/turismo) que
contesta «Sí» a la pregunta tal como está redactada —es la respuesta literalmente
correcta a lo que se le pregunta—, con régimen 612. Ejercicio 2026, $1,000,000 de
combustible, $140,000 en efectivo. El motor abre la 2.9 y deduce los $140,000
(~$42,000 de ISR) más $19,310 de IVA, con la nota «deducible por la facilidad del
15 % (RFA 2026 regla 2.9)». La regla 2.9 no la alcanza; la que podría alcanzarla
es la 3.12, y el producto no sabe qué dice.

**Consecuencia.** Para el contralor de una flota de turismo: una deducción
sostenida por una regla que no le aplica, con el número de regla impreso. Para
cualquier contralor: si le pregunta al agente contador «¿la 2.9 cubre pasaje?»,
la respuesta sale de `corpus_texto.ts:106` y es «sí». Le pongo MEDIO y no ALTO
porque Likida vende hoy a flotas de carga y el segmento de turismo no está
abierto — es exposición de redacción y de corpus, no un cliente actual.

**Causa raíz probable:** el arreglo de la AUDITORÍA 19 F3 corrigió «carga» →
«carga federal» y de paso amplió la pregunta a «pasaje / turismo» apoyándose en
la nota de `rfa-2026-2.1.yaml:51`, que es la línea del corpus que contradice a los
dos textos literales que ella misma cita.

---

### [MEDIO] El latido de vigilancia declara «cero hallazgos» sobre 18 de las 39 fichas, con un mecanismo que no existe en ninguna — y `normas/` no puede ni siquiera expresar que una ficha venció

`normas/.latido-vigilancia:61` (`fichas_disparadas: 0 — ninguna de **las 18
fichas** de normas/*.yaml quedó contradicho`) · `.claude/skills/vigilancia-normativa/SKILL.md:3`
(la descripción de la rutina: «detectar cuándo una de **las 18 fichas** de
`normas/` dejó de ser cierta») · contra `ls normas/*.yaml | wc -l` = **39** ·
`SKILL.md:32` describe el mecanismo: «Cada ficha lleva **`hash_texto_vigente`** —
SHA-256 del `texto_vigente` normalizado — y un bloque **`vigilancia:`** con sus
disparadores y su fuente» · medido hoy sobre las 39 fichas:
`grep -l hash_texto_vigente normas/*.yaml` → **0**;
`grep -l '^vigilancia:' normas/*.yaml` → **0**.

Y el otro lado: `src/lib/likida/normas/indice.ts:49-79` define `interface Norma`
con `exigibleDesde?: string | null` y **ninguna contraparte `hasta`**
(`grep -n hasta indice.ts` solo devuelve una palabra dentro de un comentario, la
línea 18). `normas_sincronizadas.test.ts:126` obliga a que el índice y la ficha
coincidan en `fecha_vigencia_desde` — y solo en esa.

**Norma** — no es un artículo, es el método que este rubro declara suyo
(`rubros.md`, §6): «`normas/*.yaml` es la **fuente de verdad**… las marcadas
`verificado_fuente_primaria` ganan cualquier discusión». Una fuente de verdad con
fecha de caducidad que el sistema no puede leer deja de serlo el día que caduca.
El dato concreto: **cinco** fichas llevan `fecha_vigencia_hasta: 2026-12-31`
(`rfa-2026-2.1`, `2.2`, `2.3`, `2.5`, `2.9`), y son las que sostienen la facilidad
del 15 % y el veredicto de deducibilidad de todo el diésel en efectivo.

**Escenario, con fecha.** 8-ene-2027. Se liquida un viaje de enero-2027 con un
diésel de **$11,600** en efectivo. `desde_db.ts:118-120` fija `anioEjercicio =
'2027'`; `engine.ts:757-828` aplica `facilidad15` igual que el 31-dic y el PDF
imprime «deducible por la facilidad del 15 % (**RFA 2026 regla 2.9**)» — citando
una Resolución cuya vigencia terminó siete días antes, según la propia ficha. No
hay un solo lugar donde la vigencia pueda frenarlo: el índice no tiene campo
`hasta`, ninguna prueba lo vigila, y el barrido del DOF (`references/prompt.md:26-31`)
dispara **por publicación con título coincidente** — el vencimiento de una
resolución no es una publicación, así que no dispara nunca. Si la RFA 2027 mueve
el porcentaje o las condiciones (la renumeración 2025→2026 ya movió la regla del
8 % de `1.2` a `2.2`, `rfa-2026-2.2.yaml:27-31`), la cifra impresa es falsa; si no
las mueve, la **cita** es falsa igual.

Y el contraste está en el mismo repo: `cuadre/cuota_diesel.ts:128-133`
(`cuotaDieselVigente`) **falla cerrado de verdad** fuera de su rango cubierto —
devuelve `null`, nunca la última cuota conocida. El patrón existe, probado y
elogiado en la 27; las fichas con caducidad no lo usan.

**Consecuencia.** Dos, distintas. (1) El commit `e578dd2` de esta ventana declara
«barrido 03..05-sep **sin hallazgos nuevos**», y el encargo pedía verificar si es
cierto: **no es verificable** — cubre a lo sumo 18 de 39 fichas y su
`fichas_disparadas: 0` es la aritmética de un conjunto de disparadores vacío, no
evidencia de que nada se movió. Las 21 fichas fuera del conteo incluyen
`lisr-72-73`, `rfa-2026-2.1/2.2/2.3/2.5`, `rmf-2026-3.3.1.7` y `rliva-3-fr-II`.
(2) El 1-ene-2027 el motor sigue citando la RFA 2026 sin que nada lo note. No lo
subo a ALTO porque el daño está fechado a ~4 meses y ninguna cifra está mal hoy;
lo dejo en MEDIO porque el mecanismo que debería atraparlo no existe.

**Causa raíz probable:** la vigilancia se diseñó por **hash y disparadores por
ficha** y se implementó por **palabras clave en el título del DOF**; el número
«18» se congeló cuando había 18 fichas y `normas/` creció a 39 sin que nadie
reconciliara el contador ni el mecanismo.

---

### [BAJO] El comentario que documenta la derivación del régimen sigue diciendo «601/612 califican» — el error exacto que un CRÍTICO corrigió veinte líneas más abajo

`src/lib/likida/administracion.ts:107-110`, el doc-comment de `NuevaFlota.regimenFiscal`:

> «…se captura como el código SAT real (c_RegimenFiscal) en
> `tenant.regimen_fiscal`, y la elegibilidad se DERIVA de él (**los códigos
> 601/612 son los que califican**).»

contra `:198` (`const REGIMENES_ELEGIBLES = ['624', '612'];`) y contra `:186-197`,
el bloque `FISC-C2-1` que declara: «aquí decía `['601', '612']` … · Título II a
secas = la S.A. de C.V. ordinaria → clave 601, que **NO** entra».

**Norma** — `normas/lisr-72-73.yaml`, `verificado_fuente_primaria`, art. 72: el
Capítulo VII es un régimen propio (coordinados, clave 624), distinto del Título II
general. La ficha lo registra literalmente en
`lo_que_ya_estaba_bien_en_el_codigo`.

No cambia ninguna cifra hoy: el código es correcto y la constante también. Lo
reporto porque la trazabilidad ficha↔código es la mitad del método de este rubro,
y este comentario es lo primero que lee quien vaya a tocar la constante: reinstala,
en prosa, el error que costó un CRÍTICO. (Del mismo tipo que el
`normas/rfa-2026-2.9.yaml:91` REINCIDENTE: el índice manda a leer la línea
equivocada.)

---

## Lo que revisé y está bien

- **La derivación desde la clave SAT, en sus dos implementaciones, es correcta y
  coincide con la ficha.** `administracion.ts:198` (`['624','612']`) y
  `entrevista.ts:704` (`v === '612' || v === '624'`), atadas por
  `administracion.test.ts:123-165` y `entrevista.test.ts:110-112` (601 → false;
  612 y 624 → true). El defecto no es la regla, es que hay una tercera ruta que
  no la usa.
- **La entrevista conversacional se niega a aceptar un sí para el régimen**, con
  el rechazo escrito (`entrevista.ts:703`) y con el catálogo probado para que
  `regimenElegible` **no** sea una pregunta (`entrevista.test.ts:72`). Es el
  comportamiento correcto y es el que refuta al formulario.
- **`facilidad15Declarada` no inventa un no.** `preguntas.ts:336-342`: si falta
  cualquiera de los dos campos devuelve `null`, y `decidir()` (`:86-91`) descarta
  las procedencias `inferido`, `ausente` y `default`. `undefined` llega al motor y
  `engine.ts:836-841` emite `combustible_efectivo` («sin esa declaración esto se
  revisa»), que está en `POR_CONFIRMAR` **y** en `SIN_IVA_ACREDITABLE`
  (`:377`, `:403`). Fail-closed real cuando nadie declaró.
- **El CFDI consolidado de monedero NO duplica el gasto** — refuté yo mismo la
  hipótesis con la que entré. `intake/consolidado.ts:241-330` **liga** cada línea
  a un `gasto` ya capturado (lo sella con `cfdi_uuid`/`xml_verificado`); las que
  no ligan se quedan en `cfdi_consolidado_linea` con `estatus='por_conciliar'`,
  **fuera de la tabla `gasto`**. Así que el ticket de bomba y su línea ECC no
  suman dos veces al denominador del 15 % ni al comprobado. No es hallazgo.
- **RMF 3.3.1.7 (monedero) está cableada como la ficha dice.**
  `intake/evidencia_monedero.ts:63-92` no afirma sin evidencia (padrón de
  emisores, o línea ECC del mismo día/estación/monto con ±$1 y ±1 día),
  `engine.ts:715-723` solo emite `ticket_monedero` cuando `!g.cfdiUuid`, el tipo
  está en `POR_CONFIRMAR` (`:377`) y el `if (!g.xmlVerificado) continue` de
  `:1635` corta el IVA y los litros estructuralmente — el razonamiento de
  `:1604-1607` para no meterlo en `SIN_IVA_ACREDITABLE` se sostiene al leerlo.
- **`cubetaDe` sigue siendo la única definición de cubeta** (`engine.ts:469-482`)
  y `!g.cfdiUuid → por_confirmar` sigue en pie: un ticket no es una factura.
- **La lista de medios y el tope de $2,000 no se movieron.**
  `MEDIOS_LISR_27_III = ['02','03','04','05','28','29']` (`engine.ts:126`) contra
  `0345:31`; `TOPE_EFECTIVO_LISR_27_III = 2000` (`:140`) aplicado con `>` y con
  `!esCombustible`, que es lo que ordena el 2º párrafo de la fracción.
- **`0345` conserva el arreglo del `'99'`**: `:30` sigue siendo
  `and forma_pago_efectiva <> '99'` dentro del `filter` del numerador, espejo de
  `medioNoAdmitidoCombustible` (`engine.ts:222`).
- **Los topes de la ley siguen sin ser configurables por el cliente**
  (reverificado: `administracion.ts` no expone `estimulos` en
  `guardarAjustesOperativos`).
- **`normas/rfa-2026-2.5.yaml` ya declara su propio hueco** (una central o
  paradero con régimen 624 **no** puede aplicar 2.1/2.2/2.9, y
  `REGIMENES_ELEGIBLES` no lo distingue). Está escrito en la ficha con su
  `impacto_en_producto` y `pendiente_en_producto`; **no lo levanto como hallazgo
  nuevo** porque está declarado y porque el segmento no está abierto.
- **`normas/rfa-2026-2.2.yaml` (el 8 % «gasto ciego») tiene `usado_en_codigo: []`
  y el código no lo implementa** — verificado con `grep` sobre `src/lib/likida`:
  no hay ningún `0.08` fiscal ni tope de $1,000,000. No implementar una facilidad
  opcional no es un defecto; lo anoto porque era mi otro candidato de cruce y
  salió limpio. (Su `advertencia` —«NO cubre combustible»— tampoco tiene por dónde
  violarse hoy.)

## Lo que NO alcancé a revisar

- **Nada que requiera base viva.** Sin `.env` ni Postgres no corrí las RPC 0345,
  0307, 0308, 0316 ni 0317 contra datos. Los cinco reincidentes y los cinco
  hallazgos de hoy **no** la necesitan: el CRÍTICO y el MEDIO del pasaje están
  medidos con `cuadrarViaje` y `parseOnboarding` reales; el ALTO y los dos BAJO
  son cotejos de texto contra texto con las líneas citadas; el MEDIO de la
  vigilancia se midió con `grep` sobre las 39 fichas.
- **El recorrido de UI no se miró renderizado.** No levanté un preview de
  `/dashboard/onboarding` ni de `/admin/flotas` (el MAPA prohíbe `npm run build`
  aquí): los dos hallazgos de pantalla están sostenidos por el `archivo:línea` del
  `<Selector>` / `<select>` y por la acción de servidor que consume su `name`, no
  por un screenshot.
- **`intake/sat.ts` (69-B / estado del CFDI) y `intake/cfdi.ts` siguen sin abrir**,
  tercera ronda seguida. La descarga masiva del SAT (0231) y `decidirCruce` siguen
  sin auditar.
- **`normas/lisr-27-III.yaml` sigue en `evidencia_corroborante`** («NO se leyó en
  diputados.gob.mx»), igual que `lisr-28-XX`, `cff-29-A`, `rmf-2026-2.7.1.21`,
  `rmf-2026-2.7.1.48`, `rmf-2026-3.3.1.7` y `criterio-1-LIF-PI`. Mientras la
  27-III —la fracción detrás del veredicto rojo más frecuente del motor y del
  importe de $2,000— no se cierre contra fuente primaria, **el ancla de 8+ es
  inalcanzable por construcción**, con independencia del código.
- **`rfa-2026-3.12` no existe como ficha** y por eso el MEDIO del pasaje/turismo
  se queda en «la 2.9 no los cubre» sin poder decir qué sí les aplica.
- **`normas/rmf-2026-2.7.7.yaml` (Carta Porte, obligados y radio de 30 km) y
  `criterios-imss-sbc` / `lss-27`** quedaron sin cruzar esta ronda: el encargo
  pedía UN TEMA y se fue entero en la puerta de elegibilidad de la 2.9.
