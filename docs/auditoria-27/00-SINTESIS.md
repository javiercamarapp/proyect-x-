# Auditoría 27 — síntesis y recalificación

**Global: 5.4** (anterior: **5.8**) · **▼ 0.4**

Ronda **COMPLETA**, desatendida, en la nube. Rama `claude/auditoria-27` sobre
`origin/master` = `06b2eca4`. Árbol limpio al arrancar → **autofix habilitado**.

## Por qué esta ronda fue completa

La decisión se tomó **antes** de gastar un token en auditores:

- `list_pull_requests(open)` → **6 PRs**, ninguno de auditoría (#338/#329/#324
  `dof-diario`, #330/#327 `normativa`, #328 `cuota-diesel`). El PR de la ronda
  anterior, **#326**, está cerrado y mergeado (`merged_at` 2026-09-05T23:08:25Z;
  `git merge-base --is-ancestor a3c1560 origin/master` → SI). **No aplica la
  regla de continuación.**
- `git log a3c1560..origin/master -- src/ supabase/ normas/` → **181 commits,
  346 archivos, +27,031/−2,631**. **No aplica la ronda ligera.**

## La lectura de la ronda

**Nueve de los doce rubros no recibieron un solo commit desde que se
calificaron, y la nota bajó igual.** Ese es el resultado de esta ronda y merece
decirse sin adornos: los 181 commits se concentraron en fiscal, póliza,
analytics y seguridad, y **eso se nota** —fiscal reporta siete cierres
verificados de verdad, seguridad sube a 8, datos a 7—, pero cuatro rubros bajan
porque llevan una ronda entera sin que nadie los toque mientras sus hallazgos
siguen vivos. `rendimiento` lo midió con precisión: **en 181 commits no se tocó
ni una línea de los diez archivos que la 26 dejó abiertos** (`git diff --numstat
a3c1560..HEAD`: los diez, sin cambios).

**Y por primera vez en cuatro rondas, el trabajo de arreglo del ciclo anterior
resistió el escrutinio.** El auditor fiscal abrió los siete puntos que se le
mandaron verificar —`2a58e075`, `8c72f7bd`, `6cbac00f`, `f85e68f3` ×2,
`42f93f91`, `80692404`— y los siete cerraron de verdad, incluida la ficha
`normas/rmf-2026-2.7.1.29.yaml` que la 26 declaró no verificable y hoy está
`verificado_fuente_primaria`. La 26 salvó uno de cuatro; la 27 salva siete de
siete. Eso es lo que sostiene a fiscal en 4 en vez de bajarlo.

**Lo que no cambió es la forma del problema.** El CRÍTICO fiscal nuevo está otra
vez en el cubo del 15 %, por **quinta vuelta consecutiva**, y otra vez por la
misma causa estructural que `arquitectura` nombró por su nombre: *«la regla "una
foto repetida no es un gasto" vive en once archivos de TypeScript y en cero de
los dos agregados SQL, y el cubo del 15 % se mide con los dos a la vez»*. No es
mala suerte cuatro veces seguidas: es una arquitectura que garantiza que cada
arreglo deje una copia sin arreglar.

**Dos auditores independientes encontraron el mismo CRÍTICO.** `agentico` y
`rendimiento` corrieron en paralelo, sin contacto, con encargos distintos, y los
dos llegaron a `intake/rep.ts:190-241`: `ingerirRep` sin reloj. Cuando dos
miradas independientes tropiezan con la misma piedra, la piedra existe — y el
auditor de rendimiento además **corrigió la aritmética de la 26**: el corte llega
a los 63 doctos, no a los 95.

**El hallazgo que más cambia la operación no lo trajo ningún auditor de código,
sino el de operabilidad, y explica todos los demás:** la alarma que debía
denunciar que producción lleva 224 commits congelada **se cerraba sola en cada
push a `master`**. Por eso nadie se enteró. Ese fue el arreglo de la ronda.

## Las notas

Global = media aritmética de los 12, con un decimal: **65 / 12 = 5.42 → 5.4**.

| Rubro | Antes | Hoy | Δ | Porqué del movimiento |
|---|---|---|---|---|
| **Seguridad** | 7 | **8** | ▲1 | **Se atacó y subió.** Único rubro que sube por trabajo hecho: los cierres que la 26 acreditó aguantaron al reabrirlos, y los commits nuevos (redacción de datos sensibles en logs, destino de conectores en TLS, host exacto de Meta, filtros sin setters de prototipo) resisten el caso adversarial. 0 críticos, 1 alto. |
| **Modelo de datos** | 6 | **7** | ▲1 | **Se atacó y subió.** El auditor **no pudo escribir un solo escenario «entra X → sale Y mal» con dinero**: dominios, unicidades, `liquidacion_diferencia_cuadra` y FK compuestas con tenant están puestos, y la 0339 cerró y **validó** las dos que la 0319 omitió. Reportó además **7 auto-refutaciones** documentadas — el tipo de honestidad que sostiene una nota alta. |
| **Pruebas** | 8 | **8** | = | ***No auditado esta ronda*** — el auditor no entregó su archivo. Su nota **no se mueve**: mover la de un rubro que nadie miró es exactamente el ruido que la serie no debe tener. Queda como el hueco de cobertura de esta ronda. |
| **Tool calling** | 6 | **6** | = | **Ninguna de las tres razones aplica, y se dice así.** Ningún commit de los 181 tocó el rubro (verificado archivo por archivo), la suite del rubro mide idéntico a la 26 (53 archivos / 321 pruebas), los 5 cierres de la 26 aguantan y los 5 abiertos siguen vivos. Sin razón escrita, la nota se queda. |
| **Backend y API** | 7→6 | **5** | ▼1 | **Deuda que cobró factura.** Al patrón `soltarClaim(true)` de la 24 se le colgaron tres condiciones de cierre **que no son transitorias**: hoy una foto que agotó sus 5 intentos bloquea para siempre todos los cierres de ese chofer, en silencio y sin salida. Y BE-3 sigue vivo: la 0344 cubrió las 4 consultas que el hallazgo enumeraba, no la clase. |
| **Sistema agéntico** | 6 | **5** | ▼1 | **Deuda que cobró factura.** Cero commits del rubro en 181; **7 de sus 9 hallazgos son reincidentes**, cinco intactos línea por línea, y los dos ciclos que nadie había recorrido produjeron dos ALTO nuevos (el aviso de emergencia que salta tres niveles y despierta al dueño; los relojes legales que sellan «avisado» con un solo canal). |
| **Cumplimiento legal** | 6 | **5** | ▼1 | **Mirada más profunda** — el código no empeoró; la nota anterior estaba inflada. El hallazgo raíz es que `tenant.url_aviso_privacidad` **no tiene un solo escritor** en el repo: ninguna flota puede señalar su aviso integral aunque Likida ya lo renderice (art. 16 fr. II). Y `be94db90` **no** cerró lo de ARCO: cambió el texto, no el alcance. |
| **Rendimiento y costo** | 6 | **5** | ▼1 | **Deuda que cobró factura.** Los diez archivos que la 26 dejó abiertos no recibieron **una sola línea** en 181 commits, y —peor— el margen de 20 s que la 26 marcó como insuficiente **se copió literalmente a un cron nuevo** (el de GPS, sobre una unidad atómica de ~114 s). La deuda no solo no se pagó: se replicó. |
| **Frontend** | 4 | **4** | = | **Dos fuerzas del mismo tamaño, ambas escritas.** *Se atacó y subió*: los tres puntos abiertos que traía están cerrados de verdad, verificados uno por uno. *Deuda que cobró factura*: entró un CRÍTICO nuevo en la misma ventana — el despacho ya no ofrece el Anticipo, el viaje nace en 0 y la pantalla de firma presenta ese cero como una medición. Se cancelan. |
| **Cumplimiento fiscal** | 5→4 | **4** | = | **Dos fuerzas, ambas escritas.** *Se atacó y subió*: **los siete cierres que se mandaron verificar cerraron de verdad**, incluida la prueba de paridad volteada y la ficha que faltaba. *Mirada más profunda*: un CRÍTICO nuevo en el mismo cubo del 15 %, la copia que entra por la RPC y no por el motor. El ancla («3 o menos si imprime una cifra fiscal equivocada») lo empujaría a 3; lo sostiene en 4 que la disciplina de fichas está intacta y que los cierres fueron reales. |
| **Arquitectura** | 5 | **4** | ▼1 | **Deuda que cobró factura.** De los seis hallazgos que la 26 dejó abiertos, **cero se cerraron y uno creció**: `42f93f91` cerró la mitad que inventaba $7,200 en el archivo del ERP, pero lo hizo **bloqueando** — hoy un ajuste firmado inhabilita el export contable del periodo completo, 409 para las 40 liquidaciones del mes, y sin una sola prueba. 5ª aparición. |
| **Operabilidad y DX** | 5 | **4** | ▼1 | **Deuda que cobró factura + mirada más profunda.** Producción lleva **224 commits, 29 merges y 43 migraciones** congelada, `deploy-preview-promote.yml` lleva 28 corridas y **cero** han ejecutado el job `promote` — y la mirada más profunda encontró **por qué nadie se enteró**: la alarma se cerraba sola en cada push. Eso último sí se arregló. |

## Lo arreglado, con prueba que lo reproduce

**Una vuelta retenida de tres gastadas.**

| ID | Sha | Qué era |
|---|---|---|
| **OP-C2** (CRÍTICO) | `5569437e` | El paso «Cerrar el issue al recuperarse» de `salud-produccion.yml` estaba en `if: success()` a secas, mientras el cotejo de deriva que abre el issue **no corre en un push** (`event_name != 'push'`). Una corrida por push que jamás evaluó la deriva certificaba la recuperación. Medido contra la API de GitHub, no inferido: **#339** abierto 04:53:03Z por un schedule en rojo, cerrado **11:01:53Z** por la corrida de push sobre `06b2eca4`; mismo patrón en **#334** y **#325**; con **20 schedules en rojo seguidos** y producción 224 commits atrás, la etiqueta `salud-produccion` **no tenía un solo issue abierto**. Prueba que lo reproduce: extrae la condición del paso y exige que excluya el push — rojo medido (`Received: "success()"`) → verde. |

## Lo que se intentó y se revirtió, con su razón

**BE-3 (ALTO, REINCIDENTE) — la liquidación rechazada que sigue sumando.**

Se escribió `0348_agregados_sin_rechazadas.sql` (las cuatro agregadas restantes
con `revision <> 'rechazada'`, la **misma** decisión de producto que la 0344 ya
tomó) y una prueba de invariante estático anclada a **la última definición
vigente** —el idioma de `arco_search_path.test.ts`, que existe justamente porque
en este repo una migración ya revirtió a otra copiando un cuerpo viejo. La
prueba discriminó bien: **rojo en las cuatro sin arreglar, verde en las dos que
la 0344 ya cubría**, y verde en las seis con la migración.

**Y la suite completa se puso roja: 41 fallos en 3 archivos.** La causa, medida:

```
scripts/ci/staging-recovery.mjs:121
  if (expected.length !== 324 || new Set(expected).size !== 324 || expected.at(-1) !== '0347')
    fail('RECOVERY_LOCAL_MIGRATIONS');
```

Se revirtió, y **la razón importa más que la reversión**: ese `324/'0347'` no es
un fixture incompleto —el caso de la 26, donde completar la entrada fue
correcto—, es un **enclavamiento de seguridad sobre una operación destructiva**
(el `reset` de staging de los PRs #335-337), fijado al conjunto exacto de
migraciones contra el que esa recuperación se diseñó y se revisó. Subirlo a
`325/'0348'` de madrugada, sin que nadie compruebe que la recuperación sigue
siendo válida contra el conjunto nuevo, es debilitar un candado destructivo
**y** salirse del alcance del hallazgo. La regla de la skill y el encargo
coinciden. El arreglo queda diseñado y medido para quien lo retome.

## Un hallazgo que no traía ningún auditor

**[ALTO] OP-C4 — el repo no acepta una sola migración nueva sin ponerse rojo.**
`staging-recovery.mjs:121` exige `expected.length === 324` y
`expected.at(-1) === '0347'`, así que **cualquier** migración legítima tumba 35
pruebas de `staging-recovery.test.ts` con un `RECOVERY_LOCAL_MIGRATIONS` que no
dice nada de lo que el autor tocó. Salió al intentar BE-3 y se verificó
revirtiendo: sin la 0348, las 35 vuelven a verde. Es una trampa puesta en el
camino de la próxima persona que escriba una migración.

## Lo que NO se arregló, y por qué

Con el tope de 3 vueltas gastado (1 retenida, 1 revertida, 1 consumida en el
diagnóstico del enclavamiento), quedan **pendientes con razón escrita**:

- **[CRÍTICO · fiscal] La copia de un comprobante en el cubo del 15 %.** Exige
  una **sexta** implementación del predicado «esto es una copia» dentro de SQL,
  con la normalización de folios que hoy vive en TS. 5ª vuelta sobre este cubo;
  las cuatro anteriores metieron un defecto nuevo en la línea que acababan de
  editar. Y no es medible aquí: no hay base.
- **[CRÍTICO · frontend] El Anticipo que nadie puede capturar.** Exige decidir el
  producto (enseñar el campo, bloquear la creación, o un estado «no capturado»
  que hoy no cabe: `NOT NULL DEFAULT 0`), y voltear una aserción que fija el
  `anticipo: 0` como esperado.
- **[CRÍTICO · arquitectura] La póliza tras `ajustar`, 5ª aparición.** Necesita
  una decisión sobre qué hace el producto con una liquidación ajustada.
- **[CRÍTICO · agéntico y rendimiento] `ingerirRep` sin reloj.** Arreglarlo es
  rediseñar el troceado del lote, no poner un `Date.now()`.
- **[CRÍTICO · operabilidad] Producción congelada.** **Necesita una mano
  humana**: aplicar 0304→0347 en la base y publicar. Ninguna rutina puede
  hacerlo y el Redeploy del panel no basta.
- **[CRÍTICO · operabilidad] Sin monitor externo de GitHub Actions.** Exige
  cablear un servicio de fuera; no cabe en un commit del repo.
- **[ALTO · backend] La carta muerta que bloquea el cierre para siempre.**
  Cerrarlo exige voltear una aserción deliberada de la auditoría 24
  (`conv_foto_anterior_aud24.test.ts:71-75`) o darle salida a la carta muerta:
  las dos direcciones pierden comportamiento que alguien decidió.

## Compuerta al cerrar

- `npm test` → **905 archivos, 12,175 pruebas: 12,169 pasan, 1 saltada, 5
  fallan.** Las 5 son **INFRA** (`proxy-local.test.ts`, `EAFNOSUPPORT ::1`: el
  contenedor no tiene loopback IPv6, comprobado aparte). Línea base: 12,168
  pasan / 5 fallan. **La diferencia es exactamente la prueba nueva del arreglo.**
- `npx tsc --noEmit -p .` → **exit 0**.
- `npm run lint` → **0 errores, 156 avisos** (idéntico a la línea base).
- `npm run build` → **no se corre aquí a propósito** (sin credenciales).

## Tablero

`tablero.html` + `tablero.png`, capturado con Chromium headless y **mirado**: se
cuentan los **12** rubros, las notas de la rejilla suman **65** y 65/12 = 5.42 →
**5.4**, la cifra que encabeza esta síntesis. Al mirarlo se corrigieron dos
defectos: la tarjeta de Pruebas salía ámbar con nota 8 (el color codifica la
nota, nunca otra cosa) y el pie salía cortado.

## Nota de método, para la ronda 28

1. **`pruebas` quedó sin cubrir.** Es el primer rubro que hay que relanzar, y su
   8 es hoy la nota menos sostenida del tablero: nadie la ha mirado en dos
   rondas y es la más alta.
2. **OP-C4 bloquea cualquier arreglo que necesite una migración**, y varios
   pendientes la necesitan (BE-3 entre ellos). Subir ese pin —con alguien
   mirando— desatasca la 28 entera.
3. El arreglo de BE-3 **ya está diseñado y medido**; no se rehace desde cero.
