# Arquitectura y mantenibilidad — auditoría 26

**Nota: 5/10** (antes 4). Razón del movimiento: **el código cambió**. De los 8
hallazgos abiertos que me tocaban, **6 están cerrados de verdad** —los abrí uno
por uno y corrí sus pruebas—, 1 quedó cerrado a medias y 1 es reincidente y
además creció. El CRÍTICO de la 25 (la proporción de LIVA 5 fr. I en tres
sitios, el tercero con la mitad de las reglas) **ya no existe en esa forma**:
`fiscal.ts:530` **importa** `proporcionesDeducibles` del motor en vez de
reinventarla.

No sube a 6 porque el ancla del rubro sigue tocada: **el panel y el PDF todavía
imprimen dos cifras distintas de IVA acreditable sobre el MISMO comprobante** —
ya no por $16,000 contra $0, sino por la diferencia entre una asignación por
comprobante y una aproximación agregada que el comentario del propio archivo
declara exacta. Lo medí corriendo los dos módulos reales: $15,900.38 contra
$17,496.81.

**El riesgo mayor del rubro, hoy:** «¿qué liquidaciones sostienen el IVA
acreditable del mes?» tiene **tres respuestas** dentro del producto —el panel,
la póliza contable y el reporte que se le manda al cliente— y la tercera afirma
por escrito ser la primera.

> **Método, y una advertencia para quien verifique estas líneas.** Todas las
> citas `archivo:línea` están comprobadas contra **`ce6f462` (HEAD)**, no contra
> el árbol de trabajo: a media ronda otro proceso empezó a mutar
> `cuadre/engine.ts` y `cuadre/desde_db.ts` (`git status` arrancó limpio y
> terminó con dos `M` y un `.test.ts` sin seguir). Releí `git show
> HEAD:cuadre/engine.ts` y confirmé que mis nueve citas de ese archivo coinciden
> al número. La mutación que vi es un refactor que extrae `formaPagoJuzgableDe`
> sin cambiar el comportamiento sobre los comprobantes `'01'` de mi medición.
>
> Las dos cifras del hallazgo ARQ-26-1 no las razoné: las **medí**, montando un
> vitest fuera del repo (config propia en el scratchpad, alias `@` → `src/`) que
> llama `resumirFiscal` y `cuadrarViaje` reales. No edité un solo archivo del
> repo fuera de este entregable.

---

## Hallazgos

### [ALTO] El agregado del 15% del panel NO reproduce al motor cuando el IVA no es uniforme, y el comentario que lo introduce afirma que sí — medido (REINCIDENTE PARCIAL del CRÍTICO de la 25, commit `0e4c0d7`)

`src/lib/likida/fiscal.ts:524-535` (`proporcionCombustible15`: UNA proporción
agregada del ejercicio) ·
`src/lib/likida/fiscal.ts:508-522` (el comentario que afirma «*da la MISMA
proporción agregada que sumar el resultado real del motor viaje por viaje —
exacta cuando `gastos` cubre el ejercicio completo*») ·
`src/lib/likida/fiscal.ts:1077` y `:1097-1100` (dónde se aplica: la misma
proporción a TODOS los comprobantes) ·
`src/lib/likida/cuadre/engine.ts:766-772` (la asignación real: `tope`,
`cupoRestante`, `dentro`, `proporcionDeducible.set(g.id, dentro / g.monto)` —
**por comprobante y por orden de cierre**) ·
`src/lib/likida/cuadre/engine.ts:1615` y `:1636`
(`ivaAcreditable += ivaTraslado * proporcion`) ·
`src/lib/likida/fiscal_combustible15.test.ts:63-96` (la prueba que ata los dos
usa **dos comprobantes idénticos**, que es justo el único caso en el que la
identidad se cumple)

**Escenario, con valores, medido.** Flota elegible (`elegible15: true`),
ejercicio 2026 con **$1,000,000** de combustible (tope del 15% = **$150,000**) y
**dos CFDI de diésel pagados en EFECTIVO ('01')**, de $100,000 cada uno, con
tasas de IVA distintas —una flota fronteriza compra en Tijuana al 8% y en el
centro al 16%, que es el caso normal del decreto de región fronteriza—:

- `g1`: subtotal $86,206.90 + IVA 16% $13,793.10 = **$100,000.00**
- `g2`: subtotal $92,592.59 + IVA 8% $7,407.41 = **$100,000.00**
- Efectivo del ejercicio: **$200,000**; excedente sobre el tope: **$50,000**.

| Quién | IVA acreditable | Cómo |
|---|---|---|
| Panel del contador (`resumirFiscal`) | **$15,900.38** | proporción única 150,000/200,000 = 0.75 aplicada a los dos |
| PDF/motor, si `g1` cerró primero | **$17,496.81** | `g1` cabe entero (proporción 1), `g2` al 50% |
| PDF/motor, si `g2` cerró primero | **$14,303.96** | al revés |

Entra: **dos CFDI de diésel en efectivo por $200,000** → sale **$15,900.38 en la
pantalla y $17,496.81 (o $14,303.96) en los PDF**, sobre el mismo ejercicio y la
misma regla. La brecha es **$1,596.43**, y en el orden B el panel acredita **de
más**, que es el lado caro y el que motivó el arreglo entero.

La identidad que el comentario invoca —«la suma de `dentro_i` es siempre
`min(efectivo, tope)`»— es cierta **para el monto deducible** y falsa **para el
IVA**: el IVA acreditado es `Σ ivaTraslado_i × proporcion_i`, y eso solo iguala
`p_agregada × Σ ivaTraslado_i` si el cociente IVA/monto es el mismo en todos los
comprobantes en efectivo. Basta una tasa fronteriza del 8%, o un CFDI de
combustible sin desglose de IVA (`conCfdiSinDesglose` es un KPI del propio
`resumirFiscal`), para romperla. Con `ivaTraslado: null` en `g2` la brecha
medida sube a **$3,448.27**.

**Consecuencia.** El contralor teclea en su declaración la cifra de la pantalla
y archiva el PDF con otra. Es exactamente la falla que la 25 declaró CRÍTICA,
reducida en magnitud pero no eliminada: cambió de «acredita el 100%» a «acredita
una aproximación cuyo comentario dice que es exacta».

**Intento de refutación.** Lo busqué y hay defensas reales, y por eso es ALTO y
no CRÍTICO: (a) `fiscal.ts:530` **reusa** la función del motor en vez de
copiarla —la mitad estructural del hallazgo sí se cerró—; (b) sin acumulado del
ejercicio falla cerrado (`return 0`, `fiscal.ts:525`); y (c)
`combustible15SujetoADeriva` (`fiscal.ts:925` y `:1152`) ya avisa que esta cifra puede no
coincidir con un PDF archivado. Lo que ese aviso dice es «puede haber cambiado
el acumulado desde que se firmó»; **no** dice «esta cifra es una aproximación
ponderada que no reproduce el reparto del motor ni con el acumulado de hoy», que
es lo medido aquí.

**Causa raíz probable:** la asignación del motor depende del ORDEN de cierre de
los viajes, y ninguna función agregada del ejercicio puede reproducir una
asignación que depende del orden — el arreglo eligió la única forma que no puede
ser exacta y la documentó como exacta.

---

### [ALTO] «¿Qué liquidaciones sostienen el IVA acreditable del mes?» tiene tres respuestas, y la tercera afirma por escrito ser la primera

`supabase/migrations/0308_acreditables_solo_firmadas.sql:50`
(`and revision in ('aprobada','ajustada')` — lo que alimenta el tile «IVA
acreditable de tus liquidaciones») ·
`supabase/migrations/0316_gastos_fiscales_agregados_solo_liquidacion_firmada.sql:82`
(el mismo criterio para el panel fiscal) ·
`src/lib/likida/fiscal.ts:946` (`if (!g.liquidacionFirmada) return false;`) ·
`supabase/migrations/0307_poliza_y_viaje_respetan_rechazada.sql:59` y `:119`
(`'ivaAcreditable', coalesce(l.iva_acreditable, 0)` … `and l.revision <>
'rechazada'` — **incluye `pendiente`**) ·
`src/lib/likida/contabilidad/poliza.ts:175-184` (lo asienta como CARGO a la
cuenta de IVA acreditable) ·
`src/app/api/export/poliza/route.ts:299` y `:348` (la ruta no agrega ningún
filtro de `revision`; lo verifiqué con `grep -n revision` sobre el archivo: cero
resultados de filtrado) ·
`src/lib/likida/agentes/exito.ts:679` y `:686-691` (`leerValorDelMes`:
`from('liquidacion').select('… iva_acreditable …')` con `tenant_id` y rango de
fechas, **sin una sola cláusula sobre `revision`**) ·
`src/lib/likida/agentes/exito.ts:654` (el rótulo que dice «*la misma columna que
la RPC `acreditables_liquidacion_tenant`*»)

**Escenario.** Un mes con 100 liquidaciones de una flota, cada una con
`iva_acreditable = $16,000`: **60 aprobadas, 10 ajustadas, 25 pendientes de
firma, 5 rechazadas**.

- `/dashboard/contador`, tile «IVA acreditable de tus liquidaciones»
  (`getAcreditables` → RPC 0308): **70 × 16,000 = $1,120,000**.
- `/api/export/poliza` (el archivo que el contador importa a CONTPAQi): **95 ×
  16,000 = $1,520,000** cargados a la cuenta de IVA acreditable — las 25
  pendientes entran.
- El reporte «VALOR — <flota> — <mes>» del agente de Éxito
  (`armarReporteValor`), que es un borrador para mandarle **al cliente**: **100 ×
  16,000 = $1,600,000**, con las 5 rechazadas dentro, y con la leyenda que
  afirma ser la misma columna que la RPC.

Entra: **el mismo mes de la misma flota** → salen **$1,120,000, $1,520,000 y
$1,600,000**, las tres bajo el rótulo «IVA acreditable».

**Consecuencia.** La póliza asienta en la contabilidad de la flota $400,000 de
IVA acreditable que el propio producto declara no acreditable todavía —el
comentario de la 0308 lo dice literal: «*una rechazada o pendiente no sostiene
todavía el requisito de deducibilidad de LIVA 5-I*»—. Y el correo que Javier le
manda al cliente lleva una tercera cifra que el panel del cliente no va a
reproducir nunca.

**Intento de refutación.** Busqué el guardarraíl. La 0307 SÍ razona el filtro
(`<> 'rechazada'`, «*el MISMO criterio que api/export/liquidaciones*») y es
coherente con el CSV de tesorería; el problema es que ese criterio se copió del
**listado** (qué liquidaciones enseñar) al **asiento contable** (qué IVA
acreditar), que es la pregunta que la 0308 contestó distinto tres migraciones
después. `leerValorDelMes` no tiene ninguna defensa: ni filtro ni advertencia, y
su propio texto asegura la equivalencia. Tampoco es un caso vacío: la 0299 creó
`revision` precisamente porque «pendiente» es el estado normal de una
liquidación recién cerrada.

**Causa raíz probable:** `revision` (0299) se propagó tabla por tabla y consulta
por consulta, sin un solo predicado exportado que diga «esta liquidación
sostiene dinero»; cada migración eligió su cláusula a mano y la 0307 llegó antes
que la 0308.

---

### [BAJO · REINCIDENTE PARCIAL] `estadoRenglon` sigue siendo la única reconstrucción de `cubetaDe` que no llama a `cubetaDe`: el commit `74109dd` importó el tercer criterio y dejó el cuarto

`src/app/dashboard/[id]/vista.tsx:199-221` (`estadoRenglon`) ·
`src/app/dashboard/[id]/vista.tsx:215` (`if (pagoPendiente(g))` — lo que sí
entró en `74109dd`) ·
`src/lib/likida/cuadre/engine.ts:443-456` (`cubetaDe`, **cuatro** criterios; el
cuarto es `if (!g.cfdiUuid) return 'por_confirmar'`) ·
`src/lib/likida/config.ts:94` (`{ concepto: 'diesel', topeMonto: 4000 }` — sin
`requiereCfdi`, así que el motor NO emite `sin_cfdi` para un diésel sin factura) ·
`src/app/dashboard/[id]/detalle.tsx:364` (dónde se pinta)

**Escenario.** Ticket de diésel de **$3,800** fotografiado en la bomba (bajo el
tope de $4,000 de la política), sin CFDI, sin forma de pago capturada:

- `cubetaDe` → cuarto criterio → `'por_confirmar'`; `totalPorConfirmar +=
  3,800` y el bloque de deducibilidad de la MISMA pantalla imprime «Por
  confirmar $3,800.00».
- `estadoRenglon(g, [])`: `TIPOS_MALOS` no; captura no; `tipos.includes('sin_cfdi')`
  **no** (el motor no la emitió: la política del diésel no exige CFDI);
  `TIPOS_TOPE` no; `TIPOS_POR_CONFIRMAR` no; `tipos.length > 0` no;
  `pagoPendiente` no (la forma de pago no es `'99'`); `estadoSat` no es
  `'vigente'`; `cfdiValido` falsy; `cfdiUuid` ausente → **`{ estado: 'neutral',
  etiqueta: 'Ticket' }`**.

Entra: un ticket de $3,800 → la pastilla del renglón dice «Ticket» en gris
neutro mientras el bloque de arriba de la misma hoja dice «Por confirmar
$3,800.00».

**Consecuencia.** Ya no es la pastilla verde con palomita de la 25 —eso sí se
arregló— y por eso baja a BAJO. Lo que queda es el mecanismo: la pantalla sigue
reconstruyendo la cubeta con seis condiciones propias en vez de llamar a la
función que `engine.ts:429-430` declara «LA ÚNICA definición… vive aquí,
exportada, para que nadie la reconstruya». Los otros tres consumidores
(`liquidacion/pdf.ts:442`, `analytics.ts:1591`,
`api/export/poliza/route.ts:174`) sí la llaman.

**Causa raíz probable:** el arreglo cerró el caso del hallazgo (forma '99') en
vez de cerrar la reconstrucción; el cuarto criterio nunca estuvo en el escenario
que se citó.

---

### [BAJO · REINCIDENTE, quinta ronda seguida — y esta vez CRECIÓ] `procesarTurno` pasó de 3,096 a 3,140 líneas

`src/lib/likida/processor.ts:1316-4455`. Lo medí con un barrido de columna 0:
entre la línea 1316 (`async function procesarTurno(...)`) y la 4455 (el `}`
final del archivo) **no hay ninguna otra declaración de nivel superior**.
4455 − 1316 + 1 = **3,140**. El archivo entero son 4,455 líneas.

**Escenario.** No es un bug de hoy, es el costo de cambiar: el 100% del producto
entra por esta función, y los +62 líneas que la ronda le metió
(`git diff --stat 4f94490..HEAD -- src/lib/likida/processor.ts`) se revisaron
dentro de un bloque que no cabe en pantalla ni se puede probar por partes.

**Consecuencia.** La serie es 2,913 (c23) → 3,096 (c24) → 3,096 (c25) → **3,140
(hoy)**. Cinco rondas señalándolo, cero pasos extraídos, y la primera vez que
crece desde la 24.

**Lo honesto:** busqué adentro lo que la 25 no alcanzó a mirar —una tercera
copia de una regla de dinero— y **no la hay**: `grep -n
"totalComprobado\|ivaAcreditable\|round2(\|0\.16"` sobre `processor.ts` da cero
resultados. El turno orquesta; no calcula pesos.

---

### [BAJO] El encabezado de `revision.ts` declara dos contratos que su propio archivo ya rompe

`src/lib/likida/revision.ts:9` («*Este archivo es el ÚNICO lector/escritor de
`liquidacion.revision` en la app*») ·
`src/lib/likida/revision.ts:18-20` («*La escritura NO re-cuadra… Un segundo
motor de cuadre en SQL o aquí sería «dos cálculos» (CLAUDE.md)*») ·
`src/lib/likida/revision.ts:30` (importa `recalcularParaAjuste`) y `:439` (lo
llama) ·
`src/lib/likida/revision_recalculo.ts:96` (`await cuadrarDesdeDB(...)` — la
escritura SÍ re-cuadra desde `d914e74`) ·
`src/app/api/export/liquidaciones/route.ts:122-124` y
`src/app/api/v1/liquidaciones/route.ts:139-141` (los otros dos lectores de la
columna, con su propio `if/else if` sobre `revision`)

**Escenario.** Un autor nuevo abre `revision.ts` para agregar un cuarto filtro
de revisión al CSV. El encabezado le dice que este archivo es el único sitio que
toca la columna, así que lo agrega aquí y termina — y el `else if (rev.filtro
=== …)` de las dos rutas se queda sin la rama nueva, que es exactamente cómo
nació el hallazgo de `?revision=` que la 25 levantó y que `da8d05e` acaba de
cerrar. Y si abre el archivo para ver si un ajuste recalcula el desglose fiscal,
el encabezado le dice que NO y la línea 439 hace que sí.

**Consecuencia.** No mueve una cifra hoy, y por eso es BAJO. Es la misma forma
del hallazgo abierto de `repo_paginado.ts` —un encabezado que dejó de describir
su archivo—, en el archivo que declara el contrato de la firma de dinero. El de
`repo_paginado.ts` **sí se cerró** esta ronda (ver abajo); este nació en su
lugar.

**Causa raíz probable:** `d914e74` (BE-C1a/BE-C1b) agregó la mitad que re-cuadra
sin releer las 20 líneas de encabezado que la prohibían.

---

### [BAJO] La consolidación de `ROL_LABEL` dejó una quinta copia del mismo dominio, y el barrido que la protege solo mira el nombre

`src/lib/auth/provisionar.ts:36` (`ROL_LABEL: Record<RolAppUser, string>`, la
única, exhaustiva) ·
`src/lib/auth/rol_label_unico.test.ts:21` (el barrido:
`grep -rlnE '(const|let) ROL_LABEL' src` — **casa por NOMBRE**) ·
`src/app/dashboard/chrome.tsx:29-35` (`ROL_BADGE: Record<string, string>`, los
mismos cinco roles del mismo dominio, sin tipar) y `:107`
(`ROL_BADGE[rol] ?? rol.toUpperCase()`) ·
`src/lib/likida/firma_atada_a_timbra.test.ts:28` (una sexta enumeración del
dominio, tecleada a mano dentro de una prueba)

**Escenario.** Entra un sexto rol por migración (digamos `auditor`, como entró
`vendedor` en la 0105). Se agrega a `RolAppUser` → `tsc` se pone rojo en
`provisionar.ts` y obliga a poner el rótulo: el mecanismo funciona. **Nunca
menciona `chrome.tsx`**: el sidebar de ese usuario imprime «AUDITOR» (la clave
cruda en mayúsculas) mientras `/admin/equipo`, `/dashboard/mi-perfil` y
`/dashboard/sesiones-mcp` imprimen el rótulo bueno. Es literalmente lo que le
pasaba a `vendedor` antes de `f128cd1`, en el único archivo que el arreglo no
tocó.

**Consecuencia.** No mueve una cifra. Es el costo de cambiar, y sobre todo es la
lección del guardia anterior repetida: `acotada_guardiana.test.ts` murió por ser
una lista literal, y este barrido es una lista literal de UN nombre. Un mapa que
enumera un dominio de la base y no está tipado contra él vuelve a caer.

**Causa raíz probable:** el arreglo consolidó por nombre (`ROL_LABEL`) en vez de
por forma (`Record<…, string>` sobre el dominio de `app_user.rol`), y el barrido
heredó el mismo criterio.

---

## Los ocho hallazgos abiertos de la 25, verificados uno por uno

| # | Hallazgo | Veredicto hoy | Prueba que lo sostiene |
|---|---|---|---|
| CRÍTICO | Proporción de LIVA 5-I en tres sitios, el tercero con `?? 1` | **CERRADO** en su forma; queda ARQ-26-1 | `fiscal.ts:49,530` importa `proporcionesDeducibles`; `fiscal_combustible15.test.ts` verde |
| ALTO | `estadoRenglon` verde con palomita | **CERRADO**; queda un residuo BAJO | `vista.tsx:215` llama `pagoPendiente`; `estado_renglon.test.ts` verde |
| ALTO | Las dos salidas de `?revision=` | **CERRADO** | vocabulario único en `revision.ts:48-75`; `periodo.ts:76-82` y `v1/liquidaciones/route.ts:117` lo importan |
| ALTO | Nada ata `FIRMA` con `TIMBRA` | **CERRADO** | `firma_atada_a_timbra.test.ts` recorre el dominio de rol; corrida, verde |
| MEDIO | Qué papel vence antes, dos anclas de día | **CERRADO** | `operacion.ts:194` llama `papelMasProximo`; default `hoyMx()` |
| MEDIO | La compuerta cotejaba máximo contra máximo | **CERRADO** | `migracion.ts:42-53` declara `aplicados` y `:83` lo arma; `compuerta-deploy.mjs:125-136` coteja CONJUNTO; 149 pruebas de `scripts/` verdes |
| BAJO | `procesarTurno` en 3,096 líneas | **REINCIDENTE, y creció a 3,140** | medido arriba |
| BAJO | `repo_paginado.ts` rompe su contrato | **CERRADO** | `repo_paginado.ts:280` `if (errOp) throw`; encabezado `:16-21` reescrito para declarar la excepción |
| BAJO | Cuatro `ROL_LABEL` + `PILL_ESTATUS` privado | **CERRADO**; queda `ROL_BADGE` (BAJO arriba) | `rol_label_unico.test.ts` + `pill_estatus_unico.test.ts` verdes |

---

## Lo que revisé y está bien

- **El motor sigue puro, medido transitivamente.** `cuadre/engine.ts:11-22`
  importa 10 módulos; abrí los diez y ninguno tiene `supabase`, `fetch(` ni
  `node:*`. `formato.ts:141` sigue siendo un comentario, no un import.
- **La frontera de datos está EXACTAMENTE en su techo.** Reimplementé el barrido
  de `frontera_datos_guardiana.test.ts:66-80` fuera de vitest sobre el árbol
  integrado: **252 de 252**. Con 124 commits y 199 archivos tocados, ni un
  módulo nuevo con `.from(`/`.rpc(` se coló sin declararse. Es el guardia que
  mejor aguantó la integración.
- **Las dependencias que apuntan al revés siguen siendo dos, las mismas.**
  `likida/oficina_wa.ts:7` → `@/app/api/dashboard/chat/tope` y
  `lib/mcp/credencial.ts:20` → `@/app/api/v1/_comun`. No nacieron terceras.
- **`REVISAR` sigue DERIVADA** (`engine.ts:426`) y `contencion_listas.test.ts`
  sigue exigiendo las contenciones entre las cinco listas. Corrida: verde.
- **`otro: 'Gasto'` / `otro: 'Otro'` —el ejemplo canónico— sigue cerrado por
  mecanismo.** `etiquetas_sincronizadas.test.ts` barre todo `src/` por PATRÓN.
  Corrida: verde.
- **La numeración de migraciones sobrevivió a tres renumeraciones en paralelo.**
  `ls supabase/migrations | grep -oE '^[0-9]{4}' | sort | uniq -d` → **vacío**:
  296 archivos, 0 prefijos chocados, pese a `7127752` (0316→0318) y `f2f1486`
  (0305→0308). El `NUMERACION-SALTADA.md` solo documenta 3 de los 22 huecos
  reales, pero eso ya no importa para la puerta: desde `a0ef2b4` la compuerta
  coteja el CONJUNTO de prefijos del repo, no el máximo.
- **La consolidación de la puerta `/api/admin/*` es real.** `lib/auth/api-superadmin.ts`
  es la única implementación y las cuatro familias (copiloto, mapa-prospectos,
  palette, qa) la importan —directo o por su `puerta.ts` de reexport—. No quedó
  una quinta copia del chequeo.
- **La paridad SQL↔TS de la 0317 está hecha con la disciplina correcta**: el
  umbral (`UMBRAL_RENGLONES_AJENOS`) y el patrón (`SENAL_BAR`) se **importan de
  `engine.ts` y se pasan como parámetros** (`fiscal.ts:1634-1639`), y la
  traducción `\b` → `\y` está hecha y comentada —Postgres ARE lee `\b` como
  BACKSPACE, así que sin esa línea `consumoBar` sería siempre falso en el panel y
  verdadero en el motor. Fui a buscar aquí un hallazgo y el hueco ya estaba
  tapado.
- **`getAcumuladoCombustible` es reuso de verdad, no una segunda barrida.** El
  panel (`fiscal.ts:487`), el motor (`desde_db.ts:128`) y la tool de periodo
  (`tools.ts:200`) llaman la MISMA función y la MISMA RPC (`sumar_combustible_
  ejercicio`, 0305, con la forma de pago EFECTIVA en SQL).
- **`lunesDe` vive en 7 archivos y NO ha divergido.** Los verifiqué uno por uno:
  `backoffice.ts:109` ancla a `T00:00:00Z` y los otros seis a `T12:00:00Z`, pero
  sobre un string `YYYY-MM-DD` en UTC las dos anclas dan la misma fecha. La
  duplicación está justificada por escrito (no arrastrar árboles de import al
  runner). No lo reporto porque no pude construir el escenario con valores que
  este rubro exige — pero es el candidato más probable del próximo ciclo.
- **`revision_recalculo.ts` no reimplementa el motor**: llama `cuadrarDesdeDB` y
  no prorratea `sub_total`/`iva_traslado` a mano. Es el contraejemplo bueno del
  rubro en un archivo nuevo.

---

## Lo que NO alcancé a revisar

- **`sat_descarga/*` contra `facturacion/*`** — dos módulos sobre el mismo
  dominio de comprobantes, sin comparar sus lectores de CFDI entre sí. Pendiente
  desde la 24; `sat_descarga/ciclo.ts` creció +105 líneas esta ronda y no lo
  abrí.
- **`lib/mcp/herramientas/*` contra `/v1/*`.** Verifiqué `dinero.ts` (usa
  `opcionesFiscalesDelPeriodo`, correcto) y `unidades.ts` (hereda el default
  `hoyMx()` ya arreglado). NO crucé `viajes.ts` ni `busqueda.ts` contra sus
  gemelos de `/v1`.
- **Las 15 migraciones nuevas (0304-0318) leídas de punta a punta.** Abrí 0305,
  0307, 0308, 0316 y 0317 por lo que tocaban a mis hallazgos; no crucé qué
  funciones redefine `create or replace` entre 0304 y 0318 —el accidente que la
  24 encontró en 0283/0299 y que `a864b9d` volvió a encontrar en la 0317 de esta
  misma ronda—. `supabase/verificaciones.sql` (292 bloques) no lo abrí.
- **Un detector de clones por contenido.** Corrí uno por NOMBRE de símbolo
  exportado sobre todo `src/` y trabajé los ~15 candidatos con semántica de
  dominio (`lunesDe`, `masDias`, `diasEntreIso`, `codificarCursor`,
  `ROL_BADGE`, `PILL_ESTATUS`, `TOPE_EFECTIVO`, `esCombustible`…). Los que
  comparten estructura sin compartir nombre —las 4 `forma.tsx` que la 24
  marcó— siguen sin evaluarse.
- **`procesarTurno` por dentro, línea por línea.** Medí su tamaño y descarté por
  grep que tenga aritmética de dinero; no leí sus 3,140 líneas.
- **Nada que requiera base viva.** Los conteos de las tres respuestas del
  hallazgo ARQ-26-2 son aritmética sobre las cláusulas SQL leídas, no filas
  contadas: la base está en cero y no hay credenciales en esta ronda.
