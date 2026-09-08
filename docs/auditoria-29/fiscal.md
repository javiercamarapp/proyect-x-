# Cumplimiento fiscal — auditoría 29

**Nota: 4/10** (antes 3). Razón del movimiento: **se atacó y subió** — un punto,
no dos, y la razón de que sea uno está escrita abajo.

Lo que subió es real y lo verifiqué abriendo archivo y prueba, no leyendo asuntos
de commit: la puerta que la 28 marcó como CRÍTICA —el `<select>` sí/no del
onboarding del cliente— **está cerrada y medida** (`regimen=si` ya no se lee;
`regimenSat=601` produce `regimenElegible=false`), el control de corrección del
superadmin **ya no es inerte** (`actualizarFacilidad15` escribe la fuente
autoritativa y hay tres archivos de prueba que fijan el escenario exacto de la
reincidencia), la pregunta de dedicación **ya no dice «pasaje / turismo»** contra
el texto verificado de la 2.9, la ficha 2.1 que contradecía a los dos textos
literales **está corregida y el corpus regenerado** (lo comprobé corriendo
`corpus_texto.test.ts` y `normas_sincronizadas.test.ts`: 22 verdes), y
`tope15DeGastos` —función muerta que la ficha declaraba viva— se retiró. Cinco
hallazgos míos cerrados de verdad en una sola ventana.

Lo que impide que suba más, y es el motivo del punto único: **el arreglo de
FIS-A3 movió el defecto en vez de matarlo**. El sí/no que le ganaba a la clave
del SAT no desapareció: se mudó a `/admin/flotas`, y ese mismo commit lo
**ascendió** — antes ese `<select>` solo escribía `tenant.config` (el legado, que
perdía contra el perfil); hoy escribe `tenant.perfil` con `procedencia:
'declarado'`, que es exactamente el campo que le gana a todo. Y la «fuente
única» que el commit anuncia dejó fuera a dos llamadores de producción, uno de
ellos el panel del contador, que es el comprador.

**El riesgo mayor del rubro, hoy:** la elegibilidad a la facilidad del 15 % sigue
decidiéndose con la palabra de una persona y no con la clave del SAT, y el
arreglo de esta ventana le dio a esa palabra **más** peso del que tenía; nadie
compara nunca esa declaración contra `tenant.regimen_fiscal`.

| Severidad | # | de los cuales |
|---|---|---|
| CRÍTICO | 2 | 1 MUTADO (era FIS-C1 de la 28) · 1 REINCIDENTE (de la 27) |
| ALTO | 3 | 1 nuevo · 2 REINCIDENTES |
| MEDIO | 3 | 2 nuevos · 1 REINCIDENTE |
| BAJO | 2 | 2 nuevos |

Lo marcado *(medido)* se corrió con `cuadrarViaje`, `parseOnboarding`,
`declararFacilidad15`, `facilidad15Vigente`, `causasDe` y `resumirPerdidas`
**reales**, desde un `vitest.config.mjs` en el scratchpad con `resolve.alias` a
`/home/user/cuadra/src` — **cero archivos del repo tocados** (`git status
--porcelain` vacío al empezar y al terminar, salvo este entregable).

---

## Estado de los hallazgos abiertos de la 28

| Hallazgo | Commit que decía cerrarlo | Veredicto verificado hoy |
|---|---|---|
| **CRÍTICO** — el `<select>` sí/no del onboarding le gana a la clave del SAT | `9aefea0` | **MUTADO** → ver FIS-C1 |
| **ALTO** — la corrección del superadmin en `/admin/flotas` es inerte | `b877f2f` | **CERRADO** |
| **MEDIO** (FIS-M1) — la válvula de dedicación decía «pasaje / turismo» y la 2.9 no los cubre | `99fba32` | **CERRADO** |
| **MEDIO** (FIS-M2) — vigilancia sobre 18 de 39 fichas; `normas/` no puede expresar que una ficha venció | `99fba32` | **REINCIDENTE en su mitad viva** → ver FIS-B1 |
| **BAJO** (FIS-B1) — el comentario de `administracion.ts` decía «601/612 califican» | `99fba32` | **CERRADO** |
| **BAJO** (FIS-B2) — la ficha 2.9 declaraba viva `tope15DeGastos` | `99fba32` | **CERRADO** |

Detalle de los tres que no son un «cerrado» limpio:

**El CRÍTICO — cerrado quirúrgicamente, mutado en su causa raíz.** La mitad del
formulario del cliente está cerrada y **medida**: `src/lib/likida/perfil/onboarding.ts:50-51`
(`const regimenSat = limpio('regimenSat'); const regimenElegible = regimenSat ?
regimenElegibleDeClave(regimenSat) : undefined`) y `:19-22`
(`regimenElegibleDeClave` → `clave === '612' || clave === '624'`), con
`src/app/dashboard/onboarding/forma.tsx:34-42` sirviendo las seis claves reales.
Corrido con `parseOnboarding` real, mandando **a la vez** el campo viejo
`regimen=si` y una clave: `regimenSat=''` → sin `regimenElegible` (la pareja no
se declara, `facilidad15Declarada` = `null`); `601` → `false`; `626` → `false`;
`612` y `624` → `true`. El POST que fuerce `regimen=si` ya no concede nada. Eso
sí se cerró. La causa raíz que la 28 escribió —«dos estándares de prueba para el
mismo hecho fiscal, la clave del SAT y la palabra del cliente, y el que escribe
último gana»— **no**: ver FIS-C1.

**FIS-M2 — la mitad mecánica cerrada, la que cuesta dinero declarada fuera de
lote.** `.claude/skills/vigilancia-normativa/SKILL.md` ya no cita un conteo
congelado y `src/lib/likida/normas/indice.ts:92` tiene `exigibleHasta`, cotejado
ficha↔índice por `normas_sincronizadas.test.ts:151-171` (lo corrí: verde). Pero
el propio doc-comment del campo lo dice, `indice.ts:84-85`: «**EL MOTOR NO LO LEE
TODAVÍA**». El escenario de la 28 se reescribe hoy con las mismas palabras: el
8-ene-2027, un diésel en efectivo de $11,600 de un viaje de enero-2027 sale
`facilidad15` por la misma ruta y el PDF imprime «deducible por la facilidad del
15 % (**RFA 2026 regla 2.9**)» citando una Resolución cuya
`fecha_vigencia_hasta: 2026-12-31` (`normas/rfa-2026-2.9.yaml:24`) venció siete
días antes. Lo cuento como REINCIDENTE y le sumo el locus nuevo que encontré:
FIS-B1.

**Los cinco reincidentes que la 28 arrastraba de la 27** — reverificados hoy, uno
por uno, leyendo el archivo:

| Hallazgo | Verificado hoy | Estado |
|---|---|---|
| **CRÍTICO** — la COPIA de un comprobante entra al 15 % por la RPC y no por el motor | `0345` sigue sin una palabra de copias (`0345_combustible_rep_por_definir.sql:19-33`); `engine.ts:674` (`copiasDeComprobante`) sigue siendo solo del motor | **REINCIDENTE** (4ª ronda) |
| **ALTO** — el denominador suma combustible COMPRADO; la norma dice «pagos EFECTUADOS» | `0345:27` sigue siendo `coalesce(sum(monto), 0) as total` sin mirar forma de pago, mientras `:28-32` sí la exige para el numerador | **REINCIDENTE** |
| **ALTO** — el panel del contador cuenta las copias que el PDF descarta | `fiscal.ts:1117` sigue siendo `gastoTotal += g.monto`; `grep -c copiasDeComprobante src/lib/likida/fiscal.ts` = **0** | **REINCIDENTE** |
| **MEDIO** — `factura_emitida` no puede representar la retención del 4 % | `facturacion_escritura.ts:154`: `const total = Math.round((subtotal + iva) * 100) / 100` | **REINCIDENTE** (25, 26, 27, 28) |
| **BAJO** — la ficha 2.9 declara viva `tope15DeGastos` | `normas/rfa-2026-2.9.yaml:85-91` ya cita los símbolos vivos | **CERRADO** por `99fba32` |

No los desarrollo otra vez: sus escenarios y sus cifras están en
`docs/auditoria-27/fiscal.md` y no han cambiado. Cuentan en la tabla de
severidades porque siguen vivos; no mueven la nota porque repetirlos no es
trabajo nuevo.

---

## Fichas cruzadas esta ronda

Abiertas y leídas completas (no solo el nombre): `rfa-2026-2.9`, `rfa-2026-2.1`,
`rfa-2026-2.3`, `lisr-27-III`, `lisr-28-V`, `lisr-28-XX`, `lisr-72-73` (releída
para el veredicto del CRÍTICO), `rlisr-57`, `lif-2026-20-A`, `rmf-2026-9.1.7`,
`rmf-2026-9.1.8`, `red-nacional-autopistas`, `tesis-autotransporte`,
`rliva-3-fr-II`, `cff-29-A`, `criterio-1-LIF-PI`, más el archivo de datos
`normas/datos/cuota-ieps-diesel.yaml`.

**Nunca cruzadas antes por ninguna auditoría de la serie** (`grep` sobre
`docs/auditoria-2*/`: cero apariciones): **`red-nacional-autopistas`**,
**`rmf-2026-9.1.7`**, **`tesis-autotransporte`**, **`rfa-2026-2.3`**. De las
cuatro salió FIS-M2. (Las otras tres sin cruzar —`lft-110-111-263`,
`lft-132-XXXIV-jornada`, `reglamento-transito-83`— son de `legal`, no de este
rubro.)

`verificado_fuente_primaria` entre las que cruzo y que por tanto ganan cualquier
discusión: `rfa-2026-2.9`, `rfa-2026-2.1`, `rfa-2026-2.3`, `lisr-28-V`,
`lisr-72-73`, `rlisr-57`, `lif-2026-20-A`, `rmf-2026-9.1.7`, `rmf-2026-9.1.8`,
`red-nacional-autopistas`, `tesis-autotransporte`, `rliva-3-fr-II`. Inventario
medido hoy sobre las 39: **31** `verificado_fuente_primaria`, **7**
`evidencia_corroborante`, **1** `sin_verificar`.

**No verificables en esta ronda** (`evidencia_corroborante`, sin texto literal en
fuente primaria — no se asume que estén bien ni mal): **`lisr-27-III`**,
`lisr-28-XX`, `cff-29-A`, `criterio-1-LIF-PI`, `rmf-2026-2.7.1.21`,
`rmf-2026-2.7.1.48`, `rmf-2026-3.3.1.7`; y `politica-portales-plazos`
(`sin_verificar`). Sigue en pie lo que la 28 dejó escrito: mientras la **27-III**
—la fracción detrás del veredicto rojo más frecuente del motor y del importe de
$2,000— no se cierre contra fuente primaria, **el ancla de 8+ es inalcanzable por
construcción**, con independencia del código.

---

## Hallazgos

### [CRÍTICO] FIS-C1 — el sí/no que le gana a la clave del SAT no se cerró: se mudó a `/admin/flotas`, y el arreglo de FIS-A3 lo ASCENDIÓ de `tenant.config` (legado) a `tenant.perfil` (la fuente que decide)

`src/app/admin/flotas/page.tsx:236-241` — el control, textual:

```tsx
<select name="reg" defaultValue={…}>
  <option value="">Régimen: —</option>
  <option value="si">Régimen: Sí</option>
  <option value="no">Régimen: No</option>
</select>
```

· `:89` (`const reg = fd.get('reg') === 'si' ? true : fd.get('reg') === 'no' ? false : undefined`)
· `:96` (`await actualizarFacilidad15(flotaId, ded, reg, s.userId)`)
· **`src/lib/likida/repo.ts:1599`** — la línea que cambió esta ventana:
`await guardarPerfilPatch(tenantId, declararFacilidad15(ded, reg), actualizadoPor);`
· `src/lib/likida/perfil/preguntas.ts:391-394` (`declararFacilidad15` → `campo(regimenElegible)`)
y `:171-173` (`function campo<T>(valor: T) { return { valor, procedencia: 'declarado' }; }`)
· `src/lib/likida/perfil/preguntas.ts:366-367` (`facilidad15Vigente`: `const f15Perfil = facilidad15Declarada(perfilCrudo); if (f15Perfil) return f15Perfil;` — el perfil gana y el `config` es el `else`)
· `src/lib/likida/cuadre/desde_db.ts:110-113` (`const f15Vigente = facilidad15Vigente(perfilCrudo, config)` → `facilidad15`).

Contra el único sitio que deriva la elegibilidad de un hecho comprobable,
`src/lib/likida/administracion.ts:198-199`:

```ts
const REGIMENES_ELEGIBLES = ['624', '612'];
const regimenElegible = f.regimenFiscal ? REGIMENES_ELEGIBLES.includes(f.regimenFiscal) : undefined;
```

y contra el comentario `FISC-C2-1` que ese mismo archivo lleva encima
(`administracion.ts:194-196`): «Se falla cerrado a propósito: **conceder de más
imprime en el PDF, citando el artículo, una deducción que la norma niega**».

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, líneas
9-12, literal:

> «Los contribuyentes personas físicas o morales, dedicados exclusivamente al
> autotransporte terrestre de carga federal, **que tributen conforme al Título
> II, Capítulo VII o Título IV, Capítulo II, Sección I de la Ley del ISR**,
> considerarán cumplida la obligación establecida en el artículo 27, fracción
> III, segundo párrafo de la Ley del ISR…»

Y `normas/lisr-72-73.yaml`, **`verificado_fuente_primaria`**, art. 72 primer
párrafo:

> «Se consideran **coordinados**, a las personas morales que administran y operan
> activos fijos o activos fijos y terrenos, relacionados directamente con la
> actividad del autotransporte terrestre de carga o de pasajeros y cuyos
> integrantes realicen exclusivamente actividades de autotransporte…»

El Título II **Capítulo VII** es ese régimen propio (clave `c_RegimenFiscal`
**624**), distinto del Título II a secas (clave **601**, la S.A. de C.V.
ordinaria). La condición de la regla es una **clave del SAT**, no una opinión.

**Qué cambió esta ventana, y por qué empeora en vez de mejorar.** Antes de
`b877f2f`, `actualizarFacilidad15` escribía **solo** `tenant.config`
(el legado), así que un «Sí» del superadmin **perdía** contra cualquier
declaración del perfil. Hoy escribe el perfil PRIMERO, con `procedencia:
'declarado'` — la única procedencia que `decidir()` obedece
(`preguntas.ts:86-91`) — y por tanto le gana a todo, incluida la derivación
correcta desde la clave. El commit lo dice sin rodeos: «El `<select>` sí/no de
`/admin/flotas/page.tsx` queda intacto (decisión de producto fuera de este
lote)». La puerta trasera del fail-closed no se tapió: se le puso escalera.

**Escenario** *(medido)*. Flota **S.A. de C.V., régimen 601**, carga federal,
ejercicio 2026. Alta bien hecha: `crearFlota` con `regimenFiscal: '601'` →
`tenant.regimen_fiscal = '601'` y `config.facilidadCombustibleEfectivo.regimenElegible = false`
(`administracion.ts:199`). Compras de combustible del año $1,000,000, de las
cuales $140,000 con medios que la LISR 27-III no admite (14 %). Un CFDI de diésel
de **$11,600** (SubTotal $10,000 + IVA $1,600), `FormaPago '01'`, XML verificado.

1. El contador llama a Javier: «somos flota de carga federal, sí calificamos».
   Javier entra a `/admin/flotas`, columna «Facilidad 15 % (RFA 2.9)», pone
   **Carga: Sí · Régimen: Sí** y recibe «Declaración del 15 % actualizada.».
2. Salida medida de `declararFacilidad15(true, true)`:
   `{"dedicacionExclusivaCarga":{"valor":true,"procedencia":"declarado"},"regimenElegible":{"valor":true,"procedencia":"declarado"}}`
   → escrito en `tenant.perfil`.
3. Salida medida de `facilidad15Vigente(perfil, config{regimenElegible:false})`:
   `{"dedicacionExclusivaCarga":true,"regimenElegible":true}` — **el `false`
   derivado de la clave 601 no se consulta**.
4. `desde_db.ts:111-113` → `facilidad15: true`.

Mismo CFDI, dos veredictos del motor real *(medidos con `cuadrarViaje`)*:

| | 601 real (`facilidad15: false`) | tras el «Régimen: Sí» (`true`) |
|---|---|---|
| Deducible para ISR | **$0.00** | **$11,600.00** |
| No deducible | **$11,600.00** | $0.00 |
| IVA acreditable | **$0.00** | **$1,600.00** |
| Diferencia emitida | `efectivo_no_elegible` | `combustible_efectivo_dentro15` |

Y la frase que se imprime, verbatim de la corrida:

> «Combustible pagado en EFECTIVO — deducible por la facilidad del 15 % (**RFA
> 2026 regla 2.9**): el ejercicio lleva $140,000.00 de $1,000,000.00 de
> combustible pagado con medios que la LISR 27-III no admite (14 % del total,
> tope 15 %). No acredita IEPS.»

contra la que le corresponde a un 601:

> «…la flota declaró que NO califica a la facilidad del 15 % (dedicación
> exclusiva o régimen), así que el combustible exige uno de los medios de la LISR
> 27-III … — no deducible.»

**Consecuencia.** Sobre los $140,000 de efectivo del ejercicio: **$140,000 de
deducción** que la RFA 2.9 no le concede a un 601 (~$42,000 de ISR a la tasa del
art. 9) y **$22,400 de IVA acreditable** sobre ese efectivo. El papel cita el
artículo, sale en verde y lo firmó Likida. Y el `tenant` queda diciendo dos cosas
a la vez: `regimen_fiscal = '601'` —el que viaja al CFDI de la mensualidad— y
`perfil.regimenElegible = true`. Nadie los compara: `guardarPerfilPatch`
(`repo.ts:127-140`) es una fusión sin validación y `guardarDatosFiscales` cambia
`regimen_fiscal` sin recalcular nada.

**Severidad.** Se queda en CRÍTICO y no baja a ALTO porque el resultado es una
cifra fiscal equivocada impresa con su artículo al lado; lo que sí bajó es el
**radio**: de «cualquier cliente nuevo, en la pantalla de alta» a «la consola del
superadmin». Ese cambio de radio es la mitad del punto que sube la nota.

**Causa raíz probable:** siguen existiendo dos estándares de prueba para el mismo
hecho fiscal —la clave del SAT y la palabra de una persona— y el que escribe
último gana; el arreglo cerró el escritor barato del cliente y promovió el del
superadmin a la fuente autoritativa sin cotejarlo contra `tenant.regimen_fiscal`.

---

### [ALTO] FIS-A1 — la «fuente única» de FIS-A3 se instaló como parámetro OPCIONAL, y los dos paneles de producción no lo pasan: el panel del contador juzga el 15 % con el legado mientras el motor y el chat lo juzgan con el perfil

`src/lib/likida/fiscal.ts:577` — la firma que hace posible el hueco:

```ts
export function opcionesDe(cfg: LikidaConfig, perfilCrudo?: unknown): OpcionesFiscales {
```

· `:593` (`elegible15: f15Vigente ? (…) : undefined`) · los llamadores, medidos con `grep`:

| Llamador | ¿pasa el perfil? |
|---|---|
| `src/app/dashboard/contador/inicio-contador.tsx:121` y `:126-128` | **NO** (`opcionesDe(cfg)`) |
| `src/app/dashboard/inicio-contenido.tsx:161` y `:166-168` | **NO** (`opcionesDe(cfg)`) |
| `src/lib/agents/chat-tools.ts:152` | sí (`opcionesDe(cfg, perfilCrudo)`) |
| `src/lib/mcp/herramientas/dinero.ts:165` | sí |
| `fiscal.ts:1650` / `:1715` (`getGastosFiscales*`) | sí (`perfilBestEffort`) |

El propio comentario del arreglo lo deja escrito, `fiscal.ts:580-582`:
«`perfilCrudo` es opcional y best-effort: un llamador que no lo tenga a la mano
(todavía) **se degrada exactamente al comportamiento de antes** (solo
`tenant.config`)». Ese «comportamiento de antes» es la reincidencia que FIS-A3
decía cerrar.

**Norma** — la misma `normas/rfa-2026-2.9.yaml` (`verificado_fuente_primaria`,
líneas 9-12) y la regla de la casa que este rubro custodia: *un rótulo tiene que
ser verdad*, y *la misma cifra fiscal no se puede leer distinto en dos
pantallas*.

**Escenario** *(medido)*, sin ninguna contradicción de captura de por medio.
Flota S.A. de C.V. dada de alta **sin capturar `regimenFiscal`** —es opcional
(`administracion.ts:112`) y sin él `crearFlota` no escribe
`facilidadCombustibleEfectivo` en absoluto (`:200-208`), así que `tenant.config`
no trae la llave. El dueño completa `/dashboard/onboarding` **con toda
honestidad**: «Dedicación exclusiva al autotransporte terrestre de carga federal»
= **Sí**, «Régimen fiscal (clave SAT)» = **601**. Ejercicio 2026 con $140,000 de
diésel en efectivo y $22,400 de IVA trasladado.

- `perfil` queda `{dedicacionExclusivaCarga: true(declarado), regimenElegible: false(declarado)}`
  *(medido con `parseOnboarding` + `declararOnboarding` reales)*.
- **Motor y PDF** (`desde_db.ts:110-113`): `facilidad15 = true && false = false` →
  los $140,000 salen **no deducibles**, IVA acreditable **$0**.
- **`/dashboard/contador`, `resumirPerdidas` con `opcionesDe(cfg)`**
  (`inicio-contador.tsx:121`): `elegible15 = undefined` → `causasDe`
  (`fiscal.ts:763`) empuja **`combustible_efectivo`** en vez de
  `efectivo_no_elegible`. Medido: `{"montoPerdido":0,"montoEnRiesgo":140000}` —
  contra `{"montoPerdido":140000,"montoEnRiesgo":0}` que da la misma función con
  el perfil. El renglón que se pinta (`resumen-visual.tsx:203-215`, `MotorFiscal`)
  dice **«Combustible pagado en efectivo · 1 comprobante · $140,000.00»**, cuya
  ficha de causa (`fiscal.ts:693-698`) reza «**Dentro del 15 % sigue siendo
  deducible**; el excedente no».
- **En la MISMA página**, `BloqueDesglose` (`inicio-contador.tsx:288`, alimentado
  por `pResumenFiscal` de `:135-137`, que **sí** lee el perfil vía
  `opcionesFiscalesDelPeriodo`) imprime esos mismos $140,000 con **$22,400 de IVA
  NO acreditable**, porque ahí `elegible15 === false` (`fiscal.ts:1007`).
- Y si el contralor le pregunta al chat, `chat-tools.ts:152` **sí** pasa el perfil
  y contesta la versión del motor. Tres respuestas, dos fuentes, un solo hecho.

**Consecuencia.** El comprador —el contralor, en la pantalla que se llama «Panel
del contador»— lee que $140,000 de diésel están «en riesgo» y «dentro del 15 %
siguen siendo deducibles», dos centímetros encima del desglose que dice que su
IVA no se acredita y el mismo día en que el PDF los declaró no deducibles. Es
falla silenciosa: el KPI de arriba (`motor-fiscal-periodo.tsx:72`) suma
`montoEnRiesgo + montoPerdido`, así que la cifra agregada tapa la diferencia y
nadie ve que hay dos criterios corriendo.

**Causa raíz probable:** la fuente única se introdujo como parámetro opcional en
vez de como dependencia obligatoria, y ningún guardia cuenta llamadores de
`opcionesDe` sin perfil — el mismo patrón que la 28 documentó para
`tenant.config`, un nivel más arriba.

---

### [MEDIO] FIS-M1 — el cubo del 15 % se define por exclusión de una lista que **no** es la que la RFA 2.9 enumera, y esa lectura (la tercera de la regla) no está declarada en ninguna parte

`src/lib/likida/cuadre/engine.ts:120-126`:

```ts
// AUDITORÍA 2 (fiscal): los medios de pago que la LISR 27-III / LIF 20-A-IV
// aceptan para acreditar un estímulo. Lista CERRADA (02 cheque, 03 transferencia,
// 04 tarjeta crédito, 05 monedero, 28 débito, 29 servicios) …
export const MEDIOS_LISR_27_III = ['02', '03', '04', '05', '28', '29'] as const;
```

· `:221-225` — el predicado que define el cubo del 15 %:
`return !(MEDIOS_LISR_27_III as readonly string[]).includes(formaPago);`
· mismo predicado en `fiscal.ts:759` y espejado en SQL en
`0345_combustible_rep_por_definir.sql:31` (`not in ('02','03','04','05','28','29')`).

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, líneas
13-17, literal (el subrayado es mío):

> «…cuando los pagos por consumo de combustible se realicen con **medios
> distintos a cheque nominativo de la cuenta del contribuyente; tarjeta de
> crédito, de débito o de servicios; o monederos electrónicos autorizados por el
> SAT**, siempre que estos no excedan el 15 por ciento del total de los pagos
> efectuados por consumo de combustible para realizar su actividad.»

La enumeración de la RFA tiene **cuatro** familias. La de la LISR 27-III
(`normas/lisr-27-III.yaml:9-14`) tiene **cinco**, porque abre con la que la RFA
no menciona:

> «…se efectúen mediante **transferencia electrónica de fondos** desde cuentas
> abiertas a nombre del contribuyente…; cheque nominativo de la cuenta del
> contribuyente, tarjeta de crédito, de débito, de servicios, o los denominados
> monederos electrónicos autorizados por el Servicio de Administración
> Tributaria.»

El motor construye el cubo de la **RFA** por exclusión de la lista de la
**LISR**, con `'03'` dentro. Leída al pie de la letra, una transferencia
electrónica es un «medio distinto» a los cuatro que la RFA enumera y **consume**
el 15 %.

**Escenario, con pesos.** Flota 624, ejercicio 2026, combustible $1,000,000:
$700,000 por transferencia (`03`), $160,000 en efectivo (`01`), $140,000 con
tarjeta de crédito (`04`).

- **Lo que hace el motor:** numerador = $160,000 → 16 % > 15 % → tope $150,000 →
  **$150,000 deducibles** del efectivo y $10,000 no deducibles; IVA acreditable
  sobre esos $150,000 = **$24,000**.
- **Lectura literal de la ficha:** numerador = $700,000 + $160,000 = $860,000
  (86 %) → el cupo de $150,000 se consume con las transferencias y el efectivo
  queda **íntegramente fuera**: **$160,000 no deducibles**, $0 de IVA sobre ellos.
- Diferencia entre lecturas: **$150,000 de deducción (~$45,000 de ISR) y $24,000
  de IVA acreditable**, en una sola flota y un solo ejercicio.

**Me refuté a mí mismo antes de escribirlo, y el resultado sigue siendo un
hallazgo.** La lectura del motor es la defendible: la RFA existe para tener «por
cumplida la obligación establecida en el artículo 27, fracción III, **segundo
párrafo**», y un pago por transferencia ya cumple ese párrafo por sí solo, así
que no tiene sentido que consuma un cupo hecho para lo que no cumple. La propia
ficha lo glosa así en `condiciones_de_aplicacion[2]` («**El efectivo** no puede
exceder el 15 %»). Lo que reporto no es el resultado: es que **la elección no
está declarada**. El repo tiene doctrina explícita para esto —
`LECTURA_RFA_29_PRORRATEO` (`engine.ts:258-270`) declara la lectura (a) frente a
la (b) y hasta pone la cifra de la diferencia; `BASE_ESTIMULO_PEAJE` hace lo
mismo para la base del peaje — y aquí no hay una línea. Peor: el comentario de
`engine.ts:120-123` **rotula la lista como «los medios que la LISR 27-III / LIF
20-A-IV aceptan»** y a cuatro líneas la reusa como definición de un cubo de la
**RFA**, que enumera uno menos. La divergencia siempre cae del lado de conceder
de más, que es el lado que `administracion.ts:194-196` declara caro.

**Consecuencia.** El contralor no puede tener con su contador la discusión que sí
puede tener sobre el prorrateo, porque el papel no le dice que hubo una elección.
Y la ficha `lectura_aplicada_por_el_motor` (`rfa-2026-2.9.yaml:60-71`) enumera
dos lecturas de la regla; ésta es una tercera, sobre otro término de la misma
frase, y no está en ninguna de las dos listas.

**Causa raíz probable:** una constante nombrada por la norma que la originó
(`MEDIOS_LISR_27_III`, auditoría 2) se reusó como definición de un concepto de
otra norma sin cotejar las dos enumeraciones.

---

### [MEDIO] FIS-M2 — dos fichas `verificado_fuente_primaria` que nadie había cruzado nunca dan instrucciones OPUESTAS sobre la caseta estatal, y las dos se le entregan al chat en el mismo tema

`normas/rmf-2026-9.1.7.yaml:53-57`, **`verificado_fuente_primaria`**,
`consecuencia_operativa`, literal:

> «La 9.1.7 define un término que la fracción V no emplea. **NO extiende el
> estímulo de peaje a autopistas concesionadas ni estatales**, porque no toca la
> expresión que sí usa la ley: “Red Nacional de Autopistas de Cuota”. El motor
> debe seguir el texto legal, y **una caseta fuera de esa Red no genera
> estímulo**.»

`normas/red-nacional-autopistas.yaml:78-85`, **`verificado_fuente_primaria`**,
`la_regla_de_negocio`, literal:

> «**NO CONSTRUIR LISTA BLANCA DE CASETAS. Prácticamente toda plaza del RNC cae
> dentro de la Red**; lo que hay que filtrar NO es la geografía sino el medio de
> pago y la trazabilidad. La condición es: `es_de_cuota AND
> pago_con_TAG_o_sistema_electrónico` (RMF 9.1.8 fr. III) `AND
> bitácora_origen_destino_conciliada_con_estado_de_cuenta` (fr. II)…»

La misma ficha inventaría el universo en disputa (`:39-40`): «Campo
`ADMINISTRA`: CAPUFE 725, Concesionado 507, **Estatal 141**, Municipal 3». Una
ficha dice que esas 141 + 507 no generan estímulo; la otra dice que
prácticamente todas sí y que no se filtre por geografía. Las dos están marcadas
`verificado_fuente_primaria`, las dos se verificaron el **20-ago-2026**, y las
dos declaran `usado_en_codigo: []` (`rmf-2026-9.1.7.yaml:66`,
`red-nacional-autopistas.yaml:88`) — lo cual es falso: viven en
`src/lib/likida/normas/consulta.ts:52-56`, tema `peajes_y_casetas`, que es lo que
la tool `consultar_normas` del chat le entrega al analista
(`src/lib/agents/chat-tools.ts:386-400`).

**Escenario, con pesos.** Flota de carga federal, ingresos $80M, no parte
relacionada (`elegiblePeaje = true`). En el ejercicio paga **$100,000** de
casetas de libramientos **estatales** con TAG (`FormaPago '03'`), más IVA.

- **Lo que hace el motor:** `engine.ts:1719` dispara con `g.concepto === 'caseta'`
  a secas —sin filtro geográfico— y el PDF imprime «Estímulo de peaje 50 % (LIF
  2026 art. 20, ap. A) — sujeto a elegibilidad» por **$50,000**
  (`acreditable.ts:131-140`).
- **Bajo la ficha 9.1.7** esos $50,000 no existen; **bajo `red-nacional`** sí. El
  motor está del lado de la segunda sin que nadie lo haya decidido.
- El contralor que le pregunte al chat «¿mis casetas estatales cuentan?» recibe
  las dos fichas en el mismo `tema` y ninguna señal de que se contradicen.

**Por qué es MEDIO y no ALTO.** El renglón del PDF ya sale en tono
`condicionado` y `CONDICIONES_ESTIMULO_PEAJE` (`acreditable.ts:84-90`) nombra la
condición de la Red Nacional y dice que Likida no la verifica: la afirmación está
declarada, que es la mitad que este rubro exige. Lo que no está resuelto es cuál
de las dos fichas gana, y el corpus del producto no puede enseñar una
contradicción que no sabe que tiene.

**Causa raíz probable:** las dos fichas se escribieron el mismo día para el mismo
hueco (H5 de `lif-2026-20-A`) desde dos ángulos —el textual y el operativo— y
nadie las leyó una contra la otra; ninguna auditoría de la serie las había
abierto.

---

### [BAJO] FIS-B1 — `exigibleHasta` existe, está cotejado y **no tiene un solo lector de producción**: la única salida de una norma hacia el chat tira el campo

`src/lib/likida/normas/indice.ts:92` (`exigibleHasta?: string | null`), poblado
con `"2026-12-31"` en las cinco fichas de la RFA 2026 (`:352`, `:364`, `:376`,
`:388`, `:400`). `grep -rn "exigibleHasta" src/` devuelve **cinco** apariciones y
todas viven en `normas_sincronizadas.test.ts` o en la definición: **cero
lectores**. Y el único proyector hacia el modelo,
`src/lib/likida/normas/consulta.ts:106-108` y `:135`, expone
`exigible_desde: n.exigibleDesde ?? null` **sin contraparte `hasta`**.

**Norma** — no es un artículo: es la vigencia que las propias fichas declaran.
`normas/rfa-2026-2.9.yaml:24` (`fecha_vigencia_hasta: 2026-12-31`) y las cuatro
hermanas.

**Escenario.** 8-ene-2027. El contralor pregunta por WhatsApp «¿el diésel en
efectivo me sigue siendo deducible?». `consultar_normas('diesel_y_combustible')`
devuelve `rfa-2026-2.9` con `afirmable: true`, `jerarquia: 3`, `exigible_desde:
'2026-02-18'` y **nada** que diga que su vigencia terminó ocho días antes; la
regla que viaja con el dato (`chat-tools.ts:396`) es «Cita SOLO estas normas, con
su campo "cita" textual», así que el analista cita «RFA 2026 regla 2.9» como
vigente. Es el mismo 1-ene-2027 del FIS-M2 de la 28, ahora con un locus concreto
y con el campo ya poblado a un `if` de distancia.

No cambia ninguna cifra hoy. Lo reporto porque el arreglo de la 28 dejó el dato
cotejado y a nadie leyéndolo, y porque el propio doc-comment
(`indice.ts:84-85`: «EL MOTOR NO LO LEE TODAVÍA») declara pendiente **el motor**
y no menciona que el **chat** también lo ignora.

---

### [BAJO] FIS-B2 — el `ayuda` de la pregunta de dedicación afirma que es «válvula … del estímulo de peaje», y el estímulo de peaje no la lee

`src/app/dashboard/onboarding/forma.tsx:104`, textual:

> `ayuda="RFA 2026 regla 2.9: exige carga FEDERAL específicamente — la carga
> local/municipal no califica. Válvula del 15% de combustible en efectivo **y del
> estímulo de peaje**."`

contra `src/lib/likida/perfil/preguntas.ts:126-133`, la función completa que
decide ese estímulo:

```ts
export function calificaEstimuloPeaje(perfilCrudo: unknown): ElegibilidadEstimuloPeaje {
  …
  if (menoresA300M === undefined || parteRelacionada === undefined) return { elegible: null };
  return { elegible: menoresA300M && !parteRelacionada };
}
```

`dedicacionExclusivaCarga` no aparece; `desde_db.ts:77-78` toma `elegiblePeaje`
de ahí y `engine.ts:1718-1719` no consulta ninguna otra declaración.

**Norma** — `normas/lif-2026-20-A.yaml`, **`verificado_fuente_primaria`**,
`estimulo_peaje.texto_vigente` (líneas 147-149):

> «Se otorga un estímulo fiscal a las personas contribuyentes **que se dediquen
> exclusivamente al transporte terrestre público y privado, de carga o pasaje,
> así como el turístico**, que utilizan la Red Nacional de Autopistas de Cuota…»

Dos cosas, y las dos importan. (1) El rótulo miente: contestar «No» a esa
pregunta no mueve un peso del estímulo de peaje. (2) Hay una trampa latente
puesta esta misma ventana: `99fba32` (FIS-M1) **estrechó** la pregunta a «carga
federal» —correcto para la RFA 2.9, cuyo texto solo dice carga federal— pero el
`ayuda` sigue colgándole el estímulo de peaje, cuya ley **sí** cubre pasaje y
turismo. Si alguien lee ese rótulo y cablea el booleano a `elegiblePeaje`, negará
un estímulo que la LIF concede a una flota de pasaje.

Y la condición de fondo que la fr. V sí exige —dedicarse **exclusivamente** al
transporte— el motor no la verifica; la ficha lo dice con todas sus letras en
`aplicabilidad_por_segmento.peaje_50_fr_V.no_aplica_a` («La flota privada de una
empresa cuyo giro es otro»). Eso está declarado en el papel
(`acreditable.ts:84-90`), así que no lo levanto como hallazgo propio; el rótulo
del formulario sí, porque afirma lo contrario de lo que el código hace.

---

## Lo que revisé y está bien

- **El cierre de FIS-C1 en el formulario del cliente es real y probado.**
  `src/lib/likida/perfil/onboarding.ts:19-22` y `:50-51`, con
  `onboarding.test.ts:75-118` cubriendo 601, 612, 624, 626, vacío y una clave
  inválida (`999` → `regimenElegible` ausente, no `false`: no se inventa un no).
  Medido con `parseOnboarding` real: mandar `regimen=si` junto con `regimenSat=601`
  produce `regimenElegible: false`.
- **FIS-A1 de la 28 (la corrección inerte del superadmin) está cerrado.**
  `repo.ts:1593-1619` escribe perfil (fuente) **y** config (legado) en el mismo
  camino, y `negocio.ts:459` **lee** con `facilidad15Vigente(t.perfil, cfg)` en vez
  del legado suelto. Los tres archivos de prueba nuevos
  (`facilidad15_fuente_unica.test.ts`, `…_desde_db.test.ts`, `…_tools.test.ts`)
  fijan el escenario exacto de la reincidencia con el config deliberadamente sin
  corregir.
- **La corrección de las fichas por texto literal se sostiene.**
  `rfa-2026-2.1.yaml:51` ya no afirma que la 2.2 y la 2.9 cubren pasaje/turismo, y
  el corpus se regeneró: corrí `corpus_texto.test.ts` y `normas_sincronizadas.test.ts`
  → **22 pruebas verdes**, es decir, ninguna ficha del corpus se ha separado de
  `normas/`.
- **El estímulo de IEPS de diésel sigue siendo litros y no pesos, que es lo
  correcto.** `engine.ts:1629` (`const iepsAcreditable = 0`, y es `const` a
  propósito), `:1756` (los litros solo con `MEDIOS_LISR_27_III`, que es
  exactamente el 4º párrafo transcrito en `lif-2026-20-A.yaml:114-123`), y
  `acreditable.ts:101-103` (`NOTA_LITROS_DIESEL`). La regla del rubro —«el IEPS
  trasladado del CFDI **no** es el estímulo»— está respetada y comentada donde se
  decide.
- **El guardia de litros contra el monto sigue vivo.** `engine.ts:1766-1777`:
  razón fuera de 0.5×–2× del precio de referencia → `diesel_desviacion` y **no**
  se acredita. Es lo que impide que un decimal corrido del OCR multiplique el
  estímulo por cien.
- **La base del estímulo de peaje es la que la regla ordena.**
  `engine.ts:1720-1721` (`(g.subTotal - g.descuento) * 0.5`) contra
  `normas/rmf-2026-9.1.8.yaml:31-34`, `verificado_fuente_primaria`, fr. IV: «se
  aplicará al importe pagado por concepto del uso de la infraestructura carretera
  de cuota, **sin incluir el IVA**, el factor de 0.5». Y `MEDIOS_ELECTRONICOS_PEAJE`
  (`engine.ts:256`) es la lista cerrada de la fr. III, sin `'02'` (cheque) — que
  no es un sistema electrónico de la autopista.
- **La leyenda que cita el permiso CRE cita bien.** `deducibilidad.ts:78` («LISR
  27-III y RFA 2026 regla 2.9 exigen que el CFDI de combustible consigne el permiso
  CRE vigente») — entré con la hipótesis de que era una cita prestada del CFF 29-A
  y **me refuté**: los dos textos lo dicen, `lisr-27-III.yaml:19-22` («en el
  comprobante fiscal deberá constar la información del permiso vigente, expedido
  en los términos de la Ley de Hidrocarburos») y `rfa-2026-2.9.yaml:17-21` (misma
  frase). No es hallazgo.
- **El 69-B está implementado del lado seguro.** `intake/sat.ts:80-84`: solo
  `200`/`201` son «limpio»; cualquier otro código cae en `efosDesconocido` (bandeja)
  y **nunca** en `efos: true`. Coincide con `cff-69-B.yaml`
  (`verificado_fuente_primaria`): el efecto de «no producen ni produjeron efecto
  fiscal alguno» es del listado **definitivo**, no del presunto. Es el archivo que
  llevaba tres rondas sin abrirse; está bien.
- **`MEDIOS_LISR_27_III` y `TOPE_EFECTIVO_LISR_27_III` no se movieron**
  (`engine.ts:126`, `:140`), y `0345:29-31` sigue siendo su espejo en SQL,
  incluido el `<> '99'` que la auditoría 26 puso.
- **El agente contador (`ejecutarContador`) no tiene llamador de producción** —
  solo el arnés de exámenes (`grep`: `hashPromptContador` en `admin/evals.ts:27`
  y nada más). Lo verifiqué porque tenía una hipótesis de hallazgo: el corpus del
  contador embebe `normas/datos/cuota-ieps-diesel.yaml`, cuya última semana cubre
  hasta el **2026-09-04** (hoy es 8-sep), y el prompt (`contador.ts:29-49`) **no
  lleva fecha**, así que un modelo preguntado por «la cuota de esta semana» no
  tiene con qué saber que la tabla está corta. Con el agente muerto en producción,
  **no es hallazgo hoy** — queda anotado como trampa armada para el día que se
  encienda. `cuotaDieselVigente` (`cuota_diesel.ts:131-135`) sigue fallando
  cerrado (devuelve `null` fuera de rango, nunca la última conocida) y tampoco
  tiene llamador de producción.
- **`fiscal.ts` degrada honesto cuando no puede leer el perfil.**
  `perfilBestEffort` (`:63-70`) atrapa y cae a `{}`, que es «sin perfil», no «no
  elegible». Es el criterio correcto para un camino informativo; el camino de
  cierre (`desde_db.ts`) sigue lanzando.

## Lo que NO alcancé a revisar

- **Nada que requiera base viva.** Sin `.env` ni Postgres no corrí las RPC 0345,
  0305, 0307, 0308, 0316 ni 0317 contra datos. Ninguno de los hallazgos de hoy la
  necesita: FIS-C1 y FIS-A1 están **medidos** con el motor y los helpers reales;
  FIS-M1, FIS-M2, FIS-B1 y FIS-B2 son cotejos de texto contra texto con
  `archivo:línea` citados.
- **Ningún render.** No levanté preview de `/admin/flotas` ni de
  `/dashboard/contador` (el MAPA prohíbe `npm run build` aquí): los dos hallazgos
  de pantalla se sostienen en el `archivo:línea` del `<select>` / del llamador y
  en la acción de servidor que consume su `name`, no en un screenshot.
- **`intake/cfdi.ts` sigue sin auditarse a fondo**, y su ficha de referencia
  (`cff-29-A`) es `evidencia_corroborante` con `texto_vigente: null`: **no
  verificable en esta ronda** por construcción. `intake/sat.ts` sí quedó cruzado.
- **La descarga masiva del SAT (`sat_descarga/`, mig. 0231) y `decidirCruce`**
  siguen sin auditar, cuarta ronda.
- **`rfa-2026-3.12` sigue sin ficha** (39 archivos, ninguno es 3.12), así que el
  cierre fail-closed de FIS-M1 de la 28 —una flota de pasaje/turismo ya no abre la
  2.9— deja abierto qué regla **sí** la alcanza. Es lo que hace latente a FIS-B2.
- **`rmf-2026-2.7.7` (Carta Porte, obligados y radio de 30 km),
  `criterios-imss-sbc` y `lss-27`** quedaron otra vez sin cruzar: el encargo pedía
  reverificar los abiertos primero y eso, más los dos cruces nuevos de peaje, se
  llevó la ronda.
- **`lisr-27-III` sigue en `evidencia_corroborante`** («NO se leyó en
  diputados.gob.mx»), igual que `lisr-28-XX`, `cff-29-A`, `rmf-2026-2.7.1.21`,
  `rmf-2026-2.7.1.48`, `rmf-2026-3.3.1.7` y `criterio-1-LIF-PI`. Es la deuda que
  fija el techo del rubro y no se movió en esta ventana.
