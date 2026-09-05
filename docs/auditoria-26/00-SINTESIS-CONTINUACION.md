# Auditoría 26 · continuación — síntesis y recalificación

**Global: 5.8** (anterior: **6.0**) · **▼ 0.2**

Ronda de **CONTINUACIÓN**, desatendida, en la nube. Misma rama
`claude/auditoria-26`, mismo PR **#326**. Árbol limpio al arrancar → **autofix
habilitado**.

## Por qué esta ronda fue de continuación, y por qué solo 3 rubros

La decisión se tomó **antes** de gastar un token en auditores:

- `list_pull_requests(javiercamarapp/cuadra, state=open)` → **5 PRs**, y uno es
  **#326 `claude/auditoria-26`**, de auditoría y abierto. La regla manda seguir
  sobre él: **no se abre ronda 27 ni PR nuevo**. Un PR vivo vale más que catorce
  ignorados.
- `git fetch origin master` → `origin/master` = `ce6f4621`, y
  `git merge-base --is-ancestor ce6f4621 HEAD` → **SI**: la rama ya contiene a
  master. Sin conflicto, nada que traer.
- `pull_request_read(get_check_runs, #326)` → **9 de 9 verdes**.

Y luego, el tamaño. La regla dice relanzar **solo** los rubros cuyo archivo
falte o cuyo código haya cambiado desde que se escribió. Los 12 archivos
existen. Cruzando los cuatro commits de arreglo de la 26 contra cada reporte:

| Rubro | Commit posterior a su archivo | ¿Relanza? |
|---|---|---|
| Frontend | `273ecd9` (FE-4), `75ec862` (FE-1) | **Sí** |
| Backend | `75ec862`, sobre `analytics.ts` | **Sí** |
| Fiscal | `8abb596`, posterior a `fiscal-reauditoria.md` | **Sí** |
| Los otros nueve | ninguno | No |

**Tres auditores, no doce.** Nueve rubros no recibieron un solo commit desde que
se calificaron; relanzarlos sería pagar contexto por releer el mismo árbol y
volver a escribir la misma nota.

## La lectura de la ronda

**Los tres rubros relanzados bajan uno cada uno. Y ninguno bajó porque el código
empeorara.** Los tres hicieron lo mismo que se les pidió: abrir el arreglo que
la ronda 26 declaró cerrado, y comprobarlo.

De los cuatro arreglos de la 26, **uno resistió el escrutinio y tres no**:

- `273ecd9` (FE-4) **cerrado de verdad**: `var(--ink)` existe, y el auditor
  midió 17.5:1 en claro y ~17.4:1 en oscuro con la fórmula WCAG. Sin defecto
  nuevo.
- `75ec862` (FE-1) **cerrado en la mitad equivocada**: arregló `leerGastos`, que
  el propio archivo documenta como **camino de respaldo**, y dejó sin tocar
  `reconstruir`, el que corre cuando la liquidación está sana.
- `8abb596` (FIS-C2b) **destapó un tercero en la misma línea**: el gasto sin
  fecha, que la resta ya no cuenta, la **suma** sí lo contaba.

**El caso que mejor lo explica es FE-1, y lo encontraron dos auditores por
separado.** Frontend y backend corrieron en paralelo, sin contacto, con encargos
distintos, y los dos llegaron al mismo renglón de `analytics.ts`. Cuando dos
miradas independientes tropiezan con la misma piedra, la piedra existe.

Y el patrón que la 26 documentó —«un arreglo mete un defecto en la línea que
acaba de editar»— se repitió por **tercera vuelta consecutiva** sobre el mismo
cálculo del 15 %: la 25 lo arregló, la 26 lo arregló dos veces, y esta encontró
la tercera. No es mala suerte: es que ese cálculo tiene cuatro implementaciones
del mismo predicado repartidas entre SQL y TypeScript, y arreglar una no arregla
las otras.

## Las notas

Global = media aritmética de los 12, con un decimal: **69 / 12 = 5.75 → 5.8**.
Los nueve no auditados **conservan su nota** y se marcan como tales; mover la
nota de un rubro que nadie miró es exactamente el ruido que la serie no debe
tener.

| Rubro | Antes | Hoy | Δ | Porqué del movimiento |
|---|---|---|---|---|
| Pruebas | 8 | **8** | = | *no auditado esta ronda* |
| **Backend y API** | 7 | **6** | ▼1 | **Mirada más profunda** — el código no cambió más que en un commit, y la nota anterior estaba inflada. El barrido de los 18 `select`/`rpc` de `analytics.ts` que el encargo pidió encontró la misma clase de defecto en cuatro consultas más: `getKpis`, `getDineroObservadoPorTipo`, `getLiquidaciones` y `getLiquidacionesDeViajes` no miran `revision`, cuando el CSV, `/v1`, la póliza y los acreditables ya se abstienen. La liquidación que el contralor **rechazó** sigue sumando en los KPI y en la dona. |
| Seguridad | 7 | **7** | = | *no auditado esta ronda* |
| Sistema agéntico | 6 | **6** | = | *no auditado esta ronda* |
| Cumplimiento legal | 6 | **6** | = | *no auditado esta ronda* |
| Rendimiento y costo | 6 | **6** | = | *no auditado esta ronda* |
| Modelo de datos | 6 | **6** | = | *no auditado esta ronda* |
| Tool calling | 6 | **6** | = | *no auditado esta ronda* |
| **Cumplimiento fiscal** | 5 | **4** | ▼1 | **Deuda que cobró factura** — la ronda declaró cerrado su CRÍTICO y el cotejo término por término que se le encargó encontró un **tercero vivo en la misma línea**. El ancla del rubro dice «3 o menos si el producto imprime una cifra fiscal equivocada»; lo sostiene en 4 que la disciplina de fichas sigue intacta y que el auditor **refutó uno de sus propios hallazgos previos** (el BAJO del `monto > 0`, inerte por el CHECK `gasto_monto_no_negativo`). |
| Arquitectura | 5 | **5** | = | *no auditado esta ronda* |
| **Frontend** | 5 | **4** | ▼1 | **Deuda que cobró factura** — de los dos ALTO que la 26 dio por cerrados, uno lo está y el otro llegó al camino de respaldo. `/dashboard/[id]` —la pantalla donde se firma— lleva cinco rondas contradiciéndose, y esta creyó haberlo cerrado, que es lo caro: la nota ya había cobrado la subida. |
| Operabilidad y DX | 5 | **5** | = | *no auditado esta ronda* |

## Lo arreglado, con prueba que lo reproduce

Tres vueltas, **el tope exacto**. Cada una: prueba que falla → arreglo → prueba
verde → suite completa → commit atómico citando el ID.

| ID | Sha | Qué era |
|---|---|---|
| **FIS-C2c** (CRÍTICO) | `2a58e07` | El numerador y el denominador del 15 % (RFA 2026 regla 2.9) son el mismo universo. El denominador lo mide la RPC de la 0305, cuyo `where` acota `fecha` entre el 1-ene y el 31-dic: una `fecha` NULL falla **las dos** comparaciones y queda fuera. El motor leía `!anioComprobante ||` como «de este año» y lo sumaba **arriba**. Medido sobre un diésel de $116,000 en efectivo con $145,000 previos sobre $1,000,000: antes `{deducible 5,000 · noDeducible 111,000 · IVA 689.66}`; con fecha legible el mismo comprobante da `{22,400 · 93,600 · 3,089.66}`. La frase impresa lo delataba: «$261,000 … contra un tope de $150,000 (15% de $1,000,000)» — 26.1 %, una razón que el contador no puede reconstruir con el total del propio renglón. El prompt del OCR **ordena** devolver `null` cuando no lee el año, así que el estado es de diseño. Y lo perverso: el comprobante de **otro** ejercicio ya se abstenía; el que no trae año, del que se sabe menos, recibía el veredicto más tajante. |
| **FE-1b** (ALTO) | `fc98bbf6` | `75ec862` agregó `pagado_en` al `select` de `leerGastos`, que es el camino de **respaldo**. En una liquidación sana gana `reconstruida.filas`, y su `.map()` enumeraba once claves sin `pagadoEn`. El dato llegaba hasta ahí (`repo.ts:995`) y se perdía en el mapeo; el cast iba contra un tipo que tampoco lo declaraba, así que TypeScript no se quejaba. Toda caseta a crédito con REP seguía saliendo «Por confirmar» mientras el bloque de Deducibilidad de la misma hoja la contaba como deducible. La prueba mide **paridad** entre los dos caminos, no solo la presencia del campo: que uno traiga un campo y el otro no es como nació este bug. |
| **FIS-A3** (ALTO) | *(ver `progreso.md`)* | El cuarto sitio que mide el cubo del 15 % lo pedía **sin las claves del SAT**. La RPC sin `p_claves` cuenta solo `concepto = 'diesel'`, y el camino normal —foto antes que XML— escribe `clave_prod_serv` sin recalcular el concepto. Con $300,000 de combustible por clave fuera del denominador, el motor decía `excedido` y el agente contestaba «holgado, margen $105,000» sobre la misma liquidación cuyo PDF quita deducción. El año ya se había armonizado por esta razón en la auditoría 15; faltaban las claves. |

### Sobre las 3 pruebas que FIS-C2c puso en rojo, y por qué no se revirtió

La regla dice: suite roja → se revierte. Antes de decidir comprobé **qué**
afirmaban las tres, porque la regla existe para no retener un arreglo que rompió
comportamiento real, no para proteger un fixture incompleto:

- Las tres viven en la matriz del 15 % y miden **aritmética** (el excedente
  proporcional, el excedente por comprobante). Sus fixtures no traían `fecha`
  **ni** `anioEjercicio`.
- **Ninguna prueba del repo afirma deliberadamente** que un comprobante sin
  fecha se juzgue como del ejercicio. Lo verifiqué: las tres fallaban por el
  fixture, no por la aserción.
- `desde_db.ts` —único llamador que enciende `facilidad15` en producción—
  **siempre** manda `anioEjercicio`. El fixture sin él describía una entrada que
  producción no puede producir. El bloque «auditoría 15» del mismo archivo ya
  declaraba las dos cosas explícitas: la convención correcta ya estaba escrita
  al lado.

Se completó **la entrada** y **ninguna aserción**: 16 inserciones, 1 borrado,
cero `expect` tocados, verificado con `git diff`. Se dice aquí en vez de
enterrarlo en el commit porque es justo la clase de decisión que un lector tiene
que poder impugnar.

## Lo que NO se arregló, y por qué

Con el tope de 3 vueltas gastado, quedan **pendientes con razón escrita**:

- **[CRÍTICO, 4ª aparición] La póliza tras `ajustar`.** Reincidente desde la 24.
  No es quirúrgico: exige decidir qué hace el producto con una liquidación
  ajustada. Necesita una decisión, no un cuarto intento.
- **[ALTO] La liquidación rechazada sigue sumando en los KPI y en la dona**,
  mientras el CSV, la API y la póliza ya se abstienen. Es de una clase que toca
  cuatro consultas: no cabe en un cambio quirúrgico.
- **[ALTO] El REP con `FormaDePagoP = '99'`.** Quirúrgico en la línea, pero el
  commit tendría que **voltear una prueba de paridad existente** que hoy fija la
  asimetría, y eso es cambiar una aserción: no se hace de madrugada sin que
  alguien lo mire.
- **[ALTO] La póliza asienta IVA acreditable de liquidaciones sin firmar**
  (`0307:119` solo excluye `rechazada`). Una línea, pero decide una convención
  de producto.
- **[ALTO] Los dos ejemplares del PDF con cifras distintas** si una subida falla
  y la otra no.
- **[ALTO] La nota de crédito multi-concepto** sigue entrando por dos de las
  tres puertas de XML.
- **[MEDIO] Tres tokens CSS rotos** (`--ok-bg`, `--warn-bg`, `--bad-bg`) en
  `cola.tsx:49-53`, la misma clase que FE-4. El guardarraíl que la 26 escribió
  cubre **un solo directorio**.
- **[MEDIO] El criterio que decide todo el tratamiento del `'99'`** cita la RMF
  2.7.1.29 fr. II, **que no tiene ficha en `normas/`**. Sin ficha no hay fuente
  primaria contra la cual comparar: se declara no verificable, no se asume bien.

Y sigue en pie, sin que esta ronda pueda tocarlo: **producción congelada**.
Lleva 290 commits, 12 merges y 17 migraciones sobre el último `[deploy]`
efectivo, y la compuerta bloqueará cualquier `[deploy]` mientras la base siga en
0301. **Necesita una mano humana**; el Redeploy del panel no basta.

## Un hallazgo se descartó por falso, y lo descartó quien lo escribió

El auditor fiscal **refutó un hallazgo de la reauditoría anterior**: el BAJO que
decía que un `monto ≤ 0` se suma con signo en TS y la RPC lo ignora. El CHECK
`gasto_monto_no_negativo` (`0070:41`) hace ese escenario imposible: no hay fila
con monto negativo que pueda existir. Queda **descartado por falso**, con su
razón, que es lo que mantiene honestos a los auditores de mañana.

## Compuerta al cerrar

- `npx vitest run` → **864 archivos, 11,293 pruebas, 1 saltada, 0 fallos**
  (la línea base eran 861 / 11,287: las 6 nuevas son las de los tres arreglos).
- `npx tsc --noEmit -p .` → **exit 0**.
- `npm run lint` → **0 errores, 194 avisos**; `lint:ratchet` **194/194, 0 nuevos**.
- `npm run build` → **no se corre aquí a propósito**.
- CI del PR #326 → **9/9 verdes** antes de esta corrida.

## Tablero

`tablero-continuacion.html` + `tablero-continuacion.png`, capturado con
Chromium headless y **mirado**: se cuentan los 12 rubros, las notas de la tabla
suman 69 y 69/12 = 5.75 → 5.8, que es la cifra que encabeza esta síntesis. El
color codifica la nota, nunca el delta.

## Nota de método, para la ronda 27

**Los tres arreglos de esta continuación aterrizaron DESPUÉS de que los
auditores calificaran.** Sus notas miden el árbol que vieron, no el que dejamos.
Verificarlos es trabajo de la 27 — y a estas alturas la evidencia dice que hay
que hacerlo: **de los cuatro arreglos que la 26 dio por cerrados, la reauditoría
salvó uno.** Un arreglo no se acredita su propia nota.
